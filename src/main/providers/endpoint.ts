import type { ApiConfig } from '@shared/types'
import type { ProviderProtocol } from '@shared/providers'
import { resolveCredential } from '../services/auth'
import type { CustomProvider } from './custom-providers'

/**
 * 端点与凭据解析（pickProvider / 模型列表 / 探测共用，独立可测）：
 * - 供应商定义：models.json 自定义命中 → 其 baseUrl/协议/内联 key；否则按 baseUrl+模型名嗅探协议
 * - 凭据：auth.json[providerId] > 旧版手填(config.apiKey) > 定义内联值（env 由值语法 $ENV 承担）
 */

export interface ResolvedEndpoint {
  protocol: ProviderProtocol
  baseUrl: string
  apiKey: string
}

export interface EndpointDeps {
  customProviders: CustomProvider[]
  userDataPath: string
}

export function resolveEndpoint(c: ApiConfig, deps: EndpointDeps): ResolvedEndpoint {
  const customs = deps.customProviders
  // 供应商定义：providerId 命中优先；未设 id（旧配置/悬浮窗仅切模型）时按 baseUrl 匹配——否则其内联 key 永远不可达
  const custom =
    customs.find((p) => p.id === c.providerId) ??
    (c.baseUrl ? customs.find((p) => p.baseUrl.replace(/\/+$/, '') === c.baseUrl.replace(/\/+$/, '')) : undefined)
  const protocol = custom?.protocol ?? (c.model.startsWith('claude') || /anthropic/i.test(c.baseUrl) ? 'anthropic' : 'openai-compat')
  const cred = resolveCredential(deps.userDataPath, {
    providerId: custom?.id ?? c.providerId ?? '',
    legacyConfigKey: c.apiKey,
    inlineValue: custom?.apiKeyValue
  })
  return {
    protocol,
    baseUrl: c.baseUrl || custom?.baseUrl || '',
    apiKey: cred?.key ?? ''
  }
}

export interface ProbeResult {
  ok: boolean
  models: string[]
  error?: string
  /** 实际探测成功的协议（与传入 protocol 不同 = 发生了回退；设置 UI 据此纠正表单） */
  protocolUsed?: ProviderProtocol
}

/** 单协议一轮探测：URL 候选逐个尝试，全部失败返回 lastError */
async function probeWithProtocol(baseUrl: string, protocol: ProviderProtocol, apiKey: string): Promise<ProbeResult & { lastError: string }> {
  const base = baseUrl.replace(/\/+$/, '')
  const key = apiKey.trim()
  const endsV1 = /\/v\d+$/.test(base)
  const candidates =
    protocol === 'anthropic'
      ? [endsV1 ? `${base}/models` : `${base}/v1/models`]
      : [`${base}/models`, ...(endsV1 ? [] : [`${base}/v1/models`])]
  const headers: Record<string, string> =
    protocol === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : key
        ? { Authorization: `Bearer ${key}` }
        : {}

  let lastError = '探测失败：URL 不可达或返回格式不支持'
  for (const url of candidates) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(url, { headers, signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) {
        lastError = `HTTP ${res.status}（${url}）`
        continue
      }
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('json')) {
        lastError = '返回非 JSON'
        continue
      }
      const json = (await res.json()) as unknown
      const raw: unknown[] = Array.isArray(json)
        ? json
        : Array.isArray((json as { data?: unknown[] })?.data)
          ? (json as { data: unknown[] }).data
          : []
      const list: string[] = raw
        .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
        .filter((m): m is string => typeof m === 'string' && m.length > 0)
      const models = [...new Set(list)].sort((a, b) => a.localeCompare(b))
      if (models.length > 0) return { ok: true, models, lastError: '' }
      lastError = '端点未返回任何模型'
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  return { ok: false, models: [], lastError }
}

/** 消息端点路由校验：POST {} 到与 provider 完全一致的消息 URL，404 = 该协议在此 base 下无路由。
 * /models 端点对鉴权头普遍宽松（DeepSeek 连 x-api-key 都放行），验证不了协议——必须单独探消息端点。 */
async function messagesEndpointServed(base: string, protocol: ProviderProtocol, apiKey: string): Promise<boolean> {
  const url = base.replace(/\/+$/, '') + (protocol === 'anthropic' ? '/v1/messages' : '/chat/completions')
  const key = apiKey.trim()
  const headers: Record<string, string> =
    protocol === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
      : { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(url, { method: 'POST', headers, body: '{}', signal: ctrl.signal })
    clearTimeout(timer)
    return res.status !== 404
  } catch {
    return true // 网络层失败不作为协议判据（/models 已验证过连通性）
  }
}

/** 探测端点可用模型：GET {baseUrl}/models（自动尝试 /v1 变体；OpenAI 带 Bearer，Anthropic 带 x-api-key）。
 * 命中 /models 后再校验消息端点路由，404 则用另一协议重探——拦截"格式选错，探测通过、发送必挂"的假阳性。 */
export async function probeEndpointModels(baseUrl: string, protocol: ProviderProtocol, apiKey: string): Promise<ProbeResult> {
  const base = String(baseUrl ?? '').trim()
  const key = String(apiKey ?? '').trim()
  if (!/^https?:\/\//.test(base)) return { ok: false, models: [], error: 'Base URL 需以 http(s):// 开头' }

  const other: ProviderProtocol = protocol === 'anthropic' ? 'openai-compat' : 'anthropic'
  const first = await probeWithProtocol(base, protocol, key)
  const firstGood = first.ok && (await messagesEndpointServed(base, protocol, key))
  if (firstGood) return { ok: true, models: first.models, protocolUsed: protocol }
  const second = await probeWithProtocol(base, other, key)
  if (second.ok) return { ok: true, models: second.models, protocolUsed: other }
  if (first.ok) return { ok: true, models: first.models, protocolUsed: protocol }
  return { ok: false, models: [], error: second.lastError }
}

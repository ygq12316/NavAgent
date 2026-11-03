import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogModel } from '@shared/model-catalog'
import type { ProviderProtocol } from '@shared/providers'

/**
 * 用户级供应商（对齐 pi 的 ~/.pi/agent/models.json，零代码添加）：
 * 文件 userData/models.json —— providers.{id}.{name?,baseUrl,api,apiKey?,models[]}。
 * 只加载全局（本机自有文件），不加载项目级 —— !command 值语法的执行权限以此划界。
 * api: openai-completions → openai-compat；anthropic-messages → anthropic。
 * 模型缺省：contextWindow 128k、cost 0、reasoning=false。
 */

export interface CustomProvider {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  /** 定义内联值（凭据解析第 4 层；值语法在请求时经 resolveValueSyntax 解析） */
  apiKeyValue?: string
  models: CatalogModel[]
}

interface RawModel {
  id?: unknown
  name?: unknown
  reasoning?: unknown
  contextWindow?: unknown
  maxTokens?: unknown
  cost?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown }
}

interface RawProvider {
  name?: unknown
  baseUrl?: unknown
  api?: unknown
  apiKey?: unknown
  models?: unknown
}

export interface LoadModelsJsonResult {
  providers: CustomProvider[]
  /** 每条 "providerId: 原因" */
  errors: string[]
}

export function loadModelsJson(userDataPath: string): LoadModelsJsonResult {
  const file = join(userDataPath, 'models.json')
  if (!existsSync(file)) return { providers: [], errors: [] }
  let raw: { providers?: Record<string, RawProvider> }
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8')) as { providers?: Record<string, RawProvider> }
  } catch (err) {
    return { providers: [], errors: [`models.json: JSON 解析失败（${err instanceof Error ? err.message : String(err)}）`] }
  }
  const providers: CustomProvider[] = []
  const errors: string[] = []
  const table = raw.providers
  if (typeof table !== 'object' || table === null) return { providers: [], errors: ['models.json: 缺少 providers 对象'] }
  for (const [id, p] of Object.entries(table)) {
    if (!/^[a-z0-9_-]+$/.test(id)) {
      errors.push(`${id}: 供应商 id 只允许小写字母/数字/-/_`)
      continue
    }
    if (typeof p?.baseUrl !== 'string' || p.baseUrl.trim().length === 0) {
      errors.push(`${id}: 缺少 baseUrl`)
      continue
    }
    const protocol = normalizeProtocol(p.api)
    if (!protocol) {
      errors.push(`${id}: api 只支持 openai-completions / anthropic-messages`)
      continue
    }
    const models = Array.isArray(p.models) ? p.models.flatMap((m) => toCatalogModel(id, m, errors)) : []
    providers.push({
      id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : id,
      protocol,
      baseUrl: p.baseUrl.trim(),
      apiKeyValue: typeof p.apiKey === 'string' ? p.apiKey : undefined,
      models
    })
  }
  return { providers, errors }
}

function normalizeProtocol(api: unknown): ProviderProtocol | null {
  if (api === undefined || api === 'openai-completions') return 'openai-compat'
  if (api === 'anthropic-messages') return 'anthropic'
  return null
}

function toCatalogModel(providerId: string, m: RawModel, errors: string[]): CatalogModel[] {
  if (typeof m?.id !== 'string' || m.id.trim().length === 0) {
    errors.push(`${providerId}: 模型条目缺少 id`)
    return []
  }
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  return [
    {
      providerId,
      model: m.id.trim(),
      contextWindow: num(m.contextWindow) ?? 128_000,
      inputPrice: num(m.cost?.input) ?? 0,
      outputPrice: num(m.cost?.output) ?? 0,
      ...(num(m.cost?.cacheRead) !== undefined || num(m.cost?.cacheWrite) !== undefined
        ? { cacheReadPrice: num(m.cost?.cacheRead), cacheWritePrice: num(m.cost?.cacheWrite) }
        : {}),
      supportsThinking: m.reasoning === true
    }
  ]
}

/** 合并目录：内置优先列出（id 冲突时自定义跳过并报错），供设置 UI 与成本计价 */
export function mergeCatalogErrors(builtinIds: string[], custom: CustomProvider[]): string[] {
  const errors: string[] = []
  const set = new Set(builtinIds)
  for (const p of custom) {
    if (set.has(p.id)) errors.push(`${p.id}: 与内置供应商 id 冲突，已忽略（可用 baseUrl 覆盖改用内置条目）`)
  }
  return errors
}

// ── 设置 UI 写回（userData/models.json 的 upsert / remove）──────────────

export interface CustomProviderWriteInput {
  id?: string
  name: string
  protocol: 'anthropic' | 'openai-compat'
  baseUrl: string
  /** undefined=保留原内联值；''=清除；非空=写入 */
  apiKey?: string
  models: { id: string; reasoning?: boolean; contextWindow?: number; inputPrice?: number; outputPrice?: number }[]
}

export type ModelsJsonWriteResult = { ok: true; id: string } | { ok: false; error: string }

/** 名称 → 合法 id（小写字母/数字/-/_；冲突时追加序号） */
export function deriveProviderId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'custom'
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

function inputToRaw(input: CustomProviderWriteInput): RawProvider {
  const models = input.models
    .map((m) => ({ ...m, id: String(m.id ?? '').trim() }))
    .filter((m) => m.id.length > 0)
    .map((m) => ({
      id: m.id,
      ...(m.reasoning ? { reasoning: true } : {}),
      ...(typeof m.contextWindow === 'number' && Number.isFinite(m.contextWindow) ? { contextWindow: m.contextWindow } : {}),
      ...(m.inputPrice || m.outputPrice ? { cost: { input: m.inputPrice ?? 0, output: m.outputPrice ?? 0 } } : {})
    }))
  return {
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim(),
    api: input.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    ...(input.apiKey !== undefined ? (input.apiKey.trim() ? { apiKey: input.apiKey.trim() } : {}) : {}),
    models
  }
}

function readRawModelsJson(userDataPath: string): { raw: { providers?: Record<string, Record<string, unknown>> } & Record<string, unknown> } | { raw: null; error: string } {
  const file = join(userDataPath, 'models.json')
  if (!existsSync(file)) return { raw: {} }
  try {
    return { raw: JSON.parse(readFileSync(file, 'utf-8')) as { providers?: Record<string, Record<string, unknown>> } & Record<string, unknown> }
  } catch (err) {
    // 解析失败绝不能吞：写路径若拿到空对象会把文件里全部既有 provider 抹掉
    return { raw: null, error: `models.json 解析失败（${err instanceof Error ? err.message : String(err)}），为防数据丢失已中止写入；请修复该文件后重试` }
  }
}

function writeRawModelsJson(userDataPath: string, raw: object): { ok: true } | { ok: false; error: string } {
  const file = join(userDataPath, 'models.json')
  // 原子写：先落临时文件再改名，中途被杀也不会留下半截 JSON 毁掉全部供应商配置
  const tmp = `${file}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
    renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败忽略 */
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 新增/覆盖一个自定义供应商；保留文件里其它顶层字段与未触及的 provider 原样 */
export function upsertModelsJson(userDataPath: string, input: CustomProviderWriteInput): ModelsJsonWriteResult {
  const name = String(input.name ?? '').trim()
  const baseUrl = String(input.baseUrl ?? '').trim()
  if (!name) return { ok: false, error: '名称不能为空' }
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: 'Base URL 需以 http(s):// 开头' }
  if (input.protocol !== 'anthropic' && input.protocol !== 'openai-compat') return { ok: false, error: 'API 格式不支持' }
  const models = (input.models ?? []).filter((m) => String(m?.id ?? '').trim().length > 0)
  if (models.length === 0) return { ok: false, error: '至少添加一个模型' }

  const read = readRawModelsJson(userDataPath)
  if (read.raw === null) return { ok: false, error: read.error }
  const raw = read.raw
  const table = typeof raw.providers === 'object' && raw.providers !== null ? raw.providers : {}
  const existingIds = new Set(Object.keys(table))
  const id = input.id?.trim() || deriveProviderId(name, existingIds)
  if (!/^[a-z0-9_-]+$/.test(id)) return { ok: false, error: 'id 只允许小写字母/数字/-/_（改用名称自动生成即可）' }
  table[id] = inputToRaw(input) as Record<string, unknown>
  const written = writeRawModelsJson(userDataPath, { ...raw, providers: table })
  return written.ok ? { ok: true, id } : written
}

/** 删除一个自定义供应商；不存在也视为成功（幂等） */
export function removeFromModelsJson(userDataPath: string, id: string): ModelsJsonWriteResult {
  const read = readRawModelsJson(userDataPath)
  if (read.raw === null) return { ok: false, error: read.error }
  const raw = read.raw
  const table = typeof raw.providers === 'object' && raw.providers !== null ? raw.providers : {}
  if (!(id in table)) return { ok: true, id }
  delete table[id]
  const written = writeRawModelsJson(userDataPath, { ...raw, providers: table })
  return written.ok ? { ok: true, id } : written
}

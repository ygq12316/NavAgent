import type { ModelParams, StopReason } from '@shared/types'
import type { Provider, ProviderEvent, ProviderRequest } from './types'
import { anthropicBudgetTokens } from './thinking'

export interface AnthropicOptions {
  id: string
  baseUrl: string
  apiKey: string
  model: string
  modelParams?: ModelParams
}

const DEFAULT_MAX_TOKENS = 8192

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}') as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function mapStopReason(reason: string | null | undefined, sawToolCall: boolean): Exclude<StopReason, 'pending'> {
  if (reason === 'tool_use') return 'toolUse'
  if (reason === 'max_tokens') return 'length'
  if (!reason) return sawToolCall ? 'toolUse' : 'stop'
  return 'stop'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 内部 AgentMessage → Anthropic Messages 格式：
 * system 独立参数；assistant 直接由 content blocks 重建（text/thinking/redacted_thinking）+ tool_use；
 * 连续的 tool_result 归并为一条 user 消息（协议要求 user/assistant 交替）。
 * thinking 块回传规则（对齐 pi）：有签名原样回传；无签名降级为 text；redacted 用协议原生块。
 */
function toAnthropicMessages(req: ProviderRequest): { system: string; messages: Record<string, unknown>[] } {
  const messages: Record<string, unknown>[] = []
  for (const m of req.messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        messages.push({ role: 'user', content: m.content })
      } else {
        messages.push({
          role: 'user',
          content: m.content.map((b) =>
            b.type === 'text'
              ? { type: 'text', text: b.text }
              : { type: 'image', source: { type: 'base64', media_type: b.mimeType, data: b.data } }
          )
        })
      }
    } else if (m.role === 'assistant') {
      const blocks: Record<string, unknown>[] = []
      for (const b of m.content) {
        if (b.type === 'text') {
          if (b.text) blocks.push({ type: 'text', text: b.text })
        } else if (b.redacted) {
          blocks.push({ type: 'redacted_thinking', data: b.thinkingSignature ?? '' })
        } else if (b.thinkingSignature) {
          blocks.push({ type: 'thinking', thinking: b.thinking, signature: b.thinkingSignature })
        } else if (b.thinking) {
          blocks.push({ type: 'text', text: b.thinking })
        }
      }
      // 协议禁止空 content 数组（thinking-only 清洗后可能出现）
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: safeJson(tc.arguments) })
      }
      messages.push({ role: 'assistant', content: blocks })
    } else {
      const block = {
        type: 'tool_result',
        tool_use_id: m.callId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {})
      }
      const last = messages[messages.length - 1]
      const lastContent = last?.content as Record<string, unknown>[] | undefined
      if (last && last.role === 'user' && Array.isArray(lastContent) && lastContent.every((b) => b.type === 'tool_result')) {
        lastContent.push(block)
      } else {
        messages.push({ role: 'user', content: [block] })
      }
    }
  }
  return { system: req.system, messages }
}

/** Anthropic Messages API（claude 系）。失败不抛异常，编码为 done 终态事件（对齐 pi 契约）。 */
export class AnthropicProvider implements Provider {
  readonly id: string

  constructor(private opts: AnthropicOptions) {
    this.id = opts.id
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    let sawToolCall = false
    let stopReason: string | null = null
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    try {
      const url = this.opts.baseUrl.replace(/\/+$/, '') + '/v1/messages'
      const { system, messages } = toAnthropicMessages(req)
      const maxTokens = req.maxTokens ?? this.opts.modelParams?.max_tokens ?? DEFAULT_MAX_TOKENS
      const body: Record<string, unknown> = {
        model: this.opts.model,
        max_tokens: maxTokens,
        system,
        messages,
        stream: true
      }
      // extended thinking：budget 必须小于 max_tokens；开启时不能自定义 temperature/top_p
      const level = this.opts.modelParams?.thinkingLevel
      const budget = level ? anthropicBudgetTokens(level) : null
      const budgetTokens = budget !== null ? Math.min(budget, maxTokens - 1024) : null
      if (budgetTokens !== null && budgetTokens >= 1024) {
        body.thinking = { type: 'enabled', budget_tokens: budgetTokens }
      } else {
        if (this.opts.modelParams?.temperature !== undefined) body.temperature = this.opts.modelParams.temperature
        if (this.opts.modelParams?.top_p !== undefined) body.top_p = this.opts.modelParams.top_p
      }
      if (req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters
        }))
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body),
        signal: req.signal
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        yield {
          type: 'done',
          stopReason: 'error',
          errorMessage: `API ${res.status} ${res.statusText}：${text.slice(0, 400)}`,
          status: res.status
        }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      stream: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          let json: {
            type?: string
            index?: number
            content_block?: { type?: string; id?: string; name?: string; data?: string }
            delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string }
            message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
            usage?: { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
            error?: { message?: string }
          }
          try {
            json = JSON.parse(payload)
          } catch {
            continue
          }
          switch (json.type) {
            case 'message_start': {
              inputTokens = json.message?.usage?.input_tokens ?? 0
              outputTokens = json.message?.usage?.output_tokens ?? 0
              cacheReadTokens = json.message?.usage?.cache_read_input_tokens ?? 0
              cacheWriteTokens = json.message?.usage?.cache_creation_input_tokens ?? 0
              break
            }
            case 'content_block_start': {
              if (json.content_block?.type === 'tool_use') {
                sawToolCall = true
                yield {
                  type: 'tool_call_start',
                  index: json.index ?? 0,
                  id: json.content_block.id ?? '',
                  name: json.content_block.name ?? ''
                }
              } else if (json.content_block?.type === 'redacted_thinking') {
                yield { type: 'thinking_redacted', data: json.content_block.data ?? '' }
              }
              break
            }
            case 'content_block_delta': {
              if (json.delta?.type === 'text_delta' && json.delta.text) {
                yield { type: 'text_delta', delta: json.delta.text }
              } else if (json.delta?.type === 'thinking_delta' && json.delta.thinking) {
                yield { type: 'thinking_delta', delta: json.delta.thinking }
              } else if (json.delta?.type === 'signature_delta' && json.delta.signature) {
                yield { type: 'thinking_signature', signature: json.delta.signature }
              } else if (json.delta?.type === 'input_json_delta' && json.delta.partial_json) {
                yield { type: 'tool_call_delta', index: json.index ?? 0, argsDelta: json.delta.partial_json }
              }
              break
            }
            case 'message_delta': {
              outputTokens = json.usage?.output_tokens ?? outputTokens
              if (json.delta?.stop_reason) stopReason = json.delta.stop_reason
              // 新版 API 的 message_delta 也会带完整 usage，按需更新
              if (json.usage?.input_tokens !== undefined) inputTokens = json.usage.input_tokens
              if (json.usage?.cache_read_input_tokens !== undefined) cacheReadTokens = json.usage.cache_read_input_tokens
              if (json.usage?.cache_creation_input_tokens !== undefined) cacheWriteTokens = json.usage.cache_creation_input_tokens
              yield {
                type: 'usage',
                inputTokens,
                outputTokens,
                ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
                ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {})
              }
              break
            }
            case 'message_stop': {
              break stream
            }
            case 'error': {
              yield { type: 'done', stopReason: 'error', errorMessage: `API 错误：${json.error?.message ?? 'unknown'}` }
              return
            }
          }
        }
      }
      yield { type: 'done', stopReason: mapStopReason(stopReason, sawToolCall) }
    } catch (err) {
      if (req.signal.aborted) {
        yield { type: 'done', stopReason: 'aborted' }
        return
      }
      yield { type: 'done', stopReason: 'error', errorMessage: errorMessage(err) }
    }
  }
}

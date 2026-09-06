import type { ModelParams, StopReason } from '@shared/types'
import { textOfBlocks } from '@shared/types'
import type { Provider, ProviderEvent, ProviderRequest } from './types'
import { buildThinkingParams, detectThinkingFormat } from './thinking'

export interface OpenAICompatOptions {
  id: string
  baseUrl: string
  apiKey: string
  model: string
  modelParams?: ModelParams
}

function toOpenAIMessages(req: ProviderRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }]
  for (const m of req.messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        messages.push({ role: 'user', content: m.content })
      } else {
        // 多模态：文本 + 图片（data URL）
        messages.push({
          role: 'user',
          content: m.content.map((b) =>
            b.type === 'text'
              ? { type: 'text', text: b.text }
              : { type: 'image_url', image_url: { url: `data:${b.mimeType};base64,${b.data}` } }
          )
        })
      }
    } else if (m.role === 'assistant') {
      // 历史回传只发正文文本，剥离 thinking 块（OpenAI 兼容端点不校验思考内容，回传可能 400）
      messages.push({
        role: 'assistant',
        content: textOfBlocks(m.content),
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments }
              }))
            }
          : {})
      })
    } else {
      messages.push({ role: 'tool', tool_call_id: m.callId, content: m.content })
    }
  }
  return messages
}

function mapFinishReason(finish: string | null | undefined, sawToolCall: boolean): Exclude<StopReason, 'pending'> {
  if (finish === 'tool_calls' || finish === 'function_call') return 'toolUse'
  if (finish === 'length') return 'length'
  // 部分兼容端点不给 finish_reason：以是否出现过工具调用推断
  if (!finish) return sawToolCall ? 'toolUse' : 'stop'
  return 'stop'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * OpenAI Chat Completions 兼容协议（DeepSeek/Qwen/Kimi/智谱/Ollama/vLLM…）。
 * 契约对齐 pi：失败不抛异常，一律编码为 stopReason:'error'/'aborted' 的 done 终态事件。
 */
export class OpenAICompatProvider implements Provider {
  readonly id: string

  constructor(private opts: OpenAICompatOptions) {
    this.id = opts.id
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    let sawToolCall = false
    let finishReason: string | null = null
    let reasoningSource: string | null = null
    try {
      const url = this.opts.baseUrl.replace(/\/+$/, '') + '/chat/completions'
      const body: Record<string, unknown> = {
        model: this.opts.model,
        messages: toOpenAIMessages(req),
        stream: true,
        stream_options: { include_usage: true }
      }
      if (req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters }
        }))
      }
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
      const p = this.opts.modelParams
      if (p?.temperature !== undefined) body.temperature = p.temperature
      if (p?.top_p !== undefined) body.top_p = p.top_p
      // thinkingFormat compat flags：按 baseUrl 自动选厂商格式，档位来自 modelParams.thinkingLevel
      Object.assign(body, buildThinkingParams(detectThinkingFormat(this.opts.baseUrl), p?.thinkingLevel))

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: req.signal
      })
      if (process.env.NAVAGENT_DEBUG_WIRE) console.error(`[wire][model] ${this.opts.model} url=${url}`)
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
          if (payload === '[DONE]') break stream
          let json: {
            choices?: {
              delta?: {
                content?: string
                // reasoning 家族：llama.cpp=reasoning_content、部分端点=reasoning/reasoning_text
                reasoning_content?: string
                reasoning?: string
                reasoning_text?: string
                tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
              }
              finish_reason?: string | null
            }[]
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              prompt_tokens_details?: { cached_tokens?: number }
            }
          }
          try {
            json = JSON.parse(payload)
          } catch {
            continue
          }
          const choice = json.choices?.[0]
          if (choice?.finish_reason) finishReason = choice.finish_reason
          const delta = choice?.delta
          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            yield { type: 'text_delta', delta: delta.content }
          }
          // reasoning 家族归一为 thinking 块；首次命中时用 thinking_signature 记录来源字段名
          for (const field of ['reasoning_content', 'reasoning', 'reasoning_text'] as const) {
            const value = delta?.[field]
            if (typeof value === 'string' && value.length > 0) {
              yield { type: 'thinking_delta', delta: value }
              if (reasoningSource === null) {
                reasoningSource = field
                yield { type: 'thinking_signature', signature: field }
              }
              break
            }
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const index = typeof tc.index === 'number' ? tc.index : 0
              if (tc.id) {
                sawToolCall = true
                yield { type: 'tool_call_start', index, id: tc.id, name: tc.function?.name ?? '' }
              }
              if (tc.function?.arguments) {
                yield { type: 'tool_call_delta', index, argsDelta: tc.function.arguments }
              }
            }
          }
          if (json.usage) {
            // 归一口径：inputTokens = 非缓存输入；prompt_tokens 含缓存命中部分
            const cached = json.usage.prompt_tokens_details?.cached_tokens ?? 0
            const prompt = json.usage.prompt_tokens ?? 0
            yield {
              type: 'usage',
              inputTokens: Math.max(0, prompt - cached),
              outputTokens: json.usage.completion_tokens ?? 0,
              ...(cached > 0 ? { cacheReadTokens: cached } : {})
            }
          }
        }
      }
      yield { type: 'done', stopReason: mapFinishReason(finishReason, sawToolCall) }
    } catch (err) {
      if (req.signal.aborted) {
        yield { type: 'done', stopReason: 'aborted' }
        return
      }
      // fetch 网络失败（TypeError: fetch failed）等运行时错误同样编码为终态
      yield { type: 'done', stopReason: 'error', errorMessage: errorMessage(err) }
    }
  }
}

import type { AgentMessage, StopReason, ToolSchema } from '@shared/types'

export interface ProviderRequest {
  messages: AgentMessage[]
  tools: ToolSchema[]
  system: string
  /** 本请求的输出 token 预算（压缩摘要等内部请求使用） */
  maxTokens?: number
  signal: AbortSignal
}

export type ProviderEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_signature'; signature: string }
  | { type: 'thinking_redacted'; data: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsDelta: string }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      /** 缓存命中输入（Anthropic cache_read / OpenAI cached_tokens）；inputTokens 已归一为非缓存口径 */
      cacheReadTokens?: number
      /** 缓存写入（Anthropic cache_creation） */
      cacheWriteTokens?: number
    }
  | {
      type: 'done'
      stopReason: Exclude<StopReason, 'pending'>
      errorMessage?: string
      /** HTTP 状态码（仅 stopReason=error 时携带，供重试层判定） */
      status?: number
    }

export interface Provider {
  id: string
  stream(req: ProviderRequest): AsyncIterable<ProviderEvent>
}

import type { ThinkingLevel } from '@shared/types'

/**
 * thinkingFormat compat flags（对齐 pi 的 openai-completions thinking 消费处）：
 * 11 变体数据化——每个厂商怎么开启 thinking 只是数据，不是代码分支。
 * detectThinkingFormat 按 baseUrl 自动选格式；level=off 时多数格式返回"显式关闭"参数。
 */

export type ThinkingFormat =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'together'
  | 'baseten'
  | 'zai'
  | 'qwen'
  | 'chat-template'
  | 'qwen-chat-template'
  | 'string-thinking'
  | 'ant-ling'

type VariantBuilder = (level: ThinkingLevel) => Record<string, unknown> | null

/** OpenAI 系 reasoning_effort 只认 minimal/low/medium/high；xhigh/max 降为 high */
export function openaiEffort(level: ThinkingLevel): 'minimal' | 'low' | 'medium' | 'high' | null {
  switch (level) {
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'high'
    case 'off':
      return null
  }
}

/** 各变体的请求参数形状（返回 null = 不附加任何 thinking 参数） */
export const THINKING_VARIANTS: Record<ThinkingFormat, VariantBuilder> = {
  openai: (level) => (level === 'off' ? null : { reasoning_effort: openaiEffort(level) }),
  openrouter: (level) => (level === 'off' ? null : { reasoning: { effort: openaiEffort(level) } }),
  deepseek: (level) => ({
    thinking: { type: level === 'off' ? 'disabled' : 'enabled' },
    ...(level === 'off' ? {} : { reasoning_effort: openaiEffort(level) })
  }),
  together: (level) => ({
    reasoning: { enabled: level !== 'off' },
    ...(level === 'off' ? {} : { reasoning_effort: openaiEffort(level) })
  }),
  baseten: (level) => ({
    chat_template_args: { thinking: level !== 'off' },
    ...(level === 'off' ? {} : { reasoning_effort: openaiEffort(level) })
  }),
  zai: (level) => ({ thinking: { type: level === 'off' ? 'disabled' : 'enabled' } }),
  qwen: (level) => ({ enable_thinking: level !== 'off' }),
  'chat-template': (level) => ({
    chat_template_kwargs: { thinking: level !== 'off' },
    ...(level === 'off' ? {} : { reasoning_effort: openaiEffort(level) })
  }),
  // preserve_thinking（历史回传 thinking）暂不实现：openai-compat 侧历史不回传 thinking 块
  'qwen-chat-template': (level) => ({ chat_template_kwargs: { enable_thinking: level !== 'off' } }),
  'string-thinking': (level) => ({ thinking: level }),
  'ant-ling': (level) => (level === 'off' ? null : { reasoning: { effort: openaiEffort(level) } })
}

/** baseUrl 自动检测（对齐 pi 的 URL 命中表 + 智谱 bigmodel 扩展），默认 openai */
export function detectThinkingFormat(baseUrl: string): ThinkingFormat {
  const url = baseUrl.toLowerCase()
  if (url.includes('deepseek')) return 'deepseek'
  if (url.includes('z.ai') || url.includes('zai') || url.includes('bigmodel')) return 'zai'
  if (url.includes('together')) return 'together'
  if (url.includes('antling') || url.includes('ant-ling')) return 'ant-ling'
  if (url.includes('openrouter')) return 'openrouter'
  return 'openai'
}

export function buildThinkingParams(format: ThinkingFormat, level: ThinkingLevel | undefined): Record<string, unknown> {
  if (!level) return {}
  return THINKING_VARIANTS[format](level) ?? {}
}

/** Anthropic thinking budget_tokens（必须 < max_tokens，调用侧保证） */
export function anthropicBudgetTokens(level: ThinkingLevel): number | null {
  switch (level) {
    case 'minimal':
      return 2048
    case 'low':
      return 4096
    case 'medium':
      return 8192
    case 'high':
      return 16384
    case 'xhigh':
      return 24576
    case 'max':
      return 32768
    default:
      return null
  }
}

import type { AgentMessage } from '@shared/types'
import { contextTokensOf, messageChars, messageText, textOfBlocks } from '@shared/types'

/**
 * 上下文管理（设计方案 4.2）。
 * token 估算：CJK 约 1 token/字、英文约 4 字符/token，取中间值 /2；
 * 更精确的用量来自每次响应的 usage 字段，这里只做"发请求前"的预估。
 */
export const CONTEXT_WINDOW = 64_000
export const AUTO_COMPACT_THRESHOLD = 48_000 // ≈75%，触发自动压缩
export const KEEP_TURNS = 2 // 压缩时保留最近几轮原文
export const MIN_MESSAGES_TO_COMPACT = 4 // 少于这个数不值得压缩

export function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0
  for (const m of messages) chars += messageChars(m)
  return Math.ceil(chars / 2)
}

/**
 * usage 锚定的上下文估算（对齐 pi 的 estimateContextTokens）：
 * 优先取最近一条有效 assistant 的真实 usage（input+output，含 cache 命中时的真实上下文规模），
 * 仅对其后的尾部消息用字符启发式；没有任何 usage 时整体退化为字符估算。
 */
export function estimateContextTokens(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || !m.usage || m.stopReason === 'error' || m.stopReason === 'aborted') continue
    const anchored = contextTokensOf(m.usage) + m.usage.outputTokens
    if (anchored <= 0) continue
    let trailing = 0
    for (let j = i + 1; j < messages.length; j++) trailing += estimateTokens([messages[j]])
    return anchored + trailing
  }
  return estimateTokens(messages)
}

/**
 * 压缩切点校验（对齐 pi 的 findCutPoint 思路）：
 * 候选切点不得落在 tool_result 上，且摘要区不能留下"调用在摘要区、结果在保留区"的悬空配对；
 * 违例则把切点前移到配对之后，直到合法。无法安全切（切点推到末尾）返回 null。
 */
export function findSafeCut(messages: AgentMessage[], candidate: number): number | null {
  let cut = candidate
  for (;;) {
    if (cut >= messages.length) return null
    while (cut < messages.length && messages[cut].role === 'tool_result') cut++
    const callIds = new Set<string>()
    for (let i = 0; i < cut; i++) {
      const m = messages[i]
      if (m.role === 'assistant') for (const tc of m.toolCalls) callIds.add(tc.id)
    }
    let violation = -1
    for (let i = cut; i < messages.length; i++) {
      const m = messages[i]
      if (m.role === 'tool_result' && callIds.has(m.callId)) {
        violation = i
        break
      }
    }
    if (violation === -1) break
    cut = violation + 1
  }
  return cut > 0 && cut < messages.length ? cut : null
}

/** 压缩摘要的 system 提示（内部调用，不带工具） */
export const COMPACTION_SYSTEM = '你是会话压缩器。把对话历史压缩成要点摘要，供后续对话作为上下文使用。'

export function compactionPrompt(history: string): string {
  return [
    '请把以下对话历史压缩成一份要点摘要（用中文），必须保留：',
    '1. 用户的任务目标与约束；',
    '2. 已完成的关键操作与结果（含涉及的文件路径、命令）；',
    '3. 重要决定与未完成事项。',
    '直接输出摘要正文，不要客套话。',
    '',
    '=== 对话历史开始 ===',
    history,
    '=== 对话历史结束 ==='
  ].join('\n')
}

export function serializeForCompaction(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'user') return `[user] ${messageText(m)}`
      if (m.role === 'assistant') {
        const text = textOfBlocks(m.content)
        const tools = m.toolCalls.map((tc) => `[调用工具 ${tc.name}(${tc.arguments})]`).join(' ')
        return `[assistant] ${text}${tools ? ' ' + tools : ''}`
      }
      return `[tool_result] ${m.content.slice(0, 500)}`
    })
    .join('\n')
}

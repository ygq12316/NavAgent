import type { AgentMessage, TextContent, ThinkingContent } from '@shared/types'

type AssistantMsg = Extract<AgentMessage, { role: 'assistant' }>

/**
 * thinking 块清洗（对齐 pi 的 transform-messages thinking 规则）：
 * - 同模型：redacted / 有签名 → 原样保留（签名校验靠它）；空 thinking 且无签名 → 丢弃；
 * - 跨模型：加密 payload（redacted、仅签名无正文）无效 → 丢弃；有正文的 thinking 降级为 text 块。
 * 消息没有 model 标（旧数据）视为同模型。
 */
function cleanThinkingBlocks(m: AssistantMsg, currentModel?: string): AssistantMsg {
  const crossModel = currentModel !== undefined && m.model !== undefined && m.model !== currentModel
  // content 非 blocks（未升级的旧格式数据）原样放过
  if (!Array.isArray(m.content) || m.content.every((b) => b.type !== 'thinking')) return m
  const content = m.content.flatMap((b): (TextContent | ThinkingContent)[] => {
    if (b.type !== 'thinking') return [b]
    if (crossModel) {
      if (b.redacted) return []
      return b.thinking ? [{ type: 'text', text: b.thinking }] : []
    }
    if (b.redacted || b.thinkingSignature) return [b]
    return b.thinking ? [b] : []
  })
  return { ...m, content }
}

/**
 * 跨回合消息清洗（对齐 pi 的 transform-messages，按我们模型精简）。
 * 在每次 LLM 请求前调用，保证历史处于"可直接发给任何一家协议"的合法状态：
 * 1. 跳过 stopReason 为 error/aborted 的残缺 assistant 消息（重放会炸协议）；
 * 2. 孤立 tool call（有调用无结果，通常因中断）补合成 isError 结果，满足配对要求；
 * 3. thinking 块按签名/跨模型规则清洗（见 cleanThinkingBlocks）。
 * 历史消息可能是旧版本持久化的（无 stopReason 字段），undefined 视为正常保留。
 */
export function cleanMessagesForLlm(messages: AgentMessage[], currentModel?: string): AgentMessage[] {
  const out: AgentMessage[] = []
  let pendingCalls: { id: string; name: string }[] = []

  const flushSynthetic = (): void => {
    for (const tc of pendingCalls) {
      out.push({
        role: 'tool_result',
        callId: tc.id,
        toolName: tc.name,
        content: 'No result provided（执行被中断，未产生结果）',
        isError: true
      })
    }
    pendingCalls = []
  }

  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m.stopReason === 'error' || m.stopReason === 'aborted') continue
      // 上一条 assistant 的孤立调用在此处补结果（pi：user/assistant 都会打断工具流）
      flushSynthetic()
      if (m.toolCalls.length > 0) pendingCalls = m.toolCalls.map((tc) => ({ id: tc.id, name: tc.name }))
      out.push(cleanThinkingBlocks(m, currentModel))
    } else if (m.role === 'tool_result') {
      pendingCalls = pendingCalls.filter((pc) => pc.id !== m.callId)
      out.push(m)
    } else {
      flushSynthetic()
      out.push(m)
    }
  }
  flushSynthetic()
  return out
}

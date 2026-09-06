import type { AgentMessage, StopReason } from '@shared/types'
import { messageChars, messageText, textOfBlocks } from '@shared/types'
import type { Emit } from './engine-types'
import { COMPACTION_SYSTEM } from './context'

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 压缩策略（逐项对齐 pi 的 harness/compaction/compaction.ts）：
 * 阈值 = contextWindow − reserveTokens；保留预算 = keepRecentTokens（按 token 累积）；
 * 结构化摘要模板 + previousSummary 增量更新；摘要尾部附加文件操作清单；
 * 摘要消息用 <summary> 标签包裹。
 */

export interface CompactionSettings {
  enabled: boolean
  /** 为摘要请求与输出预留的 token */
  reserveTokens: number
  /** 压缩后保留的近期上下文 token 预算 */
  keepRecentTokens: number
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
  if (!settings.enabled) return false
  if (contextWindow <= 0) return false
  return contextTokens > contextWindow - settings.reserveTokens
}

// ── 摘要 prompt（逐字对齐 pi 的结构化模板） ──────────────────────────

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

// ── 摘要消息格式（对齐 pi 的 COMPACTION_SUMMARY_PREFIX/SUFFIX） ─────

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`

export function createCompactionSummaryMessage(summary: string): AgentMessage {
  return {
    role: 'user',
    content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`
  }
}

/** 从历史中提取最近一次压缩的摘要（增量更新的输入）；摘要消息恒为字符串 content */
export function findPreviousSummary(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user' || typeof m.content !== 'string') continue
    if (m.content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
      const body = m.content.slice(COMPACTION_SUMMARY_PREFIX.length)
      const end = body.lastIndexOf(COMPACTION_SUMMARY_SUFFIX)
      return (end >= 0 ? body.slice(0, end) : body).trim()
    }
  }
  return undefined
}

// ── 会话序列化（对齐 pi 的 serializeConversation） ──────────────────

const TOOL_RESULT_MAX_CHARS = 2000

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function serializeConversation(messages: AgentMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = messageText(msg)
      if (text) parts.push(`[User]: ${text}`)
    } else if (msg.role === 'assistant') {
      const text = textOfBlocks(msg.content)
      const toolCalls = msg.toolCalls.map((tc) => {
        let argsStr = ''
        try {
          argsStr = Object.entries(JSON.parse(tc.arguments || '{}') as Record<string, unknown>)
            .map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
            .join(', ')
        } catch {
          argsStr = tc.arguments
        }
        return `${tc.name}(${argsStr})`
      })
      if (text) parts.push(`[Assistant]: ${text}`)
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`)
    } else {
      if (msg.content) parts.push(`[Tool result]: ${msg.content.slice(0, TOOL_RESULT_MAX_CHARS)}`)
    }
  }
  return parts.join('\n\n')
}

// ── 文件操作清单（对齐 pi 的 extractFileOperations 简化版） ─────────

export interface FileOperations {
  readFiles: string[]
  modifiedFiles: string[]
}

export function extractFileOperations(messages: AgentMessage[]): FileOperations {
  const read = new Set<string>()
  const modified = new Set<string>()
  const pathOf = (argsJson: string): string | null => {
    try {
      const args = JSON.parse(argsJson || '{}') as Record<string, unknown>
      return typeof args.path === 'string' ? args.path : null
    } catch {
      return null
    }
  }
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const tc of m.toolCalls) {
      const p = pathOf(tc.arguments)
      if (!p) continue
      if (tc.name === 'read_file' || tc.name === 'glob' || tc.name === 'grep') read.add(p)
      if (tc.name === 'write_file' || tc.name === 'edit_file') modified.add(p)
    }
  }
  return { readFiles: [...read], modifiedFiles: [...modified] }
}

export function formatFileOperations(ops: FileOperations): string {
  const sections: string[] = []
  if (ops.readFiles.length > 0) {
    sections.push(`Files read:\n${ops.readFiles.map((f) => `- ${f}`).join('\n')}`)
  }
  if (ops.modifiedFiles.length > 0) {
    sections.push(`Files modified:\n${ops.modifiedFiles.map((f) => `- ${f}`).join('\n')}`)
  }
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : ''
}

// ── 切点：token 预算 + 有效切点（非 tool_result 边界）+ 配对安全 ──────

export interface CutPointResult {
  /** 压缩后保留的第一条消息下标 */
  firstKeptIndex: number
  /** 切点是否落在回合中间（回合前缀需单独摘要） */
  isSplitTurn: boolean
  /** split-turn 时的回合起点下标 */
  turnStartIndex: number
}

export function estimateTokensOf(message: AgentMessage): number {
  return Math.ceil(messageChars(message) / 2)
}

function isUserTurnStart(message: AgentMessage): boolean {
  return message.role === 'user'
}

/**
 * 选出保留预算 ≈ keepRecentTokens 的切点（对齐 pi 的 findCutPoint）：
 * 从尾部按 token 累积，到预算后在"有效切点"（非 tool_result）里取不早于该位置的最近一个；
 * 再做配对安全校验（悬空调用前移）。切不出安全位置返回 null。
 */
export function findCutPoint(messages: AgentMessage[], keepRecentTokens: number): CutPointResult | null {
  const validCuts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'tool_result') validCuts.push(i)
  }
  if (validCuts.length === 0) return null

  let accumulated = 0
  let candidate = validCuts[0]
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokensOf(messages[i])
    if (accumulated >= keepRecentTokens) {
      candidate = validCuts.find((c) => c >= i) ?? candidate
      break
    }
  }

  // 配对安全：摘要区不能留下"调用在摘要区、结果在保留区"的悬空
  for (;;) {
    if (candidate >= messages.length) return null
    while (candidate < messages.length && messages[candidate].role === 'tool_result') candidate++
    const callIds = new Set<string>()
    for (let i = 0; i < candidate; i++) {
      const m = messages[i]
      if (m.role === 'assistant') for (const tc of m.toolCalls) callIds.add(tc.id)
    }
    let violation = -1
    for (let i = candidate; i < messages.length; i++) {
      const m = messages[i]
      if (m.role === 'tool_result' && callIds.has(m.callId)) {
        violation = i
        break
      }
    }
    if (violation === -1) break
    candidate = violation + 1
  }

  if (candidate <= 0 || candidate >= messages.length) return null

  // split-turn 检测：保留区不是 user 回合起点 → 回合被切成两半
  const isUserStart = isUserTurnStart(messages[candidate])
  let turnStartIndex = -1
  if (!isUserStart) {
    for (let i = candidate; i >= 0; i--) {
      if (isUserTurnStart(messages[i])) {
        turnStartIndex = i
        break
      }
    }
  }
  return { firstKeptIndex: candidate, isSplitTurn: !isUserStart && turnStartIndex !== -1, turnStartIndex }
}

// ── 压缩主流程 ───────────────────────────────────────────────────────

export interface CompactionDeps {
  /** 用 provider 生成摘要（wiring 注入，内部带重试与 maxTokens 预算） */
  completeSummarization: (promptText: string, maxTokens: number, signal: AbortSignal) => Promise<string>
  emit: Emit
  /** 压缩结果快照持久化 */
  onSnapshot: (messages: AgentMessage[]) => void
  /** 压缩后通知编排器替换 transcript */
  onMessagesReplaced: (messages: AgentMessage[]) => void
  /** 当前模型上下文窗口（阈值 = window − reserveTokens） */
  getContextWindow: () => number
}

export interface CompactionPreparation {
  messagesToSummarize: AgentMessage[]
  turnPrefixMessages: AgentMessage[]
  retainedTail: AgentMessage[]
  isSplitTurn: boolean
  tokensBefore: number
  previousSummary?: string
  fileOps: FileOperations
}

/** 准备压缩输入；不可压缩（太短/切点不存在）返回 null */
export function prepareCompaction(
  messages: AgentMessage[],
  settings: CompactionSettings
): CompactionPreparation | null {
  if (messages.length < 4) return null
  const tokensBefore = estimateContextTokensOf(messages)
  const cut = findCutPoint(messages, settings.keepRecentTokens)
  if (cut === null) return null

  const messagesToSummarize = messages.slice(0, cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex)
  const turnPrefixMessages = cut.isSplitTurn ? messages.slice(cut.turnStartIndex, cut.firstKeptIndex) : []
  const retainedTail = messages.slice(cut.firstKeptIndex)
  if (messagesToSummarize.length === 0) return null

  return {
    messagesToSummarize,
    turnPrefixMessages,
    retainedTail,
    isSplitTurn: cut.isSplitTurn,
    tokensBefore,
    previousSummary: findPreviousSummary(messages),
    fileOps: extractFileOperations([...messagesToSummarize, ...turnPrefixMessages])
  }
}

function estimateContextTokensOf(messages: AgentMessage[]): number {
  // usage 锚定：最近有效 assistant 的完整上下文（非缓存输入+缓存读+缓存写+输出）+ 尾部启发式
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || !m.usage || m.stopReason === 'error' || m.stopReason === 'aborted') continue
    const u = m.usage
    const anchored =
      u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
    if (anchored <= 0) continue
    let trailing = 0
    for (let j = i + 1; j < messages.length; j++) trailing += estimateTokensOf(messages[j])
    return anchored + trailing
  }
  let total = 0
  for (const m of messages) total += estimateTokensOf(m)
  return total
}

/** 生成摘要（结构化模板 + previousSummary 增量 + maxTokens 预算） */
async function generateSummary(
  preparation: CompactionPreparation,
  deps: CompactionDeps,
  signal: AbortSignal
): Promise<string> {
  const maxTokens = Math.floor(0.8 * DEFAULT_COMPACTION_SETTINGS.reserveTokens)
  const basePrompt = preparation.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT
  const conversationText = serializeConversation(preparation.messagesToSummarize)
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`
  if (preparation.previousSummary) {
    promptText += `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n`
  }
  promptText += basePrompt
  return deps.completeSummarization(promptText, maxTokens, signal)
}

/** split-turn：回合前缀单独摘要（对齐 pi 的 TURN_PREFIX_SUMMARIZATION_PROMPT） */
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`

async function generateTurnPrefixSummary(
  turnPrefixMessages: AgentMessage[],
  deps: CompactionDeps,
  signal: AbortSignal
): Promise<string> {
  const maxTokens = Math.floor(0.5 * DEFAULT_COMPACTION_SETTINGS.reserveTokens)
  const promptText = `<conversation>\n${serializeConversation(turnPrefixMessages)}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`
  return deps.completeSummarization(promptText, maxTokens, signal)
}

/** 执行压缩：返回替换后的消息数组（对齐 pi 的 compact + buildSessionContext 重建规则） */
export async function compact(
  messages: AgentMessage[],
  deps: CompactionDeps,
  signal: AbortSignal
): Promise<AgentMessage[]> {
  const preparation = prepareCompaction(messages, DEFAULT_COMPACTION_SETTINGS)
  if (preparation === null) return messages

  let summary: string
  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    let historyText = 'No prior history.'
    if (preparation.messagesToSummarize.length > 0) {
      historyText = await generateSummary(preparation, deps, signal)
    }
    const prefixText = await generateTurnPrefixSummary(preparation.turnPrefixMessages, deps, signal)
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixText}`
  } else {
    summary = await generateSummary(preparation, deps, signal)
  }
  summary += formatFileOperations(preparation.fileOps)

  const next: AgentMessage[] = [
    createCompactionSummaryMessage(summary),
    { role: 'assistant', content: [{ type: 'text', text: '（已加载此前对话的摘要，将继续当前任务。）' }], toolCalls: [], stopReason: 'stop' as StopReason },
    ...preparation.retainedTail
  ]
  deps.onMessagesReplaced(next)
  deps.onSnapshot(next)
  deps.emit({ type: 'compacted', summary, removedCount: preparation.messagesToSummarize.length })
  return next
}

/** transformContext 钩子实现：超阈值自动压缩（阈值 = 窗口 − reserveTokens），失败静默返回原历史 */
export function createCompactionTransform(deps: CompactionDeps) {
  return async function transformContext(
    messages: AgentMessage[],
    signal: AbortSignal
  ): Promise<AgentMessage[]> {
    if (!shouldCompact(estimateContextTokensOf(messages), deps.getContextWindow(), DEFAULT_COMPACTION_SETTINGS)) {
      return messages
    }
    try {
      return await compact(messages, deps, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      return messages // 压缩失败不阻断正常回合
    }
  }
}

/** 手动 /compact 入口 */
export async function compactNow(messages: AgentMessage[], deps: CompactionDeps, signal: AbortSignal): Promise<AgentMessage[]> {
  return compact(messages, deps, signal)
}

export { COMPACTION_SYSTEM, errMsg }

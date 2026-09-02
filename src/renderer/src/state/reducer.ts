import type { AgentEvent, AgentMessage, ImageContent, StopReason, TextContent, ThinkingContent, Usage } from '@shared/types'
import { estimateCost, lookupModel } from '@shared/model-catalog'

/** 会话累计统计（message_end 时累加；reset 清零；成本未知 = null） */
export interface SessionStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turns: number
  costUsd: number | null
}

export const zeroStats = (): SessionStats => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, costUsd: 0 })

export type ToolStatus = 'streaming' | 'awaiting_approval' | 'running' | 'ok' | 'error' | 'denied'

export interface ToolVM {
  callId: string
  name: string
  args: string
  status: ToolStatus
  result?: string
  updates: string[]
}

export type Block =
  | { kind: 'user'; text: string; images?: ImageContent[] }
  | {
      kind: 'assistant'
      blocks: (TextContent | ThinkingContent)[]
      toolCalls: ToolVM[]
      stopReason: StopReason
      errorMessage?: string
      streaming: boolean
    }

export interface TurnVM {
  key: string
  blocks: Block[]
  done: boolean
}

export interface PermissionVM {
  requestId: string
  toolName: string
  detail: string
}

export interface UIState {
  turns: TurnVM[]
  working: boolean
  permission: PermissionVM | null
  usage: Usage | null
  errorMessage: string | null
  aborted: boolean
  retryHint: string | null
  notice: string | null
  /** 排队中的插话/续跑条数（queue_update 事件驱动） */
  queued: { steering: number; followUp: number }
  /** 会话累计 token/成本（挂 message_end，session 重放后自动恢复） */
  stats: SessionStats
}

export const initialState: UIState = {
  turns: [],
  working: false,
  permission: null,
  usage: null,
  errorMessage: null,
  aborted: false,
  retryHint: null,
  notice: null,
  queued: { steering: 0, followUp: 0 },
  stats: zeroStats()
}

export type Action =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'reset' }
  | { kind: 'closePermission' }

let turnSeq = 0

function mapLast<T>(arr: T[], fn: (item: T) => T): T[] {
  if (arr.length === 0) return arr
  return [...arr.slice(0, -1), fn(arr[arr.length - 1])]
}

function lastAssistantBlock(turn: TurnVM): Extract<Block, { kind: 'assistant' }> | null {
  for (let i = turn.blocks.length - 1; i >= 0; i--) {
    const b = turn.blocks[i]
    if (b.kind === 'assistant') return b
  }
  return null
}

function withAssistantBlock(state: UIState, fn: (b: Extract<Block, { kind: 'assistant' }>) => Extract<Block, { kind: 'assistant' }>): UIState {
  return mapTurn(state, (t) => {
    const existing = lastAssistantBlock(t)
    if (!existing) return t
    return { ...t, blocks: t.blocks.map((b) => (b.kind === 'assistant' && b === existing ? fn(b) : b)) }
  })
}

function mapTurn(state: UIState, fn: (turn: TurnVM) => TurnVM): UIState {
  return { ...state, turns: mapLast(state.turns, fn) }
}

function findTool(turn: TurnVM, callId: string): { block: Extract<Block, { kind: 'assistant' }>; tool: ToolVM } | null {
  for (let i = turn.blocks.length - 1; i >= 0; i--) {
    const b = turn.blocks[i]
    if (b.kind !== 'assistant') continue
    const tool = b.toolCalls.find((t) => t.callId === callId)
    if (tool) return { block: b, tool }
  }
  return null
}

function mapToolInLastTurn(state: UIState, callId: string, fn: (t: ToolVM) => ToolVM): UIState {
  return mapTurn(state, (t) => {
    const found = findTool(t, callId)
    if (!found) return t
    return {
      ...t,
      blocks: t.blocks.map((b) =>
        b.kind === 'assistant' && b === found.block
          ? { ...b, toolCalls: b.toolCalls.map((x) => (x.callId === callId ? fn(x) : x)) }
          : b
      )
    }
  })
}

function toolsFromMessage(message: AgentMessage & { role: 'assistant' }, previous: ToolVM[]): ToolVM[] {
  return message.toolCalls.map((tc) => {
    const old = previous.find((p) => p.callId === tc.id)
    return {
      callId: tc.id,
      name: tc.name,
      args: tc.arguments,
      status: old?.status ?? 'streaming',
      result: old?.result,
      updates: old?.updates ?? []
    }
  })
}

function userBlockOf(msg: AgentMessage & { role: 'user' }): { kind: 'user'; text: string; images?: ImageContent[] } {
  if (typeof msg.content === 'string') return { kind: 'user', text: msg.content }
  return {
    kind: 'user',
    text: msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    images: msg.content.filter((b): b is ImageContent => b.type === 'image')
  }
}

/** assistant 消息计入累计统计（成本查目录，含缓存计价；任一未知 → 总成本置 null） */
function accumulateStats(stats: SessionStats, msg: AgentMessage & { role: 'assistant' }): SessionStats {
  const usage = msg.usage
  if (!usage) return stats
  const delta = estimateCost(usage, lookupModel(undefined, msg.model ?? ''))
  const costUsd = delta === null ? null : stats.costUsd === null ? null : stats.costUsd + delta
  return {
    ...stats,
    inputTokens: stats.inputTokens + usage.inputTokens,
    outputTokens: stats.outputTokens + usage.outputTokens,
    cacheReadTokens: stats.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: stats.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    costUsd
  }
}

function applyEvent(state: UIState, e: AgentEvent): UIState {
  switch (e.type) {
    case 'agent_start':
      return { ...state, working: true, errorMessage: null, aborted: false, retryHint: null, notice: null }

    case 'turn_start':
      turnSeq += 1
      return { ...state, turns: [...state.turns, { key: `t${turnSeq}`, blocks: [], done: false }], stats: { ...state.stats, turns: state.stats.turns + 1 } }

    case 'message_start': {
      const msg = e.message
      if (msg.role === 'user') {
        const ub = userBlockOf(msg)
        return mapTurn(state, (t) => ({ ...t, blocks: [...t.blocks, ub] }))
      }
      if (msg.role === 'assistant') {
        return mapTurn(state, (t) => ({
          ...t,
          blocks: [
            ...t.blocks,
            {
              kind: 'assistant',
              blocks: msg.content.map((b) => ({ ...b })),
              toolCalls: toolsFromMessage(msg, []),
              stopReason: msg.stopReason,
              streaming: true
            }
          ]
        }))
      }
      return state
    }

    case 'message_update': {
      const msg = e.message
      if (msg.role !== 'assistant') return state
      return withAssistantBlock(state, (b) => ({
        ...b,
        blocks: msg.content.map((x) => ({ ...x })),
        toolCalls: toolsFromMessage(msg, b.toolCalls),
        stopReason: msg.stopReason
      }))
    }

    case 'message_end': {
      const msg = e.message
      if (msg.role === 'user') {
        const ub = userBlockOf(msg)
        return mapTurn(state, (t) => ({
          ...t,
          blocks: t.blocks.map((b) => (b.kind === 'user' && b.text === '' && !b.images?.length ? ub : b))
        }))
      }
      if (msg.role === 'assistant') {
        const next = withAssistantBlock(state, (b) => ({
          ...b,
          blocks: msg.content.map((x) => ({ ...x })),
          toolCalls: toolsFromMessage(msg, b.toolCalls),
          stopReason: msg.stopReason,
          errorMessage: msg.errorMessage,
          streaming: false
        }))
        const withStats = { ...next, stats: accumulateStats(next.stats, msg) }
        if (msg.stopReason === 'error') {
          return { ...withStats, errorMessage: msg.errorMessage ?? '请求失败' }
        }
        if (msg.stopReason === 'aborted') {
          return { ...withStats, aborted: true }
        }
        return withStats
      }
      return state
    }

    case 'tool_execution_start': {
      const exists = state.turns.some((t) => findTool(t, e.toolCallId))
      if (exists) {
        return mapToolInLastTurn(state, e.toolCallId, (t) => ({ ...t, args: e.args, status: 'running' }))
      }
      // 独立追加（理论上不该发生：工具调用已在 assistant 消息里）
      return mapTurn(state, (t) => {
        const b = lastAssistantBlock(t)
        if (!b) return t
        return {
          ...t,
          blocks: t.blocks.map((x) =>
            x.kind === 'assistant' && x === b
              ? { ...x, toolCalls: [...x.toolCalls, { callId: e.toolCallId, name: e.toolName, args: e.args, status: 'running', updates: [] }] }
              : x
          )
        }
      })
    }

    case 'tool_execution_update':
      return mapToolInLastTurn(state, e.toolCallId, (t) => ({ ...t, updates: [...t.updates, e.partialResult] }))

    case 'tool_execution_end':
      return mapToolInLastTurn(state, e.toolCallId, (t) => ({
        ...t,
        status: e.isError ? (e.result.includes('拒绝') ? 'denied' : 'error') : 'ok',
        result: e.result
      }))

    case 'permission_request': {
      const withAwaiting = mapTurn(state, (t) => {
        const rev = [...t.blocks]
          .reverse()
          .findIndex(
            (b) => b.kind === 'assistant' && b.toolCalls.some((x) => x.name === e.toolName && x.status === 'running')
          )
        if (rev === -1) return t
        const idx = t.blocks.length - 1 - rev
        return {
          ...t,
          blocks: t.blocks.map((b, i) =>
            i === idx && b.kind === 'assistant'
              ? { ...b, toolCalls: b.toolCalls.map((x) => (x.name === e.toolName && x.status === 'running' ? { ...x, status: 'awaiting_approval' } : x)) }
              : b
          )
        }
      })
      return { ...withAwaiting, permission: { requestId: e.requestId, toolName: e.toolName, detail: e.detail } }
    }

    case 'turn_end':
      return {
        ...mapTurn(state, (t) => ({ ...t, done: true, blocks: t.blocks.map((b) => (b.kind === 'assistant' ? { ...b, streaming: false } : b)) })),
        usage: e.message.role === 'assistant' && e.message.usage ? e.message.usage : state.usage,
        retryHint: null
      }

    case 'agent_end':
      return {
        ...state,
        working: false,
        retryHint: null,
        turns: state.turns.map((t) => ({ ...t, done: true, blocks: t.blocks.map((b) => (b.kind === 'assistant' ? { ...b, streaming: false } : b)) }))
      }

    case 'compacted': {
      turnSeq += 1
      const notice: TurnVM = {
        key: `compact_${turnSeq}`,
        blocks: [{ kind: 'user', text: `📜 已压缩历史（移除 ${e.removedCount} 条消息，上下文已释放）\n${e.summary}` }],
        done: true
      }
      return { ...state, turns: [notice] }
    }

    case 'retrying':
      return {
        ...state,
        retryHint: `请求失败（${e.reason}），${e.delayMs}ms 后进行第 ${e.attempt}/${e.maxRetries} 次重试…`
      }

    case 'notice':
      return { ...state, notice: e.message }

    case 'queue_update':
      return { ...state, queued: { steering: e.steering, followUp: e.followUp } }
  }
}

export function reducer(state: UIState, action: Action): UIState {
  switch (action.kind) {
    case 'reset':
      return { ...initialState }
    case 'closePermission':
      return { ...state, permission: null }
    case 'event':
      return applyEvent(state, action.event)
  }
}

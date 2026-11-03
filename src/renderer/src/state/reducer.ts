import type {
  AgentEvent,
  AgentMessage,
  DiffSummary,
  ImageContent,
  SessionLoadResult,
  SessionMeta,
  StopReason,
  TextContent,
  ThinkingContent,
  Usage
} from '@shared/types'
import { estimateCost, lookupModel } from '@shared/model-catalog'
import {
  closePane,
  defaultPaneLayout,
  findPath,
  insertNear,
  openPane,
  removeAt,
  setRatioAt,
  swapKinds,
  type PaneKind,
  type PaneNode
} from './pane-layout'

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
  | { kind: 'user'; text: string; images?: ImageContent[]; nodeId?: string }
  | { kind: 'injected'; rel: string; nodeId?: string }
  | {
      kind: 'assistant'
      blocks: (TextContent | ThinkingContent)[]
      toolCalls: ToolVM[]
      stopReason: StopReason
      errorMessage?: string
      streaming: boolean
      /** 所属会话树节点（rewind/fork 定位用；store 落盘时打标） */
      nodeId?: string
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

/** 单会话视图状态（事件流的增量累积结果；一桶一会话） */
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
  /** 会话累计 token/成本（挂 message_end，hydrate 后自动恢复） */
  stats: SessionStats
  /** 扩展弹窗（ctx.ui 挂起-应答；单槽，同 permission 先例） */
  uiDialog: UiDialogVM | null
}

export interface UiDialogVM {
  requestId: string
  kind: 'confirm' | 'input' | 'select'
  title: string
  message?: string
  placeholder?: string
  options?: string[]
}

export const initialSessionState: UIState = {
  turns: [],
  working: false,
  permission: null,
  usage: null,
  errorMessage: null,
  aborted: false,
  retryHint: null,
  notice: null,
  queued: { steering: 0, followUp: 0 },
  stats: zeroStats(),
  uiDialog: null
}

/** transcript 视图模式（对齐 CC 桌面端 Normal/Verbose/Summary） */
export type ViewMode = 'normal' | 'verbose' | 'summary'

/** 应用级状态：会话桶 + 会话 pane 编排（1-2 个会话并排）+ 每会话布局 */
export interface AppState {
  sessions: Record<string, UIState>
  metas: Record<string, SessionMeta>
  /** 当前项目的会话列表（侧栏） */
  sessionList: SessionMeta[]
  /** 打开的会话 pane：1-2 个；focus 决定键盘/Composer 归属 */
  panes: { left: string; right: string | null; focus: 'left' | 'right' }
  /** 每会话的 pane 分割树 */
  layouts: Record<string, PaneNode>
  /** 每会话最大化的 pane（null = 无；最大化铺满会话区，其余 pane 保持开启但隐藏） */
  maximized: Record<string, PaneKind | null>
  drafts: Record<string, string>
  /** File pane 当前文件（key 变化强制重挂载） */
  fileTargets: Record<string, { path: string; key: number } | null>
  /** 每会话的终端 PTY id 列表（pane 关闭不杀 PTY；重开回放） */
  ptys: Record<string, string[]>
  /** 聊天区 +N −M chip 数据 */
  diffSummaries: Record<string, DiffSummary | null>
  viewModes: Record<string, ViewMode>
}

export const initialAppState: AppState = {
  sessions: {},
  metas: {},
  sessionList: [],
  panes: { left: '', right: null, focus: 'left' },
  layouts: {},
  maximized: {},
  drafts: {},
  fileTargets: {},
  ptys: {},
  diffSummaries: {},
  viewModes: {}
}

export type Action =
  | { kind: 'addressed'; sessionId: string; event: AgentEvent }
  /** 渲染合帧：一批事件一次 reducer 折叠（流式/工具高频事件逐条 dispatch 会放大成重渲染风暴） */
  | { kind: 'eventsBatch'; items: { sessionId: string; event: AgentEvent }[] }
  | { kind: 'hydrate'; sessionId: string; result: SessionLoadResult }
  | { kind: 'openSession'; sessionId: string; side?: 'left' | 'right' }
  | { kind: 'closeSessionPane'; side: 'left' | 'right' }
  | { kind: 'focusSessionPane'; side: 'left' | 'right' }
  | { kind: 'togglePane'; sessionId: string; pane: 'files' | 'file' | 'terminal' | 'diff' }
  | { kind: 'closePane'; sessionId: string; pane: PaneKind }
  | { kind: 'setMaximized'; sessionId: string; pane: PaneKind | null }
  | { kind: 'seedLayouts'; layouts: Record<string, PaneNode> }
  | { kind: 'openFile'; sessionId: string; path: string }
  | { kind: 'setDraft'; sessionId: string; text: string }
  | { kind: 'setSessions'; list: SessionMeta[] }
  | { kind: 'patchMeta'; sessionId: string; patch: Partial<SessionMeta> }
  | { kind: 'setPty'; sessionId: string; ptyId: string | null }
  | { kind: 'removePty'; sessionId: string; ptyId: string }
  | { kind: 'setDiffSummary'; sessionId: string; summary: DiffSummary | null }
  | { kind: 'setViewMode'; sessionId: string; mode: ViewMode }
  | { kind: 'closePermission'; sessionId: string }
  | { kind: 'closeUiDialog'; sessionId: string }
  /** pane 拖拽/缩放（路径语义见 pane-layout） */
  | { kind: 'paneRatio'; sessionId: string; path: number[]; ratio: number }
  | { kind: 'paneDrop'; sessionId: string; win: PaneKind; target: PaneKind; mode: 'left' | 'right' | 'top' | 'bottom' | 'swap' }

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

function userBlockOf(msg: AgentMessage & { role: 'user' }): Block {
  if (msg.injectedPath) return { kind: 'injected', rel: msg.injectedPath, nodeId: msg.nodeId }
  const base = {
    kind: 'user' as const,
    text:
      typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    nodeId: msg.nodeId
  }
  if (typeof msg.content === 'string') return base
  return {
    ...base,
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
        // 注入文件以独立合成消息进上下文：自成一个 turn（与 hydrate 的"每条 user 消息一个 turn"一致）
        if (msg.injectedPath) {
          turnSeq += 1
          return {
            ...state,
            turns: [...state.turns, { key: `t${turnSeq}`, blocks: [userBlockOf(msg)], done: true }]
          }
        }
        const ub = userBlockOf(msg)
        // message_start 已渲染同一条消息（nodeId 要到落盘时才有）——按最后一个 turn 里
        // 首个未打标的 user 块回填；找不到（异常缺 message_start）时兜底追加保证可见
        return mapTurn(state, (t) => {
          const idx = t.blocks.findIndex((b) => b.kind === 'user' && !b.nodeId)
          if (idx === -1) return { ...t, blocks: [...t.blocks, ub] }
          return { ...t, blocks: t.blocks.map((b, i) => (i === idx ? ub : b)) }
        })
      }
      if (msg.role === 'assistant') {
        const next = withAssistantBlock(state, (b) => ({
          ...b,
          blocks: msg.content.map((x) => ({ ...x })),
          toolCalls: toolsFromMessage(msg, b.toolCalls),
          stopReason: msg.stopReason,
          errorMessage: msg.errorMessage,
          streaming: false,
          nodeId: msg.nodeId
        }))
        // 上下文占用即时回落/推进：不等 turn_end（工具批次执行期间也反映最新一轮请求）
        const withUsage = { ...next, usage: msg.usage ?? next.usage }
        const withStats = { ...withUsage, stats: accumulateStats(withUsage.stats, msg) }
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
        // 回合终态：挂起的审批/扩展弹窗全部作废（主进程 abort 路径已 deny），
        // 否则模态遮罩滞留会挡住输入框
        permission: null,
        uiDialog: null,
        turns: state.turns.map((t) => ({ ...t, done: true, blocks: t.blocks.map((b) => (b.kind === 'assistant' ? { ...b, streaming: false } : b)) }))
      }

    case 'compacted': {
      turnSeq += 1
      const notice: TurnVM = {
        key: `compact_${turnSeq}`,
        blocks: [{ kind: 'user', text: `已压缩历史（移除 ${e.removedCount} 条消息，上下文已释放）\n${e.summary}` }],
        done: true
      }
      // usage 是压缩前的旧口径，保留会让占用显示虚高；清零待下一轮真实 usage 回填
      return { ...state, turns: [notice], usage: null }
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

    case 'ui_request':
      return {
        ...state,
        uiDialog: {
          requestId: e.requestId,
          kind: e.kind,
          title: e.title,
          ...(e.message !== undefined ? { message: e.message } : {}),
          ...(e.placeholder !== undefined ? { placeholder: e.placeholder } : {}),
          ...(e.options !== undefined ? { options: e.options } : {})
        }
      }

    // 事件协议只增不改：未知事件类型（如并行落地的 panel_*）在此静默忽略，前向兼容
    default:
      return state
  }
}

// ── hydrate：message 行 → 会话桶（修复旧"切换会话历史不渲染"问题：不再依赖 turn_start 重放） ──

export function sessionStateFromMessages(messages: AgentMessage[]): UIState {
  const turns: TurnVM[] = []
  let stats = zeroStats()
  let usage: Usage | null = null
  let cur: TurnVM | null = null

  const ensureTurn = (): TurnVM => {
    if (!cur) {
      turnSeq += 1
      cur = { key: `t${turnSeq}`, blocks: [], done: false }
      turns.push(cur)
    }
    return cur
  }

  for (const m of messages) {
    if (m.role === 'user') {
      turnSeq += 1
      cur = { key: `t${turnSeq}`, blocks: [userBlockOf(m)], done: false }
      turns.push(cur)
    } else if (m.role === 'assistant') {
      const turn = ensureTurn()
      turn.blocks.push({
        kind: 'assistant',
        blocks: m.content.map((x) => ({ ...x })),
        toolCalls: m.toolCalls.map((tc) => ({ callId: tc.id, name: tc.name, args: tc.arguments, status: 'streaming', updates: [] })),
        stopReason: m.stopReason,
        errorMessage: m.errorMessage,
        streaming: false,
        nodeId: m.nodeId
      })
      stats = accumulateStats(stats, m)
      if (m.usage) usage = m.usage
    } else {
      const turn = ensureTurn()
      for (const b of turn.blocks) {
        if (b.kind !== 'assistant') continue
        const tool = b.toolCalls.find((x) => x.callId === m.callId)
        if (tool) {
          tool.status = m.isError ? (m.content.includes('拒绝') ? 'denied' : 'error') : 'ok'
          tool.result = m.content
        }
      }
    }
  }
  // 中断会话可能存在无结果的工具调用：归一为 error，避免历史里永远转圈
  for (const t of turns) {
    t.done = true
    for (const b of t.blocks) {
      if (b.kind !== 'assistant') continue
      b.streaming = false
      for (const tool of b.toolCalls) {
        if (tool.status === 'streaming' || tool.status === 'running' || tool.status === 'awaiting_approval') {
          tool.status = 'error'
          tool.result = tool.result ?? '（中断，无结果）'
        }
      }
    }
  }
  return { ...initialSessionState, turns, stats, usage }
}

// ── 应用级 reducer ─────────────────────────────────────────

const layoutOf = (s: AppState, sid: string): PaneNode => s.layouts[sid] ?? defaultPaneLayout()

function focusedId(s: AppState): string {
  return s.panes.focus === 'right' && s.panes.right ? s.panes.right : s.panes.left
}

export function appReducer(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case 'addressed': {
      // '' = 应用级 notice：落到当前聚焦会话
      const sid = action.sessionId || focusedId(state)
      if (!sid) return state
      const bucket = state.sessions[sid] ?? initialSessionState
      const applied = applyEvent(bucket, action.event)
      // 事件未改变会话桶（未知事件/pty 类）时原样返回：React 据此跳过整树重渲染
      if (applied === bucket) return state
      return { ...state, sessions: { ...state.sessions, [sid]: applied } }
    }

    case 'eventsBatch': {
      let next = state
      for (const item of action.items) {
        const sid = item.sessionId || focusedId(next)
        if (!sid) continue
        const bucket = next.sessions[sid] ?? initialSessionState
        const applied = applyEvent(bucket, item.event)
        if (applied === bucket) continue
        next = { ...next, sessions: { ...next.sessions, [sid]: applied } }
      }
      return next
    }

    case 'hydrate': {
      const { sessionId, result } = action
      if (!result.ok) return state
      return {
        ...state,
        sessions: { ...state.sessions, [sessionId]: sessionStateFromMessages(result.messages) },
        metas: { ...state.metas, [sessionId]: result.meta }
      }
    }

    case 'openSession': {
      const side = action.side ?? state.panes.focus
      const panes =
        side === 'right'
          ? { ...state.panes, right: action.sessionId, focus: 'right' as const }
          : { ...state.panes, left: action.sessionId, focus: 'left' as const }
      return { ...state, panes }
    }

    case 'closeSessionPane': {
      if (action.side === 'right') {
        return { ...state, panes: { ...state.panes, right: null, focus: 'left' } }
      }
      // 左栏关闭：有右栏则顶替，否则保留（至少显示一个会话）
      if (state.panes.right) {
        return { ...state, panes: { left: state.panes.right, right: null, focus: 'left' } }
      }
      return state
    }

    case 'focusSessionPane':
      return { ...state, panes: { ...state.panes, focus: action.side } }

    case 'togglePane': {
      const cur = layoutOf(state, action.sessionId)
      const maxed = state.maximized[action.sessionId] ?? null
      // 最大化中点自己的召唤钮：仅还原（保持开启），不动树
      if (maxed === action.pane) {
        return { ...state, maximized: { ...state.maximized, [action.sessionId]: null } }
      }
      const has = ((): boolean => {
        const walk = (n: PaneNode): boolean => (n.t === 'leaf' ? n.kind === action.pane : walk(n.a) || walk(n.b))
        return walk(cur)
      })()
      const next = has ? closePane(cur, action.pane) : openPane(cur, action.pane)
      // 最大化期间点其他召唤钮：先还原再切换
      const clearMax = maxed ? { ...state.maximized, [action.sessionId]: null } : state.maximized
      return { ...state, layouts: { ...state.layouts, [action.sessionId]: next }, maximized: clearMax }
    }

    case 'closePane': {
      // 真关闭：从树摘除；若关闭的是最大化 pane 则同时还原
      const cur = layoutOf(state, action.sessionId)
      const next = closePane(cur, action.pane)
      const maxed = state.maximized[action.sessionId] ?? null
      const maximized = maxed === action.pane ? { ...state.maximized, [action.sessionId]: null } : state.maximized
      return { ...state, layouts: { ...state.layouts, [action.sessionId]: next }, maximized }
    }

    case 'setMaximized':
      return { ...state, maximized: { ...state.maximized, [action.sessionId]: action.pane } }

    case 'seedLayouts':
      return { ...state, layouts: { ...action.layouts, ...state.layouts } }

    case 'openFile': {
      const cur = layoutOf(state, action.sessionId)
      return {
        ...state,
        layouts: { ...state.layouts, [action.sessionId]: openPane(cur, 'file') },
        fileTargets: { ...state.fileTargets, [action.sessionId]: { path: action.path, key: (state.fileTargets[action.sessionId]?.key ?? 0) + 1 } }
      }
    }

    case 'setDraft':
      return { ...state, drafts: { ...state.drafts, [action.sessionId]: action.text } }

    case 'setSessions':
      return { ...state, sessionList: action.list }

    case 'patchMeta': {
      const cur = state.metas[action.sessionId]
      if (!cur) return state
      return { ...state, metas: { ...state.metas, [action.sessionId]: { ...cur, ...action.patch } } }
    }

    case 'setPty': {
      const cur = state.ptys[action.sessionId] ?? []
      const next = action.ptyId ? [...cur, action.ptyId] : cur
      return { ...state, ptys: { ...state.ptys, [action.sessionId]: next } }
    }

    case 'removePty':
      return {
        ...state,
        ptys: { ...state.ptys, [action.sessionId]: (state.ptys[action.sessionId] ?? []).filter((x) => x !== action.ptyId) }
      }

    case 'setDiffSummary':
      return { ...state, diffSummaries: { ...state.diffSummaries, [action.sessionId]: action.summary } }

    case 'setViewMode':
      return { ...state, viewModes: { ...state.viewModes, [action.sessionId]: action.mode } }

    case 'closePermission': {
      const bucket = state.sessions[action.sessionId]
      if (!bucket) return state
      return { ...state, sessions: { ...state.sessions, [action.sessionId]: { ...bucket, permission: null } } }
    }
    case 'closeUiDialog': {
      const bucket = state.sessions[action.sessionId]
      if (!bucket) return state
      return { ...state, sessions: { ...state.sessions, [action.sessionId]: { ...bucket, uiDialog: null } } }
    }

    case 'paneRatio':
      return { ...state, layouts: { ...state.layouts, [action.sessionId]: setRatioAt(layoutOf(state, action.sessionId), action.path, action.ratio) } }

    case 'paneDrop': {
      const cur = layoutOf(state, action.sessionId)
      if (action.win === action.target) return state
      if (action.mode === 'swap') {
        if (!findPath(cur, action.target)) return state
        return { ...state, layouts: { ...state.layouts, [action.sessionId]: swapKinds(cur, action.win, action.target) } }
      }
      const p = findPath(cur, action.win)
      if (!p) return state
      const removed = removeAt(cur, p)
      if (!removed) return state
      const dir = action.mode === 'left' || action.mode === 'right' ? ('row' as const) : ('col' as const)
      const first = action.mode === 'left' || action.mode === 'top'
      if (!findPath(removed, action.target)) {
        const fresh: PaneNode = { t: 'leaf', kind: action.win }
        return {
          ...state,
          layouts: { ...state.layouts, [action.sessionId]: { t: 'split', dir, ratio: 0.5, a: first ? fresh : removed, b: first ? removed : fresh } }
        }
      }
      return { ...state, layouts: { ...state.layouts, [action.sessionId]: insertNear(removed, action.target, dir, first, action.win) } }
    }
  }
}

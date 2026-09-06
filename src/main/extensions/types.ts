import type { AgentMessage } from '@shared/types'
import type { Tool } from '../tools/registry'

/**
 * 扩展 API（对齐 pi 的 extensions：自定义工具/命令 + 拦截与观察事件 + 状态持久化）。
 * 扩展模块 = ESM default export `function (pi)`（可为 async）；在主进程运行，拥有完整系统权限。
 * 信任边界：全局目录（userData/extensions）视为用户自有；项目目录（.navagent/extensions）必须受信任后才加载。
 *
 * 两类事件：
 * - 拦截型（tool_call/tool_result）：串行链、有返回契约（首 block 短路、args/结果链式传递）
 * - 观察型（生命周期）：只读、dispatch 处逐个 await 完成（对齐 pi 的 subscribers awaited）
 *
 * 并发语义：注册表进程级全局共享，handler 可能被多个并行会话并发调用——ctx.sessionId 区分来源，
 * handler 内不要假设"当前只有一个会话"。
 */

/** 扩展工具定义 = Tool + 可选 mutating 声明（只读模式下会被剔除） */
export type ExtensionTool = Tool<any>

export interface ExtensionCommand {
  /** 斜杠命令名（不含 /）；[a-z0-9_-] */
  name: string
  description: string
  /** 返回文本将以 notice 事件回显到界面；ctx 区分来源会话 */
  handler: (args: string, ctx: ExtensionContext) => string | Promise<string>
}

/** 扩展私有 K-V 存储（pi.state：userData/ext-state/<extId>.json；ctx.session：会话 JSONL ext 行） */
export interface StateStore {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
  keys(): string[]
}

/** 扩展 GUI 交互原语（替代 pi 的 ctx.ui TUI 组件；renderer 弹窗挂起-应答） */
export interface ExtensionUi {
  /** 即时提示（走 notice 通道，不挂起） */
  notify(text: string, level?: 'info' | 'warn' | 'error'): void
  /** 确认框；取消/关闭 = false */
  confirm(title: string, message?: string): Promise<boolean>
  /** 单行输入；取消/关闭 = null */
  input(title: string, opts?: { message?: string; placeholder?: string }): Promise<string | null>
  /** 单选；取消/关闭 = null */
  select(title: string, options: string[], opts?: { message?: string }): Promise<string | null>
}

/** 会话树能力面（ctx.sessions）：扩展经此访问 fork/分支数据，不直接触碰 IPC 与存储 */
export interface SessionsCapability {
  /** 全量节点树 + 当前活动叶子（非线性对话的数据源） */
  getTree(sessionId: string): Promise<{ nodes: import('@shared/types').SessionTreeNode[]; leafId: string | null }>
  /** 从指定节点派生新会话（祖先链复制）；源会话运行中返回 null */
  fork(sessionId: string, nodeId: string): Promise<string | null>
  /** 切换活动叶子（summarize=为被离开路径生成分支摘要）；运行中返回 'busy' */
  switchLeaf(sessionId: string, nodeId: string, summarize: boolean): Promise<import('@shared/types').TreeSummaryResult | 'busy'>
  /** 项目下全部会话元数据（含 forkSourceId，会话地图的数据源） */
  listSessions(projectPath: string): Promise<import('@shared/types').SessionMeta[]>
  /** 删除会话：派生子会话断线提升为新的根（不级联删除） */
  removeSession(sessionId: string): Promise<'ok' | 'not-found'>
}

/** 每次调用注入的上下文（多会话共享注册表，ctx 区分来源） */
export interface ExtensionContext {
  sessionId: string
  workspacePath: string
  /** 拦截型=引擎当前 run 的 AbortSignal；观察型=会话级 controller（session_end/drop 时 abort） */
  signal: AbortSignal
  /** 会话级 K-V（跨重启随会话恢复） */
  session: StateStore
  /** GUI 交互原语 */
  ui: ExtensionUi
  /** 会话树能力面（fork/分支/切换） */
  sessions: SessionsCapability
}

// ── 拦截型事件 ────────────────────────────────────────────────

export interface ToolCallEvent {
  toolName: string
  args: Record<string, unknown>
}

export interface ToolCallInterception {
  /** 拦截并阻止执行 */
  block?: boolean
  reason?: string
  /** 改写工具参数（后续拦截器与执行都会看到改写值） */
  args?: Record<string, unknown>
}

export type ToolCallInterceptor = (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallInterception | void | Promise<ToolCallInterception | void>

export interface ToolResultEvent {
  toolCallId: string
  toolName: string
  /** 权限门后的实际执行参数（可能已被 tool_call 拦截器改写） */
  args: Record<string, unknown>
  result: { content: string; isError: boolean }
}

export interface ToolResultOverwrite {
  content?: string
  isError?: boolean
  terminate?: boolean
}

export type ToolResultInterceptor = (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultOverwrite | void | Promise<ToolResultOverwrite | void>

// ── 观察型事件 ────────────────────────────────────────────────

export interface SessionStartEvent {
  sessionId: string
}
export interface SessionEndEvent {
  sessionId: string
  reason: 'delete' | 'quit'
}
export interface AgentEndEvent {
  stopReason: string
}
export interface TurnEndEvent {
  message: AgentMessage
  toolResults: AgentMessage[]
}
export interface CompactedEvent {
  summary: string
  removedCount: number
}

// ── 事件表 ────────────────────────────────────────────────────

/** 拦截型/观察型统一事件表：键集即合法事件名 */
export interface ExtensionHandlers {
  tool_call: ToolCallInterceptor
  tool_result: ToolResultInterceptor
  session_start: (e: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>
  session_end: (e: SessionEndEvent, ctx: ExtensionContext) => void | Promise<void>
  agent_start: (e: Record<string, never>, ctx: ExtensionContext) => void | Promise<void>
  agent_end: (e: AgentEndEvent, ctx: ExtensionContext) => void | Promise<void>
  turn_start: (e: Record<string, never>, ctx: ExtensionContext) => void | Promise<void>
  turn_end: (e: TurnEndEvent, ctx: ExtensionContext) => void | Promise<void>
  compacted: (e: CompactedEvent, ctx: ExtensionContext) => void | Promise<void>
}

export type ExtensionEventName = keyof ExtensionHandlers
export type ExtensionHandler = ExtensionHandlers[ExtensionEventName]

// ── 扩展面板（沙箱 GUI 宿主） ─────────────────────────────────

/** 面板声明：entry 为扩展目录内相对路径（经 navagent-ext:// 只读协议加载进沙箱 iframe） */
export interface PanelSpec {
  title: string
  entry: string
  width?: number
  height?: number
}

/** 面板句柄：扩展 main 侧主动推送 / 关闭 */
export interface PanelHandle {
  /** 推送任意 JSON 到面板（renderer 转发进 iframe postMessage） */
  push(payload: unknown): void
  /** 关闭面板（renderer 卸载宿主） */
  close(): void
}

/** 面板消息处理：面板 GUI 经桥 invoke 到达；ctx 由 main 按面板归属会话注入 */
export interface PanelMessageHandlers {
  onMessage?(op: string, params: Record<string, unknown>, ctx: ExtensionContext): unknown | Promise<unknown>
}

export interface ExtensionApi {
  registerTool: (tool: ExtensionTool) => void
  registerCommand: (name: string, cmd: { description: string; handler: ExtensionCommand['handler'] }) => void
  /** 订阅事件；同事件可多次订阅，按注册顺序执行 */
  on: <K extends ExtensionEventName>(event: K, handler: ExtensionHandlers[K]) => void
  /** 扩展私有全局 K-V（注册期绑定本扩展，跨重启持久） */
  state: StateStore
  /**
   * 打开扩展面板（沙箱 iframe 宿主；同扩展可多面板，panelId 唯一）。
   * sessionId 决定事件信封与 onMessage 注入的 ctx；不传则为全局面板（ctx 需 params 自带 sessionId）。
   */
  openPanel: (spec: PanelSpec, handlers?: PanelMessageHandlers, sessionId?: string) => PanelHandle
}

export interface LoadedExtension {
  tools: ExtensionTool[]
  commands: ExtensionCommand[]
}

export interface ExtensionScanSpec {
  dir: string
  source: 'global' | 'project'
  enabled: boolean
}

/** 一条事件订阅（拦截/观察同表，消费侧按 event 分流） */
export interface ExtensionHandlerEntry {
  event: ExtensionEventName
  extId: string
  handler: ExtensionHandler
}

export interface LoadResult {
  tools: ExtensionTool[]
  commands: ExtensionCommand[]
  /** 全部事件订阅（按触发顺序） */
  handlers: ExtensionHandlerEntry[]
  /** 每个失败文件的 "文件名: 原因" */
  errors: string[]
  /** 每个扫描到的扩展的元信息（含禁用/失败条目，设置页扩展卡片数据源） */
  infos: import('@shared/types').ExtensionInfo[]
}
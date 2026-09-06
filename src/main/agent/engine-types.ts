import type { AgentEvent, AgentMessage, ToolCall } from '@shared/types'
import type { ProviderEvent } from '../providers/types'

/**
 * 引擎契约（对齐 pi 的 agent/src/types.ts）：
 * 引擎只负责循环机制，一切策略（审批/压缩/清洗/上限）通过钩子注入。
 * 钩子契约：禁止 throw——失败返回安全回退值，否则会打断引擎的事件序列。
 */

export interface EngineContext {
  systemPrompt: string
  messages: AgentMessage[]
  tools: EngineTool[]
}

export interface EngineToolResult {
  content: string
  isError?: boolean
  /** 提示引擎：本批次全部结果都 terminate 时提前结束回合 */
  terminate?: boolean
}

export type EngineToolUpdate = (partialResult: string) => void

export interface EngineTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 声明 sequential 后，同批次内任一 sequential 工具会使整批顺序执行 */
  executionMode?: 'sequential' | 'parallel'
  /** 原始参数修正 shim（Schema 校验前调用） */
  prepareArguments?: (args: Record<string, unknown>) => Record<string, unknown>
  validate?: (args: Record<string, unknown>) => string | null
  /** pi 契约：执行失败应抛异常（引擎捕获转 isError 结果）；也兼容返回 isError 标记 */
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: EngineToolUpdate
  ): Promise<EngineToolResult>
}

export interface BeforeToolCallContext {
  toolCall: ToolCall
  args: Record<string, unknown>
}

export interface BeforeToolCallResult {
  block?: boolean
  reason?: string
  /** 修改后的参数（拦截器可改写；执行与后续钩子都会看到改写值） */
  args?: Record<string, unknown>
}

export interface AfterToolCallContext {
  toolCall: ToolCall
  args: Record<string, unknown>
  result: EngineToolResult
  isError: boolean
}

export interface AfterToolCallResult {
  content?: string
  isError?: boolean
  terminate?: boolean
}

export interface TurnContext {
  message: AgentMessage
  toolResults: AgentMessage[]
  turnCount: number
  newMessages: AgentMessage[]
}

export interface NextTurnUpdate {
  messages?: AgentMessage[]
}

export interface EngineHooks {
  /**
   * AgentMessage[] → 发送给 LLM 的消息（清洗/自定义消息过滤）。必填，禁止 throw。
   */
  convertToLlm: (messages: AgentMessage[]) => AgentMessage[]
  /**
   * 每次请求前的上下文治理（压缩/剪枝）。禁止 throw。
   */
  transformContext?: (messages: AgentMessage[], signal: AbortSignal) => Promise<AgentMessage[]>
  beforeToolCall?: (ctx: BeforeToolCallContext, signal: AbortSignal) => Promise<BeforeToolCallResult | undefined>
  afterToolCall?: (ctx: AfterToolCallContext, signal: AbortSignal) => Promise<AfterToolCallResult | undefined>
  shouldStopAfterTurn?: (ctx: TurnContext) => boolean | Promise<boolean>
  prepareNextTurn?: (ctx: TurnContext) => Promise<NextTurnUpdate | undefined>
  /** steering：运行中插话队列，在工具批次结束后注入 */
  getSteeringMessages?: () => Promise<AgentMessage[]>
  /** follow-up：agent 即将停止时的续跑队列 */
  getFollowUpMessages?: () => Promise<AgentMessage[]>
  /** 工具批次执行模式；任一 sequential 工具强制整批顺序。默认 parallel */
  toolExecution?: 'sequential' | 'parallel'
  /** 防失控上限；策略层应同时用 shouldStopAfterTurn 给用户可见提示 */
  maxTurns?: number
}

export type Emit = (event: AgentEvent) => Promise<void> | void

export interface StreamRequest {
  system: string
  messages: AgentMessage[]
  tools: { name: string; description: string; parameters: Record<string, unknown> }[]
  signal: AbortSignal
}

/**
 * StreamFn 契约（对齐 pi）：禁止 throw——失败编码为 ProviderEvent 的 done 终态；
 * 引擎从 done 事件读取 stopReason。
 */
export type StreamFn = (req: StreamRequest) => AsyncIterable<ProviderEvent>

export function findTool(context: EngineContext, name: string): EngineTool | undefined {
  return context.tools.find((t) => t.name === name)
}

import type { AgentEvent, AgentMessage, ImageContent, PermissionMode, TextContent, ToolCall } from '@shared/types'
import type { ProviderEvent } from '../providers/types'
import type { PermissionManager } from '../permissions'
import type { Tool, ToolResult } from '../tools/registry'
import { agentLoop, agentLoopContinue } from './engine'
import type { AfterToolCallContext, BeforeToolCallContext, EngineHooks, EngineTool, Emit } from './engine-types'
import { createStreamFn } from './stream-fn'
import { cleanMessagesForLlm } from './replay-clean'
import { compactNow, createCompactionTransform } from './compaction'

const OVERFLOW_PATTERN = /context (length|overflow)|maximum context|too many tokens|input length exceeds/i

/** 扩展观察者关注的事件集（session_start/end 由会话管理层派发，不经引擎事件流） */
const OBSERVE_EVENTS = new Set(['agent_start', 'agent_end', 'turn_start', 'turn_end', 'compacted'])

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * 编排器（对齐 pi 的 Agent + harness 分层）：
 * 持有 transcript 与双队列，把策略（压缩/审批/清洗/上限）装配成引擎钩子，
 * 引擎（engine.ts）只负责循环机制。
 */
export interface AgentDeps {
  emit: Emit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 异构工具注册表：各工具的参数类型在此抹平
  tools: Tool<any>[]
  getSystemPrompt: () => string
  getProvider: () => { stream(req: { system: string; messages: AgentMessage[]; tools: { name: string; description: string; parameters: Record<string, unknown> }[]; signal: AbortSignal; maxTokens?: number }): AsyncIterable<ProviderEvent> }
  getWorkspacePath: () => string
  /** 会话终端执行器（agent bash 在可见 PTY 终端里执行；缺省 = 无终端环境，回落隐藏 shell） */
  terminal?: { exec: (command: string, timeoutMs: number, signal: AbortSignal) => Promise<ToolResult> }
  /** 审批门（PermissionManager 的 beforeToolCall 实现） */
  permissions: PermissionManager
  /** 压缩摘要请求（wiring 用 provider 实现，maxTokens 为摘要输出预算） */
  completeSummarization: (promptText: string, maxTokens: number, signal: AbortSignal) => Promise<string>
  /** 当前模型上下文窗口（压缩阈值 = window − reserveTokens） */
  getContextWindow: () => number
  /** 当前模型名（assistant 消息打标：跨模型清洗判定 thinking 签名有效性） */
  getCurrentModel: () => string
  /**
   * 扩展 tool_call 拦截器（index.ts 组装：扩展先 block/改参，权限审批门后行）。
   * 返回 block 时跳过权限直接拒绝；返回 args 时用改写值继续；扩展自身异常由组装侧隔离。
   */
  toolCallInterceptor?: (ctx: { toolCall: ToolCall; args: Record<string, unknown> }, signal: AbortSignal) => Promise<{
    block?: boolean
    reason?: string
    args?: Record<string, unknown>
  } | undefined>
  /**
   * 扩展 tool_result 覆写链（afterToolCall 钩子）：changeTracker.after（磁盘真相）之后执行，
   * 只改模型可见结果；返回 undefined=不覆写。多 handler 合并语义由装配侧（index.ts）实现。
   */
  toolResultInterceptor?: (e: {
    toolCallId: string
    toolName: string
    args: Record<string, unknown>
    result: { content: string; isError: boolean }
  }, signal: AbortSignal) => Promise<{ content?: string; isError?: boolean; terminate?: boolean } | undefined>
  /** 压缩快照持久化 */
  onSnapshot: (messages: AgentMessage[]) => void
  /** 扩展观察者（生命周期事件旁路）：consume 对观察集事件在 emit 后 await 派发，保证下一轮前跑完 */
  observe?: (event: AgentEvent) => Promise<void> | void
  /** 会话权限模式（plan = 装配时剔除写类工具）；缺省 manual */
  getPermissionMode?: () => PermissionMode
  /**
   * 会话改动追踪（非 git 项目的 Diff 基线；index.ts 按 sessionId 绑定注入 DiffService）。
   * before 在权限放行后、工具执行前调用；after 在执行后调用。两者永不 throw。
   */
  changeTracker?: {
    before(ctx: BeforeToolCallContext): void
    after(ctx: AfterToolCallContext): void
  }
  maxTurns?: number
}

export class Agent {
  private transcript: AgentMessage[] = []
  private steerQueue: AgentMessage[] = []
  private followUpQueue: AgentMessage[] = []
  private abortController: AbortController | null = null
  private recoveryAttempted = false
  running = false

  constructor(private deps: AgentDeps) {}

  getTranscript(): AgentMessage[] {
    return [...this.transcript]
  }

  replaceTranscript(messages: AgentMessage[]): void {
    this.transcript = [...messages]
  }

  /** 新 prompt：空闲时启动 loop；运行中返回 busy（应改用 steer）。images 作为 user 图片块随消息发送 */
  async prompt(text: string, images?: ImageContent[]): Promise<'ok' | 'busy'> {
    if (this.running) return 'busy'
    if (!this.deps.getWorkspacePath()) {
      this.deps.emit({ type: 'notice', message: '尚未选择工作目录：请点击顶栏项目选择器或 ⚙ 设置，先选择一个文件夹' })
      return 'ok'
    }
    this.running = true
    this.recoveryAttempted = false
    this.abortController = new AbortController()
    try {
      const content: string | (TextContent | ImageContent)[] =
        images && images.length > 0
          ? [...(text ? [{ type: 'text' as const, text }] : []), ...images.map((im) => ({ type: 'image' as const, data: im.data, mimeType: im.mimeType }))]
          : text
      const userMsg: AgentMessage = { role: 'user', content }
      const userTurn: AgentMessage[] = [userMsg]
      // prompt 不预进 transcript：以 prompts 传入引擎，随 message_end 事件回流 transcript/持久化（避免双份）
      await this.runLoopOnce(userTurn)
      // pi 的 overflow 恢复：压缩后以 agentLoopContinue 续跑一次被中断的回合
      await this.maybeOverflowRecovery()
      return 'ok'
    } finally {
      this.running = false
      this.abortController = null
    }
  }

  /** 运行中插话（pi 的 steering）：进入队列，下一个工具批次结束后注入 */
  steer(text: string): 'queued' {
    this.steerQueue.push({ role: 'user', content: text })
    this.emitQueueUpdate()
    return 'queued'
  }

  /** 即将停止时的续跑队列（pi 的 follow-up） */
  followUp(text: string): 'queued' {
    this.followUpQueue.push({ role: 'user', content: text })
    this.emitQueueUpdate()
    return 'queued'
  }

  private emitQueueUpdate(): void {
    this.deps.emit({ type: 'queue_update', steering: this.steerQueue.length, followUp: this.followUpQueue.length })
  }

  /** 取回并清空两队列尚未消费的消息（pi 的 Escape 行为：排队消息回到输入框） */
  drainQueues(): string[] {
    const drained = [...this.steerQueue.splice(0), ...this.followUpQueue.splice(0)]
    if (drained.length > 0) this.emitQueueUpdate()
    return drained.map((m) => (typeof m.content === 'string' ? m.content : ''))
  }

  /** 用户取消（Esc）：对齐 pi 的 abort；返回取回的排队消息文本供 UI 回填 */
  abort(): string[] {
    const drained = this.drainQueues()
    this.abortController?.abort()
    this.deps.permissions.cancelAll()
    return drained
  }

  async compact(): Promise<'ok' | 'busy'> {
    if (this.running) return 'busy'
    this.running = true
    this.abortController = new AbortController()
    try {
      const next = await compactNow(this.transcript, this.compactionDeps(), this.abortController.signal)
      if (next === this.transcript) this.deps.emit({ type: 'notice', message: '（历史太短或无法安全切分，无需/无法压缩）' })
      this.transcript = next
      return 'ok'
    } catch (err) {
      if (isAbort(err)) {
        this.deps.emit({ type: 'notice', message: '压缩已取消' })
      } else {
        this.deps.emit({ type: 'notice', message: `压缩失败：${err instanceof Error ? err.message : String(err)}` })
      }
      return 'ok'
    } finally {
      this.running = false
      this.abortController = null
    }
  }

  /** 新会话：清空 transcript 与队列 */
  reset(): void {
    if (this.running) return
    this.transcript = []
    this.steerQueue = []
    this.followUpQueue = []
    this.deps.permissions.reset()
  }

  /** 消费引擎事件流：转发 + message_end 实时并入 transcript（assistant 打 model 标） */
  private async consume(stream: AsyncIterable<AgentEvent>): Promise<void> {
    for await (const ev of stream) {
      if (ev.type === 'message_end' && ev.message.role === 'assistant') {
        const model = this.deps.getCurrentModel()
        if (model) ev.message.model = model
      }
      this.deps.emit(ev)
      if (ev.type === 'message_end') this.transcript.push(ev.message)
      // 扩展观察者：emit 后 await 派发（checkpointing 类扩展保证在下一轮前完成）
      if (this.deps.observe && OBSERVE_EVENTS.has(ev.type)) await this.deps.observe(ev)
    }
  }

  private async runLoopOnce(prompts: AgentMessage[]): Promise<void> {
    const stream = agentLoop({
      prompts,
      context: {
        systemPrompt: this.deps.getSystemPrompt(),
        messages: [...this.transcript],
        tools: this.adaptTools()
      },
      hooks: this.buildHooks(),
      signal: this.abortController!.signal,
      emit: this.deps.emit,
      streamFn: createStreamFn({
        getProvider: () => this.deps.getProvider(),
        onRetry: (info) => this.deps.emit({ type: 'retrying', ...info })
      })
    })
    await this.consume(stream)
  }

  /**
   * pi 的 overflow 恢复（对齐 _checkCompaction Case 1）：
   * 上下文溢出/可恢复截断 → 移除失败消息 → 压缩 → agentLoopContinue 续跑一次。
   */
  private async maybeOverflowRecovery(): Promise<void> {
    if (this.recoveryAttempted) return
    const last = this.transcript[this.transcript.length - 1]
    if (!last || last.role !== 'assistant' || last.stopReason !== 'error') return
    const message = last.errorMessage ?? ''
    if (!OVERFLOW_PATTERN.test(message)) return

    this.recoveryAttempted = true
    this.transcript = this.transcript.slice(0, -1)
    this.deps.emit({ type: 'notice', message: '检测到上下文溢出：正在压缩历史并自动重试…' })
    try {
      this.transcript = await compactNow(this.transcript, this.compactionDeps(), this.abortController!.signal)
    } catch (err) {
      if (isAbort(err)) throw err
      this.deps.emit({ type: 'notice', message: `压缩失败：${err instanceof Error ? err.message : String(err)}` })
      return
    }

    const stream = agentLoopContinue({
      context: {
        systemPrompt: this.deps.getSystemPrompt(),
        messages: [...this.transcript],
        tools: this.adaptTools()
      },
      hooks: this.buildHooks(),
      signal: this.abortController!.signal,
      emit: this.deps.emit,
      streamFn: createStreamFn({
        getProvider: () => this.deps.getProvider(),
        onRetry: (info) => this.deps.emit({ type: 'retrying', ...info })
      })
    })
    await this.consume(stream)
  }

  private compactionDeps() {
    return {
      completeSummarization: this.deps.completeSummarization,
      emit: this.deps.emit,
      onSnapshot: (messages: AgentMessage[]) => this.deps.onSnapshot(messages),
      onMessagesReplaced: (messages: AgentMessage[]) => this.replaceTranscript(messages),
      getContextWindow: () => this.deps.getContextWindow()
    }
  }

  /** registry 工具 → 引擎工具适配：execute 签名对齐（onUpdate 预留，内置工具暂不支持）；plan 模式剔除写类工具 */
  private adaptTools(): EngineTool[] {
    const mode = this.deps.getPermissionMode?.() ?? 'manual'
    return this.deps.tools
      .filter((t) => mode !== 'plan' || !t.mutating)
      .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      validate: t.validate ? (args: Record<string, unknown>) => t.validate!(args) : undefined,
      execute: async (toolCallId: string, args: Record<string, unknown>, signal: AbortSignal) => {
        void toolCallId
        const res = await t.execute(
          args,
          {
            workspacePath: this.deps.getWorkspacePath(),
            ...(this.deps.terminal ? { terminal: this.deps.terminal } : {})
          },
          signal
        )
        return { content: res.content, isError: res.isError }
      }
    }))
  }

  private buildHooks(): EngineHooks {
    const maxTurns = this.deps.maxTurns ?? 40
    return {
      convertToLlm: (messages) => cleanMessagesForLlm(messages, this.deps.getCurrentModel()),
      transformContext: createCompactionTransform(this.compactionDeps()),
      beforeToolCall: async (ctx, signal) => {
        let effectiveArgs = ctx.args
        if (this.deps.toolCallInterceptor) {
          const ext = await this.deps.toolCallInterceptor({ toolCall: ctx.toolCall, args: effectiveArgs }, signal)
          if (ext?.block) return { block: true, reason: ext.reason }
          if (ext?.args) effectiveArgs = ext.args
        }
        // 权限门看到改写后的参数；未拒绝时把改写值带回引擎执行
        const res = await this.deps.permissions.beforeToolCall({ ...ctx, args: effectiveArgs })
        if (res) return res
        // 权限放行后才抓基线（被拒绝的调用不进改动日志）
        try {
          this.deps.changeTracker?.before({ toolCall: ctx.toolCall, args: effectiveArgs })
        } catch {
          /* 追踪失败不阻塞工具执行 */
        }
        return effectiveArgs !== ctx.args ? { args: effectiveArgs } : undefined
      },
      afterToolCall: async (ctx, signal) => {
        // 先记磁盘真相（只读 isError，不受覆写影响），再让扩展覆写模型可见结果
        try {
          this.deps.changeTracker?.after(ctx)
        } catch {
          /* 同上 */
        }
        if (!this.deps.toolResultInterceptor) return undefined
        return await this.deps.toolResultInterceptor(
          {
            toolCallId: ctx.toolCall.id,
            toolName: ctx.toolCall.name,
            args: ctx.args,
            result: { content: ctx.result.content ?? '', isError: ctx.isError }
          },
          signal
        )
      },
      shouldStopAfterTurn: (ctx) => {
        if (ctx.turnCount >= maxTurns) {
          this.deps.emit({ type: 'notice', message: `达到最大轮数限制（${maxTurns}），已停止。` })
          return true
        }
        return false
      },
      getSteeringMessages: async () => {
        const out = this.steerQueue.splice(0)
        if (out.length > 0) this.emitQueueUpdate()
        return out
      },
      getFollowUpMessages: async () => {
        const out = this.followUpQueue.splice(0)
        if (out.length > 0) this.emitQueueUpdate()
        return out
      },
      maxTurns
    }
  }
}

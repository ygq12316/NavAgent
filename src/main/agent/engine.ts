import type { AgentMessage, TextContent, ThinkingContent, ToolCall } from '@shared/types'
import type { ProviderEvent } from '../providers/types'
import { AgentEventStream } from './event-stream'
import type { Emit, EngineContext, EngineHooks, EngineTool, EngineToolResult, StreamFn } from './engine-types'

interface RunOptions {
  prompts: AgentMessage[]
  context: EngineContext
  hooks: EngineHooks
  signal: AbortSignal
  emit: Emit
  streamFn: StreamFn
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 启动一次 agent loop（新 prompt）：返回事件流，agent_end 为终态，
 * result() 兑现本次新增的消息数组（对齐 pi 的 agentLoop）。
 */
export function agentLoop(opts: RunOptions): AgentEventStream {
  const stream = new AgentEventStream()
  void runAgentLoop(opts, (event) => stream.push(event)).then((messages) => {
    stream.end(messages)
  })
  return stream
}

/** 从现有上下文继续（重试/续跑语义）：最后一条消息必须是 user 或 tool_result（对齐 pi 的 agentLoopContinue） */
export function agentLoopContinue(opts: Omit<RunOptions, 'prompts'>): AgentEventStream {
  if (opts.context.messages.length === 0) throw new Error('Cannot continue: no messages')
  const last = opts.context.messages[opts.context.messages.length - 1]
  if (last.role === 'assistant') throw new Error('Cannot continue from assistant message')
  const stream = new AgentEventStream()
  void runAgentLoop({ ...opts, prompts: [] }, (event) => stream.push(event)).then((messages) => {
    stream.end(messages)
  })
  return stream
}

export async function runAgentLoop(opts: RunOptions, emit: Emit): Promise<AgentMessage[]> {
  const context: EngineContext = {
    ...opts.context,
    messages: [...opts.context.messages, ...opts.prompts]
  }
  const newMessages: AgentMessage[] = [...opts.prompts]
  await emit({ type: 'agent_start' })
  await emit({ type: 'turn_start' })
  for (const prompt of opts.prompts) {
    await emit({ type: 'message_start', message: prompt })
    await emit({ type: 'message_end', message: prompt })
  }
  await runLoop(context, newMessages, opts, emit)
  // 所有退出路径（error/aborted/shouldStop/正常结束）统一在此收口 agent_end
  await emit({ type: 'agent_end', messages: newMessages })
  return newMessages
}

/**
 * 主循环（对齐 pi 的 runLoop）：内环处理工具调用与 steering 注入，
 * 外环处理 follow-up 续跑；一切终止判定来自 stopReason 与钩子。
 */
async function runLoop(
  context: EngineContext,
  newMessages: AgentMessage[],
  opts: RunOptions,
  emit: Emit
): Promise<void> {
  const { hooks, signal, streamFn } = opts
  let pending: AgentMessage[] = (await hooks.getSteeringMessages?.()) ?? []
  let lastTurn: Parameters<NonNullable<EngineHooks['shouldStopAfterTurn']>>[0] | undefined
  let turnCount = 0

  outer: while (true) {
    let hasMoreToolCalls = true
    while (hasMoreToolCalls || pending.length > 0) {
      if (lastTurn) {
        const update = await hooks.prepareNextTurn?.(lastTurn)
        if (update?.messages) context.messages = update.messages
        if (pending.length === 0) pending = (await hooks.getSteeringMessages?.()) ?? []
        await emit({ type: 'turn_start' })
      }

      for (const m of pending) {
        await emit({ type: 'message_start', message: m })
        await emit({ type: 'message_end', message: m })
        context.messages.push(m)
        newMessages.push(m)
      }
      pending = []

      const message = await streamAssistantResponse(context, hooks, signal, emit, streamFn)
      // assistant 必须进 context.messages：下一轮请求的 history 依赖它携带 tool_calls（否则 tool 消息悬空 400）
      context.messages.push(message)
      newMessages.push(message)
      turnCount++

      // 失败/取消：编码进消息终态（错误进流契约），本轮回合结束即终止
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        await emit({ type: 'turn_end', message, toolResults: [] })
        return
      }

      const toolCalls = message.toolCalls
      const toolResults: AgentMessage[] = []
      hasMoreToolCalls = false
      if (toolCalls.length > 0) {
        const batch =
          message.stopReason === 'length'
            ? await failTruncatedToolCalls(toolCalls, emit)
            : await executeToolCalls(context, message, hooks, signal, emit)
        toolResults.push(...batch.messages)
        hasMoreToolCalls = !batch.terminate
        for (const r of toolResults) {
          context.messages.push(r)
          newMessages.push(r)
        }
      }

      lastTurn = { message, toolResults, turnCount, newMessages }
      await emit({ type: 'turn_end', message, toolResults })

      if (await hooks.shouldStopAfterTurn?.(lastTurn)) return
      pending = (await hooks.getSteeringMessages?.()) ?? []
      if (turnCount >= (hooks.maxTurns ?? 40)) {
        await emit({ type: 'notice', message: `达到最大轮数限制（${hooks.maxTurns ?? 40}），已停止。` })
        return
      }
    }

    const followUps = (await hooks.getFollowUpMessages?.()) ?? []
    if (followUps.length > 0) {
      pending = followUps
      continue outer
    }
    break outer
  }
}

/**
 * 流式获取 assistant 回复（对齐 pi 的 streamAssistantResponse）：
 * transformContext → convertToLlm 两个边界钩子后调用 StreamFn；
 * 消费协议事件，实时组装 partial assistant 消息并以 message_update 推送快照。
 */
async function streamAssistantResponse(
  context: EngineContext,
  hooks: EngineHooks,
  signal: AbortSignal,
  emit: Emit,
  streamFn: StreamFn
): Promise<AgentMessage & { role: 'assistant' }> {
  let messages = context.messages
  if (hooks.transformContext) messages = await hooks.transformContext(messages, signal)
  const llmMessages = hooks.convertToLlm(messages)

  let usage: import('@shared/types').Usage | undefined
  let errorMessage: string | undefined
  // 块共聚合：同类型增量并入当前块，类型切换开新块（对齐 pi 的流式 blocks 组装）
  const blocks: (TextContent | ThinkingContent)[] = []
  let cur: TextContent | ThinkingContent | null = null
  const calls: ToolCall[] = []
  const callByIndex = new Map<number, ToolCall>()
  let stopReason: import('@shared/types').StopReason = 'pending'

  const appendDelta = (kind: 'text' | 'thinking', delta: string): void => {
    if (cur?.type === 'text' && kind === 'text') {
      cur.text += delta
      return
    }
    if (cur?.type === 'thinking' && kind === 'thinking') {
      cur.thinking += delta
      return
    }
    cur = kind === 'text' ? { type: 'text', text: delta } : { type: 'thinking', thinking: delta }
    blocks.push(cur)
  }

  // partial 快照与累积器隔离：块对象逐个重建，已发快照永不被后续拼接改写
  const partial = (): AgentMessage => ({
    role: 'assistant',
    content: blocks.map((b) => ({ ...b })),
    toolCalls: [...calls],
    stopReason,
    ...(usage ? { usage } : {}),
    ...(errorMessage ? { errorMessage } : {})
  })

  await emit({ type: 'message_start', message: partial() })
  for await (const ev of streamFn({
    system: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
    signal
  })) {
    if (ev.type === 'text_delta') {
      appendDelta('text', ev.delta)
      await emit({ type: 'message_update', message: partial() })
    } else if (ev.type === 'thinking_delta') {
      appendDelta('thinking', ev.delta)
      await emit({ type: 'message_update', message: partial() })
    } else if (ev.type === 'thinking_signature') {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]
        if (b.type === 'thinking' && !b.thinkingSignature) {
          b.thinkingSignature = ev.signature
          break
        }
      }
    } else if (ev.type === 'thinking_redacted') {
      cur = null
      blocks.push({ type: 'thinking', thinking: '', thinkingSignature: ev.data, redacted: true })
      await emit({ type: 'message_update', message: partial() })
    } else if (ev.type === 'tool_call_start') {
      cur = null
      const call: ToolCall = { id: ev.id, name: ev.name, arguments: '' }
      calls.push(call)
      callByIndex.set(ev.index, call)
      await emit({ type: 'message_update', message: partial() })
    } else if (ev.type === 'tool_call_delta') {
      // index 是 provider 侧的分片序号（OpenAI=工具序号，Anthropic=content block 序号），经映射关联
      const c = callByIndex.get(ev.index)
      if (c) c.arguments += ev.argsDelta
      await emit({ type: 'message_update', message: partial() })
    } else if (ev.type === 'usage') {
      usage = {
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
        ...(ev.cacheWriteTokens !== undefined ? { cacheWriteTokens: ev.cacheWriteTokens } : {})
      }
    } else if (ev.type === 'done') {
      stopReason = ev.stopReason
      errorMessage = ev.errorMessage
      await emit({ type: 'message_update', message: partial() })
    }
  }
  if (stopReason === 'pending') stopReason = calls.length > 0 ? 'toolUse' : 'stop'

  const final: AgentMessage = {
    role: 'assistant',
    content: blocks.map((b) => ({ ...b })),
    toolCalls: [...calls],
    stopReason,
    ...(usage ? { usage } : {}),
    ...(errorMessage ? { errorMessage } : {})
  }
  await emit({ type: 'message_end', message: final })
  return final
}

/** length 截断保护：作废本条消息全部工具调用（参数可能不完整），报错让模型重发 */
async function failTruncatedToolCalls(
  toolCalls: ToolCall[],
  emit: Emit
): Promise<{ messages: AgentMessage[]; terminate: boolean }> {
  const messages: AgentMessage[] = []
  for (const tc of toolCalls) {
    await emit({ type: 'tool_execution_start', toolCallId: tc.id, toolName: tc.name, args: tc.arguments })
    const content = '工具调用未执行：回复被 max_tokens 截断，参数可能不完整。请重发该调用并确保参数完整。'
    await emit({ type: 'tool_execution_end', toolCallId: tc.id, toolName: tc.name, result: content, isError: true })
    messages.push({ role: 'tool_result', callId: tc.id, toolName: tc.name, content, isError: true })
  }
  return { messages, terminate: false }
}

type FinalizedToolCall = {
  toolCall: ToolCall
  result: EngineToolResult
  isError: boolean
}

/** 工具批次（对齐 pi 的 executeToolCalls）：任一 sequential 工具使整批顺序执行，否则并行 */
async function executeToolCalls(
  context: EngineContext,
  message: AgentMessage & { role: 'assistant' },
  hooks: EngineHooks,
  signal: AbortSignal,
  emit: Emit
): Promise<{ messages: AgentMessage[]; terminate: boolean }> {
  const toolCalls = message.toolCalls
  const anySequential = toolCalls.some((tc) => findToolSafe(context, tc.name)?.executionMode === 'sequential')
  if (hooks.toolExecution === 'sequential' || anySequential) {
    return executeToolCallsSequential(context, toolCalls, hooks, signal, emit)
  }
  return executeToolCallsParallel(context, toolCalls, hooks, signal, emit)
}

function findToolSafe(context: EngineContext, name: string): EngineTool | undefined {
  return context.tools.find((t) => t.name === name)
}

async function executeToolCallsSequential(
  context: EngineContext,
  toolCalls: ToolCall[],
  hooks: EngineHooks,
  signal: AbortSignal,
  emit: Emit
): Promise<{ messages: AgentMessage[]; terminate: boolean }> {
  const finalized: FinalizedToolCall[] = []
  const messages: AgentMessage[] = []
  for (const tc of toolCalls) {
    await emit({ type: 'tool_execution_start', toolCallId: tc.id, toolName: tc.name, args: tc.arguments })
    const prepared = await prepareToolCall(context, tc, hooks, signal)
    let fin: FinalizedToolCall
    if (prepared.kind === 'immediate') {
      fin = { toolCall: tc, result: prepared.result, isError: prepared.isError }
    } else {
      fin = await executeAndFinalize(prepared.tool, tc, prepared.args, hooks, signal, emit)
    }
    await emit({ type: 'tool_execution_end', toolCallId: tc.id, toolName: tc.name, result: fin.result.content, isError: fin.isError })
    const message = createToolResultMessage(fin)
    await emit({ type: 'message_start', message })
    await emit({ type: 'message_end', message })
    messages.push(message)
    finalized.push(fin)
    if (signal.aborted) break
  }
  return { messages, terminate: finalized.length > 0 && finalized.every((f) => f.result.terminate === true) }
}

async function executeToolCallsParallel(
  context: EngineContext,
  toolCalls: ToolCall[],
  hooks: EngineHooks,
  signal: AbortSignal,
  emit: Emit
): Promise<{ messages: AgentMessage[]; terminate: boolean }> {
  const entries: (FinalizedToolCall | (() => Promise<FinalizedToolCall>))[] = []
  for (const tc of toolCalls) {
    await emit({ type: 'tool_execution_start', toolCallId: tc.id, toolName: tc.name, args: tc.arguments })
    const prepared = await prepareToolCall(context, tc, hooks, signal)
    if (prepared.kind === 'immediate') {
      entries.push({ toolCall: tc, result: prepared.result, isError: prepared.isError })
      if (signal.aborted) break
      continue
    }
    entries.push(async () => {
      if (signal.aborted) {
        return { toolCall: tc, result: { content: 'Operation aborted' }, isError: true }
      }
      return executeAndFinalize(prepared.tool, tc, prepared.args, hooks, signal, emit)
    })
    if (signal.aborted) break
  }
  const ordered = await Promise.all(entries.map((e) => (typeof e === 'function' ? e() : Promise.resolve(e))))
  const messages: AgentMessage[] = []
  // 结果消息按 assistant 源顺序发出（协议配对稳定），end 事件随后按源序发出
  for (const fin of ordered) {
    const message = createToolResultMessage(fin)
    await emit({ type: 'message_start', message })
    await emit({ type: 'message_end', message })
    messages.push(message)
  }
  for (const fin of ordered) {
    await emit({ type: 'tool_execution_end', toolCallId: fin.toolCall.id, toolName: fin.toolCall.name, result: fin.result.content, isError: fin.isError })
  }
  return { messages, terminate: ordered.length > 0 && ordered.every((f) => f.result.terminate === true) }
}

type PreparedToolCall = { kind: 'prepared'; tool: EngineTool; args: Record<string, unknown> }
type ImmediateOutcome = { kind: 'immediate'; result: EngineToolResult; isError: boolean }

/** prepare 段：找工具 → 参数 shim → 校验 → beforeToolCall 钩子；失败短路为 immediate 错误结果 */
async function prepareToolCall(
  context: EngineContext,
  toolCall: ToolCall,
  hooks: EngineHooks,
  signal: AbortSignal
): Promise<PreparedToolCall | ImmediateOutcome> {
  const tool = findToolSafe(context, toolCall.name)
  if (!tool) return { kind: 'immediate', result: { content: `未知工具：${toolCall.name}` }, isError: true }
  try {
    let args: Record<string, unknown>
    try {
      args = JSON.parse(toolCall.arguments || '{}') as Record<string, unknown>
    } catch {
      return { kind: 'immediate', result: { content: `工具参数不是合法 JSON：${toolCall.arguments.slice(0, 200)}` }, isError: true }
    }
    if (tool.prepareArguments) args = tool.prepareArguments(args)
    const invalid = tool.validate?.(args) ?? null
    if (invalid) return { kind: 'immediate', result: { content: `参数校验失败：${invalid}` }, isError: true }
    if (hooks.beforeToolCall) {
      const before = await hooks.beforeToolCall({ toolCall, args }, signal)
      if (signal.aborted) return { kind: 'immediate', result: { content: 'Operation aborted' }, isError: true }
      if (before?.block) return { kind: 'immediate', result: { content: before.reason || '工具执行被拒绝' }, isError: true }
      // 拦截器改写参数：执行与后续钩子使用改写值
      if (before?.args) args = before.args
    }
    if (signal.aborted) return { kind: 'immediate', result: { content: 'Operation aborted' }, isError: true }
    return { kind: 'prepared', tool, args }
  } catch (err) {
    return { kind: 'immediate', result: { content: errMsg(err) }, isError: true }
  }
}

/** execute + finalize 段：执行（onUpdate → tool_execution_update）→ afterToolCall 覆盖 */
async function executeAndFinalize(
  tool: EngineTool,
  toolCall: ToolCall,
  args: Record<string, unknown>,
  hooks: EngineHooks,
  signal: AbortSignal,
  emit: Emit
): Promise<FinalizedToolCall> {
  let result: EngineToolResult
  let isError = false
  try {
    result = await tool.execute(toolCall.id, args, signal, (partial) => {
      void emit({ type: 'tool_execution_update', toolCallId: toolCall.id, toolName: toolCall.name, partialResult: partial })
    })
    isError = result.isError ?? false
  } catch (err) {
    if (isAbort(err) || signal.aborted) {
      result = { content: 'Operation aborted' }
      isError = true
    } else {
      result = { content: errMsg(err) }
      isError = true
    }
  }
  if (hooks.afterToolCall) {
    try {
      const after = await hooks.afterToolCall({ toolCall, args, result, isError }, signal)
      if (after) {
        result = {
          content: after.content ?? result.content,
          ...(after.isError !== undefined ? { isError: after.isError } : {}),
          ...(after.terminate !== undefined ? { terminate: after.terminate } : {})
        }
        isError = after.isError ?? isError
      }
    } catch (err) {
      result = { content: errMsg(err) }
      isError = true
    }
  }
  return { toolCall, result, isError }
}

function createToolResultMessage(fin: FinalizedToolCall): AgentMessage {
  return {
    role: 'tool_result',
    callId: fin.toolCall.id,
    toolName: fin.toolCall.name,
    content: fin.result.content ?? '',
    isError: fin.isError
  }
}

// ProviderEvent 引用保持类型依赖（StreamFn 输出即 provider 事件流）
export type { ProviderEvent }

import { describe, expect, it } from 'vitest'
import { initialState, reducer } from '../reducer'
import { textOfBlocks } from '@shared/types'
import type { AgentEvent, AgentMessage } from '@shared/types'

function run(events: AgentEvent[]) {
  let state = initialState
  for (const e of events) state = reducer(state, { kind: 'event', event: e })
  return state
}

function user(text: string): AgentMessage {
  return { role: 'user', content: text }
}

function asst(
  text: string,
  stopReason: 'stop' | 'toolUse' | 'error' | 'aborted' = 'stop',
  extra: { usage?: { inputTokens: number; outputTokens: number }; errorMessage?: string } = {}
): AgentMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    toolCalls: [],
    stopReason,
    ...(extra.usage ? { usage: extra.usage } : {}),
    ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {})
  }
}

function userTurn(text: string): AgentEvent[] {
  const u = user(text)
  return [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: u },
    { type: 'message_end', message: u }
  ]
}

describe('reducer：纯文本回合', () => {
  it('message_update 累积文本，turn_end 结束并记录 usage', () => {
    const s = run([
      ...userTurn('hi'),
      { type: 'message_start', message: asst('', 'stop') },
      { type: 'message_update', message: asst('你好，', 'stop') },
      { type: 'message_update', message: asst('世界', 'stop') },
      { type: 'message_end', message: asst('你好，世界', 'stop', { usage: { inputTokens: 10, outputTokens: 5 } }) },
      { type: 'turn_end', message: asst('你好，世界', 'stop', { usage: { inputTokens: 10, outputTokens: 5 } }), toolResults: [] },
      { type: 'agent_end', messages: [] }
    ])
    expect(s.working).toBe(false)
    expect(s.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(s.turns[0].done).toBe(true)
    const blocks = s.turns[0].blocks
    expect(blocks[0].kind === 'user' && blocks[0].text).toBe('hi')
    expect(blocks[1].kind === 'assistant' && textOfBlocks(blocks[1].blocks)).toBe('你好，世界')
  })
})

describe('reducer：工具回合', () => {
  const toolCalls = [{ id: 'c1', name: 'bash', arguments: '{"command":"dir"}' }]

  it('assistant 消息携带工具调用 → 执行事件驱动工具行状态', () => {
    const s = run([
      ...userTurn('run dir'),
      { type: 'message_start', message: asst('', 'toolUse') },
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '运行 dir' }], toolCalls, stopReason: 'toolUse' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '运行 dir' }], toolCalls, stopReason: 'toolUse' } },
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: '{"command":"dir"}' },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: 'docs/\nsrc/', isError: false },
      { type: 'turn_end', message: asst('运行 dir', 'toolUse'), toolResults: [] },
      { type: 'agent_end', messages: [] }
    ])
    const ab = s.turns[0].blocks.find((b) => b.kind === 'assistant')
    expect(ab && ab.kind === 'assistant' && ab.toolCalls[0].status).toBe('ok')
    expect(ab && ab.kind === 'assistant' && ab.toolCalls[0].result).toBe('docs/\nsrc/')
  })

  it('审批请求把工具置为 awaiting_approval 并挂起卡片', () => {
    const s = run([
      ...userTurn('run dir'),
      { type: 'message_start', message: asst('', 'toolUse') },
      { type: 'message_end', message: { role: 'assistant', content: [], toolCalls, stopReason: 'toolUse' } },
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: '{"command":"dir"}' },
      { type: 'permission_request', requestId: 'p1', toolName: 'bash', detail: '运行命令：dir' }
    ])
    const ab = s.turns[0].blocks.find((b) => b.kind === 'assistant')
    expect(ab && ab.kind === 'assistant' && ab.toolCalls[0].status).toBe('awaiting_approval')
    expect(s.permission?.requestId).toBe('p1')
  })

  it('拒绝结果置为 denied', () => {
    const s = run([
      ...userTurn('run dir'),
      { type: 'message_start', message: asst('', 'toolUse') },
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: '{}' },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: '用户拒绝了该操作', isError: true }
    ])
    const ab = s.turns[0].blocks.find((b) => b.kind === 'assistant')
    expect(ab && ab.kind === 'assistant' && ab.toolCalls[0].status).toBe('denied')
  })
})

describe('reducer：错误、中断与提示', () => {
  it('错误进流：message_end(error) 显示错误，agent_end 收口', () => {
    const s = run([
      ...userTurn('hi'),
      { type: 'message_start', message: asst('', 'error') },
      { type: 'message_end', message: asst('半截', 'error', { errorMessage: 'API 401：无效 key' }) },
      { type: 'turn_end', message: asst('半截', 'error'), toolResults: [] },
      { type: 'agent_end', messages: [] }
    ])
    expect(s.errorMessage).toBe('API 401：无效 key')
    expect(s.working).toBe(false)
  })

  it('中断进流：message_end(aborted) 显示已中断', () => {
    const s = run([
      ...userTurn('hi'),
      { type: 'message_start', message: asst('', 'aborted') },
      { type: 'message_end', message: asst('写到一半', 'aborted') },
      { type: 'turn_end', message: asst('写到一半', 'aborted'), toolResults: [] },
      { type: 'agent_end', messages: [] }
    ])
    expect(s.aborted).toBe(true)
    expect(s.working).toBe(false)
  })

  it('retrying 设置提示、turn_end 清除', () => {
    let s = run([
      ...userTurn('hi'),
      { type: 'retrying', attempt: 1, maxRetries: 3, delayMs: 1000, reason: 'API 429' }
    ])
    expect(s.retryHint).toContain('1/3')
    s = reducer(s, { kind: 'event', event: { type: 'turn_end', message: asst('x', 'stop'), toolResults: [] } })
    expect(s.retryHint).toBeNull()
  })

  it('notice 显示提示行', () => {
    const s = run([{ type: 'notice', message: '达到最大轮数限制' }])
    expect(s.notice).toBe('达到最大轮数限制')
  })
})

describe('reducer：压缩', () => {
  it('compacted 用摘要通知替换全部 turns', () => {
    const s = run([
      ...userTurn('hi'),
      { type: 'compacted', summary: '摘要要点', removedCount: 6 }
    ])
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0].blocks[0].kind === 'user' && s.turns[0].blocks[0].text).toContain('移除 6 条消息')
  })
})

describe('stats 累计与 queue_update', () => {
  it('message_end 累计 token/成本，turn_start 计回合', () => {
    const a1 = { ...asst('回答', 'stop', { usage: { inputTokens: 1000, outputTokens: 500 } }), model: 'deepseek-chat' }
    const s = run([
      ...userTurn('hi'),
      { type: 'message_start', message: asst('') },
      { type: 'message_end', message: a1 },
      { type: 'turn_end', message: a1, toolResults: [] }
    ])
    expect(s.stats.turns).toBe(1)
    expect(s.stats.inputTokens).toBe(1000)
    expect(s.stats.outputTokens).toBe(500)
    // deepseek-chat 在目录中：1000/1M*0.27 + 500/1M*1.1
    expect(s.stats.costUsd).toBeCloseTo(0.00027 + 0.00055, 8)
  })

  it('多回合持续累计；目录未收录模型成本为 null', () => {
    const a1 = { ...asst('a1', 'stop', { usage: { inputTokens: 100, outputTokens: 10 } }), model: 'deepseek-chat' }
    const a2 = { ...asst('a2', 'stop', { usage: { inputTokens: 200, outputTokens: 20 } }), model: '不存在-模型' }
    const s = run([
      ...userTurn('1'),
      { type: 'message_start', message: a1 },
      { type: 'message_end', message: a1 },
      ...userTurn('2'),
      { type: 'message_start', message: a2 },
      { type: 'message_end', message: a2 }
    ])
    expect(s.stats.turns).toBe(2)
    expect(s.stats.inputTokens).toBe(300)
    expect(s.stats.outputTokens).toBe(30)
    expect(s.stats.costUsd).toBeNull()
  })

  it('reset 清零', () => {
    let s = run([
      ...userTurn('hi'),
      { type: 'message_start', message: asst('') },
      { type: 'message_end', message: asst('回答', 'stop', { usage: { inputTokens: 10, outputTokens: 5 } }) }
    ])
    s = reducer(s, { kind: 'reset' })
    expect(s.stats.turns).toBe(0)
    expect(s.stats.inputTokens).toBe(0)
    expect(s.stats.costUsd).toBe(0)
  })

  it('queue_update 记录排队数', () => {
    const s = run([
      { type: 'queue_update', steering: 2, followUp: 1 }
    ])
    expect(s.queued).toEqual({ steering: 2, followUp: 1 })
  })
})

describe('stats 缓存 token 计费', () => {
  it('cacheRead 按缓存价累计，cacheReadTokens 入统计', () => {
    const a = {
      ...asst('回答', 'stop', { usage: { inputTokens: 1000, outputTokens: 500 } }),
      model: 'deepseek-chat',
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 }
    }
    const s = run([
      ...userTurn('hi'),
      { type: 'message_start', message: asst('') },
      { type: 'message_end', message: a }
    ])
    expect(s.stats.cacheReadTokens).toBe(2000)
    // deepseek-chat: 1000/1M*0.27 + 2000/1M*0.07(缓存) + 500/1M*1.1
    expect(s.stats.costUsd).toBeCloseTo(0.00027 + 0.00014 + 0.00055, 8)
  })
})

import type { NavAgentApi } from './types'
import type {
  AddressedEvent,
  AgentEvent,
  AgentMessage,
  ApiConfig,
  CommandInfo,
  ContextBreakdown,
  ContextSection,
  CredentialInfo,
  CatalogSnapshot,
  ExtensionInfo,
  ExtensionOpResult,
  ModelListResult,
  CustomProviderFull,
  CustomProviderInput,
  CustomProviderWriteResult,
  DiffResult,
  DiffSummary,
  FileReadResult,
  FileWriteResult,
  GitStatusResult,
  ImageContent,
  PermissionDecision,
  SessionLoadResult,
  SessionMeta,
  SessionSearchHit,
  SessionTreeNode,
  TextContent,
  ThinkingContent,
  ToolInfo,
  TreeSummaryResult
} from '@shared/types'
import { contextTokensOf, messageText } from '@shared/types'
import { catalogContextWindowOf } from '@shared/model-catalog'

type Listener = (e: AddressedEvent) => void
type AssistantMsg = Extract<AgentMessage, { role: 'assistant' }>
type AsstBlocks = (TextContent | ThinkingContent)[]

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

function userMsg(text: string): AgentMessage {
  return { role: 'user', content: text }
}

function asst(text: string, toolCalls: AssistantMsg['toolCalls'] = [], stopReason: AssistantMsg['stopReason'] = 'pending'): AgentMessage {
  return { role: 'assistant', content: text ? [{ type: 'text', text }] : [], toolCalls, stopReason }
}

/** 从累积 blocks 组装 assistant 消息（拷贝块对象，模拟引擎的快照隔离） */
function asstFrom(blocks: AsstBlocks, toolCalls: AssistantMsg['toolCalls'], stopReason: AssistantMsg['stopReason']): AgentMessage {
  return { role: 'assistant', content: blocks.map((b) => ({ ...b })), toolCalls, stopReason }
}

function toolResultMsg(callId: string, toolName: string, content: string, isError: boolean): AgentMessage {
  return { role: 'tool_result', callId, toolName, content, isError }
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

function chunkText(s: string, size = 8): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

interface StoredSession {
  meta: SessionMeta
  events: AgentEvent[]
  /** 树节点稳定 id（与 message_end 事件一一对应，惰性补齐） */
  nodeIds?: string[]
}

type MockStep = { say: string } | { think: string } | { tool: string; args: string; result: string; isError?: boolean }

/** demo glob → RegExp（语义对齐 main/tools/walk.ts globToRegExp：** / * / ? / {a,b}） */
function demoGlobToRegExp(pattern: string): RegExp {
  const escapeRe = (c: string): string => /[\\^$.+?()[\]{}|]/.test(c) ? '\\' + c : c
  const expandGlobChars = (s: string): string => {
    let out = ''
    let i = 0
    while (i < s.length) {
      const c = s[i]!
      if (c === '*') {
        out += s[i + 1] === '*' ? '.*' : '[^/]*'
        i += s[i + 1] === '*' ? 2 : 1
        continue
      }
      if (c === '?') {
        out += '[^/]'
        i++
        continue
      }
      out += escapeRe(c)
      i++
    }
    return out
  }
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*'
          i += 3
          continue
        }
        re += '.*'
        i += 2
        continue
      }
      re += '[^/]*'
      i++
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i++
      continue
    }
    if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end > i) {
        const body = pattern.slice(i + 1, end)
        re += '(?:' + body.split(',').map(expandGlobChars).join('|') + ')'
        i = end + 1
        continue
      }
    }
    re += escapeRe(c)
    i++
  }
  return new RegExp('^(?:' + re + ')$', 'i')
}

/** 会话中心演示 API：并行会话各自跑各自的事件流，事件以 {sessionId, event} 信封发出 */
export class MockApi implements NavAgentApi {
  private listeners = new Set<Listener>()
  private config: ApiConfig = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-demo-xxxx',
    model: 'deepseek-chat',
    providerId: 'deepseek',
    workspacePath: 'E:\\pythonProject\\AgentLearn\\navAgent',
    recentProjects: ['E:\\pythonProject\\AgentLearn\\navAgent', 'E:\\demo\\projA', 'E:\\demo\\projB'],
    modelParams: {},
    readOnly: false,
    disabledTools: [],
    trustedProjects: [],
    defaultPermissionMode: 'manual'
  }
  private sessions = new Map<string, StoredSession>()
  private running = new Set<string>()
  private cancelled = new Map<string, boolean>()
  private queues = new Map<string, { steer: string[]; followUp: string[] }>()
  private pending = new Map<string, { requestId: string; resolve: (d: PermissionDecision) => void }>()
  private alwaysAllowed = new Set<string>()
  /** 非会话级 demo diff（模拟改动审查） */
  private demoDiffs = new Map<string, DiffResult>()
  /** 已注入上下文的文件（会话级，演示态） */
  private injectedBy = new Map<string, string[]>()

  constructor() {
    this.seed()
    // 演示内存态文件：让文件 pane 能打开真实内容（编辑器可查找）
    this.memFiles.set('README.md', { content: `# navAgent

从零手写的桌面端 coding agent harness（Electron + TypeScript，Windows 优先）。

## 核心约束 R1

- 不引入 agent 框架、官方 SDK、状态库、UI 组件库
- provider 协议直接以 HTTP/SSE 实现
- 参照物是 pi（badlogic/earendil-works）

## 常用命令

\`\`\`bash
pnpm dev          # Electron 开发
pnpm dev:web      # 仅浏览器跑 renderer（UI 迭代用）
pnpm typecheck    # 两个 tsconfig 各跑一次
pnpm test         # vitest run
\`\`\`
`, mtime: Date.now() })
    // 演示会话的改动清单：让 Git 面板与其 diff 一致（点击改动文件可聚焦）
    const firstSid = [...this.sessions.keys()][0]
    if (firstSid) {
      this.demoDiffs.set(firstSid, {
        source: 'session',
        files: [
          { path: 'src/renderer/src/components/Composer.tsx', status: 'modified', additions: 12, deletions: 3, diff: '@@ -1,4 +1,5 @@\n ' },
          { path: 'src/shared/types.ts', status: 'modified', additions: 8, deletions: 2, diff: '@@ -1,3 +1,4 @@\n ' }
        ]
      })
    }
  }

  private seed(): void {
    const mk = (title: string, ageMs: number, userText: string, steps: MockStep[]): void => {
      const meta: SessionMeta = {
        id: uid(),
        projectPath: this.config.workspacePath,
        title,
        createdAt: Date.now() - ageMs,
        updatedAt: Date.now() - ageMs + 600_000,
        model: 'deepseek-chat',
        permissionMode: 'manual'
      }
      this.sessions.set(meta.id, { meta, events: this.scriptedEvents(userText, steps) })
    }
    mk('总结调研报告要点', 2 * HOUR, '帮我总结这份调研报告', [
      { think: '用户要总结调研报告。报告在 docs/ 目录下，先用 read_file 读取，再按核心结论分点归纳。' },
      { say: '我先读取调研报告文件。' },
      { tool: 'read_file', args: '{"path":"docs/research-desktop-agent-harness.md","limit":200}', result: '已读取 412 行（截断）：# 本地桌面端 Coding Agent Harness 调研报告 …' },
      { say: '这份报告的核心结论：\n\n1. 推荐 TypeScript + Electron 技术栈，手写 agent loop；\n2. UI 采用 transcript 终端风格；\n3. provider 层照 pi 的"边界转换"模式设计。' }
    ])
    mk('修复登录超时 bug', DAY + 3 * HOUR, '排查一下登录超时的问题', [
      { say: '我先看下日志文件。' },
      { tool: 'read_file', args: '{"path":"logs/app.log"}', result: '…timeout at line 42…' },
      { say: '我运行一下测试确认。' },
      { tool: 'bash', args: '{"command":"npm test","interactive":true}', result: '用户拒绝了该操作', isError: true },
      { say: '好的，已跳过运行测试。根据日志，超时发生在鉴权环节。' }
    ])
    mk('设计 provider 抽象层', 6 * DAY, '怎么设计 provider 抽象层？', [
      { say: '参考 pi 的两层分离：Provider 是厂商数据，Api 是协议模块。建议先用 OpenAI 兼容 + Anthropic 两个 adapter。\n\n```typescript\ninterface ProviderEvent { kind: "text"; text: string }\nconst adapter = (raw: string): ProviderEvent[] =>\n  raw.split("\\n").map((text) => ({ kind: "text", text }))\n```' }
    ])
  }

  /** 离线构造一段历史（hydrate 数据源 = message 行） */
  private scriptedEvents(userText: string, steps: MockStep[]): AgentEvent[] {
    const events: AgentEvent[] = []
    const user = userMsg(userText)
    events.push({ type: 'agent_start' }, { type: 'turn_start' })
    events.push({ type: 'message_start', message: user }, { type: 'message_end', message: user })
    const blocks: AsstBlocks = []
    const toolCalls: AssistantMsg['toolCalls'] = []
    const toolResults: AgentMessage[] = []
    events.push({ type: 'message_start', message: asst('', [], 'pending') })
    for (const step of steps) {
      if ('say' in step) {
        for (const c of chunkText(step.say)) {
          const last = blocks[blocks.length - 1]
          if (last && last.type === 'text') last.text += c
          else blocks.push({ type: 'text', text: c })
          events.push({ type: 'message_update', message: asstFrom(blocks, [...toolCalls], 'pending') })
        }
      } else if ('think' in step) {
        blocks.push({ type: 'thinking', thinking: step.think })
        events.push({ type: 'message_update', message: asstFrom(blocks, [...toolCalls], 'pending') })
      } else {
        const callId = uid()
        toolCalls.push({ id: callId, name: step.tool, arguments: step.args })
        events.push({ type: 'message_update', message: asstFrom(blocks, [...toolCalls], 'pending') })
        events.push({ type: 'tool_execution_start', toolCallId: callId, toolName: step.tool, args: step.args })
        events.push({
          type: 'tool_execution_end',
          toolCallId: callId,
          toolName: step.tool,
          result: step.result,
          isError: step.isError ?? false
        })
        const tr = toolResultMsg(callId, step.tool, step.result, step.isError ?? false)
        toolResults.push(tr)
        events.push({ type: 'message_start', message: tr }, { type: 'message_end', message: tr })
      }
    }
    const final = {
      ...asstFrom(blocks, [...toolCalls], toolCalls.length ? 'toolUse' : 'stop'),
      usage: { inputTokens: 4_820, outputTokens: 361, cacheReadTokens: 3_600 },
      model: 'deepseek-chat'
    }
    events.push({ type: 'message_end', message: final })
    events.push({ type: 'turn_end', message: final, toolResults })
    events.push({ type: 'agent_end', messages: [user, final, ...toolResults] })
    return events
  }

  onEvent(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(sessionId: string, e: AgentEvent): void {
    this.listeners.forEach((l) => l({ sessionId, event: e }))
    const s = this.sessions.get(sessionId)
    if (s) s.events.push(e)
  }

  private get demoDelay(): number {
    return document.visibilityState === 'visible' ? 1 : 0
  }

  private async sleep(sid: string, ms: number): Promise<void> {
    const target = ms * this.demoDelay
    if (target > 0) await new Promise<void>((r) => setTimeout(r, target))
    if (this.cancelled.get(sid)) throw new Error('aborted')
  }

  async getConfig(): Promise<ApiConfig> {
    return { ...this.config }
  }

  async setConfig(partial: Partial<ApiConfig>): Promise<ApiConfig> {
    this.config = { ...this.config, ...partial }
    return { ...this.config }
  }

  async setOverlayTheme(_theme: 'light' | 'dark'): Promise<'ok'> {
    return 'ok'
  }

  async pickWorkspace(): Promise<string | null> {
    const paths = this.config.recentProjects
    const idx = paths.indexOf(this.config.workspacePath)
    return paths[(idx + 1) % paths.length] ?? null
  }

  // ── agent 操作（每会话独立并行） ──────────────────────────

  async send(sessionId: string, text: string, images?: ImageContent[]): Promise<'ok'> {
    if (typeof text !== 'string' || (text.trim().length === 0 && (images?.length ?? 0) === 0)) return 'ok'
    if (this.running.has(sessionId)) {
      void this.steer(sessionId, text)
      return 'ok'
    }
    this.runScenario(sessionId, text, images)
    return 'ok'
  }

  async steer(sessionId: string, text: string): Promise<'ok' | 'queued'> {
    const t = typeof text === 'string' ? text.trim() : ''
    if (!t) return 'ok'
    if (!this.running.has(sessionId)) {
      this.runScenario(sessionId, t)
      return 'ok'
    }
    const q = this.queues.get(sessionId) ?? { steer: [], followUp: [] }
    q.steer.push(t)
    this.queues.set(sessionId, q)
    this.emit(sessionId, { type: 'queue_update', steering: q.steer.length, followUp: q.followUp.length })
    return 'queued'
  }

  async followUp(sessionId: string, text: string): Promise<'ok' | 'queued'> {
    const t = typeof text === 'string' ? text.trim() : ''
    if (!t) return 'ok'
    if (!this.running.has(sessionId)) {
      this.runScenario(sessionId, t)
      return 'ok'
    }
    const q = this.queues.get(sessionId) ?? { steer: [], followUp: [] }
    q.followUp.push(t)
    this.queues.set(sessionId, q)
    this.emit(sessionId, { type: 'queue_update', steering: q.steer.length, followUp: q.followUp.length })
    return 'queued'
  }

  async cancel(sessionId: string): Promise<string[]> {
    const q = this.queues.get(sessionId) ?? { steer: [], followUp: [] }
    const drained = [...q.steer.splice(0), ...q.followUp.splice(0)]
    this.emit(sessionId, { type: 'queue_update', steering: 0, followUp: 0 })
    this.cancelled.set(sessionId, true)
    const p = this.pending.get(sessionId)
    if (p) {
      this.pending.delete(sessionId)
      p.resolve('deny')
    }
    return drained
  }

  async compact(sessionId: string): Promise<'ok' | 'busy'> {
    if (this.running.has(sessionId)) return 'busy'
    this.emit(sessionId, {
      type: 'compacted',
      summary: '（模拟压缩）用户要求总结调研报告；已读取设计文档；下一步待定。',
      removedCount: 2
    })
    return 'ok'
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    for (const [sid, p] of this.pending) {
      if (p.requestId !== requestId) continue
      this.pending.delete(sid)
      if (decision === 'always') this.alwaysAllowed.add('bash')
      p.resolve(decision === 'always' ? 'approve' : decision)
    }
  }

  private async requestPermission(sid: string, toolName: string, detail: string): Promise<PermissionDecision> {
    if (this.alwaysAllowed.has(toolName)) return 'approve'
    const requestId = `perm_${Date.now()}_${uid()}`
    this.emit(sid, { type: 'permission_request', requestId, toolName, detail })
    return new Promise((resolve) => {
      this.pending.set(sid, { requestId, resolve })
    })
  }

  /** 演示回合：流式输出 + 工具模拟（并行安全：状态全部按 sessionId 隔离） */
  private runScenario(sid: string, text: string, images?: ImageContent[]): void {
    void (async () => {
      this.running.add(sid)
      this.cancelled.set(sid, false)
      const s = this.sessions.get(sid)
      if (s && s.meta.title === '新对话') {
        s.meta.title = text.slice(0, 18) || '新对话'
        s.meta.updatedAt = Date.now()
      }
      try {
        await this.scenario(sid, text, images)
        await this.runSteerQueue(sid)
      } catch {
        this.emit(sid, { type: 'agent_end', messages: [] })
      } finally {
        this.running.delete(sid)
      }
    })()
  }

  private async scenario(sid: string, text: string, images?: ImageContent[]): Promise<void> {
    this.emit(sid, { type: 'agent_start' })
    this.emit(sid, { type: 'turn_start' })
    const content: string | (TextContent | ImageContent)[] =
      images && images.length > 0
        ? [...(text ? [{ type: 'text' as const, text }] : []), ...images.map((im) => ({ type: 'image' as const, data: im.data, mimeType: im.mimeType }))]
        : text
    const user: AgentMessage = { role: 'user', content }
    this.emit(sid, { type: 'message_start', message: user })
    this.emit(sid, { type: 'message_end', message: user })

    const blocks: AsstBlocks = []
    let text0 = ''
    const emitUpdate = (): void => {
      this.emit(sid, { type: 'message_update', message: asstFrom(blocks, [], 'pending') })
    }
    this.emit(sid, { type: 'message_start', message: asst('', [], 'pending') })
    const wantsBash = /运行|执行|命令|dir|npm|test|测试/.test(text)

    blocks.push({ type: 'thinking', thinking: '用户想要了解项目内容。先查看目录或文档，再决定是否需要执行命令。' })
    emitUpdate()
    for (const c of chunkText('好的，我先查看相关内容。')) {
      await this.sleep(sid, 24)
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'text') last.text += c
      else blocks.push({ type: 'text', text: c })
      emitUpdate()
    }
    const callId = uid()
    const toolName = wantsBash ? 'bash' : 'read_file'
    const args = wantsBash ? JSON.stringify({ command: 'dir' }) : JSON.stringify({ path: 'docs/design.md', limit: 80 })
    this.emit(sid, { type: 'message_update', message: asstFrom(blocks, [{ id: callId, name: toolName, arguments: '' }], 'pending') })
    this.emit(sid, { type: 'tool_execution_start', toolCallId: callId, toolName, args })
    if (wantsBash) {
      const decision = await this.requestPermission(sid, toolName, '运行命令：dir')
      if (decision === 'deny') {
        this.emit(sid, { type: 'tool_execution_end', toolCallId: callId, toolName, result: '用户拒绝了该操作', isError: true })
        const tr = toolResultMsg(callId, toolName, '用户拒绝了该操作', true)
        this.emit(sid, { type: 'message_start', message: tr })
        this.emit(sid, { type: 'message_end', message: tr })
        await this.streamAssistantTail(sid, text0, '明白，我不执行该命令。你可以把文件路径发给我，我用 read_file 查看。')
      } else {
        await this.sleep(sid, 400)
        this.emit(sid, { type: 'tool_execution_update', toolCallId: callId, toolName, partialResult: 'docs/' })
        this.emit(sid, { type: 'tool_execution_update', toolCallId: callId, toolName, partialResult: 'src/' })
        const result = 'docs/\nsrc/\npackage.json'
        this.emit(sid, { type: 'tool_execution_end', toolCallId: callId, toolName, result, isError: false })
        const tr = toolResultMsg(callId, toolName, result, false)
        this.emit(sid, { type: 'message_start', message: tr })
        this.emit(sid, { type: 'message_end', message: tr })
        await this.streamAssistantTail(sid, text0, '目录里有 docs/ 与 src/ 等。当前项目结构符合设计方案的规划。')
      }
    } else {
      await this.sleep(sid, 500)
      const result = '# navAgent 设计方案\n## 1. 概述\n（已读取 80 行）'
      this.emit(sid, { type: 'tool_execution_end', toolCallId: callId, toolName, result, isError: false })
      const tr = toolResultMsg(callId, toolName, '# navAgent 设计方案\n## 1. 概述', false)
      this.emit(sid, { type: 'message_start', message: tr })
      this.emit(sid, { type: 'message_end', message: tr })
      await this.streamAssistantTail(sid, text0, '这是设计方案文档。总体架构：Electron main 进程承载 agent loop，renderer 只消费事件流。需要我深入哪个部分？')
      if (/修改|edit|写|fix|修复/.test(text)) {
        this.demoDiffs.set(sid, {
          source: 'session',
          files: [
            {
              path: 'docs/design.md',
              status: 'modified',
              additions: 2,
              deletions: 1,
              diff: '--- a/docs/design.md\n+++ b/docs/design.md\n@@ -1,3 +1,4 @@\n # navAgent 设计方案\n-旧版结论一行\n+新版结论一行\n+补充说明\n 上下文行'
            }
          ]
        })
      }
    }
  }

  private async streamAssistantTail(sid: string, prefix: string, tail: string): Promise<void> {
    // 工具结果之后的新一轮 assistant（pi：turn_end → turn_start）
    this.emit(sid, { type: 'turn_end', message: asst(prefix, [], 'toolUse'), toolResults: [] })
    this.emit(sid, { type: 'turn_start' })
    let text = ''
    this.emit(sid, { type: 'message_start', message: asst('', [], 'pending') })
    for (const c of chunkText(tail)) {
      await this.sleep(sid, 24)
      text += c
      this.emit(sid, { type: 'message_update', message: asst(text, [], 'pending') })
    }
    // usage 随对话轮数增长（模拟真实供应商：输入随历史累积），多轮后上下文统计可见变化
    const turns = this.sessions.get(sid)?.events.filter((e) => e.type === 'message_end' && e.message.role === 'assistant').length ?? 0
    const final = {
      ...asst(text, [], 'stop'),
      usage: { inputTokens: 2_600 + turns * 900, outputTokens: 268, cacheReadTokens: 1_800 + turns * 350 },
      model: 'deepseek-chat'
    }
    this.emit(sid, { type: 'message_end', message: final })
    this.emit(sid, { type: 'turn_end', message: final, toolResults: [] })
    this.emit(sid, { type: 'agent_end', messages: [] })
  }

  private async runSteerQueue(sid: string): Promise<void> {
    const q = this.queues.get(sid)
    while (q && q.steer.length > 0) {
      const text = q.steer.shift()!
      this.emit(sid, { type: 'agent_start' })
      this.emit(sid, { type: 'turn_start' })
      const user = userMsg(`[插话] ${text}`)
      this.emit(sid, { type: 'message_start', message: user })
      this.emit(sid, { type: 'message_end', message: user })
      let t = ''
      this.emit(sid, { type: 'message_start', message: asst('', [], 'pending') })
      for (const c of chunkText('（模拟）收到你的插话，已纳入当前任务上下文。')) {
        await this.sleep(sid, 20)
        t += c
        this.emit(sid, { type: 'message_update', message: asst(t, [], 'pending') })
      }
      const final = asst(t, [], 'stop')
      this.emit(sid, { type: 'message_end', message: final })
      this.emit(sid, { type: 'turn_end', message: final, toolResults: [] })
      this.emit(sid, { type: 'agent_end', messages: [] })
    }
  }

  // ── 会话管理 ──────────────────────────────────────────────

  async newSession(projectPath: string): Promise<string> {
    const meta: SessionMeta = {
      id: uid(),
      projectPath: projectPath || this.config.workspacePath,
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: this.config.model,
      permissionMode: this.config.defaultPermissionMode ?? 'manual'
    }
    this.sessions.set(meta.id, { meta, events: [] })
    return meta.id
  }

  async listSessions(projectPath: string): Promise<SessionMeta[]> {
    return [...this.sessions.values()]
      .filter((s) => s.meta.projectPath === projectPath)
      .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
      .map((s) => {
        // 同步叶子（供 TreeOverlay 判定"当前"与跨分支摘要询问）
        const ids = this.nodeIdsOf(s.meta.id)
        if (ids.length > 0) s.meta.leafId = ids.at(-1)
        return { ...s.meta }
      })
  }

  async loadSession(id: string): Promise<SessionLoadResult> {
    const s = this.sessions.get(id)
    if (!s) return { ok: false, error: 'not-found' }
    const messages: AgentMessage[] = []
    // 对齐真实 main 侧：message_end 落盘时打 nodeId（rewind/fork 定位用）
    const ids = this.nodeIdsOf(id)
    let i = 0
    for (const e of s.events) {
      if (e.type === 'message_end') messages.push({ ...e.message, nodeId: ids[i++] ?? uid() })
    }
    return { ok: true, meta: { ...s.meta }, messages }
  }

  async searchSessions(query: string, opts?: { sessionIds?: string[]; limit?: number }): Promise<SessionSearchHit[]> {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits: SessionSearchHit[] = []
    for (const s of this.sessions.values()) {
      if (opts?.sessionIds && !opts.sessionIds.includes(s.meta.id)) continue
      for (const e of s.events) {
        if (e.type !== 'message_end') continue
        const txt = messageText(e.message)
        const at = txt.toLowerCase().indexOf(q)
        if (at === -1) continue
        hits.push({
          sessionId: s.meta.id,
          nodeId: String((e.message as AgentMessage & { nodeId?: string }).nodeId ?? ''),
          title: s.meta.title,
          updatedAt: s.meta.updatedAt,
          snippet: txt.slice(Math.max(0, at - 40), at + 160)
        })
        break
      }
      if (hits.length >= (opts?.limit ?? 50)) break
    }
    return hits
  }

  async deleteSession(id: string): Promise<'ok' | 'not-found'> {
    if (!this.sessions.has(id)) return 'not-found'
    this.running.delete(id)
    this.cancelled.set(id, true)
    const p = this.pending.get(id)
    if (p) {
      this.pending.delete(id)
      p.resolve('deny')
    }
    this.sessions.delete(id)
    this.demoDiffs.delete(id)
    return 'ok'
  }

  async setSessionMode(id: string, mode: SessionMeta['permissionMode']): Promise<void> {
    const s = this.sessions.get(id)
    if (s && mode) s.meta.permissionMode = mode
  }

  async setSessionModel(id: string, model: string): Promise<SessionMeta | null> {
    const s = this.sessions.get(id)
    if (!s) return null
    const next = String(model ?? '').trim()
    if (!next) return { ...s.meta }
    s.meta.model = next
    return { ...s.meta }
  }

  async renameSession(id: string, title: string): Promise<SessionMeta | null> {
    const s = this.sessions.get(id)
    if (!s) return null
    const next = title.trim()
    if (next) s.meta.title = next.slice(0, 80)
    return { ...s.meta }
  }

  async setSessionArchived(id: string, archived: boolean): Promise<SessionMeta | null> {
    const s = this.sessions.get(id)
    if (!s) return null
    s.meta.archived = archived || undefined
    return { ...s.meta }
  }

  async setSessionProject(id: string, projectPath: string): Promise<SessionMeta | null> {
    const s = this.sessions.get(id)
    if (!s) return null
    const next = projectPath.trim()
    if (next) s.meta.projectPath = next
    return { ...s.meta }
  }

  async diffGet(id: string): Promise<DiffResult> {
    return this.demoDiffs.get(id) ?? { source: 'session', files: [] }
  }

  async diffSummary(id: string): Promise<DiffSummary | null> {
    const d = this.demoDiffs.get(id)
    if (!d || d.files.length === 0) return null
    return d.files.reduce<DiffSummary>(
      (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions, files: acc.files + 1 }),
      { additions: 0, deletions: 0, files: 0 }
    )
  }

  async contextBreakdown(sessionId: string): Promise<ContextBreakdown> {
    const s = this.sessions.get(sessionId)
    const msgs: AgentMessage[] = []
    if (s) {
      for (const e of s.events) {
        if (e.type === 'message_end') msgs.push(e.message)
      }
    }
    // 与主进程同口径：窗口按该会话所选模型解析；真值 = 最后一条 assistant 的 usage，各段按估算比例分摊
    const model = s?.meta.model || this.config.model
    const window = catalogContextWindowOf(model, this.config.contextWindow)
    const previewOf = (t: string): string => {
      const line = t.split('\n').find((x) => x.trim().length > 0) ?? ''
      return line.length > 48 ? line.slice(0, 48) + '…' : line
    }
    const messages = msgs.map((m) => {
      const tokens = Math.ceil(JSON.stringify(m).length / 2)
      if (m.role === 'user') {
        const text = typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '[图片]')).join(' ')
        return { label: '用户', preview: previewOf(text), tokens }
      }
      if (m.role === 'assistant') {
        const calls = m.toolCalls.map((t) => t.name).join('、')
        const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        return { label: calls ? `助手（调用 ${calls}）` : '助手', preview: previewOf(text || calls), tokens }
      }
      if (m.role === 'tool_result') return { label: `工具：${m.toolName}`, preview: previewOf(m.content), tokens }
      return { label: '摘要', preview: '', tokens }
    })
    const messagesEst = messages.reduce((acc, x) => acc + x.tokens, 0)
    const systemTokens = 1200
    const toolsTokens = 900
    const estUsed = messagesEst + systemTokens + toolsTokens
    // 真实用量 = 最后一条 assistant 的 usage（输入 + 缓存读 + 缓存写）；未发生真实请求时一切为 0
    const lastUsage = [...msgs].reverse().find((m) => m.role === 'assistant')?.usage
    const real = lastUsage ? contextTokensOf(lastUsage) : 0
    const factor = real > 0 && estUsed > 0 ? real / estUsed : 0
    const scaledMessages = Math.round(messagesEst * factor)
    const scaledSystem = Math.round(systemTokens * factor)
    const scaledTools = real > 0 ? Math.max(0, real - scaledMessages - scaledSystem) : 0
    const used = real
    for (const x of messages) x.tokens = Math.round(x.tokens * factor)
    const sections: ContextSection[] = [
      { key: 'messages', label: '消息历史', tokens: scaledMessages },
      { key: 'system', label: '系统提示', tokens: scaledSystem },
      { key: 'tools', label: '工具定义', tokens: scaledTools },
      { key: 'free', label: '空闲空间', tokens: Math.max(0, window - used) }
    ]
    return { window, used, usedPct: Math.min(100, Math.round((used / window) * 100)), sections, messages, messagesTotal: scaledMessages }
  }

  async injectFile(sessionId: string, rel: string): Promise<'ok' | 'not-found'> {
    if (!this.sessions.has(sessionId)) return 'not-found'
    const list = this.injectedBy.get(sessionId) ?? []
    if (!list.includes(rel)) {
      this.injectedBy.set(sessionId, [...list, rel])
      // 对齐 main 侧：注入内容作为带 injectedPath 的合成 user 消息进 transcript（缓存友好）
      this.emit(sessionId, {
        type: 'message_end',
        message: {
          role: 'user',
          content: `<injected-file path="${rel}">\n（演示模式：文件内容快照占位）\n</injected-file>`,
          injectedPath: rel
        }
      })
    }
    return 'ok'
  }

  async uninjectFile(sessionId: string, rel: string): Promise<'ok' | 'not-found'> {
    const list = this.injectedBy.get(sessionId) ?? []
    if (!list.includes(rel)) return 'not-found'
    this.injectedBy.set(sessionId, list.filter((x) => x !== rel))
    return 'ok'
  }

  async listInjectedFiles(sessionId: string): Promise<string[]> {
    return this.injectedBy.get(sessionId) ?? []
  }

  async saveAttachment(_sessionId: string, name: string, dataB64: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    const safe = String(name ?? 'file').replace(/[\\/:*?"<>|]/g, '_').trim() || 'file'
    const rel = `.navagent/attachments/${Date.now().toString(36)}-${safe}`
    let content = ''
    try {
      content = atob(String(dataB64 ?? ''))
    } catch {
      content = '（二进制附件，演示模式无法预览）'
    }
    this.memFiles.set(rel, { content, mtime: Date.now() })
    return { ok: true, path: rel }
  }

  async absPath(sessionId: string, rel: string): Promise<string> {
    return 'C:\\demo\\' + rel.replace(/^[/\\]+/, '')
  }

  async gitBranches(_sessionId: string): Promise<{ current: string | null; branches: string[] }> {
    return { current: 'main', branches: ['main', 'feature/context-ring', 'fix/session-restore'] }
  }

  async gitStatus(sessionId: string): Promise<GitStatusResult> {
    // 演示：从会话 diff 合成改动清单；无 diff 时给一组常量化文件便于可视化
    const d = this.demoDiffs.get(sessionId)
    const unstaged: GitStatusResult['unstaged'] = d && d.files.length > 0
      ? d.files.map((f): GitStatusResult['unstaged'][number] => ({ path: f.path, status: f.status === 'deleted' ? 'deleted' : f.status === 'added' ? 'added' : 'modified' }))
      : [
          { path: 'src/renderer/src/components/Composer.tsx', status: 'modified' as const },
          { path: 'src/shared/types.ts', status: 'modified' as const }
        ]
    return { current: 'main', staged: [], unstaged, untracked: [{ path: 'notes/draft-notes.md', status: 'untracked' }] }
  }

  async gitSwitch(_sessionId: string, branch: string): Promise<{ ok: boolean; message?: string }> {
    if (branch === 'will-fail') return { ok: false, message: 'error: your local changes to the following files would be overwritten by checkout' }
    return { ok: true }
  }

  // ── 自定义供应商（演示模式：内存态增删，不落盘） ──

  private demoCustoms: CustomProviderFull[] = [
    {
      id: 'volc',
      name: '火山方舟',
      protocol: 'openai-compat',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      hasInlineKey: true,
      apiKeyValue: 'sk-demo-9f8e7d6c',
      models: [{ id: 'doubao-seed-1-6', reasoning: true, contextWindow: 128_000 }]
    }
  ]

  async saveCustomProvider(input: CustomProviderInput): Promise<CustomProviderWriteResult> {
    const name = input.name.trim()
    if (!name) return { ok: false, error: '名称不能为空' }
    if (!/^https?:\/\//.test(input.baseUrl.trim())) return { ok: false, error: 'Base URL 需以 http(s):// 开头' }
    const models = input.models.filter((m) => m.id.trim())
    if (models.length === 0) return { ok: false, error: '至少添加一个模型' }
    const id = input.id?.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
    const prev = this.demoCustoms.find((p) => p.id === id)
    const inlineKey = input.apiKey === undefined ? prev?.apiKeyValue : input.apiKey.trim() ? input.apiKey.trim() : undefined
    const entry: CustomProviderFull = {
      id,
      name,
      protocol: input.protocol,
      baseUrl: input.baseUrl.trim(),
      hasInlineKey: Boolean(inlineKey),
      ...(inlineKey ? { apiKeyValue: inlineKey } : {}),
      models: models.map((m) => ({ id: m.id.trim(), reasoning: m.reasoning ?? false, contextWindow: m.contextWindow ?? 128_000 }))
    }
    this.demoCustoms = [...this.demoCustoms.filter((p) => p.id !== id), entry]
    return { ok: true, id, snapshot: this.mockSnapshot() }
  }

  async deleteCustomProvider(id: string): Promise<CustomProviderWriteResult> {
    this.demoCustoms = this.demoCustoms.filter((p) => p.id !== id)
    return { ok: true, snapshot: this.mockSnapshot() }
  }

  async probeModels(_input: { baseUrl: string; protocol: 'openai-compat' | 'anthropic'; apiKey?: string }): Promise<{ ok: boolean; models: string[]; error?: string }> {
    await new Promise((r) => setTimeout(r, 500))
    if (!/^https?:\/\//.test(_input?.baseUrl?.trim() ?? '')) return { ok: false, models: [], error: 'Base URL 需以 http(s):// 开头' }
    return { ok: true, models: ['deepseek-chat', 'deepseek-reasoner', 'glm-4.6', 'kimi-k2-0905-preview', 'qwen3-235b-a22b'] }
  }

  /** 演示目录快照：仅内存自定义供应商 */
  private mockSnapshot(): CatalogSnapshot {
    return {
      models: this.demoCustoms.flatMap((p) =>
        p.models.map((mm) => ({
          providerId: p.id,
          model: mm.id,
          contextWindow: mm.contextWindow ?? 128_000,
          inputPrice: 0,
          outputPrice: 0,
          supportsThinking: mm.reasoning ?? false
        }))
      ),
      customs: [...this.demoCustoms]
    }
  }

  // ── 工作区文件读写 / glob / 选择（演示模式：内存态，全会话共享） ──

  /** 演示模式的内存文件系统（dev:web 下 File pane 读写这里） */
  private memFiles = new Map<string, { content: string; mtime: number }>()

  async readFile(_sessionId: string, rel: string): Promise<FileReadResult> {
    const hit = this.memFiles.get(rel)
    if (!hit) return { ok: false, error: 'not-found', message: '（演示模式）文件不存在于内存态' }
    return { ok: true, content: hit.content, mtime: hit.mtime, truncated: false }
  }

  async writeFile(_sessionId: string, rel: string, content: string, baseMtime?: number): Promise<FileWriteResult> {
    const hit = this.memFiles.get(rel)
    if (hit && baseMtime !== undefined && baseMtime !== hit.mtime) {
      return { ok: false, error: 'conflict', message: '文件已被外部修改（演示模式冲突）' }
    }
    const mtime = Date.now()
    this.memFiles.set(rel, { content, mtime })
    return { ok: true, mtime }
  }

  async globFiles(_sessionId: string, pattern: string): Promise<string[]> {
    // 与 main/tools/walk.ts 的 globToRegExp 同款语义（逐字符解析，避免替换链互相污染）
    let re: RegExp
    try {
      re = demoGlobToRegExp(pattern)
    } catch {
      return []
    }
    const seeds = ['docs/design.md', 'docs/research-desktop-agent-harness.md', 'src/App.tsx', 'src/main/index.ts', 'package.json', 'README.md']
    return [...new Set([...this.memFiles.keys(), ...seeds])].filter((k) => re.test(k)).slice(0, 200)
  }

  async revealPath(_sessionId: string, _rel: string): Promise<void> {
    /* 演示模式无文件系统 */
  }

  // ── 文件树（演示模式：固定树 + 内存态） ─────────────────────

  private demoTree: Record<string, { name: string; type: 'file' | 'dir' }[]> = {
    '': [
      { name: 'docs', type: 'dir' },
      { name: 'src', type: 'dir' },
      { name: 'package.json', type: 'file' },
      { name: 'README.md', type: 'file' }
    ],
    docs: [
      { name: 'design.md', type: 'file' },
      { name: 'references', type: 'dir' }
    ],
    'docs/references': [{ name: 'claude-code-desktop.md', type: 'file' }],
    src: [
      { name: 'components', type: 'dir' },
      { name: 'state', type: 'dir' },
      { name: 'App.tsx', type: 'file' },
      { name: 'main.tsx', type: 'file' }
    ],
    'src/components': [{ name: 'Composer.tsx', type: 'file' }],
    'src/state': [{ name: 'reducer.ts', type: 'file' }]
  }

  async listDir(_sessionId: string, path: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
    return this.demoTree[path] ?? []
  }

  // ── 终端 PTY（演示模式降级：浏览器无 shell，ptyCreate 恒 null） ──

  async ptyCreate(_sessionId: string): Promise<string | null> {
    return null
  }
  async ptyList(_sessionId: string): Promise<string[]> {
    return []
  }
  async ptyReplay(_id: string): Promise<string> {
    return ''
  }
  async ptyWrite(): Promise<void> {}
  async ptyResize(): Promise<void> {}
  async ptyKill(): Promise<void> {}
  async ptyRunCommand(): Promise<'ok' | 'no-terminal'> {
    return 'no-terminal'
  }
  onUiEvent(): () => void {
    return () => {}
  }

  // ── 会话树（演示模式：线性节点，仅支持从最新节点续跑） ──────

  /** 每会话稳定节点 id（随 message_end 数量惰性补齐） */
  private nodeIdsOf(id: string): string[] {
    const s = this.sessions.get(id)
    if (!s) return []
    const total = s.events.filter((e) => e.type === 'message_end').length
    s.nodeIds = s.nodeIds ?? []
    while (s.nodeIds.length < total) s.nodeIds.push(uid())
    return s.nodeIds
  }

  private nodesOf(id: string): SessionTreeNode[] {
    const s = this.sessions.get(id)
    if (!s) return []
    const ids = this.nodeIdsOf(id)
    const out: SessionTreeNode[] = []
    let prev: string | null = null
    let i = 0
    for (const e of s.events) {
      if (e.type !== 'message_end') continue
      const m = e.message
      const nodeId = ids[i++] ?? uid()
      out.push({
        id: nodeId,
        parentId: prev,
        kind: 'message',
        role: m.role,
        ts: s.meta.updatedAt,
        preview: messageText(m).slice(0, 80)
      })
      prev = nodeId
    }
    if (out.length > 0) s.meta.leafId = out.at(-1)!.id
    return out
  }

  async listTree(id: string): Promise<SessionTreeNode[]> {
    return this.nodesOf(id)
  }

  async switchLeaf(id: string, nodeId: string | null, _summarize: boolean): Promise<TreeSummaryResult | 'busy'> {
    if (this.running.has(id)) return 'busy'
    const s = this.sessions.get(id)
    const nodes = this.nodesOf(id)
    const idx = nodes.findIndex((n) => n.id === nodeId)
    if (!s || idx === -1) return { summaryInjected: false }
    // 回到此消息 = 事件流截断到第 idx+1 个 message_end（含自身，此后内容丢弃），App 事后 hydrate 重放
    let seen = 0
    let cut = s.events.length
    for (let i = 0; i < s.events.length; i++) {
      if (s.events[i].type === 'message_end' && ++seen > idx) {
        cut = i + 1
        break
      }
    }
    s.events = s.events.slice(0, cut)
    s.meta.leafId = nodeId ?? undefined
    return { summaryInjected: false }
  }

  async forkSession(id: string, nodeId: string): Promise<string | null> {
    if (this.running.has(id)) return null
    const s = this.sessions.get(id)
    const nodes = this.nodesOf(id)
    const idx = nodes.findIndex((n) => n.id === nodeId)
    if (!s || idx === -1) return id
    const meta: SessionMeta = {
      id: uid(),
      projectPath: s.meta.projectPath,
      title: `${s.meta.title}（fork）`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: this.config.model,
      permissionMode: s.meta.permissionMode
    }
    // 复制到第 idx+1 个 message_end 为止的事件前缀
    let seen = 0
    const prefix: AgentEvent[] = []
    for (const e of s.events) {
      prefix.push(e)
      if (e.type === 'message_end' && ++seen > idx) break
    }
    this.sessions.set(meta.id, { meta, events: prefix })
    return meta.id
  }

  async cloneSession(id: string): Promise<string | null> {
    if (this.running.has(id)) return null
    const nodes = this.nodesOf(id)
    const last = nodes.at(-1)
    if (!last) return id
    return this.forkSession(id, last.id)
  }

  // ── 工具 / 扩展 / 命令 / 信任（演示模式） ─────────────────

  private extensionCommands = new Map<string, { name: string; description: string; handler: (args: string) => string }>()

  async listTools(): Promise<ToolInfo[]> {
    const builtin = ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep', 'bash']
    return builtin.map((name) => ({
      name,
      source: 'builtin' as const,
      mutating: name === 'bash' || name === 'write_file' || name === 'edit_file',
      enabled: !this.config.disabledTools.includes(name)
    }))
  }

  async setToolEnabled(name: string, enabled: boolean): Promise<void> {
    const set = new Set(this.config.disabledTools)
    if (enabled) set.delete(name)
    else set.add(name)
    this.config = { ...this.config, disabledTools: [...set] }
  }

  async reloadExtensions(): Promise<{ tools: number; commands: number }> {
    return { tools: 0, commands: this.extensionCommands.size }
  }

  /** 演示扩展（浏览器预览扩展卡片；install 在真实 Electron 才弹目录框） */
  private demoExts: ExtensionInfo[] = [
    {
      id: 'git-flow',
      name: 'git-flow',
      version: '1.2.0',
      description: '自定义 Git 工作流：PR 工具与发布命令',
      source: 'global',
      tools: ['git_flow_pr', 'git_flow_release'],
      commands: ['review', 'greet'],
      disabled: false
    },
    {
      id: 'repo-lint',
      name: 'repo-lint',
      version: '0.3.1',
      description: '提交前仓库 lint 检查',
      source: 'project',
      tools: [],
      commands: ['lint'],
      disabled: false
    }
  ]

  async listExtensions(): Promise<ExtensionInfo[]> {
    return this.demoExts.map((e) => ({ ...e, tools: [...e.tools], commands: [...e.commands] }))
  }

  async mcpList(): Promise<{ statuses: import('@shared/types').McpServerStatus[]; config: import('@shared/types').McpConfig }> {
    return { statuses: [], config: {} }
  }
  async mcpSave(_name: string, _def: import('@shared/types').McpServerDef): Promise<{ ok: boolean; error?: string; id?: string }> {
    return { ok: false, error: '演示模式不支持 MCP' }
  }
  async mcpRemove(_name: string): Promise<'ok'> {
    return 'ok'
  }
  async mcpSetEnabled(_name: string, _enabled: boolean): Promise<'ok'> {
    return 'ok'
  }

  async installExtension(): Promise<ExtensionOpResult> {
    return { ok: false, canceled: true, extensions: this.listExtensionsSync() }
  }

  async removeExtension(id: string): Promise<ExtensionOpResult> {
    const hit = this.demoExts.find((e) => e.id === id)
    if (!hit) return { ok: false, error: `扩展不存在：${id}`, extensions: this.listExtensionsSync() }
    if (hit.source !== 'global') return { ok: false, error: '项目级扩展不可在演示模式删除', extensions: this.listExtensionsSync() }
    this.demoExts = this.demoExts.filter((e) => e.id !== id)
    return { ok: true, extensions: this.listExtensionsSync() }
  }

  async setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionInfo[]> {
    this.demoExts = this.demoExts.map((e) => (e.id === id ? { ...e, disabled: !enabled } : e))
    return this.listExtensionsSync()
  }

  private listExtensionsSync(): ExtensionInfo[] {
    return this.demoExts.map((e) => ({ ...e, tools: [...e.tools], commands: [...e.commands] }))
  }

  async listCommands(): Promise<CommandInfo[]> {
    return [
      { name: 'compact', description: '压缩会话上下文' },
      { name: 'review', description: 'prompt 模板 · 代码审查' }
    ]
  }

  async dispatchCommand(sessionId: string, name: string, args: string): Promise<'ok' | 'unknown'> {
    if (name === 'compact') {
      await this.compact(sessionId)
      return 'ok'
    }
    if (name === 'greet') {
      this.emit(sessionId, { type: 'notice', message: `/greet：你好 ${args || '世界'}` })
      return 'ok'
    }
    if (name === 'review') {
      this.emit(sessionId, { type: 'notice', message: `（演示模式）已展开 prompt 模板 /review${args ? `，参数：${args}` : ''}` })
      return 'ok'
    }
    this.emit(sessionId, { type: 'notice', message: `未知命令 /${name}（可用：/compact、扩展命令、prompts 目录下的模板）` })
    return 'unknown'
  }

  async trustProject(): Promise<void> {
    const ws = this.config.workspacePath
    if (ws && !this.config.trustedProjects.includes(ws)) {
      this.config = { ...this.config, trustedProjects: [...this.config.trustedProjects, ws] }
    }
  }

  async trustProjectOnce(): Promise<void> {
    this.trustedOnceLocal.add(this.config.workspacePath)
  }

  /** "仅本次信任"在 mock 里同样只是内存态 */
  private trustedOnceLocal = new Set<string>()

  async exportSession(id: string, format: 'jsonl' | 'html'): Promise<string | null> {
    const s = this.sessions.get(id)
    this.emit(id, { type: 'notice', message: `（演示模式）会话「${s?.meta.title ?? id}」将导出为 ${format.toUpperCase()}（真实应用会弹出保存对话框）` })
    return null
  }

  async importSession(): Promise<string | null> {
    return null
  }

  async respondUi(): Promise<void> {
    // 演示模式：扩展弹窗未实现
  }

  async panelInvoke(): Promise<unknown> {
    // 演示模式：扩展面板未实现
    return null
  }

  async panelClose(): Promise<void> {
    // 演示模式：扩展面板未实现
  }

  // ── 供应商凭据与目录（演示模式：内置目录 + 内存 auth map） ──

  private mockAuth = new Map<string, string>()

  async listModels(): Promise<ModelListResult> {
    const target = this.demoCustoms.find((p) => p.id === this.config.providerId)
    const ids = target ? target.models.map((mm) => mm.id) : [this.config.model]
    const models = [...new Set([this.config.model, ...ids])].filter(Boolean).map((id) => ({ id, live: false }))
    return { models }
  }

  async listCatalog(): Promise<CatalogSnapshot> {
    return this.mockSnapshot()
  }

  async listCredentials(): Promise<CredentialInfo[]> {
    return this.demoCustoms.map((p) => ({
      id: p.id,
      label: p.name,
      stored: this.mockAuth.has(p.id),
      source: this.mockAuth.has(p.id) ? 'auth.json' : null
    }))
  }

  async saveCredential(providerId: string, key: string): Promise<void> {
    this.mockAuth.set(providerId, key)
  }

  async clearCredential(providerId: string): Promise<void> {
    this.mockAuth.delete(providerId)
  }
}

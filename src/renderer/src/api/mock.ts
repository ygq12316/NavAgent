import type { NavAgentApi } from './types'
import type {
  AgentEvent,
  AgentMessage,
  ApiConfig,
  CommandInfo,
  FileReadResult,
  FileWriteResult,
  ImageContent,
  PermissionDecision,
  SessionMeta,
  SessionTreeNode,
  TextContent,
  ThinkingContent,
  ToolInfo,
  TreeSummaryResult
} from '@shared/types'
import { messageText } from '@shared/types'

type Listener = (e: AgentEvent) => void
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

const TREES: Record<string, Record<string, { name: string; type: 'file' | 'dir' }[]>> = {
  'E:\\pythonProject\\AgentLearn\\navAgent': {
    '': [
      { name: 'docs', type: 'dir' },
      { name: 'src', type: 'dir' },
      { name: 'index.html', type: 'file' },
      { name: 'package.json', type: 'file' },
      { name: 'README.md', type: 'file' }
    ],
    docs: [
      { name: 'design.md', type: 'file' },
      { name: 'research-desktop-agent-harness.md', type: 'file' },
      { name: 'references', type: 'dir' }
    ],
    'docs/references': [
      { name: 'pi-agent-loop.ts', type: 'file' },
      { name: 'UI-design.png', type: 'file' }
    ],
    src: [
      { name: 'api', type: 'dir' },
      { name: 'components', type: 'dir' },
      { name: 'state', type: 'dir' },
      { name: 'shared', type: 'dir' },
      { name: 'App.tsx', type: 'file' },
      { name: 'main.tsx', type: 'file' },
      { name: 'styles.css', type: 'file' }
    ],
    'src/api': [
      { name: 'mock.ts', type: 'file' },
      { name: 'types.ts', type: 'file' }
    ],
    'src/components': [
      { name: 'Sidebar.tsx', type: 'file' },
      { name: 'TopBar.tsx', type: 'file' },
      { name: 'Transcript.tsx', type: 'file' },
      { name: 'ToolBlock.tsx', type: 'file' },
      { name: 'PermissionPrompt.tsx', type: 'file' },
      { name: 'Composer.tsx', type: 'file' },
      { name: 'StatusBar.tsx', type: 'file' },
      { name: 'SettingsOverlay.tsx', type: 'file' }
    ],
    'src/state': [{ name: 'reducer.ts', type: 'file' }],
    'src/shared': [{ name: 'types.ts', type: 'file' }]
  },
  'E:\\demo\\projA': {
    '': [
      { name: 'src', type: 'dir' },
      { name: 'README.md', type: 'file' }
    ],
    src: [
      { name: 'index.ts', type: 'file' },
      { name: 'utils.ts', type: 'file' }
    ]
  },
  'E:\\demo\\projB': {
    '': [
      { name: 'main.py', type: 'file' },
      { name: 'requirements.txt', type: 'file' }
    ]
  }
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

function chunkText(s: string, size = 8): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

export class MockApi implements NavAgentApi {
  private listeners = new Set<Listener>()
  private config: ApiConfig = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-demo-xxxx',
    model: 'deepseek-chat',
    providerId: 'deepseek',
    workspacePath: Object.keys(TREES)[0],
    recentProjects: Object.keys(TREES),
    modelParams: {},
    readOnly: false,
    disabledTools: [],
    trustedProjects: []
  }
  private sessions = new Map<string, StoredSession>()
  private currentProject = this.config.workspacePath
  private currentSessionId = ''
  private running = false
  private cancelled = false
  private alwaysAllowed = new Set<string>()
  private pending: { requestId: string; resolve: (d: PermissionDecision) => void } | null = null
  private steerQueue: string[] = []
  private followUpQueue: string[] = []
  private recording = false

  constructor() {
    this.seed()
  }

  private seed(): void {
    const mk = (title: string, ageMs: number, userText: string, steps: MockStep[]): void => {
      const meta: SessionMeta = {
        id: uid(),
        projectPath: this.config.workspacePath,
        title,
        createdAt: Date.now() - ageMs,
        updatedAt: Date.now() - ageMs + 600_000,
        model: 'deepseek-chat'
      }
      this.sessions.set(meta.id, { meta, events: this.scriptedEvents(userText, steps) })
    }
    mk('总结调研报告要点', 2 * HOUR, '帮我总结这份调研报告', [
      { think: '用户要总结调研报告。报告在 docs/ 目录下，先用 read_file 读取，再按核心结论分点归纳。' },
      { say: '我先读取调研报告文件。' },
      { tool: 'read_file', args: '{"path":"docs/research-desktop-agent-harness.md","limit":200}', result: '已读取 412 行（截断）：# 本地桌面端 Coding Agent Harness 调研报告 …' },
      { say: '这份报告的核心结论：\n\n1. 推荐 TypeScript + Electron 技术栈，手写 agent loop；\n2. UI 采用 transcript 终端风格与新拟物视觉；\n3. provider 层照 pi 的"边界转换"模式设计。' }
    ])
    mk('修复登录超时 bug', DAY + 3 * HOUR, '排查一下登录超时的问题', [
      { say: '我先看下日志文件。' },
      { tool: 'read_file', args: '{"path":"logs/app.log"}', result: '…timeout at line 42…' },
      { say: '我运行一下测试确认。' },
      { tool: 'bash', args: '{"command":"npm test"}', result: '用户拒绝了该操作', isError: true },
      { say: '好的，已跳过运行测试。根据日志，超时发生在鉴权环节。' }
    ])
    mk('设计 provider 抽象层', 6 * DAY, '怎么设计 provider 抽象层？', [
      { say: '参考 pi 的两层分离：Provider 是厂商数据（15 行），Api 是协议模块（10 种）。建议先用 OpenAI 兼容 + Anthropic 两个 adapter。' }
    ])
    this.currentSessionId = [...this.sessions.values()].sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)[0].meta.id
  }

  /** 离线构造一段历史（用于会话重放演示） */
  private scriptedEvents(userText: string, steps: MockStep[]): AgentEvent[] {
    const events: AgentEvent[] = []
    const user = userMsg(userText)
    events.push({ type: 'agent_start' }, { type: 'turn_start' })
    events.push({ type: 'message_start', message: user }, { type: 'message_end', message: user })
    let text = ''
    void text
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
      usage: { inputTokens: 4_820, outputTokens: 361 },
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

  private emit(e: AgentEvent): void {
    this.listeners.forEach((l) => l(e))
    const s = this.sessions.get(this.currentSessionId)
    if (s && this.recording) s.events.push(e)
  }

  private get demoDelay(): number {
    return document.visibilityState === 'visible' ? 1 : 0
  }

  private async sleep(ms: number): Promise<void> {
    const target = ms * this.demoDelay
    if (target <= 0) {
      if (this.cancelled) throw new Error('aborted')
      return
    }
    await new Promise<void>((r) => setTimeout(r, target))
    if (this.cancelled) throw new Error('aborted')
  }

  async getConfig(): Promise<ApiConfig> {
    return { ...this.config }
  }

  async setConfig(partial: Partial<ApiConfig>): Promise<ApiConfig> {
    this.config = { ...this.config, ...partial }
    if (partial.workspacePath) this.currentProject = partial.workspacePath
    return { ...this.config }
  }

  async pickWorkspace(): Promise<string | null> {
    const paths = Object.keys(TREES)
    const idx = paths.indexOf(this.config.workspacePath)
    return paths[(idx + 1) % paths.length]
  }

  async send(text: string, images?: ImageContent[]): Promise<'ok' | 'busy'> {
    if (this.running) return 'busy'
    this.running = true
    this.cancelled = false
    const s = this.sessions.get(this.currentSessionId)
    if (s && s.meta.title === '新对话') s.meta.title = text.slice(0, 18) || '新对话'
    this.recording = true
    try {
      await this.runScenario(text, images)
      await this.runSteerQueue()
    } catch {
      this.emitAborted()
    } finally {
      this.recording = false
      if (s) s.meta.updatedAt = Date.now()
      this.running = false
    }
    return 'ok'
  }

  private emitAborted(): void {
    this.emit({ type: 'agent_end', messages: [] })
  }

  private async runScenario(text: string, images?: ImageContent[]): Promise<void> {
    this.emit({ type: 'agent_start' })
    this.emit({ type: 'turn_start' })
    const content: string | (TextContent | ImageContent)[] =
      images && images.length > 0
        ? [...(text ? [{ type: 'text' as const, text }] : []), ...images.map((im) => ({ type: 'image' as const, data: im.data, mimeType: im.mimeType }))]
        : text
    const user: AgentMessage = { role: 'user', content }
    this.emit({ type: 'message_start', message: user })
    this.emit({ type: 'message_end', message: user })

    const blocks: AsstBlocks = []
    let text0 = ''
    const emitUpdate = (): void => {
      this.emit({ type: 'message_update', message: asstFrom(blocks, [], 'pending') })
    }
    this.emit({ type: 'message_start', message: asst('', [], 'pending') })
    const wantsBash = /运行|执行|命令|dir|npm|test|测试/.test(text)

    // thinking 先行（演示思考面板），再流出正文
    blocks.push({ type: 'thinking', thinking: '用户想要了解项目内容。先查看目录或文档，再决定是否需要执行命令。' })
    emitUpdate()
    for (const c of chunkText('好的，我先查看相关内容。')) {
      await this.sleep(24)
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'text') last.text += c
      else blocks.push({ type: 'text', text: c })
      text0 += c
      emitUpdate()
    }
    const callId = uid()
    const toolName = wantsBash ? 'bash' : 'read_file'
    const args = wantsBash ? JSON.stringify({ command: 'dir' }) : JSON.stringify({ path: 'docs/design.md', limit: 80 })
    this.emit({ type: 'message_update', message: asstFrom(blocks, [{ id: callId, name: toolName, arguments: '' }], 'pending') })
    this.emit({ type: 'tool_execution_start', toolCallId: callId, toolName, args })
    if (wantsBash) {
      const decision = await this.requestPermission(toolName, '运行命令：dir')
      if (decision === 'deny') {
        this.emit({ type: 'tool_execution_end', toolCallId: callId, toolName, result: '用户拒绝了该操作', isError: true })
        const tr = toolResultMsg(callId, toolName, '用户拒绝了该操作', true)
        this.emit({ type: 'message_start', message: tr })
        this.emit({ type: 'message_end', message: tr })
        await this.streamAssistantTail(text0, '明白，我不执行该命令。你可以把文件路径发给我，我用 read_file 查看。')
      } else {
        await this.sleep(400)
        this.emit({ type: 'tool_execution_update', toolCallId: callId, toolName, partialResult: 'docs/' })
        this.emit({ type: 'tool_execution_update', toolCallId: callId, toolName, partialResult: 'src/' })
        const result = 'docs/\nsrc/\npackage.json'
        this.emit({ type: 'tool_execution_end', toolCallId: callId, toolName, result, isError: false })
        const tr = toolResultMsg(callId, toolName, result, false)
        this.emit({ type: 'message_start', message: tr })
        this.emit({ type: 'message_end', message: tr })
        await this.streamAssistantTail(text0, '目录里有 docs/ 与 src/ 等。当前项目结构符合设计方案的规划。')
      }
    } else {
      await this.sleep(500)
      const result = '# navAgent 设计方案\n## 1. 概述\n（已读取 80 行）'
      this.emit({ type: 'tool_execution_end', toolCallId: callId, toolName, result, isError: false })
      const tr = toolResultMsg(callId, toolName, '# navAgent 设计方案\n## 1. 概述', false)
      this.emit({ type: 'message_start', message: tr })
      this.emit({ type: 'message_end', message: tr })
      await this.streamAssistantTail(text0, '这是设计方案文档。总体架构：Electron main 进程承载 agent loop，renderer 只消费事件流。需要我深入哪个部分？')
    }
  }

  private async streamAssistantTail(prefix: string, tail: string): Promise<void> {
    // 工具结果之后的新一轮 assistant（pi：turn_end → turn_start）
    this.emit({ type: 'turn_end', message: asst(prefix, [], 'toolUse'), toolResults: [] })
    this.emit({ type: 'turn_start' })
    let text = ''
    this.emit({ type: 'message_start', message: asst('', [], 'pending') })
    for (const c of chunkText(tail)) {
      await this.sleep(24)
      text += c
      this.emit({ type: 'message_update', message: asst(text, [], 'pending') })
    }
    const final = { ...asst(text, [], 'stop'), usage: { inputTokens: 3_140, outputTokens: 268 }, model: 'deepseek-chat' }
    this.emit({ type: 'message_end', message: final })
    this.emit({ type: 'turn_end', message: final, toolResults: [] })
    this.emit({ type: 'agent_end', messages: [] })
  }

  private async runSteerQueue(): Promise<void> {
    while (this.steerQueue.length > 0) {
      const text = this.steerQueue.shift()!
      this.emit({ type: 'agent_start' })
      this.emit({ type: 'turn_start' })
      const user = userMsg(`[插话] ${text}`)
      this.emit({ type: 'message_start', message: user })
      this.emit({ type: 'message_end', message: user })
      let t = ''
      this.emit({ type: 'message_start', message: asst('', [], 'pending') })
      for (const c of chunkText('（模拟）收到你的插话，已纳入当前任务上下文。')) {
        await this.sleep(20)
        t += c
        this.emit({ type: 'message_update', message: asst(t, [], 'pending') })
      }
      const final = asst(t, [], 'stop')
      this.emit({ type: 'message_end', message: final })
      this.emit({ type: 'turn_end', message: final, toolResults: [] })
      this.emit({ type: 'agent_end', messages: [] })
    }
  }

  private async requestPermission(toolName: string, detail: string): Promise<PermissionDecision> {
    if (this.alwaysAllowed.has(toolName)) return Promise.resolve('approve')
    const requestId = `perm_${Date.now()}`
    this.emit({ type: 'permission_request', requestId, toolName, detail })
    return new Promise((resolve) => {
      this.pending = { requestId, resolve }
    })
  }

  async steer(text: string): Promise<'ok' | 'queued' | 'busy'> {
    if (typeof text !== 'string' || text.trim().length === 0) return 'busy'
    this.steerQueue.push(text.trim())
    this.emit({ type: 'queue_update', steering: this.steerQueue.length, followUp: this.followUpQueue.length })
    return 'queued'
  }

  async cancel(): Promise<string[]> {
    if (!this.running) return [...this.steerQueue.splice(0), ...this.followUpQueue.splice(0)]
    this.cancelled = true
    if (this.pending) {
      const p = this.pending
      this.pending = null
      p.resolve('deny')
    }
    return [...this.steerQueue.splice(0), ...this.followUpQueue.splice(0)]
  }

  async followUp(text: string): Promise<'ok' | 'queued' | 'busy'> {
    if (typeof text !== 'string' || text.trim().length === 0) return 'busy'
    this.followUpQueue.push(text.trim())
    this.emit({ type: 'queue_update', steering: this.steerQueue.length, followUp: this.followUpQueue.length })
    return 'queued'
  }

  async compact(): Promise<'ok' | 'busy'> {
    this.emit({
      type: 'compacted',
      summary: '（模拟压缩）用户要求总结调研报告；已读取设计文档；下一步待定。',
      removedCount: 2
    })
    return 'ok'
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    if (this.pending?.requestId !== requestId) return
    const p = this.pending
    this.pending = null
    if (decision === 'always') this.alwaysAllowed.add('bash')
    p.resolve(decision === 'always' ? 'approve' : decision)
  }

  async newSession(): Promise<string> {
    if (this.running) return this.currentSessionId
    const meta: SessionMeta = {
      id: uid(),
      projectPath: this.currentProject,
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: this.config.model
    }
    this.sessions.set(meta.id, { meta, events: [] })
    this.currentSessionId = meta.id
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

  async switchSession(id: string): Promise<void> {
    if (this.running) return
    const s = this.sessions.get(id)
    if (!s) return
    this.currentSessionId = id
    const gap = 6 * this.demoDelay
    for (const e of s.events) {
      this.emit(e)
      if (gap) await new Promise((r) => setTimeout(r, gap))
    }
  }

  async deleteSession(id: string): Promise<'ok' | 'busy' | 'not-found'> {
    if (!this.sessions.has(id)) return 'not-found'
    this.sessions.delete(id)
    // 与主进程同义：删除当前会话时切到同项目第一个剩余会话（消息重放仍由 App 的 switchSession 触发）
    if (this.currentSessionId === id) {
      this.currentSessionId =
        [...this.sessions.values()]
          .filter((s) => s.meta.projectPath === this.currentProject)
          .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)[0]?.meta.id ?? ''
    }
    return 'ok'
  }

  async listDir(path: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
    return TREES[this.currentProject]?.[path] ?? []
  }

  // ── 工作区文件读写 / glob / 选择（演示模式：内存态） ───────

  /** 演示模式的内存文件系统（dev:web 下 File 窗口读写这里） */
  private memFiles = new Map<string, { content: string; mtime: number }>()

  async readFile(rel: string): Promise<FileReadResult> {
    const hit = this.memFiles.get(rel)
    if (!hit) return { ok: false, error: 'not-found', message: '（演示模式）文件不存在于内存态' }
    return { ok: true, content: hit.content, mtime: hit.mtime, truncated: false }
  }

  async writeFile(rel: string, content: string, baseMtime?: number): Promise<FileWriteResult> {
    const hit = this.memFiles.get(rel)
    if (hit && baseMtime !== undefined && baseMtime !== hit.mtime) {
      return { ok: false, error: 'conflict', message: '文件已被外部修改（演示模式冲突）' }
    }
    const mtime = Date.now()
    this.memFiles.set(rel, { content, mtime })
    return { ok: true, mtime }
  }

  async globFiles(pattern: string): Promise<string[]> {
    // 简化 glob → 正则（对齐主进程语义的关键是 **/ 可选，根目录文件也能命中）
    const body = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '(?:.*/)?')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
    const re = new RegExp('^(?:' + body + ')$', 'i')
    return [...this.memFiles.keys()].filter((k) => re.test(k)).slice(0, 200)
  }

  async pickFile(): Promise<string | null> {
    this.emit({ type: 'notice', message: '（演示模式）系统文件选择器仅桌面应用可用' })
    return null
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

  async switchLeaf(id: string, nodeId: string, _summarize: boolean): Promise<TreeSummaryResult> {
    if (this.running) {
      this.emit({ type: 'notice', message: '运行中无法切换分支，请先停止。' })
      return { summaryInjected: false }
    }
    const nodes = this.nodesOf(id)
    if (!nodes.some((n) => n.id === nodeId)) return { summaryInjected: false }
    if (nodes.at(-1)?.id !== nodeId) {
      this.emit({ type: 'notice', message: '（演示模式：仅支持从最新节点续跑）' })
      return { summaryInjected: false }
    }
    return { summaryInjected: false }
  }

  async forkSession(id: string, nodeId: string): Promise<string> {
    const s = this.sessions.get(id)
    const nodes = this.nodesOf(id)
    const idx = nodes.findIndex((n) => n.id === nodeId)
    if (!s || idx === -1) return id
    const meta: SessionMeta = {
      id: uid(),
      projectPath: this.currentProject,
      title: `${s.meta.title}（fork）`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: this.config.model
    }
    // 复制到第 idx+1 个 message_end 为止的事件前缀
    let seen = 0
    const prefix: AgentEvent[] = []
    for (const e of s.events) {
      prefix.push(e)
      if (e.type === 'message_end' && ++seen > idx) break
    }
    this.sessions.set(meta.id, { meta, events: prefix })
    this.currentSessionId = meta.id
    return meta.id
  }

  async cloneSession(id: string): Promise<string> {
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

  async listCommands(): Promise<CommandInfo[]> {
    return [...this.extensionCommands.values()].map((c) => ({ name: c.name, description: c.description }))
  }

  async dispatchCommand(name: string, args: string): Promise<'ok' | 'unknown'> {
    if (name === 'compact') {
      await this.compact()
      return 'ok'
    }
    if (name === 'greet') {
      this.emit({ type: 'notice', message: `/greet：你好 ${args || '世界'}` })
      return 'ok'
    }
    if (name === 'review') {
      this.emit({ type: 'notice', message: `（演示模式）已展开 prompt 模板 /review${args ? `，参数：${args}` : ''}` })
      return 'ok'
    }
    this.emit({ type: 'notice', message: `未知命令 /${name}（可用：/compact、扩展命令、prompts 目录下的模板）` })
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
  isTrustedLocal(ws: string): boolean {
    return this.config.trustedProjects.includes(ws) || this.trustedOnceLocal.has(ws)
  }

  async exportSession(id: string, format: 'jsonl' | 'html'): Promise<string | null> {
    const s = this.sessions.get(id)
    this.emit({ type: 'notice', message: `（演示模式）会话「${s?.meta.title ?? id}」将导出为 ${format.toUpperCase()}（真实应用会弹出保存对话框）` })
    return null
  }

  async importSession(): Promise<string | null> {
    this.emit({ type: 'notice', message: '（演示模式）导入需要选择本地 JSONL 文件，桌面应用中可用' })
    return null
  }
}

type MockStep = { say: string } | { think: string } | { tool: string; args: string; result: string; isError?: boolean }

interface StoredSession {
  meta: SessionMeta
  events: AgentEvent[]
  /** 树节点稳定 id（与 message_end 事件一一对应，惰性补齐） */
  nodeIds?: string[]
}

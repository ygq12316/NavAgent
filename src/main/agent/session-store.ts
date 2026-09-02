import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentMessage, SessionMeta, SessionTreeNode } from '@shared/types'
import { messageText } from '@shared/types'
import { ancestorChain, type ParentMap } from './branch'

interface JsonlLine {
  ts: number
  /** 树节点 id（只有 message/snapshot 行是节点） */
  id?: string
  parentId?: string | null
  event?: AgentEvent
  message?: AgentMessage
  /** 压缩后的完整消息快照：路径重建时遇到即清空此前累积 */
  snapshot?: AgentMessage[]
}

interface NodeRec {
  id: string
  parentId: string | null
  kind: 'message' | 'snapshot'
  messages: AgentMessage[]
  ts: number
}

/**
 * 旧版本持久化兼容：assistant content 曾是纯字符串，加载时升级为单个 text 块。
 * 幂等（块数组原样返回），只在 load 收口调用。
 */
function normalizeMessage(m: AgentMessage): AgentMessage {
  if (m.role === 'assistant' && typeof (m.content as unknown) === 'string') {
    return { ...m, content: [{ type: 'text', text: m.content as unknown as string }] }
  }
  return m
}

/**
 * 会话持久化（设计方案 4.5 + 会话树）：目录按项目分组，JSONL append-only；
 * message/snapshot 行是树节点（id/parentId），event 行不参与树（仅 UI 重放/调试）；
 * meta.leafId 为活动叶子，恢复 = 沿 parent 链回溯根再正向重放（snapshot 行清空此前累积）。
 * 旧格式（无 id）在 load 时一次性原子迁移为线性链。
 */
export class SessionStore {
  private root: string
  private metas = new Map<string, SessionMeta>()
  currentId: string | null = null

  constructor(userDataPath: string) {
    this.root = join(userDataPath, 'sessions')
    this.scanAll()
  }

  private keyOf(projectPath: string): string {
    return projectPath.replace(/[^a-zA-Z0-9一-龥]+/g, '_').slice(0, 80) || 'default'
  }

  private dirOf(id: string): string {
    const meta = this.metas.get(id)
    return join(this.root, this.keyOf(meta?.projectPath ?? 'default'))
  }

  private fileOf(id: string): string {
    return join(this.dirOf(id), `${id}.jsonl`)
  }

  private metaFileOf(id: string): string {
    return join(this.dirOf(id), `${id}.meta.json`)
  }

  private scanAll(): void {
    let projectDirs: string[] = []
    try {
      projectDirs = readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return
    }
    for (const dir of projectDirs) {
      const full = join(this.root, dir)
      try {
        for (const f of readdirSync(full)) {
          if (!f.endsWith('.meta.json')) continue
          try {
            const meta = JSON.parse(readFileSync(join(full, f), 'utf-8')) as SessionMeta
            if (meta.id) this.metas.set(meta.id, meta)
          } catch {
            // 单个 meta 损坏不阻塞其余会话
          }
        }
      } catch {
        // 目录读取失败跳过
      }
    }
  }

  list(projectPath: string): SessionMeta[] {
    return [...this.metas.values()]
      .filter((m) => m.projectPath === projectPath)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => ({ ...m }))
  }

  getCurrent(): SessionMeta | null {
    return this.currentId ? this.metas.get(this.currentId) ?? null : null
  }

  getMeta(id: string): SessionMeta | null {
    const meta = this.metas.get(id)
    return meta ? { ...meta } : null
  }

  /** 活动路径消息（不切换当前会话；供导出等只读用途） */
  getMessages(id: string): AgentMessage[] {
    const meta = this.metas.get(id)
    if (!meta) throw new Error(`会话不存在：${id}`)
    const nodes = this.readNodes(id)
    return activePathMessages(nodes, this.resolveLeaf(meta, nodes))
  }

  /** 导出源文件路径（先确保旧格式迁移完成） */
  sourceFileOf(id: string): string {
    if (!this.metas.has(id)) throw new Error(`会话不存在：${id}`)
    this.readNodes(id)
    return this.fileOf(id)
  }

  /**
   * 删除会话（jsonl + meta）。存在性以 metas 注册表为准：
   * 刚 create 的会话可能还没有 jsonl（仅 meta），未注册的 id 一律 not-found（不抛错）。
   * 被删会话若为当前会话，currentId 置空；自动切换/重放由 IPC 层负责。
   */
  remove(id: string): 'ok' | 'not-found' {
    if (!this.metas.has(id)) return 'not-found'
    rmSync(this.fileOf(id), { force: true })
    rmSync(this.metaFileOf(id), { force: true })
    this.metas.delete(id)
    if (this.currentId === id) this.currentId = null
    return 'ok'
  }

  /**
   * 从 JSONL 文件导入为新会话：逐行校验 → 合成节点 id（若缺）→ 写入当前项目分组 → 切为当前会话。
   * 结构非法抛错，由调用侧转 notice。
   */
  importFrom(srcPath: string, projectPath: string, model: string): SessionMeta {
    let lines: JsonlLine[]
    try {
      lines = readFileSync(srcPath, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as JsonlLine)
    } catch {
      throw new Error('不是有效的会话 JSONL 文件')
    }
    if (!lines.some((l) => l.message || l.snapshot)) throw new Error('文件中没有消息行')
    for (const l of lines) {
      if (!l.message && !l.snapshot && !l.event) throw new Error('存在无法识别的行结构')
    }
    // 缺 id 的导入文件先在内存合成线性链，避免导入后叶子与历史断链
    let prev: string | null = null
    let lastNodeId: string | null = null
    const normalized: JsonlLine[] = lines.map((l) => {
      if (!(l.message || l.snapshot)) return l
      const nodeId = l.id ?? randomUUID()
      const next: JsonlLine = { ...l, id: nodeId, parentId: l.parentId ?? prev }
      prev = nodeId
      lastNodeId = nodeId
      return next
    })
    const firstUser = normalized.find((l) => l.message?.role === 'user')?.message
    const meta = this.create(projectPath, model)
    const registered = this.metas.get(meta.id)!
    registered.title = (firstUser ? messageText(firstUser).slice(0, 40) : '') || '导入的会话'
    if (lastNodeId) registered.leafId = lastNodeId
    appendFileSync(this.fileOf(registered.id), normalized.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
    this.writeMeta(registered.id)
    return { ...registered }
  }

  create(projectPath: string, model: string): SessionMeta {
    const meta: SessionMeta = {
      id: randomUUID(),
      projectPath,
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model,
      leafId: undefined
    }
    // 先注册再建目录：dirOf 依赖 metas 里的 projectPath，顺序反了会把数据写进 'default' 目录且后续 append 静默失败
    this.metas.set(meta.id, meta)
    mkdirSync(this.dirOf(meta.id), { recursive: true })
    this.writeMeta(meta.id)
    this.currentId = meta.id
    return { ...meta }
  }

  load(id: string): { meta: SessionMeta; messages: AgentMessage[]; events: AgentEvent[] } {
    const meta = this.metas.get(id)
    if (!meta) throw new Error(`会话不存在：${id}`)
    this.currentId = id
    let lines: JsonlLine[] = []
    try {
      lines = readFileSync(this.fileOf(id), 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as JsonlLine)
    } catch {
      lines = []
    }
    lines = this.migrateIfNeeded(id, lines)

    const events: AgentEvent[] = []
    for (const line of lines) {
      if (line.event) events.push(line.event)
    }
    const nodes = linesToNodes(lines)
    const leaf = this.resolveLeaf(meta, nodes)
    const messages = activePathMessages(nodes, leaf)
    this.touch(id)
    return { meta: { ...meta }, messages, events }
  }

  // ── 会话树操作 ────────────────────────────────────────────────

  private readNodes(id: string): NodeRec[] {
    let lines: JsonlLine[] = []
    try {
      lines = readFileSync(this.fileOf(id), 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as JsonlLine)
    } catch {
      return []
    }
    lines = this.migrateIfNeeded(id, lines)
    return linesToNodes(lines)
  }

  private resolveLeaf(meta: SessionMeta, nodes: NodeRec[]): string | null {
    if (nodes.length === 0) return null
    if (meta.leafId && nodes.some((n) => n.id === meta.leafId)) return meta.leafId
    const last = nodes[nodes.length - 1].id
    meta.leafId = last
    this.writeMeta(meta.id)
    return last
  }

  private parentMapOf(nodes: NodeRec[]): ParentMap {
    return new Map(nodes.map((n) => [n.id, n.parentId]))
  }

  getLeaf(id: string): string | null {
    return this.metas.get(id)?.leafId ?? null
  }

  /** root→nodeId 的节点 id 链；nodeId 非法返回 [] */
  getAncestors(id: string, nodeId: string): string[] {
    return ancestorChain(nodeId, this.parentMapOf(this.readNodes(id)))
  }

  listTree(id: string): SessionTreeNode[] {
    const meta = this.metas.get(id)
    if (!meta) throw new Error(`会话不存在：${id}`)
    return this.readNodes(id).map((n) => ({
      id: n.id,
      parentId: n.parentId,
      kind: n.kind,
      role: n.kind === 'snapshot' ? ('snapshot' as const) : n.messages[0]!.role,
      ts: n.ts,
      preview:
        n.kind === 'snapshot'
          ? `[压缩快照 · ${n.messages.length} 条]`
          : messageText(n.messages[0]!).slice(0, 80)
    }))
  }

  /** 切换活动叶子：leafId 持久化，返回新活动路径的线性消息 */
  switchLeaf(id: string, nodeId: string): { messages: AgentMessage[] } {
    const meta = this.metas.get(id)
    if (!meta) throw new Error(`会话不存在：${id}`)
    const nodes = this.readNodes(id)
    if (!nodes.some((n) => n.id === nodeId)) throw new Error(`树节点不存在：${nodeId}`)
    meta.leafId = nodeId
    this.writeMeta(id)
    return { messages: activePathMessages(nodes, nodeId) }
  }

  /** (fromExclusive, toInclusive] 区间的消息（被离开分支摘要的输入） */
  messagesBetween(id: string, fromExclusive: string, toInclusive: string): AgentMessage[] {
    const nodes = this.readNodes(id)
    const chain = ancestorChain(toInclusive, this.parentMapOf(nodes))
    const idx = chain.indexOf(fromExclusive)
    if (idx === -1) return []
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const out: AgentMessage[] = []
    for (const nid of chain.slice(idx + 1)) {
      const n = byId.get(nid)
      if (n) out.push(...n.messages)
    }
    return out
  }

  /** 从指定节点派生新会话：祖先链消息行（保留原节点 id）写入新文件并切换为当前会话 */
  fork(id: string, nodeId: string): SessionMeta {
    const src = this.metas.get(id)
    if (!src) throw new Error(`会话不存在：${id}`)
    const nodes = this.readNodes(id)
    if (!nodes.some((n) => n.id === nodeId)) throw new Error(`树节点不存在：${nodeId}`)
    const chain = ancestorChain(nodeId, this.parentMapOf(nodes))
    const byId = new Map(nodes.map((n) => [n.id, n]))

    const created = this.create(src.projectPath, src.model)
    // create 返回副本；leafId/title 必须写回注册表里的同一对象
    const meta = this.metas.get(created.id)!
    meta.title = `${src.title}（fork）`
    meta.leafId = nodeId
    const lines: JsonlLine[] = chain.map((nid) => {
      const n = byId.get(nid)!
      return { ts: n.ts, id: n.id, parentId: n.parentId, ...(n.kind === 'snapshot' ? { snapshot: n.messages } : { message: n.messages[0]! }) }
    })
    appendFileSync(this.fileOf(meta.id), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
    this.writeMeta(meta.id)
    return { ...meta }
  }

  /** 复制当前活动分支为新会话并切换 */
  clone(id: string): SessionMeta {
    const leaf = this.getLeaf(id)
    if (!leaf) throw new Error('会话为空，无从克隆')
    return this.fork(id, leaf)
  }

  appendEvent(id: string, e: AgentEvent): void {
    try {
      appendFileSync(this.fileOf(id), JSON.stringify({ ts: Date.now(), event: e }) + '\n', 'utf-8')
      if (e.type === 'turn_end') this.touch(id)
    } catch {
      // 持久化失败不阻塞对话
    }
  }

  /** 追加消息为新的树节点（parent=当前叶子，随后叶子前移） */
  appendMessage(id: string, m: AgentMessage): void {
    this.appendNode(id, { ts: Date.now(), message: m })
  }

  /** 压缩快照：单个树节点承载替换后的完整消息链 */
  appendSnapshot(id: string, messages: AgentMessage[]): void {
    this.appendNode(id, { ts: Date.now(), snapshot: messages })
  }

  private appendNode(id: string, line: { ts: number; message?: AgentMessage; snapshot?: AgentMessage[] }): void {
    const meta = this.metas.get(id)
    if (!meta) return
    const nodeId = randomUUID()
    const full: JsonlLine = { ...line, id: nodeId, parentId: meta.leafId ?? null }
    try {
      appendFileSync(this.fileOf(id), JSON.stringify(full) + '\n', 'utf-8')
      meta.leafId = nodeId
      this.writeMeta(id)
    } catch {
      // 同上
    }
  }

  ensureTitle(id: string, firstUserText: string): void {
    const meta = this.metas.get(id)
    if (!meta || meta.title !== '新对话') return
    meta.title = firstUserText.slice(0, 40) || '新对话'
    this.writeMeta(id)
  }

  private writeMeta(id: string): void {
    const meta = this.metas.get(id)
    if (!meta) return
    try {
      writeFileSync(this.metaFileOf(id), JSON.stringify(meta, null, 2), 'utf-8')
    } catch {
      // 忽略
    }
  }

  /** 旧格式（节点行缺 id）迁移：内存合成线性链后原子重写；已迁移则原样返回 */
  private migrateIfNeeded(id: string, lines: JsonlLine[]): JsonlLine[] {
    if (!lines.some((l) => (l.message || l.snapshot) && !l.id)) return lines
    let prev: string | null = null
    const out = lines.map((l) => {
      if (!(l.message || l.snapshot)) return l
      const next: JsonlLine = { ...l, id: l.id ?? randomUUID(), parentId: l.parentId ?? prev }
      prev = next.id ?? null
      return next
    })
    try {
      const tmp = this.fileOf(id) + '.tmp'
      writeFileSync(tmp, out.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
      renameSync(tmp, this.fileOf(id))
      const meta = this.metas.get(id)
      if (meta && !meta.leafId) {
        const last = out.filter((l) => l.message || l.snapshot).at(-1)
        if (last?.id) {
          meta.leafId = last.id
          this.writeMeta(id)
        }
      }
    } catch {
      // 迁移失败降级为内存态（下次 load 重试）
    }
    return out
  }

  private touch(id: string): void {
    const meta = this.metas.get(id)
    if (!meta) return
    meta.updatedAt = Date.now()
    this.writeMeta(id)
  }
}

// ── 纯函数：行 → 节点 → 活动路径 ─────────────────────────────

function linesToNodes(lines: JsonlLine[]): NodeRec[] {
  const nodes: NodeRec[] = []
  for (const l of lines) {
    if (l.snapshot) {
      nodes.push({ id: l.id ?? randomUUID(), parentId: l.parentId ?? null, kind: 'snapshot', messages: l.snapshot.map(normalizeMessage), ts: l.ts })
    } else if (l.message) {
      nodes.push({ id: l.id ?? randomUUID(), parentId: l.parentId ?? null, kind: 'message', messages: [normalizeMessage(l.message)], ts: l.ts })
    }
  }
  return nodes
}

/** root→leaf 正向重放：snapshot 节点清空此前累积（保留压缩语义），其余按序展开 */
function activePathMessages(nodes: NodeRec[], leafId: string | null): AgentMessage[] {
  if (!leafId) return []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const chain: NodeRec[] = []
  let cur = byId.get(leafId)
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.push(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  chain.reverse()
  const out: AgentMessage[] = []
  for (const n of chain) {
    if (n.kind === 'snapshot') out.length = 0
    out.push(...n.messages)
  }
  return out
}

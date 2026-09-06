import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentMessage, SessionMeta, SessionSearchHit, SessionTreeNode } from '@shared/types'
import { messageText } from '@shared/types'
import { ancestorChain, type ParentMap } from './branch'
import {
  importLinesInto,
  makeNodeRow,
  migrateLegacyLayout,
  normalizeMessage,
  SessionDb,
  type JsonlLine
} from './session-db'

interface NodeRec {
  id: string
  parentId: string | null
  kind: 'message' | 'snapshot'
  messages: AgentMessage[]
  ts: number
}

/**
 * 会话持久化（SQLite 权威存储 + JSONL 导入/导出格式，设计方案 4.5 + 会话树）：
 * message/snapshot 行是树节点（id/parentId），event 行不参与树（仅调试/导出）；
 * meta.leafId 为活动叶子，恢复 = 沿 parent 链回溯根再正向重放（snapshot 行清空此前累积）。
 * 旧 JSONL+meta.json 布局在构造时一次性迁移入库（见 session-db.migrateLegacyLayout）。
 */
export class SessionStore {
  private db: SessionDb
  private metas = new Map<string, SessionMeta>()
  currentId: string | null = null

  constructor(userDataPath: string) {
    this.db = new SessionDb(join(userDataPath, 'sessions.db'))
    migrateLegacyLayout(userDataPath, this.db)
    for (const meta of this.db.allSessions()) this.metas.set(meta.id, meta)
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

  /** 导出为旧格式 JSONL 字符串（与 importFrom 互逆） */
  exportJsonl(id: string): string {
    if (!this.metas.has(id)) throw new Error(`会话不存在：${id}`)
    return this.db.exportJsonl(id)
  }

  /**
   * 删除会话（nodes/events/ext_state/sessions 四表单事务）。存在性以 metas 注册表为准：
   * 刚 create 的会话行已存在，未注册的 id 一律 not-found（不抛错）。
   * 被删会话若为当前会话，currentId 置空；自动切换/重放由 IPC 层负责。
   */
  remove(id: string): 'ok' | 'not-found' {
    if (!this.metas.has(id)) return 'not-found'
    // 断线提升：派生子会话不级联删除，脱离父级成为新的根（会话地图语义）
    for (const m of this.metas.values()) {
      if (m.forkSourceId === id) {
        delete m.forkSourceId
        delete m.forkNodeId
        this.db.updateSessionColumns(m.id, { forkSourceId: null, forkNodeId: null })
      }
    }
    this.db.deleteSessionAll(id)
    this.metas.delete(id)
    if (this.currentId === id) this.currentId = null
    return 'ok'
  }

  /**
   * 从 JSONL 文件导入为新会话：逐行校验 → 合成节点 id（若缺）→ 入库 → 切为当前会话。
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
    this.db.updateSessionColumns(meta.id, { title: registered.title })
    importLinesInto(this.db, meta.id, normalized)
    if (lastNodeId) this.db.setSessionLeaf(meta.id, lastNodeId)
    return { ...registered }
  }

  create(projectPath: string, model: string, opts?: { permissionMode?: SessionMeta['permissionMode'] }): SessionMeta {
    const meta: SessionMeta = {
      id: randomUUID(),
      projectPath,
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model,
      leafId: undefined,
      ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {})
    }
    this.db.insertSession(meta)
    this.metas.set(meta.id, meta)
    this.currentId = meta.id
    return { ...meta }
  }

  load(id: string): { meta: SessionMeta; messages: AgentMessage[]; events: AgentEvent[] } {
    const meta = this.metas.get(id)
    if (!meta) throw new Error(`会话不存在：${id}`)
    // 并行会话模型下 load 是纯读取（renderer 自行 hydrate）；currentId 仅剩 json-mode 语义
    const events = this.db.eventsOf(id)
    const nodes = this.readNodes(id)
    const leaf = this.resolveLeaf(meta, nodes)
    const messages = activePathMessages(nodes, leaf, true)
    this.touch(id)
    return { meta: { ...meta }, messages, events }
  }

  // ── 会话树操作 ────────────────────────────────────────────────

  private readNodes(id: string): NodeRec[] {
    return linesToNodes(
      this.db.nodesOf(id).map((r) =>
        r.kind === 'snapshot'
          ? { ts: r.ts, id: r.id, parentId: r.parentId, snapshot: JSON.parse(r.payload) as AgentMessage[] }
          : { ts: r.ts, id: r.id, parentId: r.parentId, message: JSON.parse(r.payload) as AgentMessage }
      )
    )
  }

  private resolveLeaf(meta: SessionMeta, nodes: NodeRec[]): string | null {
    if (nodes.length === 0) return null
    if (meta.leafId && nodes.some((n) => n.id === meta.leafId)) return meta.leafId
    const last = nodes[nodes.length - 1].id
    meta.leafId = last
    this.db.setSessionLeaf(meta.id, last)
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
    // role/nmsgs/txt 为入库派生列，此处免 parse payload
    return this.db.treeRowsOf(id).map((r) => ({
      id: r.id,
      parentId: r.parentId,
      kind: r.kind,
      role: r.role as SessionTreeNode['role'],
      ts: r.ts,
      preview: r.kind === 'snapshot' ? `[压缩快照 · ${r.nmsgs} 条]` : r.txt.slice(0, 80)
    }))
  }

  /** 切换活动叶子：leafId 持久化，返回新活动路径的线性消息 */
  switchLeaf(id: string, nodeId: string): { messages: AgentMessage[] } {
    const meta = this.metas.get(id)
    if (!meta) throw new Error(`会话不存在：${id}`)
    const nodes = this.readNodes(id)
    if (!nodes.some((n) => n.id === nodeId)) throw new Error(`树节点不存在：${nodeId}`)
    meta.leafId = nodeId
    this.db.setSessionLeaf(id, nodeId)
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

  /** 从指定节点派生新会话：祖先链节点行（保留原节点 id）入库并切换为当前会话 */
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
    // 派生来源：会话地图（session-graph）按此连父子边
    meta.forkSourceId = id
    meta.forkNodeId = nodeId
    this.db.tx(() => {
      this.db.updateSessionColumns(created.id, { title: meta.title, forkSourceId: id, forkNodeId: nodeId })
      for (const nid of chain) {
        const n = byId.get(nid)!
        this.db.insertNode(makeNodeRow(created.id, n.id, n.parentId, n.kind, n.messages, n.ts, this.db.allocSeq(created.id)), 'ignore')
      }
      this.db.setSessionLeaf(created.id, nodeId)
    })
    return { ...meta }
  }

  /** 复制当前活动分支为新会话并切换 */
  clone(id: string): SessionMeta {
    const leaf = this.getLeaf(id)
    if (!leaf) throw new Error('会话为空，无从克隆')
    return this.fork(id, leaf)
  }

  /** 事件行入库；message_end 不重复落（节点行已承载完整消息）；turn_end 刷新 updatedAt */
  appendEvent(id: string, e: AgentEvent): void {
    try {
      if (e.type !== 'message_end') this.db.insertEvent(id, this.db.allocSeq(id), Date.now(), e)
      if (e.type === 'turn_end') this.touch(id)
    } catch {
      // 持久化失败不阻塞对话
    }
  }

  /** 追加消息节点；返回节点 id（供事件信封打标，live 消息可定位 rewind/fork） */
  appendMessage(id: string, m: AgentMessage): string {
    return this.appendNode(id, { ts: Date.now(), message: m })
  }

  /** 压缩快照：单个树节点承载替换后的完整消息链 */
  appendSnapshot(id: string, messages: AgentMessage[]): void {
    this.appendNode(id, { ts: Date.now(), snapshot: messages })
  }

  private appendNode(id: string, line: { ts: number; message?: AgentMessage; snapshot?: AgentMessage[] }): string {
    const meta = this.metas.get(id)
    if (!meta) return ''
    const nodeId = randomUUID()
    try {
      const parentId = meta.leafId ?? null
      const seq = this.db.allocSeq(id)
      if (line.message !== undefined) {
        this.db.insertNode(makeNodeRow(id, nodeId, parentId, 'message', [{ ...line.message, nodeId }], line.ts, seq))
      } else {
        this.db.insertNode(makeNodeRow(id, nodeId, parentId, 'snapshot', line.snapshot ?? [], line.ts, seq))
      }
      meta.leafId = nodeId
      this.db.setSessionLeaf(id, nodeId)
    } catch {
      // 持久化失败不阻塞对话
    }
    return nodeId
  }

  ensureTitle(id: string, firstUserText: string): void {
    const meta = this.metas.get(id)
    if (!meta || meta.title !== '新对话') return
    meta.title = firstUserText.slice(0, 40) || '新对话'
    this.db.updateSessionColumns(id, { title: meta.title })
  }

  /** 记录会话工作区（worktree 首次创建成功后落定） */
  setWorktree(id: string, worktreePath: string): void {
    const meta = this.metas.get(id)
    if (!meta) return
    meta.worktreePath = worktreePath
    this.db.updateSessionColumns(id, { worktreePath })
  }

  /** 扩展会话级 K-V：整表快照 UPSERT（last-wins；不参与树/事件重放） */
  appendExtState(id: string, state: Record<string, unknown>): void {
    if (!this.metas.has(id)) return
    try {
      this.db.setExtState(id, state, Date.now())
    } catch {
      // 持久化失败不阻塞扩展
    }
  }

  /** 最近一次扩展状态快照（无则空表）；供 ctx.session 惰性缓存初始化 */
  loadExtState(id: string): Record<string, unknown> {
    try {
      return this.db.getExtState(id) ?? {}
    } catch {
      return {}
    }
  }

  /** 会话权限模式（setSessionMode IPC 落盘 + 运行中实例即时生效） */
  setPermissionMode(id: string, mode: SessionMeta['permissionMode']): void {
    const meta = this.metas.get(id)
    if (!meta) return
    meta.permissionMode = mode
    this.db.updateSessionColumns(id, { permissionMode: mode })
  }

  /** 会话级模型切换（上下文窗口/压缩阈值按该模型的目录定义解析；provider 与归属供应商在下一次 prompt 时按会话解析） */
  setModel(id: string, model: string): SessionMeta | null {
    const meta = this.metas.get(id)
    if (!meta) return null
    const next = String(model ?? '').trim()
    if (!next) return { ...meta }
    meta.model = next
    this.db.updateSessionColumns(id, { model: meta.model })
    return { ...meta }
  }

  /** 重锚会话工作目录：切换 meta.projectPath（文件树/工具/git 经 workspaceOf 即时跟随） */
  setProject(id: string, projectPath: string): SessionMeta | null {
    const meta = this.metas.get(id)
    if (!meta) return null
    const next = String(projectPath ?? '').trim()
    if (!next) return { ...meta }
    meta.projectPath = next
    this.db.updateSessionColumns(id, { projectPath: next })
    return { ...meta }
  }

  /** 重命名会话（手动命名后 ensureTitle 不再覆盖：其只对默认标题生效） */
  rename(id: string, title: string): SessionMeta | null {
    const meta = this.metas.get(id)
    if (!meta) return null
    const next = title.trim()
    if (!next) return { ...meta }
    meta.title = next.slice(0, 80)
    this.db.updateSessionColumns(id, { title: meta.title })
    return { ...meta }
  }

  /** 归档/取消归档 */
  setArchived(id: string, archived: boolean): SessionMeta | null {
    const meta = this.metas.get(id)
    if (!meta) return null
    meta.archived = archived || undefined
    this.db.updateSessionColumns(id, { archived: Boolean(meta.archived) })
    return { ...meta }
  }

  /** 全文检索（LIKE 子串，依赖 nodes.txt 派生列）；结果按会话元数据补全标题 */
  search(text: string, sessionIds: string[] | null = null, limit = 50): SessionSearchHit[] {
    if (typeof text !== 'string' || text.trim().length === 0) return []
    try {
      const hits = this.db.search(text, sessionIds, limit)
      const out: SessionSearchHit[] = []
      for (const h of hits) {
        const meta = this.metas.get(h.sessionId)
        if (!meta) continue
        out.push({ sessionId: h.sessionId, nodeId: h.nodeId, title: meta.title, updatedAt: meta.updatedAt, snippet: h.snippet })
      }
      return out
    } catch {
      return []
    }
  }

  private touch(id: string): void {
    const meta = this.metas.get(id)
    if (!meta) return
    meta.updatedAt = Date.now()
    this.db.touchSession(id, meta.updatedAt)
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
function activePathMessages(nodes: NodeRec[], leafId: string | null, stamp = false): AgentMessage[] {
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
    // stamp=false 时剥离 nodeId（历史比较/续跑语义保持纯净）；stamp=true 供 renderer 定位
    const msgs = n.messages.map((m) => {
      if (stamp) return { ...m, nodeId: n.id }
      const { nodeId: _drop, ...rest } = m as AgentMessage & { nodeId?: string }
      return rest as AgentMessage
    })
    out.push(...msgs)
  }
  return out
}

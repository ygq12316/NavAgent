import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { AgentEvent, AgentMessage, SessionMeta } from '@shared/types'
import { messageText } from '@shared/types'

/** JSONL 交换格式行（导入/导出/旧布局迁移共用）；extState 行仅存在于旧布局文件 */
export interface JsonlLine {
  ts: number
  /** 树节点 id（只有 message/snapshot 行是节点） */
  id?: string
  parentId?: string | null
  event?: AgentEvent
  message?: AgentMessage
  /** 压缩后的完整消息快照：路径重建时遇到即清空此前累积 */
  snapshot?: AgentMessage[]
  /** 旧布局专属：扩展状态整表快照行（迁移时并入 ext_state 表） */
  extState?: Record<string, unknown>
}

export interface SearchHit {
  sessionId: string
  nodeId: string
  ts: number
  snippet: string
}

export interface NodeInsert {
  sessionId: string
  id: string
  parentId: string | null
  kind: 'message' | 'snapshot'
  payload: string
  role: string
  nmsgs: number
  txt: string
  ts: number
  seq: number
}

/** 搜索提取文本的截断上限（消息全文很长时只索引前 64KB） */
const TXT_CAP = 64_000

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  leaf_id TEXT,
  permission_mode TEXT,
  worktree_path TEXT,
  fork_source_id TEXT,
  fork_node_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_proj ON sessions(project_path, updated_at DESC);
CREATE TABLE IF NOT EXISTS nodes (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message','snapshot')),
  payload TEXT NOT NULL,
  role TEXT NOT NULL,
  nmsgs INTEGER NOT NULL DEFAULT 1,
  txt TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_nodes_seq ON nodes(session_id, seq);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ext_state (
  session_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT);
`

/** 旧版本持久化兼容：assistant content 曾是纯字符串，加载时升级为单个 text 块。幂等。 */
export function normalizeMessage(m: AgentMessage): AgentMessage {
  if (m.role === 'assistant' && typeof (m.content as unknown) === 'string') {
    return { ...m, content: [{ type: 'text', text: m.content as unknown as string }] }
  }
  return m
}

/** 节点行装配（append/fork/import 共用）：payload 与 role/nmsgs/txt 派生列同源生成 */
export function makeNodeRow(
  sessionId: string,
  id: string,
  parentId: string | null,
  kind: 'message' | 'snapshot',
  messages: AgentMessage[],
  ts: number,
  seq: number
): NodeInsert {
  if (kind === 'snapshot') {
    const txt = messages.map((m) => messageText(m)).filter(Boolean).join('\n').slice(0, TXT_CAP)
    return { sessionId, id, parentId, kind, payload: JSON.stringify(messages), role: 'snapshot', nmsgs: messages.length, txt, ts, seq }
  }
  const m = messages[0]!
  return { sessionId, id, parentId, kind, payload: JSON.stringify(m), role: m.role, nmsgs: 1, txt: messageText(m).slice(0, TXT_CAP), ts, seq }
}

/**
 * 会话权威存储（node:sqlite，单库 userData/sessions.db，WAL）。
 * 单写者由 main 单进程保证，不做跨进程锁（对齐 pi 的 sqlite-node 后端豁免）。
 * seq 为会话内单调行号，nodes/events 共用一个计数器——保持与旧 JSONL 行序等价的交错关系。
 */
export class SessionDb {
  private db: DatabaseSync
  private stmts = new Map<string, StatementSync>()
  private seqs = new Map<string, number>()

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(DDL)
    // 轻量列迁移：老库缺新列时补齐（duplicate column 报错即已有，吞掉）
    for (const col of ['fork_source_id', 'fork_node_id']) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`)
      } catch {
        /* 列已存在 */
      }
    }
    this.restoreSeqs()
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 已不在事务中
      }
      throw err
    }
  }

  // ── seq（nodes/events 共用计数器） ───────────────────────────

  allocSeq(sessionId: string): number {
    const next = (this.seqs.get(sessionId) ?? 0) + 1
    this.seqs.set(sessionId, next)
    return next
  }

  private restoreSeqs(): void {
    const q = (table: 'nodes' | 'events') =>
      this.stmt(`SELECT session_id, MAX(seq) AS m FROM ${table} GROUP BY session_id`).all() as {
        session_id: string
        m: number
      }[]
    for (const r of [...q('nodes'), ...q('events')]) {
      this.seqs.set(r.session_id, Math.max(this.seqs.get(r.session_id) ?? 0, Number(r.m)))
    }
  }

  // ── sessions ────────────────────────────────────────────────

  allSessions(): SessionMeta[] {
    const rows = this.stmt('SELECT * FROM sessions').all() as Record<string, unknown>[]
    return rows.map(rowToMeta)
  }

  insertSession(meta: SessionMeta, mode: 'strict' | 'ignore' = 'strict'): void {
    const sql =
      mode === 'ignore'
        ? 'INSERT OR IGNORE INTO sessions(id,project_path,title,model,created_at,updated_at,leaf_id,permission_mode,worktree_path,archived) VALUES(?,?,?,?,?,?,?,?,?,?)'
        : 'INSERT INTO sessions(id,project_path,title,model,created_at,updated_at,leaf_id,permission_mode,worktree_path,archived) VALUES(?,?,?,?,?,?,?,?,?,?)'
    this.stmt(sql).run(
      meta.id,
      meta.projectPath,
      meta.title,
      meta.model,
      meta.createdAt,
      meta.updatedAt,
      meta.leafId ?? null,
      meta.permissionMode ?? null,
      meta.worktreePath ?? null,
      meta.archived ? 1 : 0
    )
  }

  updateSessionColumns(
    id: string,
    patch: Partial<{ title: string; model: string; projectPath: string; permissionMode: SessionMeta['permissionMode']; worktreePath: string; archived: boolean; forkSourceId: string | null; forkNodeId: string | null }>
  ): void {
    const COLS: Record<string, string> = {
      title: 'title',
      model: 'model',
      projectPath: 'project_path',
      permissionMode: 'permission_mode',
      worktreePath: 'worktree_path',
      archived: 'archived',
      forkSourceId: 'fork_source_id',
      forkNodeId: 'fork_node_id'
    }
    const keys = Object.keys(patch).filter((k) => COLS[k] !== undefined && (patch as Record<string, unknown>)[k] !== undefined)
    if (keys.length === 0) return
    const set = keys.map((k) => `${COLS[k]} = ?`).join(', ')
    const params: unknown[] = keys.map((k) => {
      const v = (patch as Record<string, string | boolean | null | undefined>)[k]
      return k === 'archived' ? (v ? 1 : 0) : (v as string | null)
    })
    // run 的绑定参数类型不含 null 的字面窄化，这里收口为 unknown 展开传递
    this.stmt(`UPDATE sessions SET ${set} WHERE id = ?`).run(...(params as string[]), id)
  }

  setSessionLeaf(id: string, leafId: string | null): void {
    this.stmt('UPDATE sessions SET leaf_id = ? WHERE id = ?').run(leafId, id)
  }

  touchSession(id: string, updatedAt: number): void {
    this.stmt('UPDATE sessions SET updated_at = ? WHERE id = ?').run(updatedAt, id)
  }

  /** 删除一个会话的全部行（单事务）；会话无行时静默成功 */
  deleteSessionAll(id: string): void {
    this.tx(() => {
      this.stmt('DELETE FROM nodes WHERE session_id = ?').run(id)
      this.stmt('DELETE FROM events WHERE session_id = ?').run(id)
      this.stmt('DELETE FROM ext_state WHERE session_id = ?').run(id)
      this.stmt('DELETE FROM sessions WHERE id = ?').run(id)
    })
  }

  // ── nodes ───────────────────────────────────────────────────

  insertNode(row: NodeInsert, mode: 'strict' | 'ignore' = 'strict'): void {
    const cols = 'VALUES(?,?,?,?,?,?,?,?,?,?)'
    const sql =
      mode === 'ignore'
        ? `INSERT OR IGNORE INTO nodes(session_id,id,parent_id,kind,payload,role,nmsgs,txt,ts,seq) ${cols}`
        : `INSERT INTO nodes(session_id,id,parent_id,kind,payload,role,nmsgs,txt,ts,seq) ${cols}`
    this.stmt(sql).run(row.sessionId, row.id, row.parentId, row.kind, row.payload, row.role, row.nmsgs, row.txt, row.ts, row.seq)
  }

  hasNode(sessionId: string, nodeId: string): boolean {
    return this.stmt('SELECT 1 FROM nodes WHERE session_id = ? AND id = ?').get(sessionId, nodeId) !== undefined
  }

  /** 全量节点行（按 seq = 写入顺序） */
  nodesOf(sessionId: string): { id: string; parentId: string | null; kind: 'message' | 'snapshot'; payload: string; ts: number }[] {
    return (
      this.stmt('SELECT id, parent_id, kind, payload, ts FROM nodes WHERE session_id = ? ORDER BY seq').all(sessionId) as {
        id: string
        parent_id: string | null
        kind: string
        payload: string
        ts: number
      }[]
    ).map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      kind: r.kind as 'message' | 'snapshot',
      payload: r.payload,
      ts: Number(r.ts)
    }))
  }

  /** 树视图行（免 parse payload：role/nmsgs/txt 为派生列） */
  treeRowsOf(sessionId: string): { id: string; parentId: string | null; kind: 'message' | 'snapshot'; role: string; nmsgs: number; txt: string; ts: number }[] {
    return (
      this.stmt('SELECT id, parent_id, kind, role, nmsgs, txt, ts FROM nodes WHERE session_id = ? ORDER BY seq').all(sessionId) as {
        id: string
        parent_id: string | null
        kind: string
        role: string
        nmsgs: number
        txt: string
        ts: number
      }[]
    ).map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      kind: r.kind as 'message' | 'snapshot',
      role: r.role,
      nmsgs: Number(r.nmsgs),
      txt: r.txt,
      ts: Number(r.ts)
    }))
  }

  // ── events ──────────────────────────────────────────────────

  insertEvent(sessionId: string, seq: number, ts: number, event: AgentEvent, mode: 'strict' | 'ignore' = 'strict'): void {
    const sql =
      mode === 'ignore'
        ? 'INSERT OR IGNORE INTO events(session_id,seq,ts,event) VALUES(?,?,?,?)'
        : 'INSERT INTO events(session_id,seq,ts,event) VALUES(?,?,?,?)'
    this.stmt(sql).run(sessionId, seq, ts, JSON.stringify(event))
  }

  eventsOf(sessionId: string): AgentEvent[] {
    return (this.stmt('SELECT event FROM events WHERE session_id = ? ORDER BY seq').all(sessionId) as { event: string }[]).map(
      (r) => JSON.parse(r.event) as AgentEvent
    )
  }

  // ── ext_state（扩展会话级 K-V，整表快照 last-wins） ──────────

  getExtState(sessionId: string): Record<string, unknown> | null {
    const r = this.stmt('SELECT state FROM ext_state WHERE session_id = ?').get(sessionId) as { state: string } | undefined
    if (!r) return null
    try {
      const parsed = JSON.parse(r.state) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  setExtState(sessionId: string, state: Record<string, unknown>, ts: number): void {
    this.stmt(
      'INSERT INTO ext_state(session_id,state,ts) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, ts = excluded.ts'
    ).run(sessionId, JSON.stringify(state), ts)
  }

  // ── store_meta（内部标记） ──────────────────────────────────

  getFlag(key: string): string | null {
    const r = this.stmt('SELECT value FROM store_meta WHERE key = ?').get(key) as { value: string } | undefined
    return r?.value ?? null
  }

  setFlag(key: string, value: string): void {
    this.stmt('INSERT INTO store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ── 搜索 / 导出 ─────────────────────────────────────────────

  /** LIKE 子串全文检索（%/_/\ 转义；对中文友好）；sessionIds 空数组/null = 全部会话 */
  search(text: string, sessionIds: string[] | null, limit = 50): SearchHit[] {
    const q = '%' + text.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    const filtered = Array.isArray(sessionIds) && sessionIds.length > 0
    const rows = filtered
      ? (this.stmt(
          `SELECT session_id, id, ts, txt FROM nodes WHERE txt LIKE ? ESCAPE '\\' AND session_id IN (${sessionIds!.map(() => '?').join(',')}) ORDER BY ts DESC, seq DESC LIMIT ?`
        ).all(q, ...sessionIds!, limit) as { session_id: string; id: string; ts: number; txt: string }[])
      : (this.stmt(`SELECT session_id, id, ts, txt FROM nodes WHERE txt LIKE ? ESCAPE '\\' ORDER BY ts DESC, seq DESC LIMIT ?`).all(q, limit) as {
          session_id: string
          id: string
          ts: number
          txt: string
        }[])
    return rows.map((r) => ({ sessionId: r.session_id, nodeId: r.id, ts: Number(r.ts), snippet: r.txt.slice(0, 200) }))
  }

  /** 序列化为旧格式 JSONL 字符串（与 importFrom 互逆；nodes/events 按 seq 归并保持原始交错） */
  exportJsonl(sessionId: string): string {
    const nodeRows = this.stmt('SELECT id, parent_id, kind, payload, ts, seq FROM nodes WHERE session_id = ? ORDER BY seq').all(sessionId) as {
      id: string
      parent_id: string | null
      kind: string
      payload: string
      ts: number
      seq: number
    }[]
    const eventRows = this.stmt('SELECT seq, ts, event FROM events WHERE session_id = ? ORDER BY seq').all(sessionId) as {
      seq: number
      ts: number
      event: string
    }[]
    const merged: { seq: number; line: JsonlLine }[] = []
    for (const r of nodeRows) {
      const base = { ts: Number(r.ts), id: r.id, parentId: r.parent_id }
      merged.push(
        r.kind === 'snapshot'
          ? { seq: Number(r.seq), line: { ...base, snapshot: JSON.parse(r.payload) as AgentMessage[] } }
          : { seq: Number(r.seq), line: { ...base, message: JSON.parse(r.payload) as AgentMessage } }
      )
    }
    for (const r of eventRows) {
      merged.push({ seq: Number(r.seq), line: { ts: Number(r.ts), event: JSON.parse(r.event) as AgentEvent } })
    }
    merged.sort((a, b) => a.seq - b.seq)
    return merged.map((m) => JSON.stringify(m.line)).join('\n') + (merged.length > 0 ? '\n' : '')
  }
}

function rowToMeta(r: Record<string, unknown>): SessionMeta {
  const meta: SessionMeta = {
    id: String(r.id),
    projectPath: String(r.project_path ?? ''),
    title: String(r.title ?? ''),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    model: String(r.model ?? '')
  }
  if (r.leaf_id) meta.leafId = String(r.leaf_id)
  if (r.worktree_path) meta.worktreePath = String(r.worktree_path)
  if (r.permission_mode) meta.permissionMode = String(r.permission_mode) as SessionMeta['permissionMode']
  if (r.fork_source_id) meta.forkSourceId = String(r.fork_source_id)
  if (r.fork_node_id) meta.forkNodeId = String(r.fork_node_id)
  if (Number(r.archived)) meta.archived = true
  return meta
}

/**
 * 行序列（节点/事件混排）→ 事务入库；缺 id 的节点行在内存合成线性链（叶子=最后节点）。
 * INSERT OR IGNORE 保证续导幂等；返回最后一个节点 id（供 leafId 兜底）。
 */
export function importLinesInto(db: SessionDb, sessionId: string, lines: JsonlLine[]): { lastNodeId: string | null } {
  let prev: string | null = null
  let lastNodeId: string | null = null
  db.tx(() => {
    for (const l of lines) {
      const ts = typeof l.ts === 'number' ? l.ts : 0
      if (l.message !== undefined || l.snapshot !== undefined) {
        const nodeId = l.id ?? randomUUID()
        const parentId = l.parentId ?? prev
        const seq = db.allocSeq(sessionId)
        if (l.snapshot !== undefined) {
          const arr = (Array.isArray(l.snapshot) ? l.snapshot : []).map(normalizeMessage)
          db.insertNode(makeNodeRow(sessionId, nodeId, parentId, 'snapshot', arr, ts, seq), 'ignore')
        } else {
          db.insertNode(makeNodeRow(sessionId, nodeId, parentId, 'message', [normalizeMessage(l.message!)], ts, seq), 'ignore')
        }
        prev = nodeId
        lastNodeId = nodeId
      } else if (l.event !== undefined) {
        db.insertEvent(sessionId, db.allocSeq(sessionId), ts, l.event, 'ignore')
      }
    }
  })
  return { lastNodeId }
}

function readLegacyMeta(file: string): SessionMeta | null {
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SessionMeta>
  if (!raw || typeof raw.id !== 'string') return null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Date.now())
  return {
    id: raw.id,
    projectPath: typeof raw.projectPath === 'string' ? raw.projectPath : '',
    title: typeof raw.title === 'string' ? raw.title : '新对话',
    createdAt: num(raw.createdAt),
    updatedAt: num(raw.updatedAt),
    model: typeof raw.model === 'string' ? raw.model : '',
    ...(raw.leafId ? { leafId: raw.leafId } : {}),
    ...(raw.worktreePath ? { worktreePath: raw.worktreePath } : {}),
    ...(raw.permissionMode ? { permissionMode: raw.permissionMode } : {}),
    ...(raw.archived ? { archived: true } : {})
  }
}

/**
 * 旧布局（userData/sessions/<projectKey>/{<id>.jsonl,<id>.meta.json}）一次性迁移：
 * 先把整个目录原子改名为备份目录锁定起点（中断后下次启动从备份续导，绝不删除备份），
 * 再逐会话导入（OR IGNORE 幂等）；单个会话损坏只跳过不阻塞。
 */
export function migrateLegacyLayout(userDataPath: string, db: SessionDb): void {
  const legacyRoot = join(userDataPath, 'sessions')
  if (!existsSync(legacyRoot)) return
  const backup = join(userDataPath, `sessions-legacy-backup-${Date.now()}`)
  try {
    renameSync(legacyRoot, backup)
  } catch (err) {
    console.error('[session-db] 旧会话目录改名失败，跳过迁移', err)
    return
  }
  let projectDirs: string[] = []
  try {
    projectDirs = readdirSync(backup, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(backup, d.name))
  } catch {
    return
  }
  for (const dir of projectDirs) {
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.meta.json'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const meta = readLegacyMeta(join(dir, f))
        if (!meta) continue
        const jsonlPath = join(dir, f.slice(0, -'.meta.json'.length) + '.jsonl')
        const lines: JsonlLine[] = existsSync(jsonlPath)
          ? (readFileSync(jsonlPath, 'utf-8')
              .split('\n')
              .filter((l) => l.trim().length > 0)
              .map((l) => JSON.parse(l) as JsonlLine))
          : []
        db.insertSession(meta, 'ignore')
        const { lastNodeId } = importLinesInto(db, meta.id, lines)
        let ext: Record<string, unknown> | null = null
        for (const l of lines) {
          if (l.extState && typeof l.extState === 'object' && l.extState !== null) ext = l.extState
        }
        if (ext) db.setExtState(meta.id, ext, meta.updatedAt)
        // meta 记录的叶子已入库则沿用；否则（旧格式缺 id）兜底到最后节点
        if (meta.leafId && db.hasNode(meta.id, meta.leafId)) continue
        if (lastNodeId) db.setSessionLeaf(meta.id, lastNodeId)
      } catch (err) {
        console.error('[session-db] 迁移会话失败（已跳过）', err)
      }
    }
  }
  db.setFlag('legacy_done', String(Date.now()))
}

import { execFile } from 'node:child_process'
import type { DiffFileEntry, DiffResult, DiffSummary, FileReadResult } from '@shared/types'
import { lineDiff, diffStat } from '../tools/diff'
import { isGitRepo } from './worktree'

/**
 * 会话 Diff 服务（对齐 Claude Code 桌面端的 diff 视图数据面）：
 * - git 仓库（含 worktree 会话）：git status + git diff HEAD——天然覆盖 bash 造成的改动
 * - 非 git 项目：引擎 beforeToolCall/afterToolCall 钩子抓写类工具的执行前后内容（首次基线保留），
 *   用手写 lineDiff 计算
 * 全链路永不 throw：git/读文件失败编码为空结果。
 */

interface PendingCapture {
  sessionId: string
  path: string
  beforeP: Promise<string | null>
}

function git(args: string[], cwd: string, timeoutMs = 20_000): Promise<{ ok: true; stdout: string } | { ok: false }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? { ok: false } : { ok: true, stdout: String(stdout) })
    )
  })
}

const MAX_FILES = 200
const WORKTREE_NOISE = '.claude/worktrees/'

export class DiffService {
  private pending = new Map<string, PendingCapture>()
  /** sessionId → relPath → 首次基线/最新内容 */
  private logs = new Map<string, Map<string, { before: string | null; after: string | null }>>()

  constructor(
    private workspaceOf: (sessionId: string) => string,
    private read: (ws: string, rel: string) => Promise<FileReadResult>
  ) {}

  /** 引擎 beforeToolCall 钩子（在权限放行后、执行前调用）：写类工具抓基线内容 */
  before(sessionId: string, toolName: string, toolCallId: string, args: Record<string, unknown>): void {
    if (toolName !== 'write_file' && toolName !== 'edit_file') return
    const rel = typeof args.path === 'string' ? args.path : ''
    if (!rel) return
    const ws = this.workspaceOf(sessionId)
    const beforeP: Promise<string | null> = ws
      ? this.read(ws, rel).then((r) => (r.ok ? r.content : null)).catch(() => null)
      : Promise.resolve(null)
    this.pending.set(toolCallId, { sessionId, path: rel, beforeP })
  }

  /** 引擎 afterToolCall 钩子：执行成功后抓结果内容（同一文件保留首次基线 → 累计 diff） */
  after(sessionId: string, toolName: string, toolCallId: string, isError: boolean): void {
    void sessionId
    void toolName
    const p = this.pending.get(toolCallId)
    this.pending.delete(toolCallId)
    if (!p || isError) return
    void p.beforeP.then((before) => this.record(p.sessionId, p.path, before))
  }

  private async record(sessionId: string, rel: string, before: string | null): Promise<void> {
    const ws = this.workspaceOf(sessionId)
    if (!ws) return
    const r = await this.read(ws, rel).catch(() => null)
    const after = r && r.ok ? r.content : null
    const log = this.logs.get(sessionId) ?? new Map<string, { before: string | null; after: string | null }>()
    const prev = log.get(rel)
    log.set(rel, { before: prev ? prev.before : before, after })
    this.logs.set(sessionId, log)
  }

  clear(sessionId: string): void {
    this.logs.delete(sessionId)
  }

  async get(sessionId: string): Promise<DiffResult> {
    const ws = this.workspaceOf(sessionId)
    if (!ws) return { source: 'session', files: [] }
    if (await isGitRepo(ws)) {
      const gitFiles = await this.gitDiff(ws)
      if (gitFiles !== null) return { source: 'git', files: gitFiles }
    }
    return this.sessionDiff(sessionId)
  }

  async summary(sessionId: string): Promise<DiffSummary | null> {
    const r = await this.get(sessionId)
    if (r.files.length === 0) return null
    return r.files.reduce<DiffSummary>(
      (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions, files: acc.files + 1 }),
      { additions: 0, deletions: 0, files: 0 }
    )
  }

  /** git 状态解析（porcelain 两列码）；整体失败返回 null 让调用方回落 session 日志 */
  private async gitDiff(ws: string): Promise<DiffFileEntry[] | null> {
    const st = await git(['status', '--porcelain'], ws)
    if (!st.ok) return null
    const files: DiffFileEntry[] = []
    for (const line of st.stdout.split('\n')) {
      if (line.length < 4) continue
      const code = line.slice(0, 2)
      let rel = line.slice(3).trim()
      if (rel.includes(' -> ')) rel = rel.split(' -> ')[1] ?? rel
      if (!rel || rel.startsWith(WORKTREE_NOISE)) continue
      if (files.length >= MAX_FILES) break

      if (code === '??') {
        const r = await this.read(ws, rel).catch(() => null)
        const content = r && r.ok ? r.content : ''
        const diff = lineDiff('', content, rel)
        const { add, del } = diffStat(diff)
        files.push({ path: rel, status: 'added', additions: add, deletions: del, diff })
        continue
      }
      const d = await git(['diff', 'HEAD', '--', rel], ws)
      if (!d.ok) continue
      const diff = d.stdout
      if (diff.trim().length === 0) continue
      const { add, del } = diffStat(diff)
      files.push({
        path: rel,
        status: code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : 'modified',
        additions: add,
        deletions: del,
        diff
      })
    }
    return files
  }

  private sessionDiff(sessionId: string): DiffResult {
    const log = this.logs.get(sessionId)
    if (!log || log.size === 0) return { source: 'session', files: [] }
    const files: DiffFileEntry[] = []
    for (const [rel, { before, after }] of log) {
      if (files.length >= MAX_FILES) break
      const diff = lineDiff(before ?? '', after ?? '', rel)
      const { add, del } = diffStat(diff)
      files.push({
        path: rel,
        status: before === null ? 'added' : after === null ? 'deleted' : 'modified',
        additions: add,
        deletions: del,
        diff
      })
    }
    return { source: 'session', files }
  }
}

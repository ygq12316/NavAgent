import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * git worktree 隔离（对齐 Claude Code 桌面端的并行会话模型）：
 * git 仓库的会话首次运行时落在 <root>/.claude/worktrees/<短码> 的独立工作树，
 * 分支 navagent/<短码>；非 git 项目回退原地运行。所有操作永不 throw，失败编码进返回值。
 */

interface GitOk {
  ok: true
  stdout: string
}
interface GitErr {
  ok: false
  error: string
}

function git(args: string[], cwd: string, timeoutMs = 20_000): Promise<GitOk | GitErr> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) resolve({ ok: false, error: err.message })
        else resolve({ ok: true, stdout: String(stdout) })
      }
    )
  })
}

export function shortIdOf(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 8) || 'session'
}

export function worktreePathOf(projectRoot: string, sessionId: string): string {
  return join(projectRoot, '.claude', 'worktrees', shortIdOf(sessionId))
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  if (!cwd) return false
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd)
  return r.ok && r.stdout.trim() === 'true'
}

/** Windows 路径归一：git worktree list 输出正斜杠，与 join 的反斜杠路径比较前统一（大小写不敏感） */
function normPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/[\\/]+/g, '\\').toLowerCase() : p
}

/** 该会话的 worktree 是否已在注册表中（崩溃恢复：直接复用） */
async function worktreeRegistered(projectRoot: string, wtPath: string): Promise<boolean> {
  const r = await git(['worktree', 'list', '--porcelain'], projectRoot)
  if (!r.ok) return false
  const target = normPath(wtPath)
  return r.stdout.split('\n').some((l) => l.startsWith('worktree ') && normPath(l.slice('worktree '.length).trim()) === target)
}

export type WorktreeResult =
  | { ok: true; path: string; branch: string }
  | { ok: false; error: string }

/** 幂等创建：已注册则复用；分支已存在则直接挂到该分支；其余失败返回 error */
export async function ensureWorktree(projectRoot: string, sessionId: string): Promise<WorktreeResult> {
  if (!projectRoot) return { ok: false, error: '无项目目录' }
  const wtPath = worktreePathOf(projectRoot, sessionId)
  const branch = `navagent/${shortIdOf(sessionId)}`
  if (await worktreeRegistered(projectRoot, wtPath)) return { ok: true, path: wtPath, branch }
  try {
    mkdirSync(join(projectRoot, '.claude', 'worktrees'), { recursive: true })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const add = await git(['worktree', 'add', '-b', branch, wtPath], projectRoot)
  if (add.ok) return { ok: true, path: wtPath, branch }
  // 分支已存在（上次会话残留）：挂到既有分支
  const attach = await git(['worktree', 'add', wtPath, branch], projectRoot)
  if (attach.ok) return { ok: true, path: wtPath, branch }
  return { ok: false, error: attach.error }
}

/** 删除会话时回收 worktree（--force：不关心未提交改动，会话即其隔离副本）；分支清理尽力而为 */
export async function removeWorktree(projectRoot: string, sessionId: string): Promise<void> {
  const wtPath = worktreePathOf(projectRoot, sessionId)
  await git(['worktree', 'remove', '--force', wtPath], projectRoot)
  await git(['branch', '-D', `navagent/${shortIdOf(sessionId)}`], projectRoot)
}

// src/renderer/src/components/GitPanel.tsx
/** Git 源代码管理面板（VS Code 式，落在会话管理侧栏）：
 *  当前分支 + 分支下拉切换 + 按「已暂存/工作区更改/未跟踪」分组的改动文件清单（点击打开 diff）。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitFile, GitFileStatus, GitStatusResult } from '@shared/types'
import { getApi } from '../api'
import { IconBranch, IconCheck, IconChevronDown, IconRefresh } from './icons'

interface Props {
  /** 焦点会话 id（git 作用域 = 该会话工作区；空则回落项目工作区） */
  sessionId: string
  /** 点击改动文件 → 打开该文件 diff */
  onOpenDiff: (path: string) => void
}

const STATUS_META: Record<GitFileStatus, { letter: string; cls: string }> = {
  modified: { letter: 'M', cls: 'st-mod' },
  added: { letter: 'A', cls: 'st-add' },
  deleted: { letter: 'D', cls: 'st-del' },
  renamed: { letter: 'R', cls: 'st-ren' },
  conflicted: { letter: 'U', cls: 'st-con' },
  untracked: { letter: '?', cls: 'st-untracked' }
}

function FileRow({ file, onOpenDiff }: { file: GitFile; onOpenDiff: (p: string) => void }) {
  const { letter, cls } = STATUS_META[file.status]
  return (
    <button
      className="git-file"
      title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
      onClick={() => onOpenDiff(file.path)}
    >
      <span className={`git-file-status mono ${cls}`}>{letter}</span>
      <span className="git-file-path mono">{file.path}</span>
    </button>
  )
}

function Group({ label, files, onOpenDiff }: { label: string; files: GitFile[]; onOpenDiff: (p: string) => void }) {
  return (
    <div className="git-group">
      <div className="git-group-label">
        <span>{label}</span>
        <span className="git-group-count mono">{files.length}</span>
      </div>
      <div className="git-group-files">
        {files.map((f) => (
          <FileRow key={f.path} file={f} onOpenDiff={onOpenDiff} />
        ))}
      </div>
    </div>
  )
}

export function GitPanel({ sessionId, onOpenDiff }: Props) {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [s, b] = await Promise.all([getApi().gitStatus(sessionId), getApi().gitBranches(sessionId)])
      setStatus(s)
      setBranches(b.branches)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    setStatus(null)
    setError(null)
    void refresh()
  }, [refresh])

  // 分支下拉外点关闭
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setBranchMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const openBranchMenu = async (): Promise<void> => {
    setBranchMenuOpen((v) => !v)
    if (branches.length === 0) {
      const b = await getApi().gitBranches(sessionId)
      setBranches(b.branches)
    }
  }

  const switchBranch = async (branch: string): Promise<void> => {
    if (switching || branch === status?.current) {
      setBranchMenuOpen(false)
      return
    }
    setSwitching(true)
    setError(null)
    const r = await getApi().gitSwitch(sessionId, branch)
    setSwitching(false)
    setBranchMenuOpen(false)
    if (!r.ok) {
      setError(r.message ?? '切换失败')
      return
    }
    await refresh()
  }

  const total = (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0)

  return (
    <div className="git-panel">
      <div className="git-panel-head">
        <span className="git-panel-title">Git 源代码管理</span>
        <button className="win-btn" title="刷新" onClick={() => void refresh()} disabled={loading}>
          <IconRefresh size={13} />
        </button>
      </div>

      <div ref={menuRef} className="chip-anchor git-branch-anchor">
        <button className="git-panel-branch" onClick={() => void openBranchMenu()} title="切换分支">
          <IconBranch size={13} />
          <span className="git-panel-branch-name mono">{status?.current ?? '…'}</span>
          <IconChevronDown size={9} className="chip-caret" />
        </button>
        {branchMenuOpen && (
          <div className="git-pop git-branch-menu">
            {branches.length > 0 ? (
              branches.map((b) => (
                <button
                  key={b}
                  className={`git-branch-row${b === status?.current ? ' on' : ''}${switching ? ' disabled' : ''}`}
                  title={b}
                  onClick={() => void switchBranch(b)}
                >
                  <span className="mono">{b}</span>
                  {b === status?.current && <IconCheck size={11} className="check" />}
                </button>
              ))
            ) : (
              <div className="git-empty">（非 git 仓库，无分支）</div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="git-error" title={error}>
          {error}
        </div>
      )}

      <div className="git-panel-body">
        {loading && !status ? (
          <div className="git-hint">加载中…</div>
        ) : status && status.current === null ? (
          <div className="git-hint">（非 git 仓库，无分支信息）</div>
        ) : total === 0 ? (
          <div className="git-hint">工作区干净</div>
        ) : (
          <>
            {status!.staged.length > 0 && <Group label="已暂存" files={status!.staged} onOpenDiff={onOpenDiff} />}
            {status!.unstaged.length > 0 && <Group label="工作区更改" files={status!.unstaged} onOpenDiff={onOpenDiff} />}
            {status!.untracked.length > 0 && <Group label="未跟踪" files={status!.untracked} onOpenDiff={onOpenDiff} />}
          </>
        )}
      </div>
    </div>
  )
}

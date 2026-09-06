import { useEffect, useRef, useState } from 'react'
import { IconFolder, IconFolderOpen } from './icons'

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

interface Props {
  /** 当前会话的工作目录（文件树/工具/git 的作用域） */
  project: string
  recentProjects: string[]
  onSwitch: (path: string) => void
  /** 系统选框取路径（返回 null = 取消）；取到后由本组件继续 onSwitch */
  onPick: () => Promise<string | null>
}

/** 项目选择下拉（聊天窗头部左上角：当前会话的工作目录，切换后文件树/工具即时跟随） */
export function ProjectSelect({ project, recentProjects, onSwitch, onPick }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const pickAndSwitch = async (): Promise<void> => {
    setOpen(false)
    const p = await onPick()
    if (p && p !== project) onSwitch(p)
  }

  return (
    <div className="project-select" ref={ref}>
      <button className="project-btn" onClick={() => setOpen((v) => !v)} title="当前会话的工作目录（文件树/工具/git 的作用域；切换即时生效）">
        <IconFolderOpen size={13} />
        <span className="project-name">{baseName(project)}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="dropdown raised">
          {recentProjects.map((p) => (
            <button
              key={p}
              className={`dropdown-item ${p === project ? 'active' : ''}`}
              onClick={() => {
                setOpen(false)
                if (p !== project) onSwitch(p)
              }}
              title={p}
            >
              <IconFolder size={13} />
              <span className="dropdown-name">{baseName(p)}</span>
              <span className="dropdown-path">{p}</span>
            </button>
          ))}
          <button
            className="dropdown-item"
            onClick={() => void pickAndSwitch()}
          >
            <span>＋</span>
            <span className="dropdown-name">选择文件夹…</span>
          </button>
        </div>
      )}
    </div>
  )
}

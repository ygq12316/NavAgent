import { useEffect, useRef, useState } from 'react'
import type { SessionMeta } from '@shared/types'
import { IconChevronDown, IconChevronRight, IconDots, IconFolderOpen } from './icons'

interface Props {
  /** 项目路径 → 该项目下的会话列表（含已归档，按 meta.archived 区分） */
  sessionsByProject: Record<string, SessionMeta[]>
  /** 项目顺序（当前项目在前） */
  projects: string[]
  /** 当前项目（新会话落点，高亮标记） */
  activeProject: string
  /** 各 pane 当前打开的会话（高亮） */
  activeIds: string[]
  /** 运行中的会话 id（侧栏运行指示） */
  workingIds: Set<string>
  onNew: () => void
  /** 点击 = 焦点栏打开；Ctrl+点击 = 第二栏并排（对齐 CC 桌面端） */
  onOpen: (id: string, side: 'left' | 'right') => void
  onDelete: (id: string) => void
  onExport: (id: string) => void
  /** 重命名会话（Enter/失焦提交） */
  onRename: (id: string, title: string) => void
  /** 归档 / 取消归档 */
  onArchive: (id: string, archived: boolean) => void
}

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

export function RailSessions(p: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; title: string; archived: boolean } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [archOpen, setArchOpen] = useState(false)
  /** 行内重命名态：id + 当前输入值 */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // 进入重命名即聚焦全选
  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus()
      renameRef.current?.select()
    }
  }, [renaming?.id])

  const commitRename = (): void => {
    if (renaming && renaming.value.trim()) p.onRename(renaming.id, renaming.value)
    setRenaming(null)
  }

  const item = (s: SessionMeta, archived = false) => {
    const active = p.activeIds.includes(s.id)
    const running = p.workingIds.has(s.id)
    const isRenaming = renaming?.id === s.id
    return (
      <div key={s.id} className={`session-entry${active ? ' active' : ''}${archived ? ' archived' : ''}`}>
        {isRenaming ? (
          <div className="session-item renaming">
            <input
              ref={renameRef}
              className="session-rename-input"
              value={renaming.value}
              placeholder="会话名称"
              onChange={(e) => setRenaming({ id: s.id, value: e.target.value })}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setRenaming(null)
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ) : (
          <div
            className="session-item"
            role="button"
            tabIndex={0}
            onClick={(e) => p.onOpen(s.id, e.ctrlKey || e.metaKey ? 'right' : 'left')}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, id: s.id, title: s.title, archived: Boolean(s.archived) })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') p.onOpen(s.id, 'left')
            }}
            title={`${s.title}（Ctrl+点击在第二栏打开）`}
          >
            <span className="session-item-title">
              {running && <span className="spin-ring session-running" />}
              <span className="session-item-name">{s.title}</span>
            </span>
            <button
              className="row-dots"
              title="更多操作"
              onClick={(e) => {
                e.stopPropagation()
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setMenu({ x: r.left, y: r.bottom + 2, id: s.id, title: s.title, archived: Boolean(s.archived) })
              }}
            >
              <IconDots size={12} />
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <button className="rail-new" onClick={p.onNew} title="新建会话（Ctrl+N）">
        <span className="rail-new-text">＋ 新建对话</span>
      </button>
      <div className="session-list">
        {p.projects.length === 0 && <div className="session-empty">暂无项目</div>}
        {p.projects.map((proj) => {
          const all = p.sessionsByProject[proj] ?? []
          const items = all.filter((s) => !s.archived)
          const archivedItems = all.filter((s) => s.archived)
          const isCollapsed = collapsed.has(proj)
          return (
            <div key={proj} className="project-group">
              <div
                className={`project-group-label${proj === p.activeProject ? ' on' : ''}`}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(proj)) next.delete(proj)
                    else next.add(proj)
                    return next
                  })
                }
                title={proj}
              >
                {isCollapsed ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
                <IconFolderOpen size={12} />
                <span className="project-group-name">{baseName(proj)}</span>
              </div>
              {!isCollapsed && (
                <div className="project-group-body">
                  {items.length === 0 && archivedItems.length === 0 && <div className="session-empty">（无会话）</div>}
                  {items.map((s) => item(s))}
                  {archivedItems.length > 0 && (
                    <>
                      <div className="archived-label" onClick={() => setArchOpen((v) => !v)}>
                        {archOpen ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}
                        已归档（{archivedItems.length}）
                      </div>
                      {archOpen && archivedItems.map((s) => item(s, true))}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {menu && (
        <div ref={menuRef} className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
          {!menu.archived && (
            <button
              className="ctx-item"
              onClick={() => {
                setRenaming({ id: menu.id, value: menu.title })
                setMenu(null)
              }}
            >
              重命名
            </button>
          )}
          <button
            className="ctx-item"
            onClick={() => {
              p.onArchive(menu.id, !menu.archived)
              setMenu(null)
            }}
          >
            {menu.archived ? '取消归档' : '归档'}
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              p.onExport(menu.id)
              setMenu(null)
            }}
          >
            导出会话
          </button>
          <button
            className="ctx-item danger"
            onClick={() => {
              if (window.confirm(`删除会话「${menu.title}」？此操作不可恢复。`)) p.onDelete(menu.id)
              setMenu(null)
            }}
          >
            删除会话
          </button>
        </div>
      )}
    </>
  )
}

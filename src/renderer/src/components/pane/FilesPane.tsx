// src/renderer/src/components/pane/FilesPane.tsx
/** 文件树 pane：懒加载目录树 + 文件名 glob 搜索 + 右键菜单（注入上下文 / 复制路径▸相对·绝对）+ 定位到文件 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DirEntry } from '@shared/types'
import { getApi } from '../../api'
import { IconChevronDown, IconChevronRight, IconClose, IconDots, IconRefresh, IconSearch } from '../icons'

export interface LocateRequest {
  path: string
  signal: number
}

interface Props {
  sessionId: string
  /** 会话工作目录（重锚切换时作为重载信号） */
  wsKey?: string
  /** 点击文件 → File pane 打开 */
  onOpenFile: (rel: string) => void
  /** 右键「加入到上下文」（注入状态由外部管理并渲染 chip） */
  onInject?: (rel: string) => void
  /** 编辑器区发来的定位请求（在树中展开 + 高亮该文件） */
  locate?: LocateRequest | null
  /** 当前会话改动过的文件（agent 读写的，置顶展示） */
  touched?: string[] | null
}

export function FilesPane({ sessionId, wsKey = '', onOpenFile, onInject, locate, touched }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<string[] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; rel: string; isFile: boolean } | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const debounce = useRef<number | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const loadDir = (path: string) => {
    setChildren((c) => {
      if (c[path]) return c
      void getApi()
        .listDir(sessionId, path)
        .then((entries) => setChildren((prev) => ({ ...prev, [path]: entries })))
      return c
    })
  }

  useEffect(() => {
    setExpanded(new Set())
    setChildren({})
    loadDir('')
    setQuery('')
    setHits(null)
    setMenu(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, wsKey])

  // 定位请求：展开祖先目录（逐级懒加载）→ 滚动 + 高亮
  useEffect(() => {
    if (!locate) return
    const parts = locate.path.split('/')
    const dirs = parts.slice(0, -1)
    const walk = (i: number): void => {
      if (i > dirs.length) {
        setTimeout(() => {
          const el = document.querySelector(`[data-path="${locate.path}"]`)
          el?.scrollIntoView({ block: 'nearest' })
          setFlash(locate.path)
          window.setTimeout(() => setFlash(null), 1200)
        }, 60)
        return
      }
      const dir = dirs.slice(0, i).join('/')
      setExpanded((prev) => new Set(prev).add(dir))
      loadDir(dir)
      walk(i + 1)
    }
    walk(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate?.signal])

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        loadDir(path)
      }
      return next
    })
  }

  const copyText = (text: string): void => {
    void navigator.clipboard.writeText(text)
  }

  const copyAbs = (rel: string) => {
    void getApi().absPath(sessionId, rel).then(copyText)
  }

  /** 搜索：≥2 字符即时 glob（防抖 300ms）；清空回到树视图 */
  const onQuery = (v: string) => {
    setQuery(v)
    window.clearTimeout(debounce.current)
    if (v.trim().length < 2) {
      setHits(null)
      return
    }
    debounce.current = window.setTimeout(() => {
      void getApi()
        .globFiles(sessionId, `**/*${v.trim()}*`)
        .then(setHits)
    }, 300)
  }

  const renderDir = (path: string, depth: number): React.ReactNode[] => {
    const entries = children[path] ?? []
    return entries.map((entry) => {
      const full = path ? `${path}/${entry.name}` : entry.name
      if (entry.type === 'dir') {
        const open = expanded.has(full)
        return (
          <div key={full}>
            <div
              data-path={full}
              className={`files-row${flash === full ? ' flash' : ''}`}
              style={{ paddingLeft: 4 + depth * 14 }}
              onClick={() => toggleDir(full)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, rel: full, isFile: false })
              }}
            >
              <span className="caret">{open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}</span>
              <span className="name">{entry.name}</span>
              <button
                className="row-dots"
                title="更多操作"
                onClick={(e) => {
                  e.stopPropagation()
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setMenu({ x: r.left, y: r.bottom + 2, rel: full, isFile: false })
                }}
              >
                <IconDots size={12} />
              </button>
            </div>
            {open && renderDir(full, depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={full}
          data-path={full}
          className={`files-row is-file${flash === full ? ' flash' : ''}`}
          style={{ paddingLeft: 4 + depth * 14 }}
          onClick={() => onOpenFile(full)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, rel: full, isFile: true })
          }}
          title="点击打开到编辑区；右键更多操作"
        >
          <span className="caret" />
          <span className="name">{entry.name}</span>
          <button
            className="row-dots"
            title="更多操作"
            onClick={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setMenu({ x: r.left, y: r.bottom + 2, rel: full, isFile: true })
            }}
          >
            <IconDots size={12} />
          </button>
        </div>
      )
    })
  }

  const hitsView = useMemo(
    () =>
      hits === null ? null : (
        <div className="files-body">
          {hits.length === 0 && <div className="files-empty">无匹配文件</div>}
          {hits.map((h) => (
            <div
              key={h}
              data-path={h}
              className={`files-row is-file${flash === h ? ' flash' : ''}`}
              onClick={() => onOpenFile(h)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, rel: h, isFile: true })
              }}
            >
              <span className="caret" />
              <span className="name mono">{h}</span>
            </div>
          ))}
        </div>
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hits, flash]
  )

  return (
    <>
      <div className="files-toolbar">
        <div className="files-search">
          <IconSearch size={13} />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onQuery('')
            }}
            placeholder="搜索文件名"
          />
          {query && (
            <button className="win-btn" onClick={() => onQuery('')} title="清除">
              <IconClose size={11} />
            </button>
          )}
        </div>
        <button
          className="win-btn"
          title="刷新"
          onClick={() => {
            setChildren({})
            loadDir('')
          }}
        >
          <IconRefresh size={13} />
        </button>
      </div>
      {touched && touched.length > 0 && (
        <div className="files-touched">
          <div className="files-touched-label">本次会话改动</div>
          {touched.map((f) => (
            <div
              key={f}
              data-path={f}
              className={`files-row is-file${flash === f ? ' flash' : ''}`}
              onClick={() => onOpenFile(f)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, rel: f, isFile: true })
              }}
              title={f}
            >
              <span className="caret" />
              <span className="name mono">{f}</span>
              <button
                className="row-dots"
                title="更多操作"
                onClick={(e) => {
                  e.stopPropagation()
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setMenu({ x: r.left, y: r.bottom + 2, rel: f, isFile: true })
                }}
              >
                <IconDots size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {hitsView ?? (
        <div className="files-body">
          {renderDir('', 0)}
          {Object.keys(children).length === 0 && <div className="files-empty">加载中</div>}
        </div>
      )}
      {menu && (
        <div ref={menuRef} className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.isFile && (
            <button
              className="ctx-item"
              onClick={() => {
                onInject?.(menu.rel)
                setMenu(null)
              }}
            >
              加入到上下文
            </button>
          )}
          <div className="ctx-item has-sub">
            复制路径
            <div className="ctx-sub">
              <button
                className="ctx-item"
                onClick={() => {
                  copyText(menu.rel)
                  setMenu(null)
                }}
              >
                相对路径
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  copyAbs(menu.rel)
                  setMenu(null)
                }}
              >
                绝对路径
              </button>
            </div>
            <span className="ctx-sub-caret">▸</span>
          </div>
        </div>
      )}
    </>
  )
}

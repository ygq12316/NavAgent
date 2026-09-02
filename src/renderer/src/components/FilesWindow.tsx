import { useEffect, useMemo, useRef, useState } from 'react'
import { getApi } from '../api'
import type { DirEntry } from '../api/types'

interface Props {
  workspacePath: string
  /** 点击文件 → File 窗口打开 */
  onOpenFile: (rel: string) => void
}

/** Files 目录窗口：懒加载目录树 + 文件名 glob 搜索 + 复制相对路径（单例，由 DockRoot 挂载） */
export function FilesWindow({ workspacePath, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<string[] | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const debounce = useRef<number | undefined>(undefined)

  const loadDir = (path: string) => {
    setChildren((c) => {
      if (c[path]) return c
      void getApi()
        .listDir(path)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

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

  const copyPath = (rel: string) => {
    void navigator.clipboard.writeText(rel)
    setCopied(rel)
    window.setTimeout(() => setCopied(null), 800)
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
        .globFiles(`**/*${v.trim()}*`)
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
            <div className="files-row" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => toggleDir(full)}>
              <span className="caret">{open ? '▾' : '▸'}</span>
              <span className="name">{entry.name}</span>
              <button className="copy-path" title="复制路径" onClick={(e) => { e.stopPropagation(); copyPath(full) }}>
                {copied === full ? '✓' : '⧉'}
              </button>
            </div>
            {open && renderDir(full, depth + 1)}
          </div>
        )
      }
      return (
        <div key={full} className="files-row is-file" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => onOpenFile(full)} title="打开到 File 窗口">
          <span className="caret" />
          <span className="name">{entry.name}</span>
          <button className="copy-path" title="复制路径" onClick={(e) => { e.stopPropagation(); copyPath(full) }}>
            {copied === full ? '✓' : '⧉'}
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
            <div key={h} className="files-row is-file" onClick={() => onOpenFile(h)}>
              <span className="caret" />
              <span className="name mono">{h}</span>
              <button className="copy-path" title="复制路径" onClick={(e) => { e.stopPropagation(); copyPath(h) }}>
                {copied === h ? '✓' : '⧉'}
              </button>
            </div>
          ))}
        </div>
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hits, copied]
  )

  return (
    <>
      <div className="files-toolbar">
        <div className="files-search">
          <span>⌕</span>
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onQuery('')
            }}
            placeholder="搜索文件名（≥2 字符）…"
          />
          {query && (
            <button className="win-btn" onClick={() => onQuery('')} title="清除">
              ✕
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
          ⟳
        </button>
      </div>
      {hitsView ?? (
        <div className="files-body">
          {renderDir('', 0)}
          {Object.keys(children).length === 0 && <div className="files-empty">加载中…</div>}
        </div>
      )}
    </>
  )
}

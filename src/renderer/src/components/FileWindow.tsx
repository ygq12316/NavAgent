// src/renderer/src/components/FileWindow.tsx
/** File 内容窗口：CodeMirror 6 编辑/保存/外部修改冲突三选/内建查找。工具条由 WorkspacePane 统一承载。 */
import { useEffect, useRef, useState } from 'react'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import type { FileReadResult } from '@shared/types'
import { getApi } from '../api'
import { MiniDialog } from './dock/WindowFrame'
import { IconArrowDown, IconArrowUp, IconClose, IconSearch } from './icons'

interface Props {
  /** 文件作用域 = 会话工作区（worktree 隔离） */
  sessionId: string
  path: string
  /** 外部要求重载（如重新打开同路径）时 +1 */
  reloadKey: number
  /** 外部触发查找面板（工具条「查找」按钮） */
  findSignal?: number
  onDirtyChange: (dirty: boolean) => void
  /** 文档内容回调（供外部复制全文） */
  onContentChange?: (content: string) => void
}

/** 作用域内大小写不敏感查找：返回全部命中区间（文档偏移） */
function findRanges(text: string, q: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(esc, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push({ from: m.index, to: m.index + m[0].length })
  return out
}

interface FindHi {
  ranges: { from: number; to: number }[]
  active: number
}
const setFindHi = StateEffect.define<FindHi>()
/** 自管命中高亮：命中微着色 + 当前命中加强（不依赖 CodeMirror 底部面板） */
const findHiField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setFindHi)) {
        deco = Decoration.set(
          e.value.ranges.map((r, i) =>
            (i === e.value.active ? Decoration.mark({ class: 'cm-find-active' }) : Decoration.mark({ class: 'cm-find-hit' })).range(r.from, r.to)
          )
        )
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

/** 按扩展名动态加载语言包（未命中返回 null = 纯文本） */
async function languageFor(path: string) {
  const ext = path.split('.').pop() ?? ''
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true })
    case 'ts': case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true })
    case 'json': return (await import('@codemirror/lang-json')).json()
    case 'md': return (await import('@codemirror/lang-markdown')).markdown()
    case 'py': return (await import('@codemirror/lang-python')).python()
    case 'html': case 'htm': return (await import('@codemirror/lang-html')).html()
    case 'css': return (await import('@codemirror/lang-css')).css()
    default: return null
  }
}

/** 冲突对话框语义：覆盖=以我的为准强制写；重新加载=放弃我的改动读盘 */
type ConflictKind = 'external-write' | 'external-focus'

export function FileWindow({ sessionId, path, reloadKey, findSignal = 0, onDirtyChange, onContentChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const baseMtime = useRef(0)
  const [dirty, setDirty] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictKind | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // 自有浮动查找条（替代 CodeMirror 底部面板）
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findActive, setFindActive] = useState(0)
  const [findCount, setFindCount] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  const findRangesRef = useRef<{ from: number; to: number }[]>([])

  const applyFind = (view: EditorView, ranges: { from: number; to: number }[], active: number): void => {
    view.dispatch({ effects: setFindHi.of({ ranges, active }) })
    if (ranges.length === 0) return
    const r = ranges[Math.min(Math.max(active, 0), ranges.length - 1)]
    view.dispatch({ effects: EditorView.scrollIntoView(r.from, { y: 'center' }), selection: { anchor: r.to, head: r.from } })
  }

  const updateFind = (q: string): void => {
    setFindQuery(q)
    const view = viewRef.current
    if (!view) return
    if (!q.trim()) {
      findRangesRef.current = []
      setFindCount(0)
      setFindActive(0)
      view.dispatch({ effects: setFindHi.of({ ranges: [], active: -1 }) })
      return
    }
    const ranges = findRanges(view.state.doc.toString(), q)
    findRangesRef.current = ranges
    setFindCount(ranges.length)
    setFindActive(0)
    applyFind(view, ranges, 0)
  }

  const goNext = (): void => {
    const view = viewRef.current
    const ranges = findRangesRef.current
    if (!view || ranges.length === 0) return
    const active = (findActive + 1) % ranges.length
    setFindActive(active)
    applyFind(view, ranges, active)
  }

  const goPrev = (): void => {
    const view = viewRef.current
    const ranges = findRangesRef.current
    if (!view || ranges.length === 0) return
    const active = (findActive - 1 + ranges.length) % ranges.length
    setFindActive(active)
    applyFind(view, ranges, active)
  }

  const closeFind = (): void => {
    setFindOpen(false)
    setFindQuery('')
    setFindCount(0)
    setFindActive(0)
    findRangesRef.current = []
    viewRef.current?.dispatch({ effects: setFindHi.of({ ranges: [], active: -1 }) })
  }

  const save = async (force = false): Promise<void> => {
    const view = viewRef.current
    if (!view) return
    const r = await getApi().writeFile(sessionId, path, view.state.doc.toString(), force ? undefined : baseMtime.current)
    if (r.ok) {
      baseMtime.current = r.mtime
      setDirty(false)
      setBanner(null)
    } else if (r.error === 'conflict') {
      setConflict('external-write')
    } else {
      setBanner(`保存失败：${r.message}`)
    }
  }

  // 挂载/切换文件：加载 → 建 EditorView
  useEffect(() => {
    let disposed = false
    void (async () => {
      const r: FileReadResult = await getApi().readFile(sessionId, path)
      if (disposed) return
      if (!r.ok) {
        setFailed(r.message)
        return
      }
      setFailed(null)
      baseMtime.current = r.mtime
      setDirty(false)
      setBanner(r.truncated ? '文件超过 1MB，仅显示前 1MB（只读）' : null)
      onContentChange?.(r.content)
      const lang = await languageFor(path)
      if (disposed || !host.current) return
      viewRef.current?.destroy()
      const readonly = r.truncated
      viewRef.current = new EditorView({
        state: EditorState.create({
          doc: r.content,
          extensions: [
            keymap.of([{ key: 'Mod-f', preventDefault: true, run: () => { setFindOpen(true); requestAnimationFrame(() => findInputRef.current?.focus()); return true } }]),
            findHiField,
            basicSetup,
            ...(lang ? [lang] : []),
            EditorState.readOnly.of(readonly),
            EditorView.editable.of(!readonly),
            keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (void save(), true) }]),
            EditorView.updateListener.of((v) => {
              if (v.docChanged && !readonly) {
                setDirty(true)
                onDirtyChange(true)
              }
              onContentChange?.(v.state.doc.toString())
            })
          ]
        }),
        parent: host.current
      })
    })()
    return () => {
      disposed = true
      viewRef.current?.destroy()
      viewRef.current = null
      setDirty(false)
      onDirtyChange(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadKey])

  // 工具条「查找」按钮：打开自有浮动查找条（替代 CodeMirror 底部面板）
  useEffect(() => {
    if (findSignal > 0) {
      setFindOpen(true)
      requestAnimationFrame(() => findInputRef.current?.focus())
    }
  }, [findSignal])

  // 切换文件：重置查找（新 EditorView 无历史高亮）
  useEffect(() => {
    setFindOpen(false)
    setFindQuery('')
    setFindCount(0)
    setFindActive(0)
    findRangesRef.current = []
  }, [path, reloadKey])

  // 窗口聚焦时检查外部变更
  useEffect(() => {
    const onFocus = () => {
      void (async () => {
        if (viewRef.current === null) return
        const r = await getApi().readFile(sessionId, path)
        if (r.ok && r.mtime !== baseMtime.current && !dirty) {
          // 无本地改动：静默重载
          viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: r.content } })
          baseMtime.current = r.mtime
        } else if (r.ok && r.mtime !== baseMtime.current && dirty) {
          setConflict('external-focus')
        }
      })()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [path, dirty])

  const reload = () => {
    setConflict(null)
    // 放弃本地修改：重读磁盘替换文档
    void (async () => {
      const r = await getApi().readFile(sessionId, path)
      if (r.ok && viewRef.current) {
        viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: r.content } })
        baseMtime.current = r.mtime
        setDirty(false)
        onDirtyChange(false)
      }
    })()
  }

  if (failed) {
    return <div className="files-empty" style={{ padding: 20 }}>无法打开：{failed}</div>
  }

  return (
    <>
      {banner && <div className="file-banner">{banner}</div>}
      <div className="file-editor-wrap">
        <div className="file-editor-host" ref={host} />
        {findOpen && (
          <div className="find-bar file-find-bar">
            <IconSearch size={13} className="find-bar-icon" />
            <input
              ref={findInputRef}
              className="find-input"
              value={findQuery}
              placeholder="在文件中查找"
              onChange={(e) => updateFind(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (e.shiftKey) goPrev()
                  else goNext()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  closeFind()
                }
              }}
            />
            <span className="find-count">{findCount ? `${findActive + 1}/${findCount}` : '0/0'}</span>
            <button className="find-nav" disabled={findCount === 0} onClick={goPrev} title="上一个命中">
              <IconArrowUp size={13} />
            </button>
            <button className="find-nav" disabled={findCount === 0} onClick={goNext} title="下一个命中">
              <IconArrowDown size={13} />
            </button>
            <button className="find-nav" onClick={closeFind} title="关闭查找">
              <IconClose size={13} />
            </button>
          </div>
        )}
      </div>
      {conflict && (
        <MiniDialog
          title="文件已被外部修改"
          text={
            conflict === 'external-write'
              ? '保存时发现磁盘上的文件比你打开时新（可能是 agent 写入的）。'
              : '你本地的未保存修改与磁盘新内容不一致。'
          }
          actions={[
            { label: '取消', onClick: () => setConflict(null) },
            { label: '重新加载（放弃我的修改）', onClick: reload },
            { label: '覆盖磁盘（以我的为准）', primary: true, onClick: () => { setConflict(null); void save(true) } }
          ]}
        />
      )}
    </>
  )
}

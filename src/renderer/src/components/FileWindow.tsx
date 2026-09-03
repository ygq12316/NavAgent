// src/renderer/src/components/FileWindow.tsx
/** File 内容窗口：CodeMirror 6 编辑/保存/外部修改冲突三选/内建查找/复制全文。 */
import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import type { FileReadResult } from '@shared/types'
import { getApi } from '../api'
import { IconCopy } from './icons'
import { MiniDialog } from './dock/WindowFrame'

interface Props {
  path: string
  /** 外部要求重载（如重新打开同路径）时 +1 */
  reloadKey: number
  onDirtyChange: (dirty: boolean) => void
}

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

export function FileWindow({ path, reloadKey, onDirtyChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const baseMtime = useRef(0)
  const [dirty, setDirty] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictKind | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const save = async (force = false): Promise<void> => {
    const view = viewRef.current
    if (!view) return
    const r = await getApi().writeFile(path, view.state.doc.toString(), force ? undefined : baseMtime.current)
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
      const r: FileReadResult = await getApi().readFile(path)
      if (disposed) return
      if (!r.ok) {
        setFailed(r.message)
        return
      }
      setFailed(null)
      baseMtime.current = r.mtime
      setDirty(false)
      setBanner(r.truncated ? '文件超过 1MB，仅显示前 1MB（只读）' : null)
      const lang = await languageFor(path)
      if (disposed || !host.current) return
      viewRef.current?.destroy()
      const readonly = r.truncated
      viewRef.current = new EditorView({
        state: EditorState.create({
          doc: r.content,
          extensions: [
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

  // 窗口聚焦时检查外部变更
  useEffect(() => {
    const onFocus = () => {
      void (async () => {
        if (viewRef.current === null) return
        const r = await getApi().readFile(path)
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
      const r = await getApi().readFile(path)
      if (r.ok && viewRef.current) {
        viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: r.content } })
        baseMtime.current = r.mtime
        setDirty(false)
        onDirtyChange(false)
      }
    })()
  }

  const copyAll = () => {
    const view = viewRef.current
    if (view) void navigator.clipboard.writeText(view.state.sliceDoc(0, view.state.doc.length))
  }

  if (failed) {
    return <div className="files-empty" style={{ padding: 20 }}>无法打开：{failed}</div>
  }

  return (
    <>
      <div className="file-toolbar">
        <span className="file-search-hint" title="CodeMirror 内建查找">Ctrl+F 文件内查找 · Mod+S 保存</span>
        <button onClick={copyAll} title="复制全文"><IconCopy size={12} /> 复制</button>
        <button
          className={dirty ? 'save-dirty' : ''}
          onClick={() => void save()}
          title={dirty ? '保存（有未保存修改）' : '已保存'}
        >
          {dirty ? '● 未保存 · Ctrl+S' : '已保存'}
        </button>
      </div>
      {banner && <div className="file-banner">{banner}</div>}
      <div className="file-editor-host" ref={host} />
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

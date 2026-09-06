// src/renderer/src/components/pane/WorkspacePane.tsx
/** 文件 pane：左树 + 右编辑区（多标签 + 右上角图标工具条：复制全文 / 查找 / 树中定位） */
import { useEffect, useRef, useState } from 'react'
import { getApi } from '../../api'
import { FilesPane, type LocateRequest } from './FilesPane'
import { FileWindow } from '../FileWindow'
import { IconCopy, IconCrosshair, IconPanelLeft, IconSearch } from '../icons'

interface Props {
  sessionId: string
  /** 会话工作目录（重锚切换时作为重载信号） */
  wsKey?: string
  fileTarget: { path: string; key: number } | null
  onOpenFile: (rel: string) => void
  /** 右键「加入到上下文」 */
  onInject?: (rel: string) => void
  /** 当前会话改动过的文件（文件树置顶展示） */
  touched?: string[] | null
}

export function WorkspacePane({ sessionId, wsKey = '', fileTarget, onOpenFile, onInject, touched }: Props) {
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const [findSignal, setFindSignal] = useState(0)
  const [locate, setLocate] = useState<LocateRequest | null>(null)
  // 文件树显隐（隐藏后编辑区铺满；工具条常驻开关，避免无从恢复）
  const [treeVisible, setTreeVisible] = useState(true)
  // 各标签的最新缓冲内容（复制全文用；未加载过的标签回退读盘）
  const buffers = useRef<Record<string, string>>({})

  // 会话切换 / 工作目录重锚：标签全部重置 + 恢复文件树
  useEffect(() => {
    setTabs([])
    setActive(null)
    setDirty({})
    setTreeVisible(true)
  }, [sessionId, wsKey])

  // fileTarget = 打开请求：加入标签并激活
  useEffect(() => {
    if (!fileTarget) return
    const p = fileTarget.path
    setTabs((t) => (t.includes(p) ? t : [...t, p]))
    setActive(p)
  }, [fileTarget])

  const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p

  const closeTab = (p: string) => {
    if (dirty[p] && !window.confirm(`「${baseName(p)}」有未保存修改，确定关闭（丢弃修改）？`)) return
    setTabs((t) => {
      const next = t.filter((x) => x !== p)
      setActive((cur) => (cur === p ? next.at(-1) ?? null : cur))
      return next
    })
  }

  const copyActive = () => {
    if (!active) return
    const buffered = buffers.current[active]
    if (buffered !== undefined) {
      void navigator.clipboard.writeText(buffered)
      return
    }
    void getApi()
      .readFile(sessionId, active)
      .then((r) => {
        if (r.ok) void navigator.clipboard.writeText(r.content)
      })
  }

  return (
    <div className="workspace-pane">
      {treeVisible && (
        <div className="workspace-tree">
          <FilesPane sessionId={sessionId} wsKey={wsKey} onOpenFile={onOpenFile} onInject={onInject} locate={locate} touched={touched} />
        </div>
      )}
      <div className="workspace-editor">
        <div className="editor-tabs">
          <div className="editor-tab-strip">
            {active &&
              tabs.map((t) => (
                <div
                  key={t}
                  className={`editor-tab${t === active ? ' on' : ''}`}
                  onClick={() => setActive(t)}
                  title={t}
                >
                  <span className="editor-tab-name">{baseName(t)}</span>
                  {dirty[t] && <span className="editor-tab-dirty" />}
                  <button
                    className="editor-tab-close"
                    title="关闭标签"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(t)
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
          </div>
          <div className="editor-tools">
            <button
              className={`icon-btn${treeVisible ? ' on' : ''}`}
              onClick={() => setTreeVisible((v) => !v)}
              title={treeVisible ? '隐藏文件树' : '显示文件树'}
            >
              <IconPanelLeft size={13} />
            </button>
            {active && (
              <>
                <button className="icon-btn" onClick={copyActive} title="复制整个文件内容">
                  <IconCopy size={13} />
                </button>
                <button className="icon-btn" onClick={() => setFindSignal((s) => s + 1)} title="查找（Ctrl+F）">
                  <IconSearch size={13} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => {
                    setTreeVisible(true)
                    setLocate({ path: active, signal: Date.now() })
                  }}
                  title="在文件树中定位"
                >
                  <IconCrosshair size={13} />
                </button>
              </>
            )}
          </div>
        </div>
        {active ? (
          <FileWindow
            key={active}
            sessionId={sessionId}
            path={active}
            reloadKey={0}
            findSignal={findSignal}
            onDirtyChange={(d: boolean) => setDirty((prev) => ({ ...prev, [active]: d }))}
            onContentChange={(c: string) => {
              buffers.current[active] = c
            }}
          />
        ) : (
          <div className="files-empty">从左侧文件树选择文件</div>
        )}
      </div>
    </div>
  )
}

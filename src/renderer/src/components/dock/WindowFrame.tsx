// src/renderer/src/components/dock/WindowFrame.tsx
/** Dock 窗口通用壳：标题条（拖拽换位/最小化/关闭）+ 内容区；附拖拽 ghost、外点关闭、极简对话框。 */
import { useEffect, useRef } from 'react'

export interface WindowFrameProps {
  kind: string
  title: string
  sub?: string
  /** 常驻窗口（会话管理/聊天）：无 ✕，标题条不可拖拽换位（会话管理在左栏不可拖；chat 可拖） */
  movable: boolean
  closable: boolean
  /** 头部左侧追加动作（chat 的 ＋Files 等） */
  headerActions?: React.ReactNode
  onCloseRequest?: () => void
  onMinimize: () => void
  onBeginDrag?: (e: React.PointerEvent) => void
  dropHint?: 'target' | 'reject' | null
  children: React.ReactNode
}

export function WindowFrame(p: WindowFrameProps) {
  return (
    <section
      className={`dock-window${p.dropHint === 'target' ? ' is-drop-target' : p.dropHint === 'reject' ? ' is-drop-reject' : ''}`}
      data-window-kind={p.kind}
    >
      <div
        className={`dock-window-header${p.movable ? ' grabbable' : ''}`}
        onPointerDown={(e) => {
          if (!p.movable || (e.target as HTMLElement).closest('.win-btn')) return
          p.onBeginDrag?.(e)
        }}
      >
        <span className="dock-window-title">
          {p.title}
          {p.sub && <span className="dock-window-sub"> {p.sub}</span>}
        </span>
        {p.headerActions}
        <span className="dock-window-actions">
          <button className="win-btn" onClick={p.onMinimize} title="最小化（顶栏可唤回）">
            —
          </button>
          {p.closable && (
            <button className="win-btn" onClick={() => p.onCloseRequest?.()} title="关闭">
              ✕
            </button>
          )}
        </span>
      </div>
      <div className="dock-window-body">{p.children}</div>
    </section>
  )
}

/** 拖拽 ghost：跟随指针的浮动标签（DockRoot 渲染） */
export function DragGhost({ label, pos, reject }: { label: string; pos: { x: number; y: number }; reject: boolean }) {
  return (
    <div className="drag-ghost" style={{ left: pos.x + 10, top: pos.y + 10, color: reject ? 'var(--warn)' : undefined }}>
      {reject ? '🚫 ' : '⠿ '}
      {label}
    </div>
  )
}

/** 点击外部关闭的下拉小容器（chat 头部按钮组复用） */
export function useOutsideClose(onClose: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [onClose])
  return ref
}

/** 极简三选确认对话框（File 冲突等复用） */
export function MiniDialog({ title, text, actions }: { title: string; text: string; actions: { label: string; onClick: () => void; primary?: boolean }[] }) {
  return (
    <div className="file-dialog-mask">
      <div className="file-dialog">
        <h4>{title}</h4>
        <p>{text}</p>
        <div className="row">
          {actions.map((a) => (
            <button key={a.label} className={a.primary ? 'btn btn-primary' : 'btn'} onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// src/renderer/src/components/dock/WindowFrame.tsx
/** Pane 通用壳：标题条（拖拽换位/最大化/关闭）+ 内容区；附拖拽 ghost、外点关闭、极简对话框。 */
import { useEffect, useRef } from 'react'
import { IconClose, IconMax, IconRestore } from '../icons'
import { Swap } from '@phosphor-icons/react'

export type DropHint = 'left' | 'right' | 'top' | 'bottom' | 'swap' | 'reject' | null

export interface WindowFrameProps {
  kind: string
  title: string
  sub?: string
  /** pane 标题条可拖拽换位 */
  movable: boolean
  closable: boolean
  /** 可最大化（双击标题或右上按钮；铺满会话区） */
  maximizable?: boolean
  maximized?: boolean
  /** 聚焦态：标题文字提亮 */
  focused?: boolean
  /** 头部左侧追加动作 */
  headerActions?: React.ReactNode
  /** 头部左侧前置槽位（项目选择等，渲染在标题之前） */
  lead?: React.ReactNode
  onCloseRequest?: () => void
  onToggleMaximize?: () => void
  onBeginDrag?: (e: React.PointerEvent) => void
  /** 指针按下时请求聚焦 */
  onFocus?: () => void
  /** 拖拽落点：半区插入（left/right/top/bottom）、正中互换（swap）、拒绝（reject）、无（null） */
  dropHint?: DropHint
  children: React.ReactNode
}

export function WindowFrame(p: WindowFrameProps) {
  const zone = p.dropHint && p.dropHint !== 'reject' ? p.dropHint : null
  return (
    <section
      className={`dock-window${p.focused ? ' is-focus' : ''}${p.dropHint === 'reject' ? ' is-drop-reject' : ''}`}
      data-window-kind={p.kind}
      onPointerDownCapture={() => p.onFocus?.()}
    >
      {zone && (
        <div className={`drop-overlay drop-${zone}`}>
          {zone === 'swap' && <Swap size={22} weight="bold" />}
        </div>
      )}
      {/* 顶部移动把手：按住拖动换位 */}
      {p.movable && !p.maximized && (
        <span
          className="win-grip"
          title="拖动移动此面板"
          onPointerDown={(e) => {
            e.preventDefault()
            p.onBeginDrag?.(e)
          }}
        />
      )}
      <div
        className={`dock-window-header${p.movable ? ' grabbable' : ''}`}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('.win-btn')) return
          if (p.maximizable) p.onToggleMaximize?.()
        }}
        onPointerDown={(e) => {
          if (!p.movable || (e.target as HTMLElement).closest('.win-btn')) return
          p.onBeginDrag?.(e)
        }}
      >
        {p.lead && <span className="dock-window-lead">{p.lead}</span>}
        <span className="dock-window-title">
          {p.title}
          {p.sub && <span className="dock-window-sub"> {p.sub}</span>}
        </span>
        <span className="dock-window-tools">{p.headerActions}</span>
        <span className="dock-window-actions">
          {p.maximizable && p.onToggleMaximize && (
            <button className="win-btn" onClick={p.onToggleMaximize} title={p.maximized ? '还原' : '最大化（双击标题）'}>
              {p.maximized ? <IconRestore size={12} /> : <IconMax size={12} />}
            </button>
          )}
          {p.closable && (
            <button className="win-btn" onClick={() => p.onCloseRequest?.()} title="关闭">
              <IconClose size={12} />
            </button>
          )}
        </span>
      </div>
      <div className="dock-window-body">{p.children}</div>
    </section>
  )
}

/** 拖拽 ghost：跟随指针的浮动标签（PaneTree 渲染） */
export function DragGhost({ label, pos, reject }: { label: string; pos: { x: number; y: number }; reject: boolean }) {
  return (
    <div className="drag-ghost" style={{ left: pos.x + 10, top: pos.y + 10, color: reject ? 'var(--bad)' : undefined }}>
      {reject ? '无法落位：' : '移动到 '}
      {label}
    </div>
  )
}

/** 点击外部关闭的下拉小容器（Views 菜单/@mention 复用） */
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

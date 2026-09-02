// src/renderer/src/components/dock/DockRoot.tsx
/** Dock 壳层：递归渲染分割树 + 左栏（会话管理）+ 最小化隐藏层；pointer events 实现标题条拖拽换位与分隔条拖宽。 */
import { useCallback, useRef, useState } from 'react'
import type { LayoutAction, LayoutState, FreeKind, FreeNode } from '../../state/layout'
import { WindowFrame, DragGhost } from './WindowFrame'

export interface DockSlots {
  rail: React.ReactNode
  renderWindow: (kind: FreeKind) => React.ReactNode
  windowChrome: (kind: FreeKind) => { title: string; sub?: string; locked: boolean; headerActions?: React.ReactNode }
  /** 关闭前拦截（File 窗口脏内容确认）；返回 false 中止 */
  onCloseRequest?: (kind: FreeKind) => boolean
}

interface DragState {
  win: FreeKind
  x: number
  y: number
  target: FreeKind | 'sessions' | null
  mode: 'left' | 'right' | 'top' | 'bottom' | 'swap' | 'reject' | null
}

const EDGE = 0.28 // 目标窗口边缘热区比例

export function DockRoot({ layout, dispatch, slots }: { layout: LayoutState; dispatch: (a: LayoutAction) => void; slots: DockSlots }) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)

  const beginDrag = useCallback((win: FreeKind, e: React.PointerEvent) => {
    e.preventDefault()
    const d: DragState = { win, x: e.clientX, y: e.clientY, target: null, mode: null }
    dragRef.current = d
    setDrag(d)
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-window-kind]') as HTMLElement | null
      let target: DragState['target'] = null
      let mode: DragState['mode'] = null
      if (el) {
        target = el.dataset.windowKind as FreeKind | 'sessions'
        if (target === 'sessions') {
          mode = 'reject' // 左栏固定，禁止落位
        } else if (target !== dragRef.current?.win) {
          const r = el.getBoundingClientRect()
          const fx = (ev.clientX - r.left) / r.width
          const fy = (ev.clientY - r.top) / r.height
          mode =
            fx < EDGE ? 'left'
            : fx > 1 - EDGE ? 'right'
            : fy < EDGE ? 'top'
            : fy > 1 - EDGE ? 'bottom'
            : 'swap'
        }
      }
      const next: DragState = { win, x: ev.clientX, y: ev.clientY, target, mode }
      dragRef.current = next
      setDrag(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const cur = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (cur?.target && cur.target !== 'sessions' && cur.mode && cur.mode !== 'reject') {
        dispatch({ kind: 'drop', win: cur.win, target: cur.target, mode: cur.mode })
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [dispatch])

  /** 分隔条拖动：以所属 split 容器为基准算 ratio（path = 目标 split 自身的路径） */
  const startSplit = (path: number[], e: React.PointerEvent) => {
    e.preventDefault()
    const container = (e.currentTarget as HTMLElement).parentElement
    if (!container) return
    const dir = container.classList.contains('dock-split-col') ? 'col' : 'row'
    const rect = container.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const ratio = dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height
      dispatch({ kind: 'setRatio', path, ratio })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startRailDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const move = (ev: PointerEvent) => dispatch({ kind: 'setRail', width: ev.clientX - 8 })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const closeOf = (kind: FreeKind) => () => {
    if (slots.onCloseRequest?.(kind) === false) return
    dispatch({ kind: 'close', win: kind as Exclude<FreeKind, 'chat'> }) // chat 不可关（类型层排除），reducer 内还有运行时守卫
  }
  const minimizeOf = (kind: FreeKind) => () => dispatch({ kind: 'minimize', win: kind })

  const renderNode = (node: FreeNode, path: number[]): React.ReactNode => {
    if (node.t === 'leaf') {
      const kind = node.kind
      const chrome = slots.windowChrome(kind)
      return (
        <WindowFrame
          kind={kind}
          title={chrome.title}
          sub={chrome.sub}
          movable /* chat 可拖；仅左栏 sessions 不可拖 */
          closable={kind !== 'chat'}
          headerActions={chrome.headerActions}
          onCloseRequest={closeOf(kind)}
          onMinimize={minimizeOf(kind)}
          onBeginDrag={(e) => beginDrag(kind, e)}
          dropHint={
            drag?.target === kind ? (drag.mode === 'reject' ? 'reject' : 'target') : null
          }
        >
          {slots.renderWindow(kind)}
        </WindowFrame>
      )
    }
    const style = (isA: boolean) => ({ flexGrow: isA ? node.ratio : 1 - node.ratio, flexBasis: 0 })
    return (
      <div className={`dock-split-${node.dir}`}>
        <div style={style(true)} className="dock-split-child">{renderNode(node.a, [...path, 0])}</div>
        <div className="dock-splitter" data-dir={node.dir} onPointerDown={(e) => startSplit(path, e)} />
        <div style={style(false)} className="dock-split-child">{renderNode(node.b, [...path, 1])}</div>
      </div>
    )
  }

  const visibleKinds: FreeKind[] = []
  const collect = (n: FreeNode | null) => {
    if (!n) return
    if (n.t === 'leaf') visibleKinds.push(n.kind)
    else {
      collect(n.a)
      collect(n.b)
    }
  }
  collect(layout.free)
  const hiddenKinds = layout.openKinds.filter((k) => !visibleKinds.includes(k))

  return (
    <div className="dock">
      {!layout.railCollapsed && (
        <>
          <WindowFrame
            kind="sessions"
            title="会话管理"
            sub={undefined}
            movable={false}
            closable={false}
            onMinimize={() => dispatch({ kind: 'toggleRail' })}
            dropHint={drag?.target === 'sessions' ? 'reject' : null}
          >
            <div style={{ width: layout.rail }} className="dock-rail-inner">{slots.rail}</div>
          </WindowFrame>
          <div className="dock-splitter rail-split" data-dir="row" onPointerDown={startRailDrag} title="左栏宽度（160–320）" />
        </>
      )}
      {layout.railCollapsed && (
        <button className="rail-collapsed-bar" onClick={() => dispatch({ kind: 'toggleRail' })} title="展开会话管理">
          会话管理
        </button>
      )}
      {layout.free && <div className="dock-free" style={{ flex: 1, display: 'flex', minWidth: 0 }}>{renderNode(layout.free, [])}</div>}
      <div className="dock-hidden">
        {hiddenKinds.map((k) => (
          <div key={k}>{slots.renderWindow(k)}</div>
        ))}
      </div>
      {drag && <DragGhost label={drag.win} pos={{ x: drag.x, y: drag.y }} reject={drag.mode === 'reject' || drag.target === 'sessions'} />}
    </div>
  )
}

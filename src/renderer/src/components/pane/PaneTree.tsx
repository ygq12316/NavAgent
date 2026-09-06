// src/renderer/src/components/pane/PaneTree.tsx
/** 会话内 pane 布局树：递归渲染分割树；pointer events 实现标题条拖拽换位与分隔条拖宽。 */
import { useCallback, useRef, useState } from 'react'
import type { PaneKind, PaneNode } from '../../state/pane-layout'
import { WindowFrame, DragGhost } from '../dock/WindowFrame'

export interface PaneChrome {
  title: string
  sub?: string
  headerActions?: React.ReactNode
  /** 头部前置槽位（渲染在标题之前，聊天窗放项目选择） */
  lead?: React.ReactNode
}

export interface PaneTreeSlots {
  /** pane 标题等 chrome（按 kind） */
  chrome: (kind: PaneKind) => PaneChrome
  /** pane 内容（按 kind） */
  render: (kind: PaneKind) => React.ReactNode
  /** 关闭前拦截（File pane 脏内容确认）；返回 false 中止 */
  onCloseRequest?: (kind: PaneKind) => boolean
}

interface DragState {
  win: PaneKind
  x: number
  y: number
  target: PaneKind | null
  mode: 'left' | 'right' | 'top' | 'bottom' | 'swap' | 'reject' | null
}

const EDGE = 0.28 // 目标 pane 边缘热区比例

interface Props {
  sessionId: string
  layout: PaneNode
  focused: boolean
  /** 最大化中的 pane（铺满会话区，忽略分割树） */
  maximized?: PaneKind | null
  dispatch: (a: { kind: 'paneRatio'; path: number[]; ratio: number } | { kind: 'paneDrop'; win: PaneKind; target: PaneKind; mode: 'left' | 'right' | 'top' | 'bottom' | 'swap' }) => void
  slots: PaneTreeSlots
  onClosePane: (kind: PaneKind) => void
  onToggleMaximize: (kind: PaneKind) => void
}

export function PaneTree({ layout, focused, maximized, dispatch, slots, onClosePane, onToggleMaximize }: Props) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)

  const beginDrag = useCallback((win: PaneKind, e: React.PointerEvent) => {
    e.preventDefault()
    const d: DragState = { win, x: e.clientX, y: e.clientY, target: null, mode: null }
    dragRef.current = d
    setDrag(d)
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-window-kind]') as HTMLElement | null
      let target: DragState['target'] = null
      let mode: DragState['mode'] = null
      if (el) {
        target = el.dataset.windowKind as PaneKind
        if (target !== dragRef.current?.win) {
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
      if (cur?.target && cur.target !== cur.win && cur.mode && cur.mode !== 'reject') {
        dispatch({ kind: 'paneDrop', win: cur.win, target: cur.target, mode: cur.mode })
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
      dispatch({ kind: 'paneRatio', path, ratio })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const renderNode = (node: PaneNode, path: number[]): React.ReactNode => {
    if (node.t === 'leaf') {
      const kind = node.kind
      const chrome = slots.chrome(kind)
      return (
        <WindowFrame
          kind={kind}
          title={chrome.title}
          sub={chrome.sub}
          lead={chrome.lead}
          movable
          closable={kind !== 'chat'}
          maximizable
          maximized={maximized === kind}
          focused={focused}
          headerActions={chrome.headerActions}
          onCloseRequest={() => {
            if (slots.onCloseRequest?.(kind) === false) return
            onClosePane(kind)
          }}
          onToggleMaximize={() => onToggleMaximize(kind)}
          onBeginDrag={(e) => beginDrag(kind, e)}
          dropHint={(() => {
            // 拖过自身 = 无操作，不显示落点
            if (drag?.target !== kind || drag.win === kind) return null
            if (drag.mode === 'reject') return 'reject' as const
            return drag.mode ?? null
          })()}
        >
          {slots.render(kind)}
        </WindowFrame>
      )
    }
    if (maximized !== null && maximized !== undefined) {
      // 最大化：只渲染该 pane（铺满），分割树保持原状以便还原
      const leaf = findLeaf(node, maximized)
      if (leaf) return renderNode(leaf, path)
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

  return (
    <div className="pane-tree">
      {renderNode(layout, [])}
      {drag && <DragGhost label={drag.win} pos={{ x: drag.x, y: drag.y }} reject={drag.mode === 'reject'} />}
    </div>
  )
}

function findLeaf(node: PaneNode, kind: PaneKind): PaneNode | null {
  if (node.t === 'leaf') return node.kind === kind ? node : null
  return findLeaf(node.a, kind) ?? findLeaf(node.b, kind)
}

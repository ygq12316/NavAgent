// src/renderer/src/components/pane/SessionArea.tsx
/** 会话区：1-2 个 SessionView（双栏并排看两个会话，分隔条可拖宽）。 */
import type { ReactNode } from 'react'

interface Props {
  left: ReactNode
  right: ReactNode | null
  onSplitDrag?: (clientX: number, width: number) => void
}

export function SessionArea({ left, right }: Props) {
  if (!right) return <div className="session-area">{left}</div>
  return (
    <div className="session-area dual">
      <div className="session-half">{left}</div>
      <div className="session-splitter" />
      <div className="session-half">{right}</div>
    </div>
  )
}

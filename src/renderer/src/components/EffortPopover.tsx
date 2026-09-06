import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThinkingLevel } from '@shared/types'

/**
 * 档位定义（完全对齐 Claude Code 力度档）：Low / Medium / High / XHigh / Ultracode。
 * 左端 Faster → 右端 Smarter（Ultracode = 拉满）；配置里的空值/旧档位（off、minimal）按 Low 位显示。
 */
const LEVELS: { value: ThinkingLevel; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: '更快' },
  { value: 'medium', label: 'Medium', hint: '均衡' },
  { value: 'high', label: 'High', hint: '更强' },
  { value: 'xhigh', label: 'XHigh', hint: '很强' },
  { value: 'max', label: 'Ultracode', hint: '拉满思考' }
]


interface Props {
  value: ThinkingLevel | ''
  onChange: (v: ThinkingLevel | '') => void
}

/** 思考力度滑杆（Effort）：分段刻度块 + 旋钮；点击/拖动/方向键均可调节 */
export function ThinkingPopover({ value, onChange }: Props) {
  // 空值/旧档位（off、minimal）按 Low 位显示；一旦调节即写入显式档位
  const idx = Math.max(0, LEVELS.findIndex((l) => l.value === value))
  const trackRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  /** 上方空间不足（分栏/矮 pane 会被裁剪）时向下翻开 */
  const [down, setDown] = useState(false)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setDown(rect.top < 8)
  }, [])

  /** 横向位置（0~1）→ 最近档位 */
  const applyFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const next = Math.round(ratio * (LEVELS.length - 1))
      if (LEVELS[next] && LEVELS[next].value !== value) onChange(LEVELS[next]!.value)
    },
    [onChange, value]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    applyFromClientX(e.clientX)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    applyFromClientX(e.clientX)
  }
  const endDrag = (): void => setDragging(false)
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      onChange(LEVELS[Math.max(0, idx - 1)]!.value)
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      onChange(LEVELS[Math.min(LEVELS.length - 1, idx + 1)]!.value)
    } else if (e.key === 'Home') {
      e.preventDefault()
      onChange(LEVELS[0]!.value)
    } else if (e.key === 'End') {
      e.preventDefault()
      onChange(LEVELS[LEVELS.length - 1]!.value)
    }
  }

  const posPct = (idx / (LEVELS.length - 1)) * 100
  const current = LEVELS[idx] ?? LEVELS[0]

  return (
    <div ref={rootRef} className={`eff-pop${down ? ' down' : ''}`}>
      <div className="eff-head">
        <span className="eff-head-label">Effort</span>
        <span className="eff-head-value">{current.label}</span>
        <span
          className="eff-help"
          title="档位越高，模型思考越深：更聪明但更慢、更贵（对齐 Claude Code 六档）"
        >
          ?
        </span>
      </div>
      <div className="eff-ends">
        <span>Faster</span>
        <span>Smarter</span>
      </div>
      <div
        ref={trackRef}
        className="eff-track"
        role="slider"
        tabIndex={0}
        aria-label="思考力度"
        aria-valuemin={0}
        aria-valuemax={LEVELS.length - 1}
        aria-valuenow={idx}
        aria-valuetext={current.label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div className="eff-knob" style={{ left: `${posPct}%` }} />
      </div>
    </div>
  )
}

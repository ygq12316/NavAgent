interface Props {
  /** 排队中的插话/续跑条数 */
  queued?: { steering: number; followUp: number }
}

/** 状态栏：恒常渲染与顶部标题栏等高（32px）的底部留白；有排队时在其内显示条数 */
export function StatusBar({ queued }: Props) {
  const queuedCount = (queued?.steering ?? 0) + (queued?.followUp ?? 0)
  return (
    <footer className="statusbar">
      {queuedCount > 0 && (
        <>
          <span className="status-spacer" />
          <span className="status-item" title={`插话 ${queued?.steering ?? 0} 条 · 续跑 ${queued?.followUp ?? 0} 条`}>
            排队 {queuedCount}
          </span>
        </>
      )}
    </footer>
  )
}

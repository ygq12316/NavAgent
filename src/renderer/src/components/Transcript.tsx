import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { PermissionVM, UIState } from '../state/reducer'
import type { PermissionDecision, ThinkingContent } from '@shared/types'
import { ToolBlock } from './ToolBlock'

/** 思考过程折叠面板（sunken 内凹，默认收起；redacted 显示为加密占位） */
function ThinkingPanel({ block }: { block: ThinkingContent }) {
  if (block.redacted) {
    return (
      <div className="thinking-panel sunken">
        <div className="thinking-summary">思考过程（模型加密，不可见）</div>
      </div>
    )
  }
  return (
    <details className="thinking-panel sunken">
      <summary className="thinking-summary">思考过程（{block.thinking.length} 字）</summary>
      <div className="thinking-body mono">{block.thinking}</div>
    </details>
  )
}

const CHIPS = ['总结这份调研报告', '运行 dir 看看目录结构', '这个项目用的什么架构？']

interface Props {
  state: UIState
  onChip: (t: string) => void
  permission: PermissionVM | null
  onRespond: (d: PermissionDecision) => void
  /** 工具块内文件路径点击 → 打开到 File 窗口 */
  onOpenPath?: (p: string) => void
}

export function Transcript({ state, onChip, permission, onRespond, onOpenPath }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (el && pinned) el.scrollTop = el.scrollHeight
  })

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }

  const empty = state.turns.length === 0 && !state.errorMessage && !state.aborted

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={ref} onScroll={onScroll}>
        {empty ? (
          <div className="welcome">
            <div className="welcome-logo">◆</div>
            <h1>有什么可以帮你？</h1>
            <p>选择下方建议，或直接输入你的问题</p>
            <div className="chips">
              {CHIPS.map((c) => (
                <button key={c} className="chip raised" onClick={() => onChip(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
        ) : (
          state.turns.map((turn) => (
            <div key={turn.key} className="turn">
              {turn.blocks.map((b, i) =>
                b.kind === 'user' ? (
                  <div key={i} className="user-row">
                    <span className="user-prefix">❯</span>
                    <span className="user-text">{b.text}</span>
                    {b.images && b.images.length > 0 && (
                      <span className="user-images">
                        {b.images.map((im, k) => (
                          <img key={k} className="user-image" src={`data:${im.mimeType};base64,${im.data}`} alt="附件图片" />
                        ))}
                      </span>
                    )}
                  </div>
                ) : (
                  <div key={i} className="assistant-wrap">
                    {b.blocks.map((blk, j) =>
                      blk.type === 'text' ? (
                        blk.text ? (
                          <div key={j} className={`assistant-text md${b.streaming && j === b.blocks.length - 1 ? ' streaming' : ''}`}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                              {blk.text}
                            </ReactMarkdown>
                            {b.streaming && j === b.blocks.length - 1 && <span className="caret-blink" />}
                          </div>
                        ) : null
                      ) : (
                        <ThinkingPanel key={j} block={blk} />
                      )
                    )}
                    {b.toolCalls.map((tool) => (
                      <ToolBlock key={tool.callId} tool={tool} onOpenPath={onOpenPath} />
                    ))}
                    {b.stopReason === 'error' && b.errorMessage && <div className="error-row">✗ {b.errorMessage}</div>}
                    {b.stopReason === 'aborted' && <div className="aborted-row">⏹ 已中断</div>}
                  </div>
                )
              )}
            </div>
          ))
        )}
        {state.retryHint && <div className="retry-row mono">{state.retryHint}</div>}
        {state.notice && <div className="notice-row mono">{state.notice}</div>}
        {permission && <PermissionPrompt permission={permission} onRespond={onRespond} />}
      </div>
      {!pinned && (
        <button
          className="jump-bottom raised"
          onClick={() => {
            const el = ref.current
            if (el) {
              el.scrollTop = el.scrollHeight
              setPinned(true)
            }
          }}
        >
          ↓ 回到底部
        </button>
      )}
    </div>
  )
}

function PermissionPrompt({ permission, onRespond }: { permission: PermissionVM; onRespond: (d: PermissionDecision) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '1') onRespond('approve')
      else if (e.key === '2') onRespond('always')
      else if (e.key === '3') onRespond('deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onRespond])

  return (
    <div className="permission raised">
      <div className="permission-title">⚠ 需要授权：{permission.toolName}</div>
      <div className="permission-detail mono">{permission.detail}</div>
      <div className="permission-actions">
        <button className="btn btn-primary" onClick={() => onRespond('approve')}>
          1 批准
        </button>
        <button className="btn" onClick={() => onRespond('always')}>
          2 本会话总是允许
        </button>
        <button className="btn btn-danger" onClick={() => onRespond('deny')}>
          3 拒绝
        </button>
      </div>
    </div>
  )
}

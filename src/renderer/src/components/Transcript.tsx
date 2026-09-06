import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { PermissionVM, UiDialogVM, UIState, ViewMode } from '../state/reducer'
import type { PermissionDecision, ThinkingContent } from '@shared/types'
import { ToolBlock } from './ToolBlock'
import { CodeBlock } from './CodeBlock'
import { IconAlert, IconArrowCounterClockwise, IconChevronDown, IconCopy, IconFile, IconGitFork, IconLightbulb } from './icons'

/** 思考过程：与工具块同族的左规线行；流式期间自动展开显示「思考中」，结束后自动收起 */
function ThinkingPanel({ block, streaming }: { block: ThinkingContent; streaming: boolean }) {
  if (block.redacted) {
    return (
      <div className="thinking-panel">
        <span className="thinking-toggle static">
          <IconLightbulb size={12} className="thinking-mark" />
          思考 · 已加密
        </span>
      </div>
    )
  }
  return (
    <details className="thinking-panel" open={streaming ? true : undefined}>
      <summary className="thinking-toggle" title="模型的内部思考">
        <IconLightbulb size={12} className="thinking-mark" />
        <span className="thinking-label">{streaming ? '思考中…' : `思考 · ${block.thinking.length} 字`}</span>
        {streaming ? (
          <span className="spin-ring" />
        ) : (
          <IconChevronDown size={11} className="thinking-caret" />
        )}
      </summary>
      <div className="thinking-body mono">{block.thinking}</div>
    </details>
  )
}

const CHIPS = ['总结这份调研报告', '运行 dir 看看目录结构', '这个项目用的什么架构？']

interface Props {
  state: UIState
  sessionId: string
  /** transcript 视图模式：normal=工具折叠 / verbose=全部展开 / summary=只看正文 */
  viewMode?: ViewMode
  onChip: (t: string) => void
  permission: PermissionVM | null
  onRespond: (d: PermissionDecision) => void
  /** 扩展弹窗（ctx.ui）应答；value 随 kind：confirm=boolean，input/select=string|null，取消=null */
  onRespondUi?: (requestId: string, value: string | boolean | null) => void
  /** 工具块内文件路径点击 → 打开到 File pane */
  onOpenPath?: (p: string) => void
  /** 回到此消息（丢弃后续，切换树叶子） */
  onRewind?: (sessionId: string, nodeId: string) => void
  /** 从此消息分叉出新会话 */
  onFork?: (sessionId: string, nodeId: string) => void
  /** 打开终端面板（bash 命令条按钮） */
  onOpenTerminal?: () => void
  /** 在会话终端里执行命令（bash 命令条 ▶） */
  onRunCommand?: (command: string) => void
}

export function Transcript({ state, sessionId, viewMode = 'normal', onChip, permission, onRespond, onRespondUi, onOpenPath, onRewind, onFork, onOpenTerminal, onRunCommand }: Props) {
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
            <div className="welcome-logo">navAgent</div>
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
                b.kind === 'injected' ? (
                  <div
                    key={i}
                    className="injected-row"
                    title="文件内容已作为独立消息注入上下文；取消注入只影响之后的请求，已注入内容保留至下次压缩"
                  >
                    <IconFile size={12} />
                    <span>已注入上下文</span>
                    <span className="injected-path mono">{b.rel}</span>
                  </div>
                ) : b.kind === 'user' ? (
                  <div key={i} className="user-row">
                    <div className="user-bubble">
                      <span className="user-text">{b.text}</span>
                      {b.images && b.images.length > 0 && (
                        <span className="user-images">
                          {b.images.map((im, k) => (
                            <img key={k} className="user-image" src={`data:${im.mimeType};base64,${im.data}`} alt="附件图片" />
                          ))}
                        </span>
                      )}
                    </div>
                    {/* 动作行：copy / rewind / fork（每个用户气泡下方右侧，图标） */}
                    <div className="msg-actions">
                      <button
                        title="复制消息"
                        onClick={() => void navigator.clipboard.writeText(b.text)}
                      >
                        <IconCopy size={12} />
                      </button>
                      {b.nodeId && onRewind && (
                        <button
                          title="回到此处重新开始（丢弃此后内容）"
                          onClick={() => onRewind(sessionId, b.nodeId!)}
                        >
                          <IconArrowCounterClockwise size={12} />
                        </button>
                      )}
                      {b.nodeId && onFork && (
                        <button
                          title="从此处派生新会话"
                          onClick={() => onFork(sessionId, b.nodeId!)}
                        >
                          <IconGitFork size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="assistant-wrap">
                    {b.blocks.map((blk, j) =>
                      blk.type === 'text' ? (
                        blk.text ? (
                          <div key={j} className={`assistant-text md${b.streaming && j === b.blocks.length - 1 ? ' streaming' : ''}`}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: CodeBlock }}>
                              {blk.text}
                            </ReactMarkdown>
                            {b.streaming && j === b.blocks.length - 1 && <span className="caret-blink" />}
                          </div>
                        ) : null
                      ) : viewMode === 'summary' ? null : (
                        <ThinkingPanel key={j} block={blk} streaming={b.streaming && j === b.blocks.length - 1} />
                      )
                    )}
                    {b.toolCalls.map((tool) => (
                      <ToolBlock
                        key={tool.callId}
                        tool={tool}
                        sessionId={sessionId}
                        defaultOpen={viewMode === 'verbose'}
                        hidden={viewMode === 'summary'}
                        onOpenPath={onOpenPath}
                        onOpenTerminal={onOpenTerminal}
                        onRunCommand={onRunCommand}
                      />
                    ))}
                    {b.stopReason === 'error' && b.errorMessage && <div className="error-row">✗ {b.errorMessage}</div>}
                    {b.stopReason === 'aborted' && <div className="aborted-row">已中断</div>}
                  </div>
                )
              )}
            </div>
          ))
        )}
        {state.retryHint && <div className="retry-row mono">{state.retryHint}</div>}
        {state.notice && <div className="notice-row mono">{state.notice}</div>}
        {permission && <PermissionPrompt permission={permission} onRespond={onRespond} />}
        {state.uiDialog && onRespondUi && <ExtDialogPrompt dialog={state.uiDialog} onRespond={onRespondUi} />}
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
    <div className="permission">
      <div className="permission-head">
        <IconAlert size={13} />
        <span className="permission-title">需要授权</span>
        <span className="permission-tool mono">{permission.toolName}</span>
        <span className="permission-hint mono">1 / 2 / 3 · Esc 拒绝</span>
      </div>
      <pre className="permission-detail mono">{permission.detail}</pre>
      <div className="permission-actions">
        <button className="btn btn-primary" onClick={() => onRespond('approve')} title="批准本次执行">
          <span className="kbd">1</span>
          批准
        </button>
        <button className="btn" onClick={() => onRespond('always')} title="本会话内此工具不再询问">
          <span className="kbd">2</span>
          总是允许
        </button>
        <button className="btn btn-danger" onClick={() => onRespond('deny')} title="拒绝本次执行">
          <span className="kbd">3</span>
          拒绝
        </button>
      </div>
    </div>
  )
}

/** 扩展 GUI 弹窗（ctx.ui：confirm/input/select）；Esc=取消。复用 permission 卡样式 */
function ExtDialogPrompt({ dialog, onRespond }: { dialog: UiDialogVM; onRespond: (requestId: string, value: string | boolean | null) => void }) {
  const [value, setValue] = useState('')
  const respond = (v: string | boolean | null) => onRespond(dialog.requestId, v)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') respond(null)
      else if (dialog.kind === 'confirm' && e.key === 'Enter') respond(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog.requestId])

  return (
    <div className="permission ext-dialog">
      <div className="permission-head">
        <span className="permission-title">扩展请求</span>
        <span className="permission-tool mono">{dialog.kind}</span>
        <span className="permission-hint mono">Esc 取消</span>
      </div>
      <pre className="permission-detail mono">{dialog.title}{dialog.message ? '\n\n' + dialog.message : ''}</pre>
      {dialog.kind === 'input' && (
        <input
          className="sunken mono"
          autoFocus
          placeholder={dialog.placeholder ?? ''}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) respond(value)
          }}
        />
      )}
      <div className="permission-actions">
        {dialog.kind === 'confirm' && (
          <>
            <button className="btn btn-primary" onClick={() => respond(true)} title="允许">
              允许
            </button>
            <button className="btn btn-danger" onClick={() => respond(false)} title="拒绝">
              拒绝
            </button>
          </>
        )}
        {dialog.kind === 'input' && (
          <button className="btn btn-primary" disabled={!value.trim()} onClick={() => respond(value)} title="提交">
            提交
          </button>
        )}
        {dialog.kind === 'select' &&
          (dialog.options ?? []).map((opt: string) => (
            <button key={opt} className="btn" onClick={() => respond(opt)}>
              {opt}
            </button>
          ))}
        <button className="btn" onClick={() => respond(null)}>
          取消
        </button>
      </div>
    </div>
  )
}

import { useRef, useState } from 'react'
import type { ImageContent, ThinkingLevel } from '@shared/types'

const MAX_IMAGES = 8
const MAX_SIZE = 4 * 1024 * 1024
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

interface Props {
  draft: string
  setDraft: (t: string) => void
  working: boolean
  onSend: (t: string, images?: ImageContent[]) => void
  /** 运行中排队续跑（pi 的 Alt+Enter）：本轮 agent 结束后自动运行 */
  onFollowUp: (t: string) => void
  onCancel: () => void
  /** 当前模型名（信息条 chip，点击跳设置） */
  model: string
  /** 当前思考档位（config.modelParams.thinkingLevel；undefined = 默认档） */
  thinking: ThinkingLevel | undefined
  onSetThinking: (l: ThinkingLevel) => void
  onOpenSettings: () => void
  /** 上下文口径：contextTokensOf(usage)；null = 暂无 usage，不渲染上下文条 */
  contextTokens: number | null
  contextWindow?: number
}

function fileToImageContent(file: File): Promise<ImageContent | null> {
  return new Promise((resolve) => {
    if (!ACCEPTED.has(file.type) || file.size > MAX_SIZE) {
      resolve(null)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      resolve(base64 ? { type: 'image', data: base64, mimeType: file.type } : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

export function Composer({ draft, setDraft, working, onSend, onFollowUp, onCancel, model, thinking, onSetThinking, onOpenSettings, contextTokens, contextWindow }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [images, setImages] = useState<ImageContent[]>([])

  const addFiles = (files: FileList | File[] | null): void => {
    if (!files) return
    void Promise.all([...files].slice(0, MAX_IMAGES).map(fileToImageContent)).then((list) => {
      const valid = list.filter((im): im is ImageContent => im !== null)
      if (valid.length > 0) setImages((prev) => [...prev, ...valid].slice(0, MAX_IMAGES))
    })
  }

  const removeImage = (idx: number): void => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }

  const maybeSend = () => {
    const t = draft.trim()
    if (!working && (t || images.length > 0)) {
      onSend(t, images.length > 0 ? images : undefined)
      setImages([])
    }
  }

  /** Alt+Enter：运行中排队续跑（pi 语义）；空闲时等同普通发送 */
  const maybeFollowUp = () => {
    const t = draft.trim()
    if (!t) return
    if (working) {
      onFollowUp(t)
      setDraft('')
      const el = ref.current
      if (el) el.style.height = 'auto'
    } else {
      maybeSend()
    }
  }

  // 上下文占用百分比（>80% 信息条转警示色）
  const pct = contextTokens != null && contextWindow && contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 100) : 0

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="attachments">
          {images.map((im, i) => (
            <div key={i} className="attachment">
              <img src={`data:${im.mimeType};base64,${im.data}`} alt="待发送图片" />
              <button className="attachment-remove" onClick={() => removeImage(i)} title="移除">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-box raised">
        <button className="paperclip-btn" onClick={() => fileRef.current?.click()} title="添加图片（png/jpeg/webp/gif，≤4MB）">
          📎
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <textarea
          ref={ref}
          value={draft}
          rows={1}
          placeholder="输入消息…（Enter 发送 / Shift+Enter 换行 / Alt+Enter 排队续跑 / /compact 压缩上下文）"
          onChange={(e) => {
            setDraft(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 140) + 'px'
          }}
          onPaste={(e) => {
            const files = e.clipboardData?.files
            if (files && files.length > 0) {
              const imgs = [...files].filter((f) => ACCEPTED.has(f.type))
              if (imgs.length > 0) {
                e.preventDefault()
                addFiles(imgs)
              }
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.altKey) {
              e.preventDefault()
              maybeFollowUp()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              maybeSend()
            }
          }}
        />
        <div className="composer-meta">
          <button className="meta-chip" onClick={onOpenSettings} title="点击修改模型设置">
            {model} ▾
          </button>
          <select
            className="meta-chip thinking-active"
            value={thinking ?? ''}
            onChange={(e) => onSetThinking(e.target.value as ThinkingLevel)}
            title="思考深度（thinking level）"
          >
            <option value="">🧠 默认</option>
            {(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as ThinkingLevel[]).map((l) => (
              <option key={l} value={l}>
                🧠 {l}
              </option>
            ))}
          </select>
          {contextTokens != null && (
            <span className={`meta-ctx${pct > 80 ? ' warn' : ''}`} title="/compact 可压缩上下文">
              <span className="bar">
                <i style={{ width: `${Math.min(100, pct)}%` }} />
              </span>
              {(contextTokens / 1000).toFixed(1)}k/{((contextWindow ?? 64_000) / 1000).toFixed(0)}k
            </span>
          )}
          <span className="meta-spacer" />
        </div>
        {working ? (
          <button className="send-btn stop raised" onClick={onCancel} title="停止 (Esc)">
            ■
          </button>
        ) : (
          <button className="send-btn raised" onClick={maybeSend} disabled={!draft.trim() && images.length === 0} title="发送 (Enter)">
            ▶
          </button>
        )}
      </div>
    </div>
  )
}

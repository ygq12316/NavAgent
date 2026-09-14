import { useEffect, useRef, useState } from 'react'
import type { CommandInfo, ImageContent, PermissionMode, ThinkingLevel } from '@shared/types'
import type { SessionStats } from '../state/reducer'
import { getApi } from '../api'
import { ContextPopover } from './ContextPopover'
import { ModelPopover } from './ModelPopover'
import { ThinkingPopover } from './EffortPopover'
import { useOutsideClose } from './dock/WindowFrame'
import { IconCheck, IconChevronDown, IconClipboardText, IconFile, IconLightbulb, IconLightning, IconLockSimple, IconPaperclip, IconPencil, IconSend, IconStop } from './icons'

const MAX_IMAGES = 8
const MAX_SIZE = 4 * 1024 * 1024
const MAX_FILE = 25 * 1024 * 1024
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 非图片附件（上传到会话工作区 .navagent/attachments/，发送时正文附路径） */
interface Att {
  name: string
  size: number
  state: 'uploading' | 'ready' | 'error'
  rel?: string
  error?: string
}

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

function fmtSize(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`
}

interface Props {
  sessionId: string
  draft: string
  setDraft: (t: string) => void
  working: boolean
  onSend: (t: string, images?: ImageContent[]) => void
  /** 运行中排队续跑（pi 的 Alt+Enter）：本轮 agent 结束后自动运行 */
  onFollowUp: (t: string) => void
  onCancel: () => void
  /** 当前模型名（信息条 chip，点击跳设置） */
  model: string
  /** 全局默认模型（悬浮窗常驻「默认」选项） */
  defaultModel?: string
  /** 当前思考档位（config.modelParams.thinkingLevel；undefined = 默认档） */
  thinking: ThinkingLevel | undefined
  onSetThinking: (l: ThinkingLevel) => void
  /** 会话权限模式（Manual / Accept edits / Plan，写 meta 即时生效） */
  permissionMode: PermissionMode
  onSetMode: (m: PermissionMode) => void
  /** 点模型 chip：悬浮窗切换同 URL 下的模型 */
  onSetModel: (id: string) => void
  /** 上下文口径：contextTokensOf(usage)；null = 暂无 usage，不渲染上下文条 */
  contextTokens: number | null
  contextWindow?: number
  /** 会话累计统计（输入框底部「累计」chip，点击开上下文构成小窗；不含费用） */
  stats?: SessionStats | null
  /** AI 回答中发送新消息是否追加为续跑（默认开启，CC 对齐） */
  appendWhileRunning?: boolean
  /** 已注入上下文的文件（对话全程可见的 chip；移除走 main 注入表） */
  injectedFiles?: string[]
  onUninjectFile?: (rel: string) => void
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

interface Mention {
  query: string
  start: number
}

const MODE_OPTIONS: { value: PermissionMode; label: string; icon: typeof IconLockSimple }[] = [
  { value: 'manual', label: '审批', icon: IconLockSimple },
  { value: 'acceptEdits', label: '自动编辑', icon: IconPencil },
  { value: 'bypassPermissions', label: '跳过审批', icon: IconLightning },
  { value: 'plan', label: '计划', icon: IconClipboardText }
]

const THINKING_OPTIONS: { value: ThinkingLevel | ''; label: string }[] = [
  { value: '', label: '思考 · 厂商默认' },
  ...(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((l) => ({ value: l as ThinkingLevel | '', label: `思考 · ${l}` }))
]

/** 权限模式常驻横条：四种模式同一风格，色调区分语义 */
const MODE_STRIP: Record<PermissionMode, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'bad'; icon: typeof IconLockSimple; tip: string }> = {
  manual: { label: '审批模式', tone: 'neutral', icon: IconLockSimple, tip: '每次工具执行前请求批准' },
  acceptEdits: { label: '自动编辑模式', tone: 'ok', icon: IconPencil, tip: '文件编辑自动放行，命令执行仍需批准' },
  bypassPermissions: { label: '跳过审批模式', tone: 'bad', icon: IconLightning, tip: '所有工具自动放行，不再请求批准' },
  plan: { label: '计划模式', tone: 'warn', icon: IconClipboardText, tip: '写类工具已移除，AI 将只读探索并给出完整实施方案' }
}

/** 信息条下拉（替代原生 select 的白色菜单）：点击 chip 原地弹出深色菜单；iconOnly=仅图案（色彩表达状态） */
function ChipSelect({ icon: Icon, iconOnly, tone, value, options, onChange }: {
  icon: typeof IconLockSimple
  iconOnly?: boolean
  tone?: 'ok' | 'warn' | 'bad'
  value: string
  options: { value: string; label: string; icon?: typeof IconLockSimple }[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(() => setOpen(false))
  const current = options.find((o) => o.value === value)
  const CurrentIcon = current?.icon ?? Icon
  return (
    <div ref={ref} className="chip-anchor">
      <button
        className={`meta-chip${iconOnly ? ' icon-only' : ''}${tone ? ` tone-${tone}` : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={current?.label}
      >
        <CurrentIcon size={iconOnly ? 15 : 12} />
        {!iconOnly && <span className="meta-chip-val">{current?.label ?? ''}</span>}
        {!iconOnly && <IconChevronDown size={9} className="chip-caret" />}
      </button>
      {open && (
        <div className="meta-menu">
          {options.map((o) => {
            const OIcon = o.icon ?? Icon
            return (
              <button
                key={o.value}
                className={`meta-menu-item${o.value === value ? ' on' : ''}`}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                <OIcon size={12} className="meta-menu-icon" />
                <span>{o.label}</span>
                {o.value === value && <IconCheck size={11} className="check" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Composer(p: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [images, setImages] = useState<ImageContent[]>([])
  /** 非图片附件（上传到会话工作区） */
  const [atts, setAtts] = useState<Att[]>([])
  const [mention, setMention] = useState<Mention | null>(null)
  const [mentionSel, setMentionSel] = useState(0)
  // 上下文构成小窗：锚定信息条原地开合
  const [ctxOpen, setCtxOpen] = useState(false)
  const ctxRef = useOutsideClose(() => setCtxOpen(false))
  const toggleCtx = (): void => setCtxOpen((v) => !v)
  const [modelOpen, setModelOpen] = useState(false)
  const modelRef = useOutsideClose(() => setModelOpen(false))
  // 思考程度小窗（紫色系设计）
  const [thOpen, setThOpen] = useState(false)
  const thRef = useOutsideClose(() => setThOpen(false))
  // 斜杠命令菜单（CC 式）：/ 开头触发，选填后关闭
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [slashSel, setSlashSel] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const slashMenuOpen = /^\/[a-z0-9_-]*$/i.test(p.draft) && !slashDismissed
  const slashQuery = p.draft.slice(1).toLowerCase()
  const slashItems = slashMenuOpen ? commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery)) : []
  useEffect(() => {
    void getApi()
      .listCommands()
      .then(setCommands)
      .catch(() => undefined)
  }, [])
  const pickSlash = (c: CommandInfo): void => {
    p.setDraft(`/${c.name} `)
    setSlashSel(0)
    requestAnimationFrame(() => ref.current?.focus())
  }
  /** 会话文件清单缓存（@mention 数据源；首次 '@' 时拉取） */
  const fileListRef = useRef<{ sessionId: string; files: string[] } | null>(null)
  const [candidates, setCandidates] = useState<string[]>([])

  const addFiles = (files: FileList | File[] | null): void => {
    if (!files) return
    const list = [...files]
    // 图片：≤4MB 走视觉通道（base64 内容）
    const imgs = list.filter((f) => ACCEPTED.has(f.type) && f.size <= MAX_SIZE).slice(0, MAX_IMAGES)
    // 其他文件：上传到会话工作区附件目录（>4MB 的图片也走此通道）
    const others = list.filter((f) => !imgs.includes(f))
    if (imgs.length > 0) {
      void Promise.all(imgs.map(fileToImageContent)).then((res) => {
        const valid = res.filter((im): im is ImageContent => im !== null)
        if (valid.length > 0) setImages((prev) => [...prev, ...valid].slice(0, MAX_IMAGES))
      })
    }
    for (const f of others.slice(0, 8)) void uploadAtt(f)
  }

  /** 上传非图片附件到会话工作区；完成前 chip 呈 uploading 态 */
  const uploadAtt = async (file: File): Promise<void> => {
    if (file.size > MAX_FILE) {
      setAtts((prev) => [...prev, { name: file.name, size: file.size, state: 'error', error: '超过 25MB' }])
      return
    }
    setAtts((prev) => [...prev, { name: file.name, size: file.size, state: 'uploading' }])
    try {
      const b64 = bufToB64(await file.arrayBuffer())
      const r = await getApi().saveAttachment(p.sessionId, file.name, b64)
      setAtts((prev) =>
        prev.map((a) => (a.name === file.name && a.state === 'uploading' ? { ...a, state: r.ok ? 'ready' : 'error', rel: r.path, error: r.error } : a))
      )
    } catch (err) {
      setAtts((prev) =>
        prev.map((a) => (a.name === file.name && a.state === 'uploading' ? { ...a, state: 'error', error: err instanceof Error ? err.message : String(err) } : a))
      )
    }
  }

  const removeImage = (idx: number): void => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }

  /** '@' 触发：定位光标前的 @token，更新候选（CJK 前缀也算触发位：\w 不含全角字符） */
  const updateMention = (text: string, caret: number): void => {
    const before = text.slice(0, caret)
    const m = /(^|[^\w@])@([^\s@]*)$/.exec(before)
    if (!m || m.index === undefined) {
      setMention(null)
      setCandidates([])
      return
    }
    const query = m[2] ?? ''
    const start = before.length - query.length - 1
    setMention({ query, start })
    const cached = fileListRef.current?.sessionId === p.sessionId ? fileListRef.current.files : null
    if (cached) {
      const q = query.toLowerCase()
      setCandidates(cached.filter((f) => f.toLowerCase().includes(q)).slice(0, 8))
      setMentionSel(0)
      return
    }
    void getApi()
      .globFiles(p.sessionId, '**/*')
      .then((files) => {
        fileListRef.current = { sessionId: p.sessionId, files }
        const q = query.toLowerCase()
        setCandidates(files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8))
        setMentionSel(0)
      })
      .catch(() => setCandidates([]))
  }

  const applyMention = (path: string): void => {
    if (!mention) return
    const el = ref.current
    const caret = el?.selectionStart ?? p.draft.length
    const next = p.draft.slice(0, mention.start) + '@' + path + ' ' + p.draft.slice(caret)
    p.setDraft(next)
    setMention(null)
    setCandidates([])
    requestAnimationFrame(() => {
      const pos = mention.start + path.length + 2
      el?.setSelectionRange(pos, pos)
      el?.focus()
    })
  }

  const maybeSend = () => {
    const ready = atts.filter((a) => a.state === 'ready' && a.rel)
    const t0 = p.draft.trim()
    const t = ready.length > 0 ? `${t0 ? t0 + '\n' : ''}${ready.map((a) => `[附件] ${a.rel}`).join('\n')}` : t0
    if (!t && images.length === 0) return
    // AI 回答中：按设置决定是否追加为续跑（默认追加，CC 对齐）
    if (p.working) {
      if (p.appendWhileRunning ?? true) {
        p.onFollowUp(t)
        p.setDraft('')
        const el = ref.current
        if (el) el.style.height = 'auto'
      }
      return
    }
    p.onSend(t, images.length > 0 ? images : undefined)
    setImages([])
    setAtts((prev) => prev.filter((a) => a.state === 'uploading'))
  }

  /** Alt+Enter：运行中排队续跑（pi 语义）；空闲时等同普通发送 */
  const maybeFollowUp = () => {
    const t = p.draft.trim()
    if (!t) return
    if (p.working) {
      p.onFollowUp(t)
      p.setDraft('')
      const el = ref.current
      if (el) el.style.height = 'auto'
    } else {
      maybeSend()
    }
  }

  useEffect(() => {
    // 切会话后失效 mention 缓存并清空附件
    if (fileListRef.current?.sessionId !== p.sessionId) {
      fileListRef.current = null
      setMention(null)
      setCandidates([])
    }
  }, [p.sessionId])

  // 切会话清空附件草稿
  useEffect(() => {
    setAtts([])
    setImages([])
  }, [p.sessionId])

  // 上下文占用百分比（>80% 信息条转警示色）。大窗口（如 1M）下整数百分比会把 <1% 全抹成 0：
  // ≥10 取整、<10 保留一位小数、<0.1 显示 "<0.1"，保证只要有真实占用就不显示 0%
  const pctRaw = p.contextTokens != null && p.contextWindow && p.contextWindow > 0 ? (p.contextTokens / p.contextWindow) * 100 : 0
  const pctText = pctRaw >= 10 ? `${Math.round(pctRaw)}` : pctRaw >= 0.1 ? pctRaw.toFixed(1) : pctRaw > 0 ? '<0.1' : '0'
  const pct = pctRaw
  const cumulative = p.stats ? p.stats.inputTokens + p.stats.outputTokens : null
  // chip 只在 usage 已知时渲染（压缩后 usage 短暂未知 → 暂时隐藏，而不是显示假 0%）
  const hasUsage = p.contextTokens != null
  const cumulativeText = cumulative != null ? (cumulative >= 1000 ? `${(cumulative / 1000).toFixed(1)}k` : String(cumulative)) : null
  const ctxTitle = `上下文 ${pctText}%（${((p.contextTokens ?? 0) / 1000).toFixed(1)}k / ${((p.contextWindow ?? 64_000) / 1000).toFixed(0)}k）${
    cumulativeText ? ` · 累计 ${cumulativeText} tok` : ''
  }，点击查看构成`

  return (
    <div className="composer">
      {(() => {
        const strip = MODE_STRIP[p.permissionMode]
        if (!strip) return null
        const SIcon = strip.icon
        return (
          <div className={`mode-strip tone-${strip.tone}`} title={strip.tip}>
            <SIcon size={12} />
            <span>{strip.label}</span>
          </div>
        )
      })()}
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
      {atts.length > 0 && (
        <div className="attachments att-files">
          {atts.map((a, i) => (
            <div key={`${a.name}:${i}`} className={`att-file ${a.state}`} title={a.rel ?? `${a.name}${a.error ? `（${a.error}）` : ''}`}>
              <IconFile size={13} className="att-file-icon" />
              <span className="att-file-name">{a.name}</span>
              <span className="att-file-size mono">{fmtSize(a.size)}</span>
              {a.state === 'uploading' ? (
                <span className="spin-ring" />
              ) : a.state === 'error' ? (
                <span className="att-file-err">{a.error ?? '失败'}</span>
              ) : (
                <IconCheck size={11} className="att-file-ok" />
              )}
              <button className="attachment-remove" onClick={() => setAtts((prev) => prev.filter((_, j) => j !== i))} title="移除">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {p.injectedFiles && p.injectedFiles.length > 0 && (
        <div className="attachments att-files">
          {p.injectedFiles.map((rel) => (
            <div key={rel} className="att-file" title="已注入上下文（对话全程可见）">
              <IconFile size={13} className="att-file-icon" />
              <span className="att-file-name">{rel}</span>
              <button className="attachment-remove" onClick={() => p.onUninjectFile?.(rel)} title="移除（不再注入上下文）">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-box">
        <div className="composer-input-row">
          <div className="composer-input-wrap">
            <textarea
            ref={ref}
            value={p.draft}
            rows={1}
            placeholder="输入消息…"
            onChange={(e) => {
              p.setDraft(e.target.value)
              setSlashDismissed(false)
              setSlashSel(0)
              const el = e.target
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 140) + 'px'
              updateMention(e.target.value, el.selectionStart ?? 0)
            }}
            onPaste={(e) => {
              const files = e.clipboardData?.files
              if (files && files.length > 0) {
                e.preventDefault()
                addFiles(files)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && ctxOpen) {
                e.preventDefault()
                // 阻断冒泡：App 的 window 级 Esc 会取消运行中的 agent
                e.stopPropagation()
                setCtxOpen(false)
                return
              }
              if (e.key === 'Escape' && slashMenuOpen) {
                e.preventDefault()
                e.stopPropagation()
                setSlashDismissed(true)
                return
              }
              if (e.key === 'Escape' && mention) {
                e.preventDefault()
                e.stopPropagation()
                setMention(null)
                return
              }
              if (slashMenuOpen && slashItems.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSlashSel((i) => (i + 1) % slashItems.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSlashSel((i) => (i - 1 + slashItems.length) % slashItems.length)
                  return
                }
                if (e.key === 'Tab' || e.key === 'Enter') {
                  e.preventDefault()
                  pickSlash(slashItems[slashSel] ?? slashItems[0]!)
                  return
                }
              }
              if (mention && candidates.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionSel((i) => (i + 1) % candidates.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionSel((i) => (i - 1 + candidates.length) % candidates.length)
                  return
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.altKey)) {
                  e.preventDefault()
                  applyMention(candidates[mentionSel] ?? candidates[0]!)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMention(null)
                  return
                }
              }
              // IME 组字中：Enter 是选词确认，不是发送（keyCode 229 = 组字中的键事件）
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
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
          {slashMenuOpen && slashItems.length > 0 && (
            <div className="mention-pop cmd-pop">
              {slashItems.map((c, i) => (
                <button
                  key={c.name}
                  className={`cmd-item${i === slashSel ? ' on' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickSlash(c)
                  }}
                >
                  <span className="cmd-name mono">/{c.name}</span>
                  <span className="cmd-desc">{c.description}</span>
                </button>
              ))}
            </div>
          )}
          {mention && candidates.length > 0 && (
            <div className="mention-pop">
              {candidates.map((f, i) => {
                const name = f.split('/').pop() ?? f
                const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''
                return (
                  <button
                    key={f}
                    className={`mention-item${i === mentionSel ? ' on' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      applyMention(f)
                    }}
                  >
                    <span className="mention-name">{name}</span>
                    {dir && <span className="mention-dir mono">{dir}</span>}
                  </button>
                )
              })}
            </div>
          )}
          </div>
          {p.working ? (
            <button className="send-btn stop" onClick={p.onCancel} title="停止 (Esc)">
              <IconStop size={15} />
            </button>
          ) : (
            <button className="send-btn" onClick={maybeSend} disabled={!p.draft.trim() && images.length === 0} title="发送 (Enter)">
              <IconSend size={15} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-meta">
        <span ref={modelRef} className="chip-anchor">
          <button className="meta-chip" onClick={() => setModelOpen((v) => !v)} title="切换模型（同 URL 下可用列表）">
            <span className="meta-chip-val mono">{p.model}</span>
            <IconChevronDown size={9} className="chip-caret" />
          </button>
          {modelOpen && (
            <ModelPopover
              model={p.model}
              defaultModel={p.defaultModel}
              onPick={(id) => {
                p.onSetModel(id)
                setModelOpen(false)
              }}
            />
          )}
        </span>
        <ChipSelect
          icon={IconLockSimple}
          iconOnly
          tone={p.permissionMode === 'acceptEdits' ? 'ok' : p.permissionMode === 'bypassPermissions' ? 'bad' : p.permissionMode === 'plan' ? 'warn' : undefined}
          value={p.permissionMode}
          options={MODE_OPTIONS}
          onChange={(v) => p.onSetMode(v as PermissionMode)}
        />
        <div ref={thRef} className="chip-anchor">
          <button
            className={`meta-chip icon-only${p.thinking ? ' tone-th' : ''}`}
            onClick={() => setThOpen((v) => !v)}
            title={THINKING_OPTIONS.find((o) => o.value === (p.thinking ?? ''))?.label}
          >
            <IconLightbulb size={15} />
          </button>
          {thOpen && <ThinkingPopover value={p.thinking ?? ''} onChange={(v) => p.onSetThinking(v as ThinkingLevel)} />}
        </div>
          <span className="meta-spacer" />
          <span ref={ctxRef} className="ctx-anchor">
            {hasUsage && (
              <button className={`meta-chip${pct > 80 ? ' tone-warn' : ''}`} onClick={toggleCtx} title={ctxTitle}>
                {pctText}%
              </button>
            )}
            {ctxOpen && <ContextPopover sessionId={p.sessionId} model={p.model} contextTokens={p.contextTokens} contextWindow={p.contextWindow} stats={p.stats} />}
          </span>
          <button className="paperclip-btn" onClick={() => fileRef.current?.click()} title="添加附件（图片走视觉；其他文件放入会话工作区，≤25MB）">
            <IconPaperclip size={15} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />
      </div>
    </div>
  )
}

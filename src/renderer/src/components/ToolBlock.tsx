import { memo, useState } from 'react'
import type { ToolVM } from '../state/reducer'
import { getApi } from '../api'
import { DiffView } from './DiffView'
import { useOutsideClose } from './dock/WindowFrame'
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCopy,
  IconFile,
  IconFolderOpen,
  IconGitDiff,
  IconHourglass,
  IconPencil,
  IconPlay,
  IconProhibit,
  IconSearch,
  IconTerminal,
  IconWrench
} from './icons'

function summarize(tool: ToolVM): string {
  try {
    const args = JSON.parse(tool.args) as Record<string, unknown>
    if (typeof args.path === 'string') return args.path
    if (typeof args.command === 'string') return args.command
    if (typeof args.pattern === 'string') return args.pattern
    return tool.args
  } catch {
    return tool.args
  }
}

/** path 参数可点开的工具（点击唤起 File pane） */
const PATH_TOOLS = new Set(['read_file', 'edit_file', 'write_file'])

/** 工具身份图标：一眼区分工具类型（未列出的兜底扳手） */
const TOOL_ICONS: Record<string, typeof IconWrench> = {
  read_file: IconFile,
  write_file: IconPencil,
  edit_file: IconGitDiff,
  bash: IconTerminal,
  glob: IconSearch,
  list_dir: IconFolderOpen
}

/** 行尾状态图标（运行中 = 旋转环） */
function StatusIcon({ status }: { status: ToolVM['status'] }) {
  if (status === 'streaming' || status === 'running') return <span className="spin-ring" />
  if (status === 'awaiting_approval') return <IconHourglass size={12} />
  if (status === 'ok') return <IconCheck size={12} />
  if (status === 'error') return <IconClose size={12} />
  return <IconProhibit size={12} />
}

const STATUS_TEXT: Record<ToolVM['status'], string> = {
  streaming: '生成参数中…',
  awaiting_approval: '等待审批…',
  running: '执行中…',
  ok: '成功',
  error: '失败',
  denied: '已拒绝'
}

interface Props {
  tool: ToolVM
  sessionId: string
  /** 默认展开工具结果（Verbose 视图模式） */
  defaultOpen?: boolean
  /** 视图模式 summary 下隐藏工具行 */
  hidden?: boolean
  onOpenPath?: (p: string) => void
  /** 打开终端面板（bash 命令条按钮） */
  onOpenTerminal?: () => void
  /** 在会话终端里执行命令（bash 命令条 ▶） */
  onRunCommand?: (command: string) => void
}

/** memo 按字段比较：流式 message_update 会为全部 ToolVM 重建对象（引用恒变），
 *  未变化的工具行（历史绝大多数）靠字段相等跳过重渲染；回调 props 语义稳定（按 sid 闭包）故意忽略 */
export const ToolBlock = memo(function ToolBlock({ tool, sessionId, defaultOpen = false, hidden = false, onOpenPath, onOpenTerminal, onRunCommand }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const [copied, setCopied] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useOutsideClose(() => setMenu(null))
  const spinning = tool.status === 'streaming' || tool.status === 'running'
  const pending = spinning || tool.status === 'awaiting_approval'
  const preview = (tool.result ?? '').split('\n')[0] ?? ''
  const truncated = (tool.result ?? '').includes('\n')
  const lineCount = tool.result ? tool.result.split('\n').length : 0
  // path 工具：解析出 path 参数用于可点展示
  const argsPath = ((): string | null => {
    try {
      const a = JSON.parse(tool.args) as Record<string, unknown>
      return typeof a.path === 'string' ? a.path : null
    } catch {
      return null
    }
  })()
  const Ident = TOOL_ICONS[tool.name] ?? IconWrench
  // bash 原始命令：普通工具行也提供「在终端中运行」入口（终端重跑/长命令转终端）
  const rawCommand = ((): string | null => {
    if (tool.name !== 'bash') return null
    try {
      const a = JSON.parse(tool.args) as { command?: unknown }
      return typeof a.command === 'string' && a.command ? a.command : null
    } catch {
      return null
    }
  })()
  const runInTerminal = (e: React.MouseEvent): void => {
    if (!rawCommand) return
    e.stopPropagation()
    onOpenTerminal?.()
    onRunCommand?.(rawCommand)
  }

  if (hidden) return null

  const openMenu = (e: React.MouseEvent): void => {
    if (!argsPath) return
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const copyResult = (): void => {
    void navigator.clipboard.writeText(tool.result ?? '').then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  // bash 命令胶囊：由 AI 判断——模型在 args 里置 interactive=true 的命令才显示（dev server/用户想自己跑的命令）
  const command = ((): string | null => {
    if (tool.name !== 'bash') return null
    try {
      const a = JSON.parse(tool.args) as { interactive?: unknown }
      return a.interactive === true ? summarize(tool) : null
    } catch {
      return null
    }
  })()
  const copyCommand = (): void => {
    if (!command) return
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  if (hidden) return null

  if (command !== null) {
    return (
      <div className={`tool-block tool-bash tool-${tool.status}`}>
        <div
          className="bash-chip"
          role="button"
          onClick={() => tool.result && setOpen((v) => !v)}
          title={tool.result ? '点击查看输出' : undefined}
        >
          <span className="bash-cmd mono">{command}</span>
          <span className="bash-actions">
            {spinning ? (
              <span className="spin-ring" />
            ) : (
              <button
                className="bash-act"
                title="在终端中运行"
                onClick={(e) => {
                  e.stopPropagation()
                  onRunCommand?.(command)
                }}
              >
                <IconPlay size={13} />
              </button>
            )}
            <button
              className="bash-act"
              title="打开终端面板"
              onClick={(e) => {
                e.stopPropagation()
                onOpenTerminal?.()
              }}
            >
              <IconTerminal size={13} />
            </button>
            <button className="bash-act" title="复制命令" onClick={(e) => { e.stopPropagation(); copyCommand() }}>
              {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            </button>
          </span>
        </div>
        {pending && <div className="tool-hint mono">{STATUS_TEXT[tool.status]}</div>}
        {tool.result && !open && (
          <div className={`tool-hint mono${tool.status === 'denied' || tool.status === 'error' ? ' hint-bad' : ''}`}>
            {preview}
            {truncated ? ' …' : ''}
          </div>
        )}
        {tool.result && open && (
          <div className="tool-result-wrap">
            <div className="tool-result-head">
              <span className="tool-result-meta mono">
                {STATUS_TEXT[tool.status]}
                {lineCount > 0 ? ` · ${lineCount} 行` : ''}
              </span>
              <button className="tool-result-copy" onClick={copyResult} title="复制结果">
                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
              </button>
            </div>
            <pre className="tool-result mono">{tool.result}</pre>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`tool-block tool-${tool.status}`}>
      <button className="tool-row" onClick={() => tool.result && setOpen((v) => !v)} onContextMenu={openMenu}>
        <span className="tool-ident">
          <Ident size={13} />
        </span>
        <span className="tool-name">{tool.name}</span>
        {PATH_TOOLS.has(tool.name) && argsPath ? (
          <span className="tool-args mono clickable" onClick={() => onOpenPath?.(argsPath)} onContextMenu={openMenu} title="点击在 File pane 打开；右键更多操作">
            {argsPath}
          </span>
        ) : (
          <span className="tool-args mono">{summarize(tool)}</span>
        )}
        <span className={`tool-status st-${tool.status}`}>
          <StatusIcon status={tool.status} />
        </span>
        {tool.result && (
          <span className="tool-caret">
            {open ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
          </span>
        )}
      </button>
      {pending && (
        <div className="tool-hint mono">
          {STATUS_TEXT[tool.status]}
          {rawCommand && (
            <button className="bash-act tool-term-run" title="在终端中运行此命令" onClick={runInTerminal}>
              <IconPlay size={12} />
            </button>
          )}
        </div>
      )}
      {!pending && tool.updates.length > 0 && !tool.result && (
        <div className="tool-hint mono">{tool.updates[tool.updates.length - 1]}</div>
      )}
      {tool.result && !open && (
        <div className={`tool-hint mono${tool.status === 'denied' || tool.status === 'error' ? ' hint-bad' : ''}`}>
          {preview}
          {truncated ? ' …' : ''}
          {rawCommand && (
            <button className="bash-act tool-term-run" title="在终端中运行此命令" onClick={runInTerminal}>
              <IconPlay size={12} />
            </button>
          )}
        </div>
      )}
      {tool.result && open && (
        <div className="tool-result-wrap">
          <div className="tool-result-head">
            <span className="tool-result-meta mono">
              {STATUS_TEXT[tool.status]}
              {lineCount > 0 ? ` · ${lineCount} 行` : ''}
            </span>
            <button className="tool-result-copy" onClick={copyResult} title="复制结果">
              {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            </button>
          </div>
          {tool.name === 'edit_file' && tool.result.includes('@@') ? (
            <DiffView text={tool.result} />
          ) : (
            <pre className="tool-result mono">{tool.result}</pre>
          )}
        </div>
      )}
      {menu && argsPath && (
        <div ref={menuRef} className="ctx-menu raised" style={{ left: menu.x, top: menu.y }}>
          <button
            className="ctx-item"
            onClick={() => {
              void navigator.clipboard.writeText(argsPath)
              setMenu(null)
            }}
          >
            复制路径
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              void getApi().revealPath(sessionId, argsPath)
              setMenu(null)
            }}
          >
            在资源管理器显示
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              onOpenPath?.(argsPath)
              setMenu(null)
            }}
          >
            在 File pane 打开
          </button>
        </div>
      )}
    </div>
  )
}, (a, b) =>
  a.tool.name === b.tool.name &&
  a.tool.args === b.tool.args &&
  a.tool.status === b.tool.status &&
  a.tool.result === b.tool.result &&
  a.tool.updates === b.tool.updates &&
  a.sessionId === b.sessionId &&
  a.defaultOpen === b.defaultOpen &&
  a.hidden === b.hidden
)

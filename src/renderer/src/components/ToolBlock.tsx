import { useState } from 'react'
import type { ToolVM } from '../state/reducer'

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

/** path 参数可点开的工具（点击唤起 File 窗口） */
const PATH_TOOLS = new Set(['read_file', 'edit_file', 'write_file'])

const STATUS_ICON: Record<ToolVM['status'], string> = {
  streaming: '⠙',
  awaiting_approval: '⏳',
  running: '⠙',
  ok: '✓',
  error: '✗',
  denied: '⊘'
}

export function ToolBlock({ tool, onOpenPath }: { tool: ToolVM; onOpenPath?: (p: string) => void }) {
  const [open, setOpen] = useState(false)
  const spinning = tool.status === 'streaming' || tool.status === 'running'
  const pending = spinning || tool.status === 'awaiting_approval'
  const preview = (tool.result ?? '').split('\n')[0] ?? ''
  const truncated = (tool.result ?? '').includes('\n')
  // path 工具：解析出 path 参数用于可点展示
  const argsPath = ((): string | null => {
    try {
      const a = JSON.parse(tool.args) as Record<string, unknown>
      return typeof a.path === 'string' ? a.path : null
    } catch {
      return null
    }
  })()

  return (
    <div className={`tool-block tool-${tool.status}`}>
      <button className="tool-row" onClick={() => tool.result && setOpen((v) => !v)}>
        <span className={`tool-icon${spinning ? ' spin' : ''}`}>{STATUS_ICON[tool.status]}</span>
        <span className="tool-name">{tool.name}</span>
        {PATH_TOOLS.has(tool.name) && argsPath ? (
          <span className="tool-args mono clickable" onClick={() => onOpenPath?.(argsPath)} title="在 File 窗口打开">
            {argsPath}
          </span>
        ) : (
          <span className="tool-args mono">{summarize(tool)}</span>
        )}
        {tool.result && <span className="tool-toggle">{open ? '收起' : '展开'}</span>}
      </button>
      {pending && (
        <div className="tool-hint mono">
          ⎿ {tool.status === 'streaming' ? '生成参数中…' : tool.status === 'awaiting_approval' ? '等待审批…' : '执行中…'}
        </div>
      )}
      {!pending && tool.updates.length > 0 && !tool.result && (
        <div className="tool-hint mono">⎿ {tool.updates[tool.updates.length - 1]}</div>
      )}
      {tool.result && !open && (
        <div className={`tool-hint mono${tool.status === 'denied' || tool.status === 'error' ? ' hint-bad' : ''}`}>
          ⎿ {preview}
          {truncated ? ' …' : ''}
        </div>
      )}
      {tool.result && open && (tool.name === 'edit_file' && tool.result.includes('@@') ? <DiffView text={tool.result} /> : <pre className="tool-result sunken mono">{tool.result}</pre>)}
    </div>
  )
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  return 'diff-ctx'
}

function DiffView({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="tool-result sunken mono diff">
      {lines.map((l, i) => (
        <div key={i} className={diffLineClass(l)}>
          {l.length > 0 ? l : ' '}
        </div>
      ))}
    </div>
  )
}

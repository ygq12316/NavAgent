import { createInterface } from 'node:readline'
import type { ImageContent } from '@shared/types'

/**
 * --json CLI 模式（对齐 pi --mode json）：
 * 无 GUI，stdin 读 JSONL 指令，stdout 写会话头 + AgentEvent 事件流（事件对象均为纯 JSON）。
 * 首行 = {"type":"session",...}，其后每行一个事件；stdin EOF / exit 指令 → 退出。
 */

export interface JsonPromptCommand {
  type: 'prompt'
  text: string
  images?: ImageContent[]
}
export type JsonCommand =
  | JsonPromptCommand
  | { type: 'steer' | 'follow_up'; text: string }
  | { type: 'abort' | 'compact' | 'exit' }

export interface JsonCommandParseResult {
  ok: boolean
  cmd?: JsonCommand
  error?: string
}

/** 单行指令解析（纯函数可测）：非法 JSON / 未知类型 / 字段缺失返回 ok:false */
export function parseJsonCommandLine(line: string): JsonCommandParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, error: '无效 JSON' }
  }
  if (typeof raw !== 'object' || raw === null || typeof (raw as Record<string, unknown>).type !== 'string') {
    return { ok: false, error: '缺少 type 字段' }
  }
  const cmd = raw as Record<string, unknown>
  switch (cmd.type) {
    case 'prompt': {
      const images = Array.isArray(cmd.images)
        ? (cmd.images.filter((im) => typeof (im as ImageContent)?.data === 'string' && typeof (im as ImageContent)?.mimeType === 'string') as ImageContent[])
        : undefined
      return {
        ok: true,
        cmd: { type: 'prompt', text: typeof cmd.text === 'string' ? cmd.text : '', ...(images && images.length ? { images } : {}) }
      }
    }
    case 'steer':
    case 'follow_up':
      if (typeof cmd.text !== 'string' || cmd.text.trim().length === 0) return { ok: false, error: `${cmd.type} 需要 text` }
      return { ok: true, cmd: { type: cmd.type, text: cmd.text } }
    case 'abort':
    case 'compact':
    case 'exit':
      return { ok: true, cmd: { type: cmd.type } }
    default:
      return { ok: false, error: `未知指令：${String(cmd.type)}` }
  }
}

export function isJsonMode(argv: string[] = process.argv): boolean {
  return argv.includes('--json')
}

export interface JsonModeDeps {
  agent: Pick<import('../agent/agent').Agent, 'prompt' | 'steer' | 'followUp' | 'abort' | 'compact' | 'reset' | 'running'>
  store: import('../agent/session-store').SessionStore
  /** 预创建的会话（index.ts 已 buildSession 绑定 emit） */
  sessionId: string
  writeLine: (line: string) => void
  model: () => string
  workspace: () => string
  onQuit: () => void
}

export async function runJsonMode(deps: JsonModeDeps): Promise<void> {
  const { agent, store, writeLine, onQuit } = deps
  const ws = deps.workspace() || process.cwd()
  const meta = store.getMeta(deps.sessionId)
  agent.reset()
  writeLine(JSON.stringify({ type: 'session', version: 1, id: meta?.id, cwd: ws, model: meta?.model ?? deps.model() }))

  let closing = false
  const finish = (): void => {
    if (closing) return
    closing = true
    onQuit()
  }

  const rl = createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    const parsed = parseJsonCommandLine(t)
    if (!parsed.ok || !parsed.cmd) {
      writeLine(JSON.stringify({ type: 'notice', message: `指令被忽略：${parsed.error ?? '未知错误'}` }))
      return
    }
    const cmd = parsed.cmd
    switch (cmd.type) {
      case 'prompt': {
        if (agent.running) {
          writeLine(JSON.stringify({ type: 'notice', message: 'busy：当前已有任务在运行，可用 steer 插话' }))
          return
        }
        void agent.prompt(cmd.text, cmd.images).then((r) => {
          if (r === 'busy') writeLine(JSON.stringify({ type: 'notice', message: 'busy' }))
        })
        return
      }
      case 'steer':
        agent.steer(cmd.text)
        return
      case 'follow_up':
        agent.followUp(cmd.text)
        return
      case 'abort':
        agent.abort()
        return
      case 'compact':
        void agent.compact()
        return
      case 'exit':
        rl.close()
        finish()
        return
    }
  })
  rl.on('close', () => finish())
}

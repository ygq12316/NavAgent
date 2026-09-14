import * as pty from 'node-pty'
import type { UiEvent } from '@shared/types'
import type { ToolResult } from '../tools/registry'

export interface PtyCallbacks {
  onData: (id: string, chunk: string) => void
  onExit: (id: string, exitCode: number) => void
}

/** 真终端服务：每个终端一个 PTY 会话；永不 throw（spawn 失败返回 null，UI 呈错误态）。
 *  输出进环形缓冲（pane 关闭后 PTY 继续跑，重开时 pty:replay 回放；保尾不保头）。
 *  会话维度索引（sessionPtys）：agent bash 经 ensure/execInPty 在「点出来的那个终端」里执行。 */
export class TerminalService {
  private terms = new Map<string, pty.IPty>()
  private buffers = new Map<string, string[]>()
  private bufferLens = new Map<string, number>()
  private sessionOf = new Map<string, string>()
  private sessionPtys = new Map<string, Set<string>>()
  private shells = new Map<string, 'powershell' | 'bash'>()
  private captureTaps = new Map<string, Set<(chunk: string) => void>>()
  /** pty.spawn 是同步调用且 conpty 在启动窗口期可能竞态：同一时刻只允许一个创建（并发入口返回 null 由调用侧重试） */
  private spawning = false
  private static BUFFER_CAP = 200_000
  private emit: (e: UiEvent) => void

  constructor(emit: (e: UiEvent) => void) {
    this.emit = emit
  }

  create(cwd: string, sessionId: string): string | null {
    if (this.spawning) return null
    this.spawning = true
    try {
      const isWin = process.platform === 'win32'
      const shell = isWin ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash')
      const id = `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as Record<string, string>
      })
      this.buffers.set(id, [])
      this.bufferLens.set(id, 0)
      this.shells.set(id, isWin ? 'powershell' : 'bash')
      this.sessionOf.set(id, sessionId)
      if (!this.sessionPtys.has(sessionId)) this.sessionPtys.set(sessionId, new Set())
      this.sessionPtys.get(sessionId)!.add(id)
      term.onData((chunk) => {
        this.pushBuffer(id, chunk)
        this.emit({ type: 'pty_data', id, sessionId, chunk })
        const taps = this.captureTaps.get(id)
        if (taps) for (const tap of taps) tap(chunk)
      })
      term.onExit(({ exitCode }) => {
        // 缓冲保留：pane 重开仍可回放最终输出；kill/killAll 时才清
        this.terms.delete(id)
        this.captureTaps.delete(id)
        this.sessionPtys.get(sessionId)?.delete(id)
        this.emit({ type: 'pty_exit', id, sessionId, exitCode })
      })
      this.terms.set(id, term)
      return id
    } catch {
      return null
    } finally {
      this.spawning = false
    }
  }

  private pushBuffer(id: string, chunk: string): void {
    const buf = this.buffers.get(id)
    if (!buf) return
    buf.push(chunk)
    const len = (this.bufferLens.get(id) ?? 0) + chunk.length
    if (len <= TerminalService.BUFFER_CAP) {
      this.bufferLens.set(id, len)
      return
    }
    let dropLen = 0
    let i = 0
    while (i < buf.length && len - dropLen > TerminalService.BUFFER_CAP) {
      dropLen += buf[i]!.length
      i++
    }
    buf.splice(0, i)
    this.bufferLens.set(id, len - dropLen)
  }

  /** 会话当前存活的 PTY id（第一个 = 主终端） */
  ptysOf(sessionId: string): string[] {
    return [...(this.sessionPtys.get(sessionId) ?? [])]
  }

  /** 会话无存活终端时自动创建一个（pane 关闭也能跑；重开回放）。
   *  创建入口互斥：spawn 被占用时轮询等待（最多 6s），避免并发 conpty 分配挂死。 */
  async ensure(sessionId: string, cwd: string): Promise<string | null> {
    const alive = this.ptysOf(sessionId)
    if (alive.length > 0) return alive[0]!
    let id = this.create(cwd, sessionId)
    const deadline = Date.now() + 6_000
    while (!id && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      id = this.ptysOf(sessionId)[0] ?? this.create(cwd, sessionId)
    }
    return id
  }

  /** 向会话终端写入一行命令并回车（前端命令条 ▶ 按钮）；输出经 pty_data 实时回流到面板 */
  async runCommand(sessionId: string, command: string, cwd: string): Promise<'ok' | 'no-terminal'> {
    const id = await this.ensure(sessionId, cwd)
    if (!id) return 'no-terminal'
    const oneLine = command.replace(/\r?\n/g, ' && ')
    this.write(id, `${oneLine}\r`)
    return 'ok'
  }

  /** 等待 shell 就绪：缓冲末尾出现提示符（PS …> / $ / #）——PSReadLine 初始化期写入会被吞掉 */
  private waitReady(id: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve) => {
      const poll = (): void => {
        if (signal.aborted || Date.now() > deadline) return resolve()
        const buf = (this.buffers.get(id) ?? []).join('')
        if (buf.length > 0 && /(>|#|\$)\s?$/.test(buf.slice(-60))) return resolve()
        setTimeout(poll, 100)
      }
      poll()
    })
  }

  /** pane 重开回放：返回缓冲全文（含 ANSI 序列，xterm 直接 write） */
  replay(id: string): string {
    return (this.buffers.get(id) ?? []).join('')
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const c = Math.max(2, Math.min(500, Math.round(cols)))
    const r = Math.max(2, Math.min(300, Math.round(rows)))
    this.terms.get(id)?.resize(c, r)
  }

  kill(id: string): void {
    this.terms.get(id)?.kill()
    this.terms.delete(id)
    this.buffers.delete(id)
    this.bufferLens.delete(id)
    this.sessionPtys.get(this.sessionOf.get(id) ?? '')?.delete(id)
    this.sessionOf.delete(id)
  }

  killAll(): void {
    for (const t of this.terms.values()) {
      try {
        t.kill()
      } catch {
        /* 已退出忽略 */
      }
    }
    this.terms.clear()
    this.buffers.clear()
    this.bufferLens.clear()
    this.sessionPtys.clear()
    this.sessionOf.clear()
  }

  /** 在指定 PTY 里执行命令（agent bash 调用点出来的终端）：
   *  先等 shell 就绪；标记与命令拼在同一行（PSReadLine 会吞掉快速连发的第二行），
   *  捕获流直到出现展开后的标记（含退出码）。超时/中止发 Ctrl+C。永不 throw。
   *  opts.waitExit=false（interactive 长驻命令）：观察窗到点即返回"仍在运行"，
   *  不发 Ctrl+C——命令（dev server 等）在终端里继续跑，快命令仍会提前经标记返回。 */
  async execInPty(id: string, command: string, timeoutMs: number, signal: AbortSignal, opts: { waitExit?: boolean } = {}): Promise<ToolResult> {
    const waitExit = opts.waitExit !== false
    const term = this.terms.get(id)
    const shell = this.shells.get(id) ?? 'bash'
    if (!term) return { content: '（终端已退出，无法执行）', isError: true }
    await this.waitReady(id, signal, 15_000)
    await new Promise((r) => setTimeout(r, 250))
    const n = Math.random().toString(36).slice(2, 10)
    const MARK = `__NAVAGENT_DONE_${n}`
    // 标记拼在同一行：命令结束后同语句输出 __NAVAGENT_DONE_<n>_<退出码>；回显里 $LASTEXITCODE 未展开（无数字），不会误配。
    // $LASTEXITCODE 在纯 cmdlet 命令后为空 → $()+0 强制数值，保证标记行始终带可匹配的退出码
    const oneLine = command.replace(/\r?\n/g, '; ')
    const fullLine =
      shell === 'powershell'
        ? `${oneLine}; Write-Host "${MARK}_$($LASTEXITCODE + 0)"`
        : `${oneLine}; echo "${MARK}_$?"`
    return new Promise((resolve) => {
      const captured: string[] = []
      let settled = false
      const tap = (chunk: string): void => {
        captured.push(chunk)
        const text = captured.join('')
        const m = new RegExp(`${MARK}_(\\d+)`).exec(stripAnsi(text))
        if (!m || settled) return
        settled = true
        cleanup()
        resolve(this.shapeExecResult(text, MARK, Number(m[1]), '', command))
      }
      if (!this.captureTaps.has(id)) this.captureTaps.set(id, new Set())
      this.captureTaps.get(id)!.add(tap)

      const cleanup = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.captureTaps.get(id)?.delete(tap)
      }
      const finishAbnormal = (note: string): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(this.shapeExecResult(captured.join(''), MARK, null, note, command))
      }
      /** 长驻进程观察窗结束：不等待退出、不终止命令——已有输出交给模型，进程留在终端里继续跑 */
      const finishLongRun = (): void => {
        if (settled) return
        settled = true
        cleanup()
        const shaped = this.shapeExecResult(captured.join(''), MARK, null, '', command)
        resolve({ content: `${shaped.content}\n（命令仍在终端中运行——长驻进程不等待结束；输出与停止请看终端面板）` })
      }
      const timer = setTimeout(() => {
        if (!waitExit) {
          finishLongRun()
          return
        }
        try {
          term.write('\x03\x03')
        } catch {
          /* 已退出忽略 */
        }
        setTimeout(() => finishAbnormal('命令超时，已发送 Ctrl+C 终止'), 400)
      }, timeoutMs)
      const onAbort = (): void => {
        try {
          term.write('\x03\x03')
        } catch {
          /* 已退出忽略 */
        }
        setTimeout(() => finishAbnormal('已被用户取消'), 400)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })

      term.write(`${fullLine}\r`)
    })
  }

  /** 捕获流整形：去 ANSI → 滤掉标记行 → 去回显的命令首行 → cap。
   *  note 非空 = 超时/中止异常结束（追加说明且 isError）。 */
  private shapeExecResult(raw: string, MARK: string, exitCode: number | null, note: string, command: string): ToolResult {
    let text = stripAnsi(raw)
      .split(/\r\n|\r|\n/)
      .filter((line) => !line.includes(MARK))
      .join('\n')
    // 去掉回显的命令本身（首行起逐行匹配命令前缀；换行命令只匹配首段）
    const cmdHead = command.trim().slice(0, 10)
    const lines = text.split('\n')
    let start = 0
    while (start < lines.length && lines[start]!.trim().length === 0) start++
    if (start < lines.length && cmdHead && lines[start]!.includes(cmdHead)) start++
    text = lines.slice(start).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '')
    const body = capOut(text) || '（无输出）'
    if (note) return { content: `${body}\n（${note}）`, isError: true }
    if (exitCode !== null && exitCode !== 0) return { content: `命令退出码 ${exitCode}\n${body}`, isError: true }
    return { content: body }
  }
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}
function capOut(buf: string): string {
  const HEAD = 2000
  const TAIL = 2000
  if (buf.length <= HEAD + TAIL) return buf
  return buf.slice(0, HEAD) + `\n…（中间省略 ${buf.length - HEAD - TAIL} 字符）\n` + buf.slice(-TAIL)
}

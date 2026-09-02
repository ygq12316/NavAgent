import * as pty from 'node-pty'

export interface PtyCallbacks {
  onData: (id: string, chunk: string) => void
  onExit: (id: string, exitCode: number) => void
}

/** 真终端服务：每个终端一个 PTY 会话；永不 throw（spawn 失败返回 null，UI 呈错误态） */
export class TerminalService {
  private terms = new Map<string, pty.IPty>()

  create(cwd: string, cb: PtyCallbacks): string | null {
    try {
      const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash')
      const id = `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as Record<string, string>
      })
      term.onData((chunk) => cb.onData(id, chunk))
      term.onExit(({ exitCode }) => {
        this.terms.delete(id)
        cb.onExit(id, exitCode)
      })
      this.terms.set(id, term)
      return id
    } catch {
      return null
    }
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
  }
}

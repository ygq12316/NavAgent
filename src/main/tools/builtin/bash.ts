import { spawn } from 'node:child_process'
import type { Tool } from '../registry'

interface Args {
  command: string
  timeout_ms?: number
  interactive?: boolean
}

const HEAD = 2000
const TAIL = 2000

function cap(buf: string): string {
  if (buf.length <= HEAD + TAIL) return buf
  return buf.slice(0, HEAD) + `\n…（中间省略 ${buf.length - HEAD - TAIL} 字符）\n` + buf.slice(-TAIL)
}

export const bashTool: Tool<Args> = {
  name: 'bash',
  description:
    '在工作目录中执行 shell 命令（Windows cmd），返回合并后的 stdout/stderr。默认超时 120 秒、上限 600 秒；输出过长会被截断。执行前需要用户批准。interactive=true 时命令在用户的可见终端里执行（用户可实时观看），适用于 dev server、watch、构建等用户关心的命令。',
  mutating: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout_ms: { type: 'number', description: '超时毫秒数，默认 120000，最大 600000；interactive 时为观察窗时长（到时返回"仍在运行"，上限 15 秒）' },
      interactive: {
        type: 'boolean',
        description:
          '在用户的可见终端里执行并显示可交互命令条（▶ 重跑/打开终端）。dev server、watch、测试命令或用户明确要求"在终端运行"时置 true；普通探测性命令保持缺省'
      }
    },
    required: ['command']
  },
  requiresApproval: (a) => `运行命令：${a.command}`,
  validate: (a) => (typeof a?.command === 'string' && a.command.trim().length > 0 ? null : 'command 必须是非空字符串'),
  async execute(args, ctx, signal) {
    const timeout = Math.min(Math.max(args.timeout_ms ?? 120_000, 1_000), 600_000)
    // 可见终端优先：命令在会话「点出来的」PTY 终端里执行（标记协议捕获输出）；
    // 无终端环境（web 预览/测试）回落隐藏 shell。
    // interactive（dev server/watch 等长驻命令）：观察窗模式——窗口到点返回"仍在运行"并附带已有输出，
    // 不发 Ctrl+C、不阻塞回合；进程留在终端里继续跑，快命令仍会提前经标记返回真实退出码。
    if (ctx.terminal) {
      const waitExit = args.interactive !== true
      const wait = waitExit ? timeout : Math.min(timeout, 15_000)
      return ctx.terminal.exec(args.command, wait, signal, { waitExit })
    }
    return new Promise((resolve) => {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', args.command], {
        cwd: ctx.workspacePath,
        windowsHide: true,
        windowsVerbatimArguments: true
      })
      let out = ''
      const collect = (d: Buffer): void => {
        if (out.length < 1_000_000) out += d.toString()
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)

      let timedOut = false
      const killTree = (): void => {
        if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
      const timer = setTimeout(() => {
        timedOut = true
        killTree()
      }, timeout)
      const onAbort = (): void => killTree()
      signal.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve({ content: `命令启动失败：${err.message}`, isError: true })
      })
      child.on('close', (code, signalName) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const body = cap(out.trim()) || '（无输出）'
        if (signal.aborted) resolve({ content: `${body}\n（已被用户取消）`, isError: true })
        else if (timedOut) resolve({ content: `命令超时（${timeout}ms，进程已终止）\n${body}`, isError: true })
        else if (code === 0 && signalName === null) resolve({ content: body })
        else if (code === null && signalName !== null && !timedOut) resolve({ content: `命令被信号终止（${signalName}）\n${body}`, isError: true })
        else resolve({ content: `命令退出码 ${code}\n${body}`, isError: code !== 0 })
      })
    })
  }
}

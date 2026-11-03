import { spawn } from 'node:child_process'
import { capOut } from '../registry'
import type { Tool } from '../registry'

interface Args {
  command: string
  timeout_ms?: number
  interactive?: boolean
}

export const bashTool: Tool<Args> = {
  name: 'bash',
  description:
    '在工作目录中执行 shell 命令（Windows cmd），返回合并后的 stdout/stderr。观察窗模式：默认观察 15 秒（timeout_ms 可调，上限 600s），提前退出返回真实结果；未退出则返回「仍在执行中」与已有输出，进程转入后台继续运行，不阻塞回合。interactive=true 时命令在用户的可见终端里执行（用户可实时观看、可点箭头去终端重跑），适用于 dev server、watch、构建等长命令。',
  mutating: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout_ms: { type: 'number', description: '观察窗毫秒数，默认 15000，最大 600000；到点未退出则返回「仍在执行中」，进程继续在后台运行' },
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
    // 观察窗：到点未退出即返回「仍在执行中」，进程留在后台（不阻塞回合、不击杀）
    const wait = Math.min(Math.max(args.timeout_ms ?? 15_000, 1_000), 600_000)
    // 可见终端优先：命令在会话「点出来的」PTY 终端里执行（标记协议捕获输出）；
    // 无终端环境（web 预览/测试）回落隐藏 shell。
    // 快命令仍会提前经标记返回真实退出码；慢命令统一走观察窗返回。
    if (ctx.terminal) {
      return ctx.terminal.exec(args.command, wait, signal, {
        waitExit: false,
        onBackgroundExit: (note) => ctx.notifyBackground?.(note)
      })
    }
    return new Promise((resolve) => {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', args.command], {
        cwd: ctx.workspacePath,
        windowsHide: true,
        windowsVerbatimArguments: true
      })
      let out = ''
      let settled = false
      let backgrounded = false
      const collect = (d: Buffer): void => {
        if (out.length < 1_000_000) out += d.toString()
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)

      const killTree = (): void => {
        if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
      const onAbort = (): void => killTree()
      signal.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => {
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve({ content: `命令启动失败：${err.message}`, isError: true })
      })
      child.on('close', (code, signalName) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const body = capOut(out.trim()) || '（无输出）'
        // 观察窗已先返回「仍在执行中」：此刻补报真实结果（自动检测，进 followUp 队列）
        if (settled) {
          if (backgrounded && !signal.aborted) ctx.notifyBackground?.(`后台命令已结束（退出码 ${code}）\n${body}`)
          return
        }
        settled = true
        if (signal.aborted) resolve({ content: `${body}\n（已被用户取消）`, isError: true })
        else if (code === 0 && signalName === null) resolve({ content: body })
        else if (code === null && signalName !== null) resolve({ content: `命令被信号终止（${signalName}）\n${body}`, isError: true })
        else resolve({ content: `命令退出码 ${code}\n${body}`, isError: code !== 0 })
      })
      // 观察窗到点：命令未退出 → 立即返回「仍在执行中」，进程转后台
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        backgrounded = true
        const body = capOut(out.trim())
        resolve({
          content: `命令仍在执行中（观察窗 ${wait}ms 内未退出，进程已转入后台继续运行；不影响后续对话）\n${body || '（暂无输出）'}`
        })
      }, wait)
    })
  }
}

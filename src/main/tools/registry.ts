import path from 'node:path'
import type { ToolSchema } from '@shared/types'

export interface ToolContext {
  workspacePath: string
  /** 会话终端执行器：agent bash 在「点出来的」可见 PTY 终端里执行（无终端环境时缺省，回落隐藏 shell）。
   *  opts.waitExit=false（长命令观察窗）：到点返回"仍在运行"，不终止终端里的进程 */
  terminal?: {
    exec: (
      command: string,
      timeoutMs: number,
      signal: AbortSignal,
      opts?: { waitExit?: boolean; onBackgroundExit?: (note: string) => void }
    ) => Promise<ToolResult>
  }
  /** 观察窗转后台的命令结束时回调（自动检测结果）：文本进入会话队列，下一轮注入模型上下文 */
  notifyBackground?: (text: string) => void
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface Tool<A = Record<string, unknown>> extends ToolSchema {
  requiresApproval?: (args: A) => string | null
  /** 可变更工作区状态（写入/执行命令）：只读模式下整体剔除 */
  mutating?: boolean
  validate?: (args: A) => string | null
  execute: (args: A, ctx: ToolContext, signal: AbortSignal) => Promise<ToolResult>
}

/** 解析路径并强制约束在工作区内（Windows 大小写不敏感比较）；越界返回 null */
export function resolveWithin(workspace: string, p: string): string | null {
  if (typeof p !== 'string' || p.trim().length === 0) return null
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(workspace, p)
  const ws = path.normalize(workspace).toLowerCase()
  const n = abs.toLowerCase()
  if (n !== ws && !n.startsWith(ws + path.sep)) return null
  return abs
}

/** 工具输出截断：保头保尾各 2000 字符，中间以省略标注（bash/终端捕获等长输出共用） */
const CAP_HEAD = 2000
const CAP_TAIL = 2000
export function capOut(buf: string): string {
  if (buf.length <= CAP_HEAD + CAP_TAIL) return buf
  return buf.slice(0, CAP_HEAD) + `\n…（中间省略 ${buf.length - CAP_HEAD - CAP_TAIL} 字符）\n` + buf.slice(-CAP_TAIL)
}

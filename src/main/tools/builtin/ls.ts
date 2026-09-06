import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Tool } from '../registry'
import { resolveWithin } from '../registry'

interface Args {
  path?: string
}

export const lsTool: Tool<Args> = {
  name: 'ls',
  description: '列出工作区内某个目录的内容（目录在前，附文件大小），不递归。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内的相对目录路径，默认工作区根' }
    }
  },
  requiresApproval: () => null,
  validate: () => null,
  async execute(args, ctx) {
    const rel = args?.path ?? '.'
    const abs = resolveWithin(ctx.workspacePath, rel)
    if (!abs) return { content: `路径越出工作区：${rel}`, isError: true }
    const st = await stat(abs).catch(() => null)
    if (!st) return { content: `目录不存在：${rel}`, isError: true }
    if (!st.isDirectory()) return { content: `不是目录：${rel}`, isError: true }
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => null)
    if (!entries) return { content: `无法读取目录：${rel}`, isError: true }
    const visible = entries.filter((e) => !e.name.startsWith('.'))
    const dirs = visible.filter((e) => e.isDirectory()).map((e) => `${e.name}/`)
    const files = visible.filter((e) => e.isFile()).map((e) => e.name)
    const lines: string[] = []
    for (const d of dirs) lines.push(`${d}`)
    for (const f of files.slice(0, 500)) {
      const size = (await stat(path.join(abs, f)).catch(() => null))?.size ?? 0
      lines.push(`${f}  (${size} B)`)
    }
    if (lines.length === 0) return { content: `${rel} 是空目录` }
    return { content: lines.join('\n') }
  }
}

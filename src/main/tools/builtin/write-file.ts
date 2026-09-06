import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Tool } from '../registry'
import { resolveWithin } from '../registry'

interface Args {
  path: string
  content: string
}

export const writeFileTool: Tool<Args> = {
  name: 'write_file',
  description: '在工作区内创建或整体覆盖一个文本文件。适合新建文件或大幅重写；小改动请优先使用 edit_file。执行前需要用户批准。',
  mutating: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内的相对路径' },
      content: { type: 'string', description: '完整的文件内容' }
    },
    required: ['path', 'content']
  },
  requiresApproval: (a) => `写入文件：${a.path}（${a.content.split('\n').length} 行）`,
  validate: (a) => {
    if (typeof a?.path !== 'string' || a.path.trim().length === 0) return 'path 必须是非空字符串'
    if (typeof a?.content !== 'string') return 'content 必须是字符串'
    return null
  },
  async execute(args, ctx) {
    const abs = resolveWithin(ctx.workspacePath, args.path)
    if (!abs) return { content: `路径越出工作区：${args.path}`, isError: true }
    const st = await stat(abs).catch(() => null)
    if (st?.isDirectory()) return { content: `目标是目录，不能作为文件写入：${args.path}`, isError: true }
    const existed = st !== null
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, args.content, 'utf-8')
    const note = existed ? '（覆盖原文件）' : '（新建文件）'
    return {
      content: `已写入 ${args.path}${note}：${args.content.split('\n').length} 行，${Buffer.byteLength(args.content, 'utf-8')} 字节`
    }
  }
}

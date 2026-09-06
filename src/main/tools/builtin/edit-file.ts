import { readFile, stat, writeFile } from 'node:fs/promises'
import type { Tool } from '../registry'
import { resolveWithin } from '../registry'
import { lineDiff, diffStat } from '../diff'
import { toRel } from '../walk'

interface Args {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export const editFileTool: Tool<Args> = {
  name: 'edit_file',
  description:
    '在工作区内编辑文本文件：用 old_string 精确匹配并替换为 new_string（搜索替换式，比行号稳定）。old_string 必须与文件内容完全一致（含空白）。多处匹配时需提供更多上下文或设置 replace_all=true。返回 unified diff。执行前需要用户批准。',
  mutating: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内的相对路径' },
      old_string: { type: 'string', description: '要被替换的原文（精确匹配）' },
      new_string: { type: 'string', description: '替换后的文本；删除内容时传空字符串' },
      replace_all: { type: 'boolean', description: '替换全部匹配项，默认 false（仅第一处）' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  requiresApproval: (a) => `编辑文件：${a.path}`,
  validate: (a) => {
    if (typeof a?.path !== 'string' || a.path.trim().length === 0) return 'path 必须是非空字符串'
    if (typeof a?.old_string !== 'string' || a.old_string.length === 0) return 'old_string 必须是非空字符串'
    if (typeof a?.new_string !== 'string') return 'new_string 必须是字符串'
    return null
  },
  async execute(args, ctx) {
    const abs = resolveWithin(ctx.workspacePath, args.path)
    if (!abs) return { content: `路径越出工作区：${args.path}`, isError: true }
    const st = await stat(abs).catch(() => null)
    if (!st) return { content: `文件不存在：${args.path}（新建文件请用 write_file）`, isError: true }
    if (st.isDirectory()) return { content: `目标是目录：${args.path}`, isError: true }
    const original = await readFile(abs, 'utf-8')
    const count = original.split(args.old_string).length - 1
    if (count === 0) return { content: `未找到 old_string（需与文件内容精确匹配，包括缩进与换行）`, isError: true }
    if (count > 1 && !args.replace_all) {
      return {
        content: `old_string 在文件中出现 ${count} 次：请包含更多上下文使其唯一，或设置 replace_all=true`,
        isError: true
      }
    }
    const updated = args.replace_all ? original.split(args.old_string).join(args.new_string) : original.replace(args.old_string, args.new_string)
    await writeFile(abs, updated, 'utf-8')
    const diff = lineDiff(original, updated, toRel(ctx.workspacePath, abs))
    const { add, del } = diffStat(diff)
    return { content: `已编辑 ${args.path}（+${add} -${del}）\n${diff}` }
  }
}

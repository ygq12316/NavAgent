import { readFile, stat } from 'node:fs/promises'
import type { Tool } from '../registry'
import { resolveWithin } from '../registry'
import { extractDocText, isSupportedDoc } from '../../services/doc-text'

interface Args {
  path: string
  offset?: number
  limit?: number
}

const MAX_BYTES = 256 * 1024
const DEFAULT_LIMIT = 2000

export const readFileTool: Tool<Args> = {
  name: 'read_file',
  description:
    '读取工作区内文件的内容，返回带行号的文本，便于引用。大文件自动截断，可用 offset/limit 分页。支持 PDF / Word(.docx) / Excel(.xlsx/.xls) 文档（自动抽取纯文本）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内的相对路径' },
      offset: { type: 'number', description: '起始行号（从 1 开始）' },
      limit: { type: 'number', description: '最多读取的行数' }
    },
    required: ['path']
  },
  requiresApproval: () => null,
  validate: (a) => (typeof a?.path === 'string' && a.path.trim().length > 0 ? null : 'path 必须是非空字符串'),
  async execute(args, ctx) {
    const abs = resolveWithin(ctx.workspacePath, args.path)
    if (!abs) return { content: `路径越出工作区：${args.path}`, isError: true }
    const st = await stat(abs).catch(() => null)
    if (!st) return { content: `文件不存在：${args.path}`, isError: true }
    if (st.isDirectory()) return { content: `这是目录而不是文件：${args.path}`, isError: true }
    const buf = await readFile(abs)
    const binary = buf.subarray(0, 8192).includes(0)
    if (binary && isSupportedDoc(extname(abs))) {
      const r = await extractDocText(abs)
      if (!r.ok) return { content: `文档解析失败：${r.error}`, isError: true }
      const lines = r.text.split('\n')
      const start = Math.max(1, Math.floor(args.offset ?? 1))
      const end = Math.min(lines.length, start - 1 + Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)))
      const body = lines
        .slice(start - 1, end)
        .map((line, i) => `${String(start + i).padStart(5)}\t${line.replace(/\t/g, '  ')}`)
        .join('\n')
      const notes = [`（已从${r.note}抽取文本，共 ${r.text.length} 字符 / ${lines.length} 行）`]
      if (start > 1) notes.push(`（跳过前 ${start - 1} 行）`)
      if (end < lines.length) notes.push(`（可用 offset/limit 继续读取）`)
      return { content: body + '\n' + notes.join('') }
    }
    if (binary) return { content: '二进制文件，无法按文本读取', isError: true }
    const overBytes = buf.length > MAX_BYTES
    const text = buf.subarray(0, MAX_BYTES).toString('utf-8')
    const lines = text.split('\n')
    const start = Math.max(1, Math.floor(args.offset ?? 1))
    const end = Math.min(lines.length, start - 1 + Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)))
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(5)}\t${line.replace(/\t/g, '  ')}`)
      .join('\n')
    const notes: string[] = []
    if (start > 1) notes.push(`（跳过前 ${start - 1} 行）`)
    if (end < lines.length || overBytes)
      notes.push(`（已截断：共 ${lines.length} 行${overBytes ? '，文件超过 256KB' : ''}，可用 offset/limit 继续读取）`)
    return { content: body + (notes.length ? '\n' + notes.join('') : '') }
  }
}

function extname(p: string): string {
  const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i >= 0 ? base.slice(i).toLowerCase() : ''
}

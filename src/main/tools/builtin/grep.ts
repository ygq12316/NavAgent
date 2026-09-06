import { readFile } from 'node:fs/promises'
import type { Tool } from '../registry'
import { globToRegExp, isBinaryExt, toRel, walkFiles } from '../walk'

interface Args {
  pattern: string
  path?: string
  include?: string
  ignore_case?: boolean
}

const MAX_MATCHES = 200
const MAX_FILE_BYTES = 512 * 1024

export const grepTool: Tool<Args> = {
  name: 'grep',
  description: '在工作区文本文件中按正则表达式搜索（逐行匹配），返回「相对路径:行号: 内容」。可用 include 限定文件 glob、ignore_case 忽略大小写。不搜索二进制/隐藏/node_modules 等。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript 正则表达式' },
      path: { type: 'string', description: '起始子目录，默认工作区根' },
      include: { type: 'string', description: '文件名 glob 过滤，如 "*.ts"' },
      ignore_case: { type: 'boolean', description: '忽略大小写' }
    },
    required: ['pattern']
  },
  requiresApproval: () => null,
  validate: (a) => (typeof a?.pattern === 'string' && a.pattern.length > 0 ? null : 'pattern 必须是非空字符串'),
  async execute(args, ctx) {
    let regex: RegExp
    try {
      regex = new RegExp(args.pattern, args.ignore_case ? 'i' : '')
    } catch (err) {
      return { content: `无效的正则表达式：${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
    let includeRe: RegExp | null = null
    if (args.include) {
      try {
        includeRe = globToRegExp(args.include)
      } catch {
        includeRe = null
      }
    }
    const out: string[] = []
    let matches = 0
    outer: for await (const abs of walkFiles(ctx.workspacePath, args?.path ?? '.', 1500)) {
      const rel = toRel(ctx.workspacePath, abs)
      // include 是文件名 glob：与 glob 工具一致，无目录分隔的模式同时对 basename 匹配
      const base = rel.split('/').pop() ?? ''
      if (includeRe && !includeRe.test(rel) && !includeRe.test(base)) continue
      if (isBinaryExt(rel)) continue
      let text = await readFile(abs, 'utf-8').catch(() => null)
      if (text === null) continue
      if (text.length > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES)
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (++matches >= MAX_MATCHES) break outer
        }
      }
    }
    if (matches === 0) return { content: `未找到匹配：${args.pattern}` }
    return { content: `${matches} 处匹配${matches >= MAX_MATCHES ? '（已达上限）' : ''}\n${out.join('\n').slice(0, 16384)}` }
  }
}

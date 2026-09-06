import type { Tool } from '../registry'
import { globToRegExp, toRel, walkFiles } from '../walk'

interface Args {
  pattern: string
  path?: string
}

const MAX_RESULTS = 200

export const globTool: Tool<Args> = {
  name: 'glob',
  description: '按 glob 模式在工作区内查找文件路径（支持 ** / * / ? / {a,b}），不读取内容。返回相对路径列表。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts" 或 "docs/*.md"' },
      path: { type: 'string', description: '起始子目录，默认工作区根' }
    },
    required: ['pattern']
  },
  requiresApproval: () => null,
  validate: (a) => (typeof a?.pattern === 'string' && a.pattern.trim().length > 0 ? null : 'pattern 必须是非空字符串'),
  async execute(args, ctx) {
    let re: RegExp
    try {
      re = globToRegExp(args.pattern)
    } catch (err) {
      return { content: `无效的 glob 模式：${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
    const out: string[] = []
    for await (const abs of walkFiles(ctx.workspacePath, args?.path ?? '.', 2000)) {
      const rel = toRel(ctx.workspacePath, abs)
      // 无目录分隔的模式同时对文件名匹配（"*.ts" 等价于 "**/*.ts"）
      if (re.test(rel) || (args.pattern.includes('/') === false && re.test(rel.split('/').pop() ?? ''))) {
        out.push(rel)
        if (out.length >= MAX_RESULTS) break
      }
    }
    if (out.length === 0) return { content: `未找到匹配文件：${args.pattern}` }
    return { content: `${out.length} 个文件${out.length >= MAX_RESULTS ? '（已达上限）' : ''}\n${out.join('\n')}` }
  }
}

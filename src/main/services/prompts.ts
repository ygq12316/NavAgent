import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Prompt templates（对齐 pi 的 prompt templates）：
 * markdown 文件即模板，文件名（去 .md）为斜杠命令名；全局 userData/prompts 与项目 .navagent/prompts。
 * 内容是数据不是代码，不做信任门（与 context files 同级）。
 * 展开规则：$1..$9 位置参数（按空白切分）、$ARGUMENTS 原始参数串；
 * 模板无占位符时参数追加在模板末尾。
 */

export interface PromptTemplate {
  name: string
  description: string
  source: 'global' | 'project'
  template: string
}

export function scanPromptTemplates(dirs: { dir: string; source: 'global' | 'project' }[]): PromptTemplate[] {
  const out: PromptTemplate[] = []
  const seen = new Set<string>()
  for (const { dir, source } of dirs) {
    if (!dir || !existsSync(dir)) continue
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    } catch {
      continue
    }
    for (const file of files) {
      const name = file.slice(0, -3)
      if (seen.has(name)) continue
      try {
        const template = readFileSync(join(dir, file), 'utf-8')
        if (!template.trim()) continue
        seen.add(name)
        out.push({ name, description: firstLineOf(template), source, template })
      } catch {
        // 单文件读取失败跳过
      }
    }
  }
  return out
}

/** 描述 = 第一个非空、非标题、非 frontmatter 行（截 60 字符） */
function firstLineOf(template: string): string {
  let lines = template.split('\n')
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) lines = lines.slice(end + 1)
  }
  for (const l of lines) {
    const t = l.trim()
    if (!t || t.startsWith('#')) continue
    return t.slice(0, 60)
  }
  return ''
}

export function expandPrompt(template: string, args: string): string {
  const positional = args.trim().length > 0 ? args.trim().split(/\s+/) : []
  let out = template
  for (let i = 0; i < 9; i++) {
    out = out.replaceAll(`$${i + 1}`, positional[i] ?? '')
  }
  out = out.replaceAll('$ARGUMENTS', args)
  if (out === template && args.trim()) {
    out = `${template}\n\n${args.trim()}`
  }
  return out.trim()
}

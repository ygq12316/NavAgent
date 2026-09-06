import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from '../tools/registry'

/**
 * Agent Skills（对齐 pi 的 skills，Claude Code 式按需加载）：
 * 目录结构 <skills>/<name>/SKILL.md —— YAML 头（name/description）+ 指令正文。
 * 发现：全局 userData/skills 与项目 .navagent/skills；内容是数据，不做信任门。
 * 机制：system prompt 列出技能清单，模型经内置 `skill` 工具按需取回正文。
 */

export interface SkillMeta {
  name: string
  description: string
  source: 'global' | 'project'
  path: string
}

export function scanSkills(dirs: { dir: string; source: 'global' | 'project' }[]): SkillMeta[] {
  const out: SkillMeta[] = []
  const seen = new Set<string>()
  for (const { dir, source } of dirs) {
    if (!dir || !existsSync(dir)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue
    }
    for (const name of entries) {
      if (seen.has(name)) continue
      const file = join(dir, name, 'SKILL.md')
      if (!existsSync(file)) continue
      try {
        const raw = readFileSync(file, 'utf-8')
        if (!raw.trim()) continue
        const { description } = parseFrontmatter(raw)
        seen.add(name)
        out.push({ name, description, source, path: file })
      } catch {
        // 单技能读取失败跳过
      }
    }
  }
  return out
}

/** 极简 frontmatter：--- 包裹的 name:/description: 行；缺失时 description 取正文首个非标题行 */
function parseFrontmatter(raw: string): { description: string } {
  const lines = raw.split('\n')
  let description = ''
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = /^description:\s*(.+)$/.exec(l.trim())
        if (m) description = m[1]!.trim()
      }
      return { description }
    }
  }
  for (const l of lines) {
    const t = l.trim()
    if (!t || t.startsWith('#')) continue
    description = t.slice(0, 60)
    break
  }
  return { description }
}

/** 技能正文：剥掉 frontmatter 与标题首行 */
export function readSkillBody(file: string): string {
  const raw = readFileSync(file, 'utf-8')
  let lines = raw.split('\n')
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) lines = lines.slice(end + 1)
  }
  return lines.join('\n').trim()
}

/** 内置 `skill` 工具：模型按名取回技能正文 */
export function buildSkillTool(getSkills: () => SkillMeta[]): Tool<{ name: string }> {
  return {
    name: 'skill',
    description: '按需加载一个已安装技能的完整指令。调用前先在 system prompt 的技能清单里确认名称。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名（见技能清单）' } },
      required: ['name']
    },
    validate: (a) => (typeof a?.name === 'string' && a.name.trim().length > 0 ? null : 'name 必须是非空字符串'),
    execute: async (args) => {
      const skill = getSkills().find((s) => s.name === args.name.trim())
      if (!skill) {
        const known = getSkills().map((s) => s.name).join('、') || '（无）'
        return { content: `未找到技能：${args.name}。可用技能：${known}`, isError: true }
      }
      try {
        const body = readSkillBody(skill.path)
        return { content: `# 技能：${skill.name}\n\n${body}` }
      } catch (err) {
        return { content: `技能读取失败：${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }
  }
}

/** system prompt 的技能清单段（无技能返回空串） */
export function buildSkillsSection(skills: SkillMeta[]): string {
  if (skills.length === 0) return ''
  const list = skills.map((s) => `- ${s.name}：${s.description || '（无描述）'}`).join('\n')
  return `\n\n可用技能（需要时调用 skill 工具加载完整指令）：\n${list}`
}

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Context files（对齐 pi 的 context files 体系）：
 * 工作区根的 AGENTS.md / CLAUDE.md / .navagent/AGENTS.md 存在即拼入 system prompt。
 * getSystemPrompt 为同步调用，因此主进程维护缓存（启动/切换工作区/手动刷新时重建）。
 */

export const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md', '.navagent/AGENTS.md']
const MAX_FILE_CHARS = 32_000

export function buildContextFilesSection(workspacePath: string): string {
  if (!workspacePath) return ''
  const parts: string[] = []
  for (const rel of CONTEXT_FILES) {
    const abs = join(workspacePath, rel)
    try {
      if (!existsSync(abs)) continue
      let text = readFileSync(abs, 'utf-8')
      if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS) + '\n…（已截断）'
      if (text.trim().length === 0) continue
      parts.push(`--- ${rel} ---\n${text.trim()}`)
    } catch {
      // 单个文件读取失败跳过
    }
  }
  if (parts.length === 0) return ''
  return (
    '\n\n以下是本项目的上下文文件（context files），请遵循其中的项目约定：\n\n' + parts.join('\n\n')
  )
}

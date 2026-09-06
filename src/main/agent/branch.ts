import type { AgentMessage } from '@shared/types'

/**
 * 会话树分支算法（纯函数，独立可测）：
 * 祖先链、公共祖先、被离开路径提取；分支摘要消息构造对齐 pi 的 BranchSummaryEntry。
 */

export type ParentMap = Map<string, string | null>

/** root→nodeId 的祖先链（含两端）；nodeId 不在表中返回 [] */
export function ancestorChain(nodeId: string, parents: ParentMap): string[] {
  if (!parents.has(nodeId)) return []
  const chain: string[] = []
  let cur: string | null = nodeId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    chain.push(cur)
    cur = parents.get(cur) ?? null
  }
  return chain.reverse()
}

/** 最近公共祖先；无公共节点返回 null */
export function findCommonAncestor(a: string[], b: string[]): string | null {
  const setB = new Set(b)
  for (let i = a.length - 1; i >= 0; i--) {
    if (setB.has(a[i])) return a[i]
  }
  return null
}

/**
 * target 是否在 base 的子孙路径上（即 base 是 target 的祖先）：
 * 判断"向前跳转到后代"（无需摘要）用。
 */
export function isAncestorOf(base: string, target: string, parents: ParentMap): boolean {
  return ancestorChain(target, parents).includes(base)
}

/** 分支摘要消息包装（模式同 COMPACTION_SUMMARY_PREFIX/SUFFIX，user 角色承载） */
export const BRANCH_SUMMARY_PREFIX = `The conversation on the previous branch was summarized as follows:

<branch-summary>
`
export const BRANCH_SUMMARY_SUFFIX = `
</branch-summary>`

export function createBranchSummaryMessage(summary: string): AgentMessage {
  return {
    role: 'user',
    content: `${BRANCH_SUMMARY_PREFIX}${summary}${BRANCH_SUMMARY_SUFFIX}`
  }
}

/** 判断 user 消息是否为分支摘要（恢复/展示用） */
export function isBranchSummaryMessage(m: AgentMessage): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(BRANCH_SUMMARY_PREFIX)
}

export function extractBranchSummary(m: AgentMessage): string {
  const body = typeof m.content === 'string' ? m.content.slice(BRANCH_SUMMARY_PREFIX.length) : ''
  const end = body.lastIndexOf(BRANCH_SUMMARY_SUFFIX)
  return (end >= 0 ? body.slice(0, end) : body).trim()
}

/** 被离开路径的摘要 prompt（对齐 pi branch-summarization 的三段式） */
export const BRANCH_SUMMARIZATION_PROMPT = `The messages above are a branch of work that is being LEFT (the user navigated the session tree to a different branch). Summarize it so its important context is preserved at the navigation point.

Use this format:

## What Was Attempted
- [Key work and decisions made on this branch]

## Outcomes
- [What resulted from this branch; unfinished threads included]

## Carry-Over Context
- [File paths, error messages, or facts the retained conversation may need]

Be concise. Preserve exact file paths and error messages.`

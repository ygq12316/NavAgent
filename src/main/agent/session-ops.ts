import type { AgentMessage, SessionTreeNode, TreeSummaryResult } from '@shared/types'
import type { Agent } from './agent'
import type { SessionStore } from './session-store'
import { createBranchSummaryMessage, findCommonAncestor } from './branch'

/**
 * 会话树操作（IPC 与扩展能力面同源）：
 * switchLeaf/fork 的全部业务规则（busy 门、分支摘要、transcript 重载）在此单点实现，
 * ipc handler 与 ctx.sessions 能力面都只是薄封装——两条入口行为永远一致。
 */
export interface SessionOpsDeps {
  store: SessionStore
  isRunning: (id: string) => boolean
  getAgent: (id: string) => Agent | undefined
  summarizeBranch: (messages: AgentMessage[]) => Promise<string>
  /** 会话派生后补建 worktree（git 会话隔离）；index.ts 注入 */
  ensureWorkspace?: (sessionId: string) => Promise<void>
  /** 删除清理链（index.ts 注入）：移除运行实例 + 派发 session_end + 清 diff 状态 */
  dropSession?: (sessionId: string) => void
  clearDiff?: (sessionId: string) => void
  removeWorktree?: (projectPath: string, sessionId: string) => void
  notice: (sessionId: string, message: string) => void
}

export function createSessionOps(deps: SessionOpsDeps) {
  const { store, isRunning, getAgent, summarizeBranch, notice } = deps
  return {
    /** 全量节点树 + 当前活动叶子（非线性对话的数据源） */
    getTree(id: string): { nodes: SessionTreeNode[]; leafId: string | null } {
      return { nodes: store.listTree(id), leafId: store.getLeaf(id) }
    },

    /**
     * 切换活动叶子（跳转续跑/改写重发的基础）。
     * summarize=true 且目标不是原叶子的后代时，为被离开路径生成分支摘要并挂到新导航点；
     * 运行实例存在时同步重载其 transcript；renderer 事后自行 loadSession 重新 hydrate。
     */
    async switchLeaf(id: string, nodeId: string | null, summarize: boolean): Promise<TreeSummaryResult | 'busy'> {
      if (typeof id !== 'string' || (nodeId !== null && typeof nodeId !== 'string')) return { summaryInjected: false }
      if (isRunning(id)) {
        notice(id, '运行中无法切换分支，请先停止。')
        return 'busy'
      }
      try {
        const oldLeaf = store.getLeaf(id)
        const oldChain = oldLeaf ? store.getAncestors(id, oldLeaf) : []
        const targetChain = nodeId === null ? [] : store.getAncestors(id, nodeId)
        const movingForward = oldLeaf !== null && targetChain.includes(oldLeaf)

        const { messages } = store.switchLeaf(id, nodeId)

        let summaryInjected = false
        if (summarize && oldLeaf && !movingForward && oldLeaf !== nodeId) {
          const common = findCommonAncestor(oldChain, targetChain)
          const abandoned = common ? store.messagesBetween(id, common, oldLeaf) : []
          if (abandoned.length > 0) {
            let summaryText: string
            try {
              summaryText = await summarizeBranch(abandoned)
            } catch {
              summaryText = '（分支摘要生成失败，仅保留导航点。）'
            }
            const msg = createBranchSummaryMessage(summaryText)
            store.appendMessage(id, msg)
            messages.push(msg)
            summaryInjected = true
          }
        }

        const agent = getAgent(id)
        if (agent) {
          agent.reset()
          agent.replaceTranscript(messages)
        }
        return { summaryInjected }
      } catch (err) {
        notice(id, `切换分支失败：${err instanceof Error ? err.message : String(err)}`)
        return { summaryInjected: false }
      }
    },

    /** 从指定节点派生新会话文件（祖先链复制，保留节点 id）；源会话运行中返回 null */
    async fork(id: string, nodeId: string): Promise<string | null> {
      if (isRunning(id)) {
        notice(id, '运行中无法派生会话，请先停止。')
        return null
      }
      try {
        const meta = store.fork(id, nodeId)
        await deps.ensureWorkspace?.(meta.id)
        return meta.id
      } catch (err) {
        notice(id, `派生会话失败：${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },

    /**
     * 删除会话（会话地图语义）：派生子会话不级联删除——store.remove 内断线提升为新的根；
     * 本体走完整清理链（运行实例 / session_end / diff 状态 / worktree 回收）。
     */
    removeSession(id: string): 'ok' | 'not-found' {
      const meta = store.getMeta(id)
      if (!meta) return 'not-found'
      deps.dropSession?.(id)
      deps.clearDiff?.(id)
      const r = store.remove(id)
      if (r !== 'ok') return r
      if (meta.worktreePath) deps.removeWorktree?.(meta.projectPath, id)
      return 'ok'
    }
  }
}

export type SessionOps = ReturnType<typeof createSessionOps>

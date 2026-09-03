import { useEffect, useMemo, useState } from 'react'
import { getApi } from '../api'
import type { SessionTreeNode } from '@shared/types'

interface Props {
  sessionId: string
  /** 当前活动叶子（来自 SessionMeta）；未迁移/空会话为空 */
  leafId?: string
  working: boolean
  onClose: () => void
  /** 重放前清空本地视图（与切会话同序：先 reset 再触发主进程重放） */
  onReset: () => void
  /** 切叶/fork/clone 成功（主进程已重放事件） */
  onSwitched: () => void
  /** fork/clone 已产生新会话 id */
  onSessionSwitched: (id: string) => void
}

const ROLE_ICON: Record<SessionTreeNode['role'], string> = {
  user: '❯',
  assistant: '◆',
  tool_result: '◇',
  snapshot: '📜'
}

export function TreeOverlay({ sessionId, leafId, working, onClose, onReset, onSwitched, onSessionSwitched }: Props) {
  const api = getApi()
  const [nodes, setNodes] = useState<SessionTreeNode[]>([])
  const [pending, setPending] = useState<SessionTreeNode | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.listTree(sessionId).then(setNodes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  /** node 的祖先链（含自身），用于缩进与"向前跳转"判定 */
  const chains = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const chainOf = (n: SessionTreeNode): SessionTreeNode[] => {
      const out: SessionTreeNode[] = []
      let cur: SessionTreeNode | undefined = n
      const seen = new Set<string>()
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id)
        out.push(cur)
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      }
      return out.reverse()
    }
    return new Map(nodes.map((n) => [n.id, chainOf(n)]))
  }, [nodes])

  /** 目标不是当前叶子的后代（跨分支/向后跳转）→ 需要询问是否摘要 */
  const requiresSummary = (n: SessionTreeNode): boolean => {
    if (!leafId || n.id === leafId) return false
    return !chains.get(n.id)!.some((x) => x.id === leafId)
  }

  const handleJump = async (n: SessionTreeNode, summarize: boolean) => {
    setBusy(true)
    try {
      onReset()
      await api.switchLeaf(sessionId, n.id, summarize)
      onSwitched()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handleFork = async (n: SessionTreeNode) => {
    setBusy(true)
    try {
      onReset()
      const newId = await api.forkSession(sessionId, n.id)
      onSessionSwitched(newId)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handleClone = async () => {
    if (!leafId) return
    setBusy(true)
    try {
      onReset()
      const newId = await api.cloneSession(sessionId)
      onSessionSwitched(newId)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings raised" onClick={(e) => e.stopPropagation()}>
        <h2>分支树</h2>
        <div className="tree-list">
          {nodes.length === 0 && <div className="session-empty">（空会话）</div>}
          {nodes.map((n) => {
            const depth = chains.get(n.id)!.length - 1
            const isLeaf = n.id === leafId
            return (
              <div key={n.id} className={`bnode ${isLeaf ? 'bnode-leaf' : ''}`} style={{ marginLeft: depth * 16 }}>
                <span className="bnode-icon">{ROLE_ICON[n.role]}</span>
                <span className="bnode-preview" title={n.preview}>
                  {n.preview || '（空）'}
                </span>
                {isLeaf && <span className="bnode-tag">当前</span>}
                <span className="bnode-actions">
                  {!isLeaf && (
                    <button
                      className="btn btn-ghost"
                      disabled={busy || working}
                      onClick={() => (requiresSummary(n) ? setPending(n) : void handleJump(n, false))}
                      title="把活动位置切到此节点，从这继续对话"
                    >
                      从此续跑
                    </button>
                  )}
                  <button className="btn btn-ghost" disabled={busy || working} onClick={() => void handleFork(n)} title="以该节点为终点派生新会话">
                    派生
                  </button>
                </span>
              </div>
            )
          })}
        </div>
        {pending && (
          <div className="bnode-confirm">
            <div className="bnode-confirm-text">跳转将离开当前分支。要为被离开的对话生成摘要吗？</div>
            <div className="settings-actions">
              <button className="btn" disabled={busy} onClick={() => void handleJump(pending, false)}>
                直接跳转
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void handleJump(pending, true)}>
                生成摘要并跳转
              </button>
              <button className="btn" disabled={busy} onClick={() => setPending(null)}>
                取消
              </button>
            </div>
          </div>
        )}
        <div className="settings-actions">
          <button className="btn" disabled={busy || working || nodes.length === 0} onClick={() => void handleClone()} title="复制当前活动分支为新会话">
            克隆当前分支
          </button>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

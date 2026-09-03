import type { Usage } from '@shared/types'
import { contextTokensOf } from '@shared/types'
import type { SessionStats } from '../state/reducer'
import { IconPanelLeft } from './icons'

interface Props {
  /** 会话管理左栏是否塌缩（☰ 切换） */
  railCollapsed: boolean
  onToggleRail: () => void
  model: string
  usage: Usage | null
  working: boolean
  /** 排队中的插话/续跑条数 */
  queued?: { steering: number; followUp: number }
  /** 模型上下文窗口（config.contextWindow），ctx% 据此计算 */
  contextWindow?: number
  /** 会话累计统计（点击弹出明细） */
  stats?: SessionStats
  onOpenStats?: () => void
}

export function StatusBar({ railCollapsed, onToggleRail, model, usage, working, queued, contextWindow, stats, onOpenStats }: Props) {
  const window_ = contextWindow && contextWindow > 0 ? contextWindow : 64_000
  // 上下文口径 = 非缓存输入 + 缓存读 + 缓存写（与压缩阈值一致）
  const pct = usage ? Math.min(99, Math.round((contextTokensOf(usage) / window_) * 100)) : null
  const tok = usage ? (contextTokensOf(usage) / 1000).toFixed(1) + 'k tok' : null
  const queuedCount = (queued?.steering ?? 0) + (queued?.followUp ?? 0)
  const totalTok = stats ? ((stats.inputTokens + stats.outputTokens) / 1000).toFixed(1) + 'k' : null
  const cost = stats?.costUsd

  return (
    <footer className="statusbar">
      <button className="icon-btn raised small" onClick={onToggleRail} title={railCollapsed ? '展开会话管理' : '折叠会话管理'}>
        <IconPanelLeft size={14} />
      </button>
      <span className="status-item mono">{model}</span>
      {pct != null && <span className="status-item mono">上下文 {pct}%</span>}
      {tok && <span className="status-item mono">{tok}</span>}
      {totalTok && stats && (
        <button className="status-item status-link" onClick={onOpenStats} title="会话累计统计（点击查看明细）">
          累计 {totalTok}
          {cost != null ? ` · $${cost.toFixed(4)}` : ''}
        </button>
      )}
      {queuedCount > 0 && (
        <span className="status-item" title={`插话 ${queued?.steering ?? 0} 条 · 续跑 ${queued?.followUp ?? 0} 条`}>
          排队 {queuedCount}
        </span>
      )}
      <span className="status-spacer" />
      <span className={`status-dot${working ? ' busy' : ''}`} />
      <span className="status-item">{working ? '运行中' : '空闲'}</span>
    </footer>
  )
}

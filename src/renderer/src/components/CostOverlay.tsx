import type { Usage } from '@shared/types'
import { contextTokensOf } from '@shared/types'
import type { SessionStats } from '../state/reducer'

interface Props {
  stats: SessionStats
  /** 最后一回合的即时用量（含上下文规模口径） */
  usage: Usage | null
  contextWindow?: number
  onClose: () => void
}

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function CostOverlay({ stats, usage, contextWindow, onClose }: Props) {
  const ctxTokens = usage ? contextTokensOf(usage) : null
  const pct = ctxTokens !== null && contextWindow && contextWindow > 0 ? Math.min(99, Math.round((ctxTokens / contextWindow) * 100)) : null
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings raised">
        <h2>会话统计</h2>
        <div className="cost-grid">
          <div className="cost-item">
            <span className="cost-label">回合数</span>
            <span className="cost-value">{stats.turns}</span>
          </div>
          <div className="cost-item">
            <span className="cost-label">输入 token（累计，非缓存）</span>
            <span className="cost-value">{k(stats.inputTokens)}</span>
          </div>
          <div className="cost-item">
            <span className="cost-label">输出 token（累计）</span>
            <span className="cost-value">{k(stats.outputTokens)}</span>
          </div>
          <div className="cost-item">
            <span className="cost-label">缓存读 / 写（累计）</span>
            <span className="cost-value">
              {k(stats.cacheReadTokens)} / {k(stats.cacheWriteTokens)}
            </span>
          </div>
          <div className="cost-item">
            <span className="cost-label">估算成本</span>
            <span className="cost-value">{stats.costUsd === null ? '未知（含未收录模型）' : `$${stats.costUsd.toFixed(4)}`}</span>
          </div>
          <div className="cost-item">
            <span className="cost-label">最近回合上下文</span>
            <span className="cost-value">
              {ctxTokens !== null ? `${k(ctxTokens)} tok${pct != null ? ` · ${pct}%` : ''}` : '—'}
            </span>
          </div>
        </div>
        <div className="catalog-hint">价格取自内置模型目录（近似值），缓存读/写按目录价或输入价保守计；以厂商账单为准。</div>
        <div className="settings-actions">
          <button className="btn btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

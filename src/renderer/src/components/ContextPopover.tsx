import { useEffect, useState } from 'react'
import type { ContextBreakdown, ContextSectionKey } from '@shared/types'
import type { SessionStats } from '../state/reducer'
import { getApi } from '../api'

/** 分类配色（固定映射：蓝=消息、琥珀=系统、绿=工具、紫=预留、深灰=空闲；空闲用主题变量适配亮色） */
const SECTION_COLORS: Record<ContextSectionKey, string> = {
  messages: '#3987e5',
  system: '#c98500',
  tools: '#199e70',
  reserve: '#8f6bb4',
  free: 'var(--slate-600)'
}
const k = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

interface Props {
  sessionId: string
  /** 会话当前模型（头部展示；上下文窗口按它解析） */
  model?: string
  contextTokens: number | null
  contextWindow?: number
  /** 会话累计统计（缓存命中率数据源） */
  stats?: SessionStats | null
}

/** 上下文小窗：头部（模型 · 窗口）+ 环形图（分类占比）+ 图例（token 数）+ 距自动压缩进度 + 缓存命中率 */
export function ContextPopover({ sessionId, model, contextTokens, contextWindow, stats }: Props) {
  const [data, setData] = useState<ContextBreakdown | null>(null)

  useEffect(() => {
    void getApi()
      .contextBreakdown(sessionId)
      .then(setData)
      .catch(() => undefined)
  }, [sessionId, contextTokens]) // contextTokens 变化（新回合落账）时重取，保持小窗随对话增长

  // 窗口口径：主进程按会话模型解析的权威值优先；props（渲染层目录推导）为加载完成前的即时回退
  const win = data?.window ?? (contextWindow && contextWindow > 0 ? contextWindow : 64_000)
  // 全窗统一估算口径（与弧线/图例同源）： breakdown 未载入时才回落 API 用量
  const used = data?.used ?? contextTokens ?? 0
  // 大窗口（如 1M）下整数百分比会把 <1% 抹成 0：与 chip 同口径的分段精度（≥10 取整 / <10 一位小数 / <0.1 显示 "<0.1"）
  const usedPctRaw = win > 0 ? Math.min(100, (used / win) * 100) : 0
  const usedPctText = usedPctRaw >= 10 ? `${Math.round(usedPctRaw)}` : usedPctRaw >= 0.1 ? usedPctRaw.toFixed(1) : usedPctRaw > 0 ? '<0.1' : '0'
  // 占比文本：≥1% 取整；但 ≥99% 时保留一位小数（99.8% 不能被抹成 100%——否则与"已用 0.2%"并列成"空闲 100%"）；
  // <1% 显示一位小数，避免非零段被抹成 0%
  const pctOf = (tokens: number): string => {
    if (win <= 0 || tokens <= 0) return '0%'
    const p = (tokens / win) * 100
    if (p >= 100) return '100%'
    if (p >= 99) return `${p.toFixed(1)}%`
    if (p >= 1) return `${Math.round(p)}%`
    return `${p.toFixed(1)}%`
  }

  // 缓存命中率（会话累计）：缓存读 ÷ (缓存读 + 非缓存输入 + 缓存写)；从未命中过则不显示。
  // 写（cache_creation）仅 Anthropic 等上报——DeepSeek 等 OpenAI 兼容端点无此概念（恒 0），为 0 时不展示
  const cacheRead = stats?.cacheReadTokens ?? 0
  const cacheWrite = stats?.cacheWriteTokens ?? 0
  const plainInput = stats?.inputTokens ?? 0
  const cacheInfo =
    cacheRead > 0
      ? { rate: Math.round((cacheRead / (cacheRead + plainInput + cacheWrite)) * 100), read: cacheRead, write: cacheWrite, input: plainInput }
      : null
  const cacheParts = cacheInfo
    ? [`命中 ${k(cacheInfo.read)}`, `未命中 ${k(cacheInfo.input)}`, ...(cacheInfo.write > 0 ? [`写 ${k(cacheInfo.write)}`] : [])]
    : []

  // 环形图：半径/周长与分段（分母取 max(窗口, 合计)——超窗时归一化避免弧段 overdraw）；
  // 段间留缝（butt 端帽），缝隙随分段过密自动消失
  const R = 32
  const CIRC = 2 * Math.PI * R
  const GAP = 2.5
  const sections = data?.sections ?? []
  const sum = sections.reduce((s, x) => s + x.tokens, 0)
  const denom = Math.max(win, sum)
  let offset = 0
  const arcs = sections.map((s) => {
    const frac = denom > 0 ? Math.min(1, s.tokens / denom) : 0
    const len = Math.max(0, frac * CIRC - GAP)
    const arc = { key: s.key, color: SECTION_COLORS[s.key], dash: len, start: offset + GAP / 2 }
    offset += frac * CIRC
    return arc
  })

  // 距自动压缩已取消展示：空闲段（窗口 − 已用）即窗口剩余容量的诚实口径

  return (
    <div className="ctx-pop">
      <div className="ctx-head mono" title="上下文窗口按该会话所选模型的目录定义解析">
        <span className="ctx-head-model">{model || '默认模型'}</span>
        <span className="ctx-head-win">窗口 {k(win)}</span>
      </div>
      <div className="donut-row">
        <svg className="donut" width="88" height="88" viewBox="0 0 88 88">
          <circle cx="44" cy="44" r={R} fill="none" stroke="var(--slate-700)" strokeWidth="9" />
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx="44"
              cy="44"
              r={R}
              fill="none"
              stroke={a.color}
              strokeWidth="9"
              strokeDasharray={`${a.dash} ${CIRC - a.dash}`}
              strokeDashoffset={-a.start}
              transform="rotate(-90 44 44)"
            />
          ))}
          <text x="44" y="42" textAnchor="middle" className="donut-num mono">
            {k(used)}
          </text>
          <text x="44" y="56" textAnchor="middle" className="donut-pct mono">
            已用 {usedPctText}%
          </text>
        </svg>
        <div className="donut-legend">
          {sections.map((s) => (
            <div key={s.key} className="ctx-row" title={`${s.label} ≈ ${k(s.tokens)} tok`}>
              <span className="ctx-dot" style={{ background: SECTION_COLORS[s.key] }} />
              <span className="ctx-row-label">{s.label}</span>
              <span className="ctx-row-tok mono">{k(s.tokens)}</span>
              <span className="ctx-row-pct mono">{pctOf(s.tokens)}</span>
            </div>
          ))}
        </div>
      </div>
      {cacheInfo && (
        <div className="ctx-cache" title="命中率 = 缓存读 ÷ 总输入（会话累计）">
          <div className="ctx-row">
            <span className="ctx-dot" style={{ background: 'var(--acc)' }} />
            <span className="ctx-row-label">缓存命中率</span>
            <span className="ctx-row-pct mono" style={{ color: cacheInfo.rate >= 50 ? 'var(--acc)' : 'var(--warn)' }}>
              {cacheInfo.rate}%
            </span>
          </div>
          <div className="ctx-cache-bar" role="presentation">
            <div className="ctx-cache-fill" style={{ width: `${cacheInfo.rate}%` }} />
          </div>
          <div className="ctx-cache-sub mono">{cacheParts.join(' · ')}</div>
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import type { SessionMeta } from '@shared/types'
import { IconBranch, IconDownload, IconSearch, IconTrash } from './icons'

// 会话按时间分组标签（自 Sidebar.tsx 原样迁移）
function groupLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = (day(now) - day(d)) / 86_400_000
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff <= 7) return '近 7 天'
  return '更早'
}

function relTime(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
}

interface Props {
  sessions: SessionMeta[]
  currentSessionId: string
  working: boolean
  onNew: () => void
  onSwitch: (id: string) => void
  /** 删除（内部 confirm 确认后回调） */
  onDelete: (id: string) => void
  onOpenTree: () => void
  onExport: (id: string) => void
  onImport: () => void
}

export function RailSessions(p: Props) {
  const [query, setQuery] = useState('')
  const filtered = p.sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
  const groups: { label: string; items: SessionMeta[] }[] = []
  for (const s of filtered) {
    const label = groupLabel(s.updatedAt)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(s)
    else groups.push({ label, items: [s] })
  }
  return (
    <>
      <button className="btn btn-primary new-chat" disabled={p.working} onClick={p.onNew}>＋ 新建对话</button>
      <div className="search sunken">
        <span className="search-icon"><IconSearch size={13} /></span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索会话" />
      </div>
      <button className="btn btn-ghost branch-entry" disabled={p.working || !p.currentSessionId} onClick={p.onOpenTree} title="浏览当前会话的分支树">
        <IconBranch size={13} /> 分支树
      </button>
      <div className="session-head">
        <span className="session-group-label">会话</span>
        <button className="btn btn-ghost" disabled={p.working} onClick={p.onImport} title="从 JSONL 文件导入会话">导入</button>
      </div>
      <div className="session-list">
        {groups.length === 0 && <div className="session-empty">暂无会话</div>}
        {groups.map((g) => (
          <div key={g.label} className="session-group">
            <div className="session-group-label">{g.label}</div>
            {g.items.map((s) => (
              <div key={s.id} className="session-entry">
                <button
                  className={`session-item ${s.id === p.currentSessionId ? 'active' : ''}`}
                  disabled={p.working}
                  onClick={() => p.onSwitch(s.id)}
                  title={s.title}
                >
                  <span className="session-title">{s.title}</span>
                  <span className="session-time">{relTime(s.updatedAt)}</span>
                </button>
                <button className="icon-btn raised small session-export" disabled={p.working} onClick={() => p.onExport(s.id)} title="导出"><IconDownload size={13} /></button>
                <button
                  className="icon-btn raised small session-export"
                  disabled={p.working}
                  onClick={() => {
                    if (window.confirm(`删除会话「${s.title}」？此操作不可恢复。`)) p.onDelete(s.id)
                  }}
                  title="删除会话"
                >
                  <IconTrash size={13} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

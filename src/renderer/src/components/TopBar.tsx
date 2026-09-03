import { useEffect, useRef, useState } from 'react'
import type { ApiConfig, ThinkingLevel } from '@shared/types'
import { findPreset } from '@shared/providers'
import { IconFolder, IconGear, IconMoon, IconSun } from './icons'

interface Props {
  config: ApiConfig
  working: boolean
  /** 当前主题（☾/☀ 按钮据此渲染） */
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onSwitchProject: (path: string) => void
  onPickFolder: () => void
  onOpenSettings: () => void
  /** 快捷切换思考档位（写完整 modelParams，配合 config:set 浅合并契约） */
  onSetThinking: (level: ThinkingLevel) => void
}

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const baseName = (p: string) => p.split('\\').pop() ?? p

export function TopBar({ config, working, theme, onToggleTheme, onSwitchProject, onPickFolder, onOpenSettings, onSetThinking }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <header className="topbar">
      <div className="project-select" ref={ref}>
        <button className="project-btn raised" disabled={working} onClick={() => setOpen((v) => !v)}>
          <IconFolder size={14} />
          <span className="project-name" title={config.workspacePath}>
            {baseName(config.workspacePath)}
          </span>
          <span className="caret">▾</span>
        </button>
        {open && (
          <div className="dropdown raised">
            {config.recentProjects.map((p) => (
              <button
                key={p}
                className={`dropdown-item ${p === config.workspacePath ? 'active' : ''}`}
                onClick={() => {
                  setOpen(false)
                  if (p !== config.workspacePath) onSwitchProject(p)
                }}
                title={p}
              >
                <IconFolder size={13} />
                <span className="dropdown-name">{baseName(p)}</span>
                <span className="dropdown-path">{p}</span>
              </button>
            ))}
            <button
              className="dropdown-item"
              onClick={() => {
                setOpen(false)
                onPickFolder()
              }}
            >
              <span>＋</span>
              <span className="dropdown-name">选择文件夹…</span>
            </button>
          </div>
        )}
      </div>
      <div className="topbar-right">
        <button className="icon-btn theme-btn" onClick={onToggleTheme} title={theme === 'light' ? '切换暗色' : '切换明亮'}>
          {theme === 'light' ? <IconMoon size={14} /> : <IconSun size={14} />}
        </button>
        <select
          className="thinking-select sunken"
          value={config.modelParams?.thinkingLevel ?? ''}
          onChange={(e) => onSetThinking(e.target.value as ThinkingLevel)}
          title="思考档位（thinking level）"
        >
          <option value="">思考：默认</option>
          {THINKING_LEVELS.map((l) => (
            <option key={l} value={l}>
              思考：{l}
            </option>
          ))}
        </select>
        <button className="model-badge sunken" onClick={onOpenSettings} title="点击修改模型设置">
          {findPreset(config.providerId)?.label ? `${findPreset(config.providerId)!.label} · ` : ''}
          {config.model}
        </button>
        <button className="icon-btn raised" onClick={onOpenSettings} title="设置">
          <IconGear size={14} />
        </button>
      </div>
    </header>
  )
}

import { IconBranch, IconGear, IconMoon, IconPanelLeft, IconSun } from './icons'

interface Props {
  /** 当前主题（☾/☀ 按钮据此渲染） */
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onOpenSettings: () => void
  /** Git 源代码管理面板开关（点击图标在侧栏展开/收起） */
  gitOpen: boolean
  onToggleGit: () => void
  /** 折叠会话管理侧栏 */
  onToggleRail: () => void
}

/** 侧栏顶部单行：Git 源代码管理 + 折叠 + 主题/设置（项目选择在聊天窗头部） */
export function TopBar({ theme, onToggleTheme, onOpenSettings, gitOpen, onToggleGit, onToggleRail }: Props) {
  return (
    <div className="rail-top">
      <span className="rail-top-spacer" />
      <button
        className={`rail-icon-btn${gitOpen ? ' on' : ''}`}
        onClick={onToggleGit}
        title={gitOpen ? '收起 Git 源代码管理' : 'Git 源代码管理'}
      >
        <IconBranch size={13} />
      </button>
      <button className="rail-icon-btn" onClick={onToggleRail} title="折叠会话管理">
        <IconPanelLeft size={13} />
      </button>
      <button className="rail-icon-btn" onClick={onToggleTheme} title={theme === 'light' ? '切换暗色' : '切换明亮'}>
        {theme === 'light' ? <IconMoon size={13} /> : <IconSun size={13} />}
      </button>
      <button className="rail-icon-btn" onClick={onOpenSettings} title="设置">
        <IconGear size={13} />
      </button>
    </div>
  )
}

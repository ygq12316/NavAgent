import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { getApi } from './api'
import type { ApiConfig, ImageContent, PermissionDecision, SessionMeta, ThinkingLevel } from '@shared/types'
import { parseCommand } from '@shared/types'
import { appReducer, initialAppState, initialSessionState } from './state/reducer'
import { defaultPaneLayout, loadPrefs, loadSessionLayouts, savePrefs, saveSessionLayouts, type PaneNode, type UiPrefs } from './state/pane-layout'
import { SessionArea } from './components/pane/SessionArea'
import { SessionView } from './components/pane/SessionView'
import { RailSessions } from './components/RailSessions'
import { TopBar } from './components/TopBar'
import { GitPanel } from './components/GitPanel'
import { StatusBar } from './components/StatusBar'
import { SettingsOverlay } from './components/SettingsOverlay'
import { ExtensionPanelHost } from './components/ExtensionPanelHost'
import { IconGear, IconMoon, IconPanelLeft, IconSun } from './components/icons'
import { registerExtraCatalog } from '@shared/model-catalog'

export default function App() {
  const api = getApi()
  const [state, dispatch] = useReducer(appReducer, initialAppState)
  const [config, setConfig] = useState<ApiConfig | null>(null)
  const [prefs, setPrefs] = useState<UiPrefs>(loadPrefs)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 侧栏 Git 源代码管理面板开关
  const [gitOpen, setGitOpen] = useState(false)
  // 「点击改动文件 → 打开其 diff」：跨 App→SessionView→DiffPane 定位
  const [diffFocus, setDiffFocus] = useState<{ sessionId: string; path: string; key: number } | null>(null)
  const panesRef = useRef(state.panes)
  panesRef.current = state.panes

  // 主题落 <html data-theme> + 偏好持久化 + 融合标题栏 overlay 配色同步
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme
    void api.setOverlayTheme(prefs.theme)
    savePrefs(prefs)
  }, [prefs])

  // 事件订阅（信封 → reducer 按会话路由；'' = 应用级 notice → 聚焦会话）
  useEffect(() => api.onEvent((payload) => dispatch({ kind: 'addressed', ...payload })), [])

  // 目录快照注册（会话生效上下文窗口/成本计价的 EXTRA_CATALOG 数据源）；注册后触发重渲染
  const [, bumpCatalog] = useState(0)
  useEffect(() => {
    void api
      .listCatalog()
      .then((snap) => {
        registerExtraCatalog(snap.models)
        bumpCatalog((v) => v + 1)
      })
      .catch(() => undefined)
  }, [])

  // 每会话布局记忆：启动时装载持久化布局；布局变化后防抖写回
  useEffect(() => {
    const saved = loadSessionLayouts()
    if (Object.keys(saved).length > 0) dispatch({ kind: 'seedLayouts', layouts: saved })
  }, [])
  useEffect(() => {
    const t = window.setTimeout(() => saveSessionLayouts(state.layouts), 400)
    return () => window.clearTimeout(t)
  }, [state.layouts])

  // 会话按项目分组加载（rail 项目级一级列表的数据源）
  const projects = config ? [...new Set([config.workspacePath, ...config.recentProjects])].filter(Boolean) : []
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, SessionMeta[]>>({})
  const refreshSessions = useCallback(() => {
    void Promise.all(
      projects.map((p) =>
        api
          .listSessions(p)
          .then((list) => [p, list] as const)
          .catch(() => [p, [] as SessionMeta[]] as const)
      )
    ).then((entries) => setSessionsByProject(Object.fromEntries(entries)))
  }, [api, projects.join('|')])
  const sessionList = useMemo(() => Object.values(sessionsByProject).flat(), [sessionsByProject])

  // 启动：配置 → 会话列表 → 打开最近会话（hydrate）
  useEffect(() => {
    void api.getConfig().then(async (c) => {
      setConfig(c)
      const projects0 = [...new Set([c.workspacePath, ...c.recentProjects])].filter(Boolean)
      const entries = await Promise.all(
        projects0.map((p) =>
          api
            .listSessions(p)
            .then((list) => [p, list] as const)
            .catch(() => [p, [] as SessionMeta[]] as const)
        )
      )
      const byProject = Object.fromEntries(entries)
      setSessionsByProject(byProject)
      const first = Object.values(byProject).flat()[0]
      if (first) {
        dispatch({ kind: 'openSession', sessionId: first.id, side: 'left' })
        const r = await api.loadSession(first.id)
        dispatch({ kind: 'hydrate', sessionId: first.id, result: r })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const focused = state.panes.focus === 'right' && state.panes.right ? state.panes.right : state.panes.left
  const focusBucket = state.sessions[focused] ?? initialSessionState

  /** 打开会话：进 pane + hydrate 历史 */
  const openSession = useCallback(
    async (id: string, side?: 'left' | 'right') => {
      dispatch({ kind: 'openSession', sessionId: id, side })
      const r = await api.loadSession(id)
      dispatch({ kind: 'hydrate', sessionId: id, result: r })
    },
    [api]
  )

  const handleNewSession = async () => {
    const id = await api.newSession(config?.workspacePath ?? '')
    refreshSessions()
    await openSession(id, panesRef.current.focus)
  }

  const handleOpen = (id: string, side: 'left' | 'right') => {
    // 点击已在焦点栏打开的会话：仅聚焦；Ctrl+点击已在右栏：聚焦右栏
    if (side === 'left' && state.panes.left === id && !state.panes.right) return
    void openSession(id, side)
  }

  const handleSend = (text: string, images?: ImageContent[]) => {
    if (!focused) return
    dispatch({ kind: 'setDraft', sessionId: focused, text: '' })
    // 斜杠命令：/compact、扩展命令、prompt 模板统一由主进程分发
    if (text.startsWith('/')) {
      const cmd = parseCommand(text)
      if (!cmd) return
      void api.dispatchCommand(focused, cmd.name, cmd.args).then((r) => {
        if (r === 'ok') refreshSessions()
      })
      return
    }
    void api.send(focused, text, images).then(() => refreshSessions())
  }

  /** Alt+Enter：运行中排队续跑，本轮结束后自动运行（pi 的 follow-up 语义） */
  const handleFollowUp = (text: string) => {
    if (!focused) return
    void api.followUp(focused, text)
  }

  const handleCancel = async () => {
    if (!focused) return
    // pi 的 Escape 行为：取消时取回尚未消费的排队消息，回填输入框
    const drained = await api.cancel(focused)
    const texts = drained.filter((t) => t.trim().length > 0)
    if (texts.length > 0) {
      const cur = state.drafts[focused] ?? ''
      dispatch({ kind: 'setDraft', sessionId: focused, text: (cur ? cur + '\n' : '') + texts.join('\n') })
    }
  }

  /** 删除会话：main 侧清理实例/worktree/日志；从所有 pane 摘除 */
  const handleDeleteSession = async (id: string) => {
    const r = await api.deleteSession(id)
    if (r !== 'ok') return
    if (state.panes.right === id) dispatch({ kind: 'closeSessionPane', side: 'right' })
    else if (state.panes.left === id) {
      const next = sessionList.find((s) => s.id !== id)
      if (next) await openSession(next.id, 'left')
    }
    refreshSessions()
  }

  /** 切项目 = 改新会话默认项目 + 切侧栏列表；运行中的会话不受影响 */
  const handleSwitchProject = async (path: string) => {
    const c = await api.setConfig({ workspacePath: path })
    setConfig(c)
    refreshSessions()
  }

  const handlePickFolder = async () => {
    const p = await api.pickWorkspace()
    if (p) await handleSwitchProject(p)
  }

  /** 会话重锚工作目录：聊天窗头部项目选择器切换当前会话的 folder（文件树/工具/git 即时跟随） */
  const handleSwitchSessionProject = async (sid: string, path: string) => {
    if (!sid) return
    const meta = await api.setSessionProject(sid, path)
    if (meta) dispatch({ kind: 'patchMeta', sessionId: sid, patch: { projectPath: meta.projectPath } })
    refreshSessions()
  }

  const handlePermissionFor = async (sid: string, decision: PermissionDecision) => {
    const bucket = state.sessions[sid]
    if (!bucket?.permission) return
    const { requestId } = bucket.permission
    dispatch({ kind: 'closePermission', sessionId: sid })
    await api.respondPermission(requestId, decision)
  }

  /** 扩展弹窗（ctx.ui）应答：先清槽位再送回主进程（requestId 全局路由） */
  const handleRespondUi = (sid: string, requestId: string, value: string | boolean | null) => {
    dispatch({ kind: 'closeUiDialog', sessionId: sid })
    void api.respondUi(requestId, value)
  }

  const handleSaveConfig = async (partial: Partial<ApiConfig>) => {
    const c = await api.setConfig(partial)
    setConfig(c)
    setSettingsOpen(false)
  }

  /** 思考档位：modelParams 必须整体提交（config:set 浅合并契约） */
  const handleSetThinking = async (level: ThinkingLevel) => {
    if (!config) return
    const c = await api.setConfig({ modelParams: { ...config.modelParams, thinkingLevel: level } })
    setConfig(c)
  }

  /** 模型切换悬浮窗：会话级切换（meta.model 持久化；provider/上下文窗口主进程按会话解析），不影响其他会话 */
  const handleSetModel = async (sid: string, model: string) => {
    const meta = await api.setSessionModel(sid, model)
    if (meta) dispatch({ kind: 'patchMeta', sessionId: sid, patch: { model: meta.model } })
  }

  /** 回到消息：切换树叶子到该节点（丢弃后续），重放该会话 */
  const handleRewind = async (sid: string, nodeId: string) => {
    const r = await api.switchLeaf(sid, nodeId, false)
    if (r === 'busy') return
    const res = await api.loadSession(sid)
    dispatch({ kind: 'hydrate', sessionId: sid, result: res })
  }

  /** 从消息分叉新会话并打开 */
  const handleFork = async (sid: string, nodeId: string) => {
    const newId = await api.forkSession(sid, nodeId)
    if (!newId) return
    refreshSessions()
    await openSession(newId, state.panes.focus)
  }

  /** 导出为 HTML（可读快照） */
  const handleExport = async (id: string) => {
    await api.exportSession(id, 'html')
    refreshSessions()
  }

  /** 重命名会话（rail 三点菜单 → 行内输入提交） */
  const handleRename = async (id: string, title: string) => {
    await api.renameSession(id, title)
    refreshSessions()
    if (state.metas[id]) dispatch({ kind: 'patchMeta', sessionId: id, patch: { title } })
  }

  /** 归档 / 取消归档（归档项收进「已归档」分组） */
  const handleArchive = async (id: string, archived: boolean) => {
    await api.setSessionArchived(id, archived)
    refreshSessions()
    dispatch({ kind: 'patchMeta', sessionId: id, patch: { archived: archived || undefined } })
  }

  /** Git 面板点击改动文件 → 打开该会话的 diff pane 并聚焦该文件 */
  const handleOpenDiff = (sid: string, path: string) => {
    if (!sid) return
    const cur = state.layouts[sid] ?? defaultPaneLayout()
    const hasDiff = (() => {
      const walk = (n: PaneNode): boolean => (n.t === 'leaf' ? n.kind === 'diff' : walk(n.a) || walk(n.b))
      return walk(cur)
    })()
    if (!hasDiff) dispatch({ kind: 'togglePane', sessionId: sid, pane: 'diff' })
    setDiffFocus({ sessionId: sid, path, key: Date.now() })
  }

  // Esc：审批拒绝 → 关设置 → 停止（对齐 pi）
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      if (focusBucket.permission) void handlePermissionFor(focused, 'deny')
      else if (focusBucket.uiDialog) {
        dispatch({ kind: 'closeUiDialog', sessionId: focused })
        void api.respondUi(focusBucket.uiDialog.requestId, null)
      }
      else if (settingsOpen) setSettingsOpen(false)
      else if (focusBucket.working) void handleCancel()
    }
    window.addEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => window.removeEventListener('keydown', onKey)
  }, [focusBucket.permission, focusBucket.uiDialog, focusBucket.working, settingsOpen, focused, state.drafts])

  // 快捷键（对齐 CC 桌面端；Ctrl 系）
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.ctrlKey || ev.altKey) return
      const key = ev.key.toLowerCase()
      if (key === 'n') {
        ev.preventDefault()
        void handleNewSession()
      } else if (ev.key === 'Tab') {
        ev.preventDefault()
        if (state.panes.right) {
          dispatch({ kind: 'focusSessionPane', side: state.panes.focus === 'left' ? 'right' : 'left' })
        }
      } else if (key === '`') {
        ev.preventDefault()
        if (focused) dispatch({ kind: 'togglePane', sessionId: focused, pane: 'terminal' })
      } else if (ev.shiftKey && key === 'd') {
        ev.preventDefault()
        if (focused) dispatch({ kind: 'togglePane', sessionId: focused, pane: 'diff' })
      } else if (key === 'o') {
        ev.preventDefault()
        if (focused) {
          const cur = state.viewModes[focused] ?? 'normal'
          dispatch({ kind: 'setViewMode', sessionId: focused, mode: cur === 'normal' ? 'verbose' : cur === 'verbose' ? 'summary' : 'normal' })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => window.removeEventListener('keydown', onKey)
  }, [state.panes, state.viewModes, focused, config])

  if (!config) return <div className="app-loading">启动中…</div>

  const activeIds = [state.panes.left, state.panes.right].filter((x): x is string => Boolean(x))
  const workingIds = new Set(Object.entries(state.sessions).filter(([, b]) => b.working).map(([id]) => id))

  const renderSession = (side: 'left' | 'right') => {
    const sid = side === 'right' ? state.panes.right : state.panes.left
    if (!sid) return null
    const bucket = state.sessions[sid] ?? initialSessionState
    return (
      <SessionView
        key={`${sid}:${side}`}
        side={side}
        sessionId={sid}
        meta={state.metas[sid]}
        bucket={bucket}
        layout={state.layouts[sid] ?? defaultPaneLayout()}
        maximized={state.maximized[sid] ?? null}
        draft={state.drafts[sid] ?? ''}
        fileTarget={state.fileTargets[sid] ?? null}
        ptys={state.ptys[sid] ?? []}
        diffSummary={state.diffSummaries[sid] ?? null}
        viewMode={state.viewModes[sid] ?? 'normal'}
        config={config}
        diffFocus={diffFocus}
        active={state.panes.focus === side}
        onSetDraft={(text) => dispatch({ kind: 'setDraft', sessionId: sid, text })}
        onSend={handleSend}
        onFollowUp={handleFollowUp}
        onCancel={() => void handleCancel()}
        onDispatchCommand={(name, args) => void api.dispatchCommand(sid, name, args)}
        onRespondPermission={(d) => void handlePermissionFor(sid, d)}
        onRespondUi={(requestId, value) => handleRespondUi(sid, requestId, value)}
        onOpenPath={(path) => dispatch({ kind: 'openFile', sessionId: sid, path })}
        onTogglePane={(pane) => dispatch({ kind: 'togglePane', sessionId: sid, pane })}
        onToggleMaximize={(kind) =>
          dispatch({ kind: 'setMaximized', sessionId: sid, pane: (state.maximized[sid] ?? null) === kind ? null : kind })
        }
        onClosePane={(kind) => dispatch({ kind: 'closePane', sessionId: sid, pane: kind })}
        onPaneAction={(a) => dispatch({ ...a, sessionId: sid })}
        onSetMode={(mode) => {
          void api.setSessionMode(sid, mode)
          dispatch({ kind: 'patchMeta', sessionId: sid, patch: { permissionMode: mode } })
        }}
        onSetThinking={(l) => void handleSetThinking(l)}
        onSetViewMode={(mode) => dispatch({ kind: 'setViewMode', sessionId: sid, mode })}
        onSetModel={(id) => void handleSetModel(sid, id)}
        onPtyCreated={(ptyId) => dispatch({ kind: 'setPty', sessionId: sid, ptyId })}
        onPtyClosed={(ptyId) => dispatch({ kind: 'removePty', sessionId: sid, ptyId })}
        onSetDiffSummary={(summary) => dispatch({ kind: 'setDiffSummary', sessionId: sid, summary })}
        onRewind={(sessionId, nodeId) => void handleRewind(sessionId, nodeId)}
        onFork={(sessionId, nodeId) => void handleFork(sessionId, nodeId)}
        onCloseSessionPane={() => dispatch({ kind: 'closeSessionPane', side })}
        onSwitchProject={(path) => void handleSwitchSessionProject(sid, path)}
        onPickFolder={() => api.pickWorkspace()}
        onFocus={() => dispatch({ kind: 'focusSessionPane', side })}
      />
    )
  }

  return (
    <div className="app">
      {/* 融合标题栏（CC 桌面端式）：品牌居左，窗口钮由 Windows overlay 绘于右上，整条为拖拽区 */}
      <div className="titlebar">
        <span className="titlebar-brand">
          <span className="titlebar-mark" />
          navAgent
        </span>
      </div>
      <div className="main">
        {!prefs.railCollapsed ? (
          <>
            <aside className="rail" style={{ width: prefs.rail }}>
              <TopBar
                theme={prefs.theme}
                onToggleTheme={() => setPrefs((p) => ({ ...p, theme: p.theme === 'light' ? 'dark' : 'light' }))}
                onOpenSettings={() => setSettingsOpen(true)}
                gitOpen={gitOpen}
                onToggleGit={() => setGitOpen((v) => !v)}
                onToggleRail={() => setPrefs((p) => ({ ...p, railCollapsed: true }))}
              />
              {gitOpen && <GitPanel sessionId={focused} onOpenDiff={(path) => handleOpenDiff(focused, path)} />}
              <RailSessions
                sessionsByProject={sessionsByProject}
                projects={projects}
                activeProject={config.workspacePath}
                activeIds={activeIds}
                workingIds={workingIds}
                onNew={() => void handleNewSession()}
                onOpen={handleOpen}
                onDelete={(id) => void handleDeleteSession(id)}
                onExport={(id) => void handleExport(id)}
                onRename={(id, title) => void handleRename(id, title)}
                onArchive={(id, archived) => void handleArchive(id, archived)}
              />
            </aside>
            <div
              className="rail-splitter"
              title="侧栏宽度（160–320）"
              onPointerDown={(e) => {
                e.preventDefault()
                const move = (ev: PointerEvent) => setPrefs((p) => ({ ...p, rail: Math.min(320, Math.max(160, ev.clientX - 8)) }))
                const up = () => {
                  window.removeEventListener('pointermove', move)
                  window.removeEventListener('pointerup', up)
                }
                window.addEventListener('pointermove', move)
                window.addEventListener('pointerup', up)
              }}
            />
          </>
        ) : (
          <div className="rail-collapsed">
            <button
              className="rail-icon-btn"
              onClick={() => setPrefs((p) => ({ ...p, railCollapsed: false }))}
              title="展开会话管理"
            >
              <IconPanelLeft size={14} />
            </button>
            <button
              className="rail-icon-btn"
              onClick={() => setPrefs((p) => ({ ...p, theme: p.theme === 'light' ? 'dark' : 'light' }))}
              title={prefs.theme === 'light' ? '切换暗色' : '切换明亮'}
            >
              {prefs.theme === 'light' ? <IconMoon size={13} /> : <IconSun size={13} />}
            </button>
            <button className="rail-icon-btn" onClick={() => setSettingsOpen(true)} title="设置">
              <IconGear size={13} />
            </button>
          </div>
        )}
        <SessionArea left={renderSession('left')} right={renderSession('right')} />
      </div>
      <StatusBar queued={focusBucket.queued} />
      {settingsOpen && (
        <SettingsOverlay
          config={config}
          onSave={(p) => void handleSaveConfig(p)}
          onConfigChange={setConfig}
          onClose={() => setSettingsOpen(false)}
          onPickFolder={() => void handlePickFolder()}
        />
      )}
      <ExtensionPanelHost onNavigated={(id) => void openSession(id)} />
    </div>
  )
}

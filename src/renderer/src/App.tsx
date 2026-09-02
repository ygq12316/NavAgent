import { useEffect, useReducer, useState } from 'react'
import { getApi } from './api'
import type { ApiConfig, ImageContent, PermissionDecision, SessionMeta, ThinkingLevel } from '@shared/types'
import { contextTokensOf, parseCommand } from '@shared/types'
import { initialState, reducer } from './state/reducer'
import { layoutReducer, loadLayout, saveLayout } from './state/layout'
import type { FreeKind } from './state/layout'
import { DockRoot } from './components/dock/DockRoot'
import { RailSessions } from './components/RailSessions'
import { FilesWindow } from './components/FilesWindow'
import { FileWindow } from './components/FileWindow'
import { TerminalWindow } from './components/TerminalWindow'
import { TopBar } from './components/TopBar'
import { Transcript } from './components/Transcript'
import { Composer } from './components/Composer'
import { StatusBar } from './components/StatusBar'
import { SettingsOverlay } from './components/SettingsOverlay'
import { TreeOverlay } from './components/TreeOverlay'
import { CostOverlay } from './components/CostOverlay'

export default function App() {
  const api = getApi()
  const [state, dispatch] = useReducer(reducer, initialState)
  const [config, setConfig] = useState<ApiConfig | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [currentSessionId, setCurrentSessionId] = useState('')
  const [layout, layoutDispatch] = useReducer(layoutReducer, undefined, loadLayout)
  const [fileWin, setFileWin] = useState<{ path: string; key: number } | null>(null)
  const [fileDirty, setFileDirty] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  const [costOpen, setCostOpen] = useState(false)
  const [trustOnceIds, setTrustOnceIds] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState('')

  // 主题落 <html data-theme> + 布局持久化（localStorage）
  useEffect(() => {
    document.documentElement.dataset.theme = layout.theme
    saveLayout(layout)
  }, [layout])

  const layoutApi = {
    open: (win: Exclude<FreeKind, 'chat'>) => layoutDispatch({ kind: 'open', win }),
    theme: layout.theme,
    toggleTheme: () => layoutDispatch({ kind: 'setTheme', theme: layout.theme === 'light' ? 'dark' : 'light' }),
    toggleRail: () => layoutDispatch({ kind: 'toggleRail' }),
    railCollapsed: layout.railCollapsed
  }

  /** 打开文件到唯一 File 窗口：已关则开、已最小化则恢复、显示中则换内容 */
  const openFile = (path: string) => {
    setFileWin((f) => (f?.path === path ? { path, key: f.key + 1 } : { path, key: (f?.key ?? 0) + 1 }))
    layoutDispatch({ kind: 'open', win: 'file' })
  }

  const refreshSessions = (path: string) => {
    void api.listSessions(path).then(setSessions)
  }

  useEffect(() => {
    void api.getConfig().then((c) => {
      setConfig(c)
      refreshSessions(c.workspacePath)
    })
    return api.onEvent((event) => dispatch({ kind: 'event', event }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const working = state.working

  const handleSend = (text: string, images?: ImageContent[]) => {
    setDraft('')
    // pi 的 steering 语义：运行中的输入不打断执行，进入队列在工具批次间注入（插话只传文本）
    if (working) {
      if (text) void api.steer(text)
      return
    }
    // 斜杠命令：/compact、扩展命令、prompt 模板统一由主进程分发
    if (text.startsWith('/')) {
      const cmd = parseCommand(text)
      if (!cmd) return
      void api.dispatchCommand(cmd.name, cmd.args).then((r) => {
        if (r === 'ok') refreshSessions(config?.workspacePath ?? '')
      })
      return
    }
    void api.send(text, images).then((r) => {
      if (r === 'ok') refreshSessions(config?.workspacePath ?? '')
    })
  }

  /** Alt+Enter：运行中排队续跑，本轮结束后自动运行（pi 的 follow-up 语义） */
  const handleFollowUp = (text: string) => {
    void api.followUp(text)
  }

  const handleCancel = async () => {
    // pi 的 Escape 行为：取消时取回尚未消费的排队消息，回填输入框
    const drained = await api.cancel()
    const texts = drained.filter((t) => t.trim().length > 0)
    if (texts.length > 0) setDraft((d) => (d ? d + '\n' : '') + texts.join('\n'))
  }

  const handleNewSession = async () => {
    if (working) return
    const id = await api.newSession()
    setCurrentSessionId(id)
    dispatch({ kind: 'reset' })
    refreshSessions(config?.workspacePath ?? '')
  }

  const handleSwitchSession = async (id: string) => {
    if (working || id === currentSessionId) return
    dispatch({ kind: 'reset' })
    setCurrentSessionId(id)
    await api.switchSession(id)
  }

  /** 删除会话（busy = 当前会话运行中，主进程拒绝）；删的是当前会话则切到列表第一个 */
  const handleDeleteSession = async (id: string) => {
    const r = await api.deleteSession(id)
    if (r === 'busy') return
    const list = await api.listSessions(config?.workspacePath ?? '')
    setSessions(list)
    if (id === currentSessionId) {
      dispatch({ kind: 'reset' })
      const next = list[0]?.id ?? ''
      setCurrentSessionId(next)
      if (next) await api.switchSession(next)
    }
  }

  const handleSwitchProject = async (path: string) => {
    if (working) return
    const c = await api.setConfig({ workspacePath: path })
    setConfig(c)
    dispatch({ kind: 'reset' })
    const list = await api.listSessions(path)
    setCurrentSessionId(list[0]?.id ?? '')
    refreshSessions(path)
    if (list[0]) await api.switchSession(list[0].id)
  }

  const handlePickFolder = async () => {
    if (working) return
    const p = await api.pickWorkspace()
    if (p) await handleSwitchProject(p)
  }

  const handlePermission = async (decision: PermissionDecision) => {
    if (!state.permission) return
    const { requestId } = state.permission
    dispatch({ kind: 'closePermission' })
    await api.respondPermission(requestId, decision)
  }

  const handleSaveConfig = async (partial: Partial<ApiConfig>) => {
    const c = await api.setConfig(partial)
    setConfig(c)
    setSettingsOpen(false)
  }

  /** TopBar 快捷思考档位：modelParams 必须整体提交（config:set 浅合并契约） */
  const handleSetThinking = async (level: ThinkingLevel) => {
    if (!config) return
    const c = await api.setConfig({ modelParams: { ...config.modelParams, thinkingLevel: level } })
    setConfig(c)
  }

  /** 未信任项目：项目级扩展不加载，提示用户决策 */
  const showTrust =
    config !== null && config.workspacePath.length > 0 && !config.trustedProjects.includes(config.workspacePath) && !trustOnceIds.has(config.workspacePath)

  const handleTrust = async () => {
    await api.trustProject()
    setConfig(await api.getConfig())
  }
  const handleTrustOnce = async () => {
    await api.trustProjectOnce()
    setTrustOnceIds((s) => new Set(s).add(config?.workspacePath ?? ''))
    setConfig(await api.getConfig())
  }

  /** 导出为 HTML（可读快照）；JSONL 导出走同一入口的格式选择——这里默认 HTML */
  const handleExport = async (id: string) => {
    const path = await api.exportSession(id, 'html')
    if (path) refreshSessions(config?.workspacePath ?? '')
  }

  const handleImport = async () => {
    if (working) return
    const newId = await api.importSession()
    if (!newId) return
    dispatch({ kind: 'reset' })
    setCurrentSessionId(newId)
    refreshSessions(config?.workspacePath ?? '')
    await api.switchSession(newId)
  }

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      if (state.permission) void handlePermission('deny')
      else if (settingsOpen) setSettingsOpen(false)
      else if (state.working) handleCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.permission, state.working, settingsOpen])

  if (!config) return <div className="app-loading">启动中…</div>

  return (
    <div className="app">
      <TopBar
        config={config}
        working={working}
        theme={layout.theme}
        onToggleTheme={layoutApi.toggleTheme}
        onSwitchProject={(p) => void handleSwitchProject(p)}
        onPickFolder={() => void handlePickFolder()}
        onOpenSettings={() => setSettingsOpen(true)}
        onSetThinking={(l) => void handleSetThinking(l)}
      />
      {showTrust && (
        <div className="trust-banner">
          <span>
            已进入未信任项目 <strong>{config.workspacePath}</strong>：项目级扩展不会加载。
          </span>
          <span className="trust-actions">
            <button className="btn btn-primary" onClick={() => void handleTrust()}>
              信任此项目
            </button>
            <button className="btn" onClick={() => void handleTrustOnce()}>
              仅本次信任
            </button>
          </span>
        </div>
      )}
      <DockRoot
        layout={layout}
        dispatch={layoutDispatch}
        slots={{
          rail: (
            <RailSessions
              sessions={sessions}
              currentSessionId={currentSessionId}
              working={working}
              onNew={() => void handleNewSession()}
              onSwitch={(id) => void handleSwitchSession(id)}
              onDelete={(id) => void handleDeleteSession(id)}
              onOpenTree={() => setTreeOpen(true)}
              onExport={(id) => void handleExport(id)}
              onImport={() => void handleImport()}
            />
          ),
          windowChrome: (kind) => {
            if (kind === 'chat')
              return {
                title: '聊天',
                locked: true,
                headerActions: (
                  <>
                    <button className="win-btn open-btn" onClick={() => layoutApi.open('files')}>
                      ＋ Files
                    </button>
                    <button
                      className="win-btn open-btn"
                      onClick={() =>
                        void (async () => {
                          const p = await api.pickFile()
                          if (p) openFile(p)
                        })()
                      }
                    >
                      ＋ File
                    </button>
                    <button className="win-btn open-btn" onClick={() => layoutApi.open('terminal')}>
                      ＋ Terminal
                    </button>
                  </>
                )
              }
            if (kind === 'files') return { title: 'Files', sub: '目录', locked: false }
            if (kind === 'file') return { title: 'File', sub: fileWin ? fileWin.path.split(/[\\/]/).pop() : '', locked: false }
            return { title: 'Terminal', locked: false }
          },
          renderWindow: (kind) => {
            if (kind === 'chat')
              return (
                <>
                  <Transcript
                    state={state}
                    onChip={(t) => setDraft(t)}
                    permission={state.permission}
                    onRespond={(d) => void handlePermission(d)}
                    onOpenPath={openFile}
                  />
                  <Composer
                    draft={draft}
                    setDraft={setDraft}
                    working={working}
                    onSend={handleSend}
                    onFollowUp={handleFollowUp}
                    onCancel={handleCancel}
                    model={config.model}
                    thinking={config.modelParams?.thinkingLevel}
                    onSetThinking={(l) => void handleSetThinking(l)}
                    onOpenSettings={() => setSettingsOpen(true)}
                    contextTokens={state.usage ? contextTokensOf(state.usage) : null}
                    contextWindow={config.contextWindow}
                  />
                </>
              )
            if (kind === 'files') return <FilesWindow workspacePath={config.workspacePath} onOpenFile={openFile} />
            if (kind === 'file')
              return fileWin ? (
                <FileWindow key={fileWin.key} path={fileWin.path} reloadKey={fileWin.key} onDirtyChange={setFileDirty} />
              ) : (
                <div className="files-empty">从左侧文件树或聊天中的文件路径打开文件</div>
              )
            return <TerminalWindow />
          },
          onCloseRequest: (kind) => {
            if (kind === 'file' && fileDirty) {
              return window.confirm('File 窗口有未保存修改，确定关闭（丢弃修改）？')
            }
            return true
          }
        }}
      />
      <StatusBar
        railCollapsed={layout.railCollapsed}
        onToggleRail={layoutApi.toggleRail}
        model={config.model}
        usage={state.usage}
        working={working}
        queued={state.queued}
        contextWindow={config.contextWindow}
        stats={state.stats}
        onOpenStats={() => setCostOpen(true)}
      />
      {settingsOpen && (
        <SettingsOverlay
          config={config}
          onSave={(p) => void handleSaveConfig(p)}
          onClose={() => setSettingsOpen(false)}
          onPickFolder={() => void handlePickFolder()}
        />
      )}
      {treeOpen && (
        <TreeOverlay
          sessionId={currentSessionId}
          leafId={sessions.find((s) => s.id === currentSessionId)?.leafId}
          working={working}
          onClose={() => setTreeOpen(false)}
          onReset={() => dispatch({ kind: 'reset' })}
          onSwitched={() => refreshSessions(config.workspacePath)}
          onSessionSwitched={(id) => {
            setCurrentSessionId(id)
            refreshSessions(config.workspacePath)
          }}
        />
      )}
      {costOpen && (
        <CostOverlay stats={state.stats} usage={state.usage} contextWindow={config.contextWindow} onClose={() => setCostOpen(false)} />
      )}
    </div>
  )
}

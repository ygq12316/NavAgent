// src/renderer/src/components/pane/SessionView.tsx
/** 会话 pane：chat 锚点 + 从属 pane（files/file/terminal/preview/diff）。
 *  右侧所有面板从聊天窗口右上角唤出（参考图：chat 头部右半区的小控件群）。 */
import { memo, useEffect, useRef, useState } from 'react'
import type { ApiConfig, DiffSummary, ImageContent, PermissionDecision, PermissionMode, SessionMeta, ThinkingLevel } from '@shared/types'
import type { UIState, ViewMode } from '../../state/reducer'
import type { PaneKind, PaneNode } from '../../state/pane-layout'
import { catalogContextWindowOf } from '@shared/model-catalog'
import { getApi } from '../../api'
import { PaneTree } from './PaneTree'
import { WorkspacePane } from './WorkspacePane'
import { Transcript } from '../Transcript'
import { Composer } from '../Composer'
import { ProjectSelect } from '../ProjectSelect'
import { DiffPane } from '../DiffPane'
import { TerminalWindow } from '../TerminalWindow'
import { IconClose, IconFile, IconGitDiff, IconTerminal } from '../icons'

export interface SessionViewProps {
  side: 'left' | 'right'
  sessionId: string
  meta?: SessionMeta
  bucket: UIState
  layout: PaneNode
  /** 最大化中的 pane（null = 无） */
  maximized: PaneKind | null
  draft: string
  fileTarget: { path: string; key: number } | null
  ptys: string[]
  diffSummary: DiffSummary | null
  viewMode: ViewMode
  config: ApiConfig
  /** Git 面板点击改动文件 → Diff pane 聚焦该文件（跨会话路由，key 触发重新定位） */
  diffFocus?: { sessionId: string; path: string; key: number } | null
  /** 回到此消息后：输入框聚焦信号（key 触发 Composer useEffect） */
  draftFocus?: { sessionId: string; key: number } | null
  active: boolean
  onSetDraft: (text: string) => void
  onSend: (text: string, images?: ImageContent[]) => void
  onFollowUp: (text: string) => void
  onCancel: () => void
  onDispatchCommand: (name: string, args: string) => void
  onRespondPermission: (d: PermissionDecision) => void
  /** 扩展弹窗（ctx.ui）应答 */
  onRespondUi: (requestId: string, value: string | boolean | null) => void
  onOpenPath: (path: string) => void
  onTogglePane: (kind: 'files' | 'file' | 'terminal' | 'diff') => void
  onToggleMaximize: (kind: PaneKind) => void
  onClosePane: (kind: PaneKind) => void
  onPaneAction: (a: { kind: 'paneRatio'; path: number[]; ratio: number } | { kind: 'paneDrop'; win: PaneKind; target: PaneKind; mode: 'left' | 'right' | 'top' | 'bottom' | 'swap' }) => void
  onSetMode: (mode: PermissionMode) => void
  onSetThinking: (level: ThinkingLevel) => void
  onSetModel: (id: string) => void
  onPtyCreated: (ptyId: string) => void
  onPtyClosed: (ptyId: string) => void
  onSetDiffSummary: (summary: DiffSummary | null) => void
  /** 回到此消息（切换树叶子） */
  onRewind: (sessionId: string, nodeId: string) => void
  /** 从此消息分叉新会话 */
  onFork: (sessionId: string, nodeId: string) => void
  onCloseSessionPane: () => void
  onFocus: () => void
  /** 项目选择（聊天窗头部左上角） */
  onSwitchProject: (path: string) => void
  onPickFolder: () => Promise<string | null>
}

/** 聊天右上角的面板召唤钮（图标化 + 悬停说明；文件树与编辑器合并为一个「文件」面板） */
const SUMMONABLE: { kind: 'file' | 'terminal' | 'diff'; label: string; icon: typeof IconFile }[] = [
  { kind: 'file', label: '文件', icon: IconFile },
  { kind: 'terminal', label: '终端', icon: IconTerminal },
  { kind: 'diff', label: 'Diff 审查', icon: IconGitDiff }
]

/** memo：App 级任意状态变化（其他会话事件、draft、布局）不再让无变化的会话 pane 全量重渲染；
 *  只比较数据 props——回调 props 语义稳定（按 sid 闭包 dispatch/api），key 含 sid+side 挂载期不变，故意忽略 */
export const SessionView = memo(function SessionView(p: SessionViewProps) {
  const [fileDirty, setFileDirty] = useState(false)
  const prevWorking = useRef(p.bucket.working)

  const working = p.bucket.working
  const mode: PermissionMode = p.meta?.permissionMode ?? p.config.defaultPermissionMode ?? 'manual'
  // hasPane 读 ref：传给 memo 化 Transcript 的闭包可能跨渲染存活，需取到最新布局
  const layoutRef = useRef(p.layout)
  layoutRef.current = p.layout
  const hasPane = (kind: PaneKind): boolean => {
    const walk = (n: PaneNode): boolean => (n.t === 'leaf' ? n.kind === kind : walk(n.a) || walk(n.b))
    return walk(layoutRef.current)
  }

  // turn 结束后刷新 diff 汇总（+N −M 徽标 + 文件树「本次会话改动」置顶列表）
  const [touchedPaths, setTouchedPaths] = useState<string[] | null>(null)
  useEffect(() => {
    if (prevWorking.current && !working) {
      void getApi()
        .diffSummary(p.sessionId)
        .then((s) => p.onSetDiffSummary(s))
        .catch(() => undefined)
      void getApi()
        .diffGet(p.sessionId)
        .then((d) => setTouchedPaths(d.files.map((f) => f.path)))
        .catch(() => undefined)
    }
    prevWorking.current = working
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, p.sessionId])

  // 切会话即清空改动列表（新会话尚未产生改动）
  useEffect(() => {
    setTouchedPaths(null)
  }, [p.sessionId])

  // 已注入上下文的文件（chip 由 Composer 渲染；注入/移除走 main 注入表）
  const [injectedFiles, setInjectedFiles] = useState<string[]>([])
  useEffect(() => {
    setInjectedFiles([])
    void getApi()
      .listInjectedFiles(p.sessionId)
      .then(setInjectedFiles)
      .catch(() => undefined)
  }, [p.sessionId])

  const handleInject = (rel: string): void => {
    void getApi()
      .injectFile(p.sessionId, rel)
      .then((r) => {
        if (r === 'ok') setInjectedFiles((prev) => (prev.includes(rel) ? prev : [...prev, rel]))
      })
      .catch(() => undefined)
  }

  const handleUninject = (rel: string): void => {
    void getApi()
      .uninjectFile(p.sessionId, rel)
      .then(() => setInjectedFiles((prev) => prev.filter((x) => x !== rel)))
      .catch(() => undefined)
  }

  const chatHeaderActions = (
    <>
      {working && <span className="spin-ring" />}
      {p.diffSummary && (
        <button
          className="diff-chip mono"
          onClick={() => p.onTogglePane('diff')}
          title="查看本会话的文件改动（Diff 审查）"
        >
          +{p.diffSummary.additions} −{p.diffSummary.deletions}
        </button>
      )}
      {SUMMONABLE.map(({ kind, label, icon: Icon }) => (
        <button
          key={kind}
          className={`win-btn icon${hasPane(kind) ? ' on' : ''}`}
          onClick={() => {
            // 最大化中点自己的召唤钮 = 仅还原；其余交给 togglePane（其内部会先还原）
            if (p.maximized === kind) p.onToggleMaximize(kind)
            else p.onTogglePane(kind)
          }}
          title={hasPane(kind) ? `关闭「${label}」面板` : `打开「${label}」面板`}
        >
          <Icon size={14} />
        </button>
      ))}
      {p.side === 'right' && (
        <button className="win-btn" onClick={p.onCloseSessionPane} title="关闭此栏（回到单栏）">
          <IconClose size={12} />
        </button>
      )}
    </>
  )

  const chrome = (kind: PaneKind) => {
    switch (kind) {
      case 'chat':
        return {
          title: p.meta?.title || '新对话',
          lead: (
            <ProjectSelect
              project={p.meta?.projectPath || p.config.workspacePath}
              recentProjects={p.config.recentProjects}
              onSwitch={p.onSwitchProject}
              onPick={p.onPickFolder}
            />
          ),
          headerActions: chatHeaderActions
        }
      case 'files':
      case 'file':
        return { title: '文件', sub: p.fileTarget ? p.fileTarget.path.split(/[\\/]/).pop() : '' }
      case 'terminal':
        return { title: '终端' }
      case 'diff':
        return { title: 'Diff 审查' }
    }
  }

  const renderPane = (kind: PaneKind) => {
    if (kind === 'chat') {
      return (
        <>
          <Transcript
            state={p.bucket}
            sessionId={p.sessionId}
            viewMode={p.viewMode}
            onChip={(t) => p.onSetDraft(t)}
            permission={p.bucket.permission}
            onRespond={p.onRespondPermission}
            onRespondUi={p.onRespondUi}
            onOpenPath={p.onOpenPath}
            onRewind={p.onRewind}
            onFork={p.onFork}
            onOpenTerminal={() => {
              if (!hasPane('terminal')) p.onTogglePane('terminal')
            }}
            onRunCommand={(cmd) => {
              // 命令条 ▶：打开终端面板并在会话终端里执行（面板关闭时也照跑，打开即可见）
              if (!hasPane('terminal')) p.onTogglePane('terminal')
              void getApi().ptyRunCommand(p.sessionId, cmd)
            }}
          />
          <Composer
            sessionId={p.sessionId}
            draft={p.draft}
            setDraft={p.onSetDraft}
            working={working}
            onSend={p.onSend}
            onFollowUp={p.onFollowUp}
            onCancel={p.onCancel}
            model={p.meta?.model || p.config.model}
            defaultModel={p.config.model}
            providerId={p.config.providerId}
            thinking={p.config.modelParams?.thinkingLevel}
            onSetThinking={p.onSetThinking}
            permissionMode={mode}
            onSetMode={p.onSetMode}
            onSetModel={p.onSetModel}
            contextTokens={p.bucket.usage ? p.bucket.usage.inputTokens + (p.bucket.usage.cacheReadTokens ?? 0) + (p.bucket.usage.cacheWriteTokens ?? 0) : null}
            contextWindow={catalogContextWindowOf(p.meta?.model || p.config.model, p.config.contextWindow)}
            focusKey={p.draftFocus?.sessionId === p.sessionId ? p.draftFocus.key : 0}
            stats={p.bucket.stats}
            appendWhileRunning={p.config.appendWhileRunning ?? true}
            injectedFiles={injectedFiles}
            onUninjectFile={handleUninject}
          />
        </>
      )
    }
    if (kind === 'file' || kind === 'files') {
      // 文件树与查看窗口合并为一个面板（旧布局记忆里的 files 叶子同样渲染合并版）
      return <WorkspacePane sessionId={p.sessionId} wsKey={p.meta?.projectPath ?? ''} fileTarget={p.fileTarget} onOpenFile={p.onOpenPath} onInject={handleInject} touched={touchedPaths} />
    }
    if (kind === 'terminal') {
      return <TerminalWindow sessionId={p.sessionId} ptys={p.ptys} onCreated={p.onPtyCreated} onClosed={p.onPtyClosed} />
    }
    return (
      <DiffPane
        sessionId={p.sessionId}
        focusPath={p.diffFocus && p.diffFocus.sessionId === p.sessionId ? p.diffFocus.path : null}
        focusKey={p.diffFocus && p.diffFocus.sessionId === p.sessionId ? p.diffFocus.key : 0}
        onComment={(text) => {
          // 审查评论：运行中走 steering 注入，空闲则作为新消息（main 侧自动分流）
          p.onSend(text)
        }}
      />
    )
  }

  return (
    <div className={`session-view${p.active ? ' active' : ''}`} onPointerDownCapture={p.onFocus}>
      <div className="session-body">
        <PaneTree
          sessionId={p.sessionId}
          layout={p.layout}
          focused={p.active}
          maximized={p.maximized}
          dispatch={p.onPaneAction}
          slots={{ chrome, render: renderPane }}
          onClosePane={(kind) => {
            if (kind === 'file' && fileDirty) {
              if (!window.confirm('文件有未保存修改，确定关闭（丢弃修改）？')) return
              setFileDirty(false)
            }
            p.onClosePane(kind)
          }}
          onToggleMaximize={p.onToggleMaximize}
        />
      </div>
    </div>
  )
}, (a, b) =>
  a.side === b.side &&
  a.sessionId === b.sessionId &&
  a.meta === b.meta &&
  a.bucket === b.bucket &&
  a.layout === b.layout &&
  a.maximized === b.maximized &&
  a.draft === b.draft &&
  a.fileTarget === b.fileTarget &&
  a.ptys === b.ptys &&
  a.diffSummary === b.diffSummary &&
  a.viewMode === b.viewMode &&
  a.config === b.config &&
  a.diffFocus === b.diffFocus &&
  a.draftFocus === b.draftFocus &&
  a.active === b.active
)

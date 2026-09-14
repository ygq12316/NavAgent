import { BrowserWindow, dialog, ipcMain, app, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  AddressedEvent,
  AgentEvent,
  AgentMessage,
  ApiConfig,
  CommandInfo,
  ContextBreakdown,
  CustomProviderInput,
  ModelListResult,
  CustomProviderWriteResult,
  DiffResult,
  DiffSummary,
  GitStatusResult,
  ImageContent,
  PermissionMode,
  SessionLoadResult,
  SessionMeta,
  SessionSearchHit,
  SessionTreeNode,
  UiEvent
} from '@shared/types'
import type { SessionManager, SessionEntry } from './agent/session-manager'
import type { SessionStore } from './agent/session-store'
import type { DiffService } from './services/diff'
import type { TerminalService } from './services/terminal'
import { expandPrompt, scanPromptTemplates } from './services/prompts'
import { renderSessionHtml } from './services/export-html'
import { credentialInfo, removeCredential, saveCredential } from './services/auth'
import type { CatalogSnapshot, CredentialInfo, ExtensionInfo, ExtensionOpResult } from '@shared/types'
import { getConfig, updateConfig } from './config'
import { resolveWithin } from './tools/registry'
import { readWorkspaceFile, writeWorkspaceFile, globWorkspace } from './services/fs-service'
import { probeEndpointModels } from './providers/endpoint'

/** 单列 porcelain 状态码 → 语义状态（M/T=修改, A=新增, D=删除, R/C=重命名, U=冲突, ?=未跟踪） */
function porcelainStatus(c: string): GitStatusResult['staged'][number]['status'] {
  switch (c) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
    case 'C':
      return 'renamed'
    case 'U':
      return 'conflicted'
    case '?':
      return 'untracked'
    default:
      return 'modified'
  }
}

function stderrOf(e: unknown): string {
  if (e && typeof e === 'object' && 'stderr' in e) return String((e as { stderr?: unknown }).stderr ?? '')
  return e instanceof Error ? e.message : ''
}

/** 事件信封广播：并行会话下 renderer 按 sessionId 路由；'' 为应用级 notice（renderer 落到聚焦会话） */
export function emitAgentEvent(sessionId: string, event: AgentEvent): void {
  const payload: AddressedEvent = { sessionId, event }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:event', payload)
  }
}

/** UI 事件（PTY 等）独立通道，与 agent 事件流互不干扰 */
export function emitUiEvent(event: UiEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('navagent:uiEvent', event)
  }
}

const PERMISSION_MODES: PermissionMode[] = ['manual', 'acceptEdits', 'plan', 'bypassPermissions']

/** 文件树默认隐藏的"再生垃圾"目录（构建产物/依赖/虚拟环境；点开头文件与目录如 .env/.gitignore/.github 正常展示） */
const NOISE_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '__pycache__', '.pytest_cache', '.next', '.cache', 'target', '.git', 'venv', '.venv', '.idea'])

export function registerIpc(deps: {
  /** 会话注册表（并行 agent 实例） */
  sessions: SessionManager
  /** 会话运行时获取（index.ts：ensure + 扩展 session_start once 语义） */
  ensureSession: (sessionId: string) => Promise<SessionEntry>
  /** 会话首次运行前确保 worktree（git 仓库才隔离；index.ts 封装落 meta + notice） */
  ensureSessionWorkspace: (sessionId: string) => Promise<void>
  /** 会话工作区解析（worktreePath ?? projectPath） */
  workspaceOf: (sessionId: string) => string
  store: SessionStore
  diffs: DiffService
  /** 被离开分支的摘要引擎（index.ts 注入，复用压缩摘要链路） */
  summarizeBranch: (messages: AgentMessage[]) => Promise<string>
  /** 扩展命令注册表与工具热重载（index.ts 注入） */
  extensionCommands: Map<string, import('./extensions/types').ExtensionCommand>
  refreshTools: () => Promise<void>
  isTrusted: (ws: string) => boolean
  trustRuntime: (ws: string) => void
  listToolInfos: () => import('@shared/types').ToolInfo[]
  /** 工作区 context files 缓存重建（启动/config:set/手动刷新） */
  refreshContextFiles: () => void
  /** 终端服务（Terminal pane 的 PTY 后端；index.ts 注入） */
  terminals: TerminalService
  /** 合并目录（内置 + models.json 自定义；index.ts 注入） */
  getMergedCatalog: () => CatalogSnapshot
  /** 上下文构成（index.ts collectContext：分类段 + 逐条消息明细） */
  contextBreakdown: (sessionId: string) => ContextBreakdown
  /** 文件内容直接注入上下文（index.ts：注入表 + notice） */
  injectFile: (sessionId: string, rel: string) => Promise<'ok' | 'not-found'>
  /** 移除已注入文件 / 注入清单（注入列表管理；index.ts 注入） */
  uninjectFile: (sessionId: string, rel: string) => 'ok' | 'not-found'
  listInjectedFiles: (sessionId: string) => string[]
  /** 模型切换悬浮窗数据源（本地清单，零网络；index.ts 注入） */
  listModels: () => Promise<ModelListResult>
  /** 自定义供应商写回（models.json upsert/remove + 热重载） */
  upsertCustomProvider: (input: CustomProviderInput) => CustomProviderWriteResult
  deleteCustomProvider: (id: string) => CustomProviderWriteResult
  /** 探测/测试时解析端点凭据（手填 > auth.json > 定义内联值） */
  resolveProbeKey: (providerId: string, formKey: string) => string
  /** 凭据解析来源（不含明文；index.ts 注入） */
  describeCredential: (providerId: string) => string | null
  /** 已加载扩展清单（refreshTools 时的 loader infos 缓存） */
  listExtensions: () => import('@shared/types').ExtensionInfo[]
  /** MCP 宿主（userData/mcp.json 的服务器生命周期与工具） */
  mcp: import('./services/mcp').McpHost
  /** 扩展面板宿主（panel:invoke/panel:close 桥的后端；index.ts 注入） */
  panels: import('./extensions/panels').PanelManager
  /** 会话扩展 ctx 工厂（命令分发与面板桥共用；index.ts 注入） */
  extCtxFor: (sessionId: string) => import('./extensions/types').ExtensionContext | undefined
  /** 会话树操作（switchLeaf/fork/getTree 单点实现；index.ts 注入，与 ctx.sessions 能力面同源） */
  ops: import('./agent/session-ops').SessionOps
}): void {
  const { sessions, store, diffs, terminals, ensureSession, ensureSessionWorkspace, workspaceOf, contextBreakdown, injectFile, uninjectFile, listInjectedFiles, resolveProbeKey, panels, extCtxFor, ops } = deps

  ipcMain.handle('config:get', () => getConfig())

  // 融合标题栏：overlay 窗口钮配色随主题切换（仅 Windows 有效）
  ipcMain.handle('win:overlay', (_e, theme: string) => {
    const overlay =
      theme === 'light' ? { color: '#e9edf3', symbolColor: '#626a78' } : { color: '#000000', symbolColor: '#9aa1ad' }
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      try {
        w.setTitleBarOverlay(overlay)
      } catch {
        /* 非 Windows 平台无此 API，忽略 */
      }
    }
    return 'ok'
  })

  // 上下文构成：分类段（系统/工具/消息/预留/空闲）+ 逐条消息明细（index.ts collectContext 计算）
  // 模型列表（本地清单；模型切换悬浮窗数据源）
  ipcMain.handle('models:list', async (): Promise<ModelListResult> => {
    try {
      return await deps.listModels()
    } catch (err) {
      return { models: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('context:breakdown', (_e, sessionId: string) => contextBreakdown(String(sessionId ?? '')))

  // 文件内容注入上下文 + 相对→绝对路径
  ipcMain.handle('fs:injectFile', (_e, sessionId: string, rel: string) => injectFile(String(sessionId ?? ''), String(rel ?? '')))
  ipcMain.handle('context:uninject', (_e, sessionId: string, rel: string) => uninjectFile(String(sessionId ?? ''), String(rel ?? '')))
  ipcMain.handle('context:injectedList', (_e, sessionId: string) => listInjectedFiles(String(sessionId ?? '')))

  // 会话附件：写入 <ws>/.navagent/attachments/<时间戳>-<安全名>；返回相对路径（消息正文引用）
  ipcMain.handle('fs:saveAttachment', async (_e, sessionId: string, name: string, dataB64: string) => {
    const ws = workspaceOf(String(sessionId ?? ''))
    if (!ws) return { ok: false, error: '无会话工作区' }
    const MAX = 25 * 1024 * 1024
    const safe = basename(String(name ?? 'file')).replace(/[\\/:*?"<>|]/g, '_').trim() || 'file'
    const rel = `.navagent/attachments/${Date.now().toString(36)}-${safe}`
    const abs = resolveWithin(ws, rel)
    if (!abs) return { ok: false, error: '路径非法' }
    try {
      const buf = Buffer.from(String(dataB64 ?? ''), 'base64')
      if (buf.length === 0) return { ok: false, error: '空附件' }
      if (buf.length > MAX) return { ok: false, error: '附件超过 25MB' }
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, buf)
      return { ok: true, path: rel.split('\\').join('/') }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('fs:absPath', (_e, sessionId: string, rel: string) => {
    const ws = workspaceOf(String(sessionId ?? ''))
    const clean = String(rel ?? '').replace(/^[/\\]+/, '')
    return ws ? join(ws, clean) : clean
  })

  // git 分支：当前分支 + 本地分支列表（非 git 目录返回空）
  ipcMain.handle('git:branches', (_e, sessionId: string): { current: string | null; branches: string[] } => {
    const ws = workspaceOf(String(sessionId ?? '')) || getConfig().workspacePath
    if (!ws) return { current: null, branches: [] }
    try {
      const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws, encoding: 'utf8', timeout: 5000 }).trim()
      const out = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: ws, encoding: 'utf8', timeout: 5000 })
      return { current, branches: out.split('\n').map((s) => s.trim()).filter(Boolean) }
    } catch {
      return { current: null, branches: [] }
    }
  })

  // git 状态（Source Control 面板数据）：porcelain 两列码 → 分组
  ipcMain.handle('git:status', (_e, sessionId: string): GitStatusResult => {
    const ws = workspaceOf(String(sessionId ?? '')) || getConfig().workspacePath
    if (!ws) return { current: null, staged: [], unstaged: [], untracked: [] }
    try {
      const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws, encoding: 'utf8', timeout: 5000 }).trim()
      const out = execFileSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8', timeout: 5000 })
      const staged: GitStatusResult['staged'] = []
      const unstaged: GitStatusResult['unstaged'] = []
      const untracked: GitStatusResult['untracked'] = []
      for (const line of out.split('\n')) {
        if (line.length < 4) continue
        const x = line[0]
        const y = line[1]
        let rel = line.slice(3).trim()
        let origPath: string | undefined
        const arrow = rel.indexOf(' -> ')
        if (arrow >= 0) {
          origPath = rel.slice(0, arrow)
          rel = rel.slice(arrow + 4)
        }
        if (!rel || rel.startsWith('.claude/worktrees/')) continue
        if (x === '?' && y === '?') {
          untracked.push({ path: rel, status: 'untracked' })
          continue
        }
        if (x !== ' ' && x !== '?') staged.push({ path: rel, status: porcelainStatus(x), origPath })
        if (y !== ' ' && y !== '?') unstaged.push({ path: rel, status: porcelainStatus(y), origPath })
      }
      return { current, staged, unstaged, untracked }
    } catch {
      return { current: null, staged: [], unstaged: [], untracked: [] }
    }
  })

  // git 切换分支：脏工作区冲突时 ok=false + stderr 提示
  ipcMain.handle('git:switch', (_e, sessionId: string, branch: string): { ok: boolean; message?: string } => {
    const ws = workspaceOf(String(sessionId ?? '')) || getConfig().workspacePath
    const b = String(branch ?? '').trim()
    if (!b) return { ok: false, message: '空分支名' }
    if (!ws) return { ok: false, message: '无工作区' }
    try {
      execFileSync('git', ['switch', b], { cwd: ws, encoding: 'utf8', timeout: 20000 })
      return { ok: true }
    } catch (e) {
      const err1 = stderrOf(e)
      try {
        execFileSync('git', ['checkout', b], { cwd: ws, encoding: 'utf8', timeout: 20000 })
        return { ok: true }
      } catch (e2) {
        return { ok: false, message: (stderrOf(e2) || err1).trim() || '切换失败' }
      }
    }
  })

  ipcMain.handle('config:set', (_e, partial: Partial<ApiConfig>) => {
    const next = updateConfig(partial)
    // 工作区/信任/只读/禁用清单变化都会影响扩展加载与工具装配；工作区变化还要重建 context files 缓存
    deps.refreshContextFiles()
    void deps.refreshTools()
    return next
  })

  ipcMain.handle('context:refresh', () => {
    deps.refreshContextFiles()
    emitAgentEvent('', { type: 'notice', message: '已重新加载工作区 context files（AGENTS.md / CLAUDE.md）' })
  })

  ipcMain.handle('dialog:pickWorkspace', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ── agent 操作（全部显式 sessionId；并行会话互不阻塞） ────────

  ipcMain.handle('agent:send', async (_e, sessionId: string, text: string, images?: ImageContent[]): Promise<'ok'> => {
    if (typeof sessionId !== 'string' || !sessionId) return 'ok'
    const validImages = Array.isArray(images)
      ? images.filter((im) => typeof im?.data === 'string' && typeof im?.mimeType === 'string').slice(0, 8)
      : undefined
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed.length === 0 && (validImages?.length ?? 0) === 0) return 'ok'
    const { agent } = await ensureSession(sessionId)
    // worktree 在首次 prompt 前落定（getWorkspacePath 动态读取 meta）
    await ensureSessionWorkspace(sessionId)
    if (agent.running) {
      agent.steer(trimmed)
      return 'ok'
    }
    await agent.prompt(trimmed, validImages)
    return 'ok'
  })

  // 运行中插话（pi 的 steering）；空闲时视为普通 prompt
  ipcMain.handle('agent:steer', async (_e, sessionId: string, text: string): Promise<'ok' | 'queued'> => {
    if (typeof sessionId !== 'string' || typeof text !== 'string' || text.trim().length === 0) return 'ok'
    const { agent } = await ensureSession(sessionId)
    if (!agent.running) {
      await ensureSessionWorkspace(sessionId)
      await agent.prompt(text.trim())
      return 'ok'
    }
    return agent.steer(text.trim())
  })

  // 运行中排队续跑（pi 的 follow-up）；空闲时视为普通 prompt
  ipcMain.handle('agent:followUp', async (_e, sessionId: string, text: string): Promise<'ok' | 'queued'> => {
    if (typeof sessionId !== 'string' || typeof text !== 'string' || text.trim().length === 0) return 'ok'
    const { agent } = await ensureSession(sessionId)
    if (!agent.running) {
      await ensureSessionWorkspace(sessionId)
      await agent.prompt(text.trim())
      return 'ok'
    }
    return agent.followUp(text.trim())
  })

  // 取消并取回未消费的排队消息（pi 的 Escape 行为），UI 据此回填输入框
  ipcMain.handle('agent:cancel', (_e, sessionId: string): string[] => {
    if (typeof sessionId !== 'string') return []
    const entry = sessions.get(sessionId)
    const drained = entry?.agent.abort() ?? []
    entry?.uirm?.cancelAll() // 挂起的扩展弹窗一并取消（confirm=false / input=null）
    return drained
  })

  // 扩展弹窗应答（全局 requestId 路由；值类型随 kind：confirm=boolean，input/select=string|null）
  ipcMain.handle('agent:respondUi', (_e, requestId: string, value: string | boolean | null) => {
    sessions.routeUi(String(requestId ?? ''), (value ?? null) as string | boolean | null)
  })

  ipcMain.handle('agent:compact', async (_e, sessionId: string): Promise<'ok' | 'busy'> => {
    if (typeof sessionId !== 'string') return 'ok'
    const { agent } = await ensureSession(sessionId)
    if (agent.running) return 'busy'
    await agent.compact()
    return 'ok'
  })

  ipcMain.handle('agent:respondPermission', (_e, requestId: string, decision: 'approve' | 'deny' | 'always') => {
    sessions.routePermission(String(requestId ?? ''), decision)
  })

  // ── 会话管理（无 busy 锁：并行会话是常态） ──────────────────

  ipcMain.handle('session:new', (_e, projectPath: string): string => {
    const ws = typeof projectPath === 'string' && projectPath ? projectPath : getConfig().workspacePath
    const meta = store.create(ws, getConfig().model, { permissionMode: getConfig().defaultPermissionMode ?? 'manual' })
    return meta.id
  })

  ipcMain.handle('session:list', (_e, projectPath: string) =>
    store.list(typeof projectPath === 'string' ? projectPath : getConfig().workspacePath)
  )

  // 会话全文检索（SQLite 权威存储的 LIKE 子串；UI 入口后续接入 rail）
  ipcMain.handle(
    'session:search',
    (_e, query: string, opts?: { sessionIds?: string[]; limit?: number }): SessionSearchHit[] => {
      if (typeof query !== 'string') return []
      const sessionIds = Array.isArray(opts?.sessionIds) ? opts!.sessionIds!.filter((s) => typeof s === 'string') : null
      const limit = typeof opts?.limit === 'number' && opts.limit > 0 ? Math.min(opts.limit, 200) : 50
      return store.search(query, sessionIds, limit)
    }
  )

  // 加载活动路径消息（renderer hydrate；纯读取，不动任何运行状态）。
  // 顺路预热会话终端（幂等，无存活 PTY 才建）：用户点开终端面板时点击即得，不必看"正在创建终端…"
  ipcMain.handle('session:load', (_e, id: string): SessionLoadResult => {
    if (typeof id !== 'string') return { ok: false, error: 'not-found' }
    try {
      const { meta, messages } = store.load(id)
      void terminals.ensure(id, workspaceOf(id))
      return { ok: true, meta, messages }
    } catch {
      return { ok: false, error: 'not-found' }
    }
  })

  // 删除会话：并行运行不阻塞；同时中止运行实例、清改动日志并回收 worktree
  // 删除：完整清理链在 session-ops（含派生子会话断线提升为根，与 ctx.sessions 能力面同源）
  ipcMain.handle('session:delete', (_e, id: string) => ops.removeSession(String(id ?? '')))

  /** 会话级权限模式切换：落盘 + 运行中实例即时生效；切完在会话内提示（下一条消息按新模式装配） */
  ipcMain.handle('session:setMode', (_e, id: string, mode: PermissionMode) => {
    if (typeof id !== 'string' || !PERMISSION_MODES.includes(mode)) return
    const sid = String(id ?? '')
    const before = store.getMeta(sid)?.permissionMode
    store.setPermissionMode(sid, mode)
    sessions.get(sid)?.pm.setMode(mode)
    if (mode !== before) {
      const label = mode === 'plan' ? '计划模式' : mode === 'acceptEdits' ? '自动编辑' : mode === 'bypassPermissions' ? '跳过审批' : '审批'
      emitAgentEvent(sid, { type: 'notice', message: `已切换：${label}` })
    }
  })

  /** 会话级模型切换：持久化该会话的 meta.model（provider/上下文窗口在下一次 prompt 按会话解析），不影响其他会话；切完在会话内提示 */
  ipcMain.handle('session:setModel', (_e, id: string, model: string) => {
    const sid = String(id ?? '')
    const m = String(model ?? '')
    const before = store.getMeta(sid)?.model
    const meta = store.setModel(sid, m)
    if (meta && meta.model && meta.model !== before) {
      emitAgentEvent(sid, { type: 'notice', message: `已切换模型：${meta.model}` })
    }
    return meta
  })

  // 会话重命名 / 归档（rail 三点菜单）
  ipcMain.handle('session:rename', (_e, id: string, title: string): SessionMeta | null => {
    if (typeof id !== 'string' || typeof title !== 'string') return null
    return store.rename(id, title)
  })

  ipcMain.handle('session:archive', (_e, id: string, archived: boolean): SessionMeta | null => {
    if (typeof id !== 'string' || typeof archived !== 'boolean') return null
    return store.setArchived(id, archived)
  })

  // 会话重锚工作目录（文件树/工具/git 即时跟随；错误经 notice 编码不抛）
  ipcMain.handle('session:setProject', (_e, id: string, projectPath: string): SessionMeta | null => {
    if (typeof id !== 'string' || typeof projectPath !== 'string' || !/^([a-zA-Z]:[\\/]|\/)/.test(projectPath.trim())) return null
    const meta = store.setProject(id, projectPath)
    if (meta) emitAgentEvent(id, { type: 'notice', message: `工作目录已切换：${meta.projectPath}` })
    return meta
  })

  // ── Diff（会话改动审查） ─────────────────────────────────────

  ipcMain.handle('diff:get', (_e, id: string): Promise<DiffResult> => diffs.get(String(id ?? '')))
  ipcMain.handle('diff:summary', (_e, id: string): Promise<DiffSummary | null> => diffs.summary(String(id ?? '')))

  // ── 会话树 ────────────────────────────────────────────────

  ipcMain.handle('session:tree', (_e, id: string): SessionTreeNode[] => store.listTree(id))

  // 切换活动叶子/派生会话：业务规则单点在 session-ops（与 ctx.sessions 扩展能力面同源）
  ipcMain.handle('session:switchLeaf', (_e, id: string, nodeId: string, summarize: boolean) =>
    ops.switchLeaf(String(id ?? ''), String(nodeId ?? ''), Boolean(summarize))
  )

  ipcMain.handle('session:fork', (_e, id: string, nodeId: string) => ops.fork(String(id ?? ''), String(nodeId ?? '')))

  ipcMain.handle('session:clone', async (_e, id: string): Promise<string | null> => {
    if (sessions.isRunning(id)) {
      emitAgentEvent(id, { type: 'notice', message: '运行中无法克隆会话，请先停止。' })
      return null
    }
    try {
      const meta = store.clone(id)
      await ensureSessionWorkspace(meta.id)
      return meta.id
    } catch (err) {
      emitAgentEvent(id, { type: 'notice', message: `克隆会话失败：${err instanceof Error ? err.message : String(err)}` })
      return null
    }
  })

  // ── 工作区文件读写 / glob / 文件选择 / 显示（File pane 后端；作用域 = 会话工作区） ──

  ipcMain.handle('fs:read', (_e, sessionId: string, rel: string) =>
    readWorkspaceFile(workspaceOf(String(sessionId ?? '')), String(rel ?? ''))
  )

  // 会话工作区目录列举（文件树后端；隐藏项与噪声目录过滤，失败静默返回空）
  ipcMain.handle('fs:listDir', async (_e, sessionId: string, rel: string) => {
    const ws = workspaceOf(String(sessionId ?? ''))
    if (!ws) return []
    const abs = resolveWithin(ws, String(rel ?? '') || '.')
    if (!abs) return []
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])
    return entries
      .filter((en) => !(en.isDirectory() && NOISE_DIRS.has(en.name)))
      .map((en) => ({ name: en.name, type: en.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  })

  ipcMain.handle('fs:write', (_e, sessionId: string, rel: string, content: string, baseMtime?: number) =>
    writeWorkspaceFile(workspaceOf(String(sessionId ?? '')), String(rel ?? ''), String(content ?? ''), typeof baseMtime === 'number' ? baseMtime : undefined)
  )

  ipcMain.handle('fs:glob', (_e, sessionId: string, pattern: string) =>
    typeof pattern === 'string' && pattern.trim() ? globWorkspace(workspaceOf(String(sessionId ?? '')), pattern.trim()) : []
  )

  // 在资源管理器中显示（限会话工作区内）
  ipcMain.handle('fs:reveal', (_e, sessionId: string, rel: string) => {
    const ws = workspaceOf(String(sessionId ?? ''))
    if (!ws) return
    const abs = resolveWithin(ws, String(rel ?? ''))
    if (abs) shell.showItemInFolder(abs)
  })

  // ── 终端（PTY）：cwd = 会话工作区；spawn 失败返回 null，其余操作失败静默 ──

  ipcMain.handle('pty:create', (_e, sessionId: string): string | null => {
    const sid = String(sessionId ?? '')
    return terminals.create(workspaceOf(sid) || app.getPath('home'), sid)
  })
  ipcMain.handle('pty:replay', (_e, id: string): string => terminals.replay(String(id ?? '')))
  ipcMain.handle('pty:list', (_e, sessionId: string): string[] => terminals.ptysOf(String(sessionId ?? '')))
  ipcMain.handle('pty:write', (_e, id: string, data: string) => terminals.write(String(id), String(data ?? '')))
  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
    terminals.resize(String(id), Number(cols) || 80, Number(rows) || 24)
  )
  ipcMain.handle('pty:kill', (_e, id: string) => terminals.kill(String(id)))

  /** 命令条 ▶：向会话终端写入一行命令并回车（自动创建终端；前端同步打开终端面板） */
  ipcMain.handle('pty:runCommand', async (_e, sessionId: string, command: string): Promise<'ok' | 'no-terminal'> =>
    terminals.runCommand(String(sessionId ?? ''), String(command ?? ''), workspaceOf(String(sessionId ?? '')))
  )

  // ── 工具 / 扩展 / 命令 / 项目信任 ──────────────────────────

  ipcMain.handle('tools:list', () => deps.listToolInfos())

  ipcMain.handle('tools:setEnabled', (_e, name: string, enabled: boolean) => {
    if (typeof name !== 'string') return
    const set = new Set(getConfig().disabledTools)
    if (enabled) set.delete(name)
    else set.add(name)
    updateConfig({ disabledTools: [...set] })
    void deps.refreshTools()
  })

  ipcMain.handle('extensions:reload', async () => {
    await deps.refreshTools()
    return {
      tools: deps.listToolInfos().filter((t) => t.source === 'extension').length,
      commands: deps.extensionCommands.size
    }
  })

  // ── 扩展面板桥：面板 GUI → main 侧扩展 onMessage；renderer 关闭钮 → 释放 ──

  ipcMain.handle('panel:invoke', (_e, panelId: string, op: string, params: Record<string, unknown>) =>
    panels.invoke(String(panelId ?? ''), String(op ?? ''), params && typeof params === 'object' ? params : {})
  )

  ipcMain.handle('panel:close', (_e, panelId: string) => {
    panels.close(String(panelId ?? ''))
  })

  // ── 扩展管理：清单 / 安装（全局目录）/ 删除（仅全局）/ 启停 ──

  ipcMain.handle('extensions:list', () => deps.listExtensions())

  // ── MCP 服务（stdio JSON-RPC；配置 userData/mcp.json，工具注册为 mcp_<server>_<tool>）──

  ipcMain.handle('mcp:list', async () => {
    const { tools, statuses } = await deps.mcp.refresh()
    return { statuses, config: deps.mcp.loadConfig(), toolCount: tools.length }
  })
  ipcMain.handle('mcp:save', async (_e, name: string, def: import('@shared/types').McpServerDef) => {
    const r = deps.mcp.upsert(String(name ?? ''), {
      command: String(def?.command ?? ''),
      args: Array.isArray(def?.args) ? def.args.map(String) : undefined,
      env: def?.env && typeof def.env === 'object' ? def.env : undefined,
      enabled: def?.enabled !== false
    })
    if (r.ok) await deps.refreshTools()
    return r
  })
  ipcMain.handle('mcp:remove', async (_e, name: string) => {
    deps.mcp.remove(String(name ?? ''))
    await deps.refreshTools()
    return 'ok' as const
  })
  ipcMain.handle('mcp:setEnabled', async (_e, name: string, enabled: boolean) => {
    deps.mcp.setEnabled(String(name ?? ''), enabled === true)
    await deps.refreshTools()
    return 'ok' as const
  })

  ipcMain.handle('extensions:install', async (): Promise<ExtensionOpResult> => {
    const fail = (error: string, canceled = false): ExtensionOpResult => ({ ok: false, ...(canceled ? { canceled } : { error }), extensions: deps.listExtensions() })
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return fail('已取消', true)
    const name = basename(res.filePaths[0])
    if (!/^[a-z0-9_-]+$/i.test(name) || name.startsWith('.')) return fail('目录名不合法（字母/数字/-/_）')
    const dest = join(app.getPath('userData'), 'extensions', name)
    if (existsSync(dest) || existsSync(dest + '.mjs') || existsSync(dest + '.js')) return fail(`同名扩展已存在：${name}`)
    try {
      await cp(res.filePaths[0], dest, { recursive: true })
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    await deps.refreshTools()
    return { ok: true, extensions: deps.listExtensions() }
  })

  ipcMain.handle('extensions:remove', async (_e, id: string): Promise<ExtensionOpResult> => {
    const extId = String(id ?? '')
    if (!/^[a-z0-9_-]+$/i.test(extId)) return { ok: false, error: '非法扩展 id', extensions: deps.listExtensions() }
    const root = join(app.getPath('userData'), 'extensions')
    const hit = [join(root, extId), join(root, extId + '.mjs'), join(root, extId + '.js')].find((t) => existsSync(t))
    if (!hit) return { ok: false, error: '扩展不存在（仅全局扩展可删除）', extensions: deps.listExtensions() }
    try {
      await rm(hit, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), extensions: deps.listExtensions() }
    }
    await deps.refreshTools()
    return { ok: true, extensions: deps.listExtensions() }
  })

  ipcMain.handle('extensions:setEnabled', async (_e, id: string, enabled: boolean): Promise<ExtensionInfo[]> => {
    const extId = String(id ?? '')
    const set = new Set(getConfig().disabledExtensions ?? [])
    if (enabled) set.delete(extId)
    else set.add(extId)
    updateConfig({ disabledExtensions: [...set] })
    await deps.refreshTools()
    return deps.listExtensions()
  })

  ipcMain.handle('commands:list', () => {
    const out: CommandInfo[] = [{ name: 'compact', description: '压缩会话上下文' }]
    for (const c of deps.extensionCommands.values()) out.push({ name: c.name, description: c.description })
    const ws = getConfig().workspacePath
    const dirs = [
      { dir: join(app.getPath('userData'), 'prompts'), source: 'global' as const },
      ...(ws ? [{ dir: join(ws, '.navagent', 'prompts'), source: 'project' as const }] : [])
    ]
    for (const t of scanPromptTemplates(dirs)) out.push({ name: t.name, description: 'prompt 模板' })
    return out
  })

  // 斜杠命令统一分发（作用于指定会话）：内置 compact → 扩展命令 → prompt 模板 → unknown
  ipcMain.handle('commands:dispatch', async (_e, sessionId: string, name: string, args: string): Promise<'ok' | 'unknown'> => {
    if (typeof name !== 'string' || !name) return 'unknown'
    const sid = String(sessionId ?? '')
    const rawArgs = typeof args === 'string' ? args : ''
    if (name === 'compact') {
      const { agent } = await ensureSession(sid)
      void agent.compact()
      return 'ok'
    }
    if (name === 'reload') {
      await deps.refreshTools()
      const extTools = deps.listToolInfos().filter((t) => t.source === 'extension').length
      emitAgentEvent(sid, {
        type: 'notice',
        message: '已重载扩展：工具 ' + extTools + ' 个，自定义命令 ' + deps.extensionCommands.size + ' 条'
      })
      return 'ok'
    }
    const cmd = deps.extensionCommands.get(name)
    if (cmd) {
      try {
        // 惰性建会话：命令处理器 ctx（含 sessions/ui 能力面）需要会话运行时
        await ensureSession(sid)
        const ctx = extCtxFor(sid)
        if (!ctx) throw new Error('会话上下文不可用')
        const out = await cmd.handler(rawArgs, ctx)
        emitAgentEvent(sid, { type: 'notice', message: `/${name}${out ? `：${out}` : ' 已执行'}` })
      } catch (err) {
        emitAgentEvent(sid, { type: 'notice', message: `命令 /${name} 失败：${err instanceof Error ? err.message : String(err)}` })
      }
      return 'ok'
    }
    const ws = getConfig().workspacePath
    const dirs = [
      { dir: join(app.getPath('userData'), 'prompts'), source: 'global' as const },
      ...(ws ? [{ dir: join(ws, '.navagent', 'prompts'), source: 'project' as const }] : [])
    ]
    const tpl = scanPromptTemplates(dirs).find((t) => t.name === name)
    if (tpl) {
      const text = expandPrompt(tpl.template, rawArgs)
      const { agent } = await ensureSession(sid)
      if (agent.running) agent.steer(text)
      else void agent.prompt(text)
      emitAgentEvent(sid, { type: 'notice', message: `已展开 prompt 模板 /${name}` })
      return 'ok'
    }
    emitAgentEvent(sid, { type: 'notice', message: `未知命令 /${name}（可用：/compact、扩展命令、prompts 目录下的模板）` })
    return 'unknown'
  })

  ipcMain.handle('project:trust', () => {
    const ws = getConfig().workspacePath
    if (!ws) return
    updateConfig({ trustedProjects: [...new Set([...getConfig().trustedProjects, ws])] })
    void deps.refreshTools()
  })

  ipcMain.handle('project:trustOnce', () => {
    const ws = getConfig().workspacePath
    if (!ws) return
    deps.trustRuntime(ws)
    void deps.refreshTools()
  })

  // ── 供应商凭据（auth.json）与合并目录（对齐 pi）────────────

  ipcMain.handle('catalog:merged', (): CatalogSnapshot => deps.getMergedCatalog())

  ipcMain.handle('auth:list', async (): Promise<CredentialInfo[]> => {
    const snapshot = deps.getMergedCatalog()
    return (snapshot.customs ?? []).map((p) => ({
      id: p.id,
      label: p.name,
      stored: credentialInfo(app.getPath('userData'), p.id).stored,
      source: deps.describeCredential(p.id)
    }))
  })

  ipcMain.handle('auth:set', (_e, providerId: string, key: string) => {
    if (typeof providerId !== 'string' || typeof key !== 'string' || key.trim().length === 0) return
    saveCredential(app.getPath('userData'), providerId, key.trim())
  })

  ipcMain.handle('auth:clear', (_e, providerId: string) => {
    if (typeof providerId !== 'string') return
    removeCredential(app.getPath('userData'), providerId)
  })

  // 自定义供应商写回（models.json；写后热重载并返回新目录）
  ipcMain.handle('providers:save', (_e, input: CustomProviderInput): CustomProviderWriteResult => {
    if (typeof input !== 'object' || input === null) return { ok: false, error: '参数无效' }
    return deps.upsertCustomProvider({
      id: typeof input.id === 'string' ? input.id : undefined,
      name: String(input.name ?? ''),
      protocol: input.protocol === 'anthropic' ? 'anthropic' : 'openai-compat',
      baseUrl: String(input.baseUrl ?? ''),
      apiKey: typeof input.apiKey === 'string' ? input.apiKey : undefined,
      models: Array.isArray(input.models) ? input.models : []
    })
  })

  ipcMain.handle('providers:delete', (_e, id: string): CustomProviderWriteResult => {
    if (typeof id !== 'string' || !id.trim()) return { ok: false, error: '参数无效' }
    return deps.deleteCustomProvider(id.trim())
  })

  // 模型探测：GET {baseUrl}/models（OpenAI 兼容带 Bearer，Anthropic 带 x-api-key + version）
  ipcMain.handle('providers:probeModels', async (_e, input: { baseUrl: string; protocol: 'openai-compat' | 'anthropic'; apiKey?: string; providerId?: string }) => {
    const base = String(input?.baseUrl ?? '').trim()
    const protocol = input?.protocol === 'anthropic' ? 'anthropic' : 'openai-compat'
    const key = String(input?.apiKey ?? '').trim() || (input?.providerId ? resolveProbeKey(String(input.providerId), '') : '')
    // 统一探测入口（/models 多候选 + 消息端点路由校验 + 协议回退），表单无 key 时按 providerId 取已存凭据
    return probeEndpointModels(base, protocol, key)
  })

  // ── 会话导出 / 导入 ────────────────────────────────────────

  ipcMain.handle('session:export', async (_e, id: string, format: 'jsonl' | 'html'): Promise<string | null> => {
    const meta = store.getMeta(id)
    if (!meta) return null
    const safeTitle = meta.title.replace(/[\\/:*?"<>|]+/g, '_') || 'session'
    const ext = format === 'jsonl' ? 'jsonl' : 'html'
    const res = await dialog.showSaveDialog({
      defaultPath: join(app.getPath('downloads'), `${safeTitle}.${ext}`),
      filters: [{ name: format === 'jsonl' ? '会话 JSONL' : 'HTML', extensions: [ext] }]
    })
    if (res.canceled || !res.filePath) return null
    if (format === 'jsonl') {
      await writeFile(res.filePath, store.exportJsonl(id), 'utf-8')
    } else {
      await writeFile(res.filePath, renderSessionHtml(meta, store.getMessages(id)), 'utf-8')
    }
    return res.filePath
  })

  ipcMain.handle('session:import', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '会话 JSONL', extensions: ['jsonl'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    const meta = store.importFrom(res.filePaths[0]!, getConfig().workspacePath, getConfig().model)
    emitAgentEvent('', { type: 'notice', message: `已导入会话：${meta.title}` })
    return meta.id
  })
}

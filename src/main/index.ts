import { BrowserWindow, Menu, app, protocol } from 'electron'
import { extname, join, resolve } from 'node:path'
import type { AgentMessage, AgentEvent, CustomProviderFull, StopReason } from '@shared/types'
import type { ApiConfig, ContextBreakdown, ContextSection, ContextMessageShare } from '@shared/types'
import { readFileSync } from 'node:fs'
import { resolveWithin } from './tools/registry'
import { messageText, textOfBlocks, contextTokensOf } from '@shared/types'
import { resolveCredential } from './services/auth'
import { buildEnvSection, detectEnvironment } from './providers/env-detect'
import { estimateTokens } from './agent/context'
import { loadModelsJson, upsertModelsJson, removeFromModelsJson, type CustomProvider } from './providers/custom-providers'
import { resolveContextWindow } from '@shared/model-catalog'
import type { ToolResult } from './tools/registry'
import { resolveEndpoint } from './providers/endpoint'
import type { Provider } from './providers/types'
import type { Tool } from './tools/registry'
import { Agent } from './agent/agent'
import { SessionManager, type SessionEntry } from './agent/session-manager'
import { DiffService } from './services/diff'
import { getConfig } from './config'
import { emitAgentEvent, emitUiEvent, registerIpc } from './ipc'
import { TerminalService } from './services/terminal'
import { COMPACTION_SYSTEM } from './agent/context'
import { extractFileOperations, formatFileOperations, serializeConversation } from './agent/compaction'
import { BRANCH_SUMMARIZATION_PROMPT } from './agent/branch'
import { SessionStore } from './agent/session-store'
import { createSessionOps, type SessionOps } from './agent/session-ops'
import { removeWorktree } from './services/worktree'
import { PanelManager } from './extensions/panels'
import type { SessionsCapability } from './extensions/types'
import { buildContextFilesSection } from './agent/context-files'
import { PermissionManager } from './permissions'
import { AnthropicProvider } from './providers/anthropic'
import { OpenAICompatProvider } from './providers/openai-compat'
import { assembleTools, toolInfos, type ToolInfo } from './tools/assemble'
import type { ToolCallInterceptor } from './extensions/types'
import type { ExtensionCommand } from './extensions/types'
import type { ExtensionContext, ExtensionEventName, ExtensionHandlerEntry, ExtensionUi, StateStore, ToolResultInterceptor } from './extensions/types'
import { extensionScanSpecs, loadExtensions } from './extensions/loader'
import { UiRequestManager } from './extensions/ui-requests'
import { bashTool } from './tools/builtin/bash'
import { editFileTool } from './tools/builtin/edit-file'
import { globTool } from './tools/builtin/glob'
import { grepTool } from './tools/builtin/grep'
import { lsTool } from './tools/builtin/ls'
import { readFileTool } from './tools/builtin/read-file'
import { writeFileTool } from './tools/builtin/write-file'
import { isJsonMode, runJsonMode } from './providers/json-mode'
import { buildSkillsSection, buildSkillTool, scanSkills, type SkillMeta } from './services/skills'
import { readWorkspaceFile } from './services/fs-service'
import { extractDocText, isSupportedDoc } from './services/doc-text'
import type { ModelListResult, ExtensionInfo } from '@shared/types'

/** 扩展面板静态资源协议：navagent-ext://<extId>/<path> → userData/extensions/<extId>/<path>（只读） */
// corsEnabled 必开：沙箱 iframe（origin 'null'）里 ES module 脚本按 CORS 模式拉取，缺省会被拦
protocol.registerSchemesAsPrivileged([
  { scheme: 'navagent-ext', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

// 单实例锁：sessions.db 按"单写者 = main 进程"设计，双实例并发会触发 WAL disk I/O error（重启竞态/手动双开都会撞上）
if (!app.requestSingleInstanceLock()) {
  app.quit()
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

// dev 调试通道：CDP attach 用（remote-debugging），打包版不开启
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

const EXT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

/** 注册扩展面板资源协议处理：路径严格限制在扩展目录内（防穿越），只读 */
function registerExtensionProtocol(): void {
  protocol.handle('navagent-ext', (request) => {
    try {
      const url = new URL(request.url)
      const extId = url.hostname
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      if (!extId || !/^[a-zA-Z0-9._-]+$/.test(extId) || rel.includes('..')) {
        return new Response('forbidden', { status: 403 })
      }
      const base = resolve(app.getPath('userData'), 'extensions', extId)
      const abs = resolve(base, rel)
      if (!abs.startsWith(base + (process.platform === 'win32' ? '\\' : '/'))) {
        return new Response('forbidden', { status: 403 })
      }
      const body = readFileSync(abs)
      return new Response(body, {
        headers: {
          'content-type': EXT_MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
          // 沙箱 iframe（origin 'null'）拉取 ES module 走 CORS，响应必须带 ACAO
          'access-control-allow-origin': '*'
        }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'navAgent',
    backgroundColor: '#000000',
    // 自定义菜单默认隐藏（Alt 呼出），快捷键常驻：Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 重置
    autoHideMenuBar: true,
    // 融合标题栏：去系统边框，内容顶到窗口最上；Windows 用原生 overlay 画最小化/最大化/关闭（颜色随主题经 win:overlay 同步）
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#000000', symbolColor: '#9aa1ad', height: 32 } }
      : { titleBarStyle: 'hidden' as const }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // 页面缩放：Ctrl+=（放大）/ Ctrl+-（缩小）/ Ctrl+0（重置）。
  // before-input-event 直接拦按键，不依赖菜单加速器（键盘布局/角色映射歧义）
  win.webContents.on('before-input-event', (event, input) => {
    if (process.env.NAVAGENT_DEBUG_KEYS) console.error('[key]', input.type, JSON.stringify(input.key), 'ctrl=', input.control)
    if (input.type !== 'keyDown' || !input.control || input.alt) return
    const apply = (dir: 'in' | 'out' | 'reset'): void => {
      event.preventDefault()
      if (dir === 'reset') {
        win.webContents.setZoomLevel(0)
        return
      }
      const f = win.webContents.getZoomFactor()
      win.webContents.setZoomFactor(Math.min(3, Math.max(0.5, dir === 'in' ? f * 1.1 : f / 1.1)))
    }
    if (input.key === '=' || input.key === '+') apply('in')
    else if (input.key === '-') apply('out')
    else if (input.key === '0') apply('reset')
  })
  // Ctrl+滚轮缩放（Chromium 的 zoom-changed 事件）
  win.webContents.on('zoom-changed', (_e, dir: 'in' | 'out') => {
    const f = win.webContents.getZoomFactor()
    win.webContents.setZoomFactor(Math.min(3, Math.max(0.5, dir === 'in' ? f * 1.1 : f / 1.1)))
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** models.json 用户级供应商（refreshTools 重扫；pickProvider/合并目录共用） */
let customProviders: CustomProvider[] = []

/** 模型悬浮窗数据源：本地已知模型（models.json 各供应商清单 + 当前模型），零网络——实时列表由设置页探测负责 */
async function listVendorModels(): Promise<ModelListResult> {
  const c = getConfig()
  const catalogIds = customProviders.flatMap((p) => p.models.map((m) => m.model))
  const models = [...new Set([...catalogIds, ...(c.model ? [c.model] : [])])].filter(Boolean).map((id) => ({
    id,
    live: false
  }))
  return { models }
}

function pickProvider(c: ApiConfig): Provider {
  const endpoint = resolveEndpoint(c, { customProviders, userDataPath: app.getPath('userData') })
  const common = {
    id: customProviders.find((p) => p.id === c.providerId)?.id ?? endpoint.protocol,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: c.model,
    modelParams: c.modelParams
  }
  if (endpoint.protocol === 'anthropic') return new AnthropicProvider(common)
  return new OpenAICompatProvider(common)
}

/** 生效上下文窗口（共享实现）：会话/默认所选模型的目录定义优先，否则回退 config 手填 */
function effectiveContextWindow(c: ApiConfig): number {
  return resolveContextWindow(c.model, c.providerId, c.contextWindow, customProviders.flatMap((p) => p.models))
}

/** 合并目录：仅 models.json 自定义供应商 */
function getMergedCatalog(): { models: CustomProviderFull['models'] extends never ? never : import('@shared/model-catalog').CatalogModel[]; customs: CustomProviderFull[] } {
  return {
    models: customProviders.flatMap((p) => p.models),
    customs: customProviders.map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      hasInlineKey: Boolean(p.apiKeyValue),
      ...(p.apiKeyValue ? { apiKeyValue: p.apiKeyValue } : {}),
      models: p.models.map((m) => ({ id: m.model, reasoning: m.supportsThinking, contextWindow: m.contextWindow }))
    }))
  }
}

/** 写 models.json 后热重载自定义供应商（pickProvider / 目录 / 成本计价即时生效） */
function reloadCustomProviders(): void {
  const mp = loadModelsJson(app.getPath('userData'))
  customProviders = mp.providers
}

const BUILTIN_TOOLS: Tool<any>[] = [readFileTool, writeFileTool, editFileTool, lsTool, globTool, grepTool, bashTool]

/** 压缩摘要器：用当前 provider 生成结构化摘要（走统一协议层） */
async function summarizeWithProvider(promptText0: string, maxTokens: number, signal: AbortSignal): Promise<string> {
  let summary = ''
  let outcome: { stopReason: StopReason; errorMessage?: string } = { stopReason: 'error' }
  const provider = pickProvider(getConfig())
  for await (const ev of provider.stream({
    system: COMPACTION_SYSTEM,
    messages: [{ role: 'user', content: promptText0 }],
    tools: [],
    maxTokens,
    signal
  })) {
    if (ev.type === 'text_delta') summary += ev.delta
    else if (ev.type === 'done') outcome = { stopReason: ev.stopReason, errorMessage: ev.errorMessage }
  }
  if (signal.aborted || outcome.stopReason === 'aborted') {
    const e = new Error('Aborted')
    e.name = 'AbortError'
    throw e
  }
  if (outcome.stopReason === 'error') throw new Error(outcome.errorMessage ?? '摘要请求失败')
  if (summary.trim().length === 0) throw new Error('摘要为空')
  return summary.trim()
}

/** 被离开分支的摘要：复用压缩的结构化序列化与文件操作清单（对齐 pi branch-summarization） */
function summarizeBranchMessages(messages: AgentMessage[]): Promise<string> {
  const promptText =
    `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n` +
    BRANCH_SUMMARIZATION_PROMPT +
    formatFileOperations(extractFileOperations(messages))
  return summarizeWithProvider(promptText, 4096, new AbortController().signal)
}

app.whenReady().then(() => {
  // node-pty 的 conpty 代理（fork 子进程）在 shell 退出竞态时会抛 AttachConsole failed，
  // 这类子进程/边缘异常不允许带崩整个应用（桌面端 resilience：记录并继续）
  process.on('uncaughtException', (err) => {
    console.error('[navAgent] 未捕获异常（已兜底忽略）：', err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[navAgent] 未处理的 Promise 拒绝（已兜底忽略）：', reason)
  })

  const store = new SessionStore(app.getPath('userData'))
  // 终端 PTY 服务：退出时统一回收，避免残留 shell 进程
  const terminals = new TerminalService((e) => emitUiEvent(e))
  app.on('will-quit', () => terminals.killAll())

  // --json 模式：事件同时写到 stdout（无窗口时 emitAgentEvent 自然 no-op）
  const jsonModeEnabled = isJsonMode()

  // ── 工具装配：builtin + 扩展 → assembleTools 过滤 → 各会话 Agent 共享同一数组引用（重载原数组清空重填，adaptTools 每次 prompt 重新 map）──
  const activeTools: Tool<any>[] = [...BUILTIN_TOOLS]
  const extensionCommands = new Map<string, ExtensionCommand>()
  /** "仅本次信任"集合（不落盘） */
  const runtimeTrusted = new Set<string>()

  const isTrusted = (ws: string): boolean => getConfig().trustedProjects.includes(ws) || runtimeTrusted.has(ws)

  async function refreshTools(): Promise<void> {
    const c = getConfig()
    // 扩展重载：旧面板 handler 随模块失效，全部收口（renderer 卸载宿主）
    panels.closeAll()
    const result = await loadExtensions(
      extensionScanSpecs(app.getPath('userData'), c.workspacePath, isTrusted(c.workspacePath)),
      { stateDir: join(app.getPath('userData'), 'ext-state'), disabledIds: c.disabledExtensions ?? [], panels }
    )
    lastExtensionTools = result.tools
    lastExtensionInfos = result.infos
    extensionHandlers = result.handlers
    extensionInterceptors = extensionHandlers.filter((h) => h.event === 'tool_call').map((h) => h.handler as ToolCallInterceptor)
    extensionHandlers = result.handlers
    extensionCommands.clear()
    for (const cmd of result.commands) extensionCommands.set(cmd.name, cmd)
    skillsCache = scanSkills([
      { dir: join(app.getPath('userData'), 'skills'), source: 'global' },
      ...(c.workspacePath ? [{ dir: join(c.workspacePath, '.navagent', 'skills'), source: 'project' as const }] : [])
    ])
    const skillTool = skillsCache.length > 0 ? [buildSkillTool(() => skillsCache)] : []
    const next = assembleTools([...BUILTIN_TOOLS, ...skillTool], result.tools, c)
    activeTools.length = 0
    activeTools.push(...next)
    // models.json 用户级供应商（凭据值语法在 pickProvider 请求时解析）
    const mp = loadModelsJson(app.getPath('userData'))
    customProviders = mp.providers
    for (const e of mp.errors) emitAgentEvent('', { type: 'notice', message: `供应商配置：${e}` })
    for (const e of result.errors) emitAgentEvent('', { type: 'notice', message: `扩展加载失败：${e}` })
  }
  let lastExtensionTools: Tool<any>[] = []
  let lastExtensionInfos: ExtensionInfo[] = []
  let extensionInterceptors: ToolCallInterceptor[] = []
  let extensionHandlers: ExtensionHandlerEntry[] = []
  let skillsCache: SkillMeta[] = []
  const listToolInfos = (): ToolInfo[] => toolInfos(BUILTIN_TOOLS, lastExtensionTools, getConfig())

  // ── context files 缓存（同步 getSystemPrompt 的取数来源；取默认项目根，worktree 镜像同内容）──
  let contextFilesCache = ''
  const refreshContextFiles = (): void => {
    contextFilesCache = buildContextFilesSection(getConfig().workspacePath)
  }
  refreshContextFiles()
  // 注：refreshTools 的启动调用在 sessions/panels 集群之后（其内部依赖 panels）

  /** 会话工作区：worktree 优先，缺省回落项目目录 */
  const workspaceOf = (sessionId: string): string => {
    const meta = store.getMeta(sessionId)
    // 文件树/工具/git/系统提示词统一指向会话「所在」的真实项目文件夹（而非隔离 worktree 副本）
    return meta?.projectPath ?? ''
  }

  /** 会话生效配置：会话模型（meta.model，创建时快照 / 悬浮窗切换）覆盖全局；其归属的自定义供应商（id/baseUrl）一并对齐 */
  const sessionConfig = (sessionId: string): ApiConfig => {
    const c = getConfig()
    const model = store.getMeta(sessionId)?.model || c.model
    if (model === c.model) return c
    const owner = customProviders.find((p) => p.models.some((m) => m.model === model))
    return { ...c, model, ...(owner ? { providerId: owner.id, baseUrl: owner.baseUrl } : {}) }
  }

  /** 会话级 notice（进入该会话的事件流） */
  const notice = (sessionId: string, message: string): void => emitAgentEvent(sessionId, { type: 'notice', message })

  /** 会话首次运行前确保 worktree —— 已停用：会话直接运行在真实项目文件夹（文件树与 agent 看同一目录） */
  const ensureSessionWorkspace = async (_sessionId: string): Promise<void> => {}

  // Diff 服务：git 会话走 git diff；非 git 会话靠引擎钩子抓写类工具前后内容
  const diffs = new DiffService(workspaceOf, readWorkspaceFile)

  // 持久化包装（每会话一份闭包）：事件转发窗口（信封）+ JSONL（message_update 过重不落盘，消息以 message_end 为准）
  const emitFor = (sessionId: string) => (event: AgentEvent): void => {
    if (event.type === 'message_end') {
      if (event.message.role === 'user') store.ensureTitle(sessionId, messageText(event.message))
      // 落盘并取节点 id：live 信封携带 nodeId，renderer 即可对消息 rewind/fork
      const nodeId = store.appendMessage(sessionId, event.message)
      if (nodeId) (event.message as AgentMessage & { nodeId?: string }).nodeId = nodeId
    }
    emitAgentEvent(sessionId, event)
    if (jsonModeEnabled) process.stdout.write(JSON.stringify(event) + '\n')
    if (event.type !== 'message_update') store.appendEvent(sessionId, event)
  }

  /** 会话运行时工厂：每会话私有 emit / PermissionManager / Agent（并行互不串扰） */
  const buildSession = (sessionId: string): SessionEntry => {
    const emit = emitFor(sessionId)
    const pm = new PermissionManager(emit)
    pm.setApprovalResolver((toolName, args) => {
      const tool = [...BUILTIN_TOOLS, ...activeTools].find((t) => t.name === toolName)
      return tool?.requiresApproval?.(args) ?? null
    })
    pm.setAutoApprovable(['write_file', 'edit_file'])
    pm.setMode(store.getMeta(sessionId)?.permissionMode ?? getConfig().defaultPermissionMode ?? 'manual')
    /** 会话级扩展信号：session_end/drop 时 abort，观察型 handler 的 ctx.signal 随之取消 */
    const sessionCtl = new AbortController()
    /** 扩展 GUI 交互原语（挂起-应答；会话取消时全部收口） */
    const uirm = new UiRequestManager()
    const ui: ExtensionUi = {
      notify: (text, level) => {
        const prefix = level === 'error' ? '[错误] ' : level === 'warn' ? '[警告] ' : ''
        notice(sessionId, `${prefix}${text}`)
      },
      confirm: (title, message) => uirm.request({ kind: 'confirm', title, message }, (e) => emit(e), sessionCtl.signal) as Promise<boolean>,
      input: (title, opts) =>
        uirm.request({ kind: 'input', title, message: opts?.message, placeholder: opts?.placeholder }, (e) => emit(e), sessionCtl.signal) as Promise<string | null>,
      select: (title, options, opts) =>
        uirm.request({ kind: 'select', title, options, message: opts?.message }, (e) => emit(e), sessionCtl.signal) as Promise<string | null>
    }
    let started = false
    let ended = false
    /** 扩展会话级 K-V（惰性读最近快照，set 即整表快照追加） */
    let sessionState: Record<string, unknown> | null = null
    const sessionStoreApi: StateStore = {
      get: <T>(key: string) => {
        if (sessionState === null) sessionState = store.loadExtState(sessionId)
        return sessionState[key] as T | undefined
      },
      set: (key, value) => {
        if (sessionState === null) sessionState = store.loadExtState(sessionId)
        sessionState[key] = value
        store.appendExtState(sessionId, sessionState)
      },
      delete: (key) => {
        if (sessionState === null) sessionState = store.loadExtState(sessionId)
        delete sessionState[key]
        store.appendExtState(sessionId, sessionState)
      },
      keys: () => {
        if (sessionState === null) sessionState = store.loadExtState(sessionId)
        return Object.keys(sessionState)
      }
    }
    /** 扩展 ctx（多会话共享注册表，ctx 区分来源）；session store 由状态层阶段接入 */
    const extCtx = (signal?: AbortSignal): ExtensionContext => ({
      sessionId,
      workspacePath: workspaceOf(sessionId),
      signal: signal ?? sessionCtl.signal,
      session: sessionStoreApi,
      ui,
      sessions: sessionsCapability(sessionId)
    })
    /** 观察型事件派发：按注册序 await，单点异常隔离为 notice */
    const dispatchObserve = async (name: ExtensionEventName, payload: unknown): Promise<void> => {
      for (const h of extensionHandlers.filter((x) => x.event === name)) {
        try {
          await (h.handler as (p: unknown, c: ExtensionContext) => unknown)(payload, extCtx())
        } catch (err) {
          notice(sessionId, `扩展观察器出错：${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    const agent = new Agent({
      emit,
      tools: activeTools,
      getSystemPrompt: () => systemPromptFor(sessionId),
      getProvider: () => pickProvider(sessionConfig(sessionId)),
      getWorkspacePath: () => workspaceOf(sessionId),
      /** agent bash 在会话的可见终端（PTY）里执行：无存活终端时自动创建，pane 关闭不中断 */
      terminal: {
        exec: async (command: string, timeoutMs: number, signal: AbortSignal): Promise<ToolResult> => {
          const id = await terminals.ensure(sessionId, workspaceOf(sessionId))
          if (!id) return { content: '（终端不可用：PTY 创建失败）', isError: true }
          return terminals.execInPty(id, command, timeoutMs, signal)
        }
      },
      permissions: pm,
      /** 扩展 tool_call 拦截：按注册顺序执行，单点异常隔离为 notice 不阻塞；可 block 或改写 args */
      toolCallInterceptor: async (ctx, signal) => {
        let args: Record<string, unknown> | undefined
        for (const handler of extensionInterceptors) {
          try {
            const res = await handler({ toolName: ctx.toolCall.name, args: args ?? ctx.args }, extCtx(signal))
            if (res?.block) return { block: true, reason: res.reason ?? '被扩展拦截' }
            if (res?.args) args = res.args
          } catch (err) {
            notice(sessionId, `扩展拦截器出错：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return args ? { args } : undefined
      },
      /** 扩展 tool_result 覆写链：串行合并（后 handler 看到前序覆写值），异常隔离为 notice */
      toolResultInterceptor: async (e, signal) => {
        const handlers = extensionHandlers.filter((h) => h.event === 'tool_result')
        if (handlers.length === 0) return undefined
        const cur = { ...e.result }
        let terminate = false
        let changed = false
        for (const h of handlers) {
          try {
            const res = (await (h.handler as ToolResultInterceptor)({ ...e, result: { ...cur } }, extCtx(signal))) ?? undefined
            if (!res) continue
            if (res.content !== undefined && res.content !== cur.content) {
              cur.content = res.content
              changed = true
            }
            if (res.isError !== undefined && res.isError !== cur.isError) {
              cur.isError = res.isError
              changed = true
            }
            if (res.terminate === true) terminate = true
          } catch (err) {
            notice(sessionId, `扩展结果处理器出错：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return changed ? { content: cur.content, isError: cur.isError, ...(terminate ? { terminate: true } : {}) } : undefined
      },
      completeSummarization: (promptText, maxTokens, signal) => summarizeWithProvider(promptText, maxTokens, signal),
      getContextWindow: () => effectiveContextWindow(sessionConfig(sessionId)),
      getCurrentModel: () => sessionConfig(sessionId).model,
      onSnapshot: (messages) => store.appendSnapshot(sessionId, messages),
      getPermissionMode: () => store.getMeta(sessionId)?.permissionMode ?? 'manual',
      changeTracker: {
        before: (ctx) => diffs.before(sessionId, ctx.toolCall.name, ctx.toolCall.id, ctx.args),
        after: (ctx) => diffs.after(sessionId, ctx.toolCall.name, ctx.toolCall.id, ctx.isError)
      },
      maxTurns: 40,
      /** 生命周期观察派发（引擎事件集：agent/turn/compacted；session_* 由会话管理层派发） */
      observe: (ev) => {
        switch (ev.type) {
          case 'agent_start':
            return dispatchObserve('agent_start', {})
          case 'agent_end':
            const last = ev.messages.at(-1)
            return dispatchObserve('agent_end', { stopReason: last?.role === 'assistant' ? last.stopReason : 'stop' })
          case 'turn_start':
            return dispatchObserve('turn_start', {})
          case 'turn_end':
            return dispatchObserve('turn_end', { message: ev.message, toolResults: ev.toolResults })
          case 'compacted':
            return dispatchObserve('compacted', { summary: ev.summary, removedCount: ev.removedCount })
          default:
            return undefined
        }
      }
    })
    /** 回种持久化活动路径：实例是惰性建的，重启后首个 prompt 必须带上历史（否则模型侧失忆、缓存全冷） */
    try {
      agent.replaceTranscript(store.getMessages(sessionId))
    } catch {
      /* 会话行尚不存在（异常 id）时按空 transcript 处理 */
    }
    /** 扩展生命周期：start 首个交互前 once；end 删除/退出时 once（abort 会话信号） */
    return {
      agent,
      pm,
      uirm,
      extCtx,
      ext: {
        start: async () => {
          if (started || ended) return
          started = true
          await dispatchObserve('session_start', { sessionId })
        },
        end: async (reason) => {
          if (ended) return
          ended = true
          started = true
          sessionCtl.abort()
          await dispatchObserve('session_end', { sessionId, reason })
        }
      }
    }
  }

  const sessions = new SessionManager()

  // ── 会话树操作（IPC 与扩展能力面同源）+ 扩展面板宿主 ──
  const sessionOps: SessionOps = createSessionOps({
    store,
    isRunning: (id) => sessions.isRunning(id),
    getAgent: (id) => sessions.get(id)?.agent,
    summarizeBranch: summarizeBranchMessages,
    ensureWorkspace: ensureSessionWorkspace,
    dropSession: (id) => {
      const entry = sessions.get(id)
      sessions.drop(id)
      void entry?.ext?.end('delete')
    },
    clearDiff: (id) => diffs.clear(id),
    removeWorktree: (projectPath, sessionId) => void removeWorktree(projectPath, sessionId),
    notice
  })
  const panels = new PanelManager(emitAgentEvent, (sid) => sessions.get(sid)?.extCtx?.())
  /** ctx.sessions 能力面：扩展经此访问 fork/分支，不触碰 IPC 与存储 */
  const sessionsCapability = (sessionId: string): SessionsCapability => ({
    getTree: async (id) => sessionOps.getTree(id),
    fork: (id, nodeId) => sessionOps.fork(id, nodeId),
    switchLeaf: (id, nodeId, summarize) => sessionOps.switchLeaf(id, nodeId, summarize),
    listSessions: async (projectPath) => store.list(projectPath),
    removeSession: async (id) => sessionOps.removeSession(id)
  })
  /** 面板桥/命令分发取 ctx（会话未建返回 undefined） */
  const extCtxFor = (sessionId: string): import('./extensions/types').ExtensionContext | undefined =>
    sessions.get(sessionId)?.extCtx?.()

  /** ensure + 扩展 session_start（once）：所有交互入口统一走这里 */
  const startedSessions = new Set<string>()
  const ensureSession = async (sessionId: string): Promise<SessionEntry> => {
    const entry = sessions.ensure(sessionId, buildSession)
    if (entry.ext && !startedSessions.has(sessionId)) {
      startedSessions.add(sessionId)
      await entry.ext.start()
    }
    return entry
  }

  // 扩展装配依赖 panels（上面已就绪），启动时统一装载一次
  void refreshTools()

  /** 系统提示词组装（会话级工作目录 + context files + skills + 注入文件；供 Agent 与上下文构成统计共用） */
  function systemPromptFor(sessionId: string): string {
    const ws = workspaceOf(sessionId)
    // 注入文件已改走消息流（带 injectedPath 的合成 user 消息，append-only 不破坏缓存）；
    // plan 行放最末尾：切换权限模式只失效提示词尾部，保住前缀缓存。
    // 刻意不放当前日期——按天变化会让每天首轮全量 miss；时间感知由工具输出（git/文件 mtime）提供
    const planMode = (store.getMeta(sessionId)?.permissionMode ?? 'manual') === 'plan'
    return (
      [
        '你是 navAgent，一个运行在用户本机的编码助手。',
        `工作目录：${ws}`,
        buildEnvSection(detectEnvironment()),
        '规则：',
        '- 文件路径一律使用工作区内的相对路径。',
        '- 读取文件用 read_file；执行命令用 bash（会请求用户批准）。',
        '- 用用户的语言回答；完成任务后给出简短总结。',
        '- 不要在回复中使用 emoji 或装饰性符号（如 📂💻✨🔥）：界面已有图标体系，回复一律用纯文本 Markdown 表达。',
        '- 需要某个已安装技能的详细指令时，调用 skill 工具加载。'
      ].join('\n') +
      contextFilesCache +
      buildSkillsSection(skillsCache) +
      (planMode
        ? [
            '',
            '当前处于计划模式（只读）：写类工具已被移除，禁止尝试修改任何文件；可使用 read_file/ls/grep/glob 等只读工具先探索。',
            '你的回答必须以一份「实施计划」为核心，严格按以下 Markdown 结构组织：',
            '## 实施计划',
            '1. **目标**：一句话说明要达成什么；',
            '2. **现状**：已用只读工具确认的现状（写明涉及的文件路径与关键位置；未经探索确认的部分必须标注"未确认"，禁止编造）；',
            '3. **实施步骤**：编号列出，每步写明要改动的文件与具体改动内容，具体到可直接执行；',
            '4. **验证方式**：每一步及整体如何验证；',
            '5. **风险与备选方案**（可选）。',
            '步骤宁可细分也不要笼统；探索越多，计划越准。'
          ].join('\n')
        : '')
    )
  }

  /** 注入上下文的文件登记（会话级，内存态；仅供 UI 勾选态——内容本体在 transcript 的合成消息里） */
  interface InjectedFile {
    rel: string
  }
  const injectedFiles = new Map<string, InjectedFile[]>()
  /**
   * 注入上下文：内容快照成一条带 injectedPath 的合成 user 消息进 transcript（持久化 + 可 rewind）。
   * 不走系统提示词——消息历史 append-only，注入/取消/文件变动都不破坏前缀缓存。
   */
  async function injectFile(sessionId: string, rel: string): Promise<'ok' | 'not-found'> {
    const ws = workspaceOf(sessionId)
    const abs = resolveWithin(ws, rel)
    if (!abs) return 'not-found'
    const entry = sessions.get(sessionId)
    if (entry?.agent.running) {
      emitAgentEvent(sessionId, { type: 'notice', message: '运行中无法注入文件，请先停止。' })
      return 'not-found'
    }
    const list = injectedFiles.get(sessionId) ?? []
    if (list.some((i) => i.rel === rel)) return 'ok'
    // 内容快照一次（文档类抽取、普通文件现读），之后随消息历史走，不再每轮重读
    let content: string
    if (isSupportedDoc(extnameOf(rel))) {
      const r = await extractDocText(abs)
      if (!r.ok) {
        emitAgentEvent(sessionId, { type: 'notice', message: `注入失败：${r.error}` })
        return 'not-found'
      }
      content = r.text
    } else {
      try {
        content = readFileSync(abs, 'utf-8')
      } catch {
        emitAgentEvent(sessionId, { type: 'notice', message: `注入失败：无法读取 ${rel}` })
        return 'not-found'
      }
    }
    if (content.length > 60_000) content = content.slice(0, 60_000) + '\n…（已截断）'
    const msg: AgentMessage = {
      role: 'user',
      content: `<injected-file path="${rel}">\n${content}\n</injected-file>`,
      injectedPath: rel
    }
    const nodeId = store.appendMessage(sessionId, msg)
    const stamped: AgentMessage = { ...msg, ...(nodeId ? { nodeId } : {}) }
    // 空闲实例同步 transcript，下一轮请求即带上；无实例则 buildSession 回种时自然带上
    if (entry) entry.agent.replaceTranscript([...entry.agent.getTranscript(), stamped])
    injectedFiles.set(sessionId, [...list, { rel }])
    emitAgentEvent(sessionId, { type: 'message_end', message: stamped })
    return 'ok'
  }
  function uninjectFile(sessionId: string, rel: string): 'ok' | 'not-found' {
    const list = injectedFiles.get(sessionId) ?? []
    if (!list.some((i) => i.rel === rel)) return 'not-found'
    injectedFiles.set(sessionId, list.filter((i) => i.rel !== rel))
    return 'ok'
  }
  function listInjectedFiles(sessionId: string): string[] {
    return (injectedFiles.get(sessionId) ?? []).map((i) => i.rel)
  }
  function extnameOf(p: string): string {
    const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    const i = base.lastIndexOf('.')
    return i >= 0 ? base.slice(i).toLowerCase() : ''
  }

  /** 上下文构成统计（estimateTokens 字符/2，与压缩阈值同口径）：分类段 + 逐条消息明细；窗口按该会话所选模型解析 */
  function collectContext(sessionId: string): ContextBreakdown {
    const window_ = effectiveContextWindow(sessionConfig(sessionId))
    // 优先运行实例的实时 transcript；实例是首次 prompt 惰性建的，重启后未发过消息的历史会话
    // 没有实例——此时回退持久化的活动路径消息，否则构成小窗全零、与 chip 的 usage 口径矛盾
    const live = sessions.get(sessionId)?.agent?.getTranscript()
    let msgs = live && live.length > 0 ? live : []
    if (msgs.length === 0) {
      try {
        msgs = store.getMessages(sessionId)
      } catch {
        msgs = []
      }
    }

    const messagesTokens = estimateTokens(msgs)
    const systemTokens = Math.ceil(systemPromptFor(sessionId).length / 2)
    const toolsTokens = Math.ceil(
      activeTools.reduce((s: number, t: { name: string; description: string; parameters: unknown }) => {
        return s + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length
      }, 0) / 2
    )
    // 真实用量优先：最后一条"带 usage"的 assistant（中断/出错的尾部消息可能没有 usage，跳过之）；
    // 各段按估算比例分摊到真值上。整条路径都没有 usage（如全部轮次被中断）时退回纯估算，
    // 但空会话（一条消息都没有）仍显示 0——初始什么都不该算"已用"
    const lastUsage = [...msgs]
      .reverse()
      .find((m): m is AgentMessage & { role: 'assistant' } => m.role === 'assistant' && m.usage !== undefined)?.usage
    const real = lastUsage ? contextTokensOf(lastUsage) : 0
    const estUsed = messagesTokens + systemTokens + toolsTokens
    const used = real > 0 ? real : msgs.length > 0 ? estUsed : 0
    const factor = used > 0 && estUsed > 0 ? used / estUsed : 0
    const scaledMessages = Math.round(messagesTokens * factor)
    const scaledSystem = Math.round(systemTokens * factor)
    const scaledTools =
      real > 0
        ? Math.max(0, used - scaledMessages - scaledSystem) // 真值口径：残差归工具段，保证分段合计 = used
        : Math.round(toolsTokens * factor)
    // 预留不作为分段展示（体现在"距自动压缩"里），只展示已使用的构成
    const sections: ContextSection[] = [
      { key: 'messages', label: '消息历史', tokens: scaledMessages },
      { key: 'system', label: '系统提示', tokens: scaledSystem },
      { key: 'tools', label: '工具定义', tokens: scaledTools },
      { key: 'free', label: '空闲空间', tokens: Math.max(0, window_ - used) }
    ]

    const previewOf = (s: string): string => {
      const line = String(s ?? '').split('\n').find((x) => x.trim().length > 0) ?? ''
      return line.length > 48 ? line.slice(0, 48) + '…' : line
    }
    const messages: ContextMessageShare[] = msgs.map((m) => {
      const tokens = Math.round(estimateTokens([m]) * factor)
      if (m.role === 'user') {
        const text =
          typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '[图片]')).join(' ')
        return { label: '用户', preview: previewOf(text), tokens }
      }
      if (m.role === 'tool_result') {
        return { label: `工具：${m.toolName}`, preview: previewOf(m.content), tokens }
      }
      const calls = m.toolCalls.map((t) => t.name).join('、')
      const text = textOfBlocks(m.content)
      return {
        label: calls ? `助手（调用 ${calls}）` : '助手',
        preview: previewOf(text || (calls ? m.toolCalls.map((t) => t.arguments).join(' ') : '')),
        tokens
      }
    })

    return {
      window: window_,
      used,
      usedPct: window_ > 0 ? Math.min(100, Math.round((used / window_) * 100)) : 0,
      sections,
      messages,
      messagesTotal: scaledMessages
    }
  }

  registerExtensionProtocol()
  registerIpc({
    sessions,
    ensureSession,
    panels,
    extCtxFor,
    ops: sessionOps,
    listModels: listVendorModels,
    listExtensions: () => lastExtensionInfos,
    ensureSessionWorkspace,
    workspaceOf,
    store,
    diffs,
    summarizeBranch: summarizeBranchMessages,
    extensionCommands,
    refreshTools,
    isTrusted,
    trustRuntime: (ws: string) => runtimeTrusted.add(ws),
    listToolInfos,
    refreshContextFiles,
    terminals,
    getMergedCatalog,
    contextBreakdown: collectContext,
    injectFile,
    uninjectFile,
    listInjectedFiles,
    /** 自定义供应商写回（models.json upsert/remove + 热重载），返回刷新后的合并目录 */
    upsertCustomProvider: (input) => {
      const r = upsertModelsJson(app.getPath('userData'), input)
      if (!r.ok) return { ok: false, error: r.error }
      reloadCustomProviders()
      return { ok: true, id: r.id, snapshot: getMergedCatalog() }
    },
    deleteCustomProvider: (id) => {
      const r = removeFromModelsJson(app.getPath('userData'), id)
      if (!r.ok) return { ok: false, error: r.error }
      reloadCustomProviders()
      return { ok: true, snapshot: getMergedCatalog() }
    },
    /** 探测/测试时解析端点凭据：手填 > auth.json > 定义内联值（env 由值语法承担） */
    resolveProbeKey: (providerId: string, formKey: string): string => {
      const custom = customProviders.find((p) => p.id === providerId)
      return (
        resolveCredential(app.getPath('userData'), {
          providerId,
          legacyConfigKey: formKey,
          inlineValue: custom?.apiKeyValue
        })?.key ?? ''
      )
    },
    /** 凭据解析来源（不含明文）：手填 > auth.json > env > 定义内联值 */
    describeCredential: (providerId: string): string | null => {
      const c = getConfig()
      const custom = customProviders.find((p) => p.id === providerId)
      const cred = resolveCredential(app.getPath('userData'), {
        providerId,
        legacyConfigKey: c.apiKey,
        inlineValue: custom?.apiKeyValue
      })
      return cred?.source ?? null
    }
  })

let quitDispatched = false
app.on('before-quit', (e) => {
  if (quitDispatched) return
  const pending = sessions.all().filter((en) => en.ext)
  if (pending.length === 0) return
  quitDispatched = true
  e.preventDefault()
  Promise.race([
    Promise.allSettled(pending.map((en) => en.ext!.end('quit'))),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]).then(() => app.exit(0))
})


  if (jsonModeEnabled) {
    // 无 GUI：stdin 指令驱动，stdout 输出事件流（会话头由 runJsonMode 写出）
    const ws = getConfig().workspacePath || process.cwd()
    const meta = store.create(ws, getConfig().model)
    const { agent } = sessions.ensure(meta.id, () => buildSession(meta.id))
    void runJsonMode({
      agent,
      store,
      sessionId: meta.id,
      writeLine: (line) => process.stdout.write(line + '\n'),
      model: () => getConfig().model,
      workspace: () => getConfig().workspacePath || process.cwd(),
      onQuit: () => app.quit()
    })
    return
  }

  // 应用菜单：页面缩放快捷键（Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 重置）挂在菜单 role 上；
  // 菜单栏默认隐藏（autoHideMenuBar），Alt 呼出，快捷键全局生效
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'editMenu', label: '编辑' },
      {
        label: '视图',
        submenu: [
          { role: 'resetZoom', label: '重置缩放' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' }
        ]
      },
      { role: 'windowMenu', label: '窗口' }
    ])
  )

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

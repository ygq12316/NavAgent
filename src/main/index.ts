import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import type { AgentMessage, StopReason } from '@shared/types'
import type { ApiConfig } from '@shared/types'
import { messageText } from '@shared/types'
import { findPreset } from '@shared/providers'
import type { Provider } from './providers/types'
import type { Tool } from './tools/registry'
import { Agent } from './agent/agent'
import { getConfig } from './config'
import { emitAgentEvent, registerIpc } from './ipc'
import { COMPACTION_SYSTEM } from './agent/context'
import { extractFileOperations, formatFileOperations, serializeConversation } from './agent/compaction'
import { BRANCH_SUMMARIZATION_PROMPT } from './agent/branch'
import { SessionStore } from './agent/session-store'
import { buildContextFilesSection } from './agent/context-files'
import { PermissionManager } from './permissions'
import { AnthropicProvider } from './providers/anthropic'
import { OpenAICompatProvider } from './providers/openai-compat'
import { assembleTools, toolInfos, type ToolInfo } from './tools/assemble'
import type { ToolCallInterceptor } from './extensions/types'
import type { ExtensionCommand } from './extensions/types'
import { extensionScanSpecs, loadExtensions } from './extensions/loader'
import { bashTool } from './tools/builtin/bash'
import { editFileTool } from './tools/builtin/edit-file'
import { globTool } from './tools/builtin/glob'
import { grepTool } from './tools/builtin/grep'
import { lsTool } from './tools/builtin/ls'
import { readFileTool } from './tools/builtin/read-file'
import { writeFileTool } from './tools/builtin/write-file'
import { isJsonMode, runJsonMode } from './json-mode'
import { buildSkillsSection, buildSkillTool, scanSkills, type SkillMeta } from './skills'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'navAgent',
    backgroundColor: '#d2cfc8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function pickProvider(c: ApiConfig): Provider {
  // 协议选择：预设优先，缺省按模型名/网关地址嗅探（旧配置兼容）
  const preset = findPreset(c.providerId)
  const protocol =
    preset?.protocol ?? (c.model.startsWith('claude') || /anthropic/i.test(c.baseUrl) ? 'anthropic' : 'openai-compat')
  const common = {
    id: preset?.id ?? protocol,
    baseUrl: c.baseUrl || preset?.baseUrl || '',
    apiKey: c.apiKey,
    model: c.model,
    modelParams: c.modelParams
  }
  if (protocol === 'anthropic') return new AnthropicProvider(common)
  return new OpenAICompatProvider(common)
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
  const store = new SessionStore(app.getPath('userData'))
  const permissions = new PermissionManager(emitAgentEvent)

  // --json 模式：事件同时写到 stdout（无窗口时 emitAgentEvent 自然 no-op）
  const jsonModeEnabled = isJsonMode()

  // 持久化包装：事件转发到窗口 + JSONL（message_update 过重不落盘，消息以 message_end 为准）
  const emit: (e: Parameters<typeof emitAgentEvent>[0]) => void = (event) => {
    emitAgentEvent(event)
    if (jsonModeEnabled) process.stdout.write(JSON.stringify(event) + '\n')
    if (!store.currentId) return
    if (event.type !== 'message_update') store.appendEvent(store.currentId, event)
    if (event.type === 'message_end') {
      store.appendMessage(store.currentId, event.message)
      if (event.message.role === 'user') store.ensureTitle(store.currentId, messageText(event.message))
    }
  }

  // ── 工具装配：builtin + 扩展 → assembleTools 过滤 → Agent 持有同一数组引用（重载原数组清空重填）──
  const activeTools: Tool<any>[] = [...BUILTIN_TOOLS]
  const extensionCommands = new Map<string, ExtensionCommand>()
  /** "仅本次信任"集合（不落盘） */
  const runtimeTrusted = new Set<string>()

  const isTrusted = (ws: string): boolean => getConfig().trustedProjects.includes(ws) || runtimeTrusted.has(ws)

  async function refreshTools(): Promise<void> {
    const c = getConfig()
    const result = await loadExtensions(
      extensionScanSpecs(app.getPath('userData'), c.workspacePath, isTrusted(c.workspacePath))
    )
    lastExtensionTools = result.tools
    extensionInterceptors = result.toolCallInterceptors
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
    for (const e of result.errors) emitAgentEvent({ type: 'notice', message: `扩展加载失败：${e}` })
  }
  let lastExtensionTools: Tool<any>[] = []
  let extensionInterceptors: ToolCallInterceptor[] = []
  let skillsCache: SkillMeta[] = []
  const listToolInfos = (): ToolInfo[] => toolInfos(BUILTIN_TOOLS, lastExtensionTools, getConfig())

  // ── context files 缓存（同步 getSystemPrompt 的取数来源）──
  let contextFilesCache = ''
  const refreshContextFiles = (): void => {
    contextFilesCache = buildContextFilesSection(getConfig().workspacePath)
  }
  refreshContextFiles()
  void refreshTools()

  const agent = new Agent({
    emit,
    tools: activeTools,
    getSystemPrompt: () => {
      const ws = getConfig().workspacePath
      return (
        [
          '你是 navAgent，一个运行在用户本机的编码助手。',
          `工作目录：${ws}`,
          `当前日期：${new Date().toISOString().slice(0, 10)}`,
          '规则：',
          '- 文件路径一律使用工作区内的相对路径。',
          '- 读取文件用 read_file；执行命令用 bash（会请求用户批准）。',
          '- 用用户的语言回答；完成任务后给出简短总结。',
          '- 需要某个已安装技能的详细指令时，调用 skill 工具加载。'
        ].join('\n') +
        contextFilesCache +
        buildSkillsSection(skillsCache)
      )
    },
    getProvider: () => pickProvider(getConfig()),
    getWorkspacePath: () => getConfig().workspacePath,
    permissions,
    /** 扩展 tool_call 拦截：按注册顺序执行，单点异常隔离为 notice 不阻塞；可 block 或改写 args */
    toolCallInterceptor: async (ctx) => {
      let args: Record<string, unknown> | undefined
      for (const handler of extensionInterceptors) {
        try {
          const res = await handler({ ...ctx, ...(args ? { args } : {}) })
          if (res?.block) return { block: true, reason: res.reason ?? '被扩展拦截' }
          if (res?.args) args = res.args
        } catch (err) {
          emitAgentEvent({ type: 'notice', message: `扩展拦截器出错：${err instanceof Error ? err.message : String(err)}` })
        }
      }
      return args ? { args } : undefined
    },
    completeSummarization: (promptText, maxTokens, signal) => summarizeWithProvider(promptText, maxTokens, signal),
    getContextWindow: () => getConfig().contextWindow ?? 64_000,
    getCurrentModel: () => getConfig().model,
    onSnapshot: (messages) => {
      if (store.currentId) store.appendSnapshot(store.currentId, messages)
    },
    maxTurns: 40
  })
  // 审批判定查当前装配全量工具（builtin + 扩展）
  permissions.setApprovalResolver((toolName, args) => {
    const tool = [...BUILTIN_TOOLS, ...activeTools].find((t) => t.name === toolName)
    return tool?.requiresApproval?.(args) ?? null
  })

  registerIpc({
    agent,
    store,
    permissions,
    summarizeBranch: summarizeBranchMessages,
    extensionCommands,
    refreshTools,
    isTrusted,
    trustRuntime: (ws: string) => runtimeTrusted.add(ws),
    listToolInfos,
    refreshContextFiles
  })

  if (jsonModeEnabled) {
    // 无 GUI：stdin 指令驱动，stdout 输出事件流（会话头已在 runJsonMode 写出）
    void runJsonMode({
      agent,
      store,
      writeLine: (line) => process.stdout.write(line + '\n'),
      model: () => getConfig().model,
      workspace: () => getConfig().workspacePath || process.cwd(),
      onQuit: () => app.quit()
    })
    return
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

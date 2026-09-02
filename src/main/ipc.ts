import { BrowserWindow, dialog, ipcMain, app } from 'electron'
import { copyFileSync } from 'node:fs'
import { writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent, AgentMessage, ApiConfig, DirEntry, ImageContent, SessionTreeNode, TreeSummaryResult, UiEvent } from '@shared/types'
import type { Agent } from './agent/agent'
import type { SessionStore } from './agent/session-store'
import type { PermissionManager } from './permissions'
import type { ExtensionCommand } from './extensions/types'
import type { ToolInfo } from './tools/assemble'
import type { TerminalService } from './terminal'
import { createBranchSummaryMessage, findCommonAncestor } from './agent/branch'
import { expandPrompt, scanPromptTemplates } from './prompts'
import { renderSessionHtml } from './export-html'
import { getConfig, updateConfig } from './config'
import { resolveWithin } from './tools/registry'
import { readWorkspaceFile, writeWorkspaceFile, globWorkspace } from './fs-service'
import { toRel } from './tools/walk'

const NOISE_DIRS = new Set(['node_modules', 'dist', 'out', '__pycache__'])

export function emitAgentEvent(event: AgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:event', event)
  }
}

/** UI 事件（PTY 等）独立通道，与 agent 事件流互不干扰 */
export function emitUiEvent(event: UiEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('navagent:uiEvent', event)
  }
}

export function registerIpc(deps: {
  agent: Agent
  store: SessionStore
  permissions: PermissionManager
  /** 被离开分支的摘要引擎（index.ts 注入，复用压缩摘要链路） */
  summarizeBranch: (messages: AgentMessage[]) => Promise<string>
  /** 扩展命令注册表与工具热重载（index.ts 注入） */
  extensionCommands: Map<string, ExtensionCommand>
  refreshTools: () => Promise<void>
  isTrusted: (ws: string) => boolean
  trustRuntime: (ws: string) => void
  listToolInfos: () => ToolInfo[]
  /** 工作区 context files 缓存重建（启动/config:set/手动刷新） */
  refreshContextFiles: () => void
  /** 终端服务（Terminal 窗口 PTY 后端；index.ts 注入） */
  terminals: TerminalService
}): void {
  const { agent, store, permissions, summarizeBranch, terminals } = deps

  ipcMain.handle('config:get', () => getConfig())

  ipcMain.handle('config:set', (_e, partial: Partial<ApiConfig>) => {
    const next = updateConfig(partial)
    // 工作区/信任/只读/禁用清单变化都会影响扩展加载与工具装配；工作区变化还要重建 context files 缓存
    deps.refreshContextFiles()
    void deps.refreshTools()
    return next
  })

  ipcMain.handle('context:refresh', () => {
    deps.refreshContextFiles()
    emitAgentEvent({ type: 'notice', message: '已重新加载工作区 context files（AGENTS.md / CLAUDE.md）' })
  })

  ipcMain.handle('dialog:pickWorkspace', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('agent:send', (_e, text: string, images?: ImageContent[]) => {
    const validImages = Array.isArray(images)
      ? images.filter((im) => typeof im?.data === 'string' && typeof im?.mimeType === 'string').slice(0, 8)
      : undefined
    if (typeof text !== 'string' || (text.trim().length === 0 && (validImages?.length ?? 0) === 0)) return 'busy'
    const current = store.getCurrent()
    if (!current || current.projectPath !== getConfig().workspacePath) {
      store.create(getConfig().workspacePath, getConfig().model)
      agent.reset()
    }
    return agent.prompt(text.trim(), validImages)
  })

  // 运行中插话（pi 的 steering）：进入队列，下一个工具批次结束后注入
  ipcMain.handle('agent:steer', (_e, text: string) => {
    if (typeof text !== 'string' || text.trim().length === 0) return 'busy'
    return agent.steer(text.trim())
  })

  // 运行中排队续跑（pi 的 follow-up）：本轮 agent 结束后自动运行
  ipcMain.handle('agent:followUp', (_e, text: string) => {
    if (typeof text !== 'string' || text.trim().length === 0) return 'busy'
    return agent.followUp(text.trim())
  })

  // 取消并取回未消费的排队消息（pi 的 Escape 行为），UI 据此回填输入框
  ipcMain.handle('agent:cancel', () => agent.abort())

  ipcMain.handle('agent:compact', () => agent.compact())

  ipcMain.handle('agent:respondPermission', (_e, requestId: string, decision: 'approve' | 'deny' | 'always') =>
    permissions.respond(requestId, decision)
  )

  ipcMain.handle('session:new', () => {
    const meta = store.create(getConfig().workspacePath, getConfig().model)
    agent.reset()
    return meta.id
  })

  ipcMain.handle('session:list', () => store.list(getConfig().workspacePath))

  // 删除会话：当前会话运行中拒绝（busy）；删除当前会话后自动切到列表第一个并重放消息，无剩余会话则仅 reset
  ipcMain.handle('session:delete', (_e, id: string): 'ok' | 'busy' | 'not-found' => {
    if (typeof id !== 'string') return 'not-found'
    if (agent.running && store.getCurrent()?.id === id) return 'busy'
    // remove 会把会话移出注册表，"是否当前会话"必须在删除前判定
    const wasCurrent = store.getCurrent()?.id === id
    const r = store.remove(id)
    if (r !== 'ok') return r
    if (wasCurrent) {
      const rest = store.list(getConfig().workspacePath)
      agent.reset()
      if (rest[0]) {
        const { messages } = store.load(rest[0].id)
        agent.replaceTranscript(messages)
        for (const m of messages) {
          emitAgentEvent({ type: 'message_start', message: m })
          emitAgentEvent({ type: 'message_end', message: m })
        }
      }
    }
    return 'ok'
  })

  // 重放：以 message 行为准（新事件协议下 event 行仅作调试），逐条发 message_start/end
  ipcMain.handle('session:switch', (_e, id: string) => {
    const { messages } = store.load(id)
    agent.reset()
    agent.replaceTranscript(messages)
    for (const m of messages) {
      emitAgentEvent({ type: 'message_start', message: m })
      emitAgentEvent({ type: 'message_end', message: m })
    }
  })

  // ── 会话树 ────────────────────────────────────────────────

  ipcMain.handle('session:tree', (_e, id: string): SessionTreeNode[] => store.listTree(id))

  /**
   * 切换活动叶子（跳转续跑/改写重发的基础）。
   * summarize=true 且目标不是原叶子的后代时，为被离开路径生成分支摘要并挂到新导航点。
   */
  ipcMain.handle(
    'session:switchLeaf',
    async (_e, id: string, nodeId: string, summarize: boolean): Promise<TreeSummaryResult> => {
      if (agent.running) {
        emitAgentEvent({ type: 'notice', message: '运行中无法切换分支，请先停止。' })
        return { summaryInjected: false }
      }
      if (store.getCurrent()?.id !== id) {
        emitAgentEvent({ type: 'notice', message: '只能切换当前会话的分支。' })
        return { summaryInjected: false }
      }
      const oldLeaf = store.getLeaf(id)
      const oldChain = oldLeaf ? store.getAncestors(id, oldLeaf) : []
      const targetChain = store.getAncestors(id, nodeId)
      const movingForward = oldLeaf !== null && targetChain.includes(oldLeaf)

      const { messages } = store.switchLeaf(id, nodeId)

      let summaryInjected = false
      if (summarize && oldLeaf && !movingForward && oldLeaf !== nodeId) {
        const common = findCommonAncestor(oldChain, targetChain)
        const abandoned = common ? store.messagesBetween(id, common, oldLeaf) : []
        if (abandoned.length > 0) {
          let summaryText: string
          try {
            summaryText = await summarizeBranch(abandoned)
          } catch {
            summaryText = '（分支摘要生成失败，仅保留导航点。）'
          }
          const msg = createBranchSummaryMessage(summaryText)
          store.appendMessage(id, msg)
          messages.push(msg)
          summaryInjected = true
        }
      }

      agent.reset()
      agent.replaceTranscript(messages)
      for (const m of messages) {
        emitAgentEvent({ type: 'message_start', message: m })
        emitAgentEvent({ type: 'message_end', message: m })
      }
      return { summaryInjected }
    }
  )

  ipcMain.handle('session:fork', (_e, id: string, nodeId: string): string | null => {
    if (agent.running) {
      emitAgentEvent({ type: 'notice', message: '运行中无法派生会话，请先停止。' })
      return null
    }
    const meta = store.fork(id, nodeId)
    const { messages } = store.load(meta.id)
    agent.reset()
    agent.replaceTranscript(messages)
    for (const m of messages) {
      emitAgentEvent({ type: 'message_start', message: m })
      emitAgentEvent({ type: 'message_end', message: m })
    }
    return meta.id
  })

  ipcMain.handle('session:clone', (_e, id: string): string | null => {
    if (agent.running) {
      emitAgentEvent({ type: 'notice', message: '运行中无法克隆会话，请先停止。' })
      return null
    }
    const meta = store.clone(id)
    const { messages } = store.load(meta.id)
    agent.reset()
    agent.replaceTranscript(messages)
    for (const m of messages) {
      emitAgentEvent({ type: 'message_start', message: m })
      emitAgentEvent({ type: 'message_end', message: m })
    }
    return meta.id
  })

  ipcMain.handle('fs:listDir', async (_e, rel: string): Promise<DirEntry[]> => {
    const ws = getConfig().workspacePath
    if (!ws) return []
    const abs = resolveWithin(ws, rel || '.')
    if (!abs) return []
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])
    return entries
      .filter((en) => !en.name.startsWith('.') && !(en.isDirectory() && NOISE_DIRS.has(en.name)))
      .map((en) => ({ name: en.name, type: en.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  })

  // ── 工作区文件读写 / glob / 文件选择（File 窗口后端；失败编码进返回值） ──

  ipcMain.handle('fs:read', (_e, rel: string) => readWorkspaceFile(getConfig().workspacePath, String(rel ?? '')))

  ipcMain.handle('fs:write', (_e, rel: string, content: string, baseMtime?: number) =>
    writeWorkspaceFile(getConfig().workspacePath, String(rel ?? ''), String(content ?? ''), typeof baseMtime === 'number' ? baseMtime : undefined)
  )

  ipcMain.handle('fs:glob', (_e, pattern: string) =>
    typeof pattern === 'string' && pattern.trim() ? globWorkspace(getConfig().workspacePath, pattern.trim()) : []
  )

  // 系统文件选择器：选中工作区外文件时返回 null（不越界）
  ipcMain.handle('file:pick', async (): Promise<string | null> => {
    const ws = getConfig().workspacePath
    if (!ws) return null
    const res = await dialog.showOpenDialog({ defaultPath: ws, properties: ['openFile'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return resolveWithin(ws, res.filePaths[0]!) ? toRel(ws, res.filePaths[0]!) : null
  })

  // ── 终端（PTY）：spawn 失败返回 null，其余操作失败静默（对"永不 throw"契约） ──

  ipcMain.handle('pty:create', (): string | null =>
    terminals.create(getConfig().workspacePath || app.getPath('home'), {
      onData: (id, chunk) => emitUiEvent({ type: 'pty_data', id, chunk }),
      onExit: (id, exitCode) => emitUiEvent({ type: 'pty_exit', id, exitCode })
    })
  )
  ipcMain.handle('pty:write', (_e, id: string, data: string) => terminals.write(String(id), String(data ?? '')))
  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
    terminals.resize(String(id), Number(cols) || 80, Number(rows) || 24)
  )
  ipcMain.handle('pty:kill', (_e, id: string) => terminals.kill(String(id)))

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

  ipcMain.handle('commands:list', () => [...deps.extensionCommands.values()].map((c) => ({ name: c.name, description: c.description })))

  // 斜杠命令统一分发：内置 compact → 扩展命令 → prompt 模板 → unknown
  ipcMain.handle('commands:dispatch', async (_e, name: string, args: string): Promise<'ok' | 'unknown'> => {
    if (typeof name !== 'string' || !name) return 'unknown'
    const rawArgs = typeof args === 'string' ? args : ''
    if (name === 'compact') {
      void agent.compact()
      return 'ok'
    }
    const cmd = deps.extensionCommands.get(name)
    if (cmd) {
      try {
        const out = await cmd.handler(rawArgs)
        emitAgentEvent({ type: 'notice', message: `/${name}${out ? `：${out}` : ' 已执行'}` })
      } catch (err) {
        emitAgentEvent({ type: 'notice', message: `命令 /${name} 失败：${err instanceof Error ? err.message : String(err)}` })
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
      if (agent.running) agent.steer(text)
      else void agent.prompt(text).then((r) => (r === 'busy' ? agent.steer(text) : undefined))
      emitAgentEvent({ type: 'notice', message: `已展开 prompt 模板 /${name}` })
      return 'ok'
    }
    emitAgentEvent({ type: 'notice', message: `未知命令 /${name}（可用：/compact、扩展命令、prompts 目录下的模板）` })
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
      copyFileSync(store.sourceFileOf(id), res.filePath)
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
    emitAgentEvent({ type: 'notice', message: `已导入会话：${meta.title}` })
    return meta.id
  })
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** 命中缓存的输入 token（Anthropic cache_read / OpenAI cached_tokens） */
  cacheReadTokens?: number
  /** 写入缓存的 token（Anthropic cache_creation；仅 Anthropic 单独计价） */
  cacheWriteTokens?: number
}

/** 上下文规模口径：非缓存输入 + 缓存读 + 缓存写（ctx% 与压缩估算统一用） */
export function contextTokensOf(usage: Usage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** 回合终态原因（对齐 pi 的 StopReason）；pending 仅用于流式过程中的 partial 快照 */
export type StopReason = 'pending' | 'stop' | 'toolUse' | 'length' | 'error' | 'aborted'

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** content blocks（对齐 pi 的 ai/src/types.ts）。刻意分歧：toolCalls 不进块数组，tool_result.content 保持 string */
export interface TextContent {
  type: 'text'
  text: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
  /** Anthropic 签名（回传校验用）；openai-compat 侧记录来源字段名（reasoning_content 等） */
  thinkingSignature?: string
  /** Anthropic redacted_thinking：加密负载，thinking 为空串 */
  redacted?: boolean
}

export interface ImageContent {
  type: 'image'
  /** base64，不带 data: 前缀 */
  data: string
  mimeType: string
}

export type ContentBlock = TextContent | ThinkingContent | ImageContent

export type AgentMessage =
  | {
      role: 'user'
      content: string | (TextContent | ImageContent)[]
      nodeId?: string
      /** 注入上下文的文件（<injected-file> 合成消息；renderer 据此折叠渲染，模型只看 content） */
      injectedPath?: string
    }
  | {
      role: 'assistant'
      content: (TextContent | ThinkingContent)[]
      toolCalls: ToolCall[]
      usage?: Usage
      stopReason: StopReason
      errorMessage?: string
      /** 产生本消息的模型：thinking 签名只对同模型有效，跨模型清洗据此降级 */
      model?: string
      /** 所属会话树节点（store 落盘时打标；rewind/fork 定位用） */
      nodeId?: string
    }
  | { role: 'tool_result'; callId: string; toolName: string; content: string; isError: boolean; nodeId?: string }

/** 提取 content blocks 里的纯文本（thinking 不算正文） */
export function textOfBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/** 消息的展示/序列化文本（标题、压缩序列化、token 估算统一入口） */
export function messageText(msg: AgentMessage): string {
  if (msg.role === 'user') return typeof msg.content === 'string' ? msg.content : textOfBlocks(msg.content)
  if (msg.role === 'assistant') return textOfBlocks(msg.content)
  return msg.content
}

/** 每张图片按 ≈800 token（1600 字符）粗估——base64 体积不代表真实 token 消耗 */
const IMAGE_ESTIMATED_CHARS = 1600

/** 消息的粗略字符量（token 估算用；thinking 计入——它真实消耗了上下文） */
export function messageChars(msg: AgentMessage): number {
  if (msg.role === 'assistant') {
    let chars = 0
    for (const b of msg.content) chars += b.type === 'text' ? b.text.length : b.thinking.length
    for (const tc of msg.toolCalls) chars += tc.arguments.length + tc.name.length
    return chars
  }
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') return msg.content.length
    return msg.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : IMAGE_ESTIMATED_CHARS), 0)
  }
  return msg.content.length
}

/**
 * Agent 事件流（对齐 pi 的 AgentEvent 生命周期）。
 * message_update 携带 partial 快照（UI 拿来即用，无需自行拼增量）；
 * 失败/取消不单独发事件——从 message_end 的 stopReason 读取（错误进流契约）。
 */
export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: AgentMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: string }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; partialResult: string }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { type: 'permission_request'; requestId: string; toolName: string; detail: string }
  | { type: 'compacted'; summary: string; removedCount: number }
  | { type: 'retrying'; attempt: number; maxRetries: number; delayMs: number; reason: string }
  | { type: 'notice'; message: string }
  | { type: 'queue_update'; steering: number; followUp: number }
  /** 扩展 GUI 交互原语（ctx.ui）：renderer 弹窗应答后经 respondUi 送回（挂起-应答，模式同权限卡） */
  | {
      type: 'ui_request'
      requestId: string
      kind: 'confirm' | 'input' | 'select'
      title: string
      message?: string
      placeholder?: string
      options?: string[]
    }
  /** 扩展面板（openPanel）：renderer 打开沙箱 iframe 宿主，entry 为扩展目录内相对入口 */
  | {
      type: 'panel_open'
      panelId: string
      extId: string
      sessionId: string
      title: string
      entry: string
      width?: number
      height?: number
    }
  | { type: 'panel_close'; panelId: string }
  /** 扩展面板主动推送（扩展 main 侧 → 面板 GUI），payload 任意 JSON */
  | { type: 'panel_push'; panelId: string; payload: unknown }

/** UI 事件（非 agent 契约）：PTY 数据/退出。独立通道 navagent:uiEvent；pty 归属会话随事件携带 */
export type UiEvent =
  | { type: 'pty_data'; id: string; sessionId: string; chunk: string }
  | { type: 'pty_exit'; id: string; sessionId: string; exitCode: number }

/** IPC 边界事件信封：并行会话下 renderer 按 sessionId 路由进各自的视图状态桶；AgentEvent 本体契约不变 */
export interface AddressedEvent {
  sessionId: string
  event: AgentEvent
}

export type PermissionDecision = 'approve' | 'deny' | 'always'

/** 权限模式（对齐 Claude Code 桌面端模式选择器）：manual 逐工具审批 / acceptEdits 文件编辑自动放行 / plan 只读探索 */
export type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/** Diff 面板单文件条目 */
export interface DiffFileEntry {
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  /** unified diff 文本；untracked 新文件为全绿内容 */
  diff: string
}

export interface DiffResult {
  /** git=仓库 diff（含 bash 造成的改动）；session=非 git 项目按会话内工具改动记录计算 */
  source: 'git' | 'session'
  files: DiffFileEntry[]
}

export interface DiffSummary {
  additions: number
  deletions: number
  files: number
}

/** git 改动文件状态（porcelain 两列码映射后的语义） */
export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted' | 'untracked'

export interface GitFile {
  path: string
  status: GitFileStatus
  /** 重命名/复制时的原名（porcelain 的 ` -> ` 左侧） */
  origPath?: string
}

/** git 源代码管理面板数据（VS Code Source Control 语义） */
export interface GitStatusResult {
  /** 当前分支名（HEAD detached 或非 git 目录为 null） */
  current: string | null
  /** 已暂存（index 列有改动） */
  staged: GitFile[]
  /** 工作区未暂存（worktree 列有改动） */
  unstaged: GitFile[]
  /** 未跟踪（??） */
  untracked: GitFile[]
}

/** 会话加载结果（renderer 自行灌入对应视图状态桶，替代旧"主进程逐条重放"） */
export type SessionLoadResult =
  | { ok: true; meta: SessionMeta; messages: AgentMessage[] }
  | { ok: false; error: 'not-found' | 'io' }

export interface SessionMeta {
  id: string
  projectPath: string
  title: string
  createdAt: number
  updatedAt: number
  model: string
  /** 会话树活动叶子（旧格式会话迁移前为空） */
  leafId?: string
  /** 派生来源：本会话由 fork(sourceSessionId, forkNodeId) 创建（会话地图的父子边） */
  forkSourceId?: string
  forkNodeId?: string
  /** 会话工作区：git 仓库的会话首次运行时落在独立 worktree；无隔离时缺省（= projectPath） */
  worktreePath?: string
  /** 权限模式（缺省 manual；会话级持久化，运行中可切换） */
  permissionMode?: PermissionMode
  /** 已归档（rail 隐藏到归档分组，可取消归档） */
  archived?: boolean
}

/** 会话树节点（listTree 用；只有 message/snapshot 行是树节点，event 行不参与） */
export interface SessionTreeNode {
  id: string
  parentId: string | null
  kind: 'message' | 'snapshot'
  role: 'user' | 'assistant' | 'tool_result' | 'snapshot'
  ts: number
  preview: string
}

/** MCP（Model Context Protocol）服务器定义：stdio JSON-RPC 拉起本地进程 */
export interface McpServerDef {
  command: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
}

export interface McpConfig {
  servers?: Record<string, McpServerDef>
}

export type McpServerState = 'ready' | 'error' | 'disabled'

export interface McpServerStatus {
  name: string
  status: McpServerState
  error?: string
  tools?: number
  command?: string
}

/** 全文检索命中（SQLite nodes.txt 派生列，LIKE 子串匹配） */
export interface SessionSearchHit {
  sessionId: string
  nodeId: string
  title: string
  updatedAt: number
  snippet: string
}

export interface TreeSummaryResult {
  summaryInjected: boolean
}

/** 工具清单条目（设置面板用） */
export interface ToolInfo {
  name: string
  source: 'builtin' | 'extension'
  mutating: boolean
  enabled: boolean
  /** 条件注册工具未就绪时的指引（如 web_search 未配 key）；非空 = 开关无效 */
  hint?: string
}

export interface CommandInfo {
  name: string
  description: string
}

export interface ReloadResult {
  tools: number
  commands: number
}

/** 已加载扩展信息（设置页扩展卡片；manifest.json 提供元数据，目录名兜底） */
export interface ExtensionInfo {
  id: string
  name: string
  version?: string
  description?: string
  /** 来源：global=userData/extensions（用户自有，可删）；project=<ws>/.navagent/extensions（信任门） */
  source: 'global' | 'project'
  /** 注册的工具/命令名列表 */
  tools: string[]
  commands: string[]
  /** 加载失败原因（失败扩展 tools/commands 为空） */
  error?: string
  disabled: boolean
}

export interface ExtensionOpResult {
  ok: boolean
  canceled?: boolean
  error?: string
  extensions: ExtensionInfo[]
}

/** thinking 档位（对齐 pi 7 档）；由 thinkingFormat（compat flags）按厂商映射为请求参数 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelParams {
  temperature?: number
  top_p?: number
  max_tokens?: number
  thinkingLevel?: ThinkingLevel
}

export interface ApiConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 厂商预设 id（见 shared/providers.ts）；缺省 = 按模型名/baseUrl 嗅探协议 */
  providerId?: string
  workspacePath: string
  recentProjects: string[]
  /** 模型上下文窗口（token），压缩阈值 = window − reserveTokens */
  contextWindow?: number
  /** 模型推理参数；字段缺省 = 用厂商默认值 */
  modelParams?: ModelParams
  /** 只读模式：不注册任何可变更工作区的工具（bash/write/edit） */
  readOnly: boolean
  /** 按名禁用的工具（builtin 与扩展通用） */
  disabledTools: string[]
  /** 已禁用的扩展 id（loader 跳过加载） */
  disabledExtensions?: string[]
  /** 已信任的工作区（信任后才加载项目级扩展） */
  trustedProjects: string[]
  /** 新会话的默认权限模式（会话可在 meta.permissionMode 覆盖） */
  defaultPermissionMode?: PermissionMode
  /** AI 回答中发送新消息时是否追加为续跑（默认开启，CC 对齐） */
  appendWhileRunning?: boolean
  /** 联网搜索（web_search/web_fetch 的后端）；缺省 = 不注册这两个工具 */
  webSearch?: WebSearchConfig
}

/** 联网搜索配置：provider 决定后端实现（当前 tavily；key 为空 = 未配置） */
export interface WebSearchConfig {
  provider: 'tavily'
  apiKey: string
}

export interface ParsedCommand {
  name: string
  args: string
}

/** 解析 `/name args` 斜杠命令；非命令或名称非法返回 null（对齐 pi 的命令入口约定） */
export function parseCommand(text: string): ParsedCommand | null {
  const m = /^\/([a-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  return { name: m[1], args: (m[2] ?? '').trim() }
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface DirEntry {
  name: string
  type: 'file' | 'dir'
}

/** 读工作区文件结果（fs-service；失败编码进返回值，永不 throw） */
export type FileReadResult =
  | { ok: true; content: string; mtime: number; truncated: boolean }
  | { ok: false; error: 'outside-workspace' | 'not-found' | 'binary' | 'io'; message: string }

/** 写工作区文件结果（baseMtime 冲突检测由 fs-service 判定） */
export type FileWriteResult =
  | { ok: true; mtime: number }
  | { ok: false; error: 'conflict' | 'outside-workspace' | 'io'; message: string }

/** 上下文明细：每条消息占上下文的比例（estimateTokens 字符/2 估算，与压缩阈值同口径） */
export interface ContextMessageShare {
  /** 角色标签：用户 / 助手 / 助手（调用 xx）/ 工具：xx */
  label: string
  /** 内容预览（≤48 字符） */
  preview: string
  tokens: number
}

/** 分类构成（对齐 Claude Code /context）：系统提示 / 工具定义 / 消息历史 / 自动压缩预留 / 空闲空间 */
export type ContextSectionKey = 'messages' | 'system' | 'tools' | 'reserve' | 'free'

export interface ContextSection {
  key: ContextSectionKey
  label: string
  tokens: number
}

export interface ContextBreakdown {
  /** 窗口大小（token） */
  window: number
  /** 已用合计（system+tools+messages，估算） */
  used: number
  /** 已用占窗口百分比 */
  usedPct: number
  sections: ContextSection[]
  /** 逐条消息明细（箭头展开后） */
  messages: ContextMessageShare[]
  messagesTotal: number
}

/** preload 桥与 mock 共同实现的窄接口（设计方案 4.6；会话中心版：一切 agent/文件/终端操作显式携带 sessionId） */
export interface NavAgentApi {
  getConfig(): Promise<ApiConfig>
  setConfig(partial: Partial<ApiConfig>): Promise<ApiConfig>
  /** 融合标题栏：Windows overlay 窗口钮配色随主题切换 */
  setOverlayTheme(theme: 'light' | 'dark'): Promise<'ok'>
  pickWorkspace(): Promise<string | null>
  /** 向指定会话发送 prompt；该会话运行中时自动转为 steering 注入 */
  send(sessionId: string, text: string, images?: ImageContent[]): Promise<'ok'>
  /** 运行中插话：注入 steering 队列，在下一个工具批次结束后被模型看到；空闲时转为普通 prompt */
  steer(sessionId: string, text: string): Promise<'ok' | 'queued'>
  /** 运行中排队续跑（pi 的 Alt+Enter）：本轮结束后自动运行；空闲时转为普通 prompt */
  followUp(sessionId: string, text: string): Promise<'ok' | 'queued'>
  /** 取消指定会话并取回尚未消费的排队消息（对齐 pi 的 Escape 行为），供回填输入框 */
  cancel(sessionId: string): Promise<string[]>
  compact(sessionId: string): Promise<'ok' | 'busy'>
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>
  /** 事件订阅：信封携带 sessionId，renderer 按会话路由 */
  onEvent(cb: (e: AddressedEvent) => void): () => void
  /** 在指定项目下新建会话 */
  newSession(projectPath: string): Promise<string>
  listSessions(projectPath: string): Promise<SessionMeta[]>
  /** 加载会话活动路径的消息（renderer hydrate；不切换任何主进程状态） */
  loadSession(id: string): Promise<SessionLoadResult>
  /** 会话全文检索（跨项目；sessionIds 省略 = 全部会话） */
  searchSessions(query: string, opts?: { sessionIds?: string[]; limit?: number }): Promise<SessionSearchHit[]>
  /** 删除会话（并行运行不阻塞；main 同时清理 worktree 与运行实例） */
  deleteSession(id: string): Promise<'ok' | 'not-found'>
  /** 会话权限模式（持久化到 meta，并即时作用于运行中实例） */
  setSessionMode(id: string, mode: PermissionMode): Promise<void>
  /** 会话级模型切换（持久化 meta.model；该会话下一次 prompt 生效，上下文窗口按该模型目录定义解析；不影响其他会话） */
  setSessionModel(id: string, model: string): Promise<SessionMeta | null>
  /** 重命名会话（落盘 meta；ensureTitle 只对默认标题生效，不会覆盖手动命名） */
  renameSession(id: string, title: string): Promise<SessionMeta | null>
  /** 归档/取消归档（rail 分组展示） */
  setSessionArchived(id: string, archived: boolean): Promise<SessionMeta | null>
  /** 重锚会话工作目录：切换 meta.projectPath，文件树/工具/git 即时跟随 */
  setSessionProject(id: string, projectPath: string): Promise<SessionMeta | null>
  /** 会话内文件改动清单 + 逐文件 unified diff */
  diffGet(id: string): Promise<DiffResult>
  diffSummary(id: string): Promise<DiffSummary | null>
  /** 上下文明细：逐条消息的 token 估算与占比 */
  contextBreakdown(sessionId: string): Promise<ContextBreakdown>
  /** 把工作区内文件内容直接注入会话上下文（追加进系统提示词，注入去重） */
  injectFile(sessionId: string, rel: string): Promise<'ok' | 'not-found'>
  /** 保存会话附件（base64）到 <ws>/.navagent/attachments/，返回工作区相对路径 */
  saveAttachment(sessionId: string, name: string, dataB64: string): Promise<{ ok: boolean; path?: string; error?: string }>
  /** 移除已注入上下文的文件 */
  uninjectFile(sessionId: string, rel: string): Promise<'ok' | 'not-found'>
  /** 当前会话已注入上下文的文件清单 */
  listInjectedFiles(sessionId: string): Promise<string[]>
  /** 工作区内相对路径 → 绝对路径 */
  absPath(sessionId: string, rel: string): Promise<string>
  /** 当前项目/会话工作区的 git 分支（非 git 目录返回空） */
  gitBranches(sessionId: string): Promise<{ current: string | null; branches: string[] }>
  /** 会话工作区的 git 状态（Source Control 面板数据；非 git 目录返回空分组） */
  gitStatus(sessionId: string): Promise<GitStatusResult>
  /** 切换到指定分支；脏工作区冲突时 ok=false 并带 message */
  gitSwitch(sessionId: string, branch: string): Promise<{ ok: boolean; message?: string }>
  /** 新增/覆盖自定义供应商（写 userData/models.json 并热重载）；返回刷新后的合并目录 */
  saveCustomProvider(input: CustomProviderInput): Promise<CustomProviderWriteResult>
  /** 删除自定义供应商（从 models.json 移除并热重载） */
  deleteCustomProvider(id: string): Promise<CustomProviderWriteResult>
  /** 用 Base URL + API Key 探测端点可用模型清单（GET /models）；protocolUsed = 实际成功的协议（回退后与请求不同） */
  probeModels(input: { baseUrl: string; protocol: 'anthropic' | 'openai-compat'; apiKey?: string; providerId?: string }): Promise<{ ok: boolean; models: string[]; error?: string; protocolUsed?: 'anthropic' | 'openai-compat' }>
  readFile(sessionId: string, rel: string): Promise<FileReadResult>
  /** 会话工作区内目录列举（懒加载文件树；隐藏目录与 node_modules 等噪声已过滤） */
  listDir(sessionId: string, path: string): Promise<DirEntry[]>
  writeFile(sessionId: string, rel: string, content: string, baseMtime?: number): Promise<FileWriteResult>
  /** 会话工作区内 glob 搜索，返回相对路径（≤200 条；@mention 与搜索共用） */
  globFiles(sessionId: string, pattern: string): Promise<string[]>
  /** 在系统资源管理器中显示文件（限会话工作区内） */
  revealPath(sessionId: string, rel: string): Promise<void>
  /** 当前会话的树节点列表 */
  listTree(id: string): Promise<SessionTreeNode[]>
  /** 切换活动叶子（跳转续跑/改写重发的基础）；nodeId=null 清空活动路径（根消息改写重发）。summarize=为被离开路径生成分支摘要。该会话运行中返回 busy */
  switchLeaf(id: string, nodeId: string | null, summarize: boolean): Promise<TreeSummaryResult | 'busy'>
  /** 从指定节点派生新会话文件（祖先链复制，保留节点 id）；源会话运行中返回 null 并发 notice */
  forkSession(id: string, nodeId: string): Promise<string | null>
  /** 复制指定会话的活动分支为新会话；运行中返回 null */
  cloneSession(id: string): Promise<string | null>
  /** 全量工具清单（builtin + 扩展）及启用状态 */
  listTools(): Promise<ToolInfo[]>
  setToolEnabled(name: string, enabled: boolean): Promise<void>
  reloadExtensions(): Promise<ReloadResult>
  /** 已加载扩展清单（manifest 元数据 + 工具/命令计数 + 加载错误） */
  listExtensions(): Promise<ExtensionInfo[]>
  /** MCP 服务：状态清单（ready/error/disabled + 工具数）与当前配置 */
  mcpList(): Promise<{ statuses: McpServerStatus[]; config: McpConfig }>
  /** 新增/覆盖 MCP 服务器（写 userData/mcp.json 并刷新工具） */
  mcpSave(name: string, def: McpServerDef): Promise<{ ok: boolean; error?: string; id?: string }>
  /** 删除 MCP 服务器并停进程 */
  mcpRemove(name: string): Promise<'ok'>
  /** 启停 MCP 服务器（禁用即停进程） */
  mcpSetEnabled(name: string, enabled: boolean): Promise<'ok'>
  /** 选择文件夹安装到全局扩展目录；用户取消返回 ok:false + cancel 标记 */
  installExtension(): Promise<ExtensionOpResult>
  /** 删除扩展（仅全局目录可删） */
  removeExtension(id: string): Promise<ExtensionOpResult>
  /** 启停扩展（禁用的扩展 loader 跳过加载） */
  setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionInfo[]>
  /** 扩展注册的斜杠命令 */
  listCommands(): Promise<CommandInfo[]>
  /** 扩展面板桥：面板 GUI → main 侧该扩展的 onMessage（op 白名单由扩展自管） */
  panelInvoke(panelId: string, op: string, params?: Record<string, unknown>): Promise<unknown>
  /** 关闭扩展面板（renderer 关闭钮；main 侧同步收到 panel_close 释放） */
  panelClose(panelId: string): Promise<void>
  /**
   * 斜杠命令统一分发（作用于指定会话）：/compact → 压缩；扩展命令 → 执行并 notice；
   * prompt 模板（.navagent/prompts 等）→ 展开后作为新 prompt 发送（运行中转 steer）。
   * 未知命令返回 unknown（notice 已在主进程发出）。
   */
  dispatchCommand(sessionId: string, name: string, args: string): Promise<'ok' | 'unknown'>
  /** 信任当前工作区（持久化） */
  trustProject(): Promise<void>
  /** 仅本次信任当前工作区（不落盘） */
  trustProjectOnce(): Promise<void>
  /** 导出会话（jsonl 原样 / html 快照）；返回落盘路径，取消返回 null */
  exportSession(id: string, format: 'jsonl' | 'html'): Promise<string | null>
  /** 选择 JSONL 文件导入为新会话（落入当前默认项目）；返回新会话 id，取消返回 null */
  importSession(): Promise<string | null>
  /** 扩展弹窗应答（confirm=boolean；input/select=string|null；取消=null） */
  respondUi(requestId: string, value: string | boolean | null): Promise<void>
  /** 为指定会话新建终端（PTY，cwd=会话工作区）；失败返回 null（spawn 错误编码进返回值） */
  ptyCreate(sessionId: string): Promise<string | null>
  /** 会话现存的 PTY id 清单（打开终端面板时认领预热好的终端，点击即得） */
  ptyList(sessionId: string): Promise<string[]>
  /** 取回 PTY 环形缓冲（pane 关闭期间输出不丢） */
  ptyReplay(id: string): Promise<string>
  ptyWrite(id: string, data: string): Promise<void>
  ptyResize(id: string, cols: number, rows: number): Promise<void>
  ptyKill(id: string): Promise<void>
  /** 向会话的终端写入一行命令并回车执行（无存活终端时自动创建；web 预览返回 no-terminal） */
  ptyRunCommand(sessionId: string, command: string): Promise<'ok' | 'no-terminal'>
  /** UI 事件订阅（PTY 等）；返回解绑函数 */
  onUiEvent(cb: (e: UiEvent) => void): () => void
  // ── 供应商凭据与目录（对齐 pi 的 auth.json + models.json）──
  /** 合并目录快照：内置预设/模型 + models.json 自定义（值不落 renderer 持久层） */
  listCatalog(): Promise<CatalogSnapshot>
  /** 各厂商凭据状态与解析来源（不含明文 key） */
  listCredentials(): Promise<CredentialInfo[]>
  /** 保存某厂商 API key 到 userData/auth.json（值语法可用：$ENV、!command、$$） */
  saveCredential(providerId: string, key: string): Promise<void>
  /** 清除某厂商已存凭据 */
  clearCredential(providerId: string): Promise<void>
  /** 模型切换悬浮窗数据源：本地已知模型（models.json 各供应商清单 + 当前模型），零网络；实时列表用设置页探测 */
  listModels(): Promise<ModelListResult>
}

/** 凭据解析来源：config=设置手填覆盖 / auth.json / env:变量名 / provider-definition=models.json 内联 */
export interface CredentialInfo {
  id: string
  label: string
  stored: boolean
  source: string | null
}

/** 模型列表条目（listModels 返回；live 保留给实时探测结果，本地清单恒为 false） */
export interface ModelEntry {
  id: string
  live: boolean
}

export interface ModelListResult {
  models: ModelEntry[]
  /** 拉取失败原因（此时 models 为目录兜底列表） */
  error?: string
}

export interface CatalogSnapshot {
  models: import('./model-catalog').CatalogModel[]
  /** models.json 自定义供应商全量（设置 UI 编辑用；不含明文 key，仅 hasInlineKey 标记） */
  customs?: CustomProviderFull[]
}

/** 自定义供应商完整定义（编辑表单数据源；协议字段与 CustomProvider 一致） */
export interface CustomProviderFull {
  id: string
  name: string
  protocol: 'anthropic' | 'openai-compat'
  baseUrl: string
  /** models.json 内联 apiKey 是否存在 */
  hasInlineKey: boolean
  /** 内联 apiKey 原文（$ENV / !command 值语法不解析原样下发；设置表单回显用） */
  apiKeyValue?: string
  models: { id: string; reasoning: boolean; contextWindow: number }[]
}

/** 设置 UI 提交的自定义供应商（新增/覆盖） */
export interface CustomModelInput {
  id: string
  reasoning?: boolean
  contextWindow?: number
  inputPrice?: number
  outputPrice?: number
}

export interface CustomProviderInput {
  /** 缺省时由名称生成 slug；与已有 id 相同则覆盖 */
  id?: string
  name: string
  protocol: 'anthropic' | 'openai-compat'
  baseUrl: string
  /** undefined=保留原内联值；''=清除；非空=写入（支持 $ENV / !command 值语法） */
  apiKey?: string
  models: CustomModelInput[]
}

export interface CustomProviderWriteResult {
  ok: boolean
  error?: string
  snapshot?: CatalogSnapshot
  /** 保存成功时返回最终 id（新增时由名称派生） */
  id?: string
}

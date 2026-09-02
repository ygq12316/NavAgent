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
  | { role: 'user'; content: string | (TextContent | ImageContent)[] }
  | {
      role: 'assistant'
      content: (TextContent | ThinkingContent)[]
      toolCalls: ToolCall[]
      usage?: Usage
      stopReason: StopReason
      errorMessage?: string
      /** 产生本消息的模型：thinking 签名只对同模型有效，跨模型清洗据此降级 */
      model?: string
    }
  | { role: 'tool_result'; callId: string; toolName: string; content: string; isError: boolean }

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

export type PermissionDecision = 'approve' | 'deny' | 'always'

export interface SessionMeta {
  id: string
  projectPath: string
  title: string
  createdAt: number
  updatedAt: number
  model: string
  /** 会话树活动叶子（旧格式会话迁移前为空） */
  leafId?: string
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

export interface TreeSummaryResult {
  summaryInjected: boolean
}

/** 工具清单条目（设置面板用） */
export interface ToolInfo {
  name: string
  source: 'builtin' | 'extension'
  mutating: boolean
  enabled: boolean
}

export interface CommandInfo {
  name: string
  description: string
}

export interface ReloadResult {
  tools: number
  commands: number
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
  /** 已信任的工作区（信任后才加载项目级扩展） */
  trustedProjects: string[]
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

/** preload 桥与 mock 共同实现的窄接口（设计方案 4.6） */
export interface NavAgentApi {
  getConfig(): Promise<ApiConfig>
  setConfig(partial: Partial<ApiConfig>): Promise<ApiConfig>
  pickWorkspace(): Promise<string | null>
  send(text: string, images?: ImageContent[]): Promise<'ok' | 'busy'>
  /** 运行中插话：注入 steering 队列，在下一个工具批次结束后被模型看到（空文本返回 busy） */
  steer(text: string): Promise<'ok' | 'queued' | 'busy'>
  /** 运行中排队续跑（pi 的 Alt+Enter）：本轮 agent 结束后自动作为新 prompt 运行（空文本返回 busy） */
  followUp(text: string): Promise<'ok' | 'queued' | 'busy'>
  /** 取消并取回尚未消费的排队消息（对齐 pi 的 Escape 行为），供回填输入框 */
  cancel(): Promise<string[]>
  compact(): Promise<'ok' | 'busy'>
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>
  onEvent(cb: (e: AgentEvent) => void): () => void
  newSession(): Promise<string>
  listSessions(projectPath: string): Promise<SessionMeta[]>
  switchSession(id: string): Promise<void>
  /** 删除会话；当前会话运行中返回 busy（IPC 层保证），删除当前会话时自动切到列表第一个会话并重放 */
  deleteSession(id: string): Promise<'ok' | 'busy' | 'not-found'>
  listDir(path: string): Promise<DirEntry[]>
  /** 读工作区文件（文本；>1MB 截断 truncated=true；二进制返回 error） */
  readFile(rel: string): Promise<FileReadResult>
  /** 写工作区文件；baseMtime 缺省 = 强制覆盖；外部已改返回 conflict */
  writeFile(rel: string, content: string, baseMtime?: number): Promise<FileWriteResult>
  /** 工作区内 glob 搜索，返回相对路径（≤200 条） */
  globFiles(pattern: string): Promise<string[]>
  /** 系统文件选择器（限工作区内文件），取消返回 null */
  pickFile(): Promise<string | null>
  /** 当前会话的树节点列表 */
  listTree(id: string): Promise<SessionTreeNode[]>
  /** 切换活动叶子（跳转续跑/改写重发的基础）；summarize=为被离开路径生成分支摘要 */
  switchLeaf(id: string, nodeId: string, summarize: boolean): Promise<TreeSummaryResult>
  /** 从指定节点派生新会话文件（祖先链复制，保留节点 id） */
  forkSession(id: string, nodeId: string): Promise<string>
  /** 复制当前活动分支为新会话文件 */
  cloneSession(id: string): Promise<string>
  /** 全量工具清单（builtin + 扩展）及启用状态 */
  listTools(): Promise<ToolInfo[]>
  setToolEnabled(name: string, enabled: boolean): Promise<void>
  reloadExtensions(): Promise<ReloadResult>
  /** 扩展注册的斜杠命令 */
  listCommands(): Promise<CommandInfo[]>
  /**
   * 斜杠命令统一分发：/compact → 压缩；扩展命令 → 执行并 notice；
   * prompt 模板（.navagent/prompts 等）→ 展开后作为新 prompt 发送（运行中转 steer）。
   * 未知命令返回 unknown（notice 已在主进程发出）。
   */
  dispatchCommand(name: string, args: string): Promise<'ok' | 'unknown'>
  /** 信任当前工作区（持久化） */
  trustProject(): Promise<void>
  /** 仅本次信任当前工作区（不落盘） */
  trustProjectOnce(): Promise<void>
  /** 导出会话（jsonl 原样 / html 快照）；返回落盘路径，取消返回 null */
  exportSession(id: string, format: 'jsonl' | 'html'): Promise<string | null>
  /** 选择 JSONL 文件导入为新会话；返回新会话 id，取消返回 null */
  importSession(): Promise<string | null>
}

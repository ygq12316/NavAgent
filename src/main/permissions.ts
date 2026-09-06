import type { BeforeToolCallContext, BeforeToolCallResult } from './agent/engine-types'
import type { AgentEvent, PermissionMode } from '@shared/types'

type Decision = 'approve' | 'deny' | 'always'

interface Pending {
  toolName: string
  resolve: (d: Decision) => void
}

/**
 * L0 审批（对齐 pi 的 beforeToolCall 钩子策略）：GUI 弹卡；"always" 记入会话级白名单。
 * 每会话一份实例（并行会话互不串扰）。权限模式：
 * - manual：逐工具审批（现状）
 * - acceptEdits：文件编辑类工具（autoApprovable 集合）自动放行，bash 等照常审批
 * - bypassPermissions：一切工具自动放行（危险模式，UI 用警示色标识）
 * - plan：由 Agent.adaptTools 剔除写类工具实现（本类不参与）
 */
export class PermissionManager {
  private sessionAllowed = new Set<string>()
  private pending = new Map<string, Pending>()
  private seq = 0
  private approvalDetail: ((toolName: string, args: Record<string, unknown>) => string | null) | null = null
  private mode: PermissionMode = 'manual'
  private autoApprovable = new Set<string>()

  constructor(private emit: (e: AgentEvent) => void) {}

  /** 注入"哪些调用需要审批"的判定（wiring 用 registry 的 requiresApproval 实现） */
  setApprovalResolver(fn: (toolName: string, args: Record<string, unknown>) => string | null): void {
    this.approvalDetail = fn
  }

  /** 切换权限模式（setSessionMode 即时生效于运行中实例） */
  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  getMode(): PermissionMode {
    return this.mode
  }

  /** acceptEdits 下自动放行的工具集合（wiring 注入：write_file/edit_file） */
  setAutoApprovable(names: string[]): void {
    this.autoApprovable = new Set(names)
  }

  /** 引擎 beforeToolCall 钩子实现：需要审批则挂起等待用户决定 */
  async beforeToolCall(ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
    // bypass：一律放行（含 bash 等危险工具，UI 以警示色呈现该模式）
    if (this.mode === 'bypassPermissions') return undefined
    const detail = this.approvalDetail?.(ctx.toolCall.name, ctx.args) ?? null
    if (!detail) return undefined
    if (this.mode === 'acceptEdits' && this.autoApprovable.has(ctx.toolCall.name)) return undefined
    const decision = await this.request(ctx.toolCall.name, detail)
    if (decision === 'deny') return { block: true, reason: '用户拒绝了该操作' }
    return undefined
  }

  request(toolName: string, detail: string): Promise<Decision> {
    if (this.sessionAllowed.has(toolName)) return Promise.resolve('approve')
    const requestId = `perm_${++this.seq}`
    this.emit({ type: 'permission_request', requestId, toolName, detail })
    return new Promise((resolve) => {
      this.pending.set(requestId, { toolName, resolve })
    })
  }

  /** 处理审批决定；返回是否命中本管理器的 pending（SessionManager 路由用） */
  respond(requestId: string, decision: Decision): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    if (decision === 'always') this.sessionAllowed.add(entry.toolName)
    entry.resolve(decision === 'always' ? 'approve' : decision)
    return true
  }

  cancelAll(): void {
    for (const entry of this.pending.values()) entry.resolve('deny')
    this.pending.clear()
  }

  reset(): void {
    this.cancelAll()
    this.sessionAllowed.clear()
  }
}

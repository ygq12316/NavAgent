import type { Agent } from './agent'
import type { PermissionManager } from '../permissions'

/**
 * 会话注册表：并行会话的核心。sessionId → 运行时条目（Agent 实例 + 专属 PermissionManager）。
 * Agent 实例在会话首次 prompt 时惰性创建（transcript/双队列/abort 天然每实例一份）；
 * 事件持久化与广播不经过这里（index.ts 的 emitFor 闭包按会话绑定）。
 */
export interface SessionEntry {
  agent: Agent
  pm: PermissionManager
  /** 扩展生命周期（index.ts buildSession 注入）：start=首个交互前触发一次；end=删除/退出时触发（once 语义） */
  ext?: {
    start(): Promise<void>
    end(reason: 'delete' | 'quit'): Promise<void>
  }
  /** 扩展 GUI 交互原语的挂起-应答（ctx.ui；index.ts buildSession 注入） */
  uirm?: import('../extensions/ui-requests').UiRequestManager
  /** 会话扩展 ctx 工厂（index.ts buildSession 注入）：面板桥 invoke 与命令分发按此取 ctx */
  extCtx?: (signal?: AbortSignal) => import('../extensions/types').ExtensionContext
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>()

  /** 取会话条目，缺则用工厂创建（工厂由 index.ts 装配：emit/PM/workspace 均按会话绑定） */
  ensure(sessionId: string, factory: (sessionId: string) => SessionEntry): SessionEntry {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = factory(sessionId)
      this.sessions.set(sessionId, entry)
    }
    return entry
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId)
  }

  /** 全部会话条目（app 退出时批量派发 session_end 用） */
  all(): SessionEntry[] {
    return [...this.sessions.values()]
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.agent.running ?? false
  }

  /** 会话删除：abort 该会话全部 pending 审批与 UI 弹窗后丢弃实例（PTY 与会话无关，另行管理） */
  drop(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.agent.abort()
    entry.uirm?.cancelAll()
    this.sessions.delete(sessionId)
  }

  /** requestId → 持有它的 PermissionManager（审批卡片无会话前缀，靠全局唯一 requestId 路由） */
  routePermission(requestId: string, decision: 'approve' | 'deny' | 'always'): boolean {
    for (const entry of this.sessions.values()) {
      if (entry.pm.respond(requestId, decision)) return true
    }
    return false
  }

  /** requestId → 持有它的 UiRequestManager（扩展弹窗同样全局 requestId 路由） */
  routeUi(requestId: string, value: string | boolean | null): boolean {
    for (const entry of this.sessions.values()) {
      if (entry.uirm?.respond(requestId, value)) return true
    }
    return false
  }
}

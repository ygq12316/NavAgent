import type { AgentEvent } from '@shared/types'

/**
 * 扩展 GUI 交互原语（ctx.ui）的挂起-应答管理器。
 * 模式复制 PermissionManager：request 生成全局唯一 requestId + pending Map + emit ui_request 事件，
 * renderer 弹窗应答后 respond resolve；会话 abort/删除 → cancelAll 全部以取消值收口（confirm=false，其余=null）。
 */

export type UiKind = 'confirm' | 'input' | 'select'

export interface UiSpec {
  kind: UiKind
  title: string
  message?: string
  placeholder?: string
  /** select 的选项（kind=select 必填） */
  options?: string[]
}

export type UiValue = string | boolean | null

interface PendingEntry {
  kind: UiKind
  resolve: (value: UiValue) => void
  cleanup?: () => void
}

export class UiRequestManager {
  private seq = 0
  private pending = new Map<string, PendingEntry>()

  /** 发起 UI 请求并挂起；signal abort / cancelAll / respond 三路竞态，先到先得 */
  request(spec: UiSpec, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<UiValue> {
    const requestId = `ui_${++this.seq}`
    emit({
      type: 'ui_request',
      requestId,
      kind: spec.kind,
      title: spec.title,
      ...(spec.message !== undefined ? { message: spec.message } : {}),
      ...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {}),
      ...(spec.options !== undefined ? { options: spec.options } : {})
    })
    return new Promise<UiValue>((resolve) => {
      if (signal?.aborted) {
        resolve(this.cancelValue(spec.kind))
        return
      }
      const entry: PendingEntry = {
        kind: spec.kind,
        resolve,
        cleanup: signal ? () => signal.removeEventListener('abort', onAbort) : undefined
      }
      const onAbort = (): void => {
        this.pending.delete(requestId)
        resolve(this.cancelValue(spec.kind))
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, entry)
    })
  }

  /** renderer 应答；requestId 未命中（已取消/已应答）返回 false */
  respond(requestId: string, value: UiValue): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    entry.cleanup?.()
    entry.resolve(value)
    return true
  }

  /** 会话 abort/删除：全部以取消值收口 */
  cancelAll(): void {
    for (const entry of this.pending.values()) {
      entry.cleanup?.()
      entry.resolve(this.cancelValue(entry.kind))
    }
    this.pending.clear()
  }

  private cancelValue(kind: UiKind): UiValue {
    return kind === 'confirm' ? false : null
  }
}
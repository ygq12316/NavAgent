import type { AgentEvent } from '@shared/types'
import type { ExtensionContext, PanelHandle, PanelMessageHandlers, PanelSpec } from './types'

/**
 * 扩展面板管理器（挂起-应答/广播模式同 UiRequestManager）：
 * open 生成唯一 panelId 并广播 panel_open（renderer 挂沙箱 iframe 宿主）；
 * 面板 GUI 经 panel:invoke 桥到达时按面板路由到该扩展的 onMessage（ctx 由归属会话注入）；
 * push/close 反向广播。扩展重载时 closeAll 统一收口（旧 handler 随模块失效）。
 */
export interface PanelEntry {
  extId: string
  sessionId: string
  handlers?: PanelMessageHandlers
}

export class PanelManager {
  private seq = 0
  private panels = new Map<string, PanelEntry>()

  constructor(
    private emit: (sessionId: string, event: AgentEvent) => void,
    private ctxFor: (sessionId: string) => ExtensionContext | undefined
  ) {}

  open(extId: string, sessionId: string, spec: PanelSpec, handlers?: PanelMessageHandlers): PanelHandle {
    const panelId = `panel_${++this.seq}`
    this.panels.set(panelId, { extId, sessionId, handlers })
    this.emit(sessionId, {
      type: 'panel_open',
      panelId,
      extId,
      sessionId,
      title: spec.title,
      entry: spec.entry,
      ...(spec.width !== undefined ? { width: spec.width } : {}),
      ...(spec.height !== undefined ? { height: spec.height } : {})
    })
    return {
      push: (payload: unknown) => {
        if (this.panels.has(panelId)) this.emit(sessionId, { type: 'panel_push', panelId, payload })
      },
      close: () => this.close(panelId)
    }
  }

  /** 面板 GUI 桥调用：路由到本扩展 onMessage，注入归属会话 ctx；未注册 onMessage 返回 null */
  async invoke(panelId: string, op: string, params: Record<string, unknown>): Promise<unknown> {
    const entry = this.panels.get(panelId)
    if (!entry) throw new Error('面板不存在或已关闭')
    if (typeof op !== 'string' || op.length === 0 || op.length > 64) throw new Error('非法 op')
    const ctx = this.ctxFor(entry.sessionId)
    if (!ctx) throw new Error('面板所属会话未就绪或已关闭')
    return (await entry.handlers?.onMessage?.(op, params ?? {}, ctx)) ?? null
  }

  close(panelId: string): void {
    const entry = this.panels.get(panelId)
    if (!entry) return
    this.panels.delete(panelId)
    this.emit(entry.sessionId, { type: 'panel_close', panelId })
  }

  /** 扩展重载/应用退出：全部收口（renderer 卸载宿主） */
  closeAll(): void {
    for (const panelId of [...this.panels.keys()]) this.close(panelId)
  }
}

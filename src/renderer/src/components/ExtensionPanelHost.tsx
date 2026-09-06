import { useEffect, useRef, useState } from 'react'
import { getApi } from '../api'
import type { AgentEvent } from '@shared/types'

interface PanelVm {
  panelId: string
  extId: string
  sessionId: string
  title: string
  entry: string
  width?: number
  height?: number
}

/**
 * 扩展面板宿主：panel_open/panel_close 事件驱动挂载/卸载。
 * iframe sandbox="allow-scripts"（无 same-origin，硬隔离）加载 navagent-ext:// 只读资源；
 * 桥：面板 postMessage invoke → panelInvoke IPC → main 侧该扩展 onMessage → 结果/推送回面板。
 * 面板内 switchLeaf/fork 成功后回调 onNavigated（宿主重载 transcript / 切到派生的新会话）。
 */
export function ExtensionPanelHost({ onNavigated }: { onNavigated: (sessionId: string) => void }): null | React.JSX.Element {
  const [panels, setPanels] = useState<PanelVm[]>([])
  const panelsRef = useRef(panels)
  panelsRef.current = panels
  const frames = useRef(new Map<string, HTMLIFrameElement>())

  useEffect(() => {
    return getApi().onEvent((payload: { sessionId: string; event: AgentEvent }) => {
      const e = payload.event
      if (e.type === 'panel_open') {
        // 同扩展同会话只保留一个面板：重开即刷新
        setPanels((prev) => [...prev.filter((p) => !(p.extId === e.extId && p.sessionId === e.sessionId)), { ...e }])
      } else if (e.type === 'panel_close') {
        setPanels((prev) => prev.filter((p) => p.panelId !== e.panelId))
        frames.current.delete(e.panelId)
      } else if (e.type === 'panel_push') {
        frames.current.get(e.panelId)?.contentWindow?.postMessage(
          { __navagentPanel: e.panelId, kind: 'push', payload: e.payload },
          '*'
        )
      }
    })
  }, [])

  // 主题变化 → 推送到所有面板（面板内 CSS 变量跟随切换）
  useEffect(() => {
    const pushTheme = (): void => {
      const theme = document.documentElement.dataset.theme ?? 'dark'
      for (const [panelId, frame] of frames.current) {
        frame.contentWindow?.postMessage({ __navagentPanel: panelId, kind: 'theme', theme }, '*')
      }
    }
    const observer = new MutationObserver(pushTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onMessage = (ev: MessageEvent): void => {
      const d = ev.data as
        | { __navagentPanel?: unknown; kind?: unknown; reqId?: unknown; op?: unknown; params?: unknown }
        | null
      if (!d || typeof d.__navagentPanel !== 'string' || d.kind !== 'invoke') return
      const panelId = d.__navagentPanel
      console.debug('[panel-host] invoke 到达', panelId, d.op)
      const panel = panelsRef.current.find((p) => p.panelId === panelId)
      const reply = (msg: Record<string, unknown>): void => {
        const win = frames.current.get(panelId)?.contentWindow
        if (!win) console.warn('[panel-host] 回复失败：iframe ref 不存在', panelId)
        else win.postMessage({ __navagentPanel: panelId, ...msg }, '*')
      }
      getApi()
        .panelInvoke(panelId, String(d.op ?? ''), (d.params && typeof d.params === 'object' ? d.params : {}) as Record<string, unknown>)
        .then((result) => {
          console.debug('[panel-host] invoke 成功', panelId, d.op)
          // 面板触发的导航：跳转分支 / 打开会话 / 分支派生的新会话 → 宿主重载 transcript
          if (panel && d.op === 'switchLeaf') onNavigated(panel.sessionId)
          if (typeof result === 'string' && result && (d.op === 'fork' || d.op === 'open' || d.op === 'branch')) onNavigated(result)
          return result
        })
        .then((result) => reply({ kind: 'result', reqId: d.reqId, ok: true, result }))
        .catch((err) => {
          console.warn('[panel-host] invoke 失败', panelId, d.op, err)
          reply({ kind: 'result', reqId: d.reqId, ok: false, error: String(err instanceof Error ? err.message : err) })
        })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onNavigated])

  if (panels.length === 0) return null
  return (
    <div className="ext-panels">
      {panels.map((p) => (
        <div key={p.panelId} className="ext-panel" style={{ width: p.width ?? 520, height: p.height ?? 640 }}>
          <div className="ext-panel-head">
            <span className="ext-panel-title">{p.title}</span>
            <button className="ext-panel-close" onClick={() => void getApi().panelClose(p.panelId)} title="关闭面板">
              ✕
            </button>
          </div>
          <iframe
            ref={(el) => {
              if (el) frames.current.set(p.panelId, el)
              else frames.current.delete(p.panelId)
            }}
            className="ext-panel-frame"
            sandbox="allow-scripts"
            src={`navagent-ext://${p.extId}/${p.entry}?__panel=${encodeURIComponent(p.panelId)}&theme=${document.documentElement.dataset.theme ?? 'dark'}&v=${p.panelId}`}
            title={p.title}
          />
        </div>
      ))}
    </div>
  )
}

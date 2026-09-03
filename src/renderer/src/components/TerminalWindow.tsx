import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getApi } from '../api'
import { IconPlus } from './icons'

interface Tab {
  id: string
  label: string
}

/** 单例窗口内多终端标签；inactive 标签保持挂载（display:none）以不丢滚动缓冲 */
export function TerminalWindow() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [spawnError, setSpawnError] = useState(false)
  const hosts = useRef(new Map<string, HTMLDivElement>())
  const terms = useRef(new Map<string, { term: Terminal; fit: FitAddon }>())
  const seq = useRef(0)

  const spawn = async (): Promise<void> => {
    const id = await getApi().ptyCreate()
    if (!id) {
      setSpawnError(true)
      return
    }
    setSpawnError(false)
    seq.current += 1
    setTabs((t) => [...t, { id, label: `pwsh ${seq.current}` }])
    setActive(id)
  }

  // 订阅 PTY 输出 → 写入对应 xterm（组件生命周期只挂一次）
  useEffect(() => {
    return getApi().onUiEvent((e) => {
      if (e.type === 'pty_data') terms.current.get(e.id)?.term.write(e.chunk)
      if (e.type === 'pty_exit') {
        terms.current.get(e.id)?.term.write(`\r\n\x1b[90m[进程已退出，exitCode=${e.exitCode}]\r\n`)
      }
    })
  }, [])

  // active 标签创建 xterm（每个 id 只建一次）
  useEffect(() => {
    if (!active) return
    const host = hosts.current.get(active)
    if (!host || terms.current.has(active)) return
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, monospace",
      fontSize: 12,
      convertEol: false,
      theme: {
        background: '#00000000',
        foreground: getComputedStyle(document.documentElement).getPropertyValue('--tx').trim() || '#33312c',
        cursor: '#2383e2'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    term.onData((data) => void getApi().ptyWrite(active, data))
    terms.current.set(active, { term, fit })
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void getApi().ptyResize(active, term.cols, term.rows)
      } catch {
        /* 容器已隐藏时跳过 */
      }
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tabs.length])

  const closeTab = (id: string) => {
    void getApi().ptyKill(id)
    terms.current.get(id)?.term.dispose()
    terms.current.delete(id)
    setTabs((t) => {
      const next = t.filter((x) => x.id !== id)
      if (active === id) setActive(next[next.length - 1]?.id ?? null)
      return next
    })
  }

  if (spawnError && tabs.length === 0) {
    return (
      <div className="term-notice">
        终端不可用（需要 Electron 环境 / PTY 启动失败）。
        <br />
        <button className="btn" onClick={() => void spawn()}>重试</button>
      </div>
    )
  }

  return (
    <>
      <div className="term-tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`term-tab${t.id === active ? ' on' : ''}`} onClick={() => setActive(t.id)}>
            <span>{t.label}</span>
            <button className="tab-close" title="关闭此终端" onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}>
              ✕
            </button>
          </div>
        ))}
        <button className="term-add" onClick={() => void spawn()} title="新建终端">
          <IconPlus size={13} />
        </button>
      </div>
      <div className="term-host">
        {tabs.map((t) => (
          <div
            key={t.id}
            ref={(el) => {
              if (el) hosts.current.set(t.id, el)
              else hosts.current.delete(t.id)
            }}
            className={`term-pane${t.id === active ? '' : ' off'}`}
          />
        ))}
        {tabs.length === 0 && <div className="term-notice">尚无终端</div>}
      </div>
      {/* 首次打开自动建一个终端 */}
      <AutoSpawnOnce onSpawn={() => void spawn()} hasTabs={tabs.length > 0} />
    </>
  )
}

function AutoSpawnOnce({ onSpawn, hasTabs }: { onSpawn: () => void; hasTabs: boolean }) {
  const done = useRef(false)
  useEffect(() => {
    if (!done.current && !hasTabs) {
      done.current = true
      onSpawn()
    }
    if (hasTabs) done.current = true
  }, [hasTabs, onSpawn])
  return null
}

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getApi } from '../api'
import { IconPlus } from './icons'

/** 终端配色（跟随 app 双主题）：不能用 getPropertyValue('--tx') —— CSS 变量读出来是 "var(--xxx)" 字面量，
 *  xterm 解析失败后回退到内置默认色，与主题脱节（浅色主题下看不清的根因）。直接给两套解析好的色值。 */
const TERM_THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#00000000',
    foreground: '#e6e9ef',
    cursor: '#7f9c8b',
    selectionBackground: 'rgba(127, 156, 139, 0.32)',
    black: '#151517',
    red: '#d87656',
    green: '#6cab6c',
    yellow: '#c9a15e',
    blue: '#6ba6c8',
    magenta: '#8b84c7',
    cyan: '#5aa0a0',
    white: '#e6e9ef',
    brightBlack: '#626a78',
    brightRed: '#e88b6d',
    brightGreen: '#85c285',
    brightYellow: '#ddb873',
    brightBlue: '#8fc0dd',
    brightMagenta: '#a49fe0',
    brightCyan: '#7cc4c4',
    brightWhite: '#f5f7fa'
  },
  light: {
    background: '#00000000',
    foreground: '#1b2230',
    cursor: '#3f6b52',
    selectionBackground: 'rgba(63, 107, 82, 0.25)',
    black: '#1b2230',
    red: '#c7442c',
    green: '#2e7d43',
    yellow: '#8a6a1f',
    blue: '#3d6e86',
    magenta: '#55509e',
    cyan: '#2f7f86',
    white: '#4a5262',
    brightBlack: '#6b7688',
    brightRed: '#d8603f',
    brightGreen: '#3f9457',
    brightYellow: '#a9852f',
    brightBlue: '#508ca8',
    brightMagenta: '#6f68b8',
    brightCyan: '#3f96a0',
    brightWhite: '#1b2230'
  }
}

const termTheme = (): ITheme => TERM_THEMES[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark']

interface Props {
  sessionId: string
  /** 存活的 PTY id（AppState.ptys；pane 重开后回放环形缓冲） */
  ptys: string[]
  onCreated: (id: string) => void
  onClosed: (id: string) => void
}

/** 会话内多终端标签（cwd = 会话工作区）；pane 关闭后 PTY 继续运行，重开时 ptyReplay 回放。
 *  agent 的 bash 命令也在这套 PTY 里执行——面板里能直接看到 agent 在跑什么。 */
export function TerminalWindow({ sessionId, ptys, onCreated, onClosed }: Props) {
  const [active, setActive] = useState<string | null>(null)
  const [spawnError, setSpawnError] = useState(false)
  // 自动创建超过 8 秒仍未成功 = 异常（正常 <2s）：给出明确的重试入口而不是无限等待
  const [stuckMs, setStuckMs] = useState(0)
  useEffect(() => {
    if (ptys.length > 0 || spawnError) return
    const t0 = Date.now()
    const iv = window.setInterval(() => setStuckMs(Date.now() - t0), 500)
    return () => window.clearInterval(iv)
  }, [ptys.length, spawnError])
  const stuck = !spawnError && ptys.length === 0 && stuckMs > 8000
  const hosts = useRef(new Map<string, HTMLDivElement>())
  const terms = useRef(new Map<string, { term: Terminal; fit: FitAddon }>())

  const spawn = async (): Promise<void> => {
    // invoke 可能 reject（channel 缺失/主进程异常）——吞掉会让 UI 永远停在"正在创建终端…"，必须落到错误态
    let id: string | null = null
    try {
      id = await getApi().ptyCreate(sessionId)
    } catch {
      id = null
    }
    if (!id) {
      setSpawnError(true)
      return
    }
    setSpawnError(false)
    onCreated(id)
    setActive(id)
  }

  // 打开面板即认领 main 侧预热好的终端（session:load 时已预创建）：tab 与回放内容点击即得
  const adoptedFor = useRef<string | null>(null)
  useEffect(() => {
    if (adoptedFor.current === sessionId) return
    adoptedFor.current = sessionId
    void getApi()
      .ptyList(sessionId)
      .then((ids) => {
        if (ids.length === 0) return
        for (const id of ids) if (!ptys.includes(id)) onCreated(id)
        setActive((cur) => cur ?? ids[0]!)
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 订阅本会话 PTY 输出（组件生命周期只挂一次）
  useEffect(() => {
    return getApi().onUiEvent((e) => {
      if (e.sessionId !== sessionId) return
      if (e.type === 'pty_data') terms.current.get(e.id)?.term.write(e.chunk)
      if (e.type === 'pty_exit') {
        terms.current.get(e.id)?.term.write(`\r\n\x1b[90m[进程已退出，exitCode=${e.exitCode}]\r\n`)
      }
    })
  }, [sessionId])

  // 主题切换热更新：已打开的终端跟随 app 双主题（<html data-theme> 是唯一事实源）
  useEffect(() => {
    const applyTheme = (): void => {
      const t = termTheme()
      for (const { term } of terms.current.values()) term.options.theme = t
    }
    const mo = new MutationObserver(applyTheme)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])

  // active 标签创建 xterm（每个 id 只建一次；重开回放环形缓冲）
  useEffect(() => {
    if (!active) return
    const host = hosts.current.get(active)
    if (!host || terms.current.has(active)) return
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, monospace",
      fontSize: 12,
      convertEol: false,
      theme: termTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    void getApi().ptyReplay(active).then((buf) => {
      if (buf) term.write(buf)
    })
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
  }, [active, ptys.length])

  const closeTab = (id: string) => {
    void getApi().ptyKill(id)
    terms.current.get(id)?.term.dispose()
    terms.current.delete(id)
    onClosed(id)
    setActive((cur) => (cur === id ? ptys.filter((x) => x !== id).at(-1) ?? null : cur))
  }

  // 换会话时清理本组件创建的 xterm 实例（PTY 不动）
  useEffect(() => {
    const map = terms.current
    return () => {
      for (const t of map.values()) t.term.dispose()
      map.clear()
    }
  }, [sessionId])

  return (
    <>
      <div className="term-tabs">
        {ptys.map((id, i) => (
          <div key={id} className={`term-tab${id === active ? ' on' : ''}`} onClick={() => setActive(id)}>
            <span>终端 {i + 1}</span>
            <button className="tab-close" title="关闭此终端" onClick={(e) => { e.stopPropagation(); closeTab(id) }}>
              ✕
            </button>
          </div>
        ))}
        <button className="term-add" onClick={() => void spawn()} title="新建终端">
          <IconPlus size={13} />
        </button>
      </div>
      <div className="term-host">
        {ptys.map((id) => (
          <div
            key={id}
            ref={(el) => {
              if (el) hosts.current.set(id, el)
              else hosts.current.delete(id)
            }}
            className={`term-pane${id === active ? '' : ' off'}`}
          />
        ))}
        {ptys.length === 0 && (
          <div className="term-notice">
            {spawnError ? '终端创建失败，请点击重试。' : stuck ? '终端创建超时——请完整重启应用（Ctrl+C 后重新 pnpm dev）。' : '正在创建终端…'}
            {(stuck || spawnError) && (
              <button className="btn" onClick={() => void spawn()}>重试</button>
            )}
          </div>
        )}
      </div>
      {/* 打开面板自动建一个终端（延迟 1.2s 避开启动期 conpty 竞态；主进程侧创建入口互斥） */}
      <AutoSpawnOnce onSpawn={() => void spawn()} hasTabs={ptys.length > 0} />
    </>
  )
}

function AutoSpawnOnce({ onSpawn, hasTabs }: { onSpawn: () => void; hasTabs: boolean }) {
  const done = useRef(false)
  const spawnRef = useRef(onSpawn)
  spawnRef.current = onSpawn
  // 认领/预热可能异步落地：触发瞬间重读最新 hasTabs，避免给已有 tab 的会话重复开终端
  const hasTabsRef = useRef(hasTabs)
  hasTabsRef.current = hasTabs
  useEffect(() => {
    if (hasTabsRef.current) {
      done.current = true
      return
    }
    const t = window.setTimeout(() => {
      if (!hasTabsRef.current && !done.current) {
        done.current = true
        spawnRef.current()
      }
    }, 1200)
    return () => window.clearTimeout(t)
  }, [])
  return null
}

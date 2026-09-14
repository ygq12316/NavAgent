import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolResult } from '../tools/registry'

/**
 * MCP（Model Context Protocol）over stdio：手写 JSON-RPC 2.0（R1：不引入官方 SDK）。
 * 配置 userData/mcp.json：{ "servers": { <name>: { command, args?, env?, enabled? } } }
 * 启用的服务器懒启动 → initialize 握手 → tools/list → 工具注册为 mcp_<server>_<tool>
 * （mutating，走审批门）；tools/call 执行。崩溃标记 error，下次 refresh 重试。
 * 协议：stdio 上按行分隔的 JSON-RPC 2.0（请求 {id,method,params} / 响应 {id,result|error} / 通知无 id）。
 */

export interface McpServerDef {
  command: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
}

export interface McpConfig {
  servers?: Record<string, McpServerDef>
}

export interface McpToolDef {
  server: string
  name: string
  description: string
  inputSchema: unknown
}

export type McpServerState = 'ready' | 'error' | 'disabled'

export interface McpServerStatus {
  name: string
  status: McpServerState
  error?: string
  tools?: number
  command?: string
}

const PROTOCOL_VERSION = '2024-11-05'
const REQ_TIMEOUT = 20_000

interface McpConn {
  child: ChildProcessWithoutNullStreams
  tools: McpToolDef[]
  status: McpServerState
  error?: string
  nextId: number
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  buffer: string
}

export function sanitizeMcpName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server'
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp_${sanitizeMcpName(server)}_${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export class McpHost {
  private conns = new Map<string, McpConn>()

  constructor(private userDataPath: string) {}

  configPath(): string {
    return join(this.userDataPath, 'mcp.json')
  }

  loadConfig(): McpConfig {
    try {
      const raw = JSON.parse(readFileSync(this.configPath(), 'utf-8')) as McpConfig
      return raw?.servers && typeof raw.servers === 'object' ? raw : { servers: {} }
    } catch {
      return { servers: {} }
    }
  }

  saveConfig(cfg: McpConfig): { ok: true } | { ok: false; error: string } {
    try {
      if (!existsSync(this.userDataPath)) return { ok: false, error: 'userData 不存在' }
      writeFileSync(this.configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  upsert(name: string, def: McpServerDef): { ok: true; id: string } | { ok: false; error: string } {
    const id = sanitizeMcpName(name)
    if (!id) return { ok: false, error: '名称无效' }
    if (!def.command?.trim()) return { ok: false, error: 'command 必填' }
    const cfg = this.loadConfig()
    cfg.servers = { ...(cfg.servers ?? {}), [id]: { ...def, command: def.command.trim() } }
    const w = this.saveConfig(cfg)
    return w.ok ? { ok: true, id } : w
  }

  remove(name: string): void {
    const cfg = this.loadConfig()
    if (cfg.servers && name in cfg.servers) {
      delete cfg.servers[name]
      this.saveConfig(cfg)
    }
    this.stop(name)
  }

  setEnabled(name: string, enabled: boolean): void {
    const cfg = this.loadConfig()
    const def = cfg.servers?.[name]
    if (!def) return
    cfg.servers![name] = { ...def, enabled }
    this.saveConfig(cfg)
    if (!enabled) this.stop(name)
  }

  /** 全量刷新：按配置启停所有服务器（并行），返回工具清单与状态 */
  async refresh(): Promise<{ tools: McpToolDef[]; statuses: McpServerStatus[] }> {
    const cfg = this.loadConfig()
    const names = Object.keys(cfg.servers ?? {})
    for (const name of [...this.conns.keys()]) if (!names.includes(name)) this.stop(name)
    const results = await Promise.all(
      names.map(async (name) => {
        const def = cfg.servers![name]!
        if (def.enabled === false) {
          this.stop(name)
          return { name, status: 'disabled' as const, tools: [] as McpToolDef[], command: def.command }
        }
        try {
          await this.ensure(name, def)
          const conn = this.conns.get(name)!
          return { name, status: conn.status as McpServerState, error: conn.error, tools: conn.tools, command: def.command }
        } catch (err) {
          return { name, status: 'error' as const, error: err instanceof Error ? err.message : String(err), tools: [] as McpToolDef[], command: def.command }
        }
      })
    )
    // tools/list 响应不带来源标识（server 是本端富化字段）——组装时回填，toRegistryTool 依赖它
    const tools = results.flatMap((r) => r.tools.map((t) => ({ ...t, server: r.name })))
    const statuses: McpServerStatus[] = results.map(({ name, status, error, tools: n, command }) => ({
      name,
      status,
      ...(error ? { error } : {}),
      tools: n.length,
      command
    }))
    return { tools, statuses }
  }

  /** 启动（必要时）并完成握手与工具发现；失败抛错（refresh 收集为 status.error） */
  async ensure(name: string, def: McpServerDef): Promise<void> {
    const existing = this.conns.get(name)
    if (existing && existing.status === 'ready') return
    if (existing) this.stop(name)
    const conn = await this.connect(name, def)
    this.conns.set(name, conn)
    conn.tools = (await this.request(conn, 'tools/list', {}, 15_000) as { tools?: McpToolDef[] }).tools ?? []
    conn.status = 'ready'
    // ready 后进程崩溃 → 标记 error（callTool 立即报不可用，下次 refresh 走重连）
    conn.child.once('exit', () => {
      if (this.conns.get(name) === conn && conn.status === 'ready') {
        conn.status = 'error'
        conn.error = '服务器进程意外退出'
      }
    })
  }

  /** MCP tools/call；文本 content 拼接为 ToolResult */
  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const conn = this.conns.get(server)
    if (!conn || conn.status !== 'ready') return { content: `（MCP 服务器 ${server} 不可用）`, isError: true }
    try {
      const res = (await this.request(conn, 'tools/call', { name: tool, arguments: args }, 120_000)) as {
        content?: { type?: string; text?: string }[]
        isError?: boolean
      }
      const text = (res.content ?? [])
        .filter((c) => c.type === 'text' || typeof c.text === 'string')
        .map((c) => c.text ?? '')
        .join('\n')
      return { content: text || '（MCP 工具无文本输出）', isError: res.isError === true }
    } catch (err) {
      return { content: `MCP 调用失败：${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  }

  stopAll(): void {
    for (const name of [...this.conns.keys()]) this.stop(name)
  }

  /** MCP 工具 → registry Tool：mcp_<server>_<tool>；mutating（走审批门），schema 直透 */
  toRegistryTool(server: string, t: McpToolDef): Tool<any> {
    return {
      name: mcpToolName(server, t.name),
      description: `[MCP:${server}] ${t.description || t.name}`,
      parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as Tool<any>['parameters'],
      mutating: true,
      requiresApproval: () => `MCP 工具：${server}/${t.name}`,
      execute: async (args: Record<string, unknown>) => this.callTool(server, t.name, args)
    }
  }

  private stop(name: string): void {
    const conn = this.conns.get(name)
    if (!conn) return
    this.conns.delete(name)
    try {
      const pid = conn.child.pid
      if (process.platform === 'win32' && pid) {
        // Windows：cmd 垫片（cmd /c npx）包着真实服务器进程，kill() 只杀壳——
        // 用 taskkill /T 杀整棵进程树，否则 node 服务器残留并锁住 cwd
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
      } else {
        conn.child.kill()
      }
    } catch {
      /* 已退出忽略 */
    }
  }

  private connect(name: string, def: McpServerDef): Promise<McpConn> {
    return new Promise((resolve, reject) => {
      // Windows：.exe 直接 spawn（路径带空格经 shell 会被截断——"C:\Program Files\..." 之痛）；
      // npx 等 .cmd/.bat 垫片必须经 cmd /s /c 解析（单行拼接，含空格的参数需自行加引号）
      const isWin = process.platform === 'win32'
      const cmd = def.command.trim()
      let file = cmd
      let argv: string[] = def.args ?? []
      if (isWin && !/\.(exe|com)$/i.test(cmd)) {
        file = process.env.ComSpec ?? 'cmd.exe'
        argv = ['/d', '/s', '/c', [cmd, ...argv].join(' ')]
      }
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(file, argv, {
          cwd: this.userDataPath,
          env: { ...process.env, ...(def.env ?? {}) } as Record<string, string>,
          windowsHide: true,
          ...(isWin ? { windowsVerbatimArguments: file !== cmd } : {})
        })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      const conn: McpConn = {
        child,
        tools: [],
        status: 'error',
        nextId: 0,
        pending: new Map(),
        buffer: ''
      }
      // spawn 失败（命令不存在等）以 error 事件表现：Reject 握手
      const bootTimeout = setTimeout(() => reject(new Error('MCP 服务器启动超时（20s 内未完成握手）')), REQ_TIMEOUT)
      const failBoot = (e: Error): void => {
        if (bootTimeout) {
          clearTimeout(bootTimeout)
          reject(e)
        }
      }
      child.on('error', (err) => failBoot(err instanceof Error ? err : new Error(String(err))))
      child.on('exit', (code) => failBoot(new Error(`MCP 服务器进程退出（code=${code ?? '?'}）`)))
      child.stdout.on('data', (d: Buffer) => {
        conn.buffer += d.toString()
        let idx: number
        while ((idx = conn.buffer.indexOf('\n')) >= 0) {
          const line = conn.buffer.slice(0, idx).trim()
          conn.buffer = conn.buffer.slice(idx + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string }; method?: string }
            if (msg.id !== undefined && conn.pending.has(msg.id)) {
              const p = conn.pending.get(msg.id)!
              conn.pending.delete(msg.id)
              if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP 错误'))
              else p.resolve(msg.result)
            }
          } catch {
            /* 非 JSON 行忽略 */
          }
        }
      })
      child.stderr.on('data', () => {
        /* 服务器 stderr：日志噪声，忽略 */
      })

      // 握手：initialize → initialized 通知 → resolve（tools/list 由 ensure 续做）
      this.request(conn, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'navAgent', version: '0.1.0' }
      })
        .then(() => {
          this.notify(conn, 'notifications/initialized')
          clearTimeout(bootTimeout)
          resolve(conn)
        })
        .catch((err: Error) => reject(err))
    })
  }

  private request(conn: McpConn, method: string, params: unknown, timeoutMs: number = REQ_TIMEOUT): Promise<unknown> {
    const id = ++conn.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id)
        reject(new Error(`MCP 请求超时：${method}`))
      }, timeoutMs)
      conn.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      conn.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  private notify(conn: McpConn, method: string): void {
    conn.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  }
}

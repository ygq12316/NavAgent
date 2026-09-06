import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { ExtensionInfo } from '@shared/types'
import type { Tool } from '../tools/registry'
import { createStateStore, noopStateStore } from './state'
import type { PanelManager } from './panels'
import type { ExtensionApi, ExtensionCommand, ExtensionHandlerEntry, ExtensionEventName, ExtensionHandlers, ExtensionScanSpec, LoadResult, PanelMessageHandlers, PanelSpec } from './types'

/**
 * 扩展加载器：扫描目录 → dynamic import → 调用 default(pi) 收集注册项。
 * 入口两种形态：扁平 *.js/.mjs 与子目录 <name>/index.mjs|js（目录优先，同名文件报冲突）。
 * 单文件失败只记录不上抛（一个坏扩展不阻塞其余加载）。
 * 安全：import 即任意代码执行——全局目录=用户本机自有；项目目录必须过信任门（调用侧保证 enabled）。
 * 事件：on(event, handler) 按全局事件表校验，订阅记录 extId 供状态归因与日志。
 * 状态：pi.state 按扩展绑定 userData/ext-state/<extId>.json（未传 stateDir 时仅内存）。
 */
export async function loadExtensions(
  specs: ExtensionScanSpec[],
  opts: { stateDir?: string; disabledIds?: string[]; panels?: PanelManager } = {}
): Promise<LoadResult> {
  const tools: LoadResult['tools'] = []
  const commands: ExtensionCommand[] = []
  const handlers: ExtensionHandlerEntry[] = []
  const errors: string[] = []
  const infos: ExtensionInfo[] = []
  const seenNames = new Set<string>()
  const disabled = new Set(opts.disabledIds ?? [])

  for (const spec of specs) {
    if (!spec.enabled || !existsSync(spec.dir)) continue
    // 收集扩展入口：扁平文件 + 子目录（目录优先，同名文件报冲突）
    type Entry = { id: string; path: string; label: string; manifestPath: string | null }
    const entries: Entry[] = []
    let names: string[] = []
    try {
      names = readdirSync(spec.dir, { withFileTypes: true })
        .map((d) => d.name)
        .filter((n) => !n.startsWith('.'))
    } catch {
      continue
    }
    const taken = new Set<string>()
    for (const n of names) {
      const full = join(spec.dir, n)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) continue
      const idx = existsSync(join(full, 'index.mjs')) ? 'index.mjs' : existsSync(join(full, 'index.js')) ? 'index.js' : null
      if (!idx) continue
      taken.add(n)
      entries.push({ id: n, path: join(full, idx), label: n + '/index', manifestPath: join(full, 'manifest.json') })
    }
    for (const n of names.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
      const id = n.replace(/\.(mjs|js)$/, '')
      if (taken.has(id)) {
        errors.push(`${n}: 与同名子目录扩展冲突，已忽略（目录优先）`)
        continue
      }
      taken.add(id)
      entries.push({ id, path: join(spec.dir, n), label: n, manifestPath: null })
    }

    for (const entryInfo of entries) {
      const full = entryInfo.path
      const extId = entryInfo.id
      const label = entryInfo.label
      const manifest = entryInfo.manifestPath ? readManifest(entryInfo.manifestPath) : null
      const baseInfo: ExtensionInfo = {
        id: extId,
        name: manifest?.name ?? extId,
        ...(manifest?.version ? { version: manifest.version } : {}),
        ...(manifest?.description ? { description: manifest.description } : {}),
        source: spec.source,
        tools: [],
        commands: [],
        disabled: disabled.has(extId)
      }
      if (baseInfo.disabled) {
        infos.push(baseInfo)
        continue
      }
      const state = opts.stateDir ? createStateStore(join(opts.stateDir, extId + '.json')) : noopStateStore()
      try {
        // cache-busting：同进程重载扩展必须绕过 ESM 模块缓存，否则 /reload 拿到的永远是首载代码
        const mod = (await import(pathToFileURL(full).href + '?t=' + Date.now())) as { default?: unknown } & Record<string, unknown>
        const entry = typeof mod === 'function' ? mod : mod.default
        if (typeof entry !== 'function') {
          throw new Error('模块需 default export 一个 function (pi)')
        }

        const registered: { tools: Tool<any>[]; commands: ExtensionCommand[]; handlers: ExtensionHandlerEntry[] } = {
          tools: [],
          commands: [],
          handlers: []
        }
        const api: ExtensionApi = {
          registerTool: (tool) => {
            if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') {
              throw new Error('registerTool 缺少 name/execute')
            }
            if (seenNames.has(tool.name)) throw new Error(`工具重名：${tool.name}`)
            seenNames.add(tool.name)
            registered.tools.push(tool)
          },
          registerCommand: (name, cmd) => {
            if (typeof name !== 'string' || !/^[a-z0-9_-]+$/.test(name)) throw new Error(`命令名非法：${name}`)
            if (typeof cmd?.handler !== 'function') throw new Error(`命令 ${name} 缺少 handler`)
            if (seenNames.has(name)) throw new Error(`与工具/命令重名：${name}`)
            seenNames.add(name)
            registered.commands.push({ name, description: cmd.description ?? '', handler: cmd.handler })
          },
          on: (event, handler) => {
            if (!(event in dummyHandlers())) throw new Error(`不支持的事件：${String(event)}（可用：${Object.keys(dummyHandlers()).join('/')}）`)
            if (typeof handler !== 'function') throw new Error('事件处理器必须是函数')
            registered.handlers.push({ event, extId, handler: handler as ExtensionHandlers[ExtensionEventName] })
          },
          state,
          openPanel: (spec: PanelSpec, handlers?: PanelMessageHandlers, sessionId?: string) => {
            if (!spec || typeof spec.entry !== 'string' || spec.entry.includes('..') || !/^[a-zA-Z0-9._\-/]+$/.test(spec.entry)) {
              throw new Error('panel.entry 非法（限扩展目录内相对路径）')
            }
            if (!opts.panels) throw new Error('面板宿主未接入（panels 未注入）')
            return opts.panels.open(extId, sessionId ?? '', spec, handlers)
          }
        }

        await entry(api)
        tools.push(...registered.tools)
        commands.push(...registered.commands)
        handlers.push(...registered.handlers)
        infos.push({ ...baseInfo, tools: registered.tools.map((t) => t.name), commands: registered.commands.map((c) => c.name) })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        errors.push(`${label}: ${reason}`)
        infos.push({ ...baseInfo, error: reason })
      }
    }
  }
  return { tools, commands, handlers, errors, infos }
}

/** 目录型扩展的 manifest.json 元数据（缺失/损坏返回 null，用目录名兜底） */
function readManifest(path: string): { name?: string; version?: string; description?: string } | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    const out = { name: str(raw.name), version: str(raw.version), description: str(raw.description) }
    return out.name || out.version || out.description ? out : null
  } catch {
    return null
  }
}

/** 事件名合法性表（借一个空实现对象取键集，避免额外导出常量） */
function dummyHandlers(): ExtensionHandlers {
  return {
    tool_call: () => {},
    tool_result: () => {},
    session_start: () => {},
    session_end: () => {},
    agent_start: () => {},
    agent_end: () => {},
    turn_start: () => {},
    turn_end: () => {},
    compacted: () => {}
  }
}

/** 全局目录（userData/extensions）+ 项目目录（ws/.navagent/extensions，过信任门） */
export function extensionScanSpecs(userDataPath: string, workspacePath: string, projectTrusted: boolean): ExtensionScanSpec[] {
  return [
    { dir: join(userDataPath, 'extensions'), source: 'global' as const, enabled: true },
    { dir: join(workspacePath, '.navagent', 'extensions'), source: 'project' as const, enabled: Boolean(workspacePath) && projectTrusted }
  ]
}
import type { ApiConfig, ToolInfo } from '@shared/types'
import type { Tool } from './registry'
import { webSearchTool } from './builtin/web-search'
import { webFetchTool } from './builtin/web-fetch'

/** 联网工具（web_search/web_fetch）：仅在配置了搜索后端时注册（skill 工具同款条件注册先例） */
export function webToolsOf(config: ApiConfig): Tool<any>[] {
  return config.webSearch?.apiKey ? [webSearchTool, webFetchTool] : []
}

/** 未配置时的占位条目（设置面板可见性：hint 非空 = 开关无效） */
export function webToolPlaceholders(hint: string): ToolInfo[] {
  return [
    { name: webSearchTool.name, source: 'builtin', mutating: false, enabled: false, hint },
    { name: webFetchTool.name, source: 'builtin', mutating: false, enabled: false, hint }
  ]
}

/**
 * 工具装配（纯函数）：per-tool 开关 + 只读模式过滤。
 * Agent 持有返回数组的引用；重载时由调用侧原数组清空重填（adaptTools 每次循环重新 map）。
 */
export function assembleTools(builtin: Tool<any>[], extension: Tool<any>[], config: ApiConfig): Tool<any>[] {
  const disabled = new Set(config.disabledTools)
  return [...builtin, ...extension].filter((t) => !disabled.has(t.name)).filter((t) => !(config.readOnly && t.mutating))
}

/** 设置面板展示用：全量工具清单及启用状态（只读模式下 mutating 工具视为禁用且不可勾选） */
export function toolInfos(builtin: Tool<any>[], extension: Tool<any>[], config: ApiConfig): ToolInfo[] {
  const disabled = new Set(config.disabledTools)
  return [...builtin, ...extension].map((t) => ({
    name: t.name,
    source: builtin.includes(t) ? ('builtin' as const) : ('extension' as const),
    mutating: t.mutating ?? false,
    enabled: !disabled.has(t.name) && !(config.readOnly && t.mutating)
  }))
}

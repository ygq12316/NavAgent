import type { ApiConfig } from '@shared/types'
import type { Tool } from './registry'

export interface ToolInfo {
  name: string
  source: 'builtin' | 'extension'
  mutating: boolean
  enabled: boolean
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

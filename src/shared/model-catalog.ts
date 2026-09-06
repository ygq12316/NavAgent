import type { Usage } from './types'

/**
 * 模型目录：内置快照已移除——目录完全由 models.json 自定义供应商在运行期
 * 经 registerExtraCatalog 注册（价格单位：USD / 百万 token，以厂商账单为准）。
 */

export interface CatalogModel {
  providerId: string
  model: string
  contextWindow: number
  inputPrice: number
  outputPrice: number
  /** 缓存命中输入单价（USD/百万 token）；缺省按 inputPrice 计（保守） */
  cacheReadPrice?: number
  /** 缓存写入单价（USD/百万 token）；缺省按 inputPrice 计 */
  cacheWritePrice?: number
  supportsThinking: boolean
}

/** 运行期动态目录（renderer 成本计价用；主进程 models.json 加载后经 IPC 同步过来） */
let EXTRA_CATALOG: CatalogModel[] = []

export function registerExtraCatalog(models: CatalogModel[]): void {
  EXTRA_CATALOG = models
}

export function extraCatalog(): CatalogModel[] {
  return EXTRA_CATALOG
}

/** 按厂商+模型查目录；支持 provider 前缀写法（如 openrouter 的 anthropic/claude-… 天然匹配 model 字段） */
export function lookupModel(providerId: string | undefined, model: string): CatalogModel | undefined {
  const pool = EXTRA_CATALOG.filter((m) => (providerId ? m.providerId === providerId : true))
  return pool.find((m) => m.model === model) ?? EXTRA_CATALOG.find((m) => m.model === model)
}

export function catalogFor(providerId: string | undefined): CatalogModel[] {
  return providerId ? EXTRA_CATALOG.filter((m) => m.providerId === providerId) : [...EXTRA_CATALOG]
}

/** 渲染层生效上下文窗口：目录命中模型用其定义，否则回退 fallback，最后 64k。
 * 与主进程 resolveContextWindow 同口径（目录同源于 models.json）；EXTRA_CATALOG 需已注册。 */
export function catalogContextWindowOf(model: string, fallback?: number): number {
  return resolveContextWindow(model, undefined, fallback, extraCatalog())
}

/** 生效上下文窗口的唯一实现（主进程压缩阈值/统计与渲染层环形图共用）：
 * 当前供应商的同名模型定义优先 → 目录里任意同名模型 → fallback（config 手填）→ 64k 默认。 */
export function resolveContextWindow(
  model: string,
  providerId: string | undefined,
  fallback: number | undefined,
  catalog: CatalogModel[]
): number {
  const owner = providerId ? catalog.find((m) => m.providerId === providerId && m.model === model) : undefined
  const hit = owner ?? catalog.find((m) => m.model === model)
  if (hit && hit.contextWindow > 0) return hit.contextWindow
  return fallback && fallback > 0 ? fallback : 64_000
}

/** 估算一次用量成本（USD）；目录未收录返回 null（调用侧显示"未知"）。
 *  缓存读/写单价缺省按 inputPrice 保守计算。 */
export function estimateCost(usage: Usage, entry: CatalogModel | undefined): number | null {
  if (!entry) return null
  const readPrice = entry.cacheReadPrice ?? entry.inputPrice
  const writePrice = entry.cacheWritePrice ?? entry.inputPrice
  const cacheRead = (usage.cacheReadTokens ?? 0) / 1_000_000
  const cacheWrite = (usage.cacheWriteTokens ?? 0) / 1_000_000
  return (
    (usage.inputTokens / 1_000_000) * entry.inputPrice +
    (usage.outputTokens / 1_000_000) * entry.outputPrice +
    cacheRead * readPrice +
    cacheWrite * writePrice
  )
}

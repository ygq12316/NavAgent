// src/renderer/src/state/pane-layout.ts
/** 会话内 pane 布局模型（对标 Claude Code 桌面端）：chat 锚点 + Views 唤出的从属 pane，
 *  二叉分割树平铺；关闭即摘除（无最小化、无隐藏层、无跨会话规范构图）。 */

export type PaneKind = 'chat' | 'files' | 'file' | 'terminal' | 'diff'

/** 二叉分割树：ratio = a 子树占比 */
export type PaneNode =
  | { t: 'split'; dir: 'row' | 'col'; ratio: number; a: PaneNode; b: PaneNode }
  | { t: 'leaf'; kind: PaneKind }

export const RATIO_MIN = 0.15
export const RATIO_MAX = 0.85

const clampRatio = (r: number): number => Math.min(RATIO_MAX, Math.max(RATIO_MIN, r))

/**
 * 默认构图：只给 chat（对齐"会话为中心"——文件/终端/Diff 由头部召唤钮或 openFile 按需唤出，
 * 不随新会话自动铺开）。各会话布局独立记忆（layouts[sessionId]），互不共享。
 */
export function defaultPaneLayout(): PaneNode {
  return { t: 'leaf', kind: 'chat' }
}

// ── 树算法（纯函数，不改入参；沿用原自由窗口区的实现） ───────

export function findPath(node: PaneNode, kind: PaneKind, acc: number[] = []): number[] | null {
  if (node.t === 'leaf') return node.kind === kind ? acc : null
  return findPath(node.a, kind, [...acc, 0]) ?? findPath(node.b, kind, [...acc, 1])
}

export function countLeaves(node: PaneNode): number {
  if (node.t === 'leaf') return 1
  return countLeaves(node.a) + countLeaves(node.b)
}

/** 摘除 path 指向的叶子；split 只剩一个孩子时坍缩为该孩子。path 无效时原样返回 */
export function removeAt(node: PaneNode, path: number[]): PaneNode | null {
  if (path.length === 0) return null
  if (node.t !== 'split') return node
  const [i, ...rest] = path
  if (i !== 0 && i !== 1) return node
  const child = i === 0 ? node.a : node.b
  const kept = removeAt(child, rest)
  if (kept === child) return node
  if (kept === null) return i === 0 ? node.b : node.a
  return i === 0 ? { ...node, a: kept } : { ...node, b: kept }
}

/** 在 target 叶子旁包一层新 split（dir 定横竖，first 决定新叶在 a 还是 b）；目标不存在包裹根 */
export function insertNear(node: PaneNode, target: PaneKind, dir: 'row' | 'col', first: boolean, newKind: PaneKind): PaneNode {
  if (node.t === 'leaf') {
    if (node.kind !== target) return node
    const self: PaneNode = node
    const fresh: PaneNode = { t: 'leaf', kind: newKind }
    return { t: 'split', dir, ratio: 0.5, a: first ? fresh : self, b: first ? self : fresh }
  }
  if (findPath(node.a, target)) return { ...node, a: insertNear(node.a, target, dir, first, newKind) }
  if (findPath(node.b, target)) return { ...node, b: insertNear(node.b, target, dir, first, newKind) }
  return node
}

export function setRatioAt(node: PaneNode, path: number[], ratio: number): PaneNode {
  if (path.length === 0) return node.t === 'split' ? { ...node, ratio: clampRatio(ratio) } : node
  if (node.t !== 'split') return node
  const [i, ...rest] = path
  return i === 0 ? { ...node, a: setRatioAt(node.a, rest, ratio) } : { ...node, b: setRatioAt(node.b, rest, ratio) }
}

export function swapKinds(node: PaneNode, k1: PaneKind, k2: PaneKind): PaneNode {
  if (node.t === 'leaf') {
    if (node.kind === k1) return { ...node, kind: k2 }
    if (node.kind === k2) return { ...node, kind: k1 }
    return node
  }
  return { ...node, a: swapKinds(node.a, k1, k2), b: swapKinds(node.b, k1, k2) }
}

/** Views 唤出 pane 的默认落位：chat 锚点旁，files/file 落右侧、terminal/diff 落下方（chat 恒在前） */
export function openPane(node: PaneNode, kind: Exclude<PaneKind, 'chat'>): PaneNode {
  if (findPath(node, kind)) return node
  const dir: 'row' | 'col' = kind === 'files' || kind === 'file' ? 'row' : 'col'
  return insertNear(node, 'chat', dir, false, kind)
}

/** 关闭 pane：摘叶坍缩；chat 是锚点不可关（调用方守卫 + 此处兜底） */
export function closePane(node: PaneNode, kind: PaneKind): PaneNode {
  if (kind === 'chat') return node
  const path = findPath(node, kind)
  if (!path) return node
  return removeAt(node, path) ?? defaultPaneLayout()
}

// ── UI 偏好（主题 + 侧栏；localStorage 持久化） ──────────────

export interface UiPrefs {
  theme: 'light' | 'dark'
  railCollapsed: boolean
  rail: number
}

export const RAIL_MIN = 160
export const RAIL_MAX = 320

const PREFS_KEY = 'navagent.ui.v2'

export function defaultPrefs(): UiPrefs {
  return { theme: 'dark', railCollapsed: false, rail: 195 }
}

export function loadPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return defaultPrefs()
    const v = JSON.parse(raw) as Partial<UiPrefs>
    return {
      theme: v.theme === 'dark' ? 'dark' : 'light',
      railCollapsed: v.railCollapsed === true,
      rail: typeof v.rail === 'number' && Number.isFinite(v.rail) ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, v.rail)) : 195
    }
  } catch {
    return defaultPrefs()
  }
}

export function savePrefs(p: UiPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* 存储不可用时静默 */
  }
}

// ── 每会话布局记忆（localStorage，LRU 上限 60 会话）──────────

const LAYOUTS_KEY = 'navagent.layouts.v1'
const LAYOUTS_CAP = 60

/** 校验布局树（localStorage 来源不可信；非法返回 null） */
function validPaneNode(v: unknown): PaneNode | null {
  if (typeof v !== 'object' || v === null) return null
  const n = v as Record<string, unknown>
  if (n.t === 'leaf') {
    const kinds: PaneKind[] = ['chat', 'files', 'file', 'terminal', 'diff']
    return kinds.includes(n.kind as PaneKind) ? ({ t: 'leaf', kind: n.kind } as PaneNode) : null
  }
  if (n.t !== 'split' || (n.dir !== 'row' && n.dir !== 'col') || typeof n.ratio !== 'number' || !Number.isFinite(n.ratio)) return null
  const a = validPaneNode(n.a)
  const b = validPaneNode(n.b)
  return a && b ? { t: 'split', dir: n.dir as 'row' | 'col', ratio: Math.min(RATIO_MAX, Math.max(RATIO_MIN, n.ratio)), a, b } : null
}

export function loadSessionLayouts(): Record<string, PaneNode> {
  try {
    const raw = localStorage.getItem(LAYOUTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, PaneNode> = {}
    for (const [sid, node] of Object.entries(parsed)) {
      const valid = validPaneNode(node)
      if (typeof sid === 'string' && sid && valid) out[sid] = valid
    }
    return out
  } catch {
    return {}
  }
}

export function saveSessionLayouts(layouts: Record<string, PaneNode>): void {
  try {
    const entries = Object.entries(layouts)
    // LRU：超出上限时丢弃最早的（对象键序 = 插入序；重写时先写保留项再写新增）
    const kept = entries.slice(Math.max(0, entries.length - LAYOUTS_CAP))
    const payload: Record<string, PaneNode> = {}
    for (const [sid, node] of kept) payload[sid] = node
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify(payload))
  } catch {
    /* 存储不可用时静默 */
  }
}

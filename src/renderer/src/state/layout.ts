// src/renderer/src/state/layout.ts
/** 窗口化布局模型：会话管理固定左栏（rail），其余窗口在右侧自由区按二叉分割树平铺。
 *  设计见 docs/superpowers/specs/2026-09-02-rail-window-ui-design.md 第 4 节。 */

export type FreeKind = 'chat' | 'files' | 'file' | 'terminal'

/** 二叉分割树：ratio = a 子树占比 */
export type FreeNode =
  | { t: 'split'; dir: 'row' | 'col'; ratio: number; a: FreeNode; b: FreeNode }
  | { t: 'leaf'; kind: FreeKind }

export interface LayoutState {
  /** 会话管理左栏宽度（px） */
  rail: number
  /** 左栏塌缩成细条 */
  railCollapsed: boolean
  /** 自由区分割树；null = 不可能（chat 恒保证可见或与他窗共存），类型上保留以便移除中间态 */
  free: FreeNode | null
  /** 已打开未关闭的窗口（含最小化隐藏中）；chat 恒在 —— DockRoot 据此渲染隐藏层保活组件 */
  openKinds: FreeKind[]
  theme: 'light' | 'dark'
}

export const RAIL_MIN = 160
export const RAIL_MAX = 320
export const RATIO_MIN = 0.15
export const RATIO_MAX = 0.85

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const clampRatio = (r: number): number => clamp(r, RATIO_MIN, RATIO_MAX)

export const defaultLayout = (): LayoutState => ({
  rail: 200,
  railCollapsed: false,
  free: { t: 'leaf', kind: 'chat' },
  openKinds: ['chat'],
  theme: 'light'
})

const isFreeKind = (v: unknown): v is FreeKind => v === 'chat' || v === 'files' || v === 'file' || v === 'terminal'

/** 深校验（localStorage 来源不可信）；非法返回 null */
export function validateLayout(v: unknown): LayoutState | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  if (typeof s.rail !== 'number' || !Number.isFinite(s.rail)) return null
  if (typeof s.railCollapsed !== 'boolean') return null
  if (s.theme !== 'light' && s.theme !== 'dark') return null
  if (!Array.isArray(s.openKinds) || !s.openKinds.every(isFreeKind) || !s.openKinds.includes('chat')) return null
  const ok = (n: unknown): n is FreeNode => {
    if (typeof n !== 'object' || n === null) return false
    const x = n as Record<string, unknown>
    if (x.t === 'leaf') return isFreeKind(x.kind)
    if (x.t !== 'split') return false
    if ((x.dir !== 'row' && x.dir !== 'col') || typeof x.ratio !== 'number' || !Number.isFinite(x.ratio)) return false
    return ok(x.a) && ok(x.b)
  }
  if (!ok(s.free) || s.free === null) return null
  // 去重 openKinds（不变量：每类至多一个）
  return {
    rail: clamp(s.rail, RAIL_MIN, RAIL_MAX),
    railCollapsed: s.railCollapsed,
    free: s.free,
    openKinds: [...new Set(s.openKinds as FreeKind[])],
    theme: s.theme
  }
}

const STORAGE_KEY = 'navagent.layout.v1'

export function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultLayout()
    return validateLayout(JSON.parse(raw)) ?? defaultLayout()
  } catch {
    return defaultLayout()
  }
}

export function saveLayout(s: LayoutState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* 存储不可用时静默（隐私模式等） */
  }
}

// ── 树算法（纯函数，不改入参）──────────────────────────────

export function findPath(node: FreeNode | null, kind: FreeKind, acc: number[] = []): number[] | null {
  if (!node) return null
  if (node.t === 'leaf') return node.kind === kind ? acc : null
  return findPath(node.a, kind, [...acc, 0]) ?? findPath(node.b, kind, [...acc, 1])
}

export function countLeaves(node: FreeNode | null): number {
  if (!node) return 0
  if (node.t === 'leaf') return 1
  return countLeaves(node.a) + countLeaves(node.b)
}

/** 摘除 path 指向的叶子；split 只剩一个孩子时坍缩为该孩子。path 无效时原样返回 */
export function removeAt(node: FreeNode, path: number[]): FreeNode | null {
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

/** 在 target 叶子旁包一层新 split（dir 定横竖，first 决定新叶在 a 还是 b）；目标不存在原样返回 */
export function insertNear(node: FreeNode, target: FreeKind, dir: 'row' | 'col', first: boolean, newKind: FreeKind): FreeNode {
  if (node.t === 'leaf') {
    if (node.kind !== target) return node
    const self: FreeNode = node
    const fresh: FreeNode = { t: 'leaf', kind: newKind }
    return { t: 'split', dir, ratio: 0.5, a: first ? fresh : self, b: first ? self : fresh }
  }
  if (findPath(node.a, target)) return { ...node, a: insertNear(node.a, target, dir, first, newKind) }
  if (findPath(node.b, target)) return { ...node, b: insertNear(node.b, target, dir, first, newKind) }
  return node
}

function setRatioAt(node: FreeNode, path: number[], ratio: number): FreeNode {
  if (path.length === 0) return node.t === 'split' ? { ...node, ratio: clampRatio(ratio) } : node
  if (node.t !== 'split') return node
  const [i, ...rest] = path
  return i === 0 ? { ...node, a: setRatioAt(node.a, rest, ratio) } : { ...node, b: setRatioAt(node.b, rest, ratio) }
}

function swapKinds(node: FreeNode, k1: FreeKind, k2: FreeKind): FreeNode {
  if (node.t === 'leaf') {
    if (node.kind === k1) return { ...node, kind: k2 }
    if (node.kind === k2) return { ...node, kind: k1 }
    return node
  }
  return { ...node, a: swapKinds(node.a, k1, k2), b: swapKinds(node.b, k1, k2) }
}

// ── reducer ────────────────────────────────────────────────

export type LayoutAction =
  | { kind: 'setRail'; width: number }
  | { kind: 'toggleRail' }
  | { kind: 'open'; win: Exclude<FreeKind, 'chat'> }
  | { kind: 'close'; win: Exclude<FreeKind, 'chat'> }
  | { kind: 'minimize'; win: FreeKind }
  | { kind: 'drop'; win: FreeKind; target: FreeKind; mode: 'left' | 'right' | 'top' | 'bottom' | 'swap' }
  | { kind: 'setRatio'; path: number[]; ratio: number }
  | { kind: 'setTheme'; theme: 'light' | 'dark' }
  | { kind: 'hydrate'; state: LayoutState }
  | { kind: 'reset' }

// ── 方案 A 规范树 ──────────────────────────────────────────
/** 规范构图（用户选定方案 A）：Files 满高窄列 │ 聊天横跨上部 │ 底行 File+Terminal。
 *  open 时按当前可见窗口集合重建规范树，保证任意开窗顺序收敛到同一结构；
 *  用户拖拽出的分界比例按「a 侧子树 kind 集合」继承保留。 */
const R_FILES = 0.22   // Files 列宽占比
const R_CHAT = 0.62    // 聊天（上部）高度占比
const R_BOTTOM = 0.5   // 底行 File│Terminal 左右占比

const leafOf = (kind: FreeKind): FreeNode => ({ t: 'leaf', kind })

/** 提取旧树的比例表：key = a 侧子树的 kind 集合（排序去重），value = ratio */
export function ratioMapOf(node: FreeNode | null): Map<string, number> {
  const map = new Map<string, number>()
  const kindsOf = (n: FreeNode): FreeKind[] => (n.t === 'leaf' ? [n.kind] : [...kindsOf(n.a), ...kindsOf(n.b)])
  const walk = (n: FreeNode | null): void => {
    if (!n || n.t === 'leaf') return
    const key = [...new Set(kindsOf(n.a))].sort().join(',')
    if (!map.has(key)) map.set(key, n.ratio)
    walk(n.a)
    walk(n.b)
  }
  walk(node)
  return map
}

function rowOfKinds(kinds: FreeKind[], ratios: Map<string, number>): FreeNode {
  if (kinds.length === 1) return leafOf(kinds[0]!)
  const [a, ...rest] = kinds
  return { t: 'split', dir: 'row', ratio: ratios.get(a!) ?? R_BOTTOM, a: leafOf(a!), b: rowOfKinds(rest, ratios) }
}

/** 规范树构建（visible 至少含一个窗口） */
export function canonicalTree(visible: FreeKind[], ratios: Map<string, number>): FreeNode {
  const has = (k: FreeKind): boolean => visible.includes(k)
  const bottom = (['file', 'terminal'] as FreeKind[]).filter(has)
  let core: FreeNode
  if (has('chat') && bottom.length > 0) {
    // 聊天横跨上部，底行 File│Terminal
    core = { t: 'split', dir: 'col', ratio: ratios.get('chat') ?? R_CHAT, a: leafOf('chat'), b: rowOfKinds(bottom, ratios) }
  } else if (has('chat')) {
    core = leafOf('chat')
  } else if (bottom.length > 0) {
    core = rowOfKinds(bottom, ratios) // chat 最小化时：剩余窗口纵向主体
  } else {
    core = leafOf('files') // 不可达（open 前保证 visible 非空），防御分支
  }
  if (has('files')) {
    core = { t: 'split', dir: 'row', ratio: ratios.get('files') ?? R_FILES, a: leafOf('files'), b: core }
  }
  return core
}

export function layoutReducer(s: LayoutState, a: LayoutAction): LayoutState {
  switch (a.kind) {
    case 'setRail':
      return { ...s, rail: clamp(a.width, RAIL_MIN, RAIL_MAX) }
    case 'toggleRail':
      return { ...s, railCollapsed: !s.railCollapsed }
    case 'open': {
      if (findPath(s.free, a.win)) return s // 已可见：no-op（单例）
      const visible: FreeKind[] = []
      const collect = (n: FreeNode | null): void => {
        if (!n) return
        if (n.t === 'leaf') visible.push(n.kind)
        else {
          collect(n.a)
          collect(n.b)
        }
      }
      collect(s.free)
      // 最小化恢复与首开同路：重排为方案 A 规范树（含新窗），并继承已拖出的比例
      const free = canonicalTree([...visible, a.win], ratioMapOf(s.free))
      return { ...s, free, openKinds: s.openKinds.includes(a.win) ? s.openKinds : [...s.openKinds, a.win] }
    }
    case 'close': {
      // 类型层已排除 chat，运行时再挡一层（chat 恒可见，不可关闭）
      if ((a.win as FreeKind) === 'chat') return s
      const path = findPath(s.free, a.win)
      if (!path) return s
      return { ...s, free: removeAt(s.free!, path), openKinds: s.openKinds.filter((k) => k !== a.win) }
    }
    case 'minimize': {
      const path = findPath(s.free, a.win)
      if (!path) return s
      // 不变量：free 永远至少一个可见窗口 → 唯一可见的窗口拒绝最小化
      if (countLeaves(s.free) <= 1) return s
      return { ...s, free: removeAt(s.free!, path) }
    }
    case 'drop': {
      if (a.win === a.target) return s
      if (a.mode === 'swap') {
        if (!findPath(s.free, a.target)) return s
        return { ...s, free: swapKinds(s.free!, a.win, a.target) }
      }
      const p = findPath(s.free, a.win)
      if (!p) return s
      const removed = removeAt(s.free!, p)
      const dir = a.mode === 'left' || a.mode === 'right' ? 'row' : 'col'
      const first = a.mode === 'left' || a.mode === 'top'
      // 目标可能与被摘窗口同级（removeAt 坍缩后仍在树中），insertNear 找不到目标时包裹根
      if (!findPath(removed, a.target)) {
        const fresh: FreeNode = { t: 'leaf', kind: a.win }
        return { ...s, free: { t: 'split', dir, ratio: 0.5, a: first ? fresh : removed!, b: first ? removed! : fresh } }
      }
      return { ...s, free: insertNear(removed!, a.target, dir, first, a.win) }
    }
    case 'setRatio': {
      if (!s.free) return s
      return { ...s, free: setRatioAt(s.free, a.path, a.ratio) }
    }
    case 'setTheme':
      return { ...s, theme: a.theme }
    case 'hydrate': {
      // localStorage 来源不可信：先深校验，非法回落默认
      const v = validateLayout(a.state)
      return v ?? defaultLayout()
    }
    case 'reset':
      return defaultLayout()
  }
}

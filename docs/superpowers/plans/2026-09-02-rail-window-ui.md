# navAgent 窗口化 UI 重构实施计划（左栏会话 + 自由窗口区 + 双主题）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-09-02-rail-window-ui-design.md` 把固定布局重构为「会话管理固定左栏 + 右侧自由窗口区（chat/files/file/terminal 平铺）」，视觉切换为 Notion 式扁平双主题。

**Architecture:** 手写二叉分割树（`FreeNode`）作为布局模型，纯函数 reducer + localStorage 持久化；`DockRoot` 组件递归渲染树并用 pointer events 实现分隔条拖宽与标题条拖拽换位；五个窗口组件（RailSessions/Chat/Files/File/Terminal）全部单例，最小化窗口保持挂载（隐藏层）以保住 xterm 滚动缓冲。主进程新增 TerminalService（node-pty）、fs-service（读/写/glob，全部过 `resolveWithin`）与独立 `onUiEvent` 事件通道。

**Tech Stack:** Electron 44 + React 19 + TypeScript + electron-vite；新增依赖：`node-pty`、`@xterm/xterm`、`@xterm/addon-fit`、`codemirror`（basicSetup）、`@codemirror/lang-*`。不引入布局库/UI 框架（R1）。

## Global Constraints

- 包管理器 pnpm；测试 `pnpm exec vitest run <file>`；类型检查 `pnpm typecheck`（两个 tsconfig 各跑一次）
- R1：不引入 agent 框架、状态库、UI 组件库；provider 直连 HTTP/SSE
- 代码注释与 UI 文案使用中文；测试描述也是中文
- `AgentEvent` 事件协议只增不改；UI 事件走新独立通道 `navagent:uiEvent`
- 新 IPC 失败一律编码进返回值（`{ok:false,...}` / `'busy'` 等），**永不 throw**（对齐 EngineHooks 契约）
- 所有 fs/pty 路径入口必须过 `resolveWithin(workspace, rel)`（`src/main/tools/registry.ts:22`）
- 工具名在数据面是下划线风格：`read_file` / `edit_file` / `write_file`（`ToolBlock.tsx:54` 已按此判断）

## Spec 偏差说明（实现时以本节为准，均已按现码库现实做出取舍）

1. **思考档位 7 档**：spec 写四档，但现码库 `ThinkingLevel = 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`（对齐 pi 7 档）且 TopBar 已有切换。Composer 信息条的下拉列出全部 7 档。
2. **最小化恢复位置**：spec 写「优先插回原位」，简化为**默认槽恢复**（files→chat 左、file→chat 右、terminal→chat 下；chat 隐藏时包裹根）——对齐 VS Code 重开面板行为，避免脆弱的路径重放。
3. **最小化窗口保持挂载**：spec 的环形缓冲改为**隐藏层挂载**（`display:none`），xterm 自带回滚即缓冲，实现更简单且无输出丢失。`openKinds` 字段区分「已开未关」与「已关闭」。
4. **项目切换保留在 TopBar**（现码库已有下拉），会话管理左栏不做项目切换，只做会话增删改查/导入导出/分支树入口。
5. **StatusBar 的 ☰ 按钮**改为切换左栏塌缩（替代原 sidebarOpen）。

---

### Task 1: 布局模型纯函数（layout.ts）+ 单测

**Files:**
- Create: `src/renderer/src/state/layout.ts`
- Test: `src/renderer/src/state/__tests__/layout.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖）:
  - `type FreeKind = 'chat' | 'files' | 'file' | 'terminal'`
  - `type FreeNode = { t:'split'; dir:'row'|'col'; ratio:number; a:FreeNode; b:FreeNode } | { t:'leaf'; kind:FreeKind }`
  - `interface LayoutState { rail:number; railCollapsed:boolean; free:FreeNode|null; openKinds:FreeKind[]; theme:'light'|'dark' }`
  - `defaultLayout(): LayoutState`、`loadLayout(): LayoutState`、`saveLayout(s): void`
  - `layoutReducer(s: LayoutState, a: LayoutAction): LayoutState`、`type LayoutAction`
  - 常量 `RAIL_MIN=160, RAIL_MAX=320, RATIO_MIN=0.15, RATIO_MAX=0.85`

- [ ] **Step 1: 写失败测试**

```ts
// src/renderer/src/state/__tests__/layout.test.ts
import { describe, expect, it, beforeAll } from 'vitest'
import {
  defaultLayout, layoutReducer, findPath, removeAt, insertNear, countLeaves,
  validateLayout, loadLayout, saveLayout, RAIL_MIN, RAIL_MAX, RATIO_MIN, RATIO_MAX
} from '../layout'
import type { FreeNode } from '../layout'

// vitest node 环境没有 localStorage，持久化用例需要先打桩
beforeAll(() => {
  const store = new Map<string, string>()
  ;(globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
  }
})

const L = (k: 'chat' | 'files' | 'file' | 'terminal'): FreeNode => ({ t: 'leaf', kind: k })
const S = (dir: 'row' | 'col', ratio: number, a: FreeNode, b: FreeNode): FreeNode => ({ t: 'split', dir, ratio, a, b })

describe('findPath / removeAt / insertNear', () => {
  it('findPath 定位叶子路径', () => {
    const t = S('row', 0.5, L('chat'), S('col', 0.5, L('files'), L('terminal')))
    expect(findPath(t, 'chat')).toEqual([0])
    expect(findPath(t, 'files')).toEqual([1, 0])
    expect(findPath(t, 'file')).toBeNull()
  })

  it('removeAt 摘叶并坍缩单孩子 split', () => {
    const t = S('row', 0.5, L('chat'), L('files'))
    expect(removeAt(t, [1])).toEqual(L('chat'))
    const deep = S('col', 0.5, S('row', 0.5, L('chat'), L('files')), L('terminal'))
    expect(removeAt(deep, [0, 1])).toEqual(S('col', 0.5, L('chat'), L('terminal')))
  })

  it('insertNear 在目标叶子旁包裹新 split（不改其他子树）', () => {
    const t = L('chat')
    const next = insertNear(t, 'chat', 'row', true, 'files')
    expect(next).toEqual(S('row', 0.5, L('files'), L('chat')))
    const deep = S('col', 0.6, L('chat'), L('terminal'))
    const after = insertNear(deep, 'chat', 'row', false, 'file')
    expect(after.a).toEqual(S('row', 0.5, L('chat'), L('file')))
    expect(after.b).toEqual(L('terminal'))
  })

  it('目标不存在时 insertNear 原样返回', () => {
    const t = L('chat')
    expect(insertNear(t, 'files', 'row', true, 'file')).toEqual(t)
  })
})

describe('layoutReducer', () => {
  it('open：files 插到 chat 左、file 插到右、terminal 插到下', () => {
    let s = defaultLayout()
    s = layoutReducer(s, { kind: 'open', win: 'files' })
    expect(s.free).toEqual(S('row', 0.5, L('files'), L('chat')))
    s = layoutReducer(s, { kind: 'open', win: 'file' })
    s = layoutReducer(s, { kind: 'open', win: 'terminal' })
    expect(findPath(s.free!, 'files')).toEqual([0, 0])
    expect(findPath(s.free!, 'file')).toEqual([0, 1])
    expect(findPath(s.free!, 'terminal')).toEqual([1])
    expect(s.openKinds).toContain('files')
  })

  it('open 已存在的窗口是 no-op', () => {
    let s = layoutReducer(defaultLayout(), { kind: 'open', win: 'files' })
    const before = s.free
    s = layoutReducer(s, { kind: 'open', win: 'files' })
    expect(s.free).toBe(before)
  })

  it('close：摘叶坍缩，openKinds 移除；chat 不可关闭', () => {
    let s = defaultLayout()
    s = layoutReducer(s, { kind: 'open', win: 'files' })
    s = layoutReducer(s, { kind: 'close', win: 'files' })
    expect(s.free).toEqual(L('chat'))
    expect(s.openKinds).toEqual(['chat'])
    // chat 不在动作集合里（类型层排除），运行时再挡一层
    expect(layoutReducer(s, { kind: 'close', win: 'chat' } as never)).toEqual(s)
  })

  it('minimize：从树摘除但保留在 openKinds；唯一可见窗口的 chat 拒绝最小化', () => {
    let s = layoutReducer(defaultLayout(), { kind: 'open', win: 'terminal' })
    s = layoutReducer(s, { kind: 'minimize', win: 'chat' })
    expect(findPath(s.free!, 'chat')).toBeNull()
    expect(findPath(s.free!, 'terminal')).toEqual([])
    expect(s.openKinds).toContain('chat')
    // terminal 也最小化后 free 只剩……chat 已最小化、terminal 是最后一个 → 拒绝
    s = layoutReducer(s, { kind: 'minimize', win: 'terminal' })
    expect(findPath(s.free!, 'terminal')).not.toBeNull()
  })

  it('minimize 隐藏中的窗口是 no-op', () => {
    let s = layoutReducer(defaultLayout(), { kind: 'open', win: 'files' })
    s = layoutReducer(s, { kind: 'minimize', win: 'chat' })
    const before = s.free
    s = layoutReducer(s, { kind: 'minimize', win: 'chat' })
    expect(s.free).toBe(before)
  })

  it('drop left/right/top/bottom：先摘自己再插到目标旁', () => {
    let s = defaultLayout()
    s = layoutReducer(s, { kind: 'open', win: 'files' })
    // 把 files 拖到 chat 右侧
    s = layoutReducer(s, { kind: 'drop', win: 'files', target: 'chat', mode: 'right' })
    expect(s.free).toEqual(S('row', 0.5, L('chat'), L('files')))
    // 再拖到 chat 下方
    s = layoutReducer(s, { kind: 'drop', win: 'files', target: 'chat', mode: 'bottom' })
    expect(findPath(s.free!, 'files')).toEqual([1])
    expect((s.free as Extract<FreeNode, { t: 'split' }>).dir).toBe('col')
  })

  it('drop swap：两叶互换 kind', () => {
    let s = defaultLayout()
    s = layoutReducer(s, { kind: 'open', win: 'files' })
    s = layoutReducer(s, { kind: 'drop', win: 'files', target: 'chat', mode: 'swap' })
    expect(findPath(s.free!, 'chat')).toEqual([0])
    expect(findPath(s.free!, 'files')).toEqual([1])
  })

  it('drop 到自身是 no-op', () => {
    const s = layoutReducer(defaultLayout(), { kind: 'open', win: 'files' })
    expect(layoutReducer(s, { kind: 'drop', win: 'files', target: 'files', mode: 'left' })).toEqual(s)
  })

  it('setRail / setRatio 有界', () => {
    let s = defaultLayout()
    s = layoutReducer(s, { kind: 'setRail', width: 50 })
    expect(s.rail).toBe(RAIL_MIN)
    s = layoutReducer(s, { kind: 'setRail', width: 999 })
    expect(s.rail).toBe(RAIL_MAX)
    s = layoutReducer(s, { kind: 'open', win: 'files' })
    s = layoutReducer(s, { kind: 'setRatio', path: [0], ratio: 0.01 })
    expect((s.free as Extract<FreeNode, { t: 'split' }>).ratio).toBe(RATIO_MIN)
  })

  it('hydrate 非法结构回落默认；合法结构采纳', () => {
    const bad = layoutReducer(defaultLayout(), { kind: 'hydrate', state: { rail: 10, railCollapsed: false, free: { t: 'leaf', kind: 'hacker' as never }, openKinds: [], theme: 'light' } })
    expect(bad).toEqual(defaultLayout())
    const good = validateLayout({ rail: 240, railCollapsed: true, free: S('row', 0.4, L('files'), L('chat')), openKinds: ['chat', 'files'], theme: 'dark' })
    expect(good).not.toBeNull()
  })

  it('持久化往返：save 后 load 相同', () => {
    let s = layoutReducer(defaultLayout(), { kind: 'open', win: 'files' })
    s = layoutReducer(s, { kind: 'setTheme', theme: 'dark' })
    saveLayout(s)
    expect(loadLayout()).toEqual(s)
  })
})

describe('countLeaves', () => {
  it('统计叶子数', () => {
    const t = S('row', 0.5, L('chat'), S('col', 0.5, L('files'), L('terminal')))
    expect(countLeaves(t)).toBe(3)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/renderer/src/state/__tests__/layout.test.ts`
Expected: FAIL（`Cannot find module '../layout'`）

- [ ] **Step 3: 实现 layout.ts**

```ts
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

const DEFAULT_SLOT: Record<'files' | 'file' | 'terminal', { dir: 'row' | 'col'; first: boolean }> = {
  files: { dir: 'row', first: true },   // chat 左
  file: { dir: 'row', first: false },   // chat 右
  terminal: { dir: 'col', first: false } // chat 下
}

/** chat 在树中：插到 chat 旁；chat 被最小化：包裹根；空树：单叶 */
function openIn(free: FreeNode | null, win: FreeKind, dir: 'row' | 'col', first: boolean): FreeNode {
  if (free === null) return { t: 'leaf', kind: win }
  if (findPath(free, win)) return free
  if (findPath(free, 'chat')) return insertNear(free, 'chat', dir, first, win)
  const fresh: FreeNode = { t: 'leaf', kind: win }
  return { t: 'split', dir, ratio: 0.5, a: first ? fresh : free, b: first ? free : fresh }
}

export function layoutReducer(s: LayoutState, a: LayoutAction): LayoutState {
  switch (a.kind) {
    case 'setRail':
      return { ...s, rail: clamp(a.width, RAIL_MIN, RAIL_MAX) }
    case 'toggleRail':
      return { ...s, railCollapsed: !s.railCollapsed }
    case 'open': {
      const { dir, first } = DEFAULT_SLOT[a.win]
      const free = openIn(s.free, a.win, dir, first)
      if (free === s.free) return s
      return { ...s, free, openKinds: s.openKinds.includes(a.win) ? s.openKinds : [...s.openKinds, a.win] }
    }
    case 'close': {
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/renderer/src/state/__tests__/layout.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/state/layout.ts src/renderer/src/state/__tests__/layout.test.ts
git commit -m "feat(ui): 布局分割树纯函数模型 + 单测"
```

---

### Task 2: 双主题令牌与扁平化样式（theme.css）

**Files:**
- Create: `src/renderer/src/styles/theme.css`
- Modify: `src/renderer/src/main.tsx`（追加 import）
- Modify: `src/main/index.ts`（`backgroundColor: '#2a2f37'` → `'#d2cfc8'`）

**Interfaces:**
- Produces: CSS 变量 `--desk/--win/--content/--bd/--wbd/--inner/--tx/--dim/--faint/--hov/--acc/--ok/--warn` 与 `[data-theme='dark']` 覆盖；后续任务的窗口壳/文件树/终端/编辑器样式全部写进本文件

- [ ] **Step 1: 创建 theme.css**

```css
/* ── 窗口化 UI 主题层（spec 第 2 节）──────────────────────────
   引入顺序在 styles.css 之后，同名规则按层叠覆盖新拟物。
   令牌分双层：语义变量（组件只用这些）→ 主题值。 */
:root {
  --desk: #d2cfc8;
  --win: #f6f5f2;
  --content: #fbfaf8;
  --bd: #c8c5be;
  --wbd: #dddad4;
  --inner: #e9e7e1;
  --tx: #33312c;
  --dim: rgba(51, 49, 44, 0.6);
  --faint: rgba(51, 49, 44, 0.38);
  --hov: rgba(51, 49, 44, 0.06);
  --acc: #2383e2;
  --ok: #0f7b6c;
  --warn: #b58a2e;
  --radius-win: 14px;
  --gap: 8px;
}
[data-theme='dark'] {
  --desk: #1d2126;
  --win: #2a2f37;
  --content: #23272e;
  --bd: #3a404a;
  --wbd: #343a43;
  --inner: #31373f;
  --tx: #d7dce6;
  --dim: rgba(215, 220, 230, 0.62);
  --faint: rgba(215, 220, 230, 0.38);
  --hov: rgba(215, 220, 230, 0.07);
  --acc: #7c93ff;
  --ok: #5cba8c;
  --warn: #d9a441;
}

/* 全局基调：正文色/桌面底随主题 */
body {
  background: var(--desk);
  color: var(--tx);
}

/* ── 去新拟物：阴影体系全部压平，边框/底色接管层次 ───────────── */
.raised, .sunken, .btn, .icon-btn, .model-badge, .thinking-select,
.dropdown, .project-btn, .search, .composer-box, .session-entry .session-export {
  background: var(--win);
  box-shadow: none !important;
  border: 1px solid var(--wbd);
}
.btn:hover:not(:disabled), .icon-btn:hover:not(:disabled) {
  background: var(--hov);
  color: var(--tx);
  box-shadow: none !important;
}
.btn:active:not(:disabled), .icon-btn:active:not(:disabled), .btn.pressed {
  box-shadow: none !important;
  background: var(--inner);
}
:root { --radius: 6px; --radius-lg: 10px; }   /* 新拟物大圆角收敛 */

.app { background: var(--desk); }

/* ── Dock 壳层 ─────────────────────────────────────────────── */
.dock {
  flex: 1;
  display: flex;
  min-height: 0;
  padding: var(--gap);
  gap: var(--gap);
  background: var(--desk);
  overflow: hidden;
}
.dock-window {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--win);
  border: 1px solid var(--bd);
  border-radius: var(--radius-win);
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
[data-theme='dark'] .dock-window { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); }
.dock-window.is-drop-target { outline: 1.5px dashed var(--acc); outline-offset: -3px; }
.dock-window.is-drop-reject { outline: 1.5px dashed var(--warn); outline-offset: -3px; }

.dock-window-header {
  height: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 0 12px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--wbd);
  user-select: none;
}
.dock-window-header.grabbable { cursor: grab; }
.dock-window-header.grabbable:active { cursor: grabbing; }
.dock-window-title { font-size: 12px; font-weight: 600; color: var(--tx); flex: 1; white-space: nowrap; overflow: hidden; }
.dock-window-sub { font-size: 10px; color: var(--faint); font-weight: 400; }
.dock-window-badge { font-size: 9px; color: var(--faint); border: 1px solid var(--inner); border-radius: 99px; padding: 1px 6px; }
.dock-window-actions { display: flex; gap: 2px; align-items: center; }
.dock-window-actions .win-btn {
  min-width: 22px; height: 20px; border-radius: 4px; border: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: var(--faint); background: transparent; padding: 0 4px;
}
.dock-window-actions .win-btn:hover { background: var(--hov); color: var(--tx); }
.dock-window-actions .win-btn.open-btn { font-size: 10px; color: var(--dim); border: 1px solid var(--bd); border-radius: 4px; padding: 1px 7px; min-width: 0; }
.dock-window-actions .win-btn.open-btn:hover { color: var(--acc); border-color: var(--acc); background: transparent; }
.dock-window-body { flex: 1; min-height: 0; overflow: hidden; border-top: none; background: var(--content); display: flex; flex-direction: column; }

/* 分割树 */
.dock-split-row { display: flex; flex: 1; min-width: 0; min-height: 0; }
.dock-split-col { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.dock-splitter { flex: 0 0 7px; position: relative; z-index: 2; margin: 0 -3px; }
.dock-splitter[data-dir='col'] { flex-basis: 7px; margin: -3px 0; }
.dock-splitter::before {
  content: ''; position: absolute; background: transparent; transition: background 0.12s;
}
.dock-splitter[data-dir='row']::before { left: 3px; top: 0; bottom: 0; width: 1px; }
.dock-splitter[data-dir='col']::before { top: 3px; left: 0; right: 0; height: 1px; }
.dock-splitter:hover::before, .dock-splitter.active::before { background: var(--acc); }
.dock-splitter[data-dir='row']:hover::before, .dock-splitter[data-dir='row'].active::before { width: 2px; left: 2.5px; }
.dock-splitter[data-dir='col']:hover::before, .dock-splitter[data-dir='col'].active::before { height: 2px; top: 2.5px; }
.dock-splitter.rail-split::before { background: var(--acc); width: 2px; left: 2.5px; }

/* 拖拽 ghost */
.drag-ghost {
  position: fixed; z-index: 99; pointer-events: none;
  background: var(--win); border: 1px solid var(--bd); border-radius: 6px;
  box-shadow: 0 4px 16px rgba(15, 15, 15, 0.18);
  font-size: 11.5px; color: var(--tx); padding: 3px 12px;
}

/* 左栏塌缩细条 */
.rail-collapsed-bar {
  flex: 0 0 40px; border: 1px solid var(--bd); border-radius: var(--radius-win);
  background: var(--win); color: var(--dim); writing-mode: vertical-rl;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  font-size: 12px; cursor: pointer;
}
.rail-collapsed-bar:hover { color: var(--acc); }

/* 最小化窗口隐藏层（保活挂载，不可见不参与布局） */
.dock-hidden { position: absolute; width: 0; height: 0; overflow: hidden; visibility: hidden; }

/* ── Files 窗口 ────────────────────────────────────────────── */
.files-toolbar { display: flex; gap: 6px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--wbd); }
.files-search {
  flex: 1; display: flex; align-items: center; gap: 5px;
  border: 1px solid var(--inner); border-radius: 6px; padding: 3px 8px;
  color: var(--faint); font-size: 11.5px; background: var(--win);
}
.files-search input { flex: 1; border: none; outline: none; background: transparent; color: var(--tx); font-size: 11.5px; }
.files-body { flex: 1; overflow: auto; padding: 4px 6px; user-select: none; }
.files-row {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 3px 6px; border: none; border-radius: 4px; background: transparent;
  font-size: 12px; color: var(--tx); text-align: left; cursor: pointer;
}
.files-row:hover { background: var(--hov); }
.files-row .caret { width: 12px; color: var(--faint); font-size: 10px; }
.files-row .name { color: var(--tx); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.files-row.is-file .name { color: var(--dim); }
.files-row .copy-path { margin-left: auto; border: none; background: transparent; color: var(--faint); font-size: 10px; opacity: 0; cursor: pointer; padding: 1px 4px; }
.files-row:hover .copy-path { opacity: 1; }
.files-row .copy-path:hover { color: var(--acc); }
.files-empty { padding: 16px; font-size: 11.5px; color: var(--faint); text-align: center; }

/* ── File 内容窗口（CodeMirror 宿主 + 工具条）──────────────── */
.file-toolbar { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--wbd); flex-shrink: 0; }
.file-toolbar .file-search-hint { flex: 1; font-size: 10.5px; color: var(--faint); }
.file-toolbar button { border: none; background: transparent; color: var(--dim); font-size: 10.5px; padding: 2px 7px; border-radius: 4px; cursor: pointer; }
.file-toolbar button:hover { background: var(--hov); color: var(--tx); }
.file-toolbar button.save-dirty { color: var(--acc); font-weight: 600; }
.file-banner { padding: 6px 12px; font-size: 11px; background: var(--inner); color: var(--warn); flex-shrink: 0; }
.file-editor-host { flex: 1; min-height: 0; overflow: hidden; }
.file-editor-host .cm-editor { height: 100%; font-size: 12.5px; }
.file-editor-host .cm-editor.cm-focused { outline: none; }
.file-editor-host .cm-gutters { background: var(--content); border-right: 1px solid var(--wbd); color: var(--faint); }
.file-editor-host .cm-activeLine { background: var(--hov); }
.file-editor-host .cm-panels { background: var(--win); color: var(--tx); }
.file-dialog-mask { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.25); display: flex; align-items: center; justify-content: center; z-index: 10; }
.file-dialog { background: var(--win); border: 1px solid var(--bd); border-radius: 10px; padding: 16px; max-width: 320px; box-shadow: 0 8px 28px rgba(0,0,0,.16); }
.file-dialog h4 { margin: 0 0 6px; font-size: 13px; color: var(--tx); }
.file-dialog p { margin: 0 0 12px; font-size: 11.5px; color: var(--dim); line-height: 1.6; }
.file-dialog .row { display: flex; gap: 8px; justify-content: flex-end; }

/* ── Terminal 窗口 ─────────────────────────────────────────── */
.term-tabs { display: flex; gap: 4px; padding: 6px 10px 0; border-bottom: 1px solid var(--wbd); flex-shrink: 0; }
.term-tab {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; padding: 3px 9px; border: none; background: transparent;
  color: var(--faint); border-radius: 6px 6px 0 0; cursor: pointer;
}
.term-tab.on { background: var(--hov); color: var(--tx); font-weight: 500; }
.term-tab .tab-close { border: none; background: transparent; color: var(--faint); cursor: pointer; padding: 0 1px; font-size: 9px; }
.term-tab .tab-close:hover { color: var(--warn); }
.term-add { border: none; background: transparent; color: var(--dim); font-size: 13px; cursor: pointer; padding: 0 6px; }
.term-add:hover { color: var(--acc); }
.term-host { flex: 1; min-height: 0; padding: 4px; position: relative; }
.term-pane { position: absolute; inset: 4px; }
.term-pane.off { display: none; }
.term-pane .xterm { height: 100%; }
.term-notice { padding: 20px; font-size: 12px; color: var(--faint); text-align: center; }
.term-notice button { margin-top: 10px; }

/* ── Composer 信息条 ───────────────────────────────────────── */
.composer-meta {
  display: flex; align-items: center; gap: 5px;
  border-top: 1px solid var(--wbd); margin-top: 6px; padding: 6px 8px 7px;
  overflow: hidden;
}
.meta-chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10.5px; color: var(--dim); padding: 2px 8px;
  background: var(--inner); border: none; border-radius: 5px; cursor: pointer;
  white-space: nowrap;
}
.meta-chip:hover { color: var(--acc); }
.meta-chip.thinking-active { color: var(--acc); background: var(--hov); }
.meta-chip.plain { cursor: default; }
.meta-spacer { flex: 1; }
.meta-ctx { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--dim); padding: 2px 6px; white-space: nowrap; }
.meta-ctx.warn { color: var(--warn); }
.meta-ctx .bar { width: 48px; height: 4px; border-radius: 99px; background: var(--inner); overflow: hidden; }
.meta-ctx .bar i { display: block; height: 100%; border-radius: 99px; background: var(--acc); }
.meta-ctx.warn .bar i { background: var(--warn); }

/* ── ToolBlock 可点路径 ────────────────────────────────────── */
.tool-args.clickable { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px; }
.tool-args.clickable:hover { color: var(--acc); }

/* ── TopBar 主题切换 / StatusBar ───────────────────────────── */
.icon-btn.theme-btn { border: 1px solid var(--wbd); }
.statusbar { background: var(--win); border-top: 1px solid var(--wbd); }
```

- [ ] **Step 2: main.tsx 引入主题层（排在 styles.css 之后）**

```tsx
// src/renderer/src/main.tsx —— 在既有 import styles.css 下一行加：
import './styles/theme.css'
```

- [ ] **Step 3: Electron 窗口底色随明亮默认**

```ts
// src/main/index.ts —— createWindow 内：
// 原： backgroundColor: '#2a2f37',
backgroundColor: '#d2cfc8',
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm dev:web`
Expected: 页面加载无报错；现状布局仍是旧 Sidebar（新壳层任务 3 才接入），但按钮/面板阴影消失、底色变浅灰。DevTools `document.documentElement.dataset.theme = 'dark'` 手动执行后全局切换暗色。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/styles/theme.css src/renderer/src/main.tsx src/main/index.ts
git commit -m "feat(ui): 双主题令牌层 + 去新拟物扁平化"
```

---

### Task 3: Dock 壳层组件（DockRoot / WindowFrame / 拖拽）

**Files:**
- Create: `src/renderer/src/components/dock/DockRoot.tsx`
- Create: `src/renderer/src/components/dock/WindowFrame.tsx`

**Interfaces:**
- Consumes: Task 1 的 `LayoutState/LayoutAction/findPath/countLeaves`
- Produces:
  - `interface DockSlots { rail: React.ReactNode; renderWindow: (kind: FreeKind) => React.ReactNode; windowTitle: (kind: FreeKind) => { title: string; sub?: string; locked: boolean } ; onCloseRequest?: (kind: FreeKind) => void }`
  - `<DockRoot layout dispatch slots />` —— App 传入槽位；本任务先用占位内容接线，Task 4 起替换为真窗口

- [ ] **Step 1: 实现 WindowFrame.tsx**

```tsx
// src/renderer/src/components/dock/WindowFrame.tsx
import { useEffect, useRef, useState } from 'react'

export interface WindowFrameProps {
  kind: string
  title: string
  sub?: string
  /** 常驻窗口（会话管理/聊天）：无 ✕，标题条不可拖拽换位（会话管理在左栏不可拖；chat 可拖） */
  movable: boolean
  closable: boolean
  /** 头部左侧追加动作（chat 的 ＋Files 等） */
  headerActions?: React.ReactNode
  onCloseRequest?: () => void
  onMinimize: () => void
  onBeginDrag?: (e: React.PointerEvent) => void
  dropHint?: 'target' | 'reject' | null
  children: React.ReactNode
}

export function WindowFrame(p: WindowFrameProps) {
  return (
    <section
      className={`dock-window${p.dropHint === 'target' ? ' is-drop-target' : p.dropHint === 'reject' ? ' is-drop-reject' : ''}`}
      data-window-kind={p.kind}
    >
      <div
        className={`dock-window-header${p.movable ? ' grabbable' : ''}`}
        onPointerDown={(e) => {
          if (!p.movable || (e.target as HTMLElement).closest('.win-btn')) return
          p.onBeginDrag?.(e)
        }}
      >
        <span className="dock-window-title">
          {p.title}
          {p.sub && <span className="dock-window-sub"> {p.sub}</span>}
        </span>
        {p.headerActions}
        <span className="dock-window-actions">
          <button className="win-btn" onClick={p.onMinimize} title="最小化（顶栏可唤回）">
            —
          </button>
          {p.closable && (
            <button className="win-btn" onClick={() => p.onCloseRequest?.()} title="关闭">
              ✕
            </button>
          )}
        </span>
      </div>
      <div className="dock-window-body">{p.children}</div>
    </section>
  )
}

/** 拖拽 ghost：跟随指针的浮动标签（DockRoot 渲染） */
export function DragGhost({ label, pos, reject }: { label: string; pos: { x: number; y: number }; reject: boolean }) {
  return (
    <div className="drag-ghost" style={{ left: pos.x + 10, top: pos.y + 10, color: reject ? 'var(--warn)' : undefined }}>
      {reject ? '🚫 ' : '⠿ '}
      {label}
    </div>
  )
}

/** 点击外部关闭的下拉小容器（chat 头部按钮组复用） */
export function useOutsideClose(onClose: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [onClose])
  return ref
}

/** 极简三选确认对话框（File 冲突等复用） */
export function MiniDialog({ title, text, actions }: { title: string; text: string; actions: { label: string; onClick: () => void; primary?: boolean }[] }) {
  const [, force] = useState(0)
  return (
    <div className="file-dialog-mask">
      <div className="file-dialog">
        <h4>{title}</h4>
        <p>{text}</p>
        <div className="row">
          {actions.map((a) => (
            <button key={a.label} className={a.primary ? 'btn btn-primary' : 'btn'} onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 实现 DockRoot.tsx**

```tsx
// src/renderer/src/components/dock/DockRoot.tsx
import { useCallback, useRef, useState } from 'react'
import type { LayoutAction, LayoutState, FreeKind, FreeNode } from '../../state/layout'
import { WindowFrame, DragGhost } from './WindowFrame'

export interface DockSlots {
  rail: React.ReactNode
  renderWindow: (kind: FreeKind) => React.ReactNode
  windowChrome: (kind: FreeKind) => { title: string; sub?: string; locked: boolean; headerActions?: React.ReactNode }
  /** 关闭前拦截（File 窗口脏内容确认）；返回 false 中止 */
  onCloseRequest?: (kind: FreeKind) => boolean
}

interface DragState {
  win: FreeKind
  x: number
  y: number
  target: FreeKind | 'sessions' | null
  mode: 'left' | 'right' | 'top' | 'bottom' | 'swap' | 'reject' | null
}

const EDGE = 0.28 // 目标窗口边缘热区比例

export function DockRoot({ layout, dispatch, slots }: { layout: LayoutState; dispatch: (a: LayoutAction) => void; slots: DockSlots }) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)

  const beginDrag = useCallback((win: FreeKind, e: React.PointerEvent) => {
    e.preventDefault()
    const d: DragState = { win, x: e.clientX, y: e.clientY, target: null, mode: null }
    dragRef.current = d
    setDrag(d)
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-window-kind]') as HTMLElement | null
      let target: DragState['target'] = null
      let mode: DragState['mode'] = null
      if (el) {
        target = el.dataset.windowKind as FreeKind | 'sessions'
        if (target === 'sessions') {
          mode = 'reject' // 左栏固定，禁止落位
        } else if (target !== dragRef.current?.win) {
          const r = el.getBoundingClientRect()
          const fx = (ev.clientX - r.left) / r.width
          const fy = (ev.clientY - r.top) / r.height
          mode =
            fx < EDGE ? 'left'
            : fx > 1 - EDGE ? 'right'
            : fy < EDGE ? 'top'
            : fy > 1 - EDGE ? 'bottom'
            : 'swap'
        }
      }
      const next: DragState = { win, x: ev.clientX, y: ev.clientY, target, mode }
      dragRef.current = next
      setDrag(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const cur = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (cur?.target && cur.target !== 'sessions' && cur.mode && cur.mode !== 'reject') {
        dispatch({ kind: 'drop', win: cur.win, target: cur.target, mode: cur.mode })
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [dispatch])

  /** 分隔条拖动：以所属 split 容器为基准算 ratio */
  const startSplit = (path: number[], e: React.PointerEvent) => {
    e.preventDefault()
    const container = (e.currentTarget as HTMLElement).parentElement
    if (!container) return
    const dir = container.classList.contains('dock-split-col') ? 'col' : 'row'
    const rect = container.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const ratio = dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height
      dispatch({ kind: 'setRatio', path, ratio })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startRailDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const move = (ev: PointerEvent) => dispatch({ kind: 'setRail', width: ev.clientX - 8 })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const closeOf = (kind: FreeKind) => () => {
    if (slots.onCloseRequest?.(kind) === false) return
    dispatch({ kind: 'close', win: kind as Exclude<FreeKind, 'chat'> })
  }
  const minimizeOf = (kind: FreeKind) => () => dispatch({ kind: 'minimize', win: kind })

  const renderNode = (node: FreeNode, path: number[]): React.ReactNode => {
    if (node.t === 'leaf') {
      const kind = node.kind
      const chrome = slots.windowChrome(kind)
      return (
        <WindowFrame
          kind={kind}
          title={chrome.title}
          sub={chrome.sub}
          movable={kind !== 'chat' ? true : true /* chat 可拖；仅左栏 sessions 不可拖 */}
          closable={kind !== 'chat'}
          headerActions={chrome.headerActions}
          onCloseRequest={closeOf(kind)}
          onMinimize={minimizeOf(kind)}
          onBeginDrag={kind !== 'chat' || true ? (e) => beginDrag(kind, e) : undefined}
          dropHint={
            drag?.target === kind ? (drag.mode === 'reject' ? 'reject' : 'target') : null
          }
        >
          {slots.renderWindow(kind)}
        </WindowFrame>
      )
    }
    const style = (isA: boolean) => ({ flexGrow: isA ? node.ratio : 1 - node.ratio, flexBasis: 0 })
    return (
      <div className={`dock-split-${node.dir}`}>
        <div style={style(true)} className="dock-split-child">{renderNode(node.a, [...path, 0])}</div>
        <div className="dock-splitter" data-dir={node.dir} onPointerDown={(e) => startSplit(path, e)} />
        <div style={style(false)} className="dock-split-child">{renderNode(node.b, [...path, 1])}</div>
      </div>
    )
  }

  const visibleKinds: FreeKind[] = []
  const collect = (n: FreeNode | null) => {
    if (!n) return
    if (n.t === 'leaf') visibleKinds.push(n.kind)
    else {
      collect(n.a)
      collect(n.b)
    }
  }
  collect(layout.free)
  const hiddenKinds = layout.openKinds.filter((k) => !visibleKinds.includes(k))

  return (
    <div className="dock">
      {!layout.railCollapsed && (
        <>
          <WindowFrame
            kind="sessions"
            title="会话管理"
            sub={undefined}
            movable={false}
            closable={false}
            onMinimize={() => dispatch({ kind: 'toggleRail' })}
            dropHint={drag?.target === 'sessions' ? 'reject' : null}
          >
            <div style={{ width: layout.rail }} className="dock-rail-inner">{slots.rail}</div>
          </WindowFrame>
          <div className="dock-splitter rail-split" data-dir="row" onPointerDown={startRailDrag} title="左栏宽度（160–320）" />
        </>
      )}
      {layout.railCollapsed && (
        <button className="rail-collapsed-bar" onClick={() => dispatch({ kind: 'toggleRail' })} title="展开会话管理">
          会话管理
        </button>
      )}
      {layout.free && <div className="dock-free" style={{ flex: 1, display: 'flex', minWidth: 0 }}>{renderNode(layout.free, [])}</div>}
      <div className="dock-hidden">
        {hiddenKinds.map((k) => (
          <div key={k}>{slots.renderWindow(k)}</div>
        ))}
      </div>
      {drag && <DragGhost label={drag.win} pos={{ x: drag.x, y: drag.y }} reject={drag.mode === 'reject' || drag.target === 'sessions'} />}
    </div>
  )
}
```

注意：`dock-rail-inner` 需要在 theme.css 补一条（Task 2 的文件追加）：

```css
.dock-rail-inner { width: 100%; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
```

- [ ] **Step 3: 验证（占位窗口）**

本任务暂不接入 App（Task 4 接）。验证方式：`pnpm typecheck` 通过即可；Task 4 完成后一起做浏览器验收。

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/components/dock src/renderer/src/styles/theme.css
git commit -m "feat(ui): Dock 壳层（分割树渲染/分隔条拖宽/标题条拖拽换位）"
```

---

### Task 4: 会话删除（SessionStore.remove + IPC + preload/mock）

**Files:**
- Modify: `src/main/agent/session-store.ts`（新增 `remove(id)`，放在 `sourceFileOf` 附近）
- Modify: `src/shared/types.ts`（`NavAgentApi` 增 `deleteSession`）
- Modify: `src/main/ipc.ts`（注册 `session:delete`）
- Modify: `src/preload/index.ts`、`src/renderer/src/api/mock.ts`
- Test: `src/main/agent/__tests__/session-store.test.ts`（追加用例）

**Interfaces:**
- Produces: `SessionStore.remove(id: string): 'ok' | 'not-found'`；`NavAgentApi.deleteSession(id: string): Promise<'ok' | 'busy' | 'not-found'>`

- [ ] **Step 1: 追加失败测试**（沿用现有 session-store.test.ts 的 tmpdir 构造方式）

```ts
// src/main/agent/__tests__/session-store.test.ts 追加：
describe('remove', () => {
  it('删除会话文件并从列表消失；不存在返回 not-found', () => {
    const store = mkStore() // 复用文件内现有 tmp 目录构造助手
    const a = store.create('/ws', 'm')
    const b = store.create('/ws', 'm')
    expect(store.remove(b.id)).toBe('ok')
    expect(store.list('/ws').map((s) => s.id)).toEqual([a.id])
    expect(store.remove(b.id)).toBe('not-found')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/main/agent/__tests__/session-store.test.ts`
Expected: FAIL（`store.remove is not a function`）

- [ ] **Step 3: 实现 SessionStore.remove**

```ts
// src/main/agent/session-store.ts —— 紧挨 sourceFileOf 之后添加：
  /** 删除会话（jsonl + meta）；文件不存在返回 not-found。当前会话由 IPC 层负责切换 */
  remove(id: string): 'ok' | 'not-found' {
    if (!existsSync(this.sourceFileOf(id))) return 'not-found'
    rmSync(this.sourceFileOf(id), { force: true })
    rmSync(this.metaFileOf(id), { force: true })
    return 'ok'
  }
```

并在文件头部 import 处补：`import { rmSync, existsSync } from 'node:fs'`（与现有 readFileSync/writeFileSync 合并进同一语句即可）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/main/agent/__tests__/session-store.test.ts`
Expected: PASS

- [ ] **Step 5: 类型 + IPC + 桥**

```ts
// src/shared/types.ts —— NavAgentApi 内 listSessions 附近追加：
  /** 删除会话；当前会话运行中返回 busy（IPC 层保证），删除当前会话时自动切到相邻会话 */
  deleteSession(id: string): Promise<'ok' | 'busy' | 'not-found'>
```

```ts
// src/main/ipc.ts —— session:list 之后追加：
  ipcMain.handle('session:delete', (_e, id: string): 'ok' | 'busy' | 'not-found' => {
    if (agent.running && store.getCurrent()?.id === id) return 'busy'
    const r = store.remove(id)
    if (r !== 'ok') return r
    if (store.getCurrent()?.id === id) {
      const rest = store.list(getConfig().workspacePath)
      agent.reset()
      if (rest[0]) {
        const { messages } = store.load(rest[0].id)
        agent.replaceTranscript(messages)
        for (const m of messages) {
          emitAgentEvent({ type: 'message_start', message: m })
          emitAgentEvent({ type: 'message_end', message: m })
        }
      }
    }
    return 'ok'
  })
```

```ts
// src/preload/index.ts —— api 对象内追加：
  deleteSession: (id: string): Promise<'ok' | 'busy' | 'not-found'> => ipcRenderer.invoke('session:delete', id),
```

```ts
// src/renderer/src/api/mock.ts —— MockApi 类内追加（与 listSessions 同区域）：
  async deleteSession(id: string): Promise<'ok' | 'busy' | 'not-found'> {
    this.sessions = this.sessions.filter((s) => s.id !== id)
    return 'ok'
  }
```
（mock.ts 内会话列表字段名以实际为准：找到 `listSessions` 使用的字段，同源过滤。）

- [ ] **Step 6: 全量验证 + 提交**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

```bash
git add -u && git add src/main/agent/session-store.ts
git commit -m "feat(session): 删除会话（busy 保护 + 当前会话自动切换）"
```

---

### Task 5: fs-service（read/write/glob 主进程服务）+ IPC + 桥 + mock

**Files:**
- Create: `src/main/fs-service.ts`
- Test: `src/main/__tests__/fs-service.test.ts`
- Modify: `src/shared/types.ts`、`src/main/ipc.ts`、`src/preload/index.ts`、`src/renderer/src/api/mock.ts`

**Interfaces:**
- Consumes: `resolveWithin`（registry.ts:22）、`globToRegExp/toRel/walkFiles`（walk.ts，glob.ts 同款用法）
- Produces:
  - `looksBinary(buf: Buffer): boolean`、`MAX_READ_BYTES = 1024*1024`、`decideWrite(baseMtime: number|undefined, diskMtime: number): 'ok'|'conflict'`
  - `NavAgentApi.readFile(rel): Promise<FileReadResult>`；`writeFile(rel, content, baseMtime?): Promise<FileWriteResult>`；`globFiles(pattern): Promise<string[]>`；`pickFile(): Promise<string|null>`
  - shared 类型：
    ```ts
    export type FileReadResult =
      | { ok: true; content: string; mtime: number; truncated: boolean }
      | { ok: false; error: 'outside-workspace' | 'not-found' | 'binary' | 'io'; message: string }
    export type FileWriteResult =
      | { ok: true; mtime: number }
      | { ok: false; error: 'conflict' | 'outside-workspace' | 'io'; message: string }
    ```

- [ ] **Step 1: 失败测试**

```ts
// src/main/__tests__/fs-service.test.ts
import { describe, expect, it } from 'vitest'
import { looksBinary, decideWrite, MAX_READ_BYTES } from '../fs-service'

describe('looksBinary', () => {
  it('含 NUL 字节判为二进制', () => {
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true)
  })
  it('正常文本判为文本', () => {
    expect(looksBinary(Buffer.from('中文 console.log("hi")\n'))).toBe(false)
  })
})

describe('decideWrite', () => {
  it('无基线（新文件或强制覆盖）放行', () => {
    expect(decideWrite(undefined, 123)).toBe('ok')
  })
  it('基线与磁盘一致放行', () => {
    expect(decideWrite(123, 123)).toBe('ok')
  })
  it('磁盘 mtime 变化判冲突', () => {
    expect(decideWrite(123, 456)).toBe('conflict')
  })
  it('MAX_READ_BYTES 为 1MB', () => {
    expect(MAX_READ_BYTES).toBe(1024 * 1024)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/main/__tests__/fs-service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 fs-service.ts**

```ts
// src/main/fs-service.ts
import { createReadStream, promises as fsp } from 'node:fs'
import { stat, readFile, writeFile } from 'node:fs/promises'
import type { FileReadResult, FileWriteResult } from '@shared/types'

export const MAX_READ_BYTES = 1024 * 1024

/** 前 8KB 含 NUL 视为二进制 */
export function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192)
  return head.includes(0)
}

/** 写冲突判定：baseMtime 缺省 = 新文件或强制覆盖 */
export function decideWrite(baseMtime: number | undefined, diskMtime: number): 'ok' | 'conflict' {
  if (baseMtime === undefined) return 'ok'
  return baseMtime === diskMtime ? 'ok' : 'conflict'
}

export async function readWorkspaceFile(ws: string, rel: string): Promise<FileReadResult> {
  const abs = resolveWithin(ws, rel)
  if (!abs) return { ok: false, error: 'outside-workspace', message: '路径超出工作区' }
  const st = await stat(abs).catch(() => null)
  if (!st || st.isDirectory()) return { ok: false, error: 'not-found', message: '文件不存在' }
  const truncated = st.size > MAX_READ_BYTES
  try {
    const buf = await readFile(abs)
    if (looksBinary(buf)) return { ok: false, error: 'binary', message: '二进制文件不支持查看' }
    const content = truncated ? buf.subarray(0, MAX_READ_BYTES).toString('utf-8') : buf.toString('utf-8')
    return { ok: true, content, mtime: st.mtimeMs, truncated }
  } catch (err) {
    return { ok: false, error: 'io', message: err instanceof Error ? err.message : String(err) }
  }
}

export async function writeWorkspaceFile(ws: string, rel: string, content: string, baseMtime?: number): Promise<FileWriteResult> {
  const abs = resolveWithin(ws, rel)
  if (!abs) return { ok: false, error: 'outside-workspace', message: '路径超出工作区' }
  const st = await stat(abs).catch(() => null)
  if (st && st.isDirectory()) return { ok: false, error: 'io', message: '目标是目录' }
  if (decideWrite(baseMtime, st?.mtimeMs ?? 0) === 'conflict') {
    return { ok: false, error: 'conflict', message: '文件已被外部修改（可能是 agent 写入）' }
  }
  try {
    await writeFile(abs, content, 'utf-8')
    const after = await stat(abs)
    return { ok: true, mtime: after.mtimeMs }
  } catch (err) {
    return { ok: false, error: 'io', message: err instanceof Error ? err.message : String(err) }
  }
}

function resolveWithin(ws: string, rel: string): string | null {
  // 复用工具层实现，避免循环依赖：直接 import
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./tools/registry').resolveWithin(ws, rel)
}

export async function globWorkspace(ws: string, pattern: string): Promise<string[]> {
  const { globToRegExp, toRel, walkFiles } = await import('./tools/walk')
  let re: RegExp
  try {
    re = globToRegExp(pattern)
  } catch {
    return []
  }
  const out: string[] = []
  for await (const abs of walkFiles(ws, '.', 5000)) {
    const rel = toRel(ws, abs)
    if (re.test(rel) || (!pattern.includes('/') && re.test(rel.split('/').pop() ?? ''))) {
      out.push(rel)
      if (out.length >= 200) break
    }
  }
  return out
}
```

注意：`resolveWithin` 请改成顶部正常 import（`import { resolveWithin } from './tools/registry'`），上面 wrapper 写法仅为示意，直接使用顶部导入即可，删掉 require 包装。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/main/__tests__/fs-service.test.ts`
Expected: PASS

- [ ] **Step 5: IPC + 类型 + 桥 + mock**

```ts
// src/shared/types.ts —— DirEntry 定义后追加 FileReadResult/FileWriteResult（见上方 Interfaces）；
// NavAgentApi 追加：
  /** 读工作区文件（文本；>1MB 截断 truncated=true；二进制返回 error） */
  readFile(rel: string): Promise<FileReadResult>
  /** 写工作区文件；baseMtime 缺省 = 强制覆盖；外部已改返回 conflict */
  writeFile(rel: string, content: string, baseMtime?: number): Promise<FileWriteResult>
  /** 工作区内 glob 搜索，返回相对路径（≤200 条） */
  globFiles(pattern: string): Promise<string[]>
  /** 系统文件选择器（限工作区内文件），取消返回 null */
  pickFile(): Promise<string | null>
```

```ts
// src/main/ipc.ts —— fs:listDir 之后追加：
  ipcMain.handle('fs:read', (_e, rel: string) => readWorkspaceFile(getConfig().workspacePath, String(rel ?? '')))
  ipcMain.handle('fs:write', (_e, rel: string, content: string, baseMtime?: number) =>
    writeWorkspaceFile(getConfig().workspacePath, String(rel ?? ''), String(content ?? ''), typeof baseMtime === 'number' ? baseMtime : undefined)
  )
  ipcMain.handle('fs:glob', (_e, pattern: string) =>
    typeof pattern === 'string' && pattern.trim() ? globWorkspace(getConfig().workspacePath, pattern.trim()) : []
  )
  ipcMain.handle('file:pick', async (): Promise<string | null> => {
    const ws = getConfig().workspacePath
    if (!ws) return null
    const res = await dialog.showOpenDialog({ defaultPath: ws, properties: ['openFile'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return toRel(ws, res.filePaths[0]!)
  })
```
（`toRel` 从 `./tools/walk` import；`readWorkspaceFile/writeWorkspaceFile/globWorkspace` 从 `./fs-service` import。）

```ts
// src/preload/index.ts —— api 追加：
  readFile: (rel: string) => ipcRenderer.invoke('fs:read', rel),
  writeFile: (rel: string, content: string, baseMtime?: number) => ipcRenderer.invoke('fs:write', rel, content, baseMtime),
  globFiles: (pattern: string) => ipcRenderer.invoke('fs:glob', pattern),
  pickFile: () => ipcRenderer.invoke('file:pick'),
```

```ts
// src/renderer/src/api/mock.ts —— 追加（dev:web 可演示读写内存态）：
  #mem = new Map<string, { content: string; mtime: number }>()
  async readFile(rel: string): Promise<FileReadResult> {
    const hit = this.#mem.get(rel)
    if (!hit) return { ok: false, error: 'not-found', message: 'mock 中不存在' }
    return { ok: true, content: hit.content, mtime: hit.mtime, truncated: false }
  }
  async writeFile(rel: string, content: string, baseMtime?: number): Promise<FileWriteResult> {
    const hit = this.#mem.get(rel)
    if (hit && baseMtime !== undefined && baseMtime !== hit.mtime) return { ok: false, error: 'conflict', message: 'mock 冲突' }
    const mtime = Date.now()
    this.#mem.set(rel, { content, mtime })
    return { ok: true, mtime }
  }
  async globFiles(pattern: string): Promise<string[]> {
    const re = new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.'))
    return [...this.#mem.keys()].filter((k) => re.test(k)).slice(0, 200)
  }
  async pickFile(): Promise<string | null> { return null }
```
（mock 私有字段风格以该文件现状为准，必要时改为普通属性。）

- [ ] **Step 6: 全量验证 + 提交**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

```bash
git add src/main/fs-service.ts src/main/__tests__/fs-service.test.ts src/shared/types.ts src/main/ipc.ts src/preload/index.ts src/renderer/src/api/mock.ts
git commit -m "feat(fs): 工作区文件读写/glob 服务（mtime 冲突 + 二进制/超限防护）"
```

---

### Task 6: RailSessions（会话管理左栏内容）+ Files 窗口组件

**Files:**
- Create: `src/renderer/src/components/RailSessions.tsx`（承接 Sidebar.tsx 的会话半区 + 删除按钮）
- Create: `src/renderer/src/components/FilesWindow.tsx`（承接 Sidebar.tsx 的文件树半区 + 搜索/glob + 复制路径）
- Modify: `src/renderer/src/components/Sidebar.tsx`（Task 7 从 App 移除引用后整文件删除）

**Interfaces:**
- Consumes: `api.deleteSession/listSessions/newSession/switchSession/listDir/globFiles/readFile?（否）`、`DirEntry`
- Produces:
  - `RailSessions({ sessions, currentSessionId, working, onNew, onSwitch, onDelete, onOpenTree, onExport, onImport })`
  - `FilesWindow({ workspacePath, onOpenFile })`

- [ ] **Step 1: RailSessions.tsx**（groupLabel/relTime 从 Sidebar.tsx 原样搬来）

```tsx
// src/renderer/src/components/RailSessions.tsx
import { useState } from 'react'
import type { SessionMeta } from '@shared/types'

// groupLabel / relTime：从 src/renderer/src/components/Sidebar.tsx:19-37 原样复制

interface Props {
  sessions: SessionMeta[]
  currentSessionId: string
  working: boolean
  onNew: () => void
  onSwitch: (id: string) => void
  /** 删除（内部 confirm 确认后回调） */
  onDelete: (id: string) => void
  onOpenTree: () => void
  onExport: (id: string) => void
  onImport: () => void
}

export function RailSessions(p: Props) {
  const [query, setQuery] = useState('')
  const filtered = p.sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
  const groups: { label: string; items: SessionMeta[] }[] = []
  for (const s of filtered) {
    const label = groupLabel(s.updatedAt)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(s)
    else groups.push({ label, items: [s] })
  }
  return (
    <>
      <button className="btn btn-primary new-chat" disabled={p.working} onClick={p.onNew}>＋ 新建对话</button>
      <div className="search sunken">
        <span className="search-icon">🔍</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索会话" />
      </div>
      <button className="btn btn-ghost branch-entry" disabled={p.working || !p.currentSessionId} onClick={p.onOpenTree} title="浏览当前会话的分支树">
        ⑂ 分支树
      </button>
      <div className="session-head">
        <span className="session-group-label">会话</span>
        <button className="btn btn-ghost" disabled={p.working} onClick={p.onImport} title="从 JSONL 文件导入会话">导入</button>
      </div>
      <div className="session-list">
        {groups.length === 0 && <div className="session-empty">暂无会话</div>}
        {groups.map((g) => (
          <div key={g.label} className="session-group">
            <div className="session-group-label">{g.label}</div>
            {g.items.map((s) => (
              <div key={s.id} className="session-entry">
                <button
                  className={`session-item ${s.id === p.currentSessionId ? 'active' : ''}`}
                  disabled={p.working}
                  onClick={() => p.onSwitch(s.id)}
                  title={s.title}
                >
                  <span className="session-title">{s.title}</span>
                  <span className="session-time">{relTime(s.updatedAt)}</span>
                </button>
                <button className="icon-btn raised small session-export" disabled={p.working} onClick={() => p.onExport(s.id)} title="导出">⇩</button>
                <button
                  className="icon-btn raised small session-export"
                  disabled={p.working}
                  onClick={() => {
                    if (window.confirm(`删除会话「${s.title}」？此操作不可恢复。`)) p.onDelete(s.id)
                  }}
                  title="删除会话"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
```

- [ ] **Step 2: FilesWindow.tsx**

```tsx
// src/renderer/src/components/FilesWindow.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { getApi } from '../api'
import type { DirEntry } from '../api/types'

interface Props {
  workspacePath: string
  /** 点击文件 → File 窗口打开 */
  onOpenFile: (rel: string) => void
}

export function FilesWindow({ workspacePath, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<string[] | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const debounce = useRef<number | undefined>(undefined)

  const loadDir = (path: string) => {
    setChildren((c) => {
      if (c[path]) return c
      void getApi()
        .listDir(path)
        .then((entries) => setChildren((prev) => ({ ...prev, [path]: entries })))
      return c
    })
  }

  useEffect(() => {
    setExpanded(new Set())
    setChildren({})
    loadDir('')
    setQuery('')
    setHits(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        loadDir(path)
      }
      return next
    })
  }

  const copyPath = (rel: string) => {
    void navigator.clipboard.writeText(rel)
    setCopied(rel)
    window.setTimeout(() => setCopied(null), 800)
  }

  /** 搜索：≥2 字符即时 glob（防抖 300ms）；清空回到树视图 */
  const onQuery = (v: string) => {
    setQuery(v)
    window.clearTimeout(debounce.current)
    if (v.trim().length < 2) {
      setHits(null)
      return
    }
    debounce.current = window.setTimeout(() => {
      void getApi()
        .globFiles(`**/*${v.trim()}*`)
        .then(setHits)
    }, 300)
  }

  const renderDir = (path: string, depth: number): React.ReactNode[] => {
    const entries = children[path] ?? []
    return entries.map((entry) => {
      const full = path ? `${path}/${entry.name}` : entry.name
      if (entry.type === 'dir') {
        const open = expanded.has(full)
        return (
          <div key={full}>
            <div className="files-row" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => toggleDir(full)}>
              <span className="caret">{open ? '▾' : '▸'}</span>
              <span className="name">{entry.name}</span>
              <button className="copy-path" title="复制路径" onClick={(e) => { e.stopPropagation(); copyPath(full) }}>
                {copied === full ? '✓' : '⧉'}
              </button>
            </div>
            {open && renderDir(full, depth + 1)}
          </div>
        )
      }
      return (
        <div key={full} className="files-row is-file" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => onOpenFile(full)} title="打开到 File 窗口">
          <span className="caret" />
          <span className="name">{entry.name}</span>
          <button className="copy-path" title="复制路径" onClick={(e) => { e.stopPropagation(); copyPath(full) }}>
            {copied === full ? '✓' : '⧉'}
          </button>
        </div>
      )
    })
  }

  const hitsView = useMemo(
    () =>
      hits === null ? null : (
        <div className="files-body">
          {hits.length === 0 && <div className="files-empty">无匹配文件</div>}
          {hits.map((h) => (
            <div key={h} className="files-row is-file" onClick={() => onOpenFile(h)}>
              <span className="caret" />
              <span className="name mono">{h}</span>
              <button className="copy-path" title="复制路径" onClick={(e) => { e.stopPropagation(); copyPath(h) }}>
                {copied === h ? '✓' : '⧉'}
              </button>
            </div>
          ))}
        </div>
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hits, copied]
  )

  return (
    <>
      <div className="files-toolbar">
        <div className="files-search">
          <span>⌕</span>
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onQuery('')
            }}
            placeholder="搜索文件名（≥2 字符）…"
          />
          {query && (
            <button className="win-btn" onClick={() => onQuery('')} title="清除">
              ✕
            </button>
          )}
        </div>
        <button
          className="win-btn"
          title="刷新"
          onClick={() => {
            setChildren({})
            loadDir('')
          }}
        >
          ⟳
        </button>
      </div>
      {hitsView ?? (
        <div className="files-body">
          {renderDir('', 0)}
          {Object.keys(children).length === 0 && <div className="files-empty">加载中…</div>}
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 3: 验证 + 提交**

Run: `pnpm typecheck`
Expected: PASS（本任务组件尚未挂载属正常）

```bash
git add src/renderer/src/components/RailSessions.tsx src/renderer/src/components/FilesWindow.tsx
git commit -m "feat(ui): 会话管理左栏内容 + Files 目录窗口（搜索/复制/打开）"
```

---

### Task 7: File 内容窗口（CodeMirror 6 + 保存/冲突/查找）

**Files:**
- Modify: `package.json`（dependencies 增 `codemirror`、`@codemirror/lang-javascript`、`@codemirror/lang-json`、`@codemirror/lang-markdown`、`@codemirror/lang-python`、`@codemirror/lang-html`、`@codemirror/lang-css`）
- Create: `src/renderer/src/components/FileWindow.tsx`

**Interfaces:**
- Consumes: `api.readFile/writeFile`（Task 5）
- Produces: `FileWindow({ path, reloadKey, onDirtyChange, forceWriteRef })` —— `path` 变化即加载新文件（单例替换内容）；`onDirtyChange(dirty)` 供关闭确认；`forceWriteRef` 是 `{ current: () => void }`，App 的关闭确认「放弃修改」时无需用到（关闭即丢），仅内部用

- [ ] **Step 1: 安装依赖**

```bash
pnpm add codemirror @codemirror/lang-javascript @codemirror/lang-json @codemirror/lang-markdown @codemirror/lang-python @codemirror/lang-html @codemirror/lang-css
```

- [ ] **Step 2: 实现 FileWindow.tsx**

```tsx
// src/renderer/src/components/FileWindow.tsx
import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import type { FileReadResult } from '@shared/types'
import { getApi } from '../api'
import { MiniDialog } from './dock/WindowFrame'

interface Props {
  path: string
  /** 外部要求重载（如重新打开同路径）时 +1 */
  reloadKey: number
  onDirtyChange: (dirty: boolean) => void
}

async function languageFor(path: string) {
  const ext = path.split('.').pop() ?? ''
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true })
    case 'ts': case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true })
    case 'json': return (await import('@codemirror/lang-json')).json()
    case 'md': return (await import('@codemirror/lang-markdown')).markdown()
    case 'py': return (await import('@codemirror/lang-python')).python()
    case 'html': case 'htm': return (await import('@codemirror/lang-html')).html()
    case 'css': return (await import('@codemirror/lang-css')).css()
    default: return null
  }
}

/** 冲突对话框语义：覆盖=以我的为准强制写；重新加载=放弃我的改动读盘 */
type ConflictKind = 'external-write' | 'external-focus'

export function FileWindow({ path, reloadKey, onDirtyChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const baseMtime = useRef(0)
  const [dirty, setDirty] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictKind | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const save = async (force = false): Promise<void> => {
    const view = viewRef.current
    if (!view) return
    const r = await getApi().writeFile(path, view.state.doc.toString(), force ? undefined : baseMtime.current)
    if (r.ok) {
      baseMtime.current = r.mtime
      setDirty(false)
      setBanner(null)
    } else if (r.error === 'conflict') {
      setConflict('external-write')
    } else {
      setBanner(`保存失败：${r.message}`)
    }
  }

  // 挂载/切换文件：加载 → 建 EditorView
  useEffect(() => {
    let disposed = false
    const doc0 = ''
    void (async () => {
      const r: FileReadResult = await getApi().readFile(path)
      if (disposed) return
      if (!r.ok) {
        setFailed(r.message)
        return
      }
      setFailed(null)
      baseMtime.current = r.mtime
      setDirty(false)
      setBanner(r.truncated ? '文件超过 1MB，仅显示前 1MB（只读）' : null)
      const lang = await languageFor(path)
      if (disposed || !host.current) return
      viewRef.current?.destroy()
      const readonly = r.truncated
      viewRef.current = new EditorView({
        state: EditorState.create({
          doc: r.content,
          extensions: [
            basicSetup,
            ...(lang ? [lang] : []),
            EditorState.readOnly.of(readonly),
            EditorView.editable.of(!readonly),
            keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (void save(), true) }]),
            EditorView.updateListener.of((v) => {
              if (v.docChanged && !readonly) {
                setDirty(true)
                onDirtyChange(true)
              }
            })
          ]
        }),
        parent: host.current
      })
    })()
    return () => {
      disposed = true
      viewRef.current?.destroy()
      viewRef.current = null
      setDirty(false)
      onDirtyChange(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadKey])

  // 窗口聚焦时检查外部变更
  useEffect(() => {
    const onFocus = () => {
      void (async () => {
        if (viewRef.current === null) return
        const r = await getApi().readFile(path)
        if (r.ok && r.mtime !== baseMtime.current && !dirty) {
          // 无本地改动：静默重载
          viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: r.content } })
          baseMtime.current = r.mtime
        } else if (r.ok && r.mtime !== baseMtime.current && dirty) {
          setConflict('external-focus')
        }
      })()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [path, dirty])

  const reload = () => {
    setConflict(null)
    // 触发重建：递增由 App 控制；这里直接重读替换文档
    void (async () => {
      const r = await getApi().readFile(path)
      if (r.ok && viewRef.current) {
        viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: r.content } })
        baseMtime.current = r.mtime
        setDirty(false)
        onDirtyChange(false)
      }
    })()
  }

  const copyAll = () => {
    const view = viewRef.current
    if (view) void navigator.clipboard.writeText(view.state.sliceDoc(0, view.state.doc.length))
  }

  if (failed) {
    return <div className="files-empty" style={{ padding: 20 }}>无法打开：{failed}</div>
  }

  return (
    <>
      <div className="file-toolbar">
        <span className="file-search-hint" title="CodeMirror 内建查找">⌕ Ctrl+F 文件内查找 · Mod+S 保存</span>
        <button onClick={copyAll} title="复制全文">⧉ 复制</button>
        <button
          className={dirty ? 'save-dirty' : ''}
          onClick={() => void save()}
          title={dirty ? '保存（有未保存修改）' : '已保存'}
        >
          {dirty ? '● 保存' : '💾 已保存'}
        </button>
      </div>
      {banner && <div className="file-banner">{banner}</div>}
      <div className="file-editor-host" ref={host} />
      {conflict && (
        <MiniDialog
          title="文件已被外部修改"
          text={
            conflict === 'external-write'
              ? '保存时发现磁盘上的文件比你打开时新（可能是 agent 写入的）。'
              : '你本地的未保存修改与磁盘新内容不一致。'
          }
          actions={[
            { label: '取消', onClick: () => setConflict(null) },
            { label: '重新加载（放弃我的修改）', onClick: reload },
            { label: '覆盖磁盘（以我的为准）', primary: true, onClick: () => { setConflict(null); void save(true) } }
          ]}
        />
      )}
    </>
  )
}
```

- [ ] **Step 3: 验证 + 提交**

Run: `pnpm typecheck && pnpm dev:web`（File 窗口 Task 9 接入后可视化验收）
Expected: typecheck PASS

```bash
git add package.json pnpm-lock.yaml src/renderer/src/components/FileWindow.tsx
git commit -m "feat(ui): File 内容窗口（CM6 编辑/保存/冲突三选/查找/复制）"
```

---

### Task 8: 主进程 TerminalService（node-pty）+ IPC + onUiEvent 通道

**Files:**
- Modify: `package.json`（dependencies 增 `node-pty`）
- Create: `src/main/terminal.ts`
- Modify: `src/shared/types.ts`（`UiEvent` + `onUiEvent` + pty 四方法）
- Modify: `src/main/ipc.ts`（pty handlers + `emitUiEvent`）
- Modify: `src/main/index.ts`（实例化 + 退出清理）
- Modify: `src/preload/index.ts`、`src/renderer/src/api/mock.ts`

**Interfaces:**
- Produces:
  - shared：`export type UiEvent = { type: 'pty_data'; id: string; chunk: string } | { type: 'pty_exit'; id: string; exitCode: number }`
  - `NavAgentApi.ptyCreate(): Promise<string|null>` / `ptyWrite(id,data)` / `ptyResize(id,cols,rows)` / `ptyKill(id)` / `onUiEvent(cb): () => void`
  - main：`class TerminalService { create(cwd, onData, onExit): string|null; write(id,data); resize(id,cols,rows); kill(id); killAll(): void }`

- [ ] **Step 1: 安装依赖**

```bash
pnpm add node-pty
pnpm rebuild node-pty   # Electron 原生模块对齐（如 pnpm 报 ABI 警告则执行）
```
electron-vite 默认把 `dependencies` 视为 main/preload 的 external，无需改 `electron.vite.config.ts`。

- [ ] **Step 2: 实现 terminal.ts**

```ts
// src/main/terminal.ts
import * as pty from 'node-pty'

export interface PtyCallbacks {
  onData: (id: string, chunk: string) => void
  onExit: (id: string, exitCode: number) => void
}

/** 真终端服务：每个终端一个 PTY 会话；永不 throw（spawn 失败返回 null，UI 呈错误态） */
export class TerminalService {
  private terms = new Map<string, pty.IPty>()

  create(cwd: string, cb: PtyCallbacks): string | null {
    try {
      const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash')
      const id = `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as Record<string, string>
      })
      term.onData((chunk) => cb.onData(id, chunk))
      term.onExit(({ exitCode }) => {
        this.terms.delete(id)
        cb.onExit(id, exitCode)
      })
      this.terms.set(id, term)
      return id
    } catch {
      return null
    }
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const c = Math.max(2, Math.min(500, Math.round(cols)))
    const r = Math.max(2, Math.min(300, Math.round(rows)))
    this.terms.get(id)?.resize(c, r)
  }

  kill(id: string): void {
    this.terms.get(id)?.kill()
    this.terms.delete(id)
  }

  killAll(): void {
    for (const t of this.terms.values()) {
      try {
        t.kill()
      } catch {
        /* 已退出忽略 */
      }
    }
    this.terms.clear()
  }
}
```

- [ ] **Step 3: shared 类型 + IPC + index.ts + 桥 + mock**

```ts
// src/shared/types.ts —— AgentEvent 附近（独立区域）追加：
/** UI 事件（非 agent 契约）：PTY 数据/退出。独立通道 navagent:uiEvent */
export type UiEvent =
  | { type: 'pty_data'; id: string; chunk: string }
  | { type: 'pty_exit'; id: string; exitCode: number }
```
`NavAgentApi` 追加：
```ts
  /** 新建终端（PTY）；失败返回 null（spawn 错误编码进返回值） */
  ptyCreate(): Promise<string | null>
  ptyWrite(id: string, data: string): Promise<void>
  ptyResize(id: string, cols: number, rows: number): Promise<void>
  ptyKill(id: string): Promise<void>
  /** UI 事件订阅（PTY 等）；返回解绑函数 */
  onUiEvent(cb: (e: UiEvent) => void): () => void
```

```ts
// src/main/ipc.ts —— emitAgentEvent 旁追加：
import type { UiEvent } from '@shared/types'
export function emitUiEvent(event: UiEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('navagent:uiEvent', event)
  }
}
```
`registerIpc` deps 增加 `terminals: TerminalService`，注册：
```ts
  ipcMain.handle('pty:create', (): string | null =>
    terminals.create(getConfig().workspacePath || app.getPath('home'), {
      onData: (id, chunk) => emitUiEvent({ type: 'pty_data', id, chunk }),
      onExit: (id, exitCode) => emitUiEvent({ type: 'pty_exit', id, exitCode })
    })
  )
  ipcMain.handle('pty:write', (_e, id: string, data: string) => terminals.write(String(id), String(data ?? '')))
  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) => terminals.write; /* 见下 */)
```
最后一行实为：
```ts
  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
    terminals.resize(String(id), Number(cols) || 80, Number(rows) || 24)
  )
  ipcMain.handle('pty:kill', (_e, id: string) => terminals.kill(String(id)))
```

```ts
// src/main/index.ts —— registerIpc 调用处：
import { TerminalService } from './terminal'
const terminals = new TerminalService()
app.on('will-quit', () => terminals.killAll())
// registerIpc({ ..., terminals })   ← deps 对象加一个字段
```

```ts
// src/preload/index.ts —— api 追加：
  ptyCreate: () => ipcRenderer.invoke('pty:create'),
  ptyWrite: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyKill: (id: string) => ipcRenderer.invoke('pty:kill', id),
  onUiEvent: (cb: (e: UiEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, event: UiEvent): void => cb(event)
    ipcRenderer.on('navagent:uiEvent', handler)
    return () => ipcRenderer.removeListener('navagent:uiEvent', handler)
  },
```
（顶部 type import 补 `UiEvent`。）

```ts
// src/renderer/src/api/mock.ts —— 追加（dev:web 明确降级）：
  async ptyCreate(): Promise<string | null> { return null }
  async ptyWrite(): Promise<void> {}
  async ptyResize(): Promise<void> {}
  async ptyKill(): Promise<void> {}
  onUiEvent(): () => void { return () => {} }
```

- [ ] **Step 4: 验证 + 提交**

Run: `pnpm typecheck`
Expected: PASS

```bash
pnpm exec electron-vite build   # 验证 node-pty 被正确 externalize（main 产物不内联）
git add package.json pnpm-lock.yaml src/main/terminal.ts src/shared/types.ts src/main/ipc.ts src/main/index.ts src/preload/index.ts src/renderer/src/api/mock.ts
git commit -m "feat(terminal): node-pty 服务 + 独立 onUiEvent 通道"
```

---

### Task 9: Terminal 窗口组件（xterm 多标签）

**Files:**
- Modify: `package.json`（dependencies 增 `@xterm/xterm`、`@xterm/addon-fit`）
- Modify: `src/renderer/src/main.tsx`（`import '@xterm/xterm/css/xterm.css'`）
- Create: `src/renderer/src/components/TerminalWindow.tsx`

**Interfaces:**
- Consumes: Task 8 的 pty API 与 `onUiEvent`
- Produces: `TerminalWindow()`（无 props；内部自管标签）

- [ ] **Step 1: 安装 + 样式引入**

```bash
pnpm add @xterm/xterm @xterm/addon-fit
```
```tsx
// src/renderer/src/main.tsx —— import 区追加：
import '@xterm/xterm/css/xterm.css'
```

- [ ] **Step 2: 实现 TerminalWindow.tsx**

```tsx
// src/renderer/src/components/TerminalWindow.tsx
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getApi } from '../api'

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
          ＋
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
```

- [ ] **Step 3: 验证 + 提交**

Run: `pnpm typecheck && pnpm exec electron-vite build`
Expected: PASS

```bash
git add package.json pnpm-lock.yaml src/renderer/src/main.tsx src/renderer/src/components/TerminalWindow.tsx
git commit -m "feat(ui): Terminal 窗口（xterm 多标签，隐藏层保活缓冲）"
```

---

### Task 10: App 接入 Dock + Composer 信息条 + ToolBlock 路径点击 + TopBar 主题切换

**Files:**
- Modify: `src/renderer/src/App.tsx`（重写布局装配）
- Modify: `src/renderer/src/components/Composer.tsx`（meta 信息条）
- Modify: `src/renderer/src/components/ToolBlock.tsx`（路径可点）
- Modify: `src/renderer/src/components/Transcript.tsx`（透传 `onOpenPath`）
- Modify: `src/renderer/src/components/TopBar.tsx`（主题切换按钮）
- Modify: `src/renderer/src/components/StatusBar.tsx`（☰ → toggleRail）
- Delete: `src/renderer/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: 前面全部任务的产物

- [ ] **Step 1: Composer 信息条**

`Props` 增加：
```ts
  model: string
  thinking: ThinkingLevel | undefined
  onSetThinking: (l: ThinkingLevel) => void
  onOpenSettings: () => void
  /** 上下文口径：contextTokensOf(usage) 与 config.contextWindow */
  contextTokens: number | null
  contextWindow?: number
```
在 `.composer-box` 内 textarea 之后（send 按钮之前）插入：
```tsx
        <div className="composer-meta">
          <button className="meta-chip" onClick={onOpenSettings} title="点击修改模型设置">
            {model} ▾
          </button>
          <select
            className="meta-chip thinking-active"
            value={thinking ?? ''}
            onChange={(e) => onSetThinking(e.target.value as ThinkingLevel)}
            title="思考深度（thinking level）"
          >
            <option value="">🧠 默认</option>
            {(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as ThinkingLevel[]).map((l) => (
              <option key={l} value={l}>
                🧠 {l}
              </option>
            ))}
          </select>
          {contextTokens != null && (
            <span className={`meta-ctx${pct > 80 ? ' warn' : ''}`} title="/compact 可压缩上下文">
              <span className="bar">
                <i style={{ width: `${Math.min(100, pct)}%` }} />
              </span>
              {(contextTokens / 1000).toFixed(1)}k/{((contextWindow ?? 64_000) / 1000).toFixed(0)}k
            </span>
          )}
          <span className="meta-spacer" />
        </div>
```
（组件内 `const pct = contextWindow && contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 100) : 0`；顶部 import `ThinkingLevel` 类型。）

- [ ] **Step 2: ToolBlock 路径可点**

```tsx
// ToolBlock.tsx：Props 改为 { tool, onOpenPath? }；
const PATH_TOOLS = new Set(['read_file', 'edit_file', 'write_file'])
// summarize 不动；按钮行内 tool-args 处：
        {PATH_TOOLS.has(tool.name) && argsPath ? (
          <span className="tool-args mono clickable" onClick={() => onOpenPath?.(argsPath)} title="在 File 窗口打开">
            {argsPath}
          </span>
        ) : (
          <span className="tool-args mono">{summarize(tool)}</span>
        )}
```
其中 `argsPath` = `(() => { try { const a = JSON.parse(tool.args); return typeof a.path === 'string' ? a.path : null } catch { return null } })()`。

`Transcript.tsx`：`Props` 增加 `onOpenPath?: (p: string) => void`，透传给每个 `<ToolBlock>`。

- [ ] **Step 3: TopBar 主题切换**

`Props` 增加 `theme: 'light' | 'dark'`、`onToggleTheme: () => void`；topbar-right 最前面加：
```tsx
        <button className="icon-btn theme-btn" onClick={onToggleTheme} title={theme === 'light' ? '切换暗色' : '切换明亮'}>
          {theme === 'light' ? '☾' : '☀'}
        </button>
```

- [ ] **Step 4: StatusBar 的 ☰ 改接左栏**

`Props` 的 `collapsed/onToggleSidebar` 语义改为 `railCollapsed/onToggleRail`（只改名字与 title），组件体不变。

- [ ] **Step 5: App.tsx 装配（完整替换 return 之前的布局部分）**

关键新增状态与逻辑（顶部 import：`layoutReducer, loadLayout, saveLayout, defaultLayout, type LayoutState, type LayoutAction, type FreeKind`、新组件）：

```tsx
  const [layout, layoutDispatch] = useReducer(layoutReducer, undefined, loadLayout)
  const [fileWin, setFileWin] = useState<{ path: string; key: number } | null>(null)
  const [fileDirty, setFileDirty] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = layout.theme
    saveLayout(layout)
  }, [layout])

  const layoutApi = {
    open: (win: Exclude<FreeKind, 'chat'>) => layoutDispatch({ kind: 'open', win }),
    theme: layout.theme,
    toggleTheme: () => layoutDispatch({ kind: 'setTheme', theme: layout.theme === 'light' ? 'dark' : 'light' }),
    toggleRail: () => layoutDispatch({ kind: 'toggleRail' }),
    railCollapsed: layout.railCollapsed
  }

  /** 打开文件到唯一 File 窗口：已关则开、已最小化则恢复、显示中则换内容 */
  const openFile = (path: string) => {
    setFileWin((f) => (f?.path === path ? { path, key: f.key + 1 } : { path, key: (f?.key ?? 0) + 1 }))
    layoutDispatch({ kind: 'open', win: 'file' })
  }

  const handleDeleteSession = async (id: string) => {
    const r = await api.deleteSession(id)
    if (r === 'busy') return
    const list = await api.listSessions(config?.workspacePath ?? '')
    setSessions(list)
    if (id === currentSessionId) {
      dispatch({ kind: 'reset' })
      const next = list[0]?.id ?? ''
      setCurrentSessionId(next)
      if (next) await api.switchSession(next)
    }
  }
```

`return` 的 JSX 骨架（略去与现版相同的 overlay 部分）：

```tsx
  return (
    <div className="app">
      <TopBar
        config={config}
        working={working}
        theme={layout.theme}
        onToggleTheme={layoutApi.toggleTheme}
        onSwitchProject={(p) => void handleSwitchProject(p)}
        onPickFolder={() => void handlePickFolder()}
        onOpenSettings={() => setSettingsOpen(true)}
        onSetThinking={(l) => void handleSetThinking(l)}
      />
      {showTrust && (/* 原 trust-banner 原样保留 */)}
      <DockRoot
        layout={layout}
        dispatch={layoutDispatch}
        slots={{
          rail: (
            <RailSessions
              sessions={sessions}
              currentSessionId={currentSessionId}
              working={working}
              onNew={() => void handleNewSession()}
              onSwitch={(id) => void handleSwitchSession(id)}
              onDelete={(id) => void handleDeleteSession(id)}
              onOpenTree={() => setTreeOpen(true)}
              onExport={(id) => void handleExport(id)}
              onImport={() => void handleImport()}
            />
          ),
          windowChrome: (kind) => {
            if (kind === 'chat')
              return {
                title: '聊天',
                locked: true,
                headerActions: (
                  <>
                    <button className="win-btn open-btn" onClick={() => layoutApi.open('files')}>＋ Files</button>
                    <button className="win-btn open-btn" onClick={() => void (async () => { const p = await api.pickFile(); if (p) openFile(p) })()}>＋ File</button>
                    <button className="win-btn open-btn" onClick={() => layoutApi.open('terminal')}>＋ Terminal</button>
                  </>
                )
              }
            if (kind === 'files') return { title: 'Files', sub: '目录', locked: false }
            if (kind === 'file') return { title: 'File', sub: fileWin ? fileWin.path.split(/[\\/]/).pop() : '', locked: false }
            return { title: 'Terminal', locked: false }
          },
          renderWindow: (kind) => {
            if (kind === 'chat')
              return (
                <>
                  <Transcript state={state} onChip={(t) => setDraft(t)} permission={state.permission} onRespond={(d) => void handlePermission(d)} onOpenPath={openFile} />
                  <Composer
                    draft={draft}
                    setDraft={setDraft}
                    working={working}
                    onSend={handleSend}
                    onFollowUp={handleFollowUp}
                    onCancel={handleCancel}
                    model={config.model}
                    thinking={config.modelParams?.thinkingLevel}
                    onSetThinking={(l) => void handleSetThinking(l)}
                    onOpenSettings={() => setSettingsOpen(true)}
                    contextTokens={state.usage ? contextTokensOf(state.usage) : null}
                    contextWindow={config.contextWindow}
                  />
                </>
              )
            if (kind === 'files') return <FilesWindow workspacePath={config.workspacePath} onOpenFile={openFile} />
            if (kind === 'file')
              return fileWin ? (
                <FileWindow key={fileWin.key} path={fileWin.path} reloadKey={fileWin.key} onDirtyChange={setFileDirty} />
              ) : (
                <div className="files-empty">从左侧文件树或聊天中的文件路径打开文件</div>
              )
            return <TerminalWindow />
          },
          onCloseRequest: (kind) => {
            if (kind === 'file' && fileDirty) {
              return window.confirm('File 窗口有未保存修改，确定关闭（丢弃修改）？')
            }
            return true
          }
        }}
      />
      <StatusBar
        railCollapsed={layout.railCollapsed}
        onToggleRail={layoutApi.toggleRail}
        model={config.model}
        usage={state.usage}
        working={working}
        queued={state.queued}
        contextWindow={config.contextWindow}
        stats={state.stats}
        onOpenStats={() => setCostOpen(true)}
      />
      {/* SettingsOverlay / TreeOverlay / CostOverlay 原样保留 */}
    </div>
  )
```

同时：
- `sidebarOpen` state 删除；`Sidebar` import 与使用删除；删除 `src/renderer/src/components/Sidebar.tsx` 文件
- `Transcript`/`Composer` 在自由区里需要让内部滚动正常：给 `.dock-window-body` 里 chat 的两个块加 flex（在 theme.css 追加）：
```css
.dock-window-body > .transcript-host, .dock-window-body > .composer { flex-shrink: 0; }
```
实际类名以 Transcript/Composer 根元素为准：Transcript 根是滚动容器、Composer 根是 `.composer`；若 Transcript 根类名不同，以类名为准写 `flex: 1; min-height: 0;`。执行时先 `grep -n "className" src/renderer/src/components/Transcript.tsx | head -3` 确认根类名再写这条 CSS。

- [ ] **Step 6: 全量验证**

Run: `pnpm typecheck && pnpm test && pnpm dev:web`
Expected: 全部 PASS；浏览器里完成下面的手动验收（dev:web 下终端面板显示"需要 Electron 环境"属正常）。

- [ ] **Step 7: 提交**

```bash
git add -A src/renderer/src src/main/index.ts
git commit -m "feat(ui): App 接入 Dock 布局 + Composer 信息条 + 工具路径点击 + 主题切换"
```

---

## 手动验收清单（dev:web + Electron 双环境，`pnpm dev` 验 PTY）

1. 首启：只有会话管理左栏 + 聊天满宽；刷新页面布局保持
2. ＋Files/＋Terminal：默认槽出现（左/下）；关闭后空间让给邻居；最小化后从聊天按钮无法「再开一个」（恢复原窗口）
3. 拖 Files 标题条到 chat 边缘半区 → 蓝色虚线落点、松手插入分栏；拖到正中 → 交换；拖到左栏 → 🚫 拒绝
4. 分隔条拖动两侧比例变化，拖过限位（15%/85%）停住；左栏边界 160–320 限位
5. Files：搜索 ≥2 字符出 glob 结果，点击开 File；⧉ 复制相对路径；Esc 清空回树
6. File：打开后可编辑，标题栏 ● 未保存；Ctrl+S 写盘；让 agent 改同一文件后保存 → 冲突三选；聚焦外部改动文件 → 无改动静默重载
7. Terminal（Electron）：＋新建多终端、标签 ✕ 只杀单个、窗口 ✕ 杀全部；运行 `pnpm dev` 后最小化终端窗口再恢复，输出不丢
8. Composer 信息条：模型 chip 开设置、思考 7 档即时生效、上下文 >80% 转橙、附件图片发送正常
9. 聊天里 read_file/edit_file/write_file 的路径下划线可点 → File 窗口打开该文件
10. 主题 ☾/☀ 即时切换并记忆；Esc 关设置/取消运行不回归

## Self-Review 记录

- Spec 覆盖：spec 第 2 节视觉→Task 2；第 3 节窗口矩阵→Task 1/3/4/7/10；第 4 节数据模型→Task 1；第 5 节数据流→Task 4/6/7/8/9/10；第 6 节 IPC→Task 4/5/8；第 7 节错误处理→Task 5/8（返回值编码）+ Task 7（冲突三选）；第 8 节测试→Task 1/4/5 单测 + 手动清单
- 偏差已在「Spec 偏差说明」明示 5 条（7 档思考、默认槽恢复、隐藏层保活、项目切换留 TopBar、☰ 语义）
- 类型一致性：`FreeKind/FreeNode/LayoutState` 全文一致；`onUiEvent`/`UiEvent` 命名一致；`deleteSession` 返回值三态统一

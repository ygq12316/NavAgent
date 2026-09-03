// src/renderer/src/state/__tests__/layout.test.ts
import { describe, expect, it, beforeAll } from 'vitest'
import {
  defaultLayout, layoutReducer, findPath, removeAt, insertNear, countLeaves,
  validateLayout, loadLayout, saveLayout, RAIL_MIN, RAIL_MAX, RATIO_MIN
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
    const after = insertNear(deep, 'chat', 'row', false, 'file') as Extract<FreeNode, { t: 'split' }>
    expect(after.a).toEqual(S('row', 0.5, L('chat'), L('file')))
    expect(after.b).toEqual(L('terminal'))
  })

  it('目标不存在时 insertNear 原样返回', () => {
    const t = L('chat')
    expect(insertNear(t, 'files', 'row', true, 'file')).toEqual(t)
  })
})

describe('layoutReducer', () => {
  it('open：任意顺序开满三窗都收敛到方案 A 规范树', () => {
    // Files 满高窄列 │ 聊天横跨上部 │ 底行 File│Terminal
    const planA = S('row', 0.22, L('files'), S('col', 0.62, L('chat'), S('row', 0.5, L('file'), L('terminal'))))
    let s = defaultLayout()
    for (const w of ['files', 'file', 'terminal'] as const) s = layoutReducer(s, { kind: 'open', win: w })
    expect(s.free).toEqual(planA)
    let s2 = defaultLayout()
    for (const w of ['terminal', 'file', 'files'] as const) s2 = layoutReducer(s2, { kind: 'open', win: w })
    expect(s2.free).toEqual(planA)
    let s3 = defaultLayout()
    for (const w of ['file', 'terminal', 'files'] as const) s3 = layoutReducer(s3, { kind: 'open', win: w })
    expect(s3.free).toEqual(planA)
    // openKinds 顺序跟随插入序，这里只断言集合一致
    expect([...s3.openKinds].sort()).toEqual(['chat', 'file', 'files', 'terminal'].sort())
  })

  it('open 单窗/两窗的规范中间态', () => {
    let s = layoutReducer(defaultLayout(), { kind: 'open', win: 'files' })
    expect(s.free).toEqual(S('row', 0.22, L('files'), L('chat')))
    s = layoutReducer(s, { kind: 'open', win: 'file' })
    // 方案 A 中 File 属底行（聊天下方左位）：无 terminal 时独占底行
    expect(s.free).toEqual(S('row', 0.22, L('files'), S('col', 0.62, L('chat'), L('file'))))
  })

  it('open 比例继承：用户拖过的分界在重排后保留', () => {
    let s = layoutReducer(defaultLayout(), { kind: 'open', win: 'files' })
    s = layoutReducer(s, { kind: 'setRatio', path: [], ratio: 0.3 }) // files│chat 边界
    s = layoutReducer(s, { kind: 'open', win: 'terminal' })
    // 重排后根分界（a 侧仍为 files）继承 0.3，聊天│底行用规范默认 0.62
    expect(s.free).toEqual(S('row', 0.3, L('files'), S('col', 0.62, L('chat'), L('terminal'))))
  })

  it('close：从方案 A 满编摘窗仍有序补位', () => {
    let s = defaultLayout()
    for (const w of ['files', 'file', 'terminal'] as const) s = layoutReducer(s, { kind: 'open', win: w })
    s = layoutReducer(s, { kind: 'close', win: 'file' })
    expect(s.free).toEqual(S('row', 0.22, L('files'), S('col', 0.62, L('chat'), L('terminal'))))
    s = layoutReducer(s, { kind: 'close', win: 'files' })
    expect(s.free).toEqual(S('col', 0.62, L('chat'), L('terminal')))
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
    s = layoutReducer(s, { kind: 'setRatio', path: [], ratio: 0.01 })
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

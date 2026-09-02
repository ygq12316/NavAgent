import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessage } from '@shared/types'
import { SessionStore } from '../session-store'
import { createBranchSummaryMessage, extractBranchSummary, isBranchSummaryMessage } from '../branch'

const user = (t: string): AgentMessage => ({ role: 'user', content: t })
const asst = (t: string): AgentMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: t }],
  toolCalls: [],
  stopReason: 'stop'
})

const dirs: string[] = []
function mkStore(): { store: SessionStore; base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'navagent-store-'))
  dirs.push(base)
  // SessionStore(userDataPath) 内部会再拼一层 'sessions'
  return { store: new SessionStore(base), base, root: join(base, 'sessions') }
}

afterEach(() => {
  // 临时目录留给系统清理（Windows 上删除常被占用句柄干扰）
})

describe('remove', () => {
  it('删除会话文件并从列表消失；不存在返回 not-found', () => {
    const { store } = mkStore()
    const a = store.create('/ws', 'm')
    const b = store.create('/ws', 'm')
    expect(store.remove(b.id)).toBe('ok')
    expect(store.list('/ws').map((s) => s.id)).toEqual([a.id])
    expect(store.remove(b.id)).toBe('not-found')
  })
})

describe('SessionStore 树化', () => {
  it('appendMessage 形成 id/parentId 线性链，leafId 前移', () => {
    const { store } = mkStore()
    const meta = store.create('E:\\proj', 'm')
    store.appendMessage(meta.id, user('你好'))
    store.appendMessage(meta.id, asst('你好！'))
    const tree = store.listTree(meta.id)
    expect(tree.map((n) => n.role)).toEqual(['user', 'assistant'])
    expect(tree[0]!.parentId).toBeNull()
    expect(tree[1]!.parentId).toBe(tree[0]!.id)
    expect(store.getLeaf(meta.id)).toBe(tree[1]!.id)
    const { messages } = store.load(meta.id)
    expect(messages).toHaveLength(2)
  })

  it('switchLeaf 到祖先节点后续跑成新分支', () => {
    const { store } = mkStore()
    const meta = store.create('E:\\proj', 'm')
    store.appendMessage(meta.id, user('方案 A'))
    store.appendMessage(meta.id, asst('A 的回答'))
    const tree = store.listTree(meta.id)
    // 切回根（方案 A 之前）——即切到 user 节点改写重发
    const res = store.switchLeaf(meta.id, tree[0]!.id)
    expect(res.messages).toEqual([user('方案 A')])
    store.appendMessage(meta.id, user('改成方案 B'))
    store.appendMessage(meta.id, asst('B 的回答'))
    const { messages } = store.load(meta.id)
    // 新分支路径：方案 A → 改成方案 B → B 的回答（映射为 'A'）
    expect(messages.map((m) => (m.role === 'user' ? m.content : 'A'))).toEqual(['方案 A', '改成方案 B', 'A'])
    // 树上原分支与新分支共存
    expect(store.listTree(meta.id).length).toBe(4)
  })

  it('snapshot 行在路径重建时清空此前累积', () => {
    const { store } = mkStore()
    const meta = store.create('E:\\proj', 'm')
    store.appendMessage(meta.id, user('旧历史'))
    store.appendSnapshot(meta.id, [user('摘要'), asst('继续')])
    store.appendMessage(meta.id, user('压缩后新输入'))
    const { messages } = store.load(meta.id)
    expect(messages.map((m) => (m.role === 'user' ? m.content : '[asst]'))).toEqual(['摘要', '[asst]', '压缩后新输入'])
  })

  it('旧格式（无 id）load 时迁移为线性链并可继续 append', () => {
    const { store, root } = mkStore()
    const meta = store.create('E:\\proj', 'm')
    const key = 'E:\\proj'.replace(/[^a-zA-Z0-9一-龥]+/g, '_')
    const file = join(root, key, `${meta.id}.jsonl`)
    writeFileSync(
      file,
      [
        JSON.stringify({ ts: 1, message: user('旧-1') }),
        JSON.stringify({ ts: 2, message: asst('旧-2') })
      ].join('\n') + '\n',
      'utf-8'
    )
    const { messages } = store.load(meta.id)
    expect(messages).toHaveLength(2)
    // 文件已迁移：行内出现 id/parentId
    const lines = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.every((l) => typeof l.id === 'string')).toBe(true)
    expect(lines[1].parentId).toBe(lines[0].id)
    // 迁移后继续 append 挂到最后节点
    store.appendMessage(meta.id, user('新输入'))
    expect(store.listTree(meta.id)).toHaveLength(3)
  })

  it('fork 保留原节点 id 并可独立生长', () => {
    const { store } = mkStore()
    const meta = store.create('E:\\proj', 'm')
    store.appendMessage(meta.id, user('问题'))
    store.appendMessage(meta.id, asst('回答 v1'))
    const tree = store.listTree(meta.id)
    const forked = store.fork(meta.id, tree[1]!.id)
    expect(forked.id).not.toBe(meta.id)
    expect(forked.title).toContain('fork')
    // 原节点 id 保留
    expect(store.listTree(forked.id).map((n) => n.id)).toEqual([tree[0]!.id, tree[1]!.id])
    // 各自独立生长互不影响
    store.appendMessage(meta.id, user('原会话继续'))
    store.appendMessage(forked.id, user('fork 会话继续'))
    expect(store.listTree(meta.id)).toHaveLength(3)
    expect(store.listTree(forked.id)).toHaveLength(3)
  })

  it('clone 复制当前活动分支', () => {
    const { store } = mkStore()
    const meta = store.create('E:\\proj', 'm')
    store.appendMessage(meta.id, user('q'))
    const cloned = store.clone(meta.id)
    expect(store.listTree(cloned.id)).toHaveLength(1)
    expect(store.getLeaf(cloned.id)).toBe(store.listTree(cloned.id)[0]!.id)
  })

  it('messagesBetween 提取 (common, leaf] 区间', () => {
    const { store } = mkStore()
    const meta = store.create('E:\\proj', 'm')
    store.appendMessage(meta.id, user('r'))
    const tree0 = store.listTree(meta.id)
    store.appendMessage(meta.id, asst('a'))
    store.appendMessage(meta.id, user('b'))
    const branchMsg = { role: 'user' as const, content: '分支尾巴' }
    store.appendMessage(meta.id, branchMsg)
    const out = store.messagesBetween(meta.id, tree0[0]!.id, store.getLeaf(meta.id)!)
    expect(out.map((m) => (m.role === 'user' ? m.content : '[asst]'))).toEqual(['[asst]', 'b', '分支尾巴'])
  })

  it('appendNode 持久化 leafId，跨实例恢复', () => {
    const { store, base } = mkStore()
    const meta = store.create('E:\\proj', 'm')
    store.appendMessage(meta.id, user('持久化检查'))
    const leaf = store.getLeaf(meta.id)
    const store2 = new SessionStore(base)
    expect(store2.getLeaf(meta.id)).toBe(leaf)
    expect(store2.load(meta.id).messages).toHaveLength(1)
  })

  it('分支摘要消息经树持久化往返后仍可识别', () => {
    const { store } = mkStore()
    const meta = store.create('E:\\proj', 'm')
    store.appendMessage(meta.id, user('q'))
    store.appendMessage(meta.id, createBranchSummaryMessage('离开分支的摘要正文'))
    const { messages } = store.load(meta.id)
    const summary = messages.find(isBranchSummaryMessage)
    expect(summary).toBeDefined()
    expect(extractBranchSummary(summary!)).toBe('离开分支的摘要正文')
  })
})

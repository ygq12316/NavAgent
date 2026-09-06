import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { StateStore } from './types'

/**
 * 扩展 K-V 存储（pi.state / ctx.session 的后端）：
 * 整文件 JSON + 内存镜像；set/delete 即时原子写（tmp+rename，仿 session-store 迁移先例）。
 * Node 单线程 + 同步写 → 无并发交错问题。
 */
export function createStateStore(file: string): StateStore {
  let data: Record<string, unknown> = {}
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
      if (typeof parsed === 'object' && parsed !== null) data = parsed
    }
  } catch {
    data = {} // 损坏文件视为空，首次 set 即覆盖重建
  }

  const flush = (): void => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, file)
  }

  return {
    get: (key) => data[key] as undefined,
    set: (key, value) => {
      data[key] = value
      try {
        flush()
      } catch {
        /* 写盘失败不阻塞扩展；内存值仍有效 */
      }
    },
    delete: (key) => {
      delete data[key]
      try {
        flush()
      } catch {
        /* 同上 */
      }
    },
    keys: () => Object.keys(data)
  }
}

/** 空存储（状态层未接入时的占位：get 恒 undefined，写入仅内存不落盘） */
export function noopStateStore(): StateStore {
  const mem: Record<string, unknown> = {}
  return {
    get: (key) => mem[key] as undefined,
    set: (key, value) => {
      mem[key] = value
    },
    delete: (key) => {
      delete mem[key]
    },
    keys: () => Object.keys(mem)
  }
}
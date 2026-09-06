// src/main/fs-service.ts
import { stat, readFile, writeFile } from 'node:fs/promises'
import type { FileReadResult, FileWriteResult } from '@shared/types'
import { resolveWithin } from '../tools/registry'
import { globToRegExp, toRel, walkFiles } from '../tools/walk'

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

/** 工作区内 glob：返回相对路径（≤200 条）；无效模式返回空数组 */
export async function globWorkspace(ws: string, pattern: string): Promise<string[]> {
  let re: RegExp
  try {
    re = globToRegExp(pattern)
  } catch {
    return []
  }
  const out: string[] = []
  for await (const abs of walkFiles(ws, '.', 5000)) {
    const rel = toRel(ws, abs)
    // 无目录分隔的模式同时对文件名匹配（"*.ts" 等价于 "**/*.ts"，与 glob 工具同款）
    if (re.test(rel) || (!pattern.includes('/') && re.test(rel.split('/').pop() ?? ''))) {
      out.push(rel)
      if (out.length >= 200) break
    }
  }
  return out
}

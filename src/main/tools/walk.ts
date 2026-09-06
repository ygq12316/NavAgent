import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { resolveWithin } from './registry'

const NOISE_DIRS = new Set(['node_modules', 'dist', 'out', '__pycache__', '.git', '.idea', '.vscode'])

export function isNoiseDir(name: string): boolean {
  return name.startsWith('.') || NOISE_DIRS.has(name)
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.exe', '.dll', '.zip', '.gz', '.7z', '.rar',
  '.pdf', '.mp3', '.mp4', '.avi', '.mov', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.db',
  '.sqlite', '.so', '.dylib', '.bin', '.class', '.jar', '.pyc'
])

export function isBinaryExt(name: string): boolean {
  const i = name.lastIndexOf('.')
  return i >= 0 && BINARY_EXT.has(name.slice(i).toLowerCase())
}

export function toRel(workspace: string, abs: string): string {
  return path.relative(workspace, abs).split(path.sep).join('/')
}

/** 递归遍历工作区文件（跳过隐藏/噪声目录），产出绝对路径；maxFiles 防失控 */
export async function* walkFiles(workspace: string, rel: string, maxFiles = 2000): AsyncGenerator<string> {
  const rootAbs = resolveWithin(workspace, rel || '.')
  if (!rootAbs) return
  let count = 0
  const stack: string[] = [rootAbs]
  while (stack.length > 0 && count < maxFiles) {
    const dir = stack.pop()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (count >= maxFiles) return
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!isNoiseDir(e.name)) stack.push(abs)
        continue
      }
      if (e.isFile()) {
        count++
        yield abs
      }
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function expandGlobChars(s: string): string {
  let out = ''
  for (const c of s) {
    if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += escapeRe(c)
  }
  return out
}

/** 手写 glob → RegExp：支持 ** / * / ? / {a,b}；匹配对象是正斜杠化的相对路径 */
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*'
          i += 3
          continue
        }
        re += '.*'
        i += 2
        continue
      }
      re += '[^/]*'
      i++
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i++
      continue
    }
    if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end > i) {
        const body = pattern.slice(i + 1, end)
        re += '(?:' + body.split(',').map(expandGlobChars).join('|') + ')'
        i = end + 1
        continue
      }
    }
    re += escapeRe(c)
    i++
  }
  return new RegExp('^(?:' + re + ')$', 'i')
}

import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 凭据层（对齐 pi 的 auth.json + Resolution Order）：
 * 文件 userData/auth.json —— { "<providerId>": { "type": "api_key", "key": "..." } }，按厂商共存。
 * 解析顺序（找到即返回）：手填覆盖(config.apiKey，字面) > auth.json > 环境变量 > 供应商定义内联值(models.json)。
 * 值语法（auth.json 与内联值适用）：$ENV / ${ENV} 插值、!command 执行取值、$$ → $、$! → !（pi 对齐）。
 */

export interface AuthEntry {
  type: 'api_key'
  key: string
}

export type AuthFile = Record<string, AuthEntry>

export type CredentialSource = 'config' | 'auth.json' | 'env' | 'provider-definition'

export interface ResolvedCredential {
  key: string
  source: CredentialSource
}

export interface ResolveCredentialInput {
  providerId: string
  /** 第 1 层：设置里手填的即时值（字面，不插值） */
  legacyConfigKey?: string
  /** 第 3 层：厂商官方环境变量名 */
  envKey?: string
  /** 第 4 层：供应商定义内联值（models.json 的 apiKey） */
  inlineValue?: string
}

// ── auth.json 读写 ─────────────────────────────────────────────

function authFileOf(userDataPath: string): string {
  return join(userDataPath, 'auth.json')
}

export function loadAuth(userDataPath: string): AuthFile {
  try {
    const raw = JSON.parse(readFileSync(authFileOf(userDataPath), 'utf-8')) as AuthFile
    return typeof raw === 'object' && raw !== null ? raw : {}
  } catch {
    return {}
  }
}

export function saveCredential(userDataPath: string, providerId: string, key: string): void {
  const auth = loadAuth(userDataPath)
  auth[providerId] = { type: 'api_key', key }
  writeAuth(userDataPath, auth)
}

export function removeCredential(userDataPath: string, providerId: string): boolean {
  const auth = loadAuth(userDataPath)
  if (!(providerId in auth)) return false
  delete auth[providerId]
  writeAuth(userDataPath, auth)
  return true
}

function writeAuth(userDataPath: string, auth: AuthFile): void {
  const file = authFileOf(userDataPath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(auth, null, 2), 'utf-8')
}

// ── 值语法（pi 对齐）：$$ → $、$! → !、$ENV/${ENV} 插值、!command 执行取值 ──

const LITERAL_DOLLAR = '\x00D\x00'
const LITERAL_BANG = '\x00B\x00'

/**
 * 解析凭据值语法。allowCommand=false 时 ! 前缀按字面（纯函数测试/受限场景用）。
 * 命令执行限本机自有配置文件（userData 下），超时 10s，取 stdout 去尾换行。
 */
export function resolveValueSyntax(raw: string, options: { allowCommand?: boolean } = {}): string {
  const allowCommand = options.allowCommand ?? true
  let out = raw.replace(/\$\$/g, LITERAL_DOLLAR).replace(/\$!/g, LITERAL_BANG)
  if (allowCommand && out.startsWith('!')) {
    const command = out.slice(1).trim()
    if (command.length > 0) {
      try {
        out = execSync(command, { timeout: 10_000, windowsHide: true, encoding: 'utf-8' }).replace(/[\r\n]+$/, '')
      } catch {
        out = ''
      }
    } else {
      out = ''
    }
  }
  out = out.replace(/\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/g, (_m, a: string | undefined, b: string | undefined) => {
    const name = a ?? b
    const v = name ? process.env[name] : undefined
    return v ?? ''
  })
  return out.replaceAll(LITERAL_DOLLAR, '$').replaceAll(LITERAL_BANG, '!')
}

// ── 解析顺序 ──────────────────────────────────────────────────

/** 手填覆盖(config.apiKey) > auth.json > env > 定义内联值；全空返回 null */
export function resolveCredential(userDataPath: string, input: ResolveCredentialInput): ResolvedCredential | null {
  // 优先级：auth.json（按厂商刻意保存的）> 旧版手填(config.apiKey) > env > 定义内联值
  const auth = loadAuth(userDataPath)
  const stored = auth[input.providerId]?.key
  if (typeof stored === 'string' && stored.trim().length > 0) {
    return { key: resolveValueSyntax(stored), source: 'auth.json' }
  }
  if (input.legacyConfigKey && input.legacyConfigKey.trim().length > 0) {
    return { key: input.legacyConfigKey, source: 'config' }
  }
  if (input.envKey) {
    const v = process.env[input.envKey]
    if (v && v.trim().length > 0) return { key: v, source: ('env:' + input.envKey) as CredentialSource }
  }
  if (input.inlineValue !== undefined && input.inlineValue.trim().length > 0) {
    return { key: resolveValueSyntax(input.inlineValue), source: 'provider-definition' }
  }
  return null
}

/** 凭据存在性摘要（设置面板展示；不回传明文） */
export function credentialInfo(userDataPath: string, providerId: string): { stored: boolean } {
  const auth = loadAuth(userDataPath)
  return { stored: Boolean(auth[providerId]?.key) }
}

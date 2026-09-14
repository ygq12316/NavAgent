import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { Tool } from '../registry'

interface Args {
  url: string
}

const FETCH_TIMEOUT = 15_000
const MAX_REDIRECTS = 4
const BODY_CAP = 24_000

/** IPv6 展开（支持 :: 缩写与内嵌 IPv4 尾段）→ 8 组 16bit；非法返回 null */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const v4 = dotted[2]!.split('.').map(Number)
    s = dotted[1]! + (((v4[0]! << 8) | v4[1]!).toString(16)) + ':' + (((v4[2]! << 8) | v4[3]!).toString(16))
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0]!.split(':').filter(Boolean) : []
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(':').filter(Boolean) : []
  if (halves.length === 1 && head.length !== 8) return null
  if (halves.length === 2 && head.length + tail.length > 7) return null
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail].map((g) => parseInt(g, 16))
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null
  return groups
}

function isPrivateV6(groups: number[]): boolean {
  if (groups.every((g) => g === 0)) return true // 未指定 ::
  if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return true // 环回 ::1
  if (groups[0]! >= 0xfc00 && groups[0]! <= 0xfdff) return true // ULA fc00::/7
  if (groups[0]! >= 0xfe80 && groups[0]! <= 0xfebf) return true // link-local fe80::/10
  // IPv4 映射（::ffff:0:0/96，点分与十六进制两种形态经 expandV6 归一）
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isPrivateIp(`${(groups[6]! >> 8) & 0xff}.${groups[6]! & 0xff}.${(groups[7]! >> 8) & 0xff}.${groups[7]! & 0xff}`)
  }
  return false
}

/** 私网/环回地址段（SSRF 防护）：拒绝向本机与内网发起请求 */
function isPrivateIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGN
    if (a === 169 && b === 254) return true // link-local
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    return false
  }
  if (v === 6) {
    const groups = expandV6(ip)
    return groups === null ? true : isPrivateV6(groups)
  }
  return true // 非法地址一律视为不安全
}

/** URL 安全校验：协议限 http/https，解析出的所有 IP 必须是公网（lookup 可注入供测试） */
export async function assertPublicUrl(
  raw: string,
  doLookup: (host: string, opts: { all: true }) => Promise<{ address: string; family: number }[]> = lookup
): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('URL 无法解析')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`不支持的协议：${url.protocol}`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (/(^|\.)localhost$/i.test(host)) throw new Error('拒绝访问本机地址')
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('拒绝访问内网地址')
    return url
  }
  const addrs = await doLookup(host, { all: true })
  if (addrs.length === 0) throw new Error(`域名解析失败：${host}`)
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('拒绝访问内网地址')
  }
  return url
}

/** HTML → 纯文本：去脚本样式注释，块级标签转行，解码常见实体，压平空白 */
function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n)
      return code > 31 && code < 0x110000 ? String.fromCodePoint(code) : ''
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) navAgent/0.1'

/** 重定向逐跳校验（fetch 跟随重定向会绕过 SSRF 检查，必须 manual 手动走） */
async function fetchChecked(rawUrl: string, signal: AbortSignal): Promise<Response> {
  let current = await assertPublicUrl(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: 'text/html, application/json, text/*;q=0.8' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)])
    })
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      res.body?.cancel().catch(() => {})
      current = await assertPublicUrl(new URL(loc, current).toString())
      continue
    }
    return res
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`)
}

export const webFetchTool: Tool<Args> = {
  name: 'web_fetch',
  description:
    '读取网页全文（HTML 抽取为纯文本，截断）。配合 web_search 使用：对搜索结果中感兴趣的 URL 抓正文；也可直接读取用户给的链接。拒绝访问内网地址。',
  mutating: false,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整的 http(s) 网页地址' }
    },
    required: ['url']
  },
  validate: (a) => (typeof a?.url === 'string' && a.url.trim().length > 0 ? null : 'url 必须是非空字符串'),
  async execute(args, _ctx, signal) {
    try {
      const res = await fetchChecked(args.url.trim(), signal)
      if (!res.ok) return { content: `网页返回 ${res.status} ${res.statusText}`, isError: true }
      const type = (res.headers.get('content-type') ?? '').toLowerCase()
      if (!/^(text\/|application\/(json|xml|xhtml))/.test(type.split(';')[0] ?? '')) {
        return { content: `不支持的内容类型：${type || '未知'}（仅支持文本类网页）`, isError: true }
      }
      const len = Number(res.headers.get('content-length') ?? 0)
      if (len > 5_000_000) return { content: '响应过大（>5MB）', isError: true }
      const raw = (await res.text()).slice(0, 2_000_000)
      const finalUrl = res.url || args.url
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim()
      const isHtml = /html/.test(type)
      const text = (isHtml ? htmlToText(raw) : raw).slice(0, BODY_CAP)
      if (!text) return { content: '（页面无可提取正文）', isError: true }
      const head = [title ? `标题：${title}` : null, `来源：${finalUrl}`].filter(Boolean).join('\n')
      const tail = raw.length > BODY_CAP ? '\n…（内容过长已截断）' : ''
      return { content: `${head}\n\n${text}${tail}` }
    } catch (err) {
      return { content: `抓取失败：${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  }
}

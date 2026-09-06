import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * 文档文本抽取（read_file 的二进制文档分支）：PDF / Word(.docx) / Excel(.xlsx/.xls) → 纯文本。
 * 解析库按需动态 import（unpdf / mammoth / SheetJS），不进主包启动体积。
 * 全链路不 throw：解析失败编码为 error 字符串。
 */

export type DocExtractResult = { ok: true; text: string; note: string } | { ok: false; error: string }

const SUPPORTED = new Set(['.pdf', '.docx', '.xlsx', '.xls'])

export function isSupportedDoc(ext: string): boolean {
  return SUPPORTED.has(ext.toLowerCase())
}

export async function extractDocText(abs: string): Promise<DocExtractResult> {
  const ext = extOf(abs)
  if (!SUPPORTED.has(ext)) return { ok: false, error: `不支持的文档格式：${ext || '（无扩展名）'}` }
  try {
    const buf = await readFile(abs)
    if (ext === '.pdf') return await extractPdf(buf)
    if (ext === '.docx') return await extractDocx(abs)
    return await extractXlsx(buf)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function extOf(abs: string): string {
  const i = abs.lastIndexOf('.')
  return i >= 0 ? abs.slice(i).toLowerCase() : ''
}

async function extractPdf(buf: Buffer): Promise<DocExtractResult> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text, totalPages } = await extractText(pdf, { mergePages: true })
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'PDF 中未提取到文本（可能是扫描件/纯图片）' }
  return { ok: true, text: trimmed, note: `PDF · ${totalPages} 页` }
}

async function extractDocx(abs: string): Promise<DocExtractResult> {
  const mammoth = await import('mammoth')
  const r = await mammoth.extractRawText({ path: abs })
  const trimmed = r.value.trim()
  if (!trimmed) return { ok: false, error: 'Word 文档内容为空' }
  return { ok: true, text: trimmed, note: `Word · ${basename(abs)}` }
}

async function extractXlsx(buf: Buffer): Promise<DocExtractResult> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buf, { type: 'buffer' })
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    parts.push(`### Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`)
  }
  const text = parts.join('\n\n').trim()
  if (!text) return { ok: false, error: 'Excel 无内容' }
  return { ok: true, text, note: `Excel · ${wb.SheetNames.length} 个工作表` }
}

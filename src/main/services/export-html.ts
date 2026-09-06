import type { AgentMessage, SessionMeta } from '@shared/types'
import { messageText } from '@shared/types'

/**
 * 会话导出为独立 HTML（无 JS，单文件）：transcript 风格快照。
 * 纯函数；消息内容一律转义（安全边界：会话内容可能含任意模型/用户输出）。
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function tryFormatArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args || '{}'), null, 2)
  } catch {
    return args
  }
}

function renderMessage(m: AgentMessage): string {
  if (m.role === 'user') {
    const text = messageText(m)
    const images = Array.isArray(m.content)
      ? m.content
          .filter((b) => b.type === 'image')
          .map((b) => `<img class="img" src="data:${b.mimeType};base64,${b.data}" alt="附件图片" />`)
          .join('')
      : ''
    return `<div class="msg user"><div class="role">用户</div><div class="body">${esc(text)}${images}</div></div>`
  }
  if (m.role === 'assistant') {
    const text = m.content
      .filter((b): b is Extract<(typeof m.content)[number], { type: 'text' }> => b.type === 'text' && b.text.length > 0)
      .map((b) => `<p>${esc(b.text)}</p>`)
      .join('')
    const thinking = m.content.filter((b): b is (typeof m.content)[number] & { thinking: string } => b.type === 'thinking' && b.thinking.length > 0)
    const thinkingHtml = thinking.length
      ? `<details class="thinking"><summary>思考过程（${thinking.length} 块）</summary><pre>${esc(thinking.map((b) => (b.type === 'thinking' ? b.thinking : '')).join('\n\n'))}</pre></details>`
      : ''
    const tools = m.toolCalls
      .map(
        (tc) =>
          `<div class="toolcall"><code>${esc(tc.name)}</code><pre>${esc(tryFormatArgs(tc.arguments))}</pre></div>`
      )
      .join('')
    const usage = m.usage ? `<div class="usage">输入 ${m.usage.inputTokens} · 输出 ${m.usage.outputTokens} tok</div>` : ''
    const stop = m.stopReason === 'error' ? `<div class="error">${esc(m.errorMessage ?? '错误')}</div>` : ''
    return `<div class="msg assistant"><div class="role">助手${stop}</div>${thinkingHtml}<div class="body">${text}${tools}</div>${usage}</div>`
  }
  return `<div class="msg toolresult"><div class="role">工具结果 · ${esc(m.toolName)}</div><pre>${esc(m.content.slice(0, 4000))}</pre></div>`
}

export function renderSessionHtml(meta: SessionMeta, messages: AgentMessage[]): string {
  const toolCount = messages.reduce((n, m) => n + (m.role === 'assistant' ? m.toolCalls.length : 0), 0)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(meta.title)} · navAgent 会话</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; background: #14181f; color: #d7dee8; font: 14px/1.65 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  header { border-bottom: 1px solid #2a3444; padding-bottom: 14px; margin-bottom: 24px; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .meta { font-size: 12px; color: #8b98ab; }
  .msg { margin: 14px 0; border-radius: 12px; padding: 12px 14px; background: #1a212c; border: 1px solid #26303f; }
  .msg.user { border-color: #3b82f655; }
  .msg .role { font-size: 11.5px; color: #8b98ab; margin-bottom: 6px; letter-spacing: .05em; }
  .msg pre { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; color: #a8b4c4; margin: 6px 0 0; }
  .msg.user .body { white-space: pre-wrap; }
  .toolcall { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: #141a24; }
  .toolcall code { color: #7dd3fc; font-size: 12px; }
  .usage { font-size: 11px; color: #64748b; margin-top: 8px; }
  .error { color: #f87171; font-size: 12px; }
  details.thinking { margin: 8px 0; font-size: 12.5px; color: #a8b4c4; }
  details.thinking pre { white-space: pre-wrap; }
  img.img { max-width: 100%; border-radius: 8px; margin-top: 8px; display: block; }
</style>
</head>
<body>
<main>
  <header>
    <h1>${esc(meta.title)}</h1>
    <div class="meta">${esc(meta.projectPath)} · 模型 ${esc(meta.model)} · ${new Date(meta.createdAt).toISOString().slice(0, 10)} · 消息 ${messages.length} 条 · 工具调用 ${toolCount} 次</div>
  </header>
  ${messages.map(renderMessage).join('\n')}
  <footer class="meta">由 navAgent 导出 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</footer>
</main>
</body>
</html>`
}

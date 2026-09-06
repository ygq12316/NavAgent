// 临时诊断 v6：打开终端面板 → 观察自动创建 + ▶ 按钮（跑完即删）
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://localhost:9222')
const ctx = browser.contexts()[0]
const win = ctx.pages().find((p) => String(p.url()).includes('localhost')) ?? (await ctx.pages())[0]

await win.addInitScript(() => {
  window.__diag = { ptyCalls: [], unhandled: [] }
  window.addEventListener('unhandledrejection', (e) => window.__diag.unhandled.push(String(e.reason).slice(0, 160)))
  window.addEventListener('DOMContentLoaded', () => {
    try {
      const orig = window.navagent.ptyCreate.bind(window.navagent)
      window.navagent.ptyCreate = (sid) => {
        window.__diag.ptyCalls.push({ sid, t: Date.now() })
        return orig(sid)
      }
    } catch (e) {
      window.__diag.wrapErr = String(e).slice(0, 120)
    }
  })
})

await win.reload()
await win.waitForSelector('.composer', { timeout: 20000 })

// 打开终端面板（确认点击的是「打开」而非「关闭」）
const btn = win.locator('button[title="打开「终端」面板"]').first()
console.log('[diag] open-btn count:', await btn.count())
await btn.click()
console.log('[diag] clicked open')

for (const w of [400, 1200, 2500, 4000]) {
  await win.waitForTimeout(w)
  const diag = await win.evaluate(() => ({
    calls: JSON.stringify(window.__diag.ptyCalls),
    unhandled: JSON.stringify(window.__diag.unhandled.slice(0, 3)),
    tabs: document.querySelectorAll('.term-tab').length,
    tabText: [...document.querySelectorAll('.term-tab')].map((x) => x.textContent.trim()).join(','),
    termText: (document.querySelector('.term-host')?.textContent ?? '').trim().slice(0, 50),
    notice: (document.querySelector('.term-notice')?.textContent ?? '').trim()
  }))
  console.log(`[diag] +${w}ms`, JSON.stringify(diag))
}

// ▶ 按钮：若存在命令胶囊，点击运行
const runBtn = win.locator('.bash-act[title="在终端中运行"]').first()
if (await runBtn.count()) {
  await runBtn.click()
  await win.waitForTimeout(4000)
  const termText = (await win.locator('.term-host').textContent().catch(() => '')) ?? ''
  console.log('[diag] after ▶ click, terminal contains cmd:', termText.includes('npm test'))
} else {
  console.log('[diag] no run button (该会话暂无 interactive 命令)')
}
process.exit(0)

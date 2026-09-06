// 临时诊断 v2：完整交互序列 + 主进程内直接 spawn 测试（跑完即删）
import { _electron } from 'playwright-core'

const app = await _electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
const errors = []
win.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text().slice(0, 200))
})
app.process().stderr?.on('data', (d) => {
  const s = String(d)
  if (s.includes('term-diag')) console.log('[main]', s.trim().slice(0, 160))
})

await win.waitForSelector('.composer', { timeout: 20000 })

// ① 打开终端面板（自动创建路径，term-diag 计时经 stderr 输出）
await win.locator('button[title*="终端"]').first().click()
console.log('[diag] clicked terminal summon')
for (const w of [500, 1000, 1500, 2000, 3000]) {
  await win.waitForTimeout(w)
  const tabs = await win.locator('.term-tab').count()
  const notice = (await win.locator('.term-notice').textContent().catch(() => null)) ?? ''
  console.log(`[diag] +${w}ms tabs=${tabs} notice="${notice.trim()}"`)
}

// ③ 键入（pty.write 路径）
await win.locator('.term-pane').first().click({ position: { x: 200, y: 100 } })
await win.keyboard.type('echo typed-ok')
await win.keyboard.press('Enter')
await win.waitForTimeout(1200)
const text = (await win.locator('.term-host').textContent().catch(() => null)) ?? ''
console.log('[diag] typed visible:', text.includes('typed-ok'))

console.log('[diag] renderer errors:', JSON.stringify(errors.slice(0, 5)))
await app.close()
process.exit(0)

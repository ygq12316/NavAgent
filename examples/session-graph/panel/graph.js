/**
 * 会话地图（沙箱面板，零依赖）：两级结构 + 自由画布。
 * - 左上角悬浮列表 = 当前项目全部会话（点击聚焦）
 * - 主画布 = 聚焦会话的 fork 派生树，向右横向生长（根在左，后代按层级向右展开）
 * - 卡片可拖动（位置按会话 id 持久化）；画布可缩放（按钮 / Ctrl+滚轮，0.4x–2.5x）
 * - 删除会话：派生子会话断线提升为新的根（主进程 removeSession 语义）
 */

// ── 桥：postMessage invoke / push ──────────────────────────────
const PANEL_ID = new URLSearchParams(location.search).get('__panel') || ''
let seq = 0
const pending = new Map()

window.addEventListener('message', (e) => {
  const d = e.data
  if (!d || d.__navagentPanel !== PANEL_ID) return
  // 宿主主题变化：跟随切换（CSS 变量即时生效）
  if (d.kind === 'theme') {
    if (d.theme === 'light' || d.theme === 'dark') document.documentElement.dataset.theme = d.theme
    return
  }
  if (d.kind === 'result') {
    const p = pending.get(d.reqId)
    if (p) {
      pending.delete(d.reqId)
      if (d.ok) p.resolve(d.result)
      else p.reject(new Error(d.error || 'invoke 失败'))
    }
  } else if (d.kind === 'push') {
    onPush(d.payload)
  }
})

function invoke(op, params = {}) {
  return new Promise((resolve, reject) => {
    const reqId = ++seq
    pending.set(reqId, { resolve, reject })
    window.parent.postMessage({ __navagentPanel: PANEL_ID, kind: 'invoke', reqId, op, params }, '*')
  })
}

// ── 状态 ───────────────────────────────────────────────────────
let data = { sessions: [], currentId: '', positions: {} }
let focusId = '' // 聚焦会话（fork 树的根）
let pos = {} // sessionId -> {x,y} 实时坐标（含拖动未保存值）
let zoom = 1
let selected = null
let listOpen = true // 悬浮会话列表展开态；收起时树从最左铺开

const stat = document.getElementById('stat')
const errBox = document.getElementById('err')
const wrap = document.getElementById('wrap')
const canvas = document.getElementById('canvas')
const content = document.getElementById('content')
const underlay = document.getElementById('underlay')
const cardsLayer = document.getElementById('cards')
const listItems = document.getElementById('listItems')
const zoomPct = document.getElementById('zoomPct')

// ── 缩放 ───────────────────────────────────────────────────────
function applyZoom() {
  const W = parseFloat(content.style.width) || 400
  const H = parseFloat(content.style.height) || 300
  canvas.style.width = W * zoom + 'px'
  canvas.style.height = H * zoom + 'px'
  content.style.transform = `scale(${zoom})`
  zoomPct.textContent = Math.round(zoom * 100) + '%'
}

function setZoom(z) {
  zoom = Math.min(2.5, Math.max(0.4, z))
  applyZoom()
  resolveCollisions()
}

document.getElementById('zIn').addEventListener('click', () => setZoom(zoom * 1.2))
document.getElementById('zOut').addEventListener('click', () => setZoom(zoom / 1.2))
document.getElementById('zFit').addEventListener('click', () => setZoom(1))
document.getElementById('listToggle').addEventListener('click', () => {
  listOpen = !listOpen
  document.getElementById('list').classList.toggle('hidden', !listOpen)
  render()
})
wrap.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9))
}, { passive: false })

// ── 拉取 ───────────────────────────────────────────────────────
async function pull() {
  try {
    data = (await invoke('mapData', {})) ?? { sessions: [], currentId: '', positions: {} }
    errBox.style.display = 'none'
    if (!data.sessions.some((s) => s.id === focusId)) {
      focusId = data.sessions.some((s) => s.id === data.currentId) ? data.currentId : (data.sessions[0]?.id ?? '')
    }
    render()
  } catch (err) {
    console.error('[graph] pull 失败', err)
    errBox.textContent = '加载失败：' + (err instanceof Error ? err.message : err)
    errBox.style.display = 'block'
  }
}

function onPush(payload) {
  if (payload && payload.kind === 'refresh') void pull()
}

// ── 常量 ───────────────────────────────────────────────────────
const CARD_W = 260
const CARD_H = 96
const COL_W = CARD_W + 64
const ROW_H = CARD_H + 24
const PAD = 20
const MARGIN = 10

// ── 无重叠约束：固定浮层（列表/缩放控件/折叠钮）换算为画布障碍物 ──
function obstacles() {
  const list = []
  const cr = content.getBoundingClientRect()
  if (cr.width === 0) return list
  const k = zoom || 1
  const add = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0) return
    list.push({ x: (r.x - cr.x) / k - MARGIN, y: (r.y - cr.y) / k - MARGIN, w: r.width / k + MARGIN * 2, h: r.height / k + MARGIN * 2 })
  }
  if (listOpen) add(document.getElementById('list'))
  add(document.getElementById('listToggle'))
  add(document.getElementById('zoomctl'))
  return list
}

function rectsHit(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** 卡片矩形是否撞上障碍物或其它卡片 */
function overlapsAnything(id, p) {
  const me = { x: p.x, y: p.y, w: CARD_W, h: CARD_H }
  if (obstacles().some((o) => rectsHit(me, o))) return true
  for (const s of data.sessions) {
    if (s.id === id) continue
    const q = pos[s.id]
    if (q && rectsHit(me, { x: q.x, y: q.y, w: CARD_W, h: CARD_H })) return true
  }
  return false
}

/** 碰撞消解：重叠的卡沿 x 向右扫到第一个不重叠的位置（一直向右必然收敛） */
function resolveCollisions() {
  let movedAny = false
  for (const s of data.sessions) {
    const p = pos[s.id]
    if (!p) continue
    const before = p.x
    let guard = 0
    while (overlapsAnything(s.id, p) && guard++ < 500) p.x += 28
    if (p.x !== before) {
      movedAny = true
      const el = [...cardsLayer.querySelectorAll('.card')].find((c) => c.__sid === s.id)
      if (el) {
        el.style.left = p.x + 'px'
        el.style.top = p.y + 'px'
      }
    }
  }
  if (movedAny) {
    redrawEdges()
    fitCanvas()
  }
}
// 首列起始：列表展开时避开左上角悬浮列表，收起后从最左铺开
const treeX0 = () => (listOpen ? 252 : PAD)

// ── 聚焦子树：焦点为根的后代集合（含焦点） ──────────────────────
function focusedTree() {
  const byId = new Map(data.sessions.map((s) => [s.id, s]))
  const children = new Map()
  for (const s of data.sessions) {
    const p = s.forkSourceId && byId.has(s.forkSourceId) ? s.forkSourceId : '__root'
    if (!children.has(p)) children.set(p, [])
    children.get(p).push(s)
  }
  for (const list of children.values()) list.sort((a, b) => a.updatedAt - b.updatedAt)
  if (!focusId || !byId.has(focusId)) focusId = data.sessions.some((s) => s.id === data.currentId) ? data.currentId : (data.sessions[0]?.id ?? '')
  const tree = []
  const seen = new Set()
  const walk = (id) => {
    if (seen.has(id)) return
    seen.add(id)
    const s = byId.get(id)
    if (!s) return
    tree.push(s)
    for (const k of children.get(id) ?? []) walk(k.id)
  }
  walk(focusId)
  return { tree, children, byId }
}

// ── 坐标：横向生长（x=层深向右，y=叶序行）；拖过的用保存值 ──────
function resolvePositions(tree, children) {
  const out = {}
  const seen = new Set()
  let rowCursor = 0
  const place = (s, depth) => {
    if (seen.has(s.id)) return rowCursor
    seen.add(s.id)
    const saved = data.positions[s.id]
    if (saved) {
      out[s.id] = { x: saved.x, y: saved.y }
      // 保存坐标也要继续铺后代，否则整棵子树失去坐标
      for (const k of (children.get(s.id) ?? []).filter((k2) => !seen.has(k2.id))) place(k, depth + 1)
      return rowCursor
    }
    const kids = (children.get(s.id) ?? []).filter((k) => !seen.has(k.id))
    let row
    if (kids.length === 0) {
      row = rowCursor++
    } else {
      const rows = kids.map((k) => place(k, depth + 1))
      row = (Math.min(...rows) + Math.max(...rows)) / 2
    }
    out[s.id] = { x: treeX0() + depth * COL_W, y: PAD + row * ROW_H }
    return row
  }
  const focus = tree.find((s) => s.id === focusId) ?? tree[0]
  if (focus) place(focus, 0)
  return out
}

// ── 连线锚点：按两卡相对位置选接法 ─────────────────────────────
function edgePath(a, b) {
  const acx = a.x + CARD_W / 2
  const bcx = b.x + CARD_W / 2
  if (b.x >= a.x + CARD_W) {
    const x1 = a.x + CARD_W
    const x2 = b.x
    const midX = (x1 + x2) / 2
    const y1 = a.y + CARD_H / 2
    const y2 = b.y + CARD_H / 2
    return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
  }
  if (b.x + CARD_W <= a.x) {
    const x1 = a.x
    const x2 = b.x + CARD_W
    const midX = (x1 + x2) / 2
    const y1 = a.y + CARD_H / 2
    const y2 = b.y + CARD_H / 2
    return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
  }
  const acy = a.y + CARD_H / 2
  const bcy = b.y + CARD_H / 2
  if (b.y >= a.y + CARD_H) {
    const y1 = a.y + CARD_H
    const y2 = b.y
    const midY = (y1 + y2) / 2
    return `M ${acx} ${y1} C ${acx} ${midY}, ${acx} ${midY}, ${bcx} ${y2}`
  }
  const y1 = a.y
  const y2 = b.y + CARD_H
  const midY = (y1 + y2) / 2
  return `M ${acx} ${y1} C ${acx} ${midY}, ${acx} ${midY}, ${bcx} ${y2}`
}

// ── 渲染 ───────────────────────────────────────────────────────
function fmtTs(ts) {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function fitCanvas() {
  let W = 400
  let H = 300
  for (const p of Object.values(pos)) {
    W = Math.max(W, p.x + CARD_W + PAD)
    H = Math.max(H, p.y + CARD_H + PAD)
  }
  content.style.width = W + 'px'
  content.style.height = H + 'px'
  underlay.setAttribute('width', String(W))
  underlay.setAttribute('height', String(H))
  applyZoom()
}

let redrawEdges = () => {}

function renderList() {
  listItems.innerHTML = ''
  const sorted = [...data.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const s of sorted) {
    const item = document.createElement('div')
    item.className = 'list-item' + (s.id === focusId ? ' on' : '') + (s.id === data.currentId ? ' cur' : '')
    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = truncate(s.title || '新对话', 12)
    item.appendChild(nm)
    if (s.forkSourceId) {
      const fk = document.createElement('span')
      fk.className = 'fk'
      fk.textContent = '⑂'
      fk.title = '派生自 ' + truncate(data.sessions.find((x) => x.id === s.forkSourceId)?.title ?? '', 14)
      item.appendChild(fk)
    }
    const tm = document.createElement('span')
    tm.className = 'tm'
    tm.textContent = fmtTs(s.updatedAt).slice(5)
    item.appendChild(tm)
    item.addEventListener('click', () => {
      focusId = s.id
      render()
    })
    listItems.appendChild(item)
  }
}

function render() {
  renderList()
  const { tree, children } = focusedTree()
  pos = resolvePositions(tree, children)
  cardsLayer.innerHTML = ''
  underlay.innerHTML = ''
  fitCanvas()

  const NS = 'http://www.w3.org/2000/svg'

  redrawEdges = () => {
    fitCanvas()
    underlay.innerHTML = ''
    for (const s of tree) {
      if (!s.forkSourceId || !pos[s.forkSourceId] || !pos[s.id]) continue
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', edgePath(pos[s.forkSourceId], pos[s.id]))
      underlay.appendChild(path)
    }
  }
  redrawEdges()

  const mkCard = (s) => {
    const at = pos[s.id]
    if (!at) return
    const card = document.createElement('div')
    card.__sid = s.id
    card.className = 'card' + (s.id === data.currentId ? ' current' : '') + (s.archived ? ' archived' : '')
    card.style.left = at.x + 'px'
    card.style.top = at.y + 'px'

    const head = document.createElement('div')
    head.className = 'card-head'
    const dot = document.createElement('span')
    dot.className = 'dot'
    head.appendChild(dot)
    const title = document.createElement('span')
    title.className = 'card-title'
    title.textContent = truncate(s.title || '新对话', 22)
    head.appendChild(title)
    card.appendChild(head)

    const meta = document.createElement('div')
    meta.className = 'card-meta'
    meta.textContent = `${fmtTs(s.updatedAt)} · ${s.model}${s.forkSourceId ? ' · ⑂ 派生' : ''}`
    card.appendChild(meta)

    const ops = document.createElement('div')
    ops.className = 'card-ops'
    const mk = (label, cls, fn) => {
      const b = document.createElement('button')
      b.textContent = label
      if (cls) b.className = cls
      b.addEventListener('click', (ev) => {
        ev.stopPropagation()
        void fn()
      })
      return b
    }
    if (s.id !== focusId) ops.appendChild(mk('聚焦', '', () => { focusId = s.id; render() }))
    ops.appendChild(mk('打开', '', () => invoke('open', { sessionId: s.id })))
    ops.appendChild(mk('分支', '', () => invoke('branch', { sessionId: s.id }).then(() => pull())))
    ops.appendChild(mk('删除', 'danger', () =>
      invoke('remove', { sessionId: s.id }).then((r) => {
        if (r === 'ok' && s.id === focusId) focusId = data.currentId
        return pull()
      })
    ))
    card.appendChild(ops)

    card.addEventListener('pointerdown', (ev) => {
      if (ev.target instanceof HTMLButtonElement) return
      ev.preventDefault()
      card.classList.add('dragging')
      const startX = ev.clientX
      const startY = ev.clientY
      const origX = at.x
      const origY = at.y
      let moved = false
      const onMove = (m) => {
        at.x = Math.max(0, origX + (m.clientX - startX) / zoom)
        at.y = Math.max(0, origY + (m.clientY - startY) / zoom)
        card.style.left = at.x + 'px'
        card.style.top = at.y + 'px'
        redrawEdges()
        moved = true
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        card.classList.remove('dragging')
        if (moved) {
          resolveCollisions()
          redrawEdges()
          fitCanvas()
          void invoke('savePositions', { positions: pos })
        }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    })
    card.addEventListener('click', () => {
      for (const el of cardsLayer.querySelectorAll('.card.selected')) el.classList.remove('selected')
      card.classList.add('selected')
    })

    cardsLayer.appendChild(card)
  }

  // 根卡最先渲染（底层），后代依次
  for (const s of tree) mkCard(s)
  resolveCollisions()

  const forked = tree.filter((s) => s.forkSourceId).length
  const cur = data.sessions.find((s) => s.id === focusId)
  stat.textContent = `${tree.length} 个节点（${forked} 个派生） · 根：${truncate(cur?.title || '—', 12)}`
}

void pull()

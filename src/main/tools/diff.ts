interface Op {
  t: '=' | '-' | '+'
  s: string
}

/** 经典 LCS 构建编辑操作序列（学习用途；文件过大时性能受控由调用方限制） */
function buildOps(A: string[], B: string[]): Op[] {
  const n = A.length
  const m = B.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ t: '=', s: A[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', s: A[i] })
      i++
    } else {
      ops.push({ t: '+', s: B[j] })
      j++
    }
  }
  while (i < n) ops.push({ t: '-', s: A[i++] })
  while (j < m) ops.push({ t: '+', s: B[j++] })
  return ops
}

/**
 * 手写行级 unified diff（设计方案 7.1 edit_file）：
 * 输出 ---/+++ 头 + @@ hunk（上下文 2 行），供模型阅读与 UI 红绿渲染。
 */
export function lineDiff(a: string, b: string, label: string, context = 2): string {
  // 空串 = 零行（git /dev/null 语义）：全绿新增 / 全红删除，不产生假的一行空行
  const A = a.length === 0 ? [] : a.split('\n')
  const B = b.length === 0 ? [] : b.split('\n')
  if (A.length * B.length > 4_000_000) return '（文件过大，略去逐行 diff）'
  const ops = buildOps(A, B)
  // 预计算每个 op 的 a/b 行号（-1 表示该侧无此行）
  let ai = 1
  let bi = 1
  const meta = ops.map((op) => {
    const row = { t: op.t, s: op.s, a: op.t === '+' ? -1 : ai, b: op.t === '-' ? -1 : bi }
    if (op.t !== '+') ai++
    if (op.t !== '-') bi++
    return row
  })

  const hunks: string[] = []
  let k = 0
  while (k < meta.length) {
    if (meta[k].t === '=') {
      k++
      continue
    }
    const start = Math.max(0, k - context)
    let lastChange = k
    let end = k
    let l = k
    while (l < meta.length) {
      if (meta[l].t !== '=') {
        lastChange = l
        l++
        continue
      }
      let m2 = l
      while (m2 < meta.length && meta[m2].t === '=') m2++
      if (m2 - l > context * 2) {
        end = Math.min(meta.length - 1, lastChange + context)
        break
      }
      l = m2
    }
    if (l >= meta.length) end = Math.min(meta.length - 1, lastChange + context)

    const lines: string[] = []
    let aStart = -1
    let bStart = -1
    let aCount = 0
    let bCount = 0
    for (let x = start; x <= end; x++) {
      const op = meta[x]
      if (op.t === '=') {
        if (aStart === -1) aStart = op.a
        if (bStart === -1) bStart = op.b
        lines.push(' ' + op.s)
        aCount++
        bCount++
      } else if (op.t === '-') {
        if (aStart === -1) aStart = op.a
        lines.push('-' + op.s)
        aCount++
      } else {
        if (bStart === -1) bStart = op.b
        lines.push('+' + op.s)
        bCount++
      }
    }
    const aLine = aStart >= 0 ? aStart : meta.slice(0, start).filter((o) => o.a >= 0).length + 1
    const bLine = bStart >= 0 ? bStart : meta.slice(0, start).filter((o) => o.b >= 0).length + 1
    hunks.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@\n` + lines.join('\n'))
    k = end + 1
  }
  if (hunks.length === 0) return ''
  return `--- a/${label}\n+++ b/${label}\n` + hunks.join('\n')
}

/** 摘要统计：+N -M */
export function diffStat(diff: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++
    else if (line.startsWith('-') && !line.startsWith('---')) del++
  }
  return { add, del }
}

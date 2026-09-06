import { execSync } from 'node:child_process'

/**
 * 运行环境探测（应用进程内缓存一次）：
 * 把 python/node/git 的可用性写进系统提示词，模型开局即知，
 * 不必浪费工具轮次盲试命令（对齐 Claude Code 的 env 注入思路）。
 */

export interface EnvProbe {
  name: string
  version: string
}

export interface EnvReport {
  available: EnvProbe[]
  missing: string[]
}

function probeOnce(cmd: string): string | null {
  try {
    const out = execSync(cmd, { timeout: 5000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const line = out.trim().split('\n')[0]?.trim()
    return line || null
  } catch {
    return null
  }
}

export function probeEnvs(): EnvReport {
  const probes: { name: string; cmd: string }[] = [
    { name: 'python', cmd: 'python --version' },
    { name: 'python3', cmd: 'python3 --version' },
    { name: 'py', cmd: 'py --version' },
    { name: 'node', cmd: 'node --version' },
    { name: 'git', cmd: 'git --version' }
  ]
  const available: EnvProbe[] = []
  const missing: string[] = []
  for (const p of probes) {
    const v = probeOnce(p.cmd)
    if (v) available.push({ name: p.name, version: v })
    else missing.push(p.name)
  }
  return { available, missing }
}

let cached: EnvReport | null = null

/** 进程级缓存：探测一次，后续直接复用（装了新环境需重启应用生效） */
export function detectEnvironment(): EnvReport {
  if (!cached) cached = probeEnvs()
  return cached
}

/** 纯函数：探测结果 → 系统提示词的环境段 */
export function buildEnvSection(r: EnvReport): string {
  const lines: string[] = ['运行环境（应用启动时探测）：']
  if (r.available.length === 0) {
    lines.push('- 未检测到任何可用的 python / node / git。')
  } else {
    for (const p of r.available) lines.push(`- ${p.name}：${p.version}`)
  }
  if (r.missing.length > 0) {
    lines.push(`未检测到：${r.missing.join('、')}。若任务需要缺失的工具，直接告知用户安装，不要反复尝试执行。`)
  }
  return lines.join('\n')
}

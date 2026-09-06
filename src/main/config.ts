import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiConfig } from '@shared/types'

const DEFAULTS: ApiConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  workspacePath: '',
  recentProjects: [],
  contextWindow: 64_000,
  modelParams: {},
  readOnly: false,
  disabledTools: [],
  trustedProjects: []
}

let cached: ApiConfig | null = null

function file(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function getConfig(): ApiConfig {
  if (cached) return cached
  try {
    cached = { ...DEFAULTS, ...(JSON.parse(readFileSync(file(), 'utf-8')) as Partial<ApiConfig>) }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

export function updateConfig(partial: Partial<ApiConfig>): ApiConfig {
  const next = { ...getConfig(), ...partial }
  if (partial.workspacePath) {
    next.recentProjects = [
      partial.workspacePath,
      ...next.recentProjects.filter((p) => p !== partial.workspacePath)
    ].slice(0, 10)
  }
  cached = next
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

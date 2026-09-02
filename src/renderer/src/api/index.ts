import type { NavAgentApi } from '@shared/types'
import { MockApi } from './mock'

function bridge(): NavAgentApi | null {
  const w = window as unknown as { navagent?: NavAgentApi }
  return w.navagent ?? null
}

let instance: NavAgentApi | null = null

/** Electron 环境用真实 IPC 桥；纯浏览器（pnpm dev:web）回落到 mock */
export function getApi(): NavAgentApi {
  if (!instance) instance = bridge() ?? new MockApi()
  return instance
}

import type { NavAgentApi } from '@shared/types'

declare global {
  interface Window {
    navagent: NavAgentApi
  }
}

export {}

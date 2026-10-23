import type { GerproApi } from '../shared/ipc'

declare global {
  interface Window {
    gerpro: GerproApi
  }
}

export {}

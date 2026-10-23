import type { ToolPermission } from '@shared/tools'

const number = new Intl.NumberFormat('pt-BR')
const time = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export const formatNumber = (n: number) => number.format(n)

const gigabytes = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })

export const formatGb = (gb: number) => `${gigabytes.format(gb)} GB`

export const formatDateTime = (iso: string) => time.format(new Date(iso))

export function formatDuration(sec: number | null): string {
  if (sec === null) return '—'
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}min ${sec % 60}s`
}

export function formatContext(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens)
}

export const capabilityLabel: Record<string, string> = {
  chat: 'Chat',
  vision: 'Visão',
  tools: 'Ferramentas',
  embedding: 'Embedding',
  reasoning: 'Raciocínio'
}

export const permissionLabel: Record<ToolPermission, string> = {
  network: 'Rede',
  'filesystem:read': 'Leitura de disco',
  'filesystem:write': 'Escrita de disco',
  process: 'Processos'
}

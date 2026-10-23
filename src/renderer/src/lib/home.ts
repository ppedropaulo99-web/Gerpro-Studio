import type { AgentRecord } from '@shared/agents'
import { isTerminalRunState, type RunRecord } from '@shared/runs'

/** Mesmo dia no fuso local do computador. */
export function isSameLocalDay(iso: string, now: Date): boolean {
  const d = new Date(iso)
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

export interface HomeStats {
  /** Agentes gravados (exceto arquivados). */
  savedAgents: number
  /** Desses, quantos estão com a configuração completa ("Pronto"). */
  readyAgents: number
  /** Execuções simuladas criadas hoje (data local, nunca fixa). */
  simulationsToday: number
  /** Execuções simuladas ainda em andamento. */
  activeSimulations: number
}

/** Indicadores do Início calculados só com dados do Main. Nada fictício entra aqui. */
export function homeStats(agents: readonly AgentRecord[], runs: readonly RunRecord[], now: Date): HomeStats {
  const active = agents.filter((a) => a.definition.state !== 'archived')
  return {
    savedAgents: active.length,
    readyAgents: active.filter((a) => a.definition.state === 'ready').length,
    simulationsToday: runs.filter((r) => isSameLocalDay(r.createdAt, now)).length,
    activeSimulations: runs.filter((r) => !isTerminalRunState(r.state)).length
  }
}

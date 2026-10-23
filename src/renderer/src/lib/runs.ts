import type { RunRecord, RunState } from '@shared/runs'
import type { RunStatus } from '@renderer/data/types'

/**
 * Mapeamento explícito dos estados usados nos dados demonstrativos da
 * etapa 1 para o contrato de execuções (`@shared/runs`). A interface exibe
 * sempre o estado do contrato, venha a execução do exemplo ou do Main.
 */
export const legacyRunState: Readonly<Record<RunStatus, RunState>> = {
  queued: 'pending',
  running: 'running',
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'cancelled'
}

/** Duração em segundos inteiros; `null` enquanto não começou ou não terminou. */
export function runDurationSec(run: Pick<RunRecord, 'startedAt' | 'finishedAt'>): number | null {
  if (!run.startedAt || !run.finishedAt) return null
  return Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))
}

/** Substitui a execução pelo ID ou a acrescenta; mantém a mais recente primeiro. */
export function upsertRun(list: readonly RunRecord[], run: RunRecord): RunRecord[] {
  const next = list.some((r) => r.id === run.id) ? list.map((r) => (r.id === run.id ? run : r)) : [...list, run]
  return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

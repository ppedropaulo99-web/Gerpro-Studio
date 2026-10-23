/**
 * Contratos de execuções de agentes.
 *
 * Toda execução declara sua `origin`. Nesta etapa só existem execuções
 * `simulated`: nenhum modelo ou ferramenta real roda. A interface deve sempre
 * sinalizar essa origem e nunca apresentar uma execução simulada como real.
 */

import type { StructuredError } from './errors'
import { Checker, readSlug, type ValidationResult } from './validation'

export type RunState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type RunOrigin = 'simulated' | 'real'

/** Transições permitidas. Estados terminais não saem de si mesmos. */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  pending: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
}

export interface RunProgress {
  /** 0–100, ou `null` quando indeterminado. */
  percent: number | null
  /** Etapa atual em texto curto. */
  step: string | null
}

export interface RunMessage {
  at: string
  level: 'info' | 'warning' | 'error'
  text: string
}

export interface RunRecord {
  id: string
  agentId: string
  origin: RunOrigin
  state: RunState
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  progress: RunProgress
  messages: RunMessage[]
  error: StructuredError | null
  /** O cancelamento é cooperativo: pedido aqui, efetivado pela execução. */
  cancelRequested: boolean
}

export function isTerminalRunState(state: RunState): boolean {
  return RUN_TRANSITIONS[state].length === 0
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

/**
 * Aplica uma transição de estado e ajusta os horários. Lança erro se a
 * transição não for permitida. Não altera o objeto recebido.
 */
export function applyRunTransition(run: RunRecord, to: RunState, at: Date): RunRecord {
  if (!canTransitionRun(run.state, to)) {
    throw new Error(`Transição de execução inválida: ${run.state} → ${to}`)
  }
  const iso = at.toISOString()
  return {
    ...run,
    state: to,
    startedAt: to === 'running' ? iso : run.startedAt,
    finishedAt: isTerminalRunState(to) ? iso : run.finishedAt,
    progress: to === 'completed' ? { percent: 100, step: null } : run.progress
  }
}

// ---------------------------------------------------------------------------
// Execução demonstrativa
// ---------------------------------------------------------------------------

/** Pedido de execução simulada. `scenario` escolhe o desfecho da demonstração. */
export interface DemoRunRequest {
  agentId: string
  scenario: 'success' | 'failure'
}

export const RUN_ID_PATTERN = /^run-[a-z0-9-]{1,64}$/

export function validateDemoRunRequest(input: unknown): ValidationResult<DemoRunRequest> {
  const c = new Checker()
  const obj = c.record(input, '$', ['agentId', 'scenario'])
  if (!obj) return c.result<DemoRunRequest>(undefined)
  const agentId = readSlug(c, obj['agentId'], '$.agentId')
  const scenario = c.oneOf(obj['scenario'], '$.scenario', ['success', 'failure'] as const)
  return c.result(agentId && scenario ? { agentId, scenario } : undefined)
}

export function validateRunId(input: unknown): ValidationResult<string> {
  const c = new Checker()
  return c.result(c.string(input, '$', { pattern: RUN_ID_PATTERN, patternMessage: 'ID de execução inválido' }))
}

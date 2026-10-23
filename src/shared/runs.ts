/**
 * Contratos de execuções de agentes.
 *
 * Toda execução declara sua `origin`. Nesta etapa só existem execuções
 * `simulated`: o ciclo de vida é real (fila, cancelamento, tempo limite), mas
 * quem responde é o provedor simulado, nunca um modelo. A interface deve
 * sempre sinalizar essa origem e nunca apresentar uma execução simulada como
 * real. O tipo garante a separação: uma execução simulada pode registrar o
 * modelo simulado resolvido e o texto simulado, mas nunca métricas
 * (`metrics: null`); só uma execução `real` tem métricas medidas.
 */

import type { StructuredError } from './errors'
import { readRunOverrides, type ResolvedExecution, type RunOverrides } from './execution'
import type { InferenceMetrics } from './inference'
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

interface RunRecordBase {
  id: string
  agentId: string
  state: RunState
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  progress: RunProgress
  messages: RunMessage[]
  error: StructuredError | null
  /** Registra que o usuário pediu o cancelamento (o Main o efetiva na hora). */
  cancelRequested: boolean
  /**
   * Aumenta a cada alteração. Respostas de IPC e eventos podem chegar fora de
   * ordem; quem recebe guarda a versão de maior `revision`.
   */
  revision: number
}

/**
 * Execução simulada: respondida pelo provedor simulado (`kind: 'simulated'`).
 * Registra o modelo simulado resolvido e o texto simulado gerado; nunca tem
 * métricas, porque nada foi medido. `execution` é `null` quando a execução
 * terminou antes de resolver um modelo.
 */
export interface SimulatedRunRecord extends RunRecordBase {
  origin: 'simulated'
  execution: ResolvedExecution | null
  /** Texto simulado gerado até agora. */
  output: string
  metrics: null
}

/** Execução real (futura): registra o modelo e o perfil efetivamente usados. */
export interface RealRunRecord extends RunRecordBase {
  origin: 'real'
  execution: ResolvedExecution
  /** Texto gerado até agora (saída em texto simples). */
  output: string
  /** Só valores medidos; `null` enquanto não houver medição. */
  metrics: InferenceMetrics | null
}

export type RunRecord = SimulatedRunRecord | RealRunRecord

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
export function applyRunTransition<T extends RunRecord>(run: T, to: RunState, at: Date): T {
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
// Execução demonstrativa (canal de compatibilidade `runs:start-demo`)
// ---------------------------------------------------------------------------

/**
 * Pedido de demonstração. `scenario` escolhe o desfecho. Mantido por
 * compatibilidade: o Main o converte num `RunRequest` para o provedor simulado.
 */
export interface DemoRunRequest {
  agentId: string
  scenario: 'success' | 'failure'
}

export const RUN_ID_PATTERN = /^run-[a-z0-9-]{1,64}$/

// ---------------------------------------------------------------------------
// Pedido de execução (canal `runs:start`)
// ---------------------------------------------------------------------------

export const RUN_INPUT_MAX = 32_000

/**
 * Limites aplicados pelo serviço de execuções no Main.
 * - `inputChars`: mensagem do usuário (validada no IPC).
 * - `promptChars`: instruções do agente + mensagem, antes de chegar ao provedor.
 * - `outputChars`: texto acumulado; ao atingir, a geração é interrompida e a
 *   execução conclui com a saída truncada.
 * - `maxPending`: execuções aguardando na fila (uma roda por vez).
 * - `maxRecords`: histórico em memória (as encerradas mais antigas saem primeiro).
 * O limite de contexto (tokens) é verificado pelo provedor, que conhece o modelo.
 */
export const RUN_LIMITS = {
  inputChars: RUN_INPUT_MAX,
  promptChars: 64_000,
  outputChars: 200_000,
  maxPending: 10,
  maxRecords: 100
} as const

/** Pedido de execução: agente, mensagem do usuário e substituições opcionais. */
export interface RunRequest {
  agentId: string
  input: string
  overrides: RunOverrides | null
}

export function validateRunRequest(input: unknown): ValidationResult<RunRequest> {
  const c = new Checker()
  const obj = c.record(input, '$', ['agentId', 'input', 'overrides'])
  if (!obj) return c.result<RunRequest>(undefined)
  const agentId = readSlug(c, obj['agentId'], '$.agentId')
  const text = c.string(obj['input'], '$.input', { min: 1, max: RUN_INPUT_MAX })
  if (text !== undefined && !text.trim()) c.fail('$.input', 'não pode ficar em branco')
  const overrides = c.nullable(obj['overrides'], '$.overrides', (v, p) => readRunOverrides(c, v, p))
  return c.result(agentId && text !== undefined && overrides !== undefined && c.ok ? { agentId, input: text, overrides } : undefined)
}

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

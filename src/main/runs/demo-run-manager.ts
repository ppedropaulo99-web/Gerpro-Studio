import { randomBytes } from 'node:crypto'
import {
  applyRunTransition,
  isTerminalRunState,
  validateDemoRunRequest,
  validateRunId,
  type DemoRunRequest,
  type RunMessage,
  type RunRecord,
  type SimulatedRunRecord
} from '@shared/runs'
import { AppError, unwrap } from '../errors'

/**
 * Gerenciador DEMONSTRATIVO de execuções.
 *
 * Não chama modelo nem ferramenta alguma: apenas percorre etapas fixas com
 * temporizadores para exercitar estados, progresso, mensagens, erros e
 * cancelamento. Toda execução criada aqui tem `origin: 'simulated'`, e as
 * mensagens dizem isso explicitamente. Execuções vivem só em memória.
 */

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type RunListener = (run: RunRecord) => void

export interface DemoRunManagerOptions {
  /** O agente existe e pode receber execuções? */
  canRun: (agentId: string) => { ok: true } | { ok: false; reason: string }
  stepDelayMs?: number
  maxRecords?: number
  now?: () => Date
  scheduler?: Scheduler
  newId?: () => string
}

export const DEMO_STEPS = [
  'Preparando contexto (simulado)',
  'Planejando resposta (simulado)',
  'Chamando ferramenta (simulado)',
  'Gerando resposta (simulado)'
] as const

export const DEFAULT_STEP_DELAY_MS = 700

/** Etapa em que o cenário `failure` falha. */
const FAILURE_STEP = 2

const defaultScheduler: Scheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

interface Entry {
  run: SimulatedRunRecord
  scenario: DemoRunRequest['scenario']
  /** Próxima etapa a executar; -1 antes de começar. */
  step: number
  timer: unknown
}

export class DemoRunManager {
  private readonly runs = new Map<string, Entry>()
  private readonly listeners = new Set<RunListener>()
  private readonly options: Required<DemoRunManagerOptions>

  constructor(options: DemoRunManagerOptions) {
    // `??` e não spread: uma opção passada como `undefined` deve cair no padrão.
    this.options = {
      canRun: options.canRun,
      stepDelayMs: options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS,
      maxRecords: options.maxRecords ?? 100,
      now: options.now ?? (() => new Date()),
      scheduler: options.scheduler ?? defaultScheduler,
      newId: options.newId ?? (() => `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`)
    }
  }

  onUpdate(listener: RunListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Mais recente primeiro. */
  list(): RunRecord[] {
    return [...this.runs.values()].map((e) => structuredClone(e.run)).reverse()
  }

  get(id: string): RunRecord | undefined {
    const entry = this.runs.get(id)
    return entry && structuredClone(entry.run)
  }

  start(input: unknown): RunRecord {
    const request = unwrap(validateDemoRunRequest(input))
    const check = this.options.canRun(request.agentId)
    if (!check.ok) throw new AppError('invalid-state', check.reason)

    const createdAt = this.iso()
    const run: SimulatedRunRecord = {
      id: this.options.newId(),
      agentId: request.agentId,
      origin: 'simulated',
      execution: null,
      state: 'pending',
      createdAt,
      startedAt: null,
      finishedAt: null,
      progress: { percent: 0, step: null },
      messages: [{ at: createdAt, level: 'info', text: 'Execução simulada criada. Nenhum modelo ou ferramenta real será executado.' }],
      error: null,
      cancelRequested: false
    }
    const entry: Entry = { run, scenario: request.scenario, step: -1, timer: undefined }
    this.runs.set(run.id, entry)
    this.prune()
    this.emit(entry)
    this.schedule(entry)
    return structuredClone(run)
  }

  /**
   * Pede o cancelamento. Pendente: cancela na hora. Em execução: marca o
   * pedido e a execução encerra na próxima etapa (cancelamento cooperativo).
   */
  cancel(input: unknown): RunRecord {
    const id = unwrap(validateRunId(input))
    const entry = this.runs.get(id)
    if (!entry) throw new AppError('not-found', `Execução "${id}" não encontrada.`)
    if (isTerminalRunState(entry.run.state)) {
      throw new AppError('invalid-state', `Execução já encerrada (${entry.run.state}).`)
    }
    if (entry.run.cancelRequested) return structuredClone(entry.run)

    entry.run = { ...entry.run, cancelRequested: true }
    this.addMessage(entry, 'warning', 'Cancelamento solicitado.')
    if (entry.run.state === 'pending') {
      this.options.scheduler.clearTimeout(entry.timer)
      this.finishCancelled(entry)
    }
    this.emit(entry)
    return structuredClone(entry.run)
  }

  /** Para todos os temporizadores (encerramento do app). */
  dispose(): void {
    for (const entry of this.runs.values()) this.options.scheduler.clearTimeout(entry.timer)
    this.listeners.clear()
  }

  private schedule(entry: Entry): void {
    entry.timer = this.options.scheduler.setTimeout(() => this.tick(entry), this.options.stepDelayMs)
  }

  private tick(entry: Entry): void {
    entry.timer = undefined
    if (isTerminalRunState(entry.run.state)) return

    if (entry.run.cancelRequested) {
      this.finishCancelled(entry)
    } else if (entry.run.state === 'pending') {
      entry.run = applyRunTransition(entry.run, 'running', this.options.now())
      entry.step = 0
      this.addMessage(entry, 'info', 'Execução simulada iniciada.')
      this.schedule(entry)
    } else if (entry.scenario === 'failure' && entry.step === FAILURE_STEP) {
      entry.run = {
        ...applyRunTransition(entry.run, 'failed', this.options.now()),
        error: {
          code: 'simulated-failure',
          message: 'Falha simulada para demonstração do tratamento de erros.',
          retryable: true,
          details: { step: DEMO_STEPS[entry.step] }
        }
      }
      this.addMessage(entry, 'error', `Falha simulada em "${DEMO_STEPS[entry.step]}".`)
    } else if (entry.step < DEMO_STEPS.length) {
      const step = DEMO_STEPS[entry.step]
      entry.run = { ...entry.run, progress: { percent: Math.round(((entry.step + 1) / DEMO_STEPS.length) * 100), step } }
      this.addMessage(entry, 'info', step)
      entry.step++
      this.schedule(entry)
    } else {
      entry.run = applyRunTransition(entry.run, 'completed', this.options.now())
      this.addMessage(entry, 'info', 'Execução simulada concluída.')
    }
    this.emit(entry)
  }

  private finishCancelled(entry: Entry): void {
    entry.run = applyRunTransition(entry.run, 'cancelled', this.options.now())
    this.addMessage(entry, 'warning', 'Execução cancelada.')
  }

  private addMessage(entry: Entry, level: RunMessage['level'], text: string): void {
    entry.run = { ...entry.run, messages: [...entry.run.messages, { at: this.iso(), level, text }] }
  }

  private emit(entry: Entry): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(entry.run))
      } catch (error) {
        console.error('[runs] listener falhou:', error)
      }
    }
  }

  /** Mantém no máximo `maxRecords`, descartando primeiro as mais antigas já encerradas. */
  private prune(): void {
    for (const [id, entry] of this.runs) {
      if (this.runs.size <= this.options.maxRecords) break
      if (isTerminalRunState(entry.run.state)) this.runs.delete(id)
    }
  }

  private iso(): string {
    return this.options.now().toISOString()
  }
}

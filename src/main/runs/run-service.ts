import { randomBytes } from 'node:crypto'
import type { AgentDefinition } from '@shared/agents'
import { resolveExecution, type ExecutionResolutionError, type ResolvedExecution } from '@shared/execution'
import {
  inferenceError,
  isRealProvider,
  toStructuredError,
  validateInferenceEvent,
  validateProviderModel,
  type ChatMessage,
  type InferenceError,
  type InferenceErrorCode,
  type InferenceProvider,
  type InferenceRequest,
  type ProviderInfo,
  type ProviderModelEntry
} from '@shared/inference'
import {
  applyRunTransition,
  isTerminalRunState,
  RUN_LIMITS,
  validateRunId,
  validateRunRequest,
  type RunMessage,
  type RunRecord,
  type RunRequest,
  type RunState
} from '@shared/runs'
import { AppError, unwrap } from '../errors'
import { defaultScheduler, type Scheduler } from './scheduler'

/**
 * Serviço de execuções do Main.
 *
 * Recebe pedidos validados, resolve modelo e perfil, enfileira (FIFO, uma
 * execução ativa por vez) e consome os eventos do provedor, refletindo-os no
 * `RunRecord`. Cancelamento por `AbortController`; tempo limite contado só a
 * partir do início da geração. Cada execução é finalizada uma única vez,
 * mesmo quando cancelamento, tempo limite e conclusão chegam juntos.
 *
 * Origem: execuções atendidas por provedor `simulated` são `origin:
 * 'simulated'` e nunca têm métricas. Histórico só em memória, sem nova
 * tentativa automática. Independe do Renderer: avisa ouvintes com cópias.
 */

export type RunListener = (run: RunRecord) => void

/**
 * Ponto de extensão para políticas de recursos (memória livre medida, uso de
 * GPU, execuções simultâneas por modelo). Recebe a execução já resolvida e
 * devolve um erro para recusá-la. O padrão aceita tudo: o app não aplica
 * `maxRamGb` de hardware demonstrativo nem estimado.
 */
export type ResourcePolicy = (context: { agentId: string; provider: ProviderInfo; execution: ResolvedExecution }) => InferenceError | null

export type RunLimits = { [K in keyof typeof RUN_LIMITS]: number }

/**
 * Situação da execução de agentes, em três níveis independentes:
 * - `infrastructure`: fila, cancelamento, tempo limite e eventos funcionam;
 * - `simulation`: há provedor simulado para exercitá-los;
 * - `realEngine`: há provedor capaz de inferência real.
 * Só `realEngine` diz se um agente pode rodar de verdade.
 */
export interface RunCapabilities {
  infrastructure: 'functional'
  simulation: 'available' | 'unavailable'
  realEngine: 'available' | 'unavailable'
}

export interface RunServiceOptions {
  providers: readonly InferenceProvider[]
  findAgent: (id: string) => AgentDefinition | undefined
  limits?: Partial<RunLimits>
  /** Intervalo de agrupamento das atualizações de texto (50–100 ms). */
  flushIntervalMs?: number
  resourcePolicy?: ResourcePolicy
  now?: () => Date
  scheduler?: Scheduler
  newId?: () => string
}

export const DEFAULT_FLUSH_INTERVAL_MS = 75

const RESOLUTION_TO_INFERENCE: Record<ExecutionResolutionError['code'], InferenceErrorCode> = {
  'no-model': 'invalid-request',
  'model-not-installed': 'model-not-found',
  'ambiguous-provider': 'invalid-request'
}

interface Entry {
  run: RunRecord
  provider: InferenceProvider
  request: InferenceRequest
  controller: AbortController | null
  timeoutTimer: unknown
  flushTimer: unknown
  /** Há texto ainda não enviado aos ouvintes. */
  dirty: boolean
  /** Já passou pela finalização (estado terminal emitido). */
  finished: boolean
}

export class RunService {
  private readonly runs = new Map<string, Entry>()
  private readonly queue: Entry[] = []
  private active: Entry | null = null
  private readonly listeners = new Set<RunListener>()
  private readonly limits: RunLimits
  private readonly options: Required<Omit<RunServiceOptions, 'limits'>>
  /** Inventário em andamento; abortado em `dispose`. */
  private readonly lifetime = new AbortController()
  private disposed = false

  constructor(options: RunServiceOptions) {
    const ids = options.providers.map((p) => p.info.id)
    if (new Set(ids).size !== ids.length) throw new Error('Provedores com ID repetido.')
    this.limits = { ...RUN_LIMITS, ...options.limits }
    // `??` e não spread: uma opção passada como `undefined` deve cair no padrão.
    this.options = {
      providers: options.providers,
      findAgent: options.findAgent,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      resourcePolicy: options.resourcePolicy ?? (() => null),
      now: options.now ?? (() => new Date()),
      scheduler: options.scheduler ?? defaultScheduler,
      newId: options.newId ?? (() => `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`)
    }
  }

  capabilities(): RunCapabilities {
    const { providers } = this.options
    return {
      infrastructure: 'functional',
      simulation: providers.some((p) => p.info.kind === 'simulated') ? 'available' : 'unavailable',
      realEngine: providers.some((p) => isRealProvider(p.info)) ? 'available' : 'unavailable'
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

  /** Valida, resolve e enfileira. Devolve a execução como estava ao entrar na fila. */
  async start(input: unknown): Promise<RunRecord> {
    const request = unwrap(validateRunRequest(input))
    this.assertAccepting()
    const agent = this.options.findAgent(request.agentId)
    if (!agent) throw new AppError('not-found', `Agente "${request.agentId}" não encontrado.`)
    if (agent.state === 'archived') throw new AppError('invalid-state', 'Agente arquivado não pode ser executado.')
    this.assertQueueRoom()

    const resolved = resolveExecution(
      { model: agent.defaultModel, profile: agent.defaultProfile },
      request.overrides,
      await this.inventory()
    )
    if (!resolved.ok) {
      const { code, message } = resolved.error
      throw inferenceAppError(inferenceError(RESOLUTION_TO_INFERENCE[code], message), { resolution: code })
    }
    const execution = resolved.value
    const provider = this.options.providers.find((p) => p.info.id === execution.model.providerId)!
    const messages = buildMessages(agent, request)
    const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0)
    if (promptChars > this.limits.promptChars) {
      throw inferenceAppError(
        inferenceError('context-too-long', `Instruções e mensagem somam ${promptChars} caracteres; o limite é ${this.limits.promptChars}.`)
      )
    }
    const refused = this.options.resourcePolicy({ agentId: agent.id, provider: provider.info, execution })
    if (refused) throw inferenceAppError(refused)

    // O inventário é assíncrono: o estado pode ter mudado enquanto isso.
    this.assertAccepting()
    this.assertQueueRoom()

    const entry: Entry = {
      run: this.newRecord(agent.id, provider, execution),
      provider,
      request: { model: execution.model, messages, profile: execution.profile },
      controller: null,
      timeoutTimer: undefined,
      flushTimer: undefined,
      dirty: false,
      finished: false
    }
    const snapshot = structuredClone(entry.run)
    this.runs.set(entry.run.id, entry)
    this.queue.push(entry)
    this.prune()
    this.emit(entry)
    this.pump()
    return snapshot
  }

  /**
   * Pendente: sai da fila e é cancelada. Em andamento: a geração é abortada e
   * a execução encerra como cancelada na hora, sem esperar o provedor.
   */
  cancel(input: unknown): RunRecord {
    const id = unwrap(validateRunId(input))
    const entry = this.runs.get(id)
    if (!entry) throw new AppError('not-found', `Execução "${id}" não encontrada.`)
    if (entry.finished || isTerminalRunState(entry.run.state)) {
      throw new AppError('invalid-state', `Execução já encerrada (${entry.run.state}).`)
    }
    this.commit(entry, { ...entry.run, cancelRequested: true })
    this.addMessage(entry, 'warning', 'Cancelamento solicitado.')
    this.finish(entry, 'cancelled', { message: { level: 'warning', text: 'Execução cancelada.' } })
    return structuredClone(entry.run)
  }

  /** Encerramento do app: aborta a geração, para temporizadores e não emite mais nada. */
  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
    for (const entry of this.runs.values()) {
      entry.finished = true
      this.clearTimers(entry)
      entry.controller?.abort()
    }
    this.queue.length = 0
    this.active = null
    this.listeners.clear()
  }

  // -------------------------------------------------------------------------
  // Fila e geração
  // -------------------------------------------------------------------------

  private pump(): void {
    if (this.disposed || this.active) return
    const next = this.queue.shift()
    if (!next) return
    this.active = next
    void this.execute(next).catch((error) => {
      console.error('[runs] falha inesperada na execução:', error)
      this.fail(next, inferenceError('provider-error', 'Falha inesperada ao processar a execução.'))
    })
  }

  private async execute(entry: Entry): Promise<void> {
    const controller = new AbortController()
    entry.controller = controller
    this.commit(entry, applyRunTransition(entry.run, 'running', this.options.now()))
    this.addMessage(entry, 'info', entry.run.origin === 'simulated' ? 'Execução simulada iniciada.' : 'Execução iniciada.')
    this.emit(entry)

    const timeoutSeconds = entry.request.profile.timeoutSeconds
    entry.timeoutTimer = this.options.scheduler.setTimeout(() => {
      entry.timeoutTimer = undefined
      this.fail(entry, inferenceError('timeout', `Tempo limite de ${timeoutSeconds} s esgotado.`))
    }, timeoutSeconds * 1000)

    try {
      for await (const raw of entry.provider.generate(entry.request, controller.signal)) {
        if (entry.finished) break
        const checked = validateInferenceEvent(raw)
        if (!checked.ok) {
          this.fail(entry, inferenceError('provider-error', 'O provedor enviou um evento inválido.'))
          break
        }
        const event = checked.value
        if (event.type === 'loading') {
          this.commit(entry, { ...entry.run, progress: { percent: null, step: 'Carregando modelo' } })
          this.emit(entry)
        } else if (event.type === 'delta') {
          if (!this.appendOutput(entry, event.text)) break
        } else if (event.type === 'done') {
          if (event.finishReason === 'cancelled') {
            this.finish(entry, 'cancelled', { message: { level: 'warning', text: 'O provedor encerrou a geração antes do fim.' } })
          } else {
            if (event.metrics && entry.run.origin === 'real') this.commit(entry, { ...entry.run, metrics: event.metrics })
            const text =
              event.finishReason === 'length' ? 'Geração interrompida no limite de saída do perfil.' : completedText(entry.run.origin)
            this.finish(entry, 'completed', { message: { level: event.finishReason === 'length' ? 'warning' : 'info', text } })
          }
          break
        } else {
          if (event.error.code === 'cancelled') {
            this.finish(entry, 'cancelled', { message: { level: 'warning', text: event.error.message } })
          } else {
            this.fail(entry, event.error)
          }
          break
        }
      }
      if (!entry.finished) this.fail(entry, inferenceError('provider-error', 'O provedor encerrou sem concluir a geração.'))
    } catch (error) {
      if (!entry.finished) {
        console.error('[runs] o provedor falhou:', error)
        this.fail(entry, inferenceError('provider-error', 'O provedor falhou durante a geração.'))
      }
    }
  }

  /** Acumula o texto respeitando o limite. Devolve `false` se a geração deve parar. */
  private appendOutput(entry: Entry, text: string): boolean {
    if (!text) return true
    const room = this.limits.outputChars - entry.run.output.length
    if (text.length > room) {
      this.commit(entry, { ...entry.run, output: entry.run.output + text.slice(0, room) })
      this.finish(entry, 'completed', {
        message: { level: 'warning', text: `Saída interrompida no limite de ${this.limits.outputChars} caracteres.` }
      })
      return false
    }
    this.commit(entry, { ...entry.run, output: entry.run.output + text, progress: { percent: null, step: 'Gerando resposta' } })
    this.scheduleFlush(entry)
    return true
  }

  private fail(entry: Entry, error: InferenceError): void {
    this.finish(entry, 'failed', { error, message: { level: 'error', text: error.message } })
  }

  /**
   * Único caminho para um estado terminal. Idempotente: a primeira chamada
   * vence (cancelamento, tempo limite, erro ou conclusão).
   */
  private finish(entry: Entry, state: Extract<RunState, 'completed' | 'failed' | 'cancelled'>, outcome: { error?: InferenceError; message: Pick<RunMessage, 'level' | 'text'> }): void {
    if (entry.finished) return
    entry.finished = true
    this.clearTimers(entry)
    entry.controller?.abort()
    const queued = this.queue.indexOf(entry)
    if (queued >= 0) this.queue.splice(queued, 1)

    this.commit(entry, {
      ...applyRunTransition(entry.run, state, this.options.now()),
      error: outcome.error ? toStructuredError(outcome.error) : null
    })
    this.addMessage(entry, outcome.message.level, outcome.message.text)
    this.emit(entry)

    if (this.active === entry) {
      this.active = null
      this.pump()
    }
  }

  // -------------------------------------------------------------------------
  // Eventos
  // -------------------------------------------------------------------------

  /** Texto novo é agrupado: no máximo uma atualização por intervalo. */
  private scheduleFlush(entry: Entry): void {
    entry.dirty = true
    if (entry.flushTimer !== undefined) return
    entry.flushTimer = this.options.scheduler.setTimeout(() => {
      entry.flushTimer = undefined
      if (!entry.finished && entry.dirty) this.emit(entry)
    }, this.options.flushIntervalMs)
  }

  /** Envia o estado atual na hora (inclui todo o texto acumulado). */
  private emit(entry: Entry): void {
    if (this.disposed) return
    entry.dirty = false
    if (entry.flushTimer !== undefined) {
      this.options.scheduler.clearTimeout(entry.flushTimer)
      entry.flushTimer = undefined
    }
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(entry.run))
      } catch (error) {
        console.error('[runs] listener falhou:', error)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Auxiliares
  // -------------------------------------------------------------------------

  private async inventory(): Promise<ProviderModelEntry[]> {
    const lists = await Promise.all(
      this.options.providers.map(async (provider) => {
        try {
          const raw: unknown[] = await provider.listModels(this.lifetime.signal)
          // Dados externos: só entram modelos locais, válidos e do próprio provedor.
          return raw.flatMap((item) => {
            const checked = validateProviderModel(item)
            if (!checked.ok) return []
            const { model } = checked.value
            return model.ref.providerId === provider.info.id && model.location === 'local' ? [checked.value] : []
          })
        } catch {
          return []
        }
      })
    )
    return lists.flat()
  }

  private newRecord(agentId: string, provider: InferenceProvider, execution: ResolvedExecution): RunRecord {
    const createdAt = this.iso()
    const simulated = provider.info.kind === 'simulated'
    const base = {
      id: this.options.newId(),
      agentId,
      execution,
      state: 'pending' as const,
      createdAt,
      startedAt: null,
      finishedAt: null,
      progress: { percent: null, step: null },
      messages: [
        {
          at: createdAt,
          level: 'info' as const,
          text: simulated
            ? `Execução simulada criada com "${execution.model.modelId}". O provedor simulado responde com texto fixo; nenhum modelo real é executado.`
            : `Execução criada com "${execution.model.modelId}" (${provider.info.displayName}).`
        }
      ],
      error: null,
      cancelRequested: false,
      revision: 0,
      output: '',
      metrics: null
    }
    return simulated ? { ...base, origin: 'simulated' } : { ...base, origin: 'real' }
  }

  /** Toda alteração passa por aqui para incrementar `revision`. */
  private commit(entry: Entry, run: RunRecord): void {
    entry.run = { ...run, revision: entry.run.revision + 1 }
  }

  private addMessage(entry: Entry, level: RunMessage['level'], text: string): void {
    this.commit(entry, { ...entry.run, messages: [...entry.run.messages, { at: this.iso(), level, text }] })
  }

  private clearTimers(entry: Entry): void {
    for (const key of ['timeoutTimer', 'flushTimer'] as const) {
      if (entry[key] !== undefined) this.options.scheduler.clearTimeout(entry[key])
      entry[key] = undefined
    }
  }

  private assertAccepting(): void {
    if (this.disposed) throw new AppError('invalid-state', 'O serviço de execuções foi encerrado.')
  }

  private assertQueueRoom(): void {
    if (this.queue.length >= this.limits.maxPending) {
      throw new AppError('conflict', `A fila já tem ${this.limits.maxPending} execuções aguardando. Aguarde ou cancele alguma.`, {
        retryable: true,
        details: { maxPending: this.limits.maxPending }
      })
    }
  }

  /** Mantém no máximo `maxRecords`, descartando primeiro as mais antigas já encerradas. */
  private prune(): void {
    for (const [id, entry] of this.runs) {
      if (this.runs.size <= this.limits.maxRecords) break
      if (entry.finished) this.runs.delete(id)
    }
  }

  private iso(): string {
    return this.options.now().toISOString()
  }
}

function buildMessages(agent: AgentDefinition, request: RunRequest): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (agent.instructions.trim()) messages.push({ role: 'system', content: agent.instructions })
  messages.push({ role: 'user', content: request.input })
  return messages
}

function completedText(origin: RunRecord['origin']): string {
  return origin === 'simulated' ? 'Execução simulada concluída.' : 'Execução concluída.'
}

/** Erro de inferência recusado antes de enfileirar, com o código preservado. */
function inferenceAppError(error: InferenceError, extra: Record<string, string> = {}): AppError {
  const structured = toStructuredError(error)
  return new AppError('inference', structured.message, { retryable: structured.retryable, details: { ...structured.details, ...extra } })
}

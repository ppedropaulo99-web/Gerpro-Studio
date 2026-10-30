import { randomBytes } from 'node:crypto'
import type { AgentDefinition } from '@shared/agents'
import type { StructuredError } from '@shared/errors'
import { resolveExecution, type ExecutionResolutionError, type ResolvedExecution } from '@shared/execution'
import {
  inferenceError,
  isRealProvider,
  PROVIDER_STATES,
  sameModel,
  toStructuredError,
  validateInferenceEvent,
  validateProviderModel,
  type ChatMessage,
  type InferenceError,
  type InferenceErrorCode,
  type InferenceProvider,
  type InferenceRequest,
  type ModelRef,
  type ProviderInfo,
  type ProviderModelEntry,
  type ProviderOverview,
  type ProviderStatus
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
import { InferenceProviderError } from '../engine/provider-error'
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
 * Origem: decorre do provedor que atende a execução. Provedor `simulated`
 * gera `origin: 'simulated'` (nunca com métricas); qualquer outro, `real`.
 * Histórico só em memória, sem nova tentativa automática. Independe do
 * Renderer: avisa ouvintes com cópias.
 *
 * Provedores: o serviço guarda o último estado verificado e o inventário de
 * cada um (`refreshProviders`). O motor real só conta como disponível quando
 * um provedor real respondeu `ready`; estar registrado não basta.
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

/** Dados de uma execução que vêm do próprio Main, nunca do IPC. */
export interface RunContext {
  history?: readonly ChatMessage[]
}

/**
 * Situação da execução de agentes, em três níveis independentes:
 * - `infrastructure`: fila, cancelamento, tempo limite e eventos funcionam;
 * - `simulation`: há provedor simulado para exercitá-los;
 * - `realEngine`: um provedor capaz de inferência real respondeu na última verificação.
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
  /** Prazo de cada verificação de provedor (estado e inventário). */
  providerCheckTimeoutMs?: number
}

export const DEFAULT_FLUSH_INTERVAL_MS = 75

/** Verificações mais recentes que isto são reaproveitadas por `refreshProviders(maxAgeMs)`. */
export const PROVIDER_REFRESH_MAX_AGE_MS = 5_000

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
  /** Última verificação de cada provedor: estado e modelos locais (`null` = não consultado). */
  private readonly checked = new Map<string, { status: ProviderStatus; models: ProviderModelEntry[] | null }>()
  private lastRefresh: { at: number; promise: Promise<void> } | null = null

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
      newId: options.newId ?? (() => `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`),
      providerCheckTimeoutMs: options.providerCheckTimeoutMs ?? 10_000
    }
  }

  /** Síncrono: usa a última verificação (`refreshProviders`). */
  capabilities(): RunCapabilities {
    const { providers } = this.options
    return {
      infrastructure: 'functional',
      simulation: providers.some((p) => p.info.kind === 'simulated') ? 'available' : 'unavailable',
      realEngine: providers.some((p) => isRealProvider(p.info) && this.isReady(p)) ? 'available' : 'unavailable'
    }
  }

  /**
   * Se um provedor real pronto tem `model` instalado, segundo a última
   * verificação. `providerId: null` aceita qualquer provedor real.
   */
  canRunReal(model: ModelRef | null): boolean {
    if (!model) return false
    return this.options.providers.some((p) => {
      if (!isRealProvider(p.info) || !this.isReady(p)) return false
      const models = this.checked.get(p.info.id)?.models ?? []
      return models.some((e) => (model.providerId === null ? e.model.ref.modelId === model.modelId : sameModel(e.model.ref, model)))
    })
  }

  /**
   * Verifica estado e inventário de todos os provedores, em paralelo e com
   * prazo. Nunca rejeita: falhas viram estado (`unreachable`, `error`).
   * Com `maxAgeMs`, reaproveita a verificação em andamento ou recente.
   */
  refreshProviders(maxAgeMs = 0): Promise<void> {
    const now = Date.now()
    if (this.lastRefresh && now - this.lastRefresh.at <= maxAgeMs) return this.lastRefresh.promise
    const promise = Promise.all(this.options.providers.map((p) => this.check(p))).then(() => undefined)
    this.lastRefresh = { at: now, promise }
    return promise
  }

  /** Situação atual dos provedores, depois de uma verificação nova. */
  async providers(): Promise<ProviderOverview[]> {
    await this.refreshProviders()
    return this.options.providers.map((p) => {
      const checked = this.checked.get(p.info.id)
      return structuredClone({ info: p.info, status: checked?.status ?? neverChecked(p), models: checked?.models ?? null })
    })
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

  /**
   * Valida, resolve e enfileira. Devolve a execução como estava ao entrar na fila.
   *
   * `context.history`: mensagens anteriores de uma conversa, montadas no Main
   * (`ConversationService`); vão entre as instruções do agente e a nova
   * mensagem e contam no limite `promptChars`. Não chega pelo IPC: o canal
   * `runs:start` repassa só o `RunRequest`.
   */
  async start(input: unknown, context: RunContext = {}): Promise<RunRecord> {
    const request = unwrap(validateRunRequest(input))
    this.assertAccepting()
    const agent = this.options.findAgent(request.agentId)
    if (!agent) throw new AppError('not-found', `Agente "${request.agentId}" não encontrado.`)
    if (agent.state === 'archived') throw new AppError('invalid-state', 'Agente arquivado não pode ser executado.')
    this.assertQueueRoom()

    const inventory = await this.inventory()
    const resolved = resolveExecution({ model: agent.defaultModel, profile: agent.defaultProfile }, request.overrides, inventory.entries)
    if (!resolved.ok) {
      const { code, message } = resolved.error
      // "Não instalado" só é afirmado se o provedor em questão respondeu.
      const wanted = request.overrides?.model ?? agent.defaultModel
      const unreachable =
        code === 'model-not-installed' && wanted
          ? [...inventory.failures].find(([id]) => wanted.providerId === null || wanted.providerId === id)
          : undefined
      if (unreachable) throw inferenceAppError(unreachable[1], { resolution: code, providerId: unreachable[0] })
      throw inferenceAppError(inferenceError(RESOLUTION_TO_INFERENCE[code], message), { resolution: code })
    }
    const execution = resolved.value
    const provider = this.options.providers.find((p) => p.info.id === execution.model.providerId)!
    const history = checkHistory(context.history ?? [])
    const messages = buildMessages(agent, request, history)
    const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0)
    if (promptChars > this.limits.promptChars) {
      throw inferenceAppError(
        inferenceError(
          'context-too-long',
          `${history.length > 0 ? 'Instruções, histórico e mensagem' : 'Instruções e mensagem'} somam ${promptChars} caracteres; o limite é ${this.limits.promptChars}.`
        )
      )
    }
    const refused = this.options.resourcePolicy({ agentId: agent.id, provider: provider.info, execution })
    if (refused) throw inferenceAppError(refused)

    // O inventário é assíncrono: o estado pode ter mudado enquanto isso.
    this.assertAccepting()
    this.assertQueueRoom()

    const entry: Entry = {
      run: this.newRecord(agent.id, provider, execution, history.length),
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
            // Limite atingido sem nenhum texto (ex.: o modelo gastou os tokens raciocinando):
            // não há resposta, então não é uma conclusão bem-sucedida.
            if (event.finishReason === 'length' && !entry.run.output.trim()) {
              const limit = entry.request.profile.maxOutputTokens
              this.fail(
                entry,
                inferenceError(
                  'invalid-request',
                  `O limite de saída do perfil${limit === null ? '' : ` (${limit} tokens)`} foi atingido antes de qualquer texto de resposta. Modelos com raciocínio podem consumir o limite antes de responder; aumente o limite de saída.`
                ),
                { reason: 'output-limit-before-text' }
              )
              break
            }
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

  /** `details` acrescenta marcas estruturadas ao erro (ex.: `reason`), para a interface não depender do texto. */
  private fail(entry: Entry, error: InferenceError, details?: Record<string, string>): void {
    this.finish(entry, 'failed', { error, details, message: { level: 'error', text: error.message } })
  }

  /**
   * Único caminho para um estado terminal. Idempotente: a primeira chamada
   * vence (cancelamento, tempo limite, erro ou conclusão).
   */
  private finish(
    entry: Entry,
    state: Extract<RunState, 'completed' | 'failed' | 'cancelled'>,
    outcome: { error?: InferenceError; details?: Record<string, string>; message: Pick<RunMessage, 'level' | 'text'> }
  ): void {
    if (entry.finished) return
    entry.finished = true
    this.clearTimers(entry)
    entry.controller?.abort()
    const queued = this.queue.indexOf(entry)
    if (queued >= 0) this.queue.splice(queued, 1)

    this.commit(entry, {
      ...applyRunTransition(entry.run, state, this.options.now()),
      error: outcome.error ? withDetails(toStructuredError(outcome.error), outcome.details) : null
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

  /**
   * Modelos locais de todos os provedores e, à parte, os provedores que não
   * puderam ser consultados (com o erro). Atualiza a última verificação.
   */
  private async inventory(): Promise<{ entries: ProviderModelEntry[]; failures: Map<string, InferenceError> }> {
    const failures = new Map<string, InferenceError>()
    const lists = await Promise.all(
      this.options.providers.map(async (provider) => {
        const result = await this.listProviderModels(provider)
        const previous = this.checked.get(provider.info.id)
        if (!result.ok) {
          failures.set(provider.info.id, result.error)
          if (result.error.code === 'provider-unavailable') {
            const status: ProviderStatus = {
              ...(previous?.status ?? neverChecked(provider)),
              state: 'unreachable',
              checkedAt: this.iso(),
              message: result.error.message
            }
            this.checked.set(provider.info.id, { status, models: null })
          }
          return []
        }
        if (previous) this.checked.set(provider.info.id, { ...previous, models: result.models })
        return result.models
      })
    )
    return { entries: lists.flat(), failures }
  }

  /** Inventário de um provedor. Dados externos: só entram modelos locais, válidos e do próprio provedor. */
  private async listProviderModels(
    provider: InferenceProvider
  ): Promise<{ ok: true; models: ProviderModelEntry[] } | { ok: false; error: InferenceError }> {
    try {
      const raw: unknown = await withDeadline((signal) => provider.listModels(signal), this.lifetime.signal, this.options.providerCheckTimeoutMs)
      if (!Array.isArray(raw)) {
        return { ok: false, error: inferenceError('provider-error', `${provider.info.displayName}: inventário em formato inválido.`) }
      }
      const models = raw.flatMap((item: unknown) => {
        const checked = validateProviderModel(item)
        if (!checked.ok) return []
        const { model } = checked.value
        return model.ref.providerId === provider.info.id && model.location === 'local' ? [checked.value] : []
      })
      return { ok: true, models }
    } catch (error) {
      if (error instanceof InferenceProviderError) return { ok: false, error: error.error }
      return { ok: false, error: inferenceError('provider-error', `Falha ao consultar os modelos de ${provider.info.displayName}.`) }
    }
  }

  /** Estado e, se pronto, inventário de um provedor. Nunca rejeita. */
  private async check(provider: InferenceProvider): Promise<void> {
    const failed = (message: string): ProviderStatus => ({ ...neverChecked(provider), state: 'error', checkedAt: this.iso(), message })
    let status: ProviderStatus
    try {
      const raw = await withDeadline((signal) => provider.status(signal), this.lifetime.signal, this.options.providerCheckTimeoutMs)
      status = raw.providerId === provider.info.id && PROVIDER_STATES.includes(raw.state) ? raw : failed('Estado inválido informado pelo provedor.')
    } catch {
      status = failed('Falha ao verificar o provedor.')
    }
    let models: ProviderModelEntry[] | null = null
    if (status.state === 'ready') {
      const result = await this.listProviderModels(provider)
      if (result.ok) models = result.models
      else status = { ...status, state: result.error.code === 'provider-unavailable' ? 'unreachable' : 'error', message: result.error.message }
    }
    if (!this.disposed) this.checked.set(provider.info.id, { status, models })
  }

  private isReady(provider: InferenceProvider): boolean {
    return this.checked.get(provider.info.id)?.status.state === 'ready'
  }

  private newRecord(agentId: string, provider: InferenceProvider, execution: ResolvedExecution, historyCount: number): RunRecord {
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
        },
        // Só a contagem: o conteúdo da conversa não vai para o registro técnico.
        ...(historyCount > 0
          ? [{ at: createdAt, level: 'info' as const, text: `Contexto: ${historyCount} mensagem(ns) anterior(es) da conversa enviada(s).` }]
          : [])
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

function withDetails(error: StructuredError, details: Record<string, string> | undefined): StructuredError {
  return details ? { ...error, details: { ...error.details, ...details } } : error
}

function neverChecked(provider: InferenceProvider): ProviderStatus {
  return { providerId: provider.info.id, state: 'not-detected', version: null, checkedAt: null, message: 'Ainda não verificado.' }
}

/**
 * Roda `task` com um sinal que aborta com `lifetime` ou ao fim do prazo. Se
 * o provedor ignorar o sinal, a espera termina mesmo assim.
 */
function withDeadline<T>(task: (signal: AbortSignal) => Promise<T>, lifetime: AbortSignal, timeoutMs: number): Promise<T> {
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(timeoutMs)])
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Verificação do provedor interrompida.'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    task(signal)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function buildMessages(agent: AgentDefinition, request: RunRequest, history: readonly ChatMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (agent.instructions.trim()) messages.push({ role: 'system', content: agent.instructions })
  messages.push(...history.map((m) => ({ role: m.role, content: m.content })))
  messages.push({ role: 'user', content: request.input })
  return messages
}

/** O histórico vem do Main, mas só entram papéis de conversa (as instruções são do agente). */
function checkHistory(history: readonly ChatMessage[]): ChatMessage[] {
  for (const m of history) {
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw new AppError('validation', 'Histórico de conversa inválido.')
    }
  }
  return [...history]
}

function completedText(origin: RunRecord['origin']): string {
  return origin === 'simulated' ? 'Execução simulada concluída.' : 'Execução concluída.'
}

/** Erro de inferência recusado antes de enfileirar, com o código preservado. */
function inferenceAppError(error: InferenceError, extra: Record<string, string> = {}): AppError {
  const structured = toStructuredError(error)
  return new AppError('inference', structured.message, { retryable: structured.retryable, details: { ...structured.details, ...extra } })
}

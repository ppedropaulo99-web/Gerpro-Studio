import {
  INFERENCE_LIMITS,
  inferenceError,
  isValidModelId,
  validateInferenceMetrics,
  validateProviderModel,
  type FinishReason,
  type InferenceErrorCode,
  type InferenceEvent,
  type InferenceMetrics,
  type InferenceProvider,
  type InferenceRequest,
  type ModelCapability,
  type ProviderInfo,
  type ProviderModelEntry,
  type ProviderStatus
} from '@shared/inference'
import { isRecord } from '@shared/validation'
import { localFetch, LocalHttpError, parseLoopbackUrl, readJson, readLines, readText } from '../local-http'
import { InferenceProviderError } from '../provider-error'

/**
 * Adaptador do Ollama (`kind: 'external'`).
 *
 * Converte entre os contratos de inferência e a API HTTP local do Ollama
 * (`/api/version`, `/api/tags`, `/api/chat` com streaming NDJSON). Nada do
 * formato do Ollama sai deste arquivo: o `RunService` e a interface só veem
 * `ProviderStatus`, `ProviderModelEntry` e `InferenceEvent`.
 *
 * - Só fala com o serviço neste computador (loopback); não baixa modelos,
 *   não instala nem inicia o Ollama.
 * - Toda resposta é tratada como dado externo: tamanho limitado, estrutura
 *   conferida, ids de modelo validados, eventos malformados viram erro.
 * - Métricas só quando o Ollama as informa; o tempo até o primeiro texto é
 *   medido aqui. Nada é estimado.
 * - Não registra prompts nem respostas.
 */

export const OLLAMA_PROVIDER_ID = 'ollama'

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434'

export const OLLAMA_LIMITS = {
  /** `/api/version` e corpos de erro. */
  smallBodyBytes: 16_384,
  /** `/api/tags`. */
  tagsBytes: 4 * 1024 * 1024,
  maxModels: 1_000,
  /** Cada evento do streaming. */
  lineBytes: 1024 * 1024,
  /** Corpo inteiro do streaming. */
  streamBytes: 64 * 1024 * 1024,
  /** Trecho do erro do Ollama repassado na mensagem. */
  providerMessage: 300
} as const

export type OllamaLimits = { [K in keyof typeof OLLAMA_LIMITS]: number }

export interface OllamaProviderOptions {
  /** Endereço do serviço; só loopback. Padrão: `OLLAMA_DEFAULT_URL`. */
  baseUrl?: string
  /** Prazo de `/api/version`. */
  statusTimeoutMs?: number
  /** Prazo de `/api/tags`. */
  listTimeoutMs?: number
  now?: () => Date
  /** Relógio monotônico (ms) para o tempo até o primeiro texto. */
  clock?: () => number
  /** Substitui limites de tamanho (testes). */
  limits?: Partial<OllamaLimits>
}

const CAPABILITIES: Record<string, ModelCapability> = {
  completion: 'chat',
  vision: 'vision',
  tools: 'tools',
  embedding: 'embedding',
  thinking: 'reasoning'
}

export class OllamaInferenceProvider implements InferenceProvider {
  readonly info: ProviderInfo = { id: OLLAMA_PROVIDER_ID, displayName: 'Ollama', kind: 'external' }
  readonly origin: string
  private readonly statusTimeoutMs: number
  private readonly listTimeoutMs: number
  private readonly now: () => Date
  private readonly clock: () => number
  private readonly limits: OllamaLimits

  constructor(options: OllamaProviderOptions = {}) {
    this.origin = parseLoopbackUrl(options.baseUrl ?? OLLAMA_DEFAULT_URL)
    this.statusTimeoutMs = options.statusTimeoutMs ?? 3_000
    this.listTimeoutMs = options.listTimeoutMs ?? 10_000
    this.now = options.now ?? (() => new Date())
    this.clock = options.clock ?? (() => performance.now())
    this.limits = { ...OLLAMA_LIMITS, ...options.limits }
  }

  async status(signal: AbortSignal): Promise<ProviderStatus> {
    const status = (state: ProviderStatus['state'], message: string, version: string | null = null): ProviderStatus => ({
      providerId: this.info.id,
      state,
      version,
      checkedAt: this.now().toISOString(),
      message
    })
    try {
      const { response, signal: s } = await localFetch(this.origin, '/api/version', { method: 'GET', signal, timeoutMs: this.statusTimeoutMs })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return status('error', `O Ollama respondeu com HTTP ${response.status} ao informar a versão.`)
      }
      const body = await readJson(response, this.limits.smallBodyBytes, s)
      const version = isRecord(body) ? body['version'] : undefined
      if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,50}$/.test(version)) {
        return status('error', 'O serviço em execução não respondeu como o Ollama.')
      }
      return status('ready', `Ollama ${version} respondendo em ${this.origin}.`, version)
    } catch (error) {
      if (error instanceof LocalHttpError && (error.kind === 'unreachable' || error.kind === 'timeout')) {
        return status('unreachable', `O Ollama não respondeu em ${this.origin}. Verifique se ele está aberto.`)
      }
      return status('error', 'Falha ao verificar o Ollama.')
    }
  }

  /**
   * Modelos instalados, como o Ollama os informa. Lança
   * `InferenceProviderError` (`provider-unavailable` ou `provider-error`)
   * quando não há como consultar; lista vazia significa "respondeu, sem modelos".
   */
  async listModels(signal: AbortSignal): Promise<ProviderModelEntry[]> {
    let body: unknown
    try {
      const { response, signal: s } = await localFetch(this.origin, '/api/tags', { method: 'GET', signal, timeoutMs: this.listTimeoutMs })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new InferenceProviderError(inferenceError('provider-error', `O Ollama respondeu com HTTP ${response.status} ao listar modelos.`))
      }
      body = await readJson(response, this.limits.tagsBytes, s)
    } catch (error) {
      throw toProviderError(error, this.origin)
    }
    const models = isRecord(body) ? body['models'] : undefined
    if (!Array.isArray(models)) {
      throw new InferenceProviderError(inferenceError('provider-error', 'O Ollama devolveu uma lista de modelos em formato inesperado.'))
    }
    const seen = new Set<string>()
    const entries: ProviderModelEntry[] = []
    for (const raw of models.slice(0, this.limits.maxModels)) {
      const entry = this.toEntry(raw)
      if (!entry || seen.has(entry.model.ref.modelId)) continue
      seen.add(entry.model.ref.modelId)
      entries.push(entry)
    }
    return entries
  }

  async *generate(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent> {
    const { modelId, providerId } = request.model
    if (providerId !== this.info.id) {
      yield { type: 'error', error: inferenceError('model-not-found', `O modelo "${modelId}" não pertence ao Ollama.`) }
      return
    }
    if (!isValidModelId(modelId)) {
      yield { type: 'error', error: inferenceError('invalid-request', 'Identificador de modelo inválido.') }
      return
    }

    yield { type: 'loading' }
    const startedAt = this.clock()
    let firstTextAt: number | null = null
    try {
      const { response, signal: s } = await localFetch(this.origin, '/api/chat', { method: 'POST', body: chatBody(request), signal })
      if (!response.ok) {
        yield { type: 'error', error: await httpError(response, modelId, s) }
        return
      }
      for await (const line of readLines(response, { maxLineBytes: this.limits.lineBytes, maxTotalBytes: this.limits.streamBytes }, s)) {
        const chunk = parseChunk(line)
        if (chunk.kind === 'invalid') {
          yield { type: 'error', error: inferenceError('provider-error', 'O Ollama enviou um evento malformado.') }
          return
        }
        if (chunk.kind === 'error') {
          yield { type: 'error', error: classifyMessage(chunk.message, null, modelId) }
          return
        }
        if (chunk.text) {
          firstTextAt ??= this.clock()
          for (let i = 0; i < chunk.text.length; i += INFERENCE_LIMITS.deltaText) {
            yield { type: 'delta', text: chunk.text.slice(i, i + INFERENCE_LIMITS.deltaText) }
          }
        }
        if (chunk.done) {
          const ttft = firstTextAt === null ? null : firstTextAt - startedAt
          yield { type: 'done', finishReason: chunk.finishReason, metrics: this.metrics(chunk.stats, ttft) }
          return
        }
      }
      yield { type: 'error', error: inferenceError('provider-error', 'O Ollama encerrou a resposta antes de concluir.') }
    } catch (error) {
      // Cancelamento e tempo limite vêm do RunService, que já encerrou a execução.
      if (signal.aborted) return
      yield { type: 'error', error: toProviderError(error, this.origin).error }
    }
  }

  // -------------------------------------------------------------------------
  // Conversões
  // -------------------------------------------------------------------------

  /** Converte um item de `/api/tags`; itens inválidos são descartados. */
  private toEntry(raw: unknown): ProviderModelEntry | null {
    if (!isRecord(raw)) return null
    // `model` é o nome usado nas chamadas; `name` é o equivalente em versões antigas.
    const modelId = isValidModelId(raw['model']) ? raw['model'] : isValidModelId(raw['name']) ? raw['name'] : null
    if (!modelId) return null
    const details = isRecord(raw['details']) ? raw['details'] : {}
    const capabilities = Array.isArray(raw['capabilities'])
      ? [...new Set(raw['capabilities'].flatMap((c) => (typeof c === 'string' && CAPABILITIES[c] ? [CAPABILITIES[c]] : [])))]
      : []
    const entry: ProviderModelEntry = {
      availability: 'installed',
      model: {
        ref: { providerId: this.info.id, modelId },
        digest: text(raw['digest'], 200, /^[A-Za-z0-9:._-]+$/),
        // Modelos de nuvem do Ollama aparecem na lista, mas rodam fora do computador.
        location: 'remote_host' in raw || 'remote_model' in raw ? 'remote' : 'local',
        displayName: modelId,
        family: text(details['family'], INFERENCE_LIMITS.metadata),
        parameterSize: text(details['parameter_size'], INFERENCE_LIMITS.metadata),
        quantization: text(details['quantization_level'], INFERENCE_LIMITS.metadata),
        format: text(details['format'], INFERENCE_LIMITS.metadata),
        sizeBytes: count(raw['size'], INFERENCE_LIMITS.sizeBytes),
        contextLength: positive(details['context_length'], INFERENCE_LIMITS.contextLength),
        contextBytesPerToken: null,
        capabilities
      }
    }
    return validateProviderModel(entry).ok ? entry : null
  }

  /** Métricas informadas no evento final (durações em nanossegundos). */
  private metrics(stats: Record<string, unknown>, timeToFirstTokenMs: number | null): InferenceMetrics | null {
    const ms = (v: unknown) => {
      const ns = count(v, INFERENCE_LIMITS.durationMs * 1e6)
      return ns === null ? null : ns / 1e6
    }
    const outputTokens = count(stats['eval_count'], INFERENCE_LIMITS.tokens)
    const evalMs = ms(stats['eval_duration'])
    const tps = outputTokens !== null && evalMs ? Math.round((outputTokens / (evalMs / 1000)) * 100) / 100 : null
    const metrics: InferenceMetrics = {
      source: 'measured',
      measuredAt: this.now().toISOString(),
      loadMs: ms(stats['load_duration']),
      timeToFirstTokenMs: timeToFirstTokenMs !== null && timeToFirstTokenMs >= 0 ? Math.round(timeToFirstTokenMs) : null,
      totalMs: ms(stats['total_duration']),
      promptTokens: count(stats['prompt_eval_count'], INFERENCE_LIMITS.tokens),
      outputTokens,
      outputTokensPerSecond: tps !== null && tps <= INFERENCE_LIMITS.tokensPerSecond ? tps : null,
      peakMemoryBytes: null
    }
    const measured = Object.entries(metrics).some(([k, v]) => k !== 'source' && k !== 'measuredAt' && v !== null)
    return measured && validateInferenceMetrics(metrics).ok ? metrics : null
  }
}

// ---------------------------------------------------------------------------
// Pedido e respostas de /api/chat
// ---------------------------------------------------------------------------

function chatBody(request: InferenceRequest): Record<string, unknown> {
  const { profile } = request
  const options: Record<string, number> = { temperature: profile.temperature, top_p: profile.topP }
  if (profile.maxOutputTokens !== null) options['num_predict'] = profile.maxOutputTokens
  if (profile.contextLength !== null) options['num_ctx'] = profile.contextLength
  if (profile.seed !== null) options['seed'] = profile.seed
  if (profile.cpuThreads !== null) options['num_thread'] = profile.cpuThreads
  if (profile.gpuMode === 'cpu-only') options['num_gpu'] = 0
  return {
    model: request.model.modelId,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    options
  }
}

type Chunk =
  | { kind: 'invalid' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; text: string; done: false }
  | { kind: 'data'; text: string; done: true; finishReason: FinishReason; stats: Record<string, unknown> }

/**
 * Um evento do streaming: `{ message: { content }, done }`, o final com
 * `done: true`, `done_reason` e estatísticas, ou `{ error }`. O raciocínio
 * de modelos que pensam (`message.thinking`) não entra na resposta.
 */
function parseChunk(line: string): Chunk {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { kind: 'invalid' }
  }
  if (!isRecord(value)) return { kind: 'invalid' }
  if ('error' in value) return typeof value['error'] === 'string' ? { kind: 'error', message: value['error'] } : { kind: 'invalid' }
  const done = value['done']
  if (typeof done !== 'boolean') return { kind: 'invalid' }
  let text = ''
  if ('message' in value) {
    const message = value['message']
    if (!isRecord(message)) return { kind: 'invalid' }
    const content = message['content'] ?? ''
    if (typeof content !== 'string') return { kind: 'invalid' }
    text = content
  }
  if (!done) return { kind: 'data', text, done }
  return { kind: 'data', text, done, finishReason: value['done_reason'] === 'length' ? 'length' : 'stop', stats: value }
}

async function httpError(response: Response, modelId: string, signal: AbortSignal) {
  let message = ''
  try {
    const body = JSON.parse(await readText(response, OLLAMA_LIMITS.smallBodyBytes, signal)) as unknown
    if (isRecord(body) && typeof body['error'] === 'string') message = body['error']
  } catch {
    // Corpo ausente, grande demais ou fora do formato: fica só o código HTTP.
  }
  return classifyMessage(message, response.status, modelId)
}

/** Traduz um erro do Ollama (status HTTP, se houver, + texto) para o código de inferência. */
function classifyMessage(raw: string, status: number | null, modelId: string) {
  const message = sanitize(raw)
  const lower = message.toLowerCase()
  const detail = message ? ` Ollama: ${message}` : ''
  const is = (pattern: RegExp) => pattern.test(lower)
  let code: InferenceErrorCode
  let text: string
  if (status === 404 || (is(/model/) && is(/not found/))) {
    code = 'model-not-found'
    text = `O modelo "${modelId}" não está instalado no Ollama.`
  } else if (is(/memory|out of memory|\boom\b/)) {
    code = 'insufficient-memory'
    text = 'Memória insuficiente para carregar ou rodar o modelo.'
  } else if (is(/context|too long|exceeds/)) {
    code = 'context-too-long'
    text = 'A mensagem excede o contexto aceito pelo modelo.'
  } else if (is(/unsupported|unknown model architecture|does not support/)) {
    code = 'model-unsupported'
    text = 'O Ollama não suporta este modelo para conversa.'
  } else if (status !== null && status >= 400 && status < 500) {
    code = 'invalid-request'
    text = `O Ollama recusou o pedido (HTTP ${status}).`
  } else {
    code = 'provider-error'
    text = status === null ? 'O Ollama falhou durante a geração.' : `O Ollama falhou (HTTP ${status}).`
  }
  return inferenceError(code, `${text}${detail}`.slice(0, INFERENCE_LIMITS.errorMessage))
}

/** Converte falhas de transporte em erro de inferência. */
function toProviderError(error: unknown, origin: string): InferenceProviderError {
  if (error instanceof InferenceProviderError) return error
  if (error instanceof LocalHttpError) {
    switch (error.kind) {
      case 'unreachable':
      case 'timeout':
        return new InferenceProviderError(inferenceError('provider-unavailable', `O Ollama não respondeu em ${origin}. Verifique se ele está aberto.`))
      case 'aborted':
        return new InferenceProviderError(inferenceError('cancelled', 'Consulta ao Ollama cancelada.'))
      case 'too-large':
        return new InferenceProviderError(inferenceError('provider-error', 'A resposta do Ollama excedeu o limite de tamanho.'))
      case 'invalid-body':
        return new InferenceProviderError(inferenceError('provider-error', 'O Ollama enviou uma resposta ilegível.'))
    }
  }
  return new InferenceProviderError(inferenceError('provider-error', 'Falha inesperada na comunicação com o Ollama.'))
}

// ---------------------------------------------------------------------------
// Leitura de campos externos
// ---------------------------------------------------------------------------

const text = (v: unknown, max: number, pattern?: RegExp) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) && (!pattern || pattern.test(v)) ? v : null

const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null)

const positive = (v: unknown, max: number) => (count(v, max) || null)

/** Sem caracteres de controle, numa linha e curto. */
const sanitize = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, OLLAMA_LIMITS.providerMessage)

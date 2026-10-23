/**
 * Contratos de provedores de inferência local.
 *
 * Um provedor é quem roda modelos neste computador: um processo externo
 * (ex.: Ollama, temporariamente) ou, no futuro, o runtime próprio do Gerpro
 * Studio. Agentes, execuções e interface dependem só destes contratos, nunca
 * de um provedor específico. O único provedor implementado é o simulado
 * (`kind: 'simulated'`), que exercita o ciclo de vida sem inferência real:
 * não há chamadas HTTP nem modelos rodando.
 *
 * Separação deliberada:
 * - identidade do modelo (`ModelRef`, `ProviderModel`);
 * - disponibilidade (`ModelAvailability`, `ProviderStatus`);
 * - requisitos (`AgentRequirements`, em `recommendations.ts`);
 * - parâmetros de execução (`ExecutionProfile`, em `execution.ts`).
 */

import type { StructuredError } from './errors'
import type { ExecutionProfile } from './execution'
import { Checker, readSlug, type ValidationResult } from './validation'

// ---------------------------------------------------------------------------
// Identidade do modelo
// ---------------------------------------------------------------------------

/**
 * Identificação estável de um modelo: provedor + identificador no provedor.
 * `providerId: null` significa "ainda não vinculado": qualquer provedor que
 * ofereça `modelId` serve, e a resolução acontece ao iniciar a execução.
 */
export interface ModelRef {
  providerId: string | null
  modelId: string
}

/** Referência já resolvida para um provedor. É o que uma execução real registra. */
export type ResolvedModelRef = ModelRef & { providerId: string }

export const MODEL_ID_MAX = 200

/** Sem caracteres de controle e sem espaços nas pontas. Aceita ids como `llama3.2:3b` ou `org/modelo:q4_k_m`. */
const MODEL_ID_PATTERN = /^[^\s\x00-\x1f\x7f](?:[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f])?$/

export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId
}

export const MODEL_CAPABILITIES = ['chat', 'vision', 'tools', 'embedding', 'reasoning'] as const
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number]

/**
 * Modelo como o provedor o descreve. Só metadados informados pelo provedor:
 * o que ele não informar fica `null`, nunca estimado aqui.
 */
export interface ProviderModel {
  ref: ResolvedModelRef
  /** Impressão digital do conteúdo, se o provedor informar. Muda quando o modelo é substituído sob o mesmo id. */
  digest: string | null
  /**
   * Onde o modelo roda. Um provedor local pode oferecer modelos hospedados
   * fora do computador (`remote`); eles nunca contam como execução local.
   */
  location: 'local' | 'remote'
  displayName: string
  family: string | null
  /** Como o provedor informa, ex.: `8B`. */
  parameterSize: string | null
  quantization: string | null
  format: string | null
  sizeBytes: number | null
  contextLength: number | null
  /**
   * Memória por token de contexto (cache de atenção), em bytes, quando o
   * provedor expõe os metadados da arquitetura. `null` = desconhecida.
   */
  contextBytesPerToken: number | null
  capabilities: ModelCapability[]
}

export const MODEL_AVAILABILITY = ['installed', 'not-installed', 'downloading', 'error'] as const
export type ModelAvailability = (typeof MODEL_AVAILABILITY)[number]

/** Item do inventário de um provedor: identidade e disponibilidade ficam separadas. */
export interface ProviderModelEntry {
  model: ProviderModel
  availability: ModelAvailability
}

// ---------------------------------------------------------------------------
// Provedor
// ---------------------------------------------------------------------------

/**
 * - `external`: processo separado, instalado e gerenciado fora do app (ex.: Ollama).
 * - `embedded`: runtime próprio do Gerpro Studio (futuro).
 * - `simulated`: respostas determinísticas para validar o ciclo de vida. Não
 *   é motor de inferência: execuções feitas com ele são `origin: 'simulated'`
 *   e não provam compatibilidade com o hardware.
 * Só provedores locais existem: modelos remotos estão bloqueados.
 */
export type ProviderKind = 'external' | 'embedded' | 'simulated'

/** Provedores capazes de inferência real. */
export function isRealProvider(info: ProviderInfo): boolean {
  return info.kind !== 'simulated'
}

export interface ProviderInfo {
  id: string
  displayName: string
  kind: ProviderKind
}

/**
 * - `not-configured`: o usuário ainda não habilitou o provedor.
 * - `not-detected`: habilitado, mas não encontrado neste computador.
 * - `unreachable`: encontrado, mas não respondeu (pode estar parado).
 * - `starting`: iniciando.
 * - `ready`: respondendo e com versão compatível.
 * - `incompatible-version`: versão fora da faixa suportada.
 * - `error`: falha inesperada na verificação.
 */
export const PROVIDER_STATES = ['not-configured', 'not-detected', 'unreachable', 'starting', 'ready', 'incompatible-version', 'error'] as const
export type ProviderState = (typeof PROVIDER_STATES)[number]

export interface ProviderStatus {
  providerId: string
  state: ProviderState
  /** Versão informada pelo provedor; `null` se não verificada. */
  version: string | null
  /** Momento da última verificação; `null` se nunca verificado. */
  checkedAt: string | null
  message: string | null
}

// ---------------------------------------------------------------------------
// Geração: mensagens, eventos de streaming, métricas e erros
// ---------------------------------------------------------------------------

/** Mensagens de texto simples. Ferramentas ficam para quando houver executores. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface InferenceRequest {
  model: ResolvedModelRef
  messages: ChatMessage[]
  profile: ExecutionProfile
}

/**
 * Métricas medidas pelo provedor ou pelo app durante uma geração real.
 * `source: 'measured'` é obrigatório: execuções simuladas não têm métricas,
 * e nenhum valor estimado ou fictício entra aqui. Campos não medidos ficam `null`.
 */
export interface InferenceMetrics {
  source: 'measured'
  measuredAt: string
  loadMs: number | null
  timeToFirstTokenMs: number | null
  totalMs: number | null
  promptTokens: number | null
  outputTokens: number | null
  outputTokensPerSecond: number | null
  peakMemoryBytes: number | null
}

export const INFERENCE_ERROR_CODES = [
  'provider-unavailable',
  'model-not-found',
  'model-unsupported',
  'insufficient-memory',
  'context-too-long',
  'timeout',
  'cancelled',
  'invalid-request',
  'provider-error'
] as const
export type InferenceErrorCode = (typeof INFERENCE_ERROR_CODES)[number]

/**
 * O que cada erro diz sobre a compatibilidade do modelo com o dispositivo:
 * - `permanent`: o provedor recusou o modelo (formato ou arquitetura sem suporte);
 * - `transient`: pode dar certo em outra tentativa (memória ocupada, provedor parado, tempo esgotado);
 * - `none`: não fala do modelo (pedido inválido, modelo não instalado, cancelamento).
 * Falta de memória é transitória: depende do que mais estava aberto.
 */
export const INFERENCE_ERROR_NATURE: Record<InferenceErrorCode, 'permanent' | 'transient' | 'none'> = {
  'provider-unavailable': 'transient',
  'model-not-found': 'none',
  'model-unsupported': 'permanent',
  'insufficient-memory': 'transient',
  'context-too-long': 'none',
  timeout: 'transient',
  cancelled: 'none',
  'invalid-request': 'none',
  'provider-error': 'transient'
}

export interface InferenceError {
  code: InferenceErrorCode
  message: string
  retryable: boolean
}

export function inferenceError(code: InferenceErrorCode, message: string): InferenceError {
  return { code, message, retryable: INFERENCE_ERROR_NATURE[code] === 'transient' }
}

/** Converte para o erro estruturado das execuções, preservando o código de inferência. */
export function toStructuredError(error: InferenceError): StructuredError {
  return { code: 'inference', message: error.message, retryable: error.retryable, details: { inferenceCode: error.code } }
}

export type FinishReason = 'stop' | 'length' | 'cancelled'

/** Eventos de uma geração, na ordem: `loading`? → `delta`* → `done` | `error`. */
export type InferenceEvent =
  | { type: 'loading' }
  | { type: 'delta'; text: string }
  | { type: 'done'; finishReason: FinishReason; metrics: InferenceMetrics | null }
  | { type: 'error'; error: InferenceError }

/**
 * O que qualquer provedor implementa no Main. Respostas do provedor são
 * dados externos: passam por `validateProviderModel` e `validateInferenceEvent`.
 */
export interface InferenceProvider {
  readonly info: ProviderInfo
  status(signal: AbortSignal): Promise<ProviderStatus>
  listModels(signal: AbortSignal): Promise<ProviderModelEntry[]>
  generate(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>
}

// ---------------------------------------------------------------------------
// Validação (IPC e respostas de provedores)
// ---------------------------------------------------------------------------

export const INFERENCE_LIMITS = {
  deltaText: 65_536,
  displayName: 200,
  metadata: 100,
  sizeBytes: 2 ** 50,
  contextLength: 10_000_000,
  contextBytesPerToken: 16_777_216,
  durationMs: 86_400_000,
  tokens: 100_000_000,
  tokensPerSecond: 1_000_000,
  errorMessage: 2_000
} as const

export function readModelRef(c: Checker, value: unknown, path: string): ModelRef | undefined {
  const obj = c.record(value, path, ['providerId', 'modelId'])
  if (!obj) return undefined
  const providerId = c.nullable(obj['providerId'], `${path}.providerId`, (v, p) => readSlug(c, v, p))
  const modelId = c.string(obj['modelId'], `${path}.modelId`, {
    min: 1,
    max: MODEL_ID_MAX,
    pattern: MODEL_ID_PATTERN,
    patternMessage: 'sem caracteres de controle nem espaços nas pontas'
  })
  if (providerId === undefined || modelId === undefined) return undefined
  return { providerId, modelId }
}

function readResolvedModelRef(c: Checker, value: unknown, path: string): ResolvedModelRef | undefined {
  const ref = readModelRef(c, value, path)
  if (ref && ref.providerId === null) return c.fail(`${path}.providerId`, 'obrigatório')
  return ref as ResolvedModelRef | undefined
}

export function validateModelRef(input: unknown): ValidationResult<ModelRef> {
  const c = new Checker()
  return c.result(readModelRef(c, input, '$'))
}

const optionalText = (c: Checker, v: unknown, p: string) => c.nullable(v, p, (x, q) => c.string(x, q, { max: INFERENCE_LIMITS.metadata }))
const optionalCount = (c: Checker, v: unknown, p: string, max: number, integer = true) =>
  c.nullable(v, p, (x, q) => c.number(x, q, { min: 0, max, integer }))

function readProviderModel(c: Checker, value: unknown, path: string): ProviderModel | undefined {
  const keys = [
    'ref',
    'digest',
    'location',
    'displayName',
    'family',
    'parameterSize',
    'quantization',
    'format',
    'sizeBytes',
    'contextLength',
    'contextBytesPerToken',
    'capabilities'
  ] as const
  const obj = c.record(value, path, keys)
  if (!obj) return undefined
  const model = {
    ref: readResolvedModelRef(c, obj['ref'], `${path}.ref`),
    digest: c.nullable(obj['digest'], `${path}.digest`, (v, p) => c.string(v, p, { min: 1, max: 200, pattern: /^[A-Za-z0-9:._-]+$/ })),
    location: c.oneOf(obj['location'], `${path}.location`, ['local', 'remote'] as const),
    displayName: c.string(obj['displayName'], `${path}.displayName`, { min: 1, max: INFERENCE_LIMITS.displayName }),
    family: optionalText(c, obj['family'], `${path}.family`),
    parameterSize: optionalText(c, obj['parameterSize'], `${path}.parameterSize`),
    quantization: optionalText(c, obj['quantization'], `${path}.quantization`),
    format: optionalText(c, obj['format'], `${path}.format`),
    sizeBytes: optionalCount(c, obj['sizeBytes'], `${path}.sizeBytes`, INFERENCE_LIMITS.sizeBytes),
    contextLength: c.nullable(obj['contextLength'], `${path}.contextLength`, (v, p) =>
      c.number(v, p, { min: 1, max: INFERENCE_LIMITS.contextLength, integer: true })
    ),
    contextBytesPerToken: c.nullable(obj['contextBytesPerToken'], `${path}.contextBytesPerToken`, (v, p) =>
      c.number(v, p, { min: 1, max: INFERENCE_LIMITS.contextBytesPerToken, integer: true })
    ),
    capabilities: c.array(obj['capabilities'], `${path}.capabilities`, (v, p) => c.oneOf(v, p, MODEL_CAPABILITIES), {
      max: MODEL_CAPABILITIES.length,
      unique: true
    })
  }
  return c.ok ? (model as ProviderModel) : undefined
}

/** Valida um item do inventário vindo do provedor. */
export function validateProviderModel(input: unknown): ValidationResult<ProviderModelEntry> {
  const c = new Checker()
  const obj = c.record(input, '$', ['model', 'availability'])
  if (!obj) return c.result<ProviderModelEntry>(undefined)
  const model = readProviderModel(c, obj['model'], '$.model')
  const availability = c.oneOf(obj['availability'], '$.availability', MODEL_AVAILABILITY)
  return c.result(model && availability ? { model, availability } : undefined)
}

function readMetrics(c: Checker, value: unknown, path: string): InferenceMetrics | undefined {
  const keys = ['source', 'measuredAt', 'loadMs', 'timeToFirstTokenMs', 'totalMs', 'promptTokens', 'outputTokens', 'outputTokensPerSecond', 'peakMemoryBytes'] as const
  const obj = c.record(value, path, keys)
  if (!obj) return undefined
  const { durationMs, tokens, tokensPerSecond, sizeBytes } = INFERENCE_LIMITS
  const metrics = {
    source: c.oneOf(obj['source'], `${path}.source`, ['measured'] as const),
    measuredAt: c.isoDate(obj['measuredAt'], `${path}.measuredAt`),
    loadMs: optionalCount(c, obj['loadMs'], `${path}.loadMs`, durationMs, false),
    timeToFirstTokenMs: optionalCount(c, obj['timeToFirstTokenMs'], `${path}.timeToFirstTokenMs`, durationMs, false),
    totalMs: optionalCount(c, obj['totalMs'], `${path}.totalMs`, durationMs, false),
    promptTokens: optionalCount(c, obj['promptTokens'], `${path}.promptTokens`, tokens),
    outputTokens: optionalCount(c, obj['outputTokens'], `${path}.outputTokens`, tokens),
    outputTokensPerSecond: optionalCount(c, obj['outputTokensPerSecond'], `${path}.outputTokensPerSecond`, tokensPerSecond, false),
    peakMemoryBytes: optionalCount(c, obj['peakMemoryBytes'], `${path}.peakMemoryBytes`, sizeBytes)
  }
  return c.ok ? (metrics as InferenceMetrics) : undefined
}

export function validateInferenceMetrics(input: unknown): ValidationResult<InferenceMetrics> {
  const c = new Checker()
  return c.result(readMetrics(c, input, '$'))
}

/** Valida cada evento recebido do provedor antes de repassá-lo. */
export function validateInferenceEvent(input: unknown): ValidationResult<InferenceEvent> {
  const c = new Checker()
  const obj = c.record(input, '$')
  if (!obj) return c.result<InferenceEvent>(undefined)
  const type = c.oneOf(obj['type'], '$.type', ['loading', 'delta', 'done', 'error'] as const)
  const only = (keys: readonly string[]) => c.record(obj, '$', ['type', ...keys])
  switch (type) {
    case 'loading':
      only([])
      return c.result<InferenceEvent>(c.ok ? { type } : undefined)
    case 'delta': {
      only(['text'])
      const text = c.string(obj['text'], '$.text', { max: INFERENCE_LIMITS.deltaText })
      return c.result<InferenceEvent>(text !== undefined && c.ok ? { type, text } : undefined)
    }
    case 'done': {
      only(['finishReason', 'metrics'])
      const finishReason = c.oneOf(obj['finishReason'], '$.finishReason', ['stop', 'length', 'cancelled'] as const)
      const metrics = c.nullable(obj['metrics'], '$.metrics', (v, p) => readMetrics(c, v, p))
      return c.result<InferenceEvent>(finishReason && metrics !== undefined && c.ok ? { type, finishReason, metrics } : undefined)
    }
    case 'error': {
      only(['error'])
      // `retryable` vem da natureza do código, não do provedor: pode vir junto
      // (eventos montados com `inferenceError`), mas só se coincidir.
      const err = c.record(obj['error'], '$.error', ['code', 'message', 'retryable'])
      const code = err && c.oneOf(err['code'], '$.error.code', INFERENCE_ERROR_CODES)
      const message = err && c.string(err['message'], '$.error.message', { max: INFERENCE_LIMITS.errorMessage })
      if (err && code && 'retryable' in err && err['retryable'] !== inferenceError(code, '').retryable) {
        c.fail('$.error.retryable', 'definido pela natureza do código')
      }
      return c.result<InferenceEvent>(code && message !== undefined && c.ok ? { type, error: inferenceError(code, message) } : undefined)
    }
    default:
      return c.result<InferenceEvent>(undefined)
  }
}

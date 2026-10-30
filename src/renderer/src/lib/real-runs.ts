import type { ConversationSendRequest } from '@shared/conversations'
import type { StructuredError } from '@shared/errors'
import { isRealProvider, type InferenceErrorCode, type InferenceMetrics, type ProviderOverview, type ResolvedModelRef } from '@shared/inference'
import { isTerminalRunState, RUN_INPUT_MAX, type RunOrigin, type RunRecord } from '@shared/runs'
import type { Tone } from '@renderer/components/ui/tone'
import { formatNumber } from './format'

/**
 * Lógica da execução real (enviada em Conversas, acompanhada em Execuções),
 * sem React (testável).
 * Tudo vem do Main: inventário (`providers:list`) e execuções (`RunService`).
 * Validações daqui são preventivas; o Main continua a autoridade final.
 */

// ---------------------------------------------------------------------------
// Modelos elegíveis
// ---------------------------------------------------------------------------

export interface ModelOption {
  /** Chave estável para o seletor: provedor + id exato. */
  key: string
  ref: ResolvedModelRef
  providerName: string
  /** Nome amigável para o seletor; o identificador exato fica em `ref.modelId`. */
  label: string
  /** O provedor informa que o modelo raciocina antes de responder. */
  reasoning: boolean
}

export const modelKey = (ref: ResolvedModelRef) => `${ref.providerId}\u0000${ref.modelId}`

/**
 * Modelos que a interface pode oferecer para execução real: de provedores
 * reais prontos, instalados e locais. Modelos que o provedor descreve sem
 * conversa (ex.: só embedding) ficam de fora; capacidades desconhecidas
 * (lista vazia) não excluem. O simulado nunca entra.
 */
export function eligibleModels(providers: readonly ProviderOverview[]): ModelOption[] {
  return providers
    .filter((p) => isRealProvider(p.info) && p.status.state === 'ready')
    .flatMap((p) =>
      (p.models ?? [])
        .filter(({ model, availability }) => {
          if (availability !== 'installed' || model.location !== 'local' || model.ref.providerId !== p.info.id) return false
          return model.capabilities.length === 0 || model.capabilities.includes('chat')
        })
        .map(({ model }) => ({
          key: modelKey(model.ref),
          ref: model.ref,
          providerName: p.info.displayName,
          label: friendlyModelName(model.ref.modelId, model.displayName),
          reasoning: model.capabilities.includes('reasoning')
        }))
    )
}

const MODEL_SIZE = /^(\d+(?:\.\d+)?)([bmk])(?:[-_](.+))?$/i

/**
 * Nome legível de um modelo a partir do identificador do provedor:
 * `llama3.1:8b` → "Llama 3.1 (8B)", `qwen3:8b` → "Qwen 3 (8B)". Só formata;
 * nada é inferido além do que está no identificador. Um nome de exibição
 * diferente do identificador, quando o provedor informa, tem preferência.
 */
export function friendlyModelName(modelId: string, displayName: string | null = null): string {
  if (displayName?.trim() && displayName !== modelId) return displayName.trim()
  const colon = modelId.lastIndexOf(':')
  const base = (colon === -1 ? modelId : modelId.slice(0, colon)).split('/').pop() || modelId
  const tag = colon === -1 ? '' : modelId.slice(colon + 1)
  const words = base
    .replace(/[-_]+/g, ' ')
    .replace(/^([a-z]+)(\d)/i, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  if (!tag || tag === 'latest') return words || modelId
  const size = MODEL_SIZE.exec(tag)
  const detail = size ? `${size[1]}${size[2]!.toUpperCase()}${size[3] ? ` · ${size[3]}` : ''}` : tag
  return `${words || base} (${detail})`
}

/**
 * Modelo a pré-selecionar: mantém a escolha atual se ainda existir; senão o
 * modelo pedido pela navegação (ex.: "Usar em Conversas" na tela Modelos); senão
 * o modelo padrão do agente, se instalado; senão o único disponível. Com
 * vários e nenhuma pista, o usuário escolhe.
 */
export function defaultModelKey(
  options: readonly ModelOption[],
  current: string,
  agentModel: { providerId: string | null; modelId: string } | null,
  requested: ResolvedModelRef | null = null
): string {
  if (options.some((o) => o.key === current)) return current
  if (requested && options.some((o) => o.key === modelKey(requested))) return modelKey(requested)
  if (agentModel) {
    const match = options.filter((o) => o.ref.modelId === agentModel.modelId && (agentModel.providerId === null || o.ref.providerId === agentModel.providerId))
    if (match.length === 1) return match[0]!.key
  }
  return options.length === 1 ? options[0]!.key : ''
}

/** Por que não há o que executar, em linguagem simples. `null` = há modelos. */
export function inventoryProblem(providers: readonly ProviderOverview[]): { tone: Tone; text: string } | null {
  const real = providers.filter((p) => isRealProvider(p.info))
  if (eligibleModels(providers).length > 0) return null
  if (real.length === 0) return { tone: 'warning', text: 'Nenhum motor de IA local está registrado neste aplicativo.' }
  const ready = real.filter((p) => p.status.state === 'ready')
  if (ready.length === 0) {
    return {
      tone: 'warning',
      text: `O motor de IA local (${real.map((p) => p.info.displayName).join(', ')}) não está respondendo. Verifique se ele está aberto e clique em "Atualizar lista".`
    }
  }
  return {
    tone: 'info',
    text: `${ready.map((p) => p.info.displayName).join(', ')} está respondendo, mas não há modelos de conversa instalados nele. Instale um modelo pelo próprio motor e clique em "Atualizar lista".`
  }
}

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------

export interface RunDraft {
  agentId: string
  modelKey: string
  input: string
}

export type RunDraftErrors = Partial<Record<keyof RunDraft, string>>

export function runDraftErrors(draft: RunDraft, options: readonly ModelOption[]): RunDraftErrors {
  const errors: RunDraftErrors = {}
  if (!draft.agentId) errors.agentId = 'Escolha um agente.'
  if (!draft.modelKey) errors.modelKey = 'Escolha um modelo.'
  else if (!options.some((o) => o.key === draft.modelKey)) errors.modelKey = 'Este modelo não está mais disponível. Atualize a lista.'
  if (!draft.input.trim()) errors.input = 'Digite uma mensagem.'
  else if (draft.input.length > RUN_INPUT_MAX) errors.input = `A mensagem passou do limite de ${formatNumber(RUN_INPUT_MAX)} caracteres.`
  return errors
}

/** Pedido para `conversations:send`: modelo exato escolhido; o perfil é o do agente. */
export function sendRequestFrom(draft: RunDraft, options: readonly ModelOption[], conversationId: string | null): ConversationSendRequest | null {
  const option = options.find((o) => o.key === draft.modelKey)
  if (!option) return null
  return { conversationId, agentId: draft.agentId, model: { ...option.ref }, input: draft.input }
}

// ---------------------------------------------------------------------------
// Estado exibido
// ---------------------------------------------------------------------------

export interface RunStatusView {
  label: string
  tone: Tone
  pulse?: boolean
}

const inferenceCodeOf = (error: StructuredError | null) => {
  const code = error?.details?.['inferenceCode']
  return typeof code === 'string' ? (code as InferenceErrorCode) : null
}

/** Limite de saída esgotado antes de qualquer texto (marcado pelo Main). */
export const isEmptyOutputLimit = (error: StructuredError | null) => error?.details?.['reason'] === 'output-limit-before-text'

/** Posição na fila (1 = próxima) entre as pendentes desta sessão. */
export function queuePosition(run: RunRecord, all: readonly RunRecord[]): number | null {
  if (run.state !== 'pending') return null
  const pending = all.filter((r) => r.state === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return pending.findIndex((r) => r.id === run.id) + 1 || null
}

/** Rótulo textual do estado (nunca só cor). */
export function runStatusView(run: RunRecord, all: readonly RunRecord[] = []): RunStatusView {
  const terminal = isTerminalRunState(run.state)
  if (run.cancelRequested && !terminal) return { label: 'Interrompendo…', tone: 'neutral', pulse: true }
  switch (run.state) {
    case 'pending': {
      const position = queuePosition(run, all)
      return { label: position ? `Aguardando na fila (${position}ª)` : 'Aguardando na fila', tone: 'info' }
    }
    case 'running':
      return { label: run.progress.step === 'Carregando modelo' ? 'Carregando modelo' : 'Gerando resposta', tone: 'accent', pulse: true }
    case 'completed':
      return completedWithWarning(run) ? { label: 'Concluída com aviso', tone: 'warning' } : { label: 'Concluída', tone: 'success' }
    case 'cancelled':
      return { label: 'Interrompida', tone: 'neutral' }
    case 'failed': {
      if (inferenceCodeOf(run.error) === 'timeout') return { label: 'Tempo esgotado', tone: 'danger' }
      if (isEmptyOutputLimit(run.error)) return { label: 'Sem resposta (limite)', tone: 'danger' }
      return { label: 'Falhou', tone: 'danger' }
    }
  }
}

/** Concluída, mas o último aviso diz que algo foi cortado (limite de saída). */
export function completedWithWarning(run: RunRecord): string | null {
  if (run.state !== 'completed') return null
  const last = run.messages.at(-1)
  return last?.level === 'warning' ? last.text : null
}

// ---------------------------------------------------------------------------
// Erros em linguagem simples
// ---------------------------------------------------------------------------

const FRIENDLY: Record<InferenceErrorCode, string> = {
  'provider-unavailable': 'O motor de IA local não está respondendo. Verifique se ele está aberto e tente de novo.',
  'model-not-found': 'O modelo escolhido não está instalado (pode ter sido removido). Atualize a lista de modelos.',
  'model-unsupported': 'O motor local não consegue rodar este modelo para conversa.',
  'insufficient-memory': 'Memória insuficiente para rodar este modelo agora. Feche outros programas ou escolha um modelo menor.',
  'context-too-long': 'A mensagem e as instruções do agente são longas demais para este modelo.',
  timeout: 'A geração passou do tempo limite do agente e foi interrompida.',
  cancelled: 'A geração foi interrompida.',
  'invalid-request': 'O motor local recusou o pedido.',
  'provider-error': 'O motor local falhou ou enviou uma resposta inválida.'
}

/**
 * Explicação para quem não conhece os detalhes técnicos. `detail` é a
 * mensagem original do Main, mostrada junto para não esconder o motivo real.
 * Falhas de execuções simuladas nunca são atribuídas ao motor local.
 */
export function friendlyError(error: StructuredError, origin: RunOrigin = 'real'): { title: string; detail: string | null } {
  if (origin === 'simulated' && inferenceCodeOf(error)) {
    return { title: 'Falha simulada: nenhum modelo foi executado e o motor local não foi usado.', detail: error.message }
  }
  if (isEmptyOutputLimit(error)) {
    return {
      title: 'O limite de geração acabou antes de qualquer texto de resposta. Modelos que raciocinam antes de responder podem gastar todo o limite; aumente "Máx. de tokens na resposta" no agente.',
      detail: error.message
    }
  }
  const code = inferenceCodeOf(error)
  if (code) return { title: FRIENDLY[code], detail: error.message }
  switch (error.code) {
    case 'validation':
      return { title: 'Os dados do pedido são inválidos.', detail: error.message }
    case 'conflict':
      return { title: error.message, detail: null }
    case 'not-found':
      return { title: 'O agente escolhido não existe mais. Atualize a página.', detail: error.message }
    case 'invalid-state':
      return { title: error.message, detail: null }
    default:
      return { title: error.message, detail: null }
  }
}

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

const seconds = (ms: number) => `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`

/**
 * Só as métricas medidas que existem; nada é estimado. Os tokens gerados
 * incluem o raciocínio de modelos que pensam antes de responder.
 */
export function metricRows(metrics: InferenceMetrics | null, reasoning = false): Array<[string, string]> {
  if (!metrics) return []
  const rows: Array<[string, string | null]> = [
    ['Tempo total', metrics.totalMs === null ? null : seconds(metrics.totalMs)],
    ['Carregamento do modelo', metrics.loadMs === null ? null : seconds(metrics.loadMs)],
    ['Até o primeiro texto', metrics.timeToFirstTokenMs === null ? null : seconds(metrics.timeToFirstTokenMs)],
    ['Tokens de entrada', metrics.promptTokens === null ? null : formatNumber(metrics.promptTokens)],
    [reasoning ? 'Tokens gerados (inclui raciocínio)' : 'Tokens gerados', metrics.outputTokens === null ? null : formatNumber(metrics.outputTokens)],
    [
      'Velocidade de geração',
      metrics.outputTokensPerSecond === null ? null : `${metrics.outputTokensPerSecond.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} tokens/s`
    ]
  ]
  return rows.filter((r): r is [string, string] => r[1] !== null)
}

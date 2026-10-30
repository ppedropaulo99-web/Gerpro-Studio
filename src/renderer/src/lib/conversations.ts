import {
  SAVED,
  summarizeConversation,
  type Conversation,
  type ConversationList,
  type ConversationMessage,
  type ConversationSaveStatus,
  type MessageContext
} from '@shared/conversations'
import type { Tone } from '@renderer/components/ui/tone'
import type { Result, StructuredError } from '@shared/errors'
import { sameModel } from '@shared/inference'
import { friendlyModelName } from './real-runs'

/** Insere ou atualiza o resumo de uma conversa, mantendo a mais recente no topo (e a situação de gravação já conhecida). */
export function upsertSummary(list: ConversationList, conversation: Conversation): ConversationList {
  const known = list.conversations.find((c) => c.id === conversation.id)?.save ?? SAVED
  const summary = summarizeConversation(conversation, known)
  const others = list.conversations.filter((c) => c.id !== summary.id)
  return { ...list, conversations: [summary, ...others].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
}

export function removeSummary(list: ConversationList, id: string): ConversationList {
  return { ...list, conversations: list.conversations.filter((c) => c.id !== id) }
}

/** Fica com a versão mais recente (eventos e respostas de IPC podem chegar fora de ordem). */
export function newerConversation(current: Conversation | null, incoming: Conversation): Conversation {
  if (!current || current.id !== incoming.id) return incoming
  return incoming.updatedAt >= current.updatedAt ? incoming : current
}

export interface ThreadItem {
  message: ConversationMessage
  /** Nome do novo modelo, quando esta troca usou outro modelo que a anterior. */
  modelSwitch: string | null
  /** As mensagens acima desta não foram enviadas na última resposta (limite de contexto). */
  contextStartsHere: boolean
}

/** Mensagens em ordem, com as marcas de troca de modelo e do início do contexto enviado. */
export function threadItems(conversation: Conversation): ThreadItem[] {
  const { messages } = conversation
  const lastContext = [...messages].reverse().find((m) => m.role === 'assistant' && m.context)?.context ?? null
  const boundary = lastContext && lastContext.omitted > 0 ? lastContext.firstSentId : null
  let previousModel: ConversationMessage['model'] = null
  return messages.map((message, i) => {
    let modelSwitch: string | null = null
    const reply = message.role === 'user' ? messages[i + 1] : undefined
    if (reply?.role === 'assistant' && reply.model) {
      if (previousModel && !sameModel(previousModel, reply.model)) modelSwitch = friendlyModelName(reply.model.modelId)
      previousModel = reply.model
    }
    return { message, modelSwitch, contextStartsHere: boundary !== null && message.id === boundary }
  })
}

/** Texto discreto sob a resposta: quanto do histórico o modelo recebeu. */
export function contextLabel(context: MessageContext | null): string | null {
  if (!context || (context.sent === 0 && context.omitted === 0)) return null
  const sent = context.sent === 0 ? 'sem mensagens anteriores' : `${context.sent} mensagem(ns) anterior(es)`
  return `Contexto: ${sent}${context.omitted > 0 ? ` · ${context.omitted} mais antiga(s) fora do limite` : ''}`
}

/** Situação de gravação mostrada: a do último aviso do Main, senão a da lista. */
export function saveStateOf(
  id: string,
  changes: Readonly<Record<string, ConversationSaveStatus>>,
  summaries: readonly { id: string; save: ConversationSaveStatus }[]
): ConversationSaveStatus {
  return changes[id] ?? summaries.find((s) => s.id === id)?.save ?? SAVED
}

/** Indicador discreto no cabeçalho da conversa. */
export function saveIndicator(save: ConversationSaveStatus): { label: string; tone: Tone; pulse: boolean } {
  if (save.state === 'failed') return save.retrying ? { label: 'Tentando salvar…', tone: 'warning', pulse: true } : { label: 'Falha ao salvar', tone: 'danger', pulse: false }
  if (save.state === 'saving') return { label: 'Salvando…', tone: 'neutral', pulse: true }
  return { label: 'Salvo', tone: 'success', pulse: false }
}

/** Aviso sob uma resposta interrompida pelo fechamento do app. */
export function interruptedNotice(message: ConversationMessage): string {
  return message.content
    ? 'O aplicativo foi fechado antes do fim da resposta. O texto recebido até então foi mantido; envie a mensagem de novo se precisar da resposta completa.'
    : 'O aplicativo foi fechado antes do fim da resposta. Envie a mensagem de novo se precisar.'
}

/** Erro guardado na mensagem, no formato que `ErrorExplanation` entende. */
export function messageError(message: ConversationMessage): StructuredError | null {
  if (!message.error) return null
  const { code, message: text, inferenceCode } = message.error
  return { code, message: text, retryable: false, ...(inferenceCode ? { details: { inferenceCode } } : {}) }
}

type ConversationsApi = {
  list(): Promise<Result<ConversationList>>
  onUpdated(listener: (conversation: Conversation) => void): () => void
}

export type ConversationListState = { status: 'loading' } | { status: 'error'; error: StructuredError } | { status: 'ready'; data: ConversationList }

/**
 * Acompanha a lista de conversas: assina `conversations:updated` antes de
 * pedir a lista, para não perder respostas que terminam enquanto ela carrega.
 */
export function watchConversations(api: ConversationsApi, onChange: (state: ConversationListState) => void): () => void {
  let stopped = false
  let early: Conversation[] = []
  let list: ConversationList | null = null

  const unsubscribe = api.onUpdated((conversation) => {
    if (stopped) return
    if (list === null) {
      early.push(conversation)
      return
    }
    list = upsertSummary(list, conversation)
    onChange({ status: 'ready', data: list })
  })

  void api.list().then(
    (result) => {
      if (stopped) return
      if (!result.ok) return onChange({ status: 'error', error: result.error })
      list = early.reduce(upsertSummary, result.data)
      early = []
      onChange({ status: 'ready', data: list })
    },
    () => {
      if (!stopped) onChange({ status: 'error', error: { code: 'internal', message: 'Não foi possível comunicar com o processo principal.', retryable: true } })
    }
  )

  return () => {
    stopped = true
    unsubscribe()
  }
}

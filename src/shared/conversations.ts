/**
 * Contratos de conversas.
 *
 * Três conceitos separados:
 * - `Conversation`: sessão contínua, gravada no disco pelo Main;
 * - `ConversationMessage`: mensagem do usuário ou do assistente, em ordem;
 * - `RunRecord` (`runs.ts`): cada geração, feita pelo `RunService`. Uma
 *   conversa pode ter várias execuções; a resposta guarda o `runId`.
 *
 * O texto em geração vem sempre do `RunService`; a conversa só grava a
 * resposta quando a execução termina. O contexto enviado ao modelo é um
 * recorte das mensagens anteriores (`selectContext`), registrado em cada
 * resposta, e nunca apaga nada do histórico gravado.
 */

import type { ErrorCode } from './errors'
import { readModelRef, type ChatMessage, type ResolvedModelRef } from './inference'
import { RUN_ID_PATTERN, RUN_INPUT_MAX, RUN_LIMITS } from './runs'
import { Checker, readSlug, type ValidationResult } from './validation'

export const CONVERSATION_ID_PATTERN = /^conv-[a-z0-9-]{1,64}$/
export const MESSAGE_ID_PATTERN = /^msg-[a-z0-9-]{1,64}$/

export const DEFAULT_CONVERSATION_TITLE = 'Nova conversa'

export const CONVERSATION_LIMITS = {
  maxConversations: 500,
  maxMessages: 400,
  titleChars: 120,
  userChars: RUN_INPUT_MAX,
  assistantChars: RUN_LIMITS.outputChars,
  errorChars: 2_000
} as const

/**
 * - `pending`: resposta em geração (o texto ao vivo está na execução);
 * - `complete`: concluída (inclui saída cortada no limite);
 * - `cancelled`: interrompida, com o texto recebido até então;
 * - `failed`: a geração falhou;
 * - `interrupted`: o aplicativo fechou antes do fim.
 * Mensagens do usuário são sempre `complete`.
 */
export const MESSAGE_STATES = ['pending', 'complete', 'cancelled', 'failed', 'interrupted'] as const
export type MessageState = (typeof MESSAGE_STATES)[number]

export interface MessageError {
  code: ErrorCode
  message: string
  /** Código de inferência, quando houver (`details.inferenceCode` da execução). */
  inferenceCode: string | null
}

/** Quanto do histórico foi enviado ao modelo para gerar uma resposta. */
export interface MessageContext {
  /** Mensagens anteriores enviadas junto. */
  sent: number
  /** Mensagens anteriores elegíveis que ficaram de fora pelo limite. */
  omitted: number
  /** Mais antiga das mensagens enviadas (`null` se nenhuma). */
  firstSentId: string | null
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  state: MessageState
  /** Execução que gerou a resposta (só do assistente). */
  runId: string | null
  /** Modelo que gerou a resposta (só do assistente). */
  model: ResolvedModelRef | null
  error: MessageError | null
  context: MessageContext | null
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** Último modelo escolhido. */
  model: ResolvedModelRef | null
  /** Agente cujas instruções e perfil acompanham cada envio; fixo depois da primeira mensagem. */
  agentId: string | null
  messages: ConversationMessage[]
}

/**
 * Situação da gravação de uma conversa no disco (não é gravada; vem do Main):
 * - `saved`: o arquivo tem o estado atual;
 * - `saving`: há alterações sendo gravadas;
 * - `failed`: a última gravação falhou. As mensagens continuam na memória;
 *   `retrying` indica uma nova tentativa em andamento, sem sair de `failed`
 *   até dar certo (a interface não pisca entre falha e "salvando").
 */
export interface ConversationSaveStatus {
  state: 'saved' | 'saving' | 'failed'
  retrying: boolean
  /** Explicação curta, sem caminhos nem detalhes internos; só em `failed`. */
  message: string | null
}

export const SAVED: ConversationSaveStatus = { state: 'saved', retrying: false, message: null }

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  model: ResolvedModelRef | null
  agentId: string | null
  messageCount: number
  generating: boolean
  save: ConversationSaveStatus
}

/** Evento `conversations:save-changed`: só nas mudanças de situação. */
export interface ConversationSaveChange {
  conversationId: string
  save: ConversationSaveStatus
}

export interface ConversationList {
  conversations: ConversationSummary[]
  /** Arquivos que não puderam ser lidos nesta sessão (o original fica copiado). */
  damaged: number
}

/** Envio de uma mensagem. `conversationId: null` cria a conversa com ela. */
export interface ConversationSendRequest {
  conversationId: string | null
  agentId: string
  model: ResolvedModelRef
  input: string
}

export function summarizeConversation(c: Conversation, save: ConversationSaveStatus = SAVED): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    model: c.model,
    agentId: c.agentId,
    messageCount: c.messages.length,
    generating: c.messages.some((m) => m.state === 'pending'),
    save
  }
}

/** Título automático: primeira linha da primeira mensagem, até 60 caracteres. */
export function titleFromMessage(input: string): string {
  const line = input.trim().split(/\r?\n/, 1)[0]!.replace(/\s+/g, ' ').trim()
  if (!line) return DEFAULT_CONVERSATION_TITLE
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line
}

// ---------------------------------------------------------------------------
// Contexto enviado ao modelo
// ---------------------------------------------------------------------------

/**
 * Estratégia inicial, conservadora e sem medição de tokens:
 * - janela de `contextLength` tokens do perfil; sem ela, supõe 4.096 (padrão
 *   comum dos motores locais) para não estourar a janela real;
 * - reserva tokens para a resposta (`maxOutputTokens` ou 512);
 * - converte com 3 caracteres por token, abaixo da média de textos comuns,
 *   para sobrar margem;
 * - no máximo 40 mensagens anteriores e nunca acima do limite de caracteres
 *   do `RunService`.
 */
export const CONTEXT_LIMITS = {
  assumedContextTokens: 4_096,
  outputReserveTokens: 512,
  charsPerToken: 3,
  maxHistoryMessages: 40
} as const

export function historyBudgetChars(o: {
  contextLength: number | null
  maxOutputTokens: number | null
  /** Instruções do agente + nova mensagem. */
  fixedChars: number
  /** Limite total do `RunService` (`RUN_LIMITS.promptChars`). */
  promptChars: number
}): number {
  const window = o.contextLength ?? CONTEXT_LIMITS.assumedContextTokens
  const reserve = Math.min(o.maxOutputTokens ?? CONTEXT_LIMITS.outputReserveTokens, Math.floor(window / 2))
  const byWindow = (window - reserve) * CONTEXT_LIMITS.charsPerToken - o.fixedChars
  return Math.max(0, Math.min(byWindow, o.promptChars - o.fixedChars))
}

export interface ContextSelection {
  history: ChatMessage[]
  /** IDs das mensagens enviadas, em ordem. */
  sentIds: string[]
  /** Mensagens elegíveis que ficaram de fora pelo limite (as mais antigas). */
  omitted: number
}

/**
 * Uma troca (pergunta + resposta) entra no contexto se a resposta tem texto e
 * não falhou. Respostas interrompidas (pelo usuário ou pelo fechamento do
 * app) entram com o texto que o usuário viu.
 */
export function isContextExchange(user: ConversationMessage, reply: ConversationMessage | undefined): boolean {
  return (
    user.role === 'user' &&
    reply !== undefined &&
    reply.role === 'assistant' &&
    (reply.state === 'complete' || reply.state === 'cancelled' || reply.state === 'interrupted') &&
    reply.content.trim().length > 0
  )
}

/**
 * Escolhe as trocas mais recentes que cabem em `budgetChars`, sem cortar
 * mensagens e sem pular trocas (a janela é contínua até a mais nova).
 */
export function selectContext(messages: readonly ConversationMessage[], budgetChars: number): ContextSelection {
  const exchanges: Array<[ConversationMessage, ConversationMessage]> = []
  for (let i = 0; i < messages.length - 1; i++) {
    const user = messages[i]!
    const reply = messages[i + 1]
    if (isContextExchange(user, reply)) exchanges.push([user, reply!])
  }
  const chosen: Array<[ConversationMessage, ConversationMessage]> = []
  let used = 0
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const [user, reply] = exchanges[i]!
    const size = user.content.length + reply.content.length
    if (used + size > budgetChars || (chosen.length + 1) * 2 > CONTEXT_LIMITS.maxHistoryMessages) break
    used += size
    chosen.unshift(exchanges[i]!)
  }
  const flat = chosen.flat()
  return {
    history: flat.map((m) => ({ role: m.role, content: m.content })),
    sentIds: flat.map((m) => m.id),
    omitted: (exchanges.length - chosen.length) * 2
  }
}

// ---------------------------------------------------------------------------
// Validação (IPC e disco)
// ---------------------------------------------------------------------------

const ERROR_CODES: readonly ErrorCode[] = [
  'validation',
  'not-found',
  'conflict',
  'invalid-state',
  'storage',
  'storage-read-only',
  'secret-storage-unavailable',
  'simulated-failure',
  'inference',
  'internal'
]

function readResolvedRef(c: Checker, value: unknown, path: string): ResolvedModelRef | undefined {
  const ref = readModelRef(c, value, path)
  if (ref && ref.providerId === null) return c.fail(`${path}.providerId`, 'obrigatório')
  return ref as ResolvedModelRef | undefined
}

export function readConversationId(c: Checker, value: unknown, path: string): string | undefined {
  return c.string(value, path, { pattern: CONVERSATION_ID_PATTERN, patternMessage: 'ID de conversa inválido' })
}

export function readConversationTitle(c: Checker, value: unknown, path: string): string | undefined {
  const title = c.string(value, path, { min: 1, max: CONVERSATION_LIMITS.titleChars })
  if (title === undefined) return undefined
  if (title.trim() !== title || /[\x00-\x1f\x7f]/.test(title)) return c.fail(path, 'sem espaços nas pontas nem quebras de linha')
  return title
}

function readMessage(c: Checker, value: unknown, path: string): ConversationMessage | undefined {
  const keys = ['id', 'role', 'content', 'createdAt', 'state', 'runId', 'model', 'error', 'context'] as const
  const obj = c.record(value, path, keys)
  if (!obj) return undefined
  const role = c.oneOf(obj['role'], `${path}.role`, ['user', 'assistant'] as const)
  const message = {
    id: c.string(obj['id'], `${path}.id`, { pattern: MESSAGE_ID_PATTERN }),
    role,
    content: c.string(obj['content'], `${path}.content`, {
      max: role === 'user' ? CONVERSATION_LIMITS.userChars : CONVERSATION_LIMITS.assistantChars
    }),
    createdAt: c.isoDate(obj['createdAt'], `${path}.createdAt`),
    state: c.oneOf(obj['state'], `${path}.state`, MESSAGE_STATES),
    runId: c.nullable(obj['runId'], `${path}.runId`, (v, p) => c.string(v, p, { pattern: RUN_ID_PATTERN })),
    model: c.nullable(obj['model'], `${path}.model`, (v, p) => readResolvedRef(c, v, p)),
    error: c.nullable(obj['error'], `${path}.error`, (v, p) => {
      const err = c.record(v, p, ['code', 'message', 'inferenceCode'])
      if (!err) return undefined
      const code = c.oneOf(err['code'], `${p}.code`, ERROR_CODES)
      const text = c.string(err['message'], `${p}.message`, { max: CONVERSATION_LIMITS.errorChars })
      const inferenceCode = c.nullable(err['inferenceCode'], `${p}.inferenceCode`, (x, q) => c.string(x, q, { max: 64 }))
      return code && text !== undefined && inferenceCode !== undefined ? { code, message: text, inferenceCode } : undefined
    }),
    context: c.nullable(obj['context'], `${path}.context`, (v, p) => {
      const ctx = c.record(v, p, ['sent', 'omitted', 'firstSentId'])
      if (!ctx) return undefined
      const sent = c.number(ctx['sent'], `${p}.sent`, { min: 0, max: CONVERSATION_LIMITS.maxMessages, integer: true })
      const omitted = c.number(ctx['omitted'], `${p}.omitted`, { min: 0, max: CONVERSATION_LIMITS.maxMessages, integer: true })
      const firstSentId = c.nullable(ctx['firstSentId'], `${p}.firstSentId`, (x, q) => c.string(x, q, { pattern: MESSAGE_ID_PATTERN }))
      return sent !== undefined && omitted !== undefined && firstSentId !== undefined ? { sent, omitted, firstSentId } : undefined
    })
  }
  if (!c.ok) return undefined
  if (role === 'user' && (message.state !== 'complete' || message.runId !== null || message.model !== null || message.error || message.context)) {
    return c.fail(path, 'mensagem do usuário só guarda texto e data')
  }
  return message as ConversationMessage
}

/** Validação estrita: um arquivo com qualquer problema não é usado pela metade. */
export function validateConversation(input: unknown): ValidationResult<Conversation> {
  const c = new Checker()
  const obj = c.record(input, '$', ['id', 'title', 'createdAt', 'updatedAt', 'model', 'agentId', 'messages'])
  if (!obj) return c.result<Conversation>(undefined)
  const conversation = {
    id: readConversationId(c, obj['id'], '$.id'),
    title: readConversationTitle(c, obj['title'], '$.title'),
    createdAt: c.isoDate(obj['createdAt'], '$.createdAt'),
    updatedAt: c.isoDate(obj['updatedAt'], '$.updatedAt'),
    model: c.nullable(obj['model'], '$.model', (v, p) => readResolvedRef(c, v, p)),
    agentId: c.nullable(obj['agentId'], '$.agentId', (v, p) => readSlug(c, v, p)),
    messages: c.array(obj['messages'], '$.messages', (v, p) => readMessage(c, v, p), { max: CONVERSATION_LIMITS.maxMessages })
  }
  if (!c.ok) return c.result<Conversation>(undefined)
  const messages = conversation.messages!
  if (new Set(messages.map((m) => m.id)).size !== messages.length) c.fail('$.messages', 'IDs de mensagem repetidos')
  for (let i = 1; i < messages.length; i++) {
    if (Date.parse(messages[i]!.createdAt) < Date.parse(messages[i - 1]!.createdAt)) {
      c.fail(`$.messages[${i}].createdAt`, 'fora da ordem cronológica')
      break
    }
  }
  return c.result(c.ok ? (conversation as Conversation) : undefined)
}

export function validateConversationSendRequest(input: unknown): ValidationResult<ConversationSendRequest> {
  const c = new Checker()
  const obj = c.record(input, '$', ['conversationId', 'agentId', 'model', 'input'])
  if (!obj) return c.result<ConversationSendRequest>(undefined)
  const conversationId = c.nullable(obj['conversationId'], '$.conversationId', (v, p) => readConversationId(c, v, p))
  const agentId = readSlug(c, obj['agentId'], '$.agentId')
  const model = readResolvedRef(c, obj['model'], '$.model')
  const text = c.string(obj['input'], '$.input', { min: 1, max: RUN_INPUT_MAX })
  if (text !== undefined && !text.trim()) c.fail('$.input', 'não pode ficar em branco')
  return c.result(
    conversationId !== undefined && agentId && model && text !== undefined && c.ok ? { conversationId, agentId, model, input: text } : undefined
  )
}

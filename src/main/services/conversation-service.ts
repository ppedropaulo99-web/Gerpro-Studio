import { randomBytes } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentDefinition } from '@shared/agents'
import {
  CONVERSATION_LIMITS,
  DEFAULT_CONVERSATION_TITLE,
  historyBudgetChars,
  readConversationId,
  readConversationTitle,
  SAVED,
  selectContext,
  summarizeConversation,
  titleFromMessage,
  validateConversation,
  validateConversationSendRequest,
  type Conversation,
  type ConversationList,
  type ConversationMessage,
  type ConversationSaveChange,
  type ConversationSaveStatus,
  type MessageState
} from '@shared/conversations'
import { isTerminalRunState, RUN_LIMITS, type RunRecord } from '@shared/runs'
import { Checker } from '@shared/validation'
import { AppError, unwrap } from '../errors'
import type { RunService } from '../runs/run-service'
import { defaultScheduler, type Scheduler } from '../runs/scheduler'
import { VersionedStore } from '../storage/versioned-store'

/**
 * Conversas do Main: sessões contínuas, gravadas uma por arquivo em
 * `<dados>/conversations/<id>.json` (`VersionedStore`: escrita atômica,
 * validação ao carregar, cópia do arquivo inválido, bloqueio de versões
 * futuras). Um arquivo danificado não afeta as outras conversas.
 *
 * Cada envio é uma execução do `RunService` com as instruções do agente, o
 * recorte permitido do histórico (`selectContext`) e a nova mensagem. O texto
 * em geração fica na execução (é o que a tela mostra); a conversa grava um
 * ponto de controle do texto parcial no máximo a cada `checkpointMs` e a
 * resposta final quando ela termina. Nada daqui sai do computador nem vai
 * para os registros técnicos.
 *
 * Gravação: cada conversa tem uma situação (`saved`, `saving`, `failed`). Uma
 * falha nunca descarta o que está na memória; a conversa continua marcada como
 * não salva até uma gravação dar certo (nova alteração ou `retrySave`).
 */

export const CONVERSATIONS_FORMAT_VERSION = 1

/** Intervalo mínimo entre gravações do texto parcial de uma resposta em geração. */
export const CHECKPOINT_INTERVAL_MS = 2_000

const SAVE_FAILED = 'Não foi possível gravar a conversa no disco. As mensagens continuam abertas nesta janela.'
const SAVE_READ_ONLY = 'O arquivo desta conversa não pode ser alterado por esta versão do aplicativo. As mensagens continuam abertas nesta janela.'
const FILE_PATTERN = /^(conv-[a-z0-9-]{1,64})\.json$/

export type ConversationRuns = Pick<RunService, 'start' | 'cancel' | 'get' | 'onUpdate'>

export interface ConversationServiceDeps {
  dir: string
  runs: ConversationRuns
  findAgent: (id: string) => AgentDefinition | undefined
  now?: () => Date
  newId?: (prefix: 'conv' | 'msg') => string
  log?: (message: string) => void
  scheduler?: Scheduler
  checkpointMs?: number
  /** Escrita dos arquivos (padrão: a escrita atômica do `VersionedStore`). Só para testes. */
  writer?: (filePath: string, contents: string) => Promise<void>
}

export interface ConversationSendResult {
  conversation: Conversation
  /** Execução criada, para a interface acompanhar o texto em geração. */
  run: RunRecord
}

export type ConversationListener = (conversation: Conversation) => void
export type SaveListener = (change: ConversationSaveChange) => void

interface Slot {
  store: VersionedStore<Conversation | null>
  /** Gravações desta conversa, em sequência. */
  writes: Promise<void>
  /** A memória tem alterações que o arquivo ainda não tem. */
  dirty: boolean
  save: ConversationSaveStatus
}

const STATE_OF_RUN: Record<'completed' | 'cancelled' | 'failed', MessageState> = {
  completed: 'complete',
  cancelled: 'cancelled',
  failed: 'failed'
}

export class ConversationService {
  private readonly deps: Required<Omit<ConversationServiceDeps, 'writer'>> & Pick<ConversationServiceDeps, 'writer'>
  private readonly conversations = new Map<string, Conversation>()
  private readonly slots = new Map<string, Slot>()
  /** Execução → resposta que ela vai preencher (só nesta sessão). */
  private readonly byRun = new Map<string, { conversationId: string; messageId: string }>()
  /** Conversas com um envio entre a validação e a criação da execução. */
  private readonly sending = new Set<string>()
  private readonly listeners = new Set<ConversationListener>()
  private readonly saveListeners = new Set<SaveListener>()
  /** Execução → ponto de controle agendado do texto parcial. */
  private readonly checkpoints = new Map<string, unknown>()
  private readonly unsubscribe: () => void
  private damaged = 0

  constructor(deps: ConversationServiceDeps) {
    this.deps = {
      now: () => new Date(),
      newId: (prefix) => `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      log: (message) => console.warn(`[conversations] ${message}`),
      scheduler: defaultScheduler,
      checkpointMs: CHECKPOINT_INTERVAL_MS,
      ...deps
    }
    this.unsubscribe = deps.runs.onUpdate((run) => this.applyRun(run))
  }

  /**
   * Carrega as conversas gravadas. Respostas que ficaram em geração (app
   * fechado no meio) viram `interrupted`, com o texto parcial do último ponto
   * de controle. Nada é gerado de novo automaticamente.
   */
  async init(): Promise<{ loaded: number; damaged: number }> {
    let names: string[] = []
    try {
      names = await readdir(this.deps.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log(`não foi possível ler a pasta de conversas: ${String(error)}`)
    }
    for (const name of names.sort()) {
      const id = FILE_PATTERN.exec(name)?.[1]
      if (!id) continue
      const store = this.newStore(id)
      const value = await store.load()
      if (value === null || value.id !== id) {
        this.damaged++
        const { state, backupPath } = store.status
        this.deps.log(`conversa ${id} ignorada (${state})${backupPath ? `; cópia em ${backupPath}` : ''}`)
        // Com a cópia feita, o original inválido sai da pasta para não ser copiado de novo a cada início.
        if (value === null && state === 'recovered' && backupPath) await rm(join(this.deps.dir, name), { force: true }).catch(() => undefined)
        continue
      }
      this.slots.set(id, { store, writes: Promise.resolve(), dirty: false, save: SAVED })
      const interrupted = value.messages.some((m) => m.state === 'pending')
      this.conversations.set(id, {
        ...value,
        messages: value.messages.map((m) => (m.state === 'pending' ? { ...m, state: 'interrupted' as const } : m))
      })
      if (interrupted) await this.persist(id).catch(() => undefined)
    }
    return { loaded: this.conversations.size, damaged: this.damaged }
  }

  onUpdate(listener: ConversationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Mudanças na situação de gravação (não a cada escrita bem-sucedida seguida). */
  onSaveChange(listener: SaveListener): () => void {
    this.saveListeners.add(listener)
    return () => this.saveListeners.delete(listener)
  }

  /** Mais recente primeiro. */
  list(): ConversationList {
    const conversations = [...this.conversations.values()]
      .map((c) => summarizeConversation(c, this.slots.get(c.id)?.save ?? SAVED))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { conversations, damaged: this.damaged }
  }

  /** Tenta gravar de novo uma conversa que ficou sem salvar. Devolve a situação depois da tentativa. */
  async retrySave(input: unknown): Promise<ConversationSaveStatus> {
    const id = readId(input)
    this.require(id)
    // Só grava se a memória tiver algo que o arquivo não tem (a falha deixa a conversa assim).
    if (this.slots.get(id)?.dirty) await this.persist(id).catch(() => undefined)
    return { ...(this.slots.get(id)?.save ?? SAVED) }
  }

  get(input: unknown): Conversation {
    return structuredClone(this.require(readId(input)))
  }

  /**
   * Grava a mensagem do usuário e a resposta pendente depois que o
   * `RunService` aceita a execução; recusas da fila não deixam rastro.
   */
  async send(input: unknown): Promise<ConversationSendResult> {
    const request = unwrap(validateConversationSendRequest(input))
    const existing = request.conversationId === null ? null : this.require(request.conversationId)
    if (existing) {
      if (existing.agentId !== null && existing.agentId !== request.agentId) {
        throw new AppError('invalid-state', 'O agente fica fixo na conversa. Para usar outro agente, crie uma nova conversa.')
      }
      if (this.sending.has(existing.id) || existing.messages.some((m) => m.state === 'pending')) {
        throw new AppError('conflict', 'Esta conversa já está gerando uma resposta. Aguarde ou interrompa antes de enviar outra mensagem.', {
          retryable: true
        })
      }
      if (existing.messages.length + 2 > CONVERSATION_LIMITS.maxMessages) {
        throw new AppError('conflict', `Esta conversa chegou ao limite de ${CONVERSATION_LIMITS.maxMessages} mensagens. Crie uma nova conversa para continuar.`)
      }
    } else if (this.conversations.size >= CONVERSATION_LIMITS.maxConversations) {
      throw new AppError('conflict', `Há ${CONVERSATION_LIMITS.maxConversations} conversas gravadas. Exclua alguma para criar outra.`)
    }

    // Mesma conta do `RunService`: instruções do agente + histórico + mensagem.
    const agent = this.deps.findAgent(request.agentId)
    const instructions = agent?.instructions.trim() ? agent.instructions.length : 0
    const budget = historyBudgetChars({
      contextLength: agent?.defaultProfile.contextLength ?? null,
      maxOutputTokens: agent?.defaultProfile.maxOutputTokens ?? null,
      fixedChars: instructions + request.input.length,
      promptChars: RUN_LIMITS.promptChars
    })
    const selection = existing ? selectContext(existing.messages, budget) : { history: [], sentIds: [], omitted: 0 }

    if (existing) this.sending.add(existing.id)
    let run: RunRecord
    try {
      run = await this.deps.runs.start(
        { agentId: request.agentId, input: request.input, overrides: { model: request.model, profile: null } },
        { history: selection.history }
      )
    } finally {
      if (existing) this.sending.delete(existing.id)
    }
    if (run.origin !== 'real') {
      this.cancelQuietly(run.id)
      throw new AppError('invalid-state', 'Conversas usam só modelos reais instalados neste computador.')
    }
    const current = existing ? this.conversations.get(existing.id) : null
    if (existing && !current) {
      this.cancelQuietly(run.id)
      throw new AppError('not-found', 'A conversa foi excluída durante o envio.')
    }

    const last = current?.messages.at(-1)?.createdAt
    const now = this.iso(last)
    const conversation: Conversation = current
      ? { ...current }
      : {
          id: this.deps.newId('conv'),
          title: titleFromMessage(request.input),
          createdAt: now,
          updatedAt: now,
          model: request.model,
          agentId: request.agentId,
          messages: []
        }
    if (conversation.messages.length === 0 && conversation.title === DEFAULT_CONVERSATION_TITLE) conversation.title = titleFromMessage(request.input)
    const user: ConversationMessage = {
      id: this.deps.newId('msg'),
      role: 'user',
      content: request.input,
      createdAt: now,
      state: 'complete',
      runId: null,
      model: null,
      error: null,
      context: null
    }
    const reply: ConversationMessage = {
      id: this.deps.newId('msg'),
      role: 'assistant',
      content: '',
      createdAt: now,
      state: 'pending',
      runId: run.id,
      model: run.execution.model,
      error: null,
      context: { sent: selection.sentIds.length, omitted: selection.omitted, firstSentId: selection.sentIds[0] ?? null }
    }
    conversation.messages = [...conversation.messages, user, reply]
    conversation.updatedAt = now
    conversation.model = request.model
    conversation.agentId ??= request.agentId

    this.conversations.set(conversation.id, conversation)
    if (!this.slots.has(conversation.id)) {
      this.slots.set(conversation.id, { store: this.newStore(conversation.id), writes: Promise.resolve(), dirty: false, save: SAVED })
    }
    this.byRun.set(run.id, { conversationId: conversation.id, messageId: reply.id })
    await this.persist(conversation.id).catch(() => undefined)
    this.emit(conversation)
    // Eventos que chegaram antes do vínculo: aplica o estado atual da execução.
    const latest = this.deps.runs.get(run.id) ?? run
    this.applyRun(latest)
    return { conversation: structuredClone(this.conversations.get(conversation.id)!), run: latest }
  }

  async rename(idInput: unknown, titleInput: unknown): Promise<Conversation> {
    const id = readId(idInput)
    const c = new Checker()
    const title = unwrap(c.result(readConversationTitle(c, titleInput, '$')))
    const current = this.require(id)
    const next = { ...current, title, updatedAt: this.iso(current.updatedAt) }
    this.conversations.set(id, next)
    // Se a gravação falhar, o novo título fica na memória e a conversa, marcada como não salva.
    await this.persist(id).catch(() => undefined)
    this.emit(next)
    return structuredClone(next)
  }

  /** Interrompe a resposta em geração, se houver, e apaga o arquivo. */
  async remove(input: unknown): Promise<void> {
    const id = readId(input)
    const current = this.require(id)
    for (const m of current.messages) {
      if (m.state === 'pending' && m.runId) {
        this.byRun.delete(m.runId)
        this.clearCheckpoint(m.runId)
        this.cancelQuietly(m.runId)
      }
    }
    this.conversations.delete(id)
    const slot = this.slots.get(id)
    await slot?.writes
    try {
      await rm(this.fileOf(id), { force: true })
    } catch (error) {
      this.conversations.set(id, current)
      this.deps.log(`não foi possível excluir a conversa ${id}: ${String(error)}`)
      throw new AppError('storage', 'Não foi possível excluir a conversa do disco.', { retryable: true })
    }
    this.slots.delete(id)
  }

  /** Espera as gravações já pedidas (as falhas ficam na situação de gravação). */
  async whenSaved(): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => slot.writes))
  }

  /**
   * Antes de fechar o app: grava na hora o texto parcial das respostas em
   * geração e espera as gravações pendentes.
   */
  async flushPending(): Promise<void> {
    for (const runId of [...this.byRun.keys()]) {
      this.clearCheckpoint(runId)
      this.checkpoint(runId)
    }
    await this.whenSaved()
  }

  dispose(): void {
    this.unsubscribe()
    for (const runId of [...this.checkpoints.keys()]) this.clearCheckpoint(runId)
    this.listeners.clear()
    this.saveListeners.clear()
  }

  // -------------------------------------------------------------------------

  /**
   * Em geração: agenda um ponto de controle do texto parcial. Terminada:
   * grava o texto final, o estado e o modelo que a gerou.
   */
  private applyRun(run: RunRecord): void {
    const link = this.byRun.get(run.id)
    if (!link) return
    if (!isTerminalRunState(run.state)) {
      if (run.output) this.scheduleCheckpoint(run.id)
      return
    }
    this.clearCheckpoint(run.id)
    this.byRun.delete(run.id)
    const conversation = this.conversations.get(link.conversationId)
    const index = conversation?.messages.findIndex((m) => m.id === link.messageId) ?? -1
    if (!conversation || index < 0 || conversation.messages[index]!.state !== 'pending') return
    const message = conversation.messages[index]!
    const inferenceCode = run.error?.details?.['inferenceCode']
    const updated: ConversationMessage = {
      ...message,
      content: run.output.slice(0, CONVERSATION_LIMITS.assistantChars),
      state: STATE_OF_RUN[run.state as keyof typeof STATE_OF_RUN],
      model: run.execution?.model ?? message.model,
      error: run.error
        ? {
            code: run.error.code,
            message: run.error.message.slice(0, CONVERSATION_LIMITS.errorChars),
            inferenceCode: typeof inferenceCode === 'string' ? inferenceCode.slice(0, 64) : null
          }
        : null
    }
    const next: Conversation = {
      ...conversation,
      updatedAt: this.iso(conversation.updatedAt),
      messages: conversation.messages.map((m, i) => (i === index ? updated : m))
    }
    this.conversations.set(next.id, next)
    void this.persist(next.id).catch(() => undefined)
    this.emit(next)
  }

  /** No máximo um ponto de controle por intervalo, por resposta; nunca a cada trecho de texto. */
  private scheduleCheckpoint(runId: string): void {
    if (this.checkpoints.has(runId)) return
    const timer = this.deps.scheduler.setTimeout(() => {
      this.checkpoints.delete(runId)
      this.checkpoint(runId)
    }, this.deps.checkpointMs)
    this.checkpoints.set(runId, timer)
  }

  private clearCheckpoint(runId: string): void {
    const timer = this.checkpoints.get(runId)
    if (timer === undefined) return
    this.deps.scheduler.clearTimeout(timer)
    this.checkpoints.delete(runId)
  }

  /** Copia o texto parcial da execução para a resposta pendente e grava (o estado continua `pending`). */
  private checkpoint(runId: string): void {
    const link = this.byRun.get(runId)
    const run = this.deps.runs.get(runId)
    if (!link || !run || isTerminalRunState(run.state)) return
    const conversation = this.conversations.get(link.conversationId)
    const index = conversation?.messages.findIndex((m) => m.id === link.messageId) ?? -1
    if (!conversation || index < 0) return
    const message = conversation.messages[index]!
    const content = run.output.slice(0, CONVERSATION_LIMITS.assistantChars)
    if (message.state !== 'pending' || message.content === content) return
    this.conversations.set(conversation.id, {
      ...conversation,
      messages: conversation.messages.map((m, i) => (i === index ? { ...m, content } : m))
    })
    void this.persist(conversation.id).catch(() => undefined)
  }

  /**
   * Grava o estado atual da conversa. Pedidos seguidos se juntam: cada escrita
   * leva o estado mais recente e as redundantes são puladas. Rejeita se falhar.
   */
  private persist(id: string): Promise<void> {
    const slot = this.slots.get(id)
    if (!slot) return Promise.resolve()
    slot.dirty = true
    const write = slot.writes.then(() => this.write(id, slot))
    slot.writes = write.catch(() => undefined)
    return write
  }

  private async write(id: string, slot: Slot): Promise<void> {
    const current = this.conversations.get(id)
    // Já gravado por uma escrita anterior, ou conversa excluída enquanto esperava.
    if (!slot.dirty || !current || this.slots.get(id) !== slot) return
    slot.dirty = false
    this.setSave(id, slot, slot.save.state === 'failed' ? { ...slot.save, retrying: true } : { state: 'saving', retrying: false, message: null })
    try {
      await slot.store.update(() => structuredClone(current))
    } catch (error) {
      slot.dirty = true // o arquivo continua com o estado anterior (escrita atômica)
      const message = error instanceof AppError && error.code === 'storage-read-only' ? SAVE_READ_ONLY : SAVE_FAILED
      // Registra só a primeira falha da sequência, sem repetir a cada tentativa.
      if (slot.save.state !== 'failed') this.deps.log(`falha ao gravar a conversa ${id}: ${error instanceof Error ? error.message : String(error)}`)
      this.setSave(id, slot, { state: 'failed', retrying: false, message })
      throw new AppError('storage', message, { retryable: true })
    }
    // Uma alteração chegou durante a escrita: a próxima da fila decide a situação.
    if (slot.dirty) return
    if (slot.save.state === 'failed') this.deps.log(`conversa ${id} gravada após falha anterior`)
    this.setSave(id, slot, SAVED)
  }

  /** Avisa só quando a situação muda. */
  private setSave(id: string, slot: Slot, next: ConversationSaveStatus): void {
    const { save } = slot
    if (save.state === next.state && save.retrying === next.retrying && save.message === next.message) return
    slot.save = next
    for (const listener of this.saveListeners) {
      try {
        listener({ conversationId: id, save: { ...next } })
      } catch (error) {
        console.error('[conversations] listener falhou:', error)
      }
    }
  }

  private newStore(id: string): VersionedStore<Conversation | null> {
    return new VersionedStore<Conversation | null>({
      filePath: this.fileOf(id),
      format: 'gerpro.conversation',
      version: CONVERSATIONS_FORMAT_VERSION,
      defaults: () => null,
      parse: (data) => {
        const result = validateConversation(data)
        return result.ok ? { value: result.value, issues: [] } : { value: undefined, issues: result.issues }
      },
      now: this.deps.now,
      log: this.deps.log,
      writer: this.deps.writer
    })
  }

  private fileOf(id: string): string {
    return join(this.deps.dir, `${id}.json`)
  }

  private require(id: string): Conversation {
    const conversation = this.conversations.get(id)
    if (!conversation) throw new AppError('not-found', 'Conversa não encontrada.')
    return conversation
  }

  private cancelQuietly(runId: string): void {
    try {
      this.deps.runs.cancel(runId)
    } catch {
      // Já encerrada.
    }
  }

  private emit(conversation: Conversation): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(conversation))
      } catch (error) {
        console.error('[conversations] listener falhou:', error)
      }
    }
  }

  /** Agora, nunca antes de `notBefore` (o relógio pode voltar; a ordem das mensagens não). */
  private iso(notBefore?: string): string {
    const now = this.deps.now()
    const floor = notBefore ? Date.parse(notBefore) : NaN
    return (Number.isFinite(floor) && floor > now.getTime() ? new Date(floor) : now).toISOString()
  }
}

function readId(input: unknown): string {
  const c = new Checker()
  return unwrap(c.result(readConversationId(c, input, '$')))
}

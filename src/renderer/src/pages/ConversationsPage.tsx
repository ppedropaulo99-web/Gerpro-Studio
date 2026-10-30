import { useEffect, useMemo, useRef, useState } from 'react'
import { History, MessageSquare, MessageSquarePlus, Pencil, RefreshCw, SendHorizontal, Trash2 } from 'lucide-react'
import { CONVERSATION_LIMITS, type Conversation, type ConversationMessage, type ConversationSummary } from '@shared/conversations'
import type { StructuredError } from '@shared/errors'
import type { ProviderOverview } from '@shared/inference'
import { RUN_INPUT_MAX, type RunRecord } from '@shared/runs'
import { useNavigation } from '@renderer/app/navigation'
import { CancelRunButton, ErrorExplanation, useCancelRun } from '@renderer/components/runs/RunParts'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FeatureBadge,
  FieldError,
  LoadingState,
  Menu,
  Notice,
  Select,
  StatusBadge,
  TextArea,
  TextInput
} from '@renderer/components/ui'
import { callApi } from '@renderer/lib/api'
import {
  contextLabel,
  interruptedNotice,
  messageError,
  newerConversation,
  removeSummary,
  saveIndicator,
  saveStateOf,
  threadItems,
  upsertSummary
} from '@renderer/lib/conversations'
import { cx } from '@renderer/lib/cx'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import {
  defaultModelKey,
  eligibleModels,
  friendlyModelName,
  inventoryProblem,
  modelKey as keyOf,
  runDraftErrors,
  runStatusView,
  sendRequestFrom,
  type RunDraftErrors
} from '@renderer/lib/real-runs'
import { requestRunDetails, takeRequestedAgent, takeRequestedModel } from '@renderer/lib/run-intent'
import { rememberInput } from '@renderer/lib/sent-inputs'
import { useConversationList, useSaveStates } from '@renderer/lib/use-conversations'
import { useResource } from '@renderer/lib/use-resource'
import { useSessionRuns, withRun } from '@renderer/lib/use-session-runs'

/**
 * Conversas: sessões contínuas com os modelos instalados neste computador.
 *
 * As conversas ficam gravadas pelo Main (`conversations:*`). Cada envio é uma
 * execução do `RunService` com o recorte permitido do histórico; enquanto a
 * resposta é gerada, o texto exibido é o da execução (`runs:updated`), e a
 * conversa recebe a resposta final quando ela termina. Se a gravação falhar,
 * as mensagens continuam na tela e o cabeçalho mostra a falha, com a opção de
 * tentar de novo.
 */
export function ConversationsPage() {
  const { navigate } = useNavigation()
  const runs = useSessionRuns()
  const list = useConversationList()
  const saves = useSaveStates()
  const agents = useResource(() => window.gerpro.agents.list())
  const providers = useResource(() => window.gerpro.providers.list())

  // Atalhos de Agentes e Modelos abrem uma conversa nova com a escolha feita.
  const [activeId, setActiveId] = useState<string | null>(null)
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [loadError, setLoadError] = useState<StructuredError | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [agentId, setAgentId] = useState(() => takeRequestedAgent() ?? '')
  const [requestedModel] = useState(() => takeRequestedModel())
  const [modelKey, setModelKey] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<RunDraftErrors>({})
  const [actionError, setActionError] = useState<StructuredError | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null)
  const [retrying, setRetrying] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)

  const all = runs.state.status === 'ready' ? runs.state.data : []
  const overview = providers.state.status === 'ready' ? providers.state.data : []
  const options = useMemo(() => eligibleModels(overview), [overview])
  const problem = providers.state.status === 'ready' ? inventoryProblem(overview) : null
  const runnable = useMemo(
    () => (agents.state.status === 'ready' ? agents.state.data.filter((a) => a.definition.state !== 'archived') : []),
    [agents.state]
  )
  const summaries = list.state.status === 'ready' ? list.state.data.conversations : []

  // Numa conversa existente, o agente é o dela (fixo depois da primeira mensagem).
  const current = conversation && conversation.id === activeId ? conversation : null
  const effectiveAgentId = current?.agentId ?? agentId
  const agent = runnable.find((a) => a.definition.id === effectiveAgentId)
  const agentMissing = current !== null && current.agentId !== null && agents.state.status === 'ready' && !agent
  const pending = current?.messages.find((m) => m.state === 'pending') ?? null
  const liveRun = pending?.runId ? (all.find((r) => r.id === pending.runId) ?? null) : null
  const cancel = useCancelRun(liveRun, (run) => runs.update(withRun(run)))
  const lastReply = current ? [...current.messages].reverse().find((m) => m.role === 'assistant') : undefined
  const save = current ? saveStateOf(current.id, saves.states, summaries) : null
  const indicator = save ? saveIndicator(save) : null

  useEffect(() => {
    if (agents.state.status === 'ready' && !runnable.some((a) => a.definition.id === agentId)) setAgentId(runnable[0]?.definition.id ?? '')
  }, [agents.state.status, runnable, agentId])

  // Conversa aberta: lida do Main; a resposta final chega por `conversations:updated`.
  useEffect(() => {
    setLoadError(null)
    if (!activeId) return
    let stale = false
    void callApi(() => window.gerpro.conversations.get(activeId)).then((result) => {
      if (stale) return
      if (result.ok) setConversation((c) => newerConversation(c, result.data))
      else setLoadError(result.error)
    })
    return () => {
      stale = true
    }
  }, [activeId, loadAttempt])

  useEffect(() => window.gerpro.conversations.onUpdated((c) => setConversation((cur) => (cur && cur.id === c.id ? newerConversation(cur, c) : cur))), [])

  // Modelo: o último da conversa, se continuar instalado; senão o padrão do agente.
  const currentModel = current?.model ?? null
  useEffect(() => {
    setModelKey((key) => {
      if (currentModel && options.some((o) => o.key === keyOf(currentModel))) return keyOf(currentModel)
      return defaultModelKey(options, key, agent?.definition.defaultModel ?? null, requestedModel)
    })
  }, [options, agent, requestedModel, current?.id, currentModel])

  // Ao abrir uma conversa, começa pela mensagem mais recente.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [current?.id])

  // Acompanha o texto enquanto chega, sem puxar quem rolou para cima para ler.
  useEffect(() => {
    const el = threadRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [liveRun?.output, current?.messages.length, current?.updatedAt])

  function openConversation(id: string | null) {
    setActiveId(id)
    if (id === null) setConversation(null)
    setErrors({})
    setActionError(null)
    cancel.clearError()
  }

  async function send() {
    const draft = { agentId: effectiveAgentId, modelKey, input }
    const found = runDraftErrors(draft, options)
    setErrors(found)
    setActionError(null)
    cancel.clearError()
    const request = sendRequestFrom(draft, options, current?.id ?? null)
    if (Object.keys(found).length > 0 || !request) return
    setBusy(true)
    const result = await callApi(() => window.gerpro.conversations.send(request))
    setBusy(false)
    if (!result.ok) {
      setActionError(result.error)
      // Modelo removido ou motor parado: a lista mostrada pode estar velha.
      if (result.error.code === 'inference') providers.reload()
      return
    }
    const { conversation: saved, run } = result.data
    rememberInput(run.id, input)
    setInput('')
    runs.update(withRun(run))
    list.update((l) => upsertSummary(l, saved))
    setConversation((c) => newerConversation(c, saved))
    setActiveId(saved.id)
  }

  async function rename(id: string, title: string) {
    setRenaming(null)
    const trimmed = title.replace(/\s+/g, ' ').trim().slice(0, CONVERSATION_LIMITS.titleChars)
    if (!trimmed || trimmed === summaries.find((s) => s.id === id)?.title) return
    const result = await callApi(() => window.gerpro.conversations.rename(id, trimmed))
    if (!result.ok) return setActionError(result.error)
    list.update((l) => upsertSummary(l, result.data))
    setConversation((c) => (c && c.id === id ? newerConversation(c, result.data) : c))
  }

  async function remove(summary: ConversationSummary) {
    setDeleting(null)
    const result = await callApi(() => window.gerpro.conversations.remove(summary.id))
    if (!result.ok) return setActionError(result.error)
    list.update((l) => removeSummary(l, summary.id))
    if (activeId === summary.id) openConversation(null)
  }

  async function retrySave(id: string) {
    setRetrying(true)
    const result = await callApi(() => window.gerpro.conversations.retrySave(id))
    setRetrying(false)
    if (result.ok) saves.set(id, result.data)
  }

  function openDetails(runId: string) {
    requestRunDetails(runId)
    navigate('runs')
  }

  const loading = agents.state.status === 'loading' || providers.state.status === 'loading'
  const canWrite = !agentMissing && runnable.length > 0 && options.length > 0
  const reasoningOf = (run: RunRecord | null) => options.some((o) => run?.execution && o.key === keyOf(run.execution.model) && o.reasoning)
  const damaged = list.state.status === 'ready' ? list.state.data.damaged : 0

  return (
    <div className="page page--full chat conversations">
      <aside className="chat__list" aria-label="Conversas" data-tour="conversations.messages">
        <div className="chat__list-head stack" style={{ gap: 'var(--space-2)' }}>
          <Button variant="secondary" icon={<MessageSquarePlus size={16} />} style={{ width: '100%' }} onClick={() => openConversation(null)}>
            Nova conversa
          </Button>
          <div className="row between">
            <span className="subtle">Conversas salvas</span>
            <FeatureBadge state="real" />
          </div>
        </div>
        {list.state.status === 'loading' && <LoadingState label="Carregando…" />}
        {list.state.status === 'error' && <ErrorState error={list.state.error} onRetry={list.reload} />}
        {list.state.status === 'ready' && summaries.length === 0 && (
          <p className="subtle chat__note">Nenhuma conversa ainda. Envie a primeira mensagem para criar uma.</p>
        )}
        {summaries.map((s) =>
          renaming?.id === s.id ? (
            <TextInput
              key={s.id}
              aria-label="Novo título da conversa"
              autoFocus
              maxLength={CONVERSATION_LIMITS.titleChars}
              value={renaming.title}
              onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
              onBlur={() => void rename(s.id, renaming.title)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename(s.id, renaming.title)
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <div key={s.id} className={cx('conversations__item', s.id === activeId && 'chat__item--active')}>
              <button type="button" className="chat__item" aria-current={s.id === activeId} onClick={() => openConversation(s.id)}>
                <span className="chat__item-title">{s.title}</span>
                <span className="subtle">
                  {saveStateOf(s.id, saves.states, summaries).state === 'failed' ? 'Não salva · ' : ''}
                  {s.generating ? 'Gerando resposta…' : `${s.model ? friendlyModelName(s.model.modelId) : 'Sem modelo'} · ${formatDateTime(s.updatedAt)}`}
                </span>
              </button>
              <Menu
                label={`Ações de ${s.title}`}
                items={[
                  { label: 'Renomear', icon: <Pencil size={14} />, onSelect: () => setRenaming({ id: s.id, title: s.title }) },
                  'separator',
                  { label: 'Excluir', icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(s) }
                ]}
              />
            </div>
          )
        )}
        {damaged > 0 && (
          <p className="subtle chat__note">
            {damaged} arquivo(s) de conversa não puderam ser lidos e ficaram de fora. Uma cópia do original foi preservada na pasta de dados.
          </p>
        )}
        <p className="subtle chat__note">As conversas ficam gravadas só neste computador.</p>
      </aside>

      <section className="chat__main">
        <header className="chat__head">
          <div className="stack" style={{ gap: 0, minWidth: 0 }}>
            <h2 className="truncate">{current?.title ?? 'Nova conversa'}</h2>
            <span className="subtle truncate">
              {current
                ? [
                    current.model ? friendlyModelName(current.model.modelId) : null,
                    agent?.definition.name ?? null,
                    `${current.messages.length} mensagem(ns)`
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'Converse com modelos de IA instalados neste computador.'}
            </span>
          </div>
          <div className="row">
            {indicator && (
              <span role="status" aria-live="polite">
                <StatusBadge tone={indicator.tone} pulse={indicator.pulse}>
                  {indicator.label}
                </StatusBadge>
              </span>
            )}
            <Button variant="ghost" size="sm" icon={<History size={14} />} onClick={() => navigate('runs')}>
              Histórico e métricas
            </Button>
          </div>
        </header>

        <div className="chat__thread" ref={threadRef} data-tour="conversations.thread">
          {activeId && loadError ? (
            <ErrorState error={loadError} onRetry={() => setLoadAttempt((n) => n + 1)} />
          ) : activeId && !current ? (
            <LoadingState label="Abrindo conversa…" />
          ) : current ? (
            threadItems(current).map(({ message, modelSwitch, contextStartsHere }) => (
              <MessageView
                key={message.id}
                message={message}
                modelSwitch={modelSwitch}
                contextStartsHere={contextStartsHere}
                run={message.runId ? (all.find((r) => r.id === message.runId) ?? null) : null}
                all={all}
                reasoning={reasoningOf(message.runId ? (all.find((r) => r.id === message.runId) ?? null) : null)}
                onDetails={openDetails}
              />
            ))
          ) : loading ? (
            <LoadingState label="Consultando agentes e modelos…" />
          ) : agents.state.status === 'error' ? (
            <ErrorState error={agents.state.error} onRetry={agents.reload} />
          ) : providers.state.status === 'error' ? (
            <ErrorState error={providers.state.error} onRetry={providers.reload} />
          ) : runnable.length === 0 ? (
            <EmptyState icon={<MessageSquare size={26} />} title="Crie um agente para começar">
              Toda conversa usa as instruções de um agente. Crie o seu na tela Agentes e volte aqui.{' '}
              <Button variant="ghost" size="sm" onClick={() => navigate('agents')}>
                Ir para Agentes
              </Button>
            </EmptyState>
          ) : (
            <Welcome providers={overview} />
          )}
        </div>

        <footer className="chat__composer" data-tour="conversations.composer">
          {current && save?.state === 'failed' && (
            <Notice tone="warning">
              <div className="row between conversations__save">
                <span>{save.message ?? 'Não foi possível gravar a conversa no disco.'} Nada foi descartado.</span>
                <Button variant="secondary" size="sm" disabled={retrying || save.retrying} onClick={() => void retrySave(current.id)}>
                  {retrying || save.retrying ? 'Tentando…' : 'Tentar salvar novamente'}
                </Button>
              </div>
            </Notice>
          )}
          {problem && <Notice tone={problem.tone}>{problem.text}</Notice>}
          {agentMissing && (
            <Notice tone="warning">O agente desta conversa foi excluído ou arquivado. Para continuar, crie uma nova conversa.</Notice>
          )}
          {lastReply?.context && lastReply.context.omitted > 0 && (
            <Notice tone="neutral">
              O limite de contexto foi atingido: o modelo recebe só as mensagens mais recentes desta conversa. As mais antigas continuam
              guardadas aqui.
            </Notice>
          )}
          {actionError && <ErrorExplanation error={actionError} />}
          {cancel.error && <ErrorExplanation error={cancel.error} />}
          <TextArea
            aria-label="Mensagem"
            rows={2}
            value={input}
            disabled={!canWrite}
            placeholder={canWrite ? 'Escreva sua mensagem…' : 'Escolha um agente e um modelo instalado para escrever.'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (!busy && !pending && canWrite) void send()
              }
            }}
          />
          <FieldError>{errors.input ?? errors.modelKey ?? errors.agentId}</FieldError>
          <div className="row between conversations__bar">
            <div className="row conversations__selects">
              <Select
                aria-label="Modelo"
                title={options.find((o) => o.key === modelKey)?.ref.modelId}
                value={modelKey}
                disabled={options.length === 0}
                onChange={(e) => setModelKey(e.target.value)}
                options={[
                  { value: '', label: options.length === 0 ? 'Nenhum modelo instalado' : 'Escolha um modelo…' },
                  ...options.map((o) => ({ value: o.key, label: o.reasoning ? `${o.label} · raciocina` : o.label }))
                ]}
              />
              <Select
                aria-label="Agente"
                title={current ? 'O agente fica fixo na conversa. Para outro agente, crie uma nova conversa.' : 'As instruções do agente acompanham a conversa.'}
                value={effectiveAgentId}
                disabled={runnable.length === 0 || current !== null}
                onChange={(e) => setAgentId(e.target.value)}
                options={
                  agentMissing
                    ? [{ value: effectiveAgentId, label: 'Agente indisponível' }]
                    : runnable.length === 0
                      ? [{ value: '', label: 'Nenhum agente' }]
                      : runnable.map((a) => ({ value: a.definition.id, label: a.definition.name }))
                }
              />
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Atualizar lista de modelos"
                title="Atualizar lista de modelos"
                icon={<RefreshCw size={14} />}
                disabled={providers.state.status === 'loading'}
                onClick={providers.reload}
              />
            </div>
            <div className="row">
              <span className="field__hint">
                {formatNumber(input.length)} / {formatNumber(RUN_INPUT_MAX)}
              </span>
              {pending && liveRun ? (
                <CancelRunButton run={liveRun} cancelling={cancel.cancelling} onCancel={() => void cancel.cancel()} size="md" variant="primary" />
              ) : (
                <Button variant="primary" icon={<SendHorizontal size={15} />} disabled={busy || !canWrite || pending !== null} onClick={() => void send()}>
                  {busy ? 'Enviando…' : 'Enviar'}
                </Button>
              )}
            </div>
          </div>
          <span className="field__hint">
            Enter envia · Shift+Enter quebra a linha · as mensagens anteriores desta conversa vão como contexto, dentro do limite
            {agent && agent.definition.tools.length > 0 ? ' · as ferramentas do agente ainda não são usadas' : ''}
          </span>
        </footer>
      </section>

      <ConfirmDialog
        open={deleting !== null}
        title="Excluir conversa?"
        cancelLabel="Cancelar"
        confirmLabel="Excluir"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && void remove(deleting)}
      >
        “{deleting?.title}” e todas as mensagens dela serão apagadas deste computador. Esta ação não pode ser desfeita.
        {deleting?.generating ? ' A resposta em geração será interrompida.' : ''}
      </ConfirmDialog>
    </div>
  )
}

/** Estado inicial: explica o que acontece ao enviar. */
function Welcome({ providers }: { providers: readonly ProviderOverview[] }) {
  const ready = eligibleModels(providers).length > 0
  return (
    <div className="stack chat__welcome">
      <EmptyState icon={<MessageSquare size={26} />} title="Nova conversa">
        {ready
          ? 'Escolha o modelo abaixo e escreva a primeira mensagem. O modelo roda neste computador e a resposta aparece aqui enquanto é gerada.'
          : 'Quando houver um modelo de conversa instalado no motor de IA local, ele aparece no seletor abaixo.'}
      </EmptyState>
      <Notice tone="neutral">
        As mensagens anteriores da conversa vão junto como contexto, até o limite do modelo; quando a conversa crescer, as mais antigas
        ficam guardadas aqui, mas deixam de ser enviadas.
      </Notice>
    </div>
  )
}

const FINAL_STATUS: Partial<Record<ConversationMessage['state'], { label: string; tone: 'neutral' | 'danger' | 'warning' }>> = {
  cancelled: { label: 'Interrompida', tone: 'neutral' },
  failed: { label: 'Falhou', tone: 'danger' },
  interrupted: { label: 'Interrompida ao fechar o aplicativo', tone: 'warning' }
}

/** Uma mensagem. Resposta em geração: o texto vem da execução (`RunService`). */
function MessageView({
  message,
  modelSwitch,
  contextStartsHere,
  run,
  all,
  reasoning,
  onDetails
}: {
  message: ConversationMessage
  modelSwitch: string | null
  contextStartsHere: boolean
  run: RunRecord | null
  all: readonly RunRecord[]
  reasoning: boolean
  onDetails: (runId: string) => void
}) {
  const marks = (
    <>
      {contextStartsHere && <div className="conversations__divider">Mensagens acima desta linha não foram enviadas na última resposta (limite de contexto)</div>}
      {modelSwitch && <div className="conversations__divider">Modelo alterado para {modelSwitch}</div>}
    </>
  )
  if (message.role === 'user') {
    return (
      <>
        {marks}
        <div className="bubble bubble--user">{message.content}</div>
      </>
    )
  }

  const live = message.state === 'pending'
  // Sem a execução (já descartada da sessão), mostra o último texto parcial gravado.
  const text = live ? (run?.output ?? message.content) : message.content
  const status = live && run ? runStatusView(run, all) : null
  const final = FINAL_STATUS[message.state]
  const waiting = !live
    ? 'Nenhum texto de resposta.'
    : run?.state === 'pending'
      ? 'Aguardando a vez na fila…'
      : // O motor só avisa "carregando" e depois manda texto: com raciocínio, a espera inclui pensar.
        reasoning
        ? 'Carregando o modelo e raciocinando antes de responder. O raciocínio não é exibido e pode levar mais de um minuto.'
        : run?.progress.step === 'Carregando modelo'
          ? 'Carregando o modelo. A primeira resposta pode levar alguns segundos.'
          : 'Gerando resposta…'
  const context = contextLabel(message.context)
  const error = messageError(message)

  return (
    <>
      {marks}
      <div className="bubble bubble--assistant" aria-live={live ? 'polite' : 'off'} aria-busy={live}>
        {text || <span className="muted">{waiting}</span>}
      </div>
      <div className="row conversations__status">
        {status && (
          <StatusBadge tone={status.tone} pulse={status.pulse}>
            {status.label}
          </StatusBadge>
        )}
        {final && <StatusBadge tone={final.tone}>{final.label}</StatusBadge>}
        <span className="subtle conversations__meta">
          {[message.model ? friendlyModelName(message.model.modelId) : null, formatDateTime(message.createdAt), context].filter(Boolean).join(' · ')}
        </span>
        {run && (
          <Button variant="ghost" size="sm" onClick={() => onDetails(run.id)}>
            Detalhes técnicos
          </Button>
        )}
      </div>
      {message.state === 'failed' && error && <ErrorExplanation error={error} origin="real" />}
      {message.state === 'failed' && <span className="subtle conversations__meta">Esta troca não é enviada como contexto nas próximas mensagens.</span>}
      {message.state === 'interrupted' && (
        <Notice tone="neutral">{interruptedNotice(message)}</Notice>
      )}
    </>
  )
}

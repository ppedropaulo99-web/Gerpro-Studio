import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, Boxes, History, MessagesSquare, Play, Zap } from 'lucide-react'
import type { AgentRecord } from '@shared/agents'
import type { StructuredError } from '@shared/errors'
import type { ProviderOverview } from '@shared/inference'
import type { DemoRunRequest, RunRecord, RunState } from '@shared/runs'
import { isTerminalRunState, RUN_LIMITS } from '@shared/runs'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { CancelRunButton, ErrorExplanation, useCancelRun } from '@renderer/components/runs/RunParts'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  FeatureBadge,
  FeatureNotice,
  Field,
  LoadingState,
  Notice,
  Segmented,
  Select,
  StatusBadge
} from '@renderer/components/ui'
import { agentById } from '@renderer/data/agents'
import { modelById } from '@renderer/data/models'
import { runs as exampleRuns } from '@renderer/data/runs'
import { useNavigation } from '@renderer/app/navigation'
import { callApi } from '@renderer/lib/api'
import { summarizeEngine } from '@renderer/lib/engine'
import { formatDateTime, formatDuration, formatNumber } from '@renderer/lib/format'
import { homeStats } from '@renderer/lib/home'
import { completedWithWarning, friendlyModelName, metricRows, runStatusView } from '@renderer/lib/real-runs'
import { takeRequestedRun } from '@renderer/lib/run-intent'
import { legacyRunState, runDurationSec } from '@renderer/lib/runs'
import { sentInputOf } from '@renderer/lib/sent-inputs'
import type { FeatureState } from '@renderer/lib/status'
import { runOrigin, runState } from '@renderer/lib/status'
import { useResource } from '@renderer/lib/use-resource'
import { useSessionRuns, withRun } from '@renderer/lib/use-session-runs'

/**
 * Central de monitoramento das execuções desta sessão: resumo, histórico,
 * estados, origem, modelo, métricas, erros e registro técnico. Mensagens
 * para modelos reais são enviadas em Conversas; aqui só se acompanha (e se
 * interrompe) o que está na fila do `RunService`.
 */
export function RunsPage() {
  const { navigate } = useNavigation()
  const runs = useSessionRuns()
  const agents = useResource(() => window.gerpro.agents.list())
  const providers = useResource(() => window.gerpro.providers.list())
  // "Detalhes técnicos" em Conversas abre esta tela já com a execução escolhida.
  const [selectedId, setSelectedId] = useState<string | null>(() => takeRequestedRun())
  const detailsRef = useRef<HTMLDivElement>(null)

  const list = runs.state.status === 'ready' ? runs.state.data : []
  const selected = list.find((r) => r.id === selectedId)
  const runnable = useMemo(
    () => (agents.state.status === 'ready' ? agents.state.data.filter((a) => a.definition.state !== 'archived') : []),
    [agents.state]
  )
  const nameOf = (id: string) =>
    (agents.state.status === 'ready' && agents.state.data.find((a) => a.definition.id === id)?.definition.name) || id
  const overview = providers.state.status === 'ready' ? providers.state.data : []

  function select(id: string | null, scroll = false) {
    setSelectedId(id)
    if (scroll) requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }

  return (
    <div className="page">
      <PageHeader
        title="Execuções"
        description="Acompanhe as execuções desta sessão: estado, origem, modelo, métricas, erros e registro técnico."
        actions={
          <Button variant="primary" icon={<MessagesSquare size={16} />} onClick={() => navigate('conversations')}>
            Nova mensagem
          </Button>
        }
      />
      <EngineNotice providers={providers.state} />
      <SessionStats agents={agents.state} runs={runs.state} />

      <div ref={detailsRef}>
        {selected && (
          <RunDetails
            run={selected}
            all={list}
            agentName={nameOf(selected.agentId)}
            providers={overview}
            onChanged={(run) => runs.update(withRun(run))}
          />
        )}
      </div>

      <SessionRuns runs={runs} selectedId={selectedId} onSelect={(id) => select(id === selectedId ? null : id, true)} nameOf={nameOf} />

      <SimulatedLauncher
        agents={agents}
        runnable={runnable}
        onStarted={(run) => {
          runs.update(withRun(run))
          select(run.id, true)
        }}
      />

      <ExampleHistory />
    </div>
  )
}

type Resource<T> = ReturnType<typeof useResource<T>>

/** Situação do motor real; o texto muda conforme o que o Main informa. */
function EngineNotice({ providers }: { providers: Resource<ProviderOverview[]>['state'] }) {
  if (providers.status !== 'ready') return null
  const engine = summarizeEngine(providers.data)
  return engine.connected ? (
    <FeatureNotice state="real">
      {engine.label} com {engine.installedModels} modelo(s) instalado(s). As mensagens enviadas em Conversas rodam neste computador, uma por
      vez. Cada geração aparece aqui só durante esta sessão; as conversas em si ficam gravadas em Conversas.
    </FeatureNotice>
  ) : (
    <FeatureNotice state="planned">
      Nenhum motor de IA local está respondendo, então execuções reais não estão disponíveis agora. A demonstração simulada continua
      funcionando.
    </FeatureNotice>
  )
}

/** Resumo da sessão, só com dados do Main; o que o motor não informa fica "Planejado". */
function SessionStats({ agents, runs }: { agents: Resource<AgentRecord[]>['state']; runs: ReturnType<typeof useSessionRuns>['state'] }) {
  const stats = agents.status === 'ready' && runs.status === 'ready' ? homeStats(agents.data, runs.data, new Date()) : null
  const pending = agents.status === 'error' || runs.status === 'error' ? '—' : '…'
  const cards: Array<{ label: string; value: string | number; detail: string; state: FeatureState; icon: typeof History }> = [
    {
      label: 'Execuções hoje',
      value: stats ? stats.realRunsToday + stats.simulationsToday : pending,
      detail: stats ? `${stats.realRunsToday} real(is) · ${stats.simulationsToday} simulada(s)` : 'Nesta sessão',
      state: 'real',
      icon: History
    },
    {
      label: 'Em andamento',
      value: stats?.activeSimulations ?? pending,
      detail: 'Na fila ou gerando (reais e simuladas)',
      state: 'real',
      icon: Activity
    },
    { label: 'Modelos carregados', value: '—', detail: 'Ainda não informado pelo motor local', state: 'planned', icon: Boxes },
    { label: 'Tokens hoje', value: '—', detail: 'Soma de tokens planejada', state: 'planned', icon: Zap }
  ]
  return (
    <div className="grid grid--stats" data-tour="runs.stats">
      {cards.map(({ label, value, detail, state, icon: Icon }) => (
        <Card key={label}>
          <CardBody className="stat">
            <div className="stat__icon">
              <Icon size={18} />
            </div>
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <div className="stat__value">{value}</div>
              <div className="subtle">{label}</div>
              <div className="row" style={{ marginTop: 'var(--space-1)' }}>
                <FeatureBadge state={state} />
              </div>
              <span className="field__hint">{detail}</span>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detalhes (resposta em tempo real, métricas, erros)
// ---------------------------------------------------------------------------

function RunDetails({
  run,
  all,
  agentName,
  providers,
  onChanged
}: {
  run: RunRecord
  all: readonly RunRecord[]
  agentName: string
  providers: readonly ProviderOverview[]
  onChanged: (run: RunRecord) => void
}) {
  const { cancel, cancelling, error: cancelError } = useCancelRun(run, onChanged)
  const simulated = run.origin === 'simulated'
  const terminal = isTerminalRunState(run.state)
  const status = runStatusView(run, all)
  const origin = runOrigin[run.origin]
  const model = run.execution?.model
  const provider = model ? providers.find((p) => p.info.id === model.providerId) : undefined
  const reasoning = Boolean(
    provider?.models?.find((m) => m.model.ref.modelId === model?.modelId)?.model.capabilities.includes('reasoning')
  )
  const warning = completedWithWarning(run)
  const sent = sentInputOf(run.id)
  const metrics = metricRows(run.metrics, reasoning)
  const log = run.messages.map((m) => `${formatDateTime(m.at)}  ${m.level.toUpperCase().padEnd(7)} ${m.text}`).join('\n')

  const facts: Array<[string, string]> = [
    ['Origem', simulated ? 'Simulada (provedor simulado, sem modelo real)' : 'Real (modelo local)'],
    ['Modelo', model ? (simulated ? model.modelId : `${friendlyModelName(model.modelId)} · ${model.modelId}`) : '—'],
    ['Provedor', provider?.info.displayName ?? model?.providerId ?? '—'],
    ['Criada', formatDateTime(run.createdAt)],
    ['Duração', formatDuration(runDurationSec(run))]
  ]

  return (
    <Card>
      <CardHeader
        title={agentName}
        subtitle={<span className="mono">{run.id}</span>}
        actions={
          <div className="row">
            <StatusBadge tone={origin.tone}>{origin.label}</StatusBadge>
            <StatusBadge tone={status.tone} pulse={status.pulse}>
              {status.label}
            </StatusBadge>
            <CancelRunButton run={run} cancelling={cancelling} onCancel={() => void cancel()} />
          </div>
        }
      />
      <CardBody className="stack">
        {cancelError && <ErrorExplanation error={cancelError} />}
        {run.state === 'failed' && run.error && <ErrorExplanation error={run.error} origin={run.origin} />}
        {warning && <Notice tone="warning">{warning} O texto recebido até esse ponto foi mantido.</Notice>}
        {run.state === 'cancelled' && (
          <Notice tone="neutral">
            {run.cancelRequested ? 'Geração interrompida por você.' : 'O motor encerrou a geração antes do fim.'}
            {run.output ? ' O texto recebido até então foi mantido.' : ''}
          </Notice>
        )}

        {sent && (
          <Labeled label="Sua mensagem">
            <div className="run-output run-output--sent">{sent}</div>
          </Labeled>
        )}

        <Labeled label={simulated ? 'Resposta simulada' : 'Resposta do modelo'}>
          {run.output ? (
            <div className="run-output" aria-live={terminal ? 'off' : 'polite'} aria-busy={!terminal}>
              {run.output}
            </div>
          ) : (
            <p className="muted">
              {terminal
                ? 'Nenhum texto de resposta.'
                : run.state === 'pending'
                  ? 'Aguardando a vez na fila.'
                  : reasoning
                    ? 'Aguardando o primeiro texto. Este modelo raciocina antes de responder; o raciocínio não é exibido e pode demorar.'
                    : 'Aguardando o primeiro texto…'}
            </p>
          )}
        </Labeled>

        <div className="form-grid" style={{ alignItems: 'start' }}>
          <dl className="specs">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {!simulated && (
            <div className="stack" style={{ gap: 'var(--space-2)' }}>
              {metrics.length > 0 ? (
                <dl className="specs" aria-label="Métricas medidas">
                  {metrics.map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="subtle">{terminal ? 'Métricas não informadas pelo motor.' : 'Métricas aparecem ao fim da geração.'}</p>
              )}
            </div>
          )}
        </div>

        <details>
          <summary className="subtle">Registro técnico</summary>
          <pre className="log" aria-label="Mensagens da execução">
            {log}
          </pre>
        </details>
      </CardBody>
    </Card>
  )
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 'var(--space-1)' }}>
      <span className="field__label">{label}</span>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Execuções desta sessão (reais e simuladas, do RunService)
// ---------------------------------------------------------------------------

function SessionRuns({
  runs,
  selectedId,
  onSelect,
  nameOf
}: {
  runs: ReturnType<typeof useSessionRuns>
  selectedId: string | null
  onSelect: (id: string) => void
  nameOf: (id: string) => string
}) {
  const list = runs.state.status === 'ready' ? runs.state.data : []
  return (
    <section className="section" aria-labelledby="session-runs" data-tour="runs.session">
      <div className="section__head">
        <h2 id="session-runs">Execuções desta sessão</h2>
        <div className="row">
          {runs.state.status === 'ready' && (
            <span className="subtle">
              {list.length} execução(ões) · até {RUN_LIMITS.maxRecords} · descartadas ao fechar o aplicativo
            </span>
          )}
        </div>
      </div>

      {runs.state.status === 'loading' && <LoadingState label="Carregando execuções…" />}
      {runs.state.status === 'error' && <ErrorState error={runs.state.error} onRetry={runs.reload} />}
      {runs.state.status === 'ready' && list.length === 0 && (
        <Card>
          <EmptyState icon={<History size={26} />} title="Nenhuma execução nesta sessão">
            Execuções reais e simuladas aparecem aqui e são descartadas ao fechar o aplicativo.
          </EmptyState>
        </Card>
      )}
      {list.length > 0 && (
        <Card>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Agente</th>
                  <th>Tipo</th>
                  <th>Modelo</th>
                  <th>Criada</th>
                  <th>Duração</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const status = runStatusView(r, list)
                  const origin = runOrigin[r.origin]
                  return (
                    <tr
                      key={r.id}
                      aria-selected={r.id === selectedId}
                      tabIndex={0}
                      onClick={() => onSelect(r.id)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(r.id))}
                      style={{ cursor: 'pointer' }}
                      title="Ver detalhes"
                    >
                      <td>{nameOf(r.agentId)}</td>
                      <td>
                        <StatusBadge tone={origin.tone}>{origin.label}</StatusBadge>
                      </td>
                      <td className="mono truncate">{r.execution?.model.modelId ?? '—'}</td>
                      <td className="muted">{formatDateTime(r.createdAt)}</td>
                      <td className="mono">{formatDuration(runDurationSec(r))}</td>
                      <td>
                        <StatusBadge tone={status.tone} pulse={status.pulse}>
                          {status.label}
                        </StatusBadge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Demonstração simulada (provedor simulado, mesma fila)
// ---------------------------------------------------------------------------

function SimulatedLauncher({
  agents,
  runnable,
  onStarted
}: {
  agents: Resource<AgentRecord[]>
  runnable: AgentRecord[]
  onStarted: (run: RunRecord) => void
}) {
  const { navigate } = useNavigation()
  const [agentId, setAgentId] = useState('')
  const [scenario, setScenario] = useState<DemoRunRequest['scenario']>('success')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<StructuredError | null>(null)

  useEffect(() => {
    if (!runnable.some((a) => a.definition.id === agentId)) setAgentId(runnable[0]?.definition.id ?? '')
  }, [runnable, agentId])

  async function start() {
    setBusy(true)
    setActionError(null)
    const result = await callApi(() => window.gerpro.runs.startDemo({ agentId, scenario }))
    setBusy(false)
    if (result.ok) onStarted(result.data)
    else setActionError(result.error)
  }

  return (
    <section className="section" aria-labelledby="simulated-runs">
      <div className="section__head">
        <h2 id="simulated-runs">Demonstração simulada</h2>
        <FeatureBadge state="simulated" />
      </div>

      <Card data-tour="runs.launcher">
        <CardBody className="stack">
          <p className="muted">
            Passa pela mesma fila das execuções reais, mas quem responde é o provedor simulado: texto fixo, nenhum modelo ou ferramenta é
            executado e nada é gravado no disco.
          </p>
          {agents.state.status === 'loading' && <LoadingState label="Carregando agentes…" />}
          {agents.state.status === 'error' && <ErrorState error={agents.state.error} onRetry={agents.reload} />}
          {agents.state.status === 'ready' && runnable.length === 0 && (
            <EmptyState icon={<Play size={24} />} title="Nenhum agente salvo para simular">
              Crie um agente na tela Agentes para iniciar uma execução simulada.{' '}
              <Button variant="ghost" size="sm" onClick={() => navigate('agents')}>
                Ir para Agentes
              </Button>
            </EmptyState>
          )}
          {agents.state.status === 'ready' && runnable.length > 0 && (
            <div className="form-grid" style={{ alignItems: 'end' }}>
              <Field label="Agente">
                {(id) => (
                  <Select
                    id={id}
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    options={runnable.map((a: AgentRecord) => ({ value: a.definition.id, label: a.definition.name }))}
                  />
                )}
              </Field>
              <Field label="Desfecho simulado">
                {(id) => (
                  <Select
                    id={id}
                    value={scenario}
                    onChange={(e) => setScenario(e.target.value as DemoRunRequest['scenario'])}
                    options={[
                      { value: 'success', label: 'Concluir com sucesso' },
                      { value: 'failure', label: 'Falhar durante a geração' }
                    ]}
                  />
                )}
              </Field>
              <div>
                <Button icon={<Play size={16} />} disabled={busy || !agentId} onClick={() => void start()}>
                  {busy ? 'Iniciando…' : 'Iniciar simulação'}
                </Button>
              </div>
            </div>
          )}
          {actionError && <Notice tone="danger">{actionError.message}</Notice>}
        </CardBody>
      </Card>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Histórico de exemplo (dados demonstrativos da etapa 1)
// ---------------------------------------------------------------------------

type Filter = 'all' | RunState

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Todas' },
  { value: 'running', label: 'Em execução' },
  { value: 'completed', label: 'Concluídas' },
  { value: 'failed', label: 'Falhas' },
  { value: 'pending', label: 'Pendentes' }
]

function ExampleHistory() {
  const [filter, setFilter] = useState<Filter>('all')
  const visible = useMemo(() => exampleRuns.filter((r) => filter === 'all' || legacyRunState[r.status] === filter), [filter])

  return (
    <section className="section" aria-labelledby="example-runs" data-tour="runs.history">
      <div className="section__head">
        <h2 id="example-runs">Histórico de exemplo</h2>
        <div className="row">
          <span className="subtle">Não corresponde a execuções reais nem simuladas</span>
          <FeatureBadge state="example" />
        </div>
      </div>

      <div className="toolbar">
        <Segmented label="Filtrar por status" value={filter} onChange={setFilter} options={filters} />
        <span className="subtle">{visible.length} resultado(s)</span>
      </div>

      <Card>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Agente</th>
                <th>Modelo</th>
                <th>Gatilho</th>
                <th>Início</th>
                <th>Duração</th>
                <th style={{ textAlign: 'right' }}>Tokens</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const meta = runState[legacyRunState[r.status]]
                return (
                  <tr key={r.id}>
                    <td className="mono subtle">{r.id}</td>
                    <td>{agentById[r.agentId]?.name}</td>
                    <td className="muted">{modelById[r.modelId]?.name}</td>
                    <td className="muted">{r.trigger}</td>
                    <td className="muted">{formatDateTime(r.startedAt)}</td>
                    <td className="mono">{formatDuration(r.durationSec)}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {formatNumber(r.tokens)}
                    </td>
                    <td>
                      <StatusBadge tone={meta.tone} pulse={meta.pulse}>
                        {meta.label}
                      </StatusBadge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  )
}

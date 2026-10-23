import { useEffect, useMemo, useState } from 'react'
import { History, Play, Square } from 'lucide-react'
import type { AgentRecord } from '@shared/agents'
import type { StructuredError } from '@shared/errors'
import type { DemoRunRequest, RunRecord, RunState } from '@shared/runs'
import { isTerminalRunState } from '@shared/runs'
import { PageHeader } from '@renderer/components/layout/PageHeader'
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
  ProgressBar,
  Segmented,
  Select,
  StatusBadge
} from '@renderer/components/ui'
import { agentById } from '@renderer/data/agents'
import { modelById } from '@renderer/data/models'
import { runs as exampleRuns } from '@renderer/data/runs'
import { useNavigation } from '@renderer/app/navigation'
import { callApi } from '@renderer/lib/api'
import { formatDateTime, formatDuration, formatNumber } from '@renderer/lib/format'
import { legacyRunState, runDurationSec, upsertRun } from '@renderer/lib/runs'
import { runOrigin, runState } from '@renderer/lib/status'
import { useResource } from '@renderer/lib/use-resource'
import { useSessionRuns } from '@renderer/lib/use-session-runs'

export function RunsPage() {
  return (
    <div className="page">
      <PageHeader title="Execuções" description="Execuções simuladas desta sessão e histórico de exemplo." />
      <FeatureNotice state="simulated">
        Nenhum motor de IA está configurado. As execuções iniciadas aqui não executam modelo nem ferramenta, e não são gravadas no
        disco.
      </FeatureNotice>
      <SimulatedRuns />
      <ExampleHistory />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Execuções simuladas (DemoRunManager no Main)
// ---------------------------------------------------------------------------

function SimulatedRuns() {
  const { navigate } = useNavigation()
  const runs = useSessionRuns()
  const agents = useResource(() => window.gerpro.agents.list())
  const [agentId, setAgentId] = useState('')
  const [scenario, setScenario] = useState<DemoRunRequest['scenario']>('success')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<StructuredError | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { update } = runs

  const runnable = useMemo(
    () => (agents.state.status === 'ready' ? agents.state.data.filter((a) => a.definition.state !== 'archived') : []),
    [agents.state]
  )
  const nameOf = (id: string) =>
    (agents.state.status === 'ready' && agents.state.data.find((a) => a.definition.id === id)?.definition.name) || id

  useEffect(() => {
    if (!runnable.some((a) => a.definition.id === agentId)) setAgentId(runnable[0]?.definition.id ?? '')
  }, [runnable, agentId])

  async function start() {
    setBusy(true)
    setActionError(null)
    const result = await callApi(() => window.gerpro.runs.startDemo({ agentId, scenario }))
    setBusy(false)
    if (result.ok) {
      update((list) => upsertRun(list, result.data))
      setSelectedId(result.data.id)
    } else setActionError(result.error)
  }

  async function cancel(id: string) {
    setActionError(null)
    const result = await callApi(() => window.gerpro.runs.cancel(id))
    if (result.ok) update((list) => upsertRun(list, result.data))
    else setActionError(result.error)
  }

  const selected = runs.state.status === 'ready' ? runs.state.data.find((r) => r.id === selectedId) : undefined

  return (
    <section className="section" aria-labelledby="simulated-runs">
      <div className="section__head">
        <h2 id="simulated-runs">Execuções simuladas desta sessão</h2>
        <div className="row">
          {runs.state.status === 'ready' && <span className="subtle">{runs.state.data.length} execução(ões)</span>}
          <FeatureBadge state="simulated" />
        </div>
      </div>

      <Card>
        <CardBody>
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
                      { value: 'failure', label: 'Falhar em uma etapa' }
                    ]}
                  />
                )}
              </Field>
              <div>
                <Button variant="primary" icon={<Play size={16} />} disabled={busy || !agentId} onClick={() => void start()}>
                  {busy ? 'Iniciando…' : 'Iniciar simulação'}
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {actionError && <Notice tone="danger">{actionError.message}</Notice>}

      {runs.state.status === 'loading' && <LoadingState label="Carregando execuções…" />}
      {runs.state.status === 'error' && <ErrorState error={runs.state.error} onRetry={runs.reload} />}
      {runs.state.status === 'ready' && runs.state.data.length === 0 && (
        <Card>
          <EmptyState icon={<History size={26} />} title="Nenhuma execução nesta sessão">
            Execuções simuladas aparecem aqui e são descartadas ao fechar o aplicativo.
          </EmptyState>
        </Card>
      )}
      {runs.state.status === 'ready' && runs.state.data.length > 0 && (
        <Card>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Agente</th>
                  <th>Tipo</th>
                  <th>Criada</th>
                  <th>Duração</th>
                  <th>Progresso</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.state.data.map((r) => (
                  <SimulatedRunRow
                    key={r.id}
                    run={r}
                    agentName={nameOf(r.agentId)}
                    selected={r.id === selectedId}
                    onSelect={() => setSelectedId(r.id === selectedId ? null : r.id)}
                    onCancel={() => void cancel(r.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {selected && <RunDetails run={selected} agentName={nameOf(selected.agentId)} />}
    </section>
  )
}

function SimulatedRunRow({
  run,
  agentName,
  selected,
  onSelect,
  onCancel
}: {
  run: RunRecord
  agentName: string
  selected: boolean
  onSelect: () => void
  onCancel: () => void
}) {
  const meta = runState[run.state]
  const origin = runOrigin[run.origin]
  const terminal = isTerminalRunState(run.state)
  return (
    <tr aria-selected={selected} onClick={onSelect} style={{ cursor: 'pointer' }} title="Ver detalhes">
      <td className="mono subtle">{run.id}</td>
      <td>{agentName}</td>
      <td>
        <StatusBadge tone={origin.tone}>{origin.label}</StatusBadge>
      </td>
      <td className="muted">{formatDateTime(run.createdAt)}</td>
      <td className="mono">{formatDuration(runDurationSec(run))}</td>
      <td style={{ minWidth: 160 }}>
        <div className="stack" style={{ gap: 4 }}>
          <ProgressBar value={run.progress.percent ?? 0} label={`Progresso de ${run.id}`} />
          <span className="subtle truncate" style={{ fontSize: 'var(--text-xs)' }}>
            {run.error?.message ?? run.progress.step ?? (terminal ? '' : 'Aguardando…')}
          </span>
        </div>
      </td>
      <td>
        <StatusBadge tone={meta.tone} pulse={meta.pulse}>
          {run.cancelRequested && !terminal ? 'Cancelando…' : meta.label}
        </StatusBadge>
      </td>
      <td style={{ textAlign: 'right' }}>
        {!terminal && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Square size={12} />}
            disabled={run.cancelRequested}
            onClick={(e) => {
              e.stopPropagation()
              onCancel()
            }}
          >
            Cancelar
          </Button>
        )}
      </td>
    </tr>
  )
}

function RunDetails({ run, agentName }: { run: RunRecord; agentName: string }) {
  const log = run.messages.map((m) => `${formatDateTime(m.at)}  ${m.level.toUpperCase().padEnd(7)} ${m.text}`).join('\n')
  return (
    <Card>
      <CardHeader title={<span className="mono">{run.id}</span>} subtitle={`${agentName} · execução simulada`} />
      <CardBody className="stack">
        {run.error && (
          <Notice tone="danger">
            <strong>{run.error.code}</strong>: {run.error.message}
          </Notice>
        )}
        <pre className="log" aria-label="Mensagens da execução">
          {log}
        </pre>
      </CardBody>
    </Card>
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
    <section className="section" aria-labelledby="example-runs">
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

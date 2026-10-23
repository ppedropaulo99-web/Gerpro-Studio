import { ArrowRight, Bot, Boxes, History, MessageSquarePlus, Plus, Zap } from 'lucide-react'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  FeatureBadge,
  LoadingState,
  StatusBadge
} from '@renderer/components/ui'
import { useNavigation } from '@renderer/app/navigation'
import { formatDateTime } from '@renderer/lib/format'
import { homeStats } from '@renderer/lib/home'
import type { FeatureState } from '@renderer/lib/status'
import { runState } from '@renderer/lib/status'
import { useGreeting } from '@renderer/lib/use-greeting'
import { useResource } from '@renderer/lib/use-resource'
import { useSessionRuns } from '@renderer/lib/use-session-runs'

export function HomePage() {
  const { navigate } = useNavigation()
  const agents = useResource(() => window.gerpro.agents.list())
  const runs = useSessionRuns()
  // Relido a cada visita ao Início: um nome salvo em Configurações já aparece na volta.
  const settings = useResource(() => window.gerpro.settings.get())
  const title = useGreeting(settings.state.status === 'ready' ? settings.state.data.profile.displayName : undefined)

  // Só dados do Main; enquanto carregam ou se falharem, nada é estimado.
  const stats =
    agents.state.status === 'ready' && runs.state.status === 'ready' ? homeStats(agents.state.data, runs.state.data, new Date()) : null
  const pendingValue = agents.state.status === 'error' || runs.state.status === 'error' ? '—' : '…'
  const nameOf = (id: string) => (agents.state.status === 'ready' && agents.state.data.find((a) => a.definition.id === id)?.definition.name) || id

  const cards: Array<{ label: string; value: string | number; detail: string; state: FeatureState; icon: typeof Bot }> = [
    {
      label: 'Agentes salvos',
      value: stats?.savedAgents ?? pendingValue,
      detail: stats ? `${stats.readyAgents} pronto(s) para uso futuro` : 'Gravados neste computador',
      state: 'real',
      icon: Bot
    },
    {
      label: 'Simulações hoje',
      value: stats?.simulationsToday ?? pendingValue,
      detail: stats?.activeSimulations ? `${stats.activeSimulations} em andamento` : 'Nesta sessão',
      state: 'simulated',
      icon: History
    },
    { label: 'Modelos carregados', value: '—', detail: 'Motor de IA não conectado', state: 'planned', icon: Boxes },
    { label: 'Tokens hoje', value: '—', detail: 'Disponível com o motor de IA', state: 'planned', icon: Zap }
  ]

  return (
    <div className="page">
      <PageHeader
        title={title}
        description="Visão geral do seu espaço de trabalho no Gerpro Studio."
        actions={
          <>
            <Button icon={<MessageSquarePlus size={16} />} onClick={() => navigate('chat')}>
              Novo chat
            </Button>
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('agents')}>
              Criar agente
            </Button>
          </>
        }
      />

      <div className="grid grid--stats" data-tour="home.stats">
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

      <div className="split">
        <Card data-tour="home.recent-runs">
          <CardHeader
            title="Execuções recentes"
            subtitle="Simulações desta sessão"
            actions={
              <div className="row">
                <FeatureBadge state="simulated" />
                <Button variant="ghost" size="sm" onClick={() => navigate('runs')}>
                  Ver todas <ArrowRight size={14} />
                </Button>
              </div>
            }
          />
          <CardBody className="stack" style={{ gap: 0 }}>
            {runs.state.status === 'loading' && <LoadingState label="Carregando execuções…" />}
            {runs.state.status === 'error' && <ErrorState error={runs.state.error} onRetry={runs.reload} />}
            {runs.state.status === 'ready' && runs.state.data.length === 0 && (
              <EmptyState icon={<History size={24} />} title="Nenhuma execução nesta sessão">
                Inicie uma simulação em Execuções. O histórico de exemplo continua disponível lá.
              </EmptyState>
            )}
            {runs.state.status === 'ready' &&
              runs.state.data.slice(0, 5).map((run) => {
                const meta = runState[run.state]
                return (
                  <div key={run.id} className="list-row">
                    <div className="stack" style={{ gap: 0, minWidth: 0 }}>
                      <span>{nameOf(run.agentId)}</span>
                      <span className="subtle">Execução simulada · {formatDateTime(run.createdAt)}</span>
                    </div>
                    <StatusBadge tone={meta.tone} pulse={meta.pulse}>
                      {meta.label}
                    </StatusBadge>
                  </div>
                )
              })}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Modelos" subtitle="Inferência local" actions={<FeatureBadge state="planned" />} />
          <CardBody className="stack">
            <p className="muted">
              Nenhum modelo está carregado: o motor de IA ainda não está conectado. A biblioteca mostra modelos de exemplo.
            </p>
            <Button variant="secondary" onClick={() => navigate('models')}>
              Abrir biblioteca de exemplos
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

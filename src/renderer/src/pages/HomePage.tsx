import { ArrowRight, Bot, Boxes, History, MessageSquarePlus, Plus, Zap } from 'lucide-react'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { Button, Card, CardBody, CardHeader, Notice, StatusBadge } from '@renderer/components/ui'
import { useNavigation } from '@renderer/app/navigation'
import { agents, agentById } from '@renderer/data/agents'
import { models, modelById } from '@renderer/data/models'
import { runs } from '@renderer/data/runs'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import { legacyRunState } from '@renderer/lib/runs'
import { runState } from '@renderer/lib/status'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Bom dia'
  if (h < 18) return 'Boa tarde'
  return 'Boa noite'
}

export function HomePage() {
  const { navigate } = useNavigation()
  const loaded = models.filter((m) => m.status === 'loaded')
  const tokensToday = runs.filter((r) => r.startedAt.startsWith('2026-10-23')).reduce((n, r) => n + r.tokens, 0)

  const stats = [
    { label: 'Agentes ativos', value: agents.filter((a) => a.status === 'active').length, total: agents.length, icon: Bot },
    { label: 'Modelos carregados', value: loaded.length, total: models.length, icon: Boxes },
    { label: 'Execuções hoje', value: runs.filter((r) => r.startedAt.startsWith('2026-10-23')).length, icon: History },
    { label: 'Tokens hoje', value: formatNumber(tokensToday), icon: Zap }
  ]

  return (
    <div className="page">
      <PageHeader
        title={greeting()}
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

      <Notice>
        Protótipo visual: todos os dados exibidos são simulados. O motor de IA ainda não está conectado.
      </Notice>

      <div className="grid grid--stats">
        {stats.map(({ label, value, total, icon: Icon }) => (
          <Card key={label}>
            <CardBody className="stat">
              <div className="stat__icon">
                <Icon size={18} />
              </div>
              <div>
                <div className="stat__value">
                  {value}
                  {total !== undefined && <span className="subtle"> / {total}</span>}
                </div>
                <div className="subtle">{label}</div>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <div className="split">
        <Card>
          <CardHeader
            title="Execuções recentes"
            subtitle="Últimas atividades dos agentes"
            actions={
              <Button variant="ghost" size="sm" onClick={() => navigate('runs')}>
                Ver todas <ArrowRight size={14} />
              </Button>
            }
          />
          <CardBody className="stack" style={{ gap: 0 }}>
            {runs.slice(0, 5).map((run) => {
              const meta = runState[legacyRunState[run.status]]
              return (
                <div key={run.id} className="list-row">
                  <div className="stack" style={{ gap: 0, minWidth: 0 }}>
                    <span>{agentById[run.agentId]?.name}</span>
                    <span className="subtle">
                      {modelById[run.modelId]?.name} · {formatDateTime(run.startedAt)}
                    </span>
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
          <CardHeader title="Modelos em memória" subtitle="Prontos para uso" />
          <CardBody className="stack">
            {loaded.map((m) => (
              <div key={m.id} className="list-row">
                <div className="stack" style={{ gap: 0 }}>
                  <span>{m.name}</span>
                  <span className="subtle mono">
                    {m.parameters} · {m.quantization} · {m.sizeGb} GB
                  </span>
                </div>
                <StatusBadge tone="success">Carregado</StatusBadge>
              </div>
            ))}
            <Button variant="secondary" onClick={() => navigate('models')}>
              Abrir biblioteca de modelos
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { Cpu, FlaskConical, Settings } from 'lucide-react'
import type { AgentRecord } from '@shared/agents'
import type { HardwareAdvisorState } from '@shared/hardware'
import { recommendAgents, TASK_LABELS, TASK_TYPES, type TaskType } from '@shared/recommendations'
import type { ToolCatalogEntry } from '@shared/tools'
import { useNavigation } from '@renderer/app/navigation'
import { ReasonList } from '@renderer/components/hardware/ReasonList'
import { Button, Card, CardBody, EmptyState, ErrorState, FeatureBadge, LoadingState, Notice, Segmented, StatusBadge, Tag } from '@renderer/components/ui'
import { exampleAgentProfiles } from '@renderer/data/agent-requirements'
import { agents as exampleAgents } from '@renderer/data/agents'
import { models } from '@renderer/data/models'
import { advisorHardware, buildCandidates, recommendationConclusion } from '@renderer/lib/advisor'
import { summarizeEngine } from '@renderer/lib/engine'
import { recommendationFit } from '@renderer/lib/status'
import { useResource } from '@renderer/lib/use-resource'

type TaskFilter = 'any' | TaskType

const taskOptions: Array<{ value: TaskFilter; label: string }> = [
  { value: 'any', label: 'Qualquer tarefa' },
  ...TASK_TYPES.map((t) => ({ value: t, label: TASK_LABELS[t].charAt(0).toUpperCase() + TASK_LABELS[t].slice(1) }))
]

interface Props {
  saved: AgentRecord[]
  tools: ToolCatalogEntry[]
}

/**
 * Recomendações do Hardware Advisor na Biblioteca de Agentes. O cálculo é
 * feito por `recommendAgents` (@shared), sem lógica de negócio aqui.
 */
export function AgentRecommendations({ saved, tools }: Props) {
  const { navigate } = useNavigation()
  const hardware = useResource(() => window.gerpro.hardware.getState())
  const [task, setTask] = useState<TaskFilter>('any')

  return (
    <section className="section" aria-labelledby="advisor-recs">
      <div className="section__head">
        <h2 id="advisor-recs" className="row">
          <Cpu size={17} className="subtle" />
          Recomendações do Hardware Advisor
        </h2>
        <FeatureBadge state="simulated">Demonstração</FeatureBadge>
      </div>

      {hardware.state.status === 'loading' && <LoadingState label="Carregando perfil de hardware…" />}
      {hardware.state.status === 'error' && <ErrorState error={hardware.state.error} onRetry={hardware.reload} />}
      {hardware.state.status === 'ready' && (
        <Body state={hardware.state.data} saved={saved} tools={tools} task={task} onTask={setTask} onOpenSettings={() => navigate('settings')} />
      )}
    </section>
  )
}

function Body({
  state,
  saved,
  tools,
  task,
  onTask,
  onOpenSettings
}: Props & { state: HardwareAdvisorState; task: TaskFilter; onTask: (t: TaskFilter) => void; onOpenSettings: () => void }) {
  const { profile, note } = advisorHardware(state)
  // Motor real conectado (provedor pronto). Não torna nada executável aqui:
  // as recomendações usam a biblioteca de exemplo, cujos modelos nunca estão instalados.
  const providers = useResource(() => window.gerpro.providers.list())
  const engineAvailable = providers.state.status === 'ready' && summarizeEngine(providers.state.data).connected
  const candidates = useMemo(() => buildCandidates(saved, exampleAgents, models, exampleAgentProfiles), [saved])
  const recs = useMemo(
    () => recommendAgents(candidates, { hardware: profile, hardwareNote: note, task, tools, engineAvailable }),
    [candidates, profile, note, task, tools, engineAvailable]
  )
  const byKey = new Map(candidates.map((c) => [`${c.origin}:${c.agentId}`, c]))

  return (
    <>
      {profile ? (
        profile.provenance.source === 'demo' && (
          <Notice tone="warning" icon={<FlaskConical size={16} />}>
            Recomendações calculadas sobre um <strong>perfil de hardware fictício</strong> (demonstração), não sobre este computador.
            {state.status === 'stale' && ' O perfil também está desatualizado.'}
          </Notice>
        )
      ) : (
        <Notice tone="neutral">
          <div className="row between" style={{ flexWrap: 'wrap' }}>
            <span>{note} Autorize e execute uma análise em Configurações › Hardware e desempenho.</span>
            <Button size="sm" variant="ghost" icon={<Settings size={13} />} onClick={onOpenSettings}>
              Abrir Configurações
            </Button>
          </div>
        </Notice>
      )}
      <Notice tone="neutral">
        As recomendações usam a biblioteca de modelos de exemplo e o perfil de hardware: são estimativas, não confirmadas em execução. Para
        usar um agente com um modelo instalado neste computador, envie uma mensagem em Conversas.
      </Notice>

      <div className="toolbar">
        <Segmented label="Tipo de tarefa" value={task} onChange={onTask} options={taskOptions} />
      </div>

      {recs.length === 0 ? (
        <EmptyState title="Nenhum agente para avaliar" />
      ) : (
        <Card>
          <CardBody className="stack" style={{ gap: 0 }}>
            {recs.map((rec, i) => {
              const candidate = byKey.get(`${rec.origin}:${rec.agentId}`)
              const meta = recommendationFit[rec.fit]
              const conclusion = recommendationConclusion(rec)
              return (
                <div
                  key={`${rec.origin}:${rec.agentId}`}
                  className="list-row"
                  style={{ alignItems: 'flex-start' }}
                  data-tour={i === 0 ? 'agents.recommendations' : undefined}
                >
                  <div className="stack" style={{ gap: 'var(--space-2)', minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <strong>{candidate?.name ?? rec.agentId}</strong>
                      <Tag>{rec.origin === 'saved' ? 'Meu agente' : 'Exemplo'}</Tag>
                      {rec.taskMatch === 'match' && <Tag>Indicado para a tarefa</Tag>}
                      {rec.taskMatch === 'mismatch' && <Tag>Outra especialidade</Tag>}
                      {rec.requirements && <Tag>{rec.requirements.source === 'declared' ? 'Requisitos declarados' : 'Requisitos estimados'}</Tag>}
                    </div>
                    <span>{conclusion.headline}</span>
                    <span className="subtle">Sugestão: {conclusion.action}</span>
                    <details className="disclosure">
                      <summary>Ver detalhes técnicos</summary>
                      <ReasonList reasons={rec.reasons} />
                    </details>
                  </div>
                  <div className="stack" style={{ gap: 'var(--space-1)', alignItems: 'flex-end', flex: 'none' }}>
                    <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                    {rec.origin === 'example' && !rec.executableNow && <span className="field__hint">Ainda não executável</span>}
                  </div>
                </div>
              )
            })}
          </CardBody>
        </Card>
      )}
    </>
  )
}

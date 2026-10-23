import { useMemo, useState } from 'react'
import { Archive, ArchiveRestore, Bot, Copy, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import type { AgentDefinition, AgentDraft, AgentRecord } from '@shared/agents'
import type { StructuredError } from '@shared/errors'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { AgentEditor } from '@renderer/components/agents/AgentEditor'
import { AgentRecommendations } from '@renderer/components/hardware/AgentRecommendations'
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  ErrorState,
  FeatureBadge,
  FeatureNotice,
  LoadingState,
  Menu,
  Notice,
  SearchInput,
  Segmented,
  StatusBadge,
  Tag
} from '@renderer/components/ui'
import { agents as exampleAgents } from '@renderer/data/agents'
import { modelById } from '@renderer/data/models'
import { toolById } from '@renderer/data/tools'
import type { AgentCategory } from '@renderer/data/types'
import { emptyAgentForm, formFromDefinition, formFromExample, type AgentFormValues } from '@renderer/lib/agent-form'
import { callApi } from '@renderer/lib/api'
import { agentAvailability, agentConfigState } from '@renderer/lib/status'
import { useResource } from '@renderer/lib/use-resource'

type Filter = 'all' | AgentCategory

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'Produtividade', label: 'Produtividade' },
  { value: 'Desenvolvimento', label: 'Desenvolvimento' },
  { value: 'Pesquisa', label: 'Pesquisa' },
  { value: 'Dados', label: 'Dados' },
  { value: 'Atendimento', label: 'Atendimento' }
]

type Editing = { mode: 'create' | 'edit'; initial: AgentFormValues }

function toDraft({ createdAt: _c, updatedAt: _u, ...draft }: AgentDefinition): AgentDraft {
  return draft
}

const sortByName = (list: AgentRecord[]) => [...list].sort((a, b) => a.definition.name.localeCompare(b.definition.name, 'pt-BR'))

export function AgentsPage() {
  const saved = useResource(() => window.gerpro.agents.list())
  const tools = useResource(() => window.gerpro.tools.list())
  const [editing, setEditing] = useState<Editing | null>(null)
  const [actionError, setActionError] = useState<StructuredError | null>(null)

  const takenIds = useMemo(
    () => new Set(saved.state.status === 'ready' ? saved.state.data.map((a) => a.definition.id) : []),
    [saved.state]
  )
  const toolName = (id: string) =>
    (tools.state.status === 'ready' && tools.state.data.find((t) => t.definition.id === id)?.definition.name) || id

  function upsert(record: AgentRecord) {
    saved.update((list) => sortByName([...list.filter((a) => a.definition.id !== record.definition.id), record]))
  }

  async function changeState(def: AgentDefinition, state: AgentDefinition['state']) {
    setActionError(null)
    const result = await callApi(() => window.gerpro.agents.update({ ...toDraft(def), state }))
    if (result.ok) upsert(result.data)
    else setActionError(result.error)
  }

  async function remove(def: AgentDefinition) {
    if (!window.confirm(`Excluir o agente "${def.name}"? Esta ação não pode ser desfeita.`)) return
    setActionError(null)
    const result = await callApi(() => window.gerpro.agents.remove(def.id))
    if (result.ok) saved.update((list) => list.filter((a) => a.definition.id !== def.id))
    else setActionError(result.error)
  }

  if (editing) {
    return (
      <div className="page">
        <PageHeader
          title={editing.mode === 'create' ? 'Novo agente' : 'Editar agente'}
          description="A definição é gravada neste computador. A execução real não está habilitada."
        />
        <AgentEditor
          mode={editing.mode}
          initial={editing.initial}
          tools={tools.state}
          onRetryTools={tools.reload}
          takenIds={takenIds}
          onCancel={() => setEditing(null)}
          onSaved={(record) => {
            upsert(record)
            setEditing(null)
          }}
        />
      </div>
    )
  }

  return (
    <div className="page">
      <PageHeader
        title="Agentes"
        description="Catálogo de agentes configurados com modelo, instruções e ferramentas."
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            disabled={saved.state.status !== 'ready'}
            onClick={() => setEditing({ mode: 'create', initial: emptyAgentForm() })}
          >
            Novo agente
          </Button>
        }
      />

      <FeatureNotice state="planned">
        A execução de agentes depende do motor de IA, ainda não conectado. Os agentes salvos são reais e ficam gravados neste
        computador, mas aparecem como indisponíveis.
      </FeatureNotice>

      <section className="section" aria-labelledby="saved-agents">
        <div className="section__head">
          <h2 id="saved-agents">Meus agentes</h2>
          <div className="row">
            {saved.state.status === 'ready' && <span className="subtle">{saved.state.data.length} salvo(s)</span>}
            <FeatureBadge state="real" />
          </div>
        </div>

        {actionError && (
          <Notice tone="danger">
            {actionError.message}
          </Notice>
        )}

        {saved.state.status === 'loading' && <LoadingState label="Carregando agentes…" />}
        {saved.state.status === 'error' && <ErrorState error={saved.state.error} onRetry={saved.reload} />}
        {saved.state.status === 'ready' && saved.state.data.length === 0 && (
          <Card>
            <EmptyState icon={<Bot size={28} />} title="Nenhum agente salvo">
              Crie um agente do zero ou duplique um dos exemplos abaixo.
            </EmptyState>
          </Card>
        )}
        {saved.state.status === 'ready' && saved.state.data.length > 0 && (
          <div className="grid">
            {saved.state.data.map(({ definition: def, availability }) => {
              const meta = agentAvailability[availability.status]
              const archived = def.state === 'archived'
              return (
                <Card key={def.id}>
                  <CardHeader
                    title={
                      <span className="row">
                        <span className="avatar" aria-hidden>
                          {def.name.charAt(0)}
                        </span>
                        {def.name}
                      </span>
                    }
                    subtitle={<span className="mono">{`${def.id} · v${def.version}`}</span>}
                    actions={
                      <Menu
                        label={`Ações de ${def.name}`}
                        items={[
                          {
                            label: 'Editar',
                            icon: <Pencil size={14} />,
                            onSelect: () => setEditing({ mode: 'edit', initial: formFromDefinition(def) })
                          },
                          archived
                            ? { label: 'Restaurar', icon: <ArchiveRestore size={14} />, onSelect: () => void changeState(def, 'draft') }
                            : { label: 'Arquivar', icon: <Archive size={14} />, onSelect: () => void changeState(def, 'archived') },
                          'separator',
                          { label: 'Excluir', icon: <Trash2 size={14} />, danger: true, onSelect: () => void remove(def) }
                        ]}
                      />
                    }
                  />
                  <CardBody className="stack">
                    <p className="muted">{def.description || 'Sem descrição.'}</p>
                    <div className="tag-list">
                      <Tag>{agentConfigState[def.state]}</Tag>
                      {def.tools.map((t) => (
                        <Tag key={t}>{toolName(t)}</Tag>
                      ))}
                    </div>
                    {availability.issues.length > 0 && (
                      <ul className="subtle" style={{ margin: 0, paddingLeft: 'var(--space-4)', fontSize: 'var(--text-xs)' }}>
                        {availability.issues.map((issue, i) => (
                          <li key={`${issue.code}-${issue.toolId ?? ''}-${i}`}>{issue.message}</li>
                        ))}
                      </ul>
                    )}
                  </CardBody>
                  <CardFooter>
                    <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                    <span className="subtle mono truncate" title="Modelo">
                      {def.model?.modelId ?? 'Sem modelo'}
                    </span>
                    <Button size="sm" icon={<Play size={13} />} disabled title="Execução real desabilitada: nenhum motor de IA configurado">
                      Executar
                    </Button>
                  </CardFooter>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {saved.state.status === 'ready' && tools.state.status === 'ready' && (
        <AgentRecommendations saved={saved.state.data} tools={tools.state.data} />
      )}

      <ExampleAgents
        canDuplicate={saved.state.status === 'ready' && tools.state.status === 'ready'}
        onDuplicate={(example) =>
          tools.state.status === 'ready' &&
          setEditing({ mode: 'create', initial: formFromExample(example, takenIds, tools.state.data) })
        }
      />
    </div>
  )
}

/** Biblioteca demonstrativa da etapa 1, preservada e identificada como exemplo. */
function ExampleAgents({
  canDuplicate,
  onDuplicate
}: {
  canDuplicate: boolean
  onDuplicate: (example: (typeof exampleAgents)[number]) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return exampleAgents.filter(
      (a) =>
        (filter === 'all' || a.category === filter) &&
        (!q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
    )
  }, [query, filter])

  return (
    <section className="section" aria-labelledby="example-agents">
      <div className="section__head">
        <h2 id="example-agents">Exemplos</h2>
        <div className="row">
          <span className="subtle">Não são agentes salvos</span>
          <FeatureBadge state="example" />
        </div>
      </div>

      <div className="toolbar">
        <SearchInput label="Buscar exemplos" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented label="Filtrar por categoria" value={filter} onChange={setFilter} options={filters} />
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={<Bot size={28} />} title="Nenhum exemplo encontrado">
          Ajuste a busca ou o filtro de categoria.
        </EmptyState>
      ) : (
        <div className="grid">
          {visible.map((agent) => {
            return (
              <Card key={agent.id}>
                <CardHeader
                  title={
                    <span className="row">
                      <span className="avatar" aria-hidden>
                        {agent.name.charAt(0)}
                      </span>
                      {agent.name}
                    </span>
                  }
                  subtitle="Exemplo"
                  actions={
                    <Menu
                      label={`Ações de ${agent.name}`}
                      items={[
                        {
                          label: 'Duplicar como novo agente',
                          icon: <Copy size={14} />,
                          disabled: !canDuplicate,
                          onSelect: () => onDuplicate(agent)
                        }
                      ]}
                    />
                  }
                />
                <CardBody className="stack">
                  <p className="muted">{agent.description}</p>
                  <div className="tag-list">
                    <Tag>{agent.category}</Tag>
                    {agent.tools.map((t) => (
                      <Tag key={t}>{toolById[t]?.name ?? t}</Tag>
                    ))}
                  </div>
                </CardBody>
                <CardFooter>
                  <FeatureBadge state="example" />
                  <span className="subtle mono truncate" title="Modelo sugerido (biblioteca de exemplo)">
                    {modelById[agent.modelId]?.name}
                  </span>
                  <Button size="sm" icon={<Play size={13} />} disabled title="Exemplo demonstrativo: não executável">
                    Executar
                  </Button>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      )}
    </section>
  )
}

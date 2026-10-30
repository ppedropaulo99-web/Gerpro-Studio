import { useMemo, useState } from 'react'
import { AlertTriangle, Archive, ArchiveRestore, Bot, Copy, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
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
import { agentActionMessage, emptyAgentForm, formFromDefinition, formFromExample, type AgentFormValues } from '@renderer/lib/agent-form'
import { AGENT_STORAGE_LOCKED, agentsInventoryNotice, agentStatus, agentStorageNotice } from '@renderer/lib/agent-status'
import { useNavigation } from '@renderer/app/navigation'
import { callApi } from '@renderer/lib/api'
import { requestRunFor } from '@renderer/lib/run-intent'
import { agentConfigState } from '@renderer/lib/status'
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
  const { navigate } = useNavigation()
  const saved = useResource(() => window.gerpro.agents.list())
  const tools = useResource(() => window.gerpro.tools.list())
  const providers = useResource(() => window.gerpro.providers.list())
  const storage = useResource(() => window.gerpro.agents.storageStatus())
  // Aqui é só orientação: quem recusa a gravação é o Main.
  const storageNotice = storage.state.status === 'ready' ? agentStorageNotice(storage.state.data) : null
  const locked = storageNotice !== null
  const inventoryNotice = agentsInventoryNotice(providers.state)
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
          description="A definição é gravada neste computador. O agente conversa com modelos instalados em Conversas; a execução de ferramentas ainda não está disponível."
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
            disabled={saved.state.status !== 'ready' || locked}
            title={locked ? AGENT_STORAGE_LOCKED : undefined}
            onClick={() => setEditing({ mode: 'create', initial: emptyAgentForm() })}
          >
            Novo agente
          </Button>
        }
      />

      {storageNotice && (
        <Notice tone="warning" icon={<AlertTriangle size={16} />}>
          {storageNotice}
        </Notice>
      )}

      <FeatureNotice state="real">
        Os agentes salvos são reais e ficam gravados neste computador. "Executar" abre Conversas com o agente escolhido, para enviar uma
        mensagem a um modelo instalado; ferramentas e execução autônoma de agentes ainda estão em desenvolvimento.
      </FeatureNotice>

      <section className="section" aria-labelledby="saved-agents" data-tour="agents.saved">
        <div className="section__head">
          <h2 id="saved-agents">Meus agentes</h2>
          <div className="row">
            {saved.state.status === 'ready' && <span className="subtle">{saved.state.data.length} salvo(s)</span>}
            <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} disabled={providers.state.status === 'loading'} onClick={providers.reload}>
              Atualizar lista
            </Button>
            <FeatureBadge state="real" />
          </div>
        </div>

        {saved.state.status === 'ready' && saved.state.data.length > 0 && inventoryNotice && <Notice tone={inventoryNotice.tone}>{inventoryNotice.text}</Notice>}

        {actionError && (
          <Notice tone="danger">
            {agentActionMessage(actionError)}
          </Notice>
        )}

        {saved.state.status === 'loading' && <LoadingState label="Carregando agentes…" />}
        {saved.state.status === 'error' && <ErrorState error={saved.state.error} onRetry={saved.reload} />}
        {saved.state.status === 'ready' && saved.state.data.length === 0 && (
          <Card>
            <EmptyState icon={<Bot size={28} />} title={locked ? 'Nenhum agente disponível' : 'Nenhum agente salvo'}>
              {locked ? 'Os agentes não puderam ser carregados. Veja o aviso no início da página.' : 'Crie um agente do zero ou duplique um dos exemplos abaixo.'}
            </EmptyState>
          </Card>
        )}
        {saved.state.status === 'ready' && saved.state.data.length > 0 && (
          <div className="grid">
            {saved.state.data.map((record) => {
              const def = record.definition
              const status = agentStatus(record, providers.state)
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
                            disabled: locked,
                            onSelect: () => setEditing({ mode: 'edit', initial: formFromDefinition(def) })
                          },
                          archived
                            ? { label: 'Restaurar', icon: <ArchiveRestore size={14} />, disabled: locked, onSelect: () => void changeState(def, 'draft') }
                            : { label: 'Arquivar', icon: <Archive size={14} />, disabled: locked, onSelect: () => void changeState(def, 'archived') },
                          'separator',
                          { label: 'Excluir', icon: <Trash2 size={14} />, danger: true, disabled: locked, onSelect: () => void remove(def) }
                        ]}
                      />
                    }
                  />
                  <CardBody className="stack">
                    <p className="muted">{def.description || 'Sem descrição.'}</p>
                    <div className="tag-list">
                      <Tag>Estado: {agentConfigState[def.state]}</Tag>
                      {def.tools.map((t) => (
                        <Tag key={t}>{toolName(t)}</Tag>
                      ))}
                    </div>
                    {status.notes.length > 0 && (
                      <ul className="subtle" style={{ margin: 0, paddingLeft: 'var(--space-4)', fontSize: 'var(--text-xs)' }}>
                        {status.notes.map((note, i) => (
                          <li key={`${note.kind}-${i}`}>{note.text}</li>
                        ))}
                      </ul>
                    )}
                  </CardBody>
                  <CardFooter>
                    <StatusBadge tone={status.badge.tone}>{status.badge.label}</StatusBadge>
                    <span className="subtle mono truncate" title="Modelo">
                      {def.defaultModel?.modelId ?? 'Sem modelo'}
                    </span>
                    <Button
                      size="sm"
                      icon={<Play size={13} />}
                      disabled={!status.canOpen}
                      title={status.actionTitle}
                      onClick={() => {
                        requestRunFor(def.id)
                        navigate('conversations')
                      }}
                    >
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
        canDuplicate={saved.state.status === 'ready' && tools.state.status === 'ready' && !locked}
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
          {visible.map((agent, i) => {
            return (
              <Card key={agent.id} data-tour={i === 0 ? 'agents.examples' : undefined}>
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

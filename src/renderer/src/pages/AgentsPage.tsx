import { useMemo, useState } from 'react'
import { Archive, Bot, Copy, Pencil, Play, Plus } from 'lucide-react'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  Menu,
  SearchInput,
  Segmented,
  StatusBadge,
  Tag
} from '@renderer/components/ui'
import { agents } from '@renderer/data/agents'
import { modelById } from '@renderer/data/models'
import { toolById } from '@renderer/data/tools'
import type { AgentCategory } from '@renderer/data/types'
import { agentStatus } from '@renderer/lib/status'

type Filter = 'all' | AgentCategory

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'Produtividade', label: 'Produtividade' },
  { value: 'Desenvolvimento', label: 'Desenvolvimento' },
  { value: 'Pesquisa', label: 'Pesquisa' },
  { value: 'Dados', label: 'Dados' },
  { value: 'Atendimento', label: 'Atendimento' }
]

export function AgentsPage() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return agents.filter(
      (a) =>
        (filter === 'all' || a.category === filter) &&
        (!q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
    )
  }, [query, filter])

  return (
    <div className="page">
      <PageHeader
        title="Agentes"
        description="Catálogo de agentes configurados com modelo, instruções e ferramentas."
        actions={
          <Button variant="primary" icon={<Plus size={16} />} disabled title="Disponível em uma próxima etapa">
            Novo agente
          </Button>
        }
      />

      <div className="toolbar">
        <SearchInput label="Buscar agentes" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented label="Filtrar por categoria" value={filter} onChange={setFilter} options={filters} />
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={<Bot size={28} />} title="Nenhum agente encontrado">
          Ajuste a busca ou o filtro de categoria.
        </EmptyState>
      ) : (
        <div className="grid">
          {visible.map((agent) => {
            const meta = agentStatus[agent.status]
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
                  actions={
                    <Menu
                      label={`Ações de ${agent.name}`}
                      items={[
                        { label: 'Editar', icon: <Pencil size={14} />, disabled: true },
                        { label: 'Duplicar', icon: <Copy size={14} />, disabled: true },
                        'separator',
                        { label: 'Arquivar', icon: <Archive size={14} />, danger: true, disabled: true }
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
                  <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                  <span className="subtle mono truncate" title="Modelo padrão">
                    {modelById[agent.modelId]?.name}
                  </span>
                  <Button size="sm" icon={<Play size={13} />} disabled title="Motor de IA não conectado">
                    Executar
                  </Button>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

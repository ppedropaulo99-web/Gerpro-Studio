import { useMemo, useState } from 'react'
import { Download, FolderOpen, HardDrive, Power, Trash2 } from 'lucide-react'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Menu,
  ProgressBar,
  SearchInput,
  Segmented,
  StatusBadge,
  Tag
} from '@renderer/components/ui'
import { models } from '@renderer/data/models'
import type { LibraryModel } from '@renderer/data/types'
import { capabilityLabel, formatContext } from '@renderer/lib/format'
import { modelStatus } from '@renderer/lib/status'

type Filter = 'all' | 'chat' | 'vision' | 'reasoning' | 'embedding'

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'chat', label: 'Chat' },
  { value: 'reasoning', label: 'Raciocínio' },
  { value: 'vision', label: 'Visão' },
  { value: 'embedding', label: 'Embedding' }
]

export function ModelsPage() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedId, setSelectedId] = useState(models[0].id)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models.filter(
      (m) =>
        (filter === 'all' || m.capabilities.includes(filter)) &&
        (!q || m.name.toLowerCase().includes(q) || m.publisher.toLowerCase().includes(q))
    )
  }, [query, filter])

  const selected = models.find((m) => m.id === selectedId) ?? models[0]
  const totalGb = models.reduce((n, m) => n + m.sizeGb, 0)

  return (
    <div className="page">
      <PageHeader
        title="Modelos"
        description={`${models.length} modelos na biblioteca local · ${totalGb.toFixed(1)} GB em disco (simulado)`}
        actions={
          <>
            <Button icon={<FolderOpen size={16} />} disabled>
              Pasta de modelos
            </Button>
            <Button variant="primary" icon={<Download size={16} />} disabled title="Disponível em uma próxima etapa">
              Descobrir modelos
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <SearchInput label="Buscar por nome ou publicador" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented label="Filtrar por capacidade" value={filter} onChange={setFilter} options={filters} />
      </div>

      <div className="split">
        <div className="stack">
          {visible.map((m) => (
            <ModelRow key={m.id} model={m} selected={m.id === selectedId} onSelect={() => setSelectedId(m.id)} />
          ))}
          {visible.length === 0 && <p className="muted">Nenhum modelo corresponde ao filtro.</p>}
        </div>
        <ModelDetail model={selected} />
      </div>
    </div>
  )
}

function ModelRow({ model, selected, onSelect }: { model: LibraryModel; selected: boolean; onSelect: () => void }) {
  const meta = modelStatus[model.status]
  return (
    <Card
      interactive
      selected={selected}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}
    >
      <CardBody className="model-row">
        <div className="model-row__icon" aria-hidden>
          <HardDrive size={18} />
        </div>
        <div className="stack" style={{ gap: 4, minWidth: 0, flex: 1 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <h3>{model.name}</h3>
            <span className="subtle">{model.publisher}</span>
          </div>
          <div className="tag-list">
            <Tag>{model.parameters}</Tag>
            <Tag>{model.quantization}</Tag>
            <Tag>{model.format.toUpperCase()}</Tag>
            {model.capabilities.map((c) => (
              <Tag key={c}>{capabilityLabel[c]}</Tag>
            ))}
          </div>
          {model.status === 'downloading' && (
            <div className="row">
              <div style={{ flex: 1 }}>
                <ProgressBar value={model.downloadProgress ?? 0} label={`Download de ${model.name}`} />
              </div>
              <span className="subtle mono">{model.downloadProgress}%</span>
            </div>
          )}
        </div>
        <div className="stack" style={{ alignItems: 'flex-end', gap: 6 }}>
          <StatusBadge tone={meta.tone} pulse={meta.pulse}>
            {meta.label}
          </StatusBadge>
          <span className="subtle mono">{model.sizeGb} GB</span>
        </div>
        <Menu
          label={`Ações de ${model.name}`}
          items={[
            { label: model.status === 'loaded' ? 'Descarregar' : 'Carregar', icon: <Power size={14} />, disabled: true },
            { label: 'Mostrar no explorador', icon: <FolderOpen size={14} />, disabled: true },
            'separator',
            { label: 'Excluir do disco', icon: <Trash2 size={14} />, danger: true, disabled: true }
          ]}
        />
      </CardBody>
    </Card>
  )
}

function ModelDetail({ model }: { model: LibraryModel }) {
  const meta = modelStatus[model.status]
  const specs: Array<[string, string]> = [
    ['Publicador', model.publisher],
    ['Parâmetros', model.parameters],
    ['Quantização', model.quantization],
    ['Formato', model.format.toUpperCase()],
    ['Contexto máximo', `${formatContext(model.contextLength)} tokens`],
    ['Tamanho', `${model.sizeGb} GB`]
  ]

  return (
    <Card className="sticky">
      <CardHeader
        title={model.name}
        subtitle={model.id}
        actions={
          <StatusBadge tone={meta.tone} pulse={meta.pulse}>
            {meta.label}
          </StatusBadge>
        }
      />
      <CardBody className="stack">
        <p className="muted">{model.description}</p>
        <dl className="specs">
          {specs.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <Button variant="primary" icon={<Power size={16} />} disabled title="Motor de IA não conectado">
          {model.status === 'loaded' ? 'Descarregar modelo' : 'Carregar modelo'}
        </Button>
      </CardBody>
    </Card>
  )
}

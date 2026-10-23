import { useMemo, useState } from 'react'
import { Download, FolderOpen, HardDrive } from 'lucide-react'
import type { ModelSource } from '@shared/recommendations'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FeatureBadge,
  FeatureNotice,
  ProgressBar,
  SearchInput,
  Segmented,
  StatusBadge,
  Tag
} from '@renderer/components/ui'
import { models } from '@renderer/data/models'
import type { LibraryModel } from '@renderer/data/types'
import { capabilityLabel, formatContext, formatGb } from '@renderer/lib/format'
import { displayedModelStatus } from '@renderer/lib/status'

type Filter = 'all' | 'chat' | 'vision' | 'reasoning' | 'embedding'

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'chat', label: 'Chat' },
  { value: 'reasoning', label: 'Raciocínio' },
  { value: 'vision', label: 'Visão' },
  { value: 'embedding', label: 'Embedding' }
]

/** Toda a biblioteca atual é fictícia. Um provedor local futuro listará modelos com `source: 'local-provider'`. */
const LIBRARY_SOURCE: ModelSource = 'example'

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

  return (
    <div className="page">
      <PageHeader
        title="Modelos"
        description={`Biblioteca de exemplo com ${models.length} modelos · nenhum modelo instalado ou carregado`}
        actions={
          <>
            <Button icon={<FolderOpen size={16} />} disabled title="Planejado: depende do provedor local de modelos">
              Pasta de modelos
            </Button>
            <Button variant="primary" icon={<Download size={16} />} disabled title="Planejado: depende do provedor local de modelos">
              Descobrir modelos
            </Button>
          </>
        }
      />

      <FeatureNotice state="example">
        Estes modelos ilustram a biblioteca: não estão neste computador e não podem ser carregados. Carregar, baixar e gerenciar
        modelos depende do motor de IA, ainda planejado.
      </FeatureNotice>

      <div className="toolbar">
        <SearchInput label="Buscar por nome ou publicador" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented label="Filtrar por capacidade" value={filter} onChange={setFilter} options={filters} />
      </div>

      <div className="split">
        <div className="stack">
          {visible.map((m, i) => (
            <ModelRow
              key={m.id}
              tour={i === 0 ? 'models.library' : undefined}
              model={m}
              source={LIBRARY_SOURCE}
              selected={m.id === selectedId}
              onSelect={() => setSelectedId(m.id)}
            />
          ))}
          {visible.length === 0 && <p className="muted">Nenhum modelo corresponde ao filtro.</p>}
        </div>
        <ModelDetail model={selected} source={LIBRARY_SOURCE} />
      </div>
    </div>
  )
}

function ModelStateBadge({ source, model }: { source: ModelSource; model: LibraryModel }) {
  const meta = displayedModelStatus(source, model.status)
  if (!meta) return <FeatureBadge state="example" />
  return (
    <StatusBadge tone={meta.tone} pulse={meta.pulse}>
      {meta.label}
    </StatusBadge>
  )
}

function ModelRow({
  model,
  source,
  selected,
  onSelect,
  tour
}: {
  model: LibraryModel
  source: ModelSource
  selected: boolean
  onSelect: () => void
  /** Marcação da apresentação guiada. */
  tour?: string
}) {
  const showProgress = source !== 'example' && model.status === 'downloading'
  return (
    <Card
      interactive
      selected={selected}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}
      data-tour={tour}
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
          {showProgress && (
            <div className="row">
              <div style={{ flex: 1 }}>
                <ProgressBar value={model.downloadProgress ?? 0} label={`Download de ${model.name}`} />
              </div>
              <span className="subtle mono">{model.downloadProgress}%</span>
            </div>
          )}
        </div>
        <div className="stack" style={{ alignItems: 'flex-end', gap: 6 }}>
          <ModelStateBadge source={source} model={model} />
          <span className="subtle mono">{formatGb(model.sizeGb)}</span>
        </div>
      </CardBody>
    </Card>
  )
}

function ModelDetail({ model, source }: { model: LibraryModel; source: ModelSource }) {
  const specs: Array<[string, string]> = [
    ['Publicador', model.publisher],
    ['Parâmetros', model.parameters],
    ['Quantização', model.quantization],
    ['Formato', model.format.toUpperCase()],
    ['Contexto máximo', `${formatContext(model.contextLength)} tokens`],
    ['Tamanho do download', formatGb(model.sizeGb)]
  ]

  return (
    <Card className="sticky">
      <CardHeader title={model.name} subtitle={model.id} actions={<ModelStateBadge source={source} model={model} />} />
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
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <FeatureBadge state="planned" />
          <span className="field__hint">
            Carregar, baixar, abrir no explorador e excluir modelos ficarão disponíveis quando o provedor local de modelos for
            conectado.
          </span>
        </div>
      </CardBody>
    </Card>
  )
}

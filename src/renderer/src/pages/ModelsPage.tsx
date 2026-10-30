import { useMemo, useState } from 'react'
import { Download, FolderOpen, HardDrive, MessageSquare, RefreshCw } from 'lucide-react'
import type { ModelSource } from '@shared/recommendations'
import { useNavigation } from '@renderer/app/navigation'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  FeatureBadge,
  FeatureNotice,
  LoadingState,
  ProgressBar,
  SearchInput,
  Segmented,
  StatusBadge,
  Tag
} from '@renderer/components/ui'
import { models } from '@renderer/data/models'
import type { LibraryModel } from '@renderer/data/types'
import { providerState, summarizeEngine } from '@renderer/lib/engine'
import { capabilityLabel, formatContext, formatGb } from '@renderer/lib/format'
import { eligibleModels, friendlyModelName, modelKey } from '@renderer/lib/real-runs'
import { requestModelFor } from '@renderer/lib/run-intent'
import { displayedModelStatus } from '@renderer/lib/status'
import { useResource } from '@renderer/lib/use-resource'

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
        description={`Modelos instalados nos provedores locais e biblioteca de exemplo com ${models.length} modelos`}
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

      <InstalledModels />

      <FeatureNotice state="example">
        Os modelos abaixo ilustram a biblioteca: não estão neste computador e não podem ser carregados. Baixar e gerenciar modelos
        pelo Gerpro Studio ainda está planejado.
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

/**
 * Modelos realmente instalados nos provedores locais (ex.: Ollama), como o
 * Main os informa. Só leitura: nada é baixado, carregado ou removido daqui.
 * "Usar em Conversas" leva a Conversas com o modelo pré-selecionado.
 */
function InstalledModels() {
  const { navigate } = useNavigation()
  const providers = useResource(() => window.gerpro.providers.list())
  const real = providers.state.status === 'ready' ? summarizeEngine(providers.state.data).real : []
  const usable = new Set(providers.state.status === 'ready' ? eligibleModels(providers.state.data).map((o) => o.key) : [])

  return (
    <section className="section" aria-labelledby="installed-models">
      <div className="section__head">
        <h2 id="installed-models">Instalados neste computador</h2>
        <div className="row">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} disabled={providers.state.status === 'loading'} onClick={providers.reload}>
            Verificar de novo
          </Button>
          <FeatureBadge state="real" />
        </div>
      </div>
      {providers.state.status === 'loading' && <LoadingState label="Consultando provedores locais…" />}
      {providers.state.status === 'error' && <ErrorState error={providers.state.error} onRetry={providers.reload} />}
      {providers.state.status === 'ready' && real.length === 0 && <p className="muted">Nenhum provedor local registrado.</p>}
      {real.map(({ info, status, models: installed }) => {
        const meta = providerState[status.state]
        return (
          <Card key={info.id}>
            <CardHeader
              title={info.displayName}
              subtitle={status.message ?? undefined}
              actions={
                <StatusBadge tone={meta.tone}>
                  {meta.label}
                  {status.version ? ` · ${status.version}` : ''}
                </StatusBadge>
              }
            />
            {installed && installed.length === 0 && (
              <CardBody>
                <p className="muted">O provedor respondeu, mas não há modelos instalados nele.</p>
              </CardBody>
            )}
            {installed && installed.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Modelo</th>
                      <th>Família</th>
                      <th>Parâmetros</th>
                      <th>Quantização</th>
                      <th>Contexto máximo</th>
                      <th style={{ textAlign: 'right' }}>Tamanho</th>
                      <th aria-label="Ações" />
                    </tr>
                  </thead>
                  <tbody>
                    {installed.map(({ model }) => (
                      <tr key={model.ref.modelId}>
                        <td>
                          <div className="stack" style={{ gap: 0 }}>
                            <span>{friendlyModelName(model.ref.modelId, model.displayName)}</span>
                            <span className="mono subtle">{model.ref.modelId}</span>
                          </div>
                        </td>
                        <td className="muted">{model.family ?? '—'}</td>
                        <td className="muted">{model.parameterSize ?? '—'}</td>
                        <td className="muted">{model.quantization ?? '—'}</td>
                        <td className="muted">{model.contextLength ? `${formatContext(model.contextLength)} tokens` : '—'}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>
                          {model.sizeBytes === null ? '—' : formatGb(model.sizeBytes / 1e9)}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {usable.has(modelKey(model.ref)) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<MessageSquare size={13} />}
                              onClick={() => {
                                requestModelFor(model.ref)
                                navigate('conversations')
                              }}
                            >
                              Usar em Conversas
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )
      })}
    </section>
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

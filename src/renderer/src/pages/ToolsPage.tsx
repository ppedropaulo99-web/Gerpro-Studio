import { Puzzle, Wrench } from 'lucide-react'
import type { ToolAvailability } from '@shared/tools'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ErrorState,
  FeatureBadge,
  FeatureNotice,
  LoadingState,
  Tag
} from '@renderer/components/ui'
import { permissionLabel } from '@renderer/lib/format'
import type { FeatureState } from '@renderer/lib/status'
import { useResource } from '@renderer/lib/use-resource'

const availabilityBadge: Record<ToolAvailability, { state: FeatureState; label: string }> = {
  available: { state: 'real', label: 'Disponível' },
  disabled: { state: 'planned', label: 'Desativada' },
  'not-implemented': { state: 'planned', label: 'Execução planejada' }
}

export function ToolsPage() {
  const catalog = useResource(() => window.gerpro.tools.list())

  return (
    <div className="page">
      <PageHeader
        title="Ferramentas"
        description="Catálogo de capacidades que os agentes poderão usar. Plugins adicionarão novas ferramentas."
        actions={
          <Button icon={<Puzzle size={16} />} disabled title="Planejado: sistema de plugins">
            Instalar plugin
          </Button>
        }
      />

      <FeatureNotice state="planned">
        O catálogo e as permissões declaradas são reais, mas nenhuma ferramenta executa nesta versão. Não há controles de
        ativação aqui: eles só farão sentido quando houver execução, com confirmação de permissões.
      </FeatureNotice>

      {catalog.state.status === 'loading' && <LoadingState label="Carregando catálogo…" />}
      {catalog.state.status === 'error' && <ErrorState error={catalog.state.error} onRetry={catalog.reload} />}
      {catalog.state.status === 'ready' && (
        <div className="grid">
          {catalog.state.data.map(({ definition: tool, availability }) => {
            const badge = availabilityBadge[availability]
            return (
              <Card key={tool.id}>
                <CardHeader
                  title={
                    <span className="row">
                      <Wrench size={15} className="subtle" />
                      {tool.name}
                    </span>
                  }
                  subtitle={tool.source === 'plugin' ? `Plugin · v${tool.version}` : `Nativa · v${tool.version}`}
                  actions={<FeatureBadge state={badge.state}>{badge.label}</FeatureBadge>}
                />
                <CardBody>
                  <p className="muted">{tool.description}</p>
                </CardBody>
                <CardFooter>
                  <div className="tag-list" aria-label="Permissões declaradas">
                    {tool.permissions.length === 0 ? (
                      <Tag>Sem permissões</Tag>
                    ) : (
                      tool.permissions.map((p) => <Tag key={p}>{permissionLabel[p]}</Tag>)
                    )}
                  </div>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import { Puzzle, ShieldCheck, Wrench } from 'lucide-react'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { Button, Card, CardBody, CardFooter, CardHeader, Notice, Switch, Tag } from '@renderer/components/ui'
import { tools as initialTools } from '@renderer/data/tools'

export function ToolsPage() {
  // Estado local apenas para demonstrar os controles; nada é persistido.
  const [enabled, setEnabled] = useState(() => Object.fromEntries(initialTools.map((t) => [t.id, t.enabled])))

  return (
    <div className="page">
      <PageHeader
        title="Ferramentas"
        description="Capacidades que os agentes podem usar. Plugins adicionarão novas ferramentas."
        actions={
          <Button icon={<Puzzle size={16} />} disabled title="Sistema de plugins em uma próxima etapa">
            Instalar plugin
          </Button>
        }
      />

      <Notice tone="neutral" icon={<ShieldCheck size={16} />}>
        Cada ferramenta declara as permissões de que precisa. Ativar ou desativar aqui é apenas visual neste protótipo.
      </Notice>

      <div className="grid">
        {initialTools.map((tool) => (
          <Card key={tool.id}>
            <CardHeader
              title={
                <span className="row">
                  <Wrench size={15} className="subtle" />
                  {tool.name}
                </span>
              }
              subtitle={tool.kind}
              actions={
                <Switch
                  label={`Ativar ${tool.name}`}
                  checked={enabled[tool.id]}
                  onChange={(v) => setEnabled((s) => ({ ...s, [tool.id]: v }))}
                />
              }
            />
            <CardBody>
              <p className="muted">{tool.description}</p>
            </CardBody>
            <CardFooter>
              <div className="tag-list">
                {tool.permissions.length === 0 ? <Tag>Sem permissões</Tag> : tool.permissions.map((p) => <Tag key={p}>{p}</Tag>)}
              </div>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  )
}

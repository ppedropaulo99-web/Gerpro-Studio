import { useEffect, useState } from 'react'
import { Play, Server, Terminal } from 'lucide-react'
import type { AppInfo } from '@shared/ipc'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { Button, Card, CardBody, CardHeader, Field, StatusBadge, SwitchRow, TextInput } from '@renderer/components/ui'

/** Endpoints planejados para o servidor local (ainda não implementados). */
const plannedEndpoints = [
  { method: 'GET', path: '/v1/models', description: 'Lista modelos disponíveis' },
  { method: 'POST', path: '/v1/chat/completions', description: 'Gera respostas de chat' },
  { method: 'POST', path: '/v1/embeddings', description: 'Gera vetores de embedding' },
  { method: 'POST', path: '/v1/agents/:id/runs', description: 'Inicia uma execução de agente' }
]

const sampleLogs = [
  '[14:32:01] INFO  ui      Interface carregada',
  '[14:32:01] INFO  ipc     Canal app:get-info registrado',
  '[14:32:02] WARN  engine  Nenhum motor de IA configurado',
  '[14:32:02] INFO  plugins Sistema de plugins desativado nesta etapa'
]

export function DeveloperPage() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [port, setPort] = useState('4310')
  const [lan, setLan] = useState(false)

  // Única chamada real de IPC do protótipo: demonstra o canal seguro Main ↔ Renderer.
  useEffect(() => {
    window.gerpro.app.getInfo().then(setInfo).catch(() => setInfo(null))
  }, [])

  return (
    <div className="page">
      <PageHeader title="Desenvolvedor" description="Servidor local, endpoints e diagnóstico do aplicativo." />

      <div className="split">
        <div className="stack">
          <Card>
            <CardHeader
              title={
                <span className="row">
                  <Server size={15} /> Servidor local
                </span>
              }
              subtitle="API compatível para outros aplicativos (planejada)"
              actions={<StatusBadge tone="neutral">Parado</StatusBadge>}
            />
            <CardBody className="stack">
              <div className="form-grid">
                <Field label="Porta" hint="Somente 127.0.0.1 por padrão">
                  {(id) => <TextInput id={id} value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />}
                </Field>
                <Field label="Endereço">
                  {(id) => <TextInput id={id} value={lan ? '0.0.0.0' : '127.0.0.1'} readOnly />}
                </Field>
              </div>
              <SwitchRow
                label="Aceitar conexões da rede local"
                description="Exporá a API a outros dispositivos da rede."
                checked={lan}
                onChange={setLan}
              />
              <div className="row">
                <Button variant="primary" icon={<Play size={15} />} disabled title="Servidor em uma próxima etapa">
                  Iniciar servidor
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Endpoints planejados" subtitle="Referência de design; nenhum está ativo" />
            <CardBody className="stack" style={{ gap: 0 }}>
              {plannedEndpoints.map((e) => (
                <div key={e.path} className="list-row">
                  <span className="row mono">
                    <span className={`method method--${e.method.toLowerCase()}`}>{e.method}</span>
                    {e.path}
                  </span>
                  <span className="subtle">{e.description}</span>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>

        <div className="stack">
          <Card>
            <CardHeader title="Aplicativo" subtitle="Lido do processo Main via IPC" />
            <CardBody>
              <dl className="specs">
                <div>
                  <dt>Versão</dt>
                  <dd>{info?.version ?? '…'}</dd>
                </div>
                <div>
                  <dt>Electron</dt>
                  <dd>{info?.versions.electron ?? '…'}</dd>
                </div>
                <div>
                  <dt>Chromium</dt>
                  <dd>{info?.versions.chrome ?? '…'}</dd>
                </div>
                <div>
                  <dt>Node.js</dt>
                  <dd>{info?.versions.node ?? '…'}</dd>
                </div>
                <div>
                  <dt>Plataforma</dt>
                  <dd>{info?.platform ?? '…'}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="row">
                  <Terminal size={15} /> Logs
                </span>
              }
              subtitle="Exemplo de saída"
            />
            <CardBody>
              <pre className="log">{sampleLogs.join('\n')}</pre>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  )
}

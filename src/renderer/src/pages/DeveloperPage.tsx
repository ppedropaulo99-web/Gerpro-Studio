import { useEffect, useState } from 'react'
import { Play, Server, Terminal } from 'lucide-react'
import type { AppInfo } from '@shared/ipc'
import { BrandLogo } from '@renderer/components/brand/BrandLogo'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { Button, Card, CardBody, CardHeader, FeatureBadge, Field, SwitchRow, TextInput } from '@renderer/components/ui'

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
  // Informações reais do processo Main, lidas pelo canal seguro de IPC.
  useEffect(() => {
    window.gerpro.app.getInfo().then(setInfo).catch(() => setInfo(null))
  }, [])

  return (
    <div className="page">
      <PageHeader title="Desenvolvedor" description="Servidor local, endpoints e diagnóstico do aplicativo." />

      <div className="split">
        <div className="stack">
          <Card data-tour="developer.server">
            <CardHeader
              title={
                <span className="row">
                  <Server size={15} /> Servidor local
                </span>
              }
              subtitle="API compatível para outros aplicativos"
              actions={<FeatureBadge state="planned" />}
            />
            <CardBody className="stack">
              <p className="muted">
                O servidor local ainda não existe: nada escuta em nenhuma porta. Os valores abaixo são os padrões previstos e não
                podem ser alterados nesta versão.
              </p>
              <div className="form-grid">
                <Field label="Porta" hint="Padrão previsto">
                  {(id) => <TextInput id={id} value="4310" disabled readOnly />}
                </Field>
                <Field label="Endereço" hint="Somente este computador">
                  {(id) => <TextInput id={id} value="127.0.0.1" disabled readOnly />}
                </Field>
              </div>
              <SwitchRow
                label="Aceitar conexões da rede local"
                description="Planejado. Exigirá decisão explícita, pois exporia a API a outros dispositivos da rede."
                checked={false}
                disabled
                onChange={() => undefined}
              />
              <div className="row">
                <Button variant="primary" icon={<Play size={15} />} disabled title="Planejado: servidor local">
                  Iniciar servidor
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Endpoints planejados" subtitle="Referência de design; nenhum está ativo" actions={<FeatureBadge state="planned" />} />
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
          <Card data-tour="developer.app">
            <CardHeader title="Aplicativo" subtitle="Lido do processo Main via IPC" actions={<FeatureBadge state="real" />} />
            <CardBody>
              <BrandLogo height={56} className="developer__logo" />
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
              subtitle="Exemplo de saída; não são logs desta sessão"
              actions={<FeatureBadge state="example" />}
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

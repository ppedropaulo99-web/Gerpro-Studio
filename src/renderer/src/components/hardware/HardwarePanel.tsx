import { useState } from 'react'
import { Cpu, FlaskConical, ScanSearch, ShieldCheck, Trash2 } from 'lucide-react'
import type { StructuredError } from '@shared/errors'
import { DEMO_SCENARIOS, HARDWARE_DATA_POINTS, type DemoScenario, type HardwareAdvisorState, type LocalAnalysisScope } from '@shared/hardware'
import { estimateLocalCapability } from '@shared/recommendations'
import { ReasonList } from '@renderer/components/hardware/ReasonList'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  Field,
  LoadingState,
  Notice,
  Select,
  StatusBadge,
  SwitchRow,
  Tag
} from '@renderer/components/ui'
import { diagnosticRows } from '@renderer/lib/advisor'
import { callApi } from '@renderer/lib/api'
import { formatDateTime } from '@renderer/lib/format'
import { consentStatus, hardwareStatus, localCapability } from '@renderer/lib/status'
import { useResource } from '@renderer/lib/use-resource'

const scenarioLabels: Record<DemoScenario, string> = {
  workstation: 'Estação de trabalho com GPU',
  modest: 'Computador modesto (hardware insuficiente)',
  partial: 'Dados parciais (GPU e disco desconhecidos)',
  stale: 'Análise antiga (dados desatualizados)',
  error: 'Falha do detector (erro)'
}

const confidenceLabel = { high: 'alta', medium: 'média', low: 'baixa' } as const

const scopeLabel: Record<LocalAnalysisScope, string> = {
  'demo-only': 'somente demonstração; não cobre leitura real',
  'device-detection': 'inclui leitura do hardware deste computador'
}

/**
 * Seção "Hardware e desempenho" (Gerpro Hardware Advisor). As ações aqui
 * valem na hora e são independentes do botão "Salvar alterações" da página.
 */
export function HardwarePanel() {
  const { state, reload, update } = useResource(() => window.gerpro.hardware.getState())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<StructuredError | null>(null)
  const [scenario, setScenario] = useState<DemoScenario>('workstation')

  async function act(call: () => Promise<Awaited<ReturnType<typeof window.gerpro.hardware.getState>>>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(true)
    setError(null)
    const result = await callApi(call)
    setBusy(false)
    if (result.ok) update(() => result.data)
    else setError(result.error)
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className="row">
            <Cpu size={15} className="subtle" />
            Hardware e desempenho
          </span>
        }
        subtitle="Gerpro Hardware Advisor: avalia os recursos do computador para recomendar agentes e modelos"
      />
      <CardBody className="stack" style={{ gap: 'var(--space-4)' }}>
        <Notice tone="warning" icon={<FlaskConical size={16} />}>
          A detecção real de hardware <strong>ainda não está implementada</strong>. Nenhuma informação do seu computador é lida. Os
          dados exibidos aqui, quando houver, são <strong>fictícios</strong> e servem só para demonstrar o fluxo. As ações desta seção
          valem na hora e não dependem do botão Salvar.
        </Notice>

        {state.status === 'loading' && <LoadingState label="Carregando o Hardware Advisor…" />}
        {state.status === 'error' && <ErrorState error={state.error} onRetry={reload} />}
        {state.status === 'ready' && (
          <AdvisorBody
            s={state.data}
            busy={busy}
            scenario={scenario}
            onScenario={setScenario}
            onGrant={() => void act(() => window.gerpro.hardware.setLocalConsent({ granted: true }))}
            onDeny={() => void act(() => window.gerpro.hardware.setLocalConsent({ granted: false }))}
            onRevoke={(deleteData) =>
              void act(
                () => window.gerpro.hardware.setLocalConsent({ granted: false, deleteData }),
                deleteData ? 'Desativar a autorização e apagar os dados de hardware armazenados?' : undefined
              )
            }
            onAnalyze={(mode) => void act(() => window.gerpro.hardware.analyze(mode === 'real' ? { mode } : { mode, scenario }))}
            onDelete={() => void act(() => window.gerpro.hardware.deleteData(), 'Apagar os dados de hardware armazenados?')}
          />
        )}
        {error && <Notice tone="danger">{error.message}</Notice>}
      </CardBody>
    </Card>
  )
}

interface BodyProps {
  s: HardwareAdvisorState
  busy: boolean
  scenario: DemoScenario
  onScenario: (s: DemoScenario) => void
  onGrant: () => void
  onDeny: () => void
  onRevoke: (deleteData: boolean) => void
  onAnalyze: (mode: 'real' | 'demo') => void
  onDelete: () => void
}

function AdvisorBody({ s, busy, scenario, onScenario, onGrant, onDeny, onRevoke, onAnalyze, onDelete }: BodyProps) {
  const local = s.consent.localAnalysis
  const granted = local.status === 'granted'
  const meta = hardwareStatus[s.status]
  const outcome = s.analysis?.outcome
  const profile = outcome?.kind === 'completed' ? outcome.profile : null

  return (
    <>
      {/* Consentimento: análise local */}
      <div className="stack" style={{ gap: 'var(--space-3)' }}>
        <div className="row between">
          <div className="stack" style={{ gap: 2 }}>
            <span className="field__label">Análise local de hardware</span>
            <span className="field__hint">
              {consentStatus[local.status]}
              {local.scope && ` (${scopeLabel[local.scope]})`}
              {local.decidedAt && ` · ${formatDateTime(local.decidedAt)}`}. A análise ocorreria só neste computador.
            </span>
          </div>
          <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
        </div>

        <details className="disclosure" open={!granted}>
          <summary>O que seria consultado</summary>
          <dl className="specs">
            {HARDWARE_DATA_POINTS.map((d) => (
              <div key={d.id}>
                <dt>{d.label}</dt>
                <dd style={{ fontFamily: 'inherit' }}>{d.detail}</dd>
              </div>
            ))}
          </dl>
          <p className="field__hint" style={{ marginTop: 'var(--space-2)' }}>
            Não são consultados arquivos pessoais, programas instalados, rede ou identificadores do usuário.
          </p>
        </details>

        <div className="row" style={{ flexWrap: 'wrap' }}>
          {granted ? (
            <>
              <Button disabled={busy} onClick={() => onRevoke(false)}>
                Desativar autorização
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => onRevoke(true)}>
                Desativar e apagar dados
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" icon={<ShieldCheck size={16} />} disabled={busy} onClick={onGrant}>
                Autorizar análise local
              </Button>
              {local.status === 'not-asked' && (
                <Button variant="ghost" disabled={busy} onClick={onDeny}>
                  Agora não
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Consentimento separado: envio ao servidor */}
      <SwitchRow
        label="Compartilhar perfil de hardware com o Gerpro Web"
        description="Autorização separada da análise local. Não disponível nesta versão: nenhuma informação é enviada a servidores."
        checked={false}
        disabled
        onChange={() => undefined}
      />

      {s.hasStoredData && !granted && (
        <Notice tone="neutral">
          Há dados de hardware gravados de uma autorização anterior. Eles não são exibidos nem usados enquanto a análise estiver
          desativada.
        </Notice>
      )}

      <p className="muted" style={{ margin: 0 }}>
        {meta.description}
      </p>

      {/* Ações de análise */}
      {granted && (
        <div className="form-grid" style={{ alignItems: 'end' }}>
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            <span className="field__label">Detecção real</span>
            <Button icon={<ScanSearch size={16} />} disabled={busy} onClick={() => onAnalyze('real')} title={s.detectors.real.reason ?? undefined}>
              Detectar hardware deste computador
            </Button>
            {/* O motivo aparece uma só vez: aqui, ou no aviso do resultado após uma tentativa. */}
            {!s.detectors.real.available && outcome?.kind !== 'unavailable' && <span className="field__hint">{s.detectors.real.reason}</span>}
          </div>
          <Field label="Cenário demonstrativo (fictício)">
            {(id) => (
              <Select
                id={id}
                value={scenario}
                onChange={(e) => onScenario(e.target.value as DemoScenario)}
                options={DEMO_SCENARIOS.map((v) => ({ value: v, label: scenarioLabels[v] }))}
              />
            )}
          </Field>
          <div>
            <Button variant="primary" icon={<FlaskConical size={16} />} disabled={busy} onClick={() => onAnalyze('demo')}>
              {busy ? 'Analisando…' : 'Executar análise demonstrativa'}
            </Button>
          </div>
        </div>
      )}

      {/* Resultado */}
      {outcome?.kind === 'unavailable' && <Notice tone="warning">{outcome.reason}</Notice>}
      {outcome?.kind === 'error' && <Notice tone="danger">{outcome.message}</Notice>}
      {profile && (
        <div className="stack" style={{ gap: 'var(--space-3)' }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {profile.provenance.source === 'demo' ? (
              <StatusBadge tone="warning">Dados fictícios: demonstração</StatusBadge>
            ) : (
              <StatusBadge tone="success">Detectado neste computador</StatusBadge>
            )}
            <Tag>Coletado em {formatDateTime(profile.provenance.collectedAt)}</Tag>
            <Tag>Confiabilidade {confidenceLabel[profile.provenance.confidence]}</Tag>
            <Tag>{profile.provenance.detectorId}</Tag>
          </div>
          {s.status === 'stale' && (
            <Notice tone="warning">
              Estes dados têm mais de {s.staleAfterDays} dias. Execute uma nova análise para atualizar as recomendações.
            </Notice>
          )}
          <dl className="specs">
            {diagnosticRows(profile).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd className={row.known ? undefined : 'subtle'}>{row.value}</dd>
              </div>
            ))}
          </dl>
          <CapabilityEstimate profile={profile} />
        </div>
      )}

      {s.hasStoredData && (
        <div>
          <Button variant="ghost" icon={<Trash2 size={14} />} size="sm" disabled={busy} onClick={onDelete}>
            Apagar dados de hardware
          </Button>
        </div>
      )}
    </>
  )
}

function CapabilityEstimate({ profile }: { profile: Parameters<typeof estimateLocalCapability>[0] }) {
  const estimate = estimateLocalCapability(profile)
  const meta = localCapability[estimate.level]
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <div className="row between">
        <span className="field__label">Compatibilidade estimada com processamento local</span>
        <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
      </div>
      <span className="muted">{estimate.summary}</span>
      <ReasonList reasons={estimate.reasons} />
      <span className="field__hint">Estimativa aproximada. Sem motor de IA, nenhum modelo é executado nesta versão.</span>
    </div>
  )
}

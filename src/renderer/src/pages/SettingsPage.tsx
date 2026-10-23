import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Save } from 'lucide-react'
import type { AppSettings, Theme } from '@shared/settings'
import { useUnsavedChangesGuard } from '@renderer/app/navigation'
import { HardwarePanel } from '@renderer/components/hardware/HardwarePanel'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  Field,
  FieldError,
  LoadingState,
  Notice,
  Segmented,
  Select,
  SwitchRow,
  TextInput
} from '@renderer/components/ui'
import { callApi } from '@renderer/lib/api'
import {
  formFromSettings,
  inactivePreference,
  patchFromForm,
  settingsFormErrors,
  type SettingsFormErrors,
  type SettingsFormValues
} from '@renderer/lib/settings-form'
import { applyTheme, themeOptions, themePatch } from '@renderer/lib/theme'
import { useResource } from '@renderer/lib/use-resource'

function Section({ title, description, tour, children }: { title: string; description: string; tour?: string; children: ReactNode }) {
  return (
    <Card data-tour={tour}>
      <CardHeader title={title} subtitle={description} />
      <CardBody className="stack" style={{ gap: 'var(--space-4)' }}>
        {children}
      </CardBody>
    </Card>
  )
}

/** Toda preferência desta tela é gravada, mas nenhuma altera o comportamento do app ainda. */
const NO_EFFECT = 'Gravado; ainda sem efeito nesta versão.'

/** Escolha antiga preservada no disco, mas sem valor de decisão. */
const STORED_NOT_APPLIED = 'Há uma escolha anterior gravada; ela foi preservada, mas não será aplicada.'

export function SettingsPage() {
  const { state, reload, update } = useResource(() => window.gerpro.settings.get())

  return (
    <div className="page settings">
      {state.status === 'ready' ? (
        <SettingsForm saved={state.data} onSaved={(s) => update(() => s)} />
      ) : (
        <>
          <PageHeader title="Configurações" description="Preferências do aplicativo, gravadas neste computador." />
          {state.status === 'loading' ? <LoadingState label="Carregando configurações…" /> : <ErrorState error={state.error} onRetry={reload} />}
        </>
      )}
      {/* Independente do formulário: funciona mesmo se as preferências não carregarem. */}
      <HardwarePanel />
    </div>
  )
}

function SettingsForm({ saved, onSaved }: { saved: AppSettings; onSaved: (s: AppSettings) => void }) {
  const [form, setForm] = useState<SettingsFormValues>(() => formFromSettings(saved))
  const [errors, setErrors] = useState<SettingsFormErrors>({})
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  const pending = patchFromForm(saved, form)
  const dirty = !pending.ok || pending.changed
  // A aparência e as ações do Hardware Advisor valem na hora e não entram aqui.
  useUnsavedChangesGuard(dirty, 'nas configurações')
  const sensitiveTools = inactivePreference(saved, 'confirmSensitiveTools')
  const telemetry = inactivePreference(saved, 'telemetry')

  useEffect(() => {
    if (dirty) setJustSaved(false)
  }, [dirty])

  const set = <K extends keyof SettingsFormValues>(key: K, value: SettingsFormValues[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined, form: undefined }))
  }

  async function save() {
    if (!pending.ok) {
      setErrors(pending.errors)
      return
    }
    setSaving(true)
    const result = await callApi(() => window.gerpro.settings.update(pending.patch))
    setSaving(false)
    if (result.ok) {
      onSaved(result.data)
      setForm(formFromSettings(result.data))
      setErrors({})
      setJustSaved(true)
    } else {
      setErrors({ ...(result.error.issues ? settingsFormErrors(result.error.issues) : {}), form: result.error.message })
    }
  }

  return (
    <>
      <PageHeader
        title="Configurações"
        description="Preferências do aplicativo, gravadas neste computador."
        actions={
          <>
            {dirty && (
              <Button variant="ghost" disabled={saving} onClick={() => {
                  setForm(formFromSettings(saved))
                  setErrors({})
                }}
              >
                Descartar
              </Button>
            )}
            <Button variant="primary" icon={justSaved ? <Check size={16} /> : <Save size={16} />} disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Salvando…' : justSaved ? 'Salvo' : 'Salvar alterações'}
            </Button>
          </>
        }
      />

      <AppearanceSection saved={saved} onSaved={onSaved} />

      <Notice tone="neutral">
        As preferências abaixo são gravadas e mantidas após reiniciar o aplicativo, mas <strong>ainda não têm efeito</strong> nesta
        versão: idioma, densidade, inicialização com o sistema, pasta e limite de modelos serão aplicados em etapas futuras. As
        preferências de privacidade e segurança ainda não podem ser alteradas.
      </Notice>

      {errors.form && (
        <Notice tone="danger" icon={<AlertTriangle size={16} />}>
          {errors.form}
        </Notice>
      )}

      <Section title="Geral" description="Idioma e comportamento do aplicativo" tour="settings.general">
        <div className="form-grid">
          <Field label="Idioma" hint={NO_EFFECT}>
            {(id) => (
              <Select
                id={id}
                value={form.language}
                onChange={(e) => set('language', e.target.value as SettingsFormValues['language'])}
                options={[
                  { value: 'pt-BR', label: 'Português (Brasil)' },
                  { value: 'en-US', label: 'English (US)' },
                  { value: 'es', label: 'Español' }
                ]}
              />
            )}
          </Field>
          <Field label="Densidade da interface" hint={NO_EFFECT}>
            {(id) => (
              <Select
                id={id}
                value={form.density}
                onChange={(e) => set('density', e.target.value as SettingsFormValues['density'])}
                options={[
                  { value: 'comfortable', label: 'Confortável' },
                  { value: 'compact', label: 'Compacta' }
                ]}
              />
            )}
          </Field>
        </div>
        <SwitchRow
          label="Iniciar com o sistema"
          description={`Abre o Gerpro Studio minimizado ao entrar no Windows. ${NO_EFFECT}`}
          checked={form.startOnLogin}
          onChange={(v) => set('startOnLogin', v)}
        />
      </Section>

      <Section title="Modelos" description="Armazenamento e limites de memória">
        <Field label="Pasta de modelos" hint={`Vazio usa a pasta padrão. ${NO_EFFECT}`}>
          {(id) => (
            <>
              <TextInput id={id} placeholder="Pasta padrão" value={form.modelsDirectory} onChange={(e) => set('modelsDirectory', e.target.value)} />
              <FieldError>{errors.modelsDirectory}</FieldError>
            </>
          )}
        </Field>
        <Field label="Limite de RAM para modelos (GB)" hint={`Impedirá carregar modelos que excedam este valor. ${NO_EFFECT}`}>
          {(id) => (
            <>
              <TextInput id={id} type="number" min={1} max={4096} step={1} value={form.maxRamGb} onChange={(e) => set('maxRamGb', e.target.value)} />
              <FieldError>{errors.maxRamGb}</FieldError>
            </>
          )}
        </Field>
      </Section>

      <Section title="Privacidade e segurança" description="Controle sobre dados e ações dos agentes" tour="settings.privacy">
        <Notice tone="neutral">
          Indisponível nesta versão. Enquanto estas funções não existirem, valem os padrões seguros mostrados abaixo. Quando forem
          implementadas, o Gerpro Studio pedirá uma <strong>nova decisão sua</strong>; nenhuma escolha anterior será aplicada
          automaticamente.
        </Notice>
        <SwitchRow
          label="Confirmar antes de usar ferramentas sensíveis"
          description={[
            'Pedirá aprovação para terminal, escrita em disco e rede. Indisponível: até lá, a confirmação vale como sempre exigida.',
            sensitiveTools.storedDiffers ? STORED_NOT_APPLIED : ''
          ].join(' ')}
          checked={sensitiveTools.shown}
          disabled
          onChange={() => undefined}
        />
        <SwitchRow
          label="Enviar dados de uso anônimos"
          description={['Indisponível: nenhum dado é enviado nesta versão.', telemetry.storedDiffers ? STORED_NOT_APPLIED : ''].join(' ')}
          checked={telemetry.shown}
          disabled
          onChange={() => undefined}
        />
      </Section>
    </>
  )
}

/**
 * Tema: aplicado e gravado na hora, fora do formulário. Não marca alterações
 * pendentes, e "Descartar" ou sair sem salvar não o revertem; para voltar,
 * basta escolher o outro tema. Se a gravação falhar, o tema anterior volta.
 */
function AppearanceSection({ saved, onSaved }: { saved: AppSettings; onSaved: (s: AppSettings) => void }) {
  const [choosing, setChoosing] = useState<Theme | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = saved.appearance.theme

  async function choose(next: Theme) {
    if (next === current || choosing) return
    const root = document.documentElement
    applyTheme(root, next)
    setChoosing(next)
    setError(null)
    const result = await callApi(() => window.gerpro.settings.update(themePatch(next)))
    setChoosing(null)
    if (result.ok) {
      onSaved(result.data)
    } else {
      applyTheme(root, current)
      setError(result.error.message)
    }
  }

  return (
    <Section title="Aparência" description="Tema visual da interface" tour="settings.appearance">
      {/* Grupo de botões com rótulo próprio (aria-label), por isso sem <label for>. */}
      <div className="field">
        <span className="field__label" aria-hidden>
          Tema
        </span>
        <Segmented label="Tema" value={choosing ?? current} onChange={(t) => void choose(t)} options={themeOptions} disabled={choosing !== null} />
        <span className="field__hint">Aplicado e gravado na hora; não depende do botão Salvar.</span>
      </div>
      {error && (
        <Notice tone="danger" icon={<AlertTriangle size={16} />}>
          Não foi possível gravar o tema. {error}
        </Notice>
      )}
    </Section>
  )
}

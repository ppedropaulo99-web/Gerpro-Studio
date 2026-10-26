import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Save, ShieldCheck } from 'lucide-react'
import type { AgentRecord } from '@shared/agents'
import type { ToolCatalogEntry } from '@shared/tools'
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
  Select,
  SwitchRow,
  Tag,
  TextArea,
  TextInput
} from '@renderer/components/ui'
import { useUnsavedChangesGuard } from '@renderer/app/navigation'
import {
  agentFormChanged,
  agentFormErrors,
  draftFromForm,
  requestedPermissionsFor,
  slugify,
  uniqueId,
  type AgentFormErrors,
  type AgentFormValues
} from '@renderer/lib/agent-form'
import { callApi } from '@renderer/lib/api'
import { permissionLabel } from '@renderer/lib/format'
import type { Resource } from '@renderer/lib/use-resource'

interface AgentEditorProps {
  mode: 'create' | 'edit'
  initial: AgentFormValues
  tools: Resource<ToolCatalogEntry[]>
  onRetryTools: () => void
  /** IDs já usados, para sugerir um ID livre ao criar. */
  takenIds: ReadonlySet<string>
  onCancel: () => void
  onSaved: (record: AgentRecord) => void
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={description} />
      <CardBody className="stack" style={{ gap: 'var(--space-4)' }}>
        {children}
      </CardBody>
    </Card>
  )
}

const availabilityHint: Record<ToolCatalogEntry['availability'], string> = {
  available: 'Disponível',
  disabled: 'Desativada',
  'not-implemented': 'Ainda sem implementação'
}

export function AgentEditor({ mode, initial, tools, onRetryTools, takenIds, onCancel, onSaved }: AgentEditorProps) {
  const [form, setForm] = useState(initial)
  const [errors, setErrors] = useState<AgentFormErrors>({})
  const [saving, setSaving] = useState(false)
  // Ao criar, o ID acompanha o nome até o usuário editá-lo.
  const [idTouched, setIdTouched] = useState(mode === 'edit' || initial.id !== '')

  // Sair pela navegação do app com alterações pendentes pede confirmação.
  useUnsavedChangesGuard(agentFormChanged(initial, form), mode === 'create' ? 'no novo agente' : 'no agente em edição')

  const catalog = tools.status === 'ready' ? tools.data : []
  const permissions = useMemo(() => requestedPermissionsFor(form.tools, catalog), [form.tools, catalog])

  const set = <K extends keyof AgentFormValues>(key: K, value: AgentFormValues[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined, form: undefined }))
  }

  const setName = (name: string) => {
    set('name', name)
    if (!idTouched) setForm((f) => ({ ...f, name, id: uniqueId(slugify(name), takenIds) }))
  }

  const toggleTool = (id: string, on: boolean) =>
    set('tools', on ? [...form.tools, id] : form.tools.filter((t) => t !== id))

  async function save() {
    const parsed = draftFromForm(form, catalog)
    if (!parsed.ok) {
      setErrors(parsed.errors)
      return
    }
    setSaving(true)
    const api = window.gerpro.agents
    const result = await callApi(() => (mode === 'create' ? api.create(parsed.draft) : api.update(parsed.draft)))
    setSaving(false)
    if (result.ok) {
      onSaved(result.data)
    } else {
      const fieldErrors = result.error.issues ? agentFormErrors(result.error.issues) : {}
      setErrors({ ...fieldErrors, form: result.error.message })
    }
  }

  const stateOptions = [
    { value: 'draft', label: 'Rascunho — pode ficar incompleto' },
    { value: 'ready', label: 'Pronto — exige modelo e instruções' },
    ...(initial.state === 'archived' ? [{ value: 'archived', label: 'Arquivado' }] : [])
  ]

  return (
    <div className="stack settings" style={{ gap: 'var(--space-4)' }}>
      {errors.form && (
        <Notice tone="danger" icon={<AlertTriangle size={16} />}>
          {errors.form}
        </Notice>
      )}

      <Section title="Identificação" description="Nome, versão e estado da configuração">
        <div className="form-grid">
          <Field label="Nome">
            {(id) => (
              <>
                <TextInput id={id} value={form.name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
                <FieldError>{errors.name}</FieldError>
              </>
            )}
          </Field>
          <Field label="ID" hint={mode === 'edit' ? 'O ID não muda após a criação.' : 'Minúsculas, dígitos e hífen.'}>
            {(id) => (
              <>
                <TextInput
                  id={id}
                  className="mono"
                  value={form.id}
                  disabled={mode === 'edit'}
                  onChange={(e) => {
                    setIdTouched(true)
                    set('id', e.target.value)
                  }}
                />
                <FieldError>{errors.id}</FieldError>
              </>
            )}
          </Field>
          <Field label="Versão" hint="Versão semântica, ex.: 1.0.0">
            {(id) => (
              <>
                <TextInput id={id} className="mono" value={form.version} onChange={(e) => set('version', e.target.value)} />
                <FieldError>{errors.version}</FieldError>
              </>
            )}
          </Field>
          <Field label="Estado">
            {(id) => (
              <>
                <Select
                  id={id}
                  value={form.state}
                  options={stateOptions}
                  onChange={(e) => set('state', e.target.value as AgentFormValues['state'])}
                />
                <FieldError>{errors.state}</FieldError>
              </>
            )}
          </Field>
        </div>
        <Field label="Descrição">
          {(id) => (
            <>
              <TextArea id={id} rows={2} maxLength={1000} value={form.description} onChange={(e) => set('description', e.target.value)} />
              <FieldError>{errors.description}</FieldError>
            </>
          )}
        </Field>
      </Section>

      <Section title="Modelo" description="Referência ao modelo e parâmetros de geração">
        <Notice tone="warning">
          O modelo é registrado na definição. O agente só fica disponível quando um motor de IA local responde com
          este modelo instalado, e a execução pela interface ainda está planejada.
        </Notice>
        <Field label="ID do modelo" hint="Obrigatório quando o estado é Pronto. Não vinculado a um motor específico.">
          {(id) => (
            <>
              <TextInput id={id} className="mono" placeholder="ex.: aurora-8b-instruct" value={form.modelId} onChange={(e) => set('modelId', e.target.value)} />
              <FieldError>{errors.modelId}</FieldError>
            </>
          )}
        </Field>
        <div className="form-grid">
          <Field label="Temperatura" hint="0 a 2">
            {(id) => (
              <>
                <TextInput id={id} type="number" min={0} max={2} step={0.05} value={form.temperature} onChange={(e) => set('temperature', e.target.value)} />
                <FieldError>{errors.temperature}</FieldError>
              </>
            )}
          </Field>
          <Field label="Top P" hint="0 a 1">
            {(id) => (
              <>
                <TextInput id={id} type="number" min={0} max={1} step={0.05} value={form.topP} onChange={(e) => set('topP', e.target.value)} />
                <FieldError>{errors.topP}</FieldError>
              </>
            )}
          </Field>
          <Field label="Máx. de tokens na resposta" hint="Vazio = padrão do motor">
            {(id) => (
              <>
                <TextInput id={id} type="number" min={1} step={1} value={form.maxOutputTokens} onChange={(e) => set('maxOutputTokens', e.target.value)} />
                <FieldError>{errors.maxOutputTokens}</FieldError>
              </>
            )}
          </Field>
        </div>
      </Section>

      <Section title="Instruções" description="Instruções de sistema do agente">
        <Field label="Instruções" hint="Obrigatórias quando o estado é Pronto.">
          {(id) => (
            <>
              <TextArea id={id} rows={8} value={form.instructions} onChange={(e) => set('instructions', e.target.value)} />
              <FieldError>{errors.instructions}</FieldError>
            </>
          )}
        </Field>
      </Section>

      <Section title="Ferramentas" description="Capacidades que o agente poderá usar">
        {tools.status === 'loading' && <LoadingState label="Carregando ferramentas…" />}
        {tools.status === 'error' && <ErrorState error={tools.error} onRetry={onRetryTools} title="Não foi possível carregar as ferramentas" />}
        {tools.status === 'ready' && (
          <>
            {tools.data.map(({ definition, availability }) => (
              <SwitchRow
                key={definition.id}
                label={definition.name}
                description={[
                  definition.description,
                  definition.permissions.length
                    ? `Permissões: ${definition.permissions.map((p) => permissionLabel[p]).join(', ')}`
                    : 'Sem permissões',
                  availabilityHint[availability]
                ].join(' · ')}
                checked={form.tools.includes(definition.id)}
                onChange={(on) => toggleTool(definition.id, on)}
              />
            ))}
            <FieldError>{errors.tools}</FieldError>
            <Notice tone="neutral" icon={<ShieldCheck size={16} />}>
              <div className="stack" style={{ gap: 'var(--space-2)' }}>
                <span>
                  Permissões solicitadas pelo agente. São apenas declaradas: nada é concedido nem pedido ao sistema operacional.
                </span>
                <div className="tag-list">
                  {permissions.length === 0 ? <Tag>Nenhuma</Tag> : permissions.map((p) => <Tag key={p}>{permissionLabel[p]}</Tag>)}
                </div>
              </div>
            </Notice>
          </>
        )}
      </Section>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          icon={<Save size={16} />}
          onClick={() => void save()}
          disabled={saving || tools.status !== 'ready'}
          title={tools.status !== 'ready' ? 'Aguardando o catálogo de ferramentas' : undefined}
        >
          {saving ? 'Salvando…' : mode === 'create' ? 'Criar agente' : 'Salvar alterações'}
        </Button>
      </div>
    </div>
  )
}

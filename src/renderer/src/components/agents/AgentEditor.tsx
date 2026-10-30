import { useId, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronRight, Plus, RefreshCw, Save, ShieldCheck } from 'lucide-react'
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
  advancedSummary,
  agentFormChanged,
  agentFormErrors,
  draftFromForm,
  formPermissions,
  hasAdvancedError,
  slugify,
  taskTypeOptions,
  taskTypesSummary,
  toggledTaskTypes,
  uniqueId,
  unknownTools,
  type AgentFormErrors,
  type AgentFormValues
} from '@renderer/lib/agent-form'
import { agentModelField, withModelChoice } from '@renderer/lib/agent-model'
import { TOOLS_PLANNED_NOTICE } from '@renderer/lib/agent-status'
import { callApi } from '@renderer/lib/api'
import { permissionLabel } from '@renderer/lib/format'
import { useResource, type Resource } from '@renderer/lib/use-resource'

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
  'not-implemented': 'Ainda não executada'
}

const gpuOptions = [
  { value: 'auto', label: 'Automático' },
  { value: 'cpu-only', label: 'Só CPU' }
]

export function AgentEditor({ mode, initial, tools, onRetryTools, takenIds, onCancel, onSaved }: AgentEditorProps) {
  const [form, setForm] = useState(initial)
  const [errors, setErrors] = useState<AgentFormErrors>({})
  const [saving, setSaving] = useState(false)
  // Só a exibição: os valores ficam em `form`, com a seção aberta ou recolhida.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Ao criar, o ID acompanha o nome até o usuário editá-lo.
  const [idTouched, setIdTouched] = useState(mode === 'edit' || initial.id !== '')

  // Sair pela navegação do app com alterações pendentes pede confirmação.
  useUnsavedChangesGuard(agentFormChanged(initial, form), mode === 'create' ? 'no novo agente' : 'no agente em edição')

  // O inventário só é lido: consultar ou atualizar a lista nunca altera o formulário.
  const providers = useResource(() => window.gerpro.providers.list())
  const model = useMemo(() => agentModelField(form, providers.state, initial), [form, providers.state, initial])
  const modelsLoading = model.inventory === 'loading'
  const taskTypesLabel = useId()

  const catalog = tools.status === 'ready' ? tools.data : []
  const permissions = useMemo(() => formPermissions(form, catalog), [form, catalog])
  // Sem o catálogo, nenhuma ferramenta pode ser dada como desconhecida.
  const unknown = tools.status === 'ready' ? unknownTools(form.tools, catalog) : []
  const removed = tools.status === 'ready' ? unknownTools(initial.tools, catalog).filter((id) => !form.tools.includes(id)) : []

  const set = <K extends keyof AgentFormValues>(key: K, value: AgentFormValues[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined, form: undefined }))
  }

  const setName = (name: string) => {
    set('name', name)
    if (!idTouched) setForm((f) => ({ ...f, name, id: uniqueId(slugify(name), takenIds) }))
  }

  const chooseModel = (key: string) => {
    setForm(withModelChoice(form, key, model))
    setErrors((e) => ({ ...e, modelId: undefined, form: undefined }))
  }

  const toggleTool = (id: string, on: boolean) =>
    set('tools', on ? [...form.tools, id] : form.tools.filter((t) => t !== id))

  const showErrors = (found: AgentFormErrors) => {
    setErrors(found)
    if (hasAdvancedError(found)) setAdvancedOpen(true)
  }

  async function save() {
    const parsed = draftFromForm(form, catalog)
    if (!parsed.ok) {
      showErrors(parsed.errors)
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
      showErrors({ ...fieldErrors, form: result.error.code === 'validation' ? 'Revise os campos indicados.' : result.error.message })
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

      {unknown.length > 0 && (
        <Notice tone="warning" icon={<AlertTriangle size={16} />}>
          Este agente referencia {unknown.length === 1 ? 'uma ferramenta não reconhecida' : 'ferramentas não reconhecidas'}: <span className="mono">{unknown.join(', ')}</span>. A
          configuração foi mantida. Para salvar alterações, remova a referência em Configurações avançadas, na seção Ferramentas.
        </Notice>
      )}

      <Section title="Informações básicas" description="O nome é obrigatório. Modelo e instruções são exigidos só no estado Pronto.">
        <div className="form-grid">
          <Field label="Nome" hint="Obrigatório.">
            {(id) => (
              <>
                <TextInput id={id} value={form.name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
                <FieldError>{errors.name}</FieldError>
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
        <Field label="Descrição" hint="Opcional.">
          {(id) => (
            <>
              <TextArea id={id} rows={2} maxLength={1000} value={form.description} onChange={(e) => set('description', e.target.value)} />
              <FieldError>{errors.description}</FieldError>
            </>
          )}
        </Field>
        <Field label="Instruções" hint="Obrigatórias quando o estado é Pronto. Diga o que o agente faz e como deve responder.">
          {(id) => (
            <>
              <TextArea id={id} rows={6} value={form.instructions} onChange={(e) => set('instructions', e.target.value)} />
              <FieldError>{errors.instructions}</FieldError>
            </>
          )}
        </Field>
        <Notice tone="neutral">
          Este é o modelo padrão do agente. Em Conversas, ele vem selecionado quando está instalado, e o agente pode ser usado com qualquer
          outro modelo instalado neste computador.
        </Notice>
        <Field label="Modelo de IA" hint="Obrigatório quando o estado é Pronto.">
          {(id) => (
            <>
              <div className="model-select">
                <Select
                  id={id}
                  value={model.selectedKey}
                  options={model.choices.map(({ key, label }) => ({ value: key, label }))}
                  disabled={modelsLoading}
                  onChange={(e) => chooseModel(e.target.value)}
                />
                <Button variant="secondary" icon={<RefreshCw size={14} />} disabled={modelsLoading} onClick={providers.reload}>
                  Atualizar lista
                </Button>
              </div>
              {modelsLoading && <span className="subtle">Consultando os modelos instalados…</span>}
              {model.identifier && <span className="subtle">Identificador: <span className="mono">{model.identifier}</span></span>}
              <FieldError>{errors.modelId}</FieldError>
            </>
          )}
        </Field>
        {model.problem && <Notice tone={model.problem.tone}>{model.problem.text}</Notice>}
        {model.notice && <Notice tone={model.notice.tone}>{model.notice.text}</Notice>}
        <div className="field">
          <span className="field__label" id={taskTypesLabel}>
            Tipos de tarefa
          </span>
          <div className="task-chips" role="group" aria-labelledby={taskTypesLabel}>
            {taskTypeOptions.map(({ value, label }) => {
              const selected = form.taskTypes.includes(value)
              return (
                <button
                  key={value}
                  type="button"
                  className="task-chip"
                  aria-pressed={selected}
                  onClick={() => set('taskTypes', toggledTaskTypes(form.taskTypes, value, !selected, initial.taskTypes))}
                >
                  {selected ? <Check size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
                  {label}
                </button>
              )
            })}
          </div>
          <span className="subtle">{taskTypesSummary(form.taskTypes)}</span>
          <FieldError>{errors.taskTypes}</FieldError>
          <span className="field__hint">Opcional. Ajuda a indicar este agente nas recomendações por tarefa.</span>
        </div>
      </Section>

      <Card>
        <details className="advanced" open={advancedOpen || tools.status === 'error'} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
          <summary className="advanced__summary">
            <ChevronRight size={16} className="advanced__chevron" aria-hidden />
            <span className="stack" style={{ gap: 0 }}>
              <strong>Configurações avançadas</strong>
              <span className="subtle">{advancedSummary(form)}</span>
            </span>
          </summary>
          <div className="advanced__body stack">
            <p className="subtle">Opcional. Recolher esta área não apaga nada: os valores continuam salvos no agente.</p>

            <section className="stack advanced__group" aria-labelledby="advanced-generation">
              <h3 id="advanced-generation">Geração de respostas</h3>
              <div className="form-grid">
                <Field label="Temperatura" hint="0 a 2. Valores baixos dão respostas mais previsíveis; altos, mais variadas.">
                {(id) => (
                  <>
                    <TextInput id={id} type="number" min={0} max={2} step={0.05} value={form.temperature} onChange={(e) => set('temperature', e.target.value)} />
                    <FieldError>{errors.temperature}</FieldError>
                  </>
                )}
              </Field>
              <Field label="Top P" hint="0 a 1. Limita as palavras consideradas a cada passo. Normalmente não precisa mudar.">
                {(id) => (
                  <>
                    <TextInput id={id} type="number" min={0} max={1} step={0.05} value={form.topP} onChange={(e) => set('topP', e.target.value)} />
                    <FieldError>{errors.topP}</FieldError>
                  </>
                )}
              </Field>
              <Field label="Máx. de tokens na resposta" hint="Vazio = padrão do motor.">
                {(id) => (
                  <>
                    <TextInput id={id} type="number" min={1} step={1} value={form.maxOutputTokens} onChange={(e) => set('maxOutputTokens', e.target.value)} />
                    <FieldError>{errors.maxOutputTokens}</FieldError>
                  </>
                )}
              </Field>
              <Field label="Tamanho do contexto (tokens)" hint="Vazio = padrão do motor. Valores altos usam mais memória.">
                {(id) => (
                  <>
                    <TextInput id={id} type="number" min={256} step={1} value={form.contextLength} onChange={(e) => set('contextLength', e.target.value)} />
                    <FieldError>{errors.contextLength}</FieldError>
                  </>
                )}
              </Field>
              <Field label="Semente" hint="Vazio = aleatória. Repetir a semente ajuda a reproduzir uma resposta.">
                {(id) => (
                  <>
                    <TextInput id={id} type="number" min={0} step={1} value={form.seed} onChange={(e) => set('seed', e.target.value)} />
                    <FieldError>{errors.seed}</FieldError>
                  </>
                )}
              </Field>
              </div>
            </section>

            <section className="stack advanced__group" aria-labelledby="advanced-performance">
              <h3 id="advanced-performance">Desempenho</h3>
              <div className="form-grid">
                <Field label="Uso da GPU" hint="Só CPU é mais lento, mas ajuda quando a memória da GPU está ocupada.">
                  {(id) => (
                    <>
                      <Select id={id} value={form.gpuMode} options={gpuOptions} onChange={(e) => set('gpuMode', e.target.value as AgentFormValues['gpuMode'])} />
                      <FieldError>{errors.gpuMode}</FieldError>
                    </>
                  )}
                </Field>
              <Field label="Threads de CPU" hint="Vazio = o motor decide.">
                {(id) => (
                  <>
                    <TextInput id={id} type="number" min={1} step={1} value={form.cpuThreads} onChange={(e) => set('cpuThreads', e.target.value)} />
                    <FieldError>{errors.cpuThreads}</FieldError>
                  </>
                )}
              </Field>
              <Field label="Tempo limite (segundos)" hint="10 a 3.600. A geração é interrompida depois desse tempo.">
                {(id) => (
                  <>
                    <TextInput id={id} type="number" min={10} max={3600} step={1} value={form.timeoutSeconds} onChange={(e) => set('timeoutSeconds', e.target.value)} />
                    <FieldError>{errors.timeoutSeconds}</FieldError>
                  </>
                )}
              </Field>
              </div>
            </section>

            <section className="stack advanced__group" aria-labelledby="advanced-identity">
              <h3 id="advanced-identity">Identificação técnica</h3>
              <div className="form-grid">
                <Field label="ID" hint={mode === 'edit' ? 'O ID não muda após a criação.' : 'Criado a partir do nome. Minúsculas, números e hífen.'}>
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
                <Field label="Versão" hint="Só para sua organização, ex.: 1.0.0. Não muda as respostas.">
                  {(id) => (
                    <>
                      <TextInput id={id} className="mono" value={form.version} onChange={(e) => set('version', e.target.value)} />
                      <FieldError>{errors.version}</FieldError>
                    </>
                  )}
                </Field>
              </div>
            </section>

            <section className="stack advanced__group" aria-labelledby="advanced-tools">
              <h3 id="advanced-tools">Ferramentas</h3>
              <Notice tone="info">{TOOLS_PLANNED_NOTICE}</Notice>
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
                  {unknown.map((id) => (
                    <div key={id} className="unknown-tool">
                      <div className="stack" style={{ gap: 0 }}>
                        <strong className="mono">{id}</strong>
                        <span className="subtle">Não reconhecida neste aplicativo. Não pode ser ativada nem usada pelo agente.</span>
                      </div>
                      <Button onClick={() => toggleTool(id, false)}>Remover referência</Button>
                    </div>
                  ))}
                  {removed.length > 0 && (
                    <Notice tone="neutral">
                      Será removida ao salvar: <span className="mono">{removed.join(', ')}</span>. As permissões do agente não mudam. Para manter, use Cancelar.
                    </Notice>
                  )}
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
            </section>
          </div>
        </details>
      </Card>

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

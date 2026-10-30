import { validateAgentDraft, type AgentConfigState, type AgentDefinition, type AgentDraft } from '@shared/agents'
import { DEFAULT_EXECUTION_PROFILE, EXECUTION_LIMITS, type ExecutionProfile } from '@shared/execution'
import type { ModelRef } from '@shared/inference'
import { TASK_LABELS, TASK_TYPES, type TaskType } from '@shared/recommendations'
import type { StructuredError } from '@shared/errors'
import type { ToolCatalogEntry, ToolPermission } from '@shared/tools'
import type { ValidationIssue } from '@shared/validation'
import { exampleAgentProfiles } from '@renderer/data/agent-requirements'
import type { Agent } from '@renderer/data/types'
import { issuesByField } from './api'

/**
 * Valores do formulário de agente. Números ficam como texto enquanto o
 * usuário digita; a conversão para `AgentDraft` acontece só ao salvar.
 */
export interface AgentFormValues {
  id: string
  name: string
  description: string
  version: string
  instructions: string
  modelId: string
  temperature: string
  topP: string
  maxOutputTokens: string
  contextLength: string
  seed: string
  cpuThreads: string
  gpuMode: ExecutionProfile['gpuMode']
  timeoutSeconds: string
  tools: string[]
  state: AgentConfigState
  /**
   * Tipos de tarefa como foram gravados. A ordem só muda quando o usuário
   * altera a seleção (`toggledTaskTypes`).
   */
  taskTypes: TaskType[]
  /** Partes do agente que o formulário não edita, preservadas ao salvar: provedor do modelo e os demais parâmetros do perfil. */
  boundModel: ModelRef | null
  profileBase: ExecutionProfile
  /** Ferramentas e permissões gravadas: as permissões só são recalculadas se as ferramentas mudarem. */
  savedAccess: { tools: string[]; requestedPermissions: ToolPermission[] } | null
}

export type AgentFormField = keyof AgentFormValues
export type AgentFormErrors = Partial<Record<AgentFormField | 'form', string>>

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
}

/** `base`, ou `base-2`, `base-3`... até não colidir. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = (base || 'agente').slice(0, 58).replace(/-+$/, '')
  if (!taken.has(root)) return root
  for (let n = 2; ; n++) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`
}

export function emptyAgentForm(): AgentFormValues {
  return {
    id: '',
    name: '',
    description: '',
    version: '1.0.0',
    instructions: '',
    modelId: '',
    temperature: String(DEFAULT_EXECUTION_PROFILE.temperature),
    topP: String(DEFAULT_EXECUTION_PROFILE.topP),
    maxOutputTokens: '',
    contextLength: '',
    seed: '',
    cpuThreads: '',
    gpuMode: DEFAULT_EXECUTION_PROFILE.gpuMode,
    timeoutSeconds: String(DEFAULT_EXECUTION_PROFILE.timeoutSeconds),
    tools: [],
    state: 'draft',
    taskTypes: [],
    boundModel: null,
    profileBase: DEFAULT_EXECUTION_PROFILE,
    savedAccess: null
  }
}

const optionalText = (value: number | null) => (value === null ? '' : String(value))

export function formFromDefinition(def: AgentDefinition | AgentDraft): AgentFormValues {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    version: def.version,
    instructions: def.instructions,
    modelId: def.defaultModel?.modelId ?? '',
    temperature: String(def.defaultProfile.temperature),
    topP: String(def.defaultProfile.topP),
    maxOutputTokens: optionalText(def.defaultProfile.maxOutputTokens),
    contextLength: optionalText(def.defaultProfile.contextLength),
    seed: optionalText(def.defaultProfile.seed),
    cpuThreads: optionalText(def.defaultProfile.cpuThreads),
    gpuMode: def.defaultProfile.gpuMode,
    timeoutSeconds: String(def.defaultProfile.timeoutSeconds),
    tools: [...def.tools],
    state: def.state,
    taskTypes: [...def.taskTypes],
    boundModel: def.defaultModel,
    profileBase: def.defaultProfile,
    savedAccess: { tools: [...def.tools], requestedPermissions: [...def.requestedPermissions] }
  }
}

/**
 * O formulário difere do estado de partida? A ordem de ferramentas e tipos de
 * tarefa não conta (marcar e desmarcar não é alteração).
 */
export function agentFormChanged(initial: AgentFormValues, form: AgentFormValues): boolean {
  const norm = (f: AgentFormValues) => JSON.stringify({ ...f, tools: [...f.tools].sort(), taskTypes: [...f.taskTypes].sort() })
  return norm(initial) !== norm(form)
}

/**
 * Novo agente (rascunho) a partir de um exemplo da biblioteca demonstrativa.
 * O modelo do exemplo é fictício e nunca é copiado: o usuário escolhe um instalado.
 * Os tipos de tarefa vêm do perfil com o mesmo ID, o que as recomendações já usam.
 */
export function formFromExample(example: Agent, takenIds: ReadonlySet<string>, catalog: readonly ToolCatalogEntry[]): AgentFormValues {
  return {
    ...emptyAgentForm(),
    id: uniqueId(example.id, takenIds),
    name: example.name,
    description: example.description,
    tools: example.tools.filter((t) => catalog.some((e) => e.definition.id === t)),
    taskTypes: TASK_TYPES.filter((t) => exampleAgentProfiles[example.id]?.taskTypes.includes(t))
  }
}

/** Tipos de tarefa com o rótulo das recomendações, na ordem de `TASK_TYPES`. */
export const taskTypeOptions = TASK_TYPES.map((value) => ({ value, label: TASK_LABELS[value].charAt(0).toUpperCase() + TASK_LABELS[value].slice(1) }))

/**
 * Seleção depois de marcar ou desmarcar `type`, na ordem de `TASK_TYPES`.
 * Voltar ao conjunto de `original` devolve a lista original, na ordem gravada.
 */
export function toggledTaskTypes(current: readonly TaskType[], type: TaskType, selected: boolean, original: readonly TaskType[]): TaskType[] {
  const next = TASK_TYPES.filter((t) => (t === type ? selected : current.includes(t)))
  return next.length === original.length && next.every((t) => original.includes(t)) ? [...original] : next
}

/** Seleção em texto, sempre na ordem de `TASK_TYPES`. */
export function taskTypesSummary(selected: readonly TaskType[]): string {
  const labels = taskTypeOptions.filter((o) => selected.includes(o.value)).map((o) => o.label)
  return labels.length > 0 ? `Selecionados: ${labels.join(', ')}` : 'Nenhum tipo selecionado.'
}

/** Campos da área avançada, que precisa abrir quando um deles tem erro. */
const ADVANCED_FIELDS: readonly AgentFormField[] = ['id', 'version', 'temperature', 'topP', 'maxOutputTokens', 'contextLength', 'seed', 'cpuThreads', 'gpuMode', 'timeoutSeconds', 'tools']

/** Sem nome, o ID derivado dele também falha: o que falta corrigir está na área básica. */
export const hasAdvancedError = (errors: AgentFormErrors) => ADVANCED_FIELDS.some((field) => errors[field] && !(field === 'id' && errors.name))

/** O que está guardado na área avançada, para vê-lo com a seção recolhida. */
export function advancedSummary(form: AgentFormValues): string {
  const d = DEFAULT_EXECUTION_PROFILE
  const adjusted = [
    form.temperature !== String(d.temperature),
    form.topP !== String(d.topP),
    form.maxOutputTokens !== '',
    form.contextLength !== '',
    form.seed !== '',
    form.cpuThreads !== '',
    form.gpuMode !== d.gpuMode,
    form.timeoutSeconds !== String(d.timeoutSeconds)
  ].filter(Boolean).length
  const parts = [adjusted === 0 ? 'Valores padrão' : adjusted === 1 ? '1 ajuste personalizado' : `${adjusted} ajustes personalizados`]
  if (form.tools.length > 0) parts.push(form.tools.length === 1 ? '1 ferramenta declarada' : `${form.tools.length} ferramentas declaradas`)
  return parts.join(' · ')
}

/** Permissões declaradas pelas ferramentas escolhidas, em ordem estável. */
export function requestedPermissionsFor(toolIds: readonly string[], catalog: readonly ToolCatalogEntry[]): ToolPermission[] {
  const wanted = new Set(catalog.filter((e) => toolIds.includes(e.definition.id)).flatMap((e) => e.definition.permissions))
  return catalog.flatMap((e) => e.definition.permissions).filter((p, i, all) => wanted.has(p) && all.indexOf(p) === i)
}

/** Ferramentas do formulário que o catálogo não conhece. */
export const unknownTools = (toolIds: readonly string[], catalog: readonly ToolCatalogEntry[]) =>
  toolIds.filter((id) => !catalog.some((e) => e.definition.id === id))

/**
 * Permissões que serão gravadas. Enquanto as ferramentas conhecidas forem as
 * gravadas, nada muda: remover uma referência desconhecida não concede nem
 * retira permissão. Se mudarem, recalcula pelo catálogo e mantém as que nenhuma
 * ferramenta conhecida declara, porque não dá para saber a quem pertencem.
 */
export function formPermissions(form: AgentFormValues, catalog: readonly ToolCatalogEntry[]): ToolPermission[] {
  const access = form.savedAccess
  if (access === null) return requestedPermissionsFor(form.tools, catalog)
  const known = (tools: readonly string[]) => tools.filter((id) => !unknownTools([id], catalog).length)
  const saved = known(access.tools)
  const current = known(form.tools)
  if (saved.length === current.length && saved.every((t) => current.includes(t))) return [...access.requestedPermissions]
  const declared = new Set(catalog.flatMap((e) => e.definition.permissions))
  return [...requestedPermissionsFor(form.tools, catalog), ...access.requestedPermissions.filter((p) => !declared.has(p))]
}

const fieldPaths: Array<[RegExp, AgentFormField]> = [
  [/^\$\.id\b/, 'id'],
  [/^\$\.name\b/, 'name'],
  [/^\$\.description\b/, 'description'],
  [/^\$\.version\b/, 'version'],
  [/^\$\.instructions\b/, 'instructions'],
  [/^\$\.taskTypes\b/, 'taskTypes'],
  [/^\$\.defaultModel\b/, 'modelId'],
  [/^\$\.defaultProfile\.temperature\b/, 'temperature'],
  [/^\$\.defaultProfile\.topP\b/, 'topP'],
  [/^\$\.defaultProfile\.maxOutputTokens\b/, 'maxOutputTokens'],
  [/^\$\.defaultProfile\.contextLength\b/, 'contextLength'],
  [/^\$\.defaultProfile\.seed\b/, 'seed'],
  [/^\$\.defaultProfile\.cpuThreads\b/, 'cpuThreads'],
  [/^\$\.defaultProfile\.gpuMode\b/, 'gpuMode'],
  [/^\$\.defaultProfile\.timeoutSeconds\b/, 'timeoutSeconds'],
  [/^\$\.tools\b/, 'tools'],
  [/^\$\.requestedPermissions\b/, 'tools'],
  [/^\$\.state\b/, 'state']
]

const count = (n: number) => n.toLocaleString('pt-BR')
const whole = (name: 'contextLength' | 'seed' | 'cpuThreads' | 'maxOutputTokens') =>
  `Use um número inteiro de ${count(EXECUTION_LIMITS[name].min)} a ${count(EXECUTION_LIMITS[name].max)}, ou deixe vazio.`

/** Texto para quem configura o agente; o contrato fala em caminhos e identificadores. */
const FIELD_MESSAGES: Partial<Record<AgentFormField, (message: string) => string>> = {
  id: (m) => (m === 'ID já em uso' ? 'Este ID já está em uso. Escolha outro.' : 'Use só letras minúsculas, números e hífen (até 64 caracteres).'),
  name: () => 'Dê um nome ao agente.',
  version: () => 'Use o formato 1.0.0.',
  instructions: (m) => (m.includes('obrigatório') ? 'Escreva as instruções. Elas são obrigatórias no estado Pronto; para deixar para depois, use Rascunho.' : m),
  modelId: (m) => (m.includes('obrigatório') ? 'Escolha um modelo. Ele é obrigatório no estado Pronto; para deixar para depois, use Rascunho.' : m),
  taskTypes: () => 'Escolha apenas os tipos de tarefa da lista.',
  tools: (m) => (m.startsWith('ferramenta desconhecida') ? 'O agente referencia uma ferramenta não reconhecida. Remova a referência para salvar.' : m),
  temperature: () => 'Use um valor de 0 a 2.',
  topP: () => 'Use um valor de 0 a 1.',
  maxOutputTokens: () => whole('maxOutputTokens'),
  contextLength: () => whole('contextLength'),
  seed: () => whole('seed'),
  cpuThreads: () => whole('cpuThreads'),
  timeoutSeconds: () => `Use um número inteiro de ${count(EXECUTION_LIMITS.timeoutSeconds.min)} a ${count(EXECUTION_LIMITS.timeoutSeconds.max)} segundos.`
}

/** Traduz problemas do contrato (cliente ou Main) para os campos do formulário. */
export function agentFormErrors(issues: readonly ValidationIssue[]): AgentFormErrors {
  const errors: AgentFormErrors = issuesByField(issues, (path) => fieldPaths.find(([re]) => re.test(path))?.[1])
  for (const key of Object.keys(errors) as AgentFormField[]) {
    const friendly = FIELD_MESSAGES[key]
    if (friendly && errors[key]) errors[key] = friendly(errors[key])
  }
  return errors
}

/** Erro de arquivar ou restaurar pela lista, onde não há campo para mostrar a orientação. */
export function agentActionMessage(error: StructuredError): string {
  const tools = error.code === 'validation' && error.issues ? agentFormErrors(error.issues).tools : undefined
  return tools ? `${tools} Use Editar › Configurações avançadas › Ferramentas.` : error.message
}

function parseNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text.replace(',', '.'))
}

/** Modelo do formulário. O provedor só se mantém se o modelo for o mesmo; outro modelo começa sem vínculo. */
export function formModelRef(form: AgentFormValues): ModelRef | null {
  const modelId = form.modelId.trim()
  return modelId ? { providerId: form.boundModel?.modelId === modelId ? form.boundModel.providerId : null, modelId } : null
}

/**
 * Converte o formulário em `AgentDraft` e o valida com o mesmo contrato que
 * o Main usa. O Main valida de novo ao receber.
 */
export function draftFromForm(
  form: AgentFormValues,
  catalog: readonly ToolCatalogEntry[]
): { ok: true; draft: AgentDraft } | { ok: false; errors: AgentFormErrors } {
  const optional = (text: string) => (text.trim() === '' ? null : parseNumber(text))
  const draft: AgentDraft = {
    id: form.id.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    version: form.version.trim(),
    instructions: form.instructions,
    taskTypes: [...form.taskTypes],
    defaultModel: formModelRef(form),
    defaultProfile: {
      ...form.profileBase,
      temperature: parseNumber(form.temperature),
      topP: parseNumber(form.topP),
      maxOutputTokens: optional(form.maxOutputTokens),
      contextLength: optional(form.contextLength),
      seed: optional(form.seed),
      cpuThreads: optional(form.cpuThreads),
      gpuMode: form.gpuMode,
      timeoutSeconds: parseNumber(form.timeoutSeconds)
    },
    tools: [...form.tools],
    requestedPermissions: formPermissions(form, catalog),
    state: form.state
  }
  const result = validateAgentDraft(draft)
  return result.ok ? { ok: true, draft: result.value } : { ok: false, errors: agentFormErrors(result.issues) }
}

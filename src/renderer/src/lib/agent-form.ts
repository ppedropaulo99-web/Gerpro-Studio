import {
  DEFAULT_AGENT_SETTINGS,
  validateAgentDraft,
  type AgentConfigState,
  type AgentDefinition,
  type AgentDraft
} from '@shared/agents'
import type { ToolCatalogEntry, ToolPermission } from '@shared/tools'
import type { ValidationIssue } from '@shared/validation'
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
  tools: string[]
  state: AgentConfigState
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
    temperature: String(DEFAULT_AGENT_SETTINGS.temperature),
    topP: String(DEFAULT_AGENT_SETTINGS.topP),
    maxOutputTokens: '',
    tools: [],
    state: 'draft'
  }
}

export function formFromDefinition(def: AgentDefinition | AgentDraft): AgentFormValues {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    version: def.version,
    instructions: def.instructions,
    modelId: def.model?.modelId ?? '',
    temperature: String(def.settings.temperature),
    topP: String(def.settings.topP),
    maxOutputTokens: def.settings.maxOutputTokens === null ? '' : String(def.settings.maxOutputTokens),
    tools: [...def.tools],
    state: def.state
  }
}

/**
 * O formulário difere do estado de partida? A ordem das ferramentas não
 * conta (marcar e desmarcar uma ferramenta não é alteração).
 */
export function agentFormChanged(initial: AgentFormValues, form: AgentFormValues): boolean {
  const norm = (f: AgentFormValues) => JSON.stringify({ ...f, tools: [...f.tools].sort() })
  return norm(initial) !== norm(form)
}

/** Novo agente (rascunho) a partir de um exemplo da biblioteca demonstrativa. */
export function formFromExample(example: Agent, takenIds: ReadonlySet<string>, catalog: readonly ToolCatalogEntry[]): AgentFormValues {
  return {
    ...emptyAgentForm(),
    id: uniqueId(example.id, takenIds),
    name: example.name,
    description: example.description,
    modelId: example.modelId,
    tools: example.tools.filter((t) => catalog.some((e) => e.definition.id === t))
  }
}

/** Permissões declaradas pelas ferramentas escolhidas, em ordem estável. */
export function requestedPermissionsFor(toolIds: readonly string[], catalog: readonly ToolCatalogEntry[]): ToolPermission[] {
  const wanted = new Set(catalog.filter((e) => toolIds.includes(e.definition.id)).flatMap((e) => e.definition.permissions))
  return catalog.flatMap((e) => e.definition.permissions).filter((p, i, all) => wanted.has(p) && all.indexOf(p) === i)
}

const fieldPaths: Array<[RegExp, AgentFormField]> = [
  [/^\$\.id\b/, 'id'],
  [/^\$\.name\b/, 'name'],
  [/^\$\.description\b/, 'description'],
  [/^\$\.version\b/, 'version'],
  [/^\$\.instructions\b/, 'instructions'],
  [/^\$\.model\b/, 'modelId'],
  [/^\$\.settings\.temperature\b/, 'temperature'],
  [/^\$\.settings\.topP\b/, 'topP'],
  [/^\$\.settings\.maxOutputTokens\b/, 'maxOutputTokens'],
  [/^\$\.tools\b/, 'tools'],
  [/^\$\.requestedPermissions\b/, 'tools'],
  [/^\$\.state\b/, 'state']
]

/** Traduz problemas do contrato (cliente ou Main) para os campos do formulário. */
export function agentFormErrors(issues: readonly ValidationIssue[]): AgentFormErrors {
  return issuesByField(issues, (path) => fieldPaths.find(([re]) => re.test(path))?.[1])
}

function parseNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text.replace(',', '.'))
}

/**
 * Converte o formulário em `AgentDraft` e o valida com o mesmo contrato que
 * o Main usa. O Main valida de novo ao receber.
 */
export function draftFromForm(
  form: AgentFormValues,
  catalog: readonly ToolCatalogEntry[]
): { ok: true; draft: AgentDraft } | { ok: false; errors: AgentFormErrors } {
  const modelId = form.modelId.trim()
  const maxOutputTokens = form.maxOutputTokens.trim() === '' ? null : parseNumber(form.maxOutputTokens)
  const draft: AgentDraft = {
    id: form.id.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    version: form.version.trim(),
    instructions: form.instructions,
    model: modelId ? { engineId: null, modelId } : null,
    settings: { temperature: parseNumber(form.temperature), topP: parseNumber(form.topP), maxOutputTokens },
    tools: [...form.tools],
    requestedPermissions: requestedPermissionsFor(form.tools, catalog),
    state: form.state
  }
  const result = validateAgentDraft(draft)
  return result.ok ? { ok: true, draft: result.value } : { ok: false, errors: agentFormErrors(result.issues) }
}

/**
 * Contratos de agentes. Uma `AgentDefinition` é o que o usuário configura e o
 * Main persiste; `AgentAvailability` é calculada a cada leitura a partir do
 * catálogo de ferramentas e dos motores presentes, nunca gravada.
 */

import type { ToolCatalogEntry, ToolPermission } from './tools'
import { TOOL_PERMISSIONS } from './tools'
import { Checker, readSlug, SEMVER_PATTERN, type ValidationResult } from './validation'

/** Referência a um modelo. Sem `engineId`, qualquer motor que ofereça o modelo serve. */
export interface ModelReference {
  engineId: string | null
  modelId: string
}

export interface AgentSettings {
  /** 0–2 */
  temperature: number
  /** 0–1 */
  topP: number
  /** `null` usa o padrão do motor. */
  maxOutputTokens: number | null
}

/**
 * Intenção do usuário para o agente:
 * - `draft`: em edição, pode estar incompleto.
 * - `ready`: configuração completa (modelo e instruções obrigatórios).
 * - `archived`: guardado, não pode ser executado.
 */
export type AgentConfigState = 'draft' | 'ready' | 'archived'

export const AGENT_CONFIG_STATES = ['draft', 'ready', 'archived'] as const satisfies readonly AgentConfigState[]

export interface AgentDefinition {
  id: string
  name: string
  description: string
  /** Versão semântica da configuração do agente, definida pelo usuário. */
  version: string
  /** Instruções de sistema. */
  instructions: string
  model: ModelReference | null
  settings: AgentSettings
  /** IDs das ferramentas habilitadas para o agente. */
  tools: string[]
  /** Permissões que o agente pede para usar suas ferramentas. Concessão fica para etapa futura. */
  requestedPermissions: ToolPermission[]
  state: AgentConfigState
  /** Definidos pelo Main ao salvar. */
  createdAt: string
  updatedAt: string
}

/** O que o Renderer envia para criar ou atualizar um agente. */
export type AgentDraft = Omit<AgentDefinition, 'createdAt' | 'updatedAt'>

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { temperature: 0.7, topP: 0.95, maxOutputTokens: null }

export const AGENT_LIMITS = {
  name: 120,
  description: 1_000,
  instructions: 32_000,
  tools: 64
} as const

// ---------------------------------------------------------------------------
// Disponibilidade
// ---------------------------------------------------------------------------

export type AgentAvailabilityStatus = 'available' | 'unavailable' | 'archived'

export type AgentIssueCode =
  | 'draft'
  | 'missing-model'
  | 'missing-instructions'
  | 'unknown-tool'
  | 'tool-disabled'
  | 'tool-not-implemented'
  | 'missing-permission'
  | 'engine-unavailable'

export interface AgentIssue {
  code: AgentIssueCode
  message: string
  toolId?: string
  permission?: ToolPermission
}

export interface AgentAvailability {
  status: AgentAvailabilityStatus
  issues: AgentIssue[]
}

/** Agente como entregue ao Renderer: definição persistida + disponibilidade calculada. */
export interface AgentRecord {
  definition: AgentDefinition
  availability: AgentAvailability
}

export interface AvailabilityContext {
  tools: readonly ToolCatalogEntry[]
  /** Se há um motor de inferência capaz de rodar o modelo. Sempre `false` nesta etapa. */
  engineAvailable: boolean
}

export function evaluateAgentAvailability(agent: AgentDefinition, ctx: AvailabilityContext): AgentAvailability {
  if (agent.state === 'archived') return { status: 'archived', issues: [] }

  const issues: AgentIssue[] = []
  if (agent.state === 'draft') issues.push({ code: 'draft', message: 'Agente em rascunho.' })
  if (!agent.model) issues.push({ code: 'missing-model', message: 'Nenhum modelo selecionado.' })
  if (!agent.instructions.trim()) issues.push({ code: 'missing-instructions', message: 'Instruções vazias.' })

  for (const toolId of agent.tools) {
    const entry = ctx.tools.find((t) => t.definition.id === toolId)
    if (!entry) {
      issues.push({ code: 'unknown-tool', message: `Ferramenta "${toolId}" não está instalada.`, toolId })
      continue
    }
    if (entry.availability === 'disabled') {
      issues.push({ code: 'tool-disabled', message: `Ferramenta "${entry.definition.name}" está desativada.`, toolId })
    } else if (entry.availability === 'not-implemented') {
      issues.push({ code: 'tool-not-implemented', message: `Ferramenta "${entry.definition.name}" ainda não tem implementação.`, toolId })
    }
    for (const permission of entry.definition.permissions) {
      if (!agent.requestedPermissions.includes(permission)) {
        issues.push({
          code: 'missing-permission',
          message: `"${entry.definition.name}" exige a permissão ${permission}.`,
          toolId,
          permission
        })
      }
    }
  }

  if (agent.model && !ctx.engineAvailable) {
    issues.push({ code: 'engine-unavailable', message: 'Nenhum motor de inferência disponível.' })
  }

  return { status: issues.length === 0 ? 'available' : 'unavailable', issues }
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

const DRAFT_KEYS = [
  'id',
  'name',
  'description',
  'version',
  'instructions',
  'model',
  'settings',
  'tools',
  'requestedPermissions',
  'state'
] as const

function readModel(c: Checker, value: unknown, path: string): ModelReference | undefined {
  const obj = c.record(value, path, ['engineId', 'modelId'])
  if (!obj) return undefined
  const engineId = c.nullable(obj['engineId'], `${path}.engineId`, (v, p) => readSlug(c, v, p))
  const modelId = c.string(obj['modelId'], `${path}.modelId`, { min: 1, max: 200 })
  if (engineId === undefined || modelId === undefined) return undefined
  return { engineId, modelId }
}

function readSettings(c: Checker, value: unknown, path: string): AgentSettings | undefined {
  const obj = c.record(value, path, ['temperature', 'topP', 'maxOutputTokens'])
  if (!obj) return undefined
  const temperature = c.number(obj['temperature'], `${path}.temperature`, { min: 0, max: 2 })
  const topP = c.number(obj['topP'], `${path}.topP`, { min: 0, max: 1 })
  const maxOutputTokens = c.nullable(obj['maxOutputTokens'], `${path}.maxOutputTokens`, (v, p) =>
    c.number(v, p, { integer: true, min: 1, max: 1_000_000 })
  )
  if (temperature === undefined || topP === undefined || maxOutputTokens === undefined) return undefined
  return { temperature, topP, maxOutputTokens }
}

function readDraft(c: Checker, input: unknown, extraKeys: readonly string[]): AgentDraft | undefined {
  const obj = c.record(input, '$', [...DRAFT_KEYS, ...extraKeys])
  if (!obj) return undefined

  const draft = {
    id: readSlug(c, obj['id'], '$.id'),
    name: c.string(obj['name'], '$.name', { min: 1, max: AGENT_LIMITS.name }),
    description: c.string(obj['description'], '$.description', { max: AGENT_LIMITS.description }),
    version: c.string(obj['version'], '$.version', { pattern: SEMVER_PATTERN, patternMessage: 'use versão semântica, ex.: 1.0.0' }),
    instructions: c.string(obj['instructions'], '$.instructions', { max: AGENT_LIMITS.instructions }),
    model: c.nullable(obj['model'], '$.model', (v, p) => readModel(c, v, p)),
    settings: readSettings(c, obj['settings'], '$.settings'),
    tools: c.array(obj['tools'], '$.tools', (v, p) => readSlug(c, v, p), { max: AGENT_LIMITS.tools, unique: true }),
    requestedPermissions: c.array(obj['requestedPermissions'], '$.requestedPermissions', (v, p) => c.oneOf(v, p, TOOL_PERMISSIONS), {
      unique: true
    }),
    state: c.oneOf(obj['state'], '$.state', AGENT_CONFIG_STATES)
  }

  if (draft.name !== undefined && !draft.name.trim()) c.fail('$.name', 'não pode ficar em branco')
  if (draft.state === 'ready') {
    if (draft.model === null) c.fail('$.model', 'obrigatório quando o agente está pronto')
    if (draft.instructions !== undefined && !draft.instructions.trim()) c.fail('$.instructions', 'obrigatório quando o agente está pronto')
  }

  return c.ok ? (draft as AgentDraft) : undefined
}

export function validateAgentDraft(input: unknown): ValidationResult<AgentDraft> {
  const c = new Checker()
  return c.result(readDraft(c, input, []))
}

/** Valida uma definição completa, como lida do disco. */
export function validateAgentDefinition(input: unknown): ValidationResult<AgentDefinition> {
  const c = new Checker()
  const draft = readDraft(c, input, ['createdAt', 'updatedAt'])
  const obj = input as Record<string, unknown>
  const createdAt = draft && c.isoDate(obj['createdAt'], '$.createdAt')
  const updatedAt = draft && c.isoDate(obj['updatedAt'], '$.updatedAt')
  return c.result(draft && createdAt && updatedAt ? { ...draft, createdAt, updatedAt } : undefined)
}

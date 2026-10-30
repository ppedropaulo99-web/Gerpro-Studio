/**
 * Contratos de agentes. Uma `AgentDefinition` é o que o usuário configura e o
 * Main persiste; `AgentAvailability` é calculada a cada leitura a partir do
 * catálogo de ferramentas e dos provedores presentes, nunca gravada.
 *
 * O agente define identidade, instruções, finalidade e permissões, e aponta
 * um modelo e um perfil de execução PADRÃO. Cada execução pode substituí-los
 * (`RunOverrides`, em `execution.ts`). Nada aqui depende de um provedor específico.
 */

import { DEFAULT_EXECUTION_PROFILE, readExecutionProfile, type ExecutionProfile } from './execution'
import { readModelRef, type ModelRef } from './inference'
import { TASK_TYPES, type TaskType } from './recommendations'
import type { ToolCatalogEntry, ToolPermission } from './tools'
import { TOOL_PERMISSIONS } from './tools'
import { Checker, isRecord, readSlug, SEMVER_PATTERN, type ValidationResult } from './validation'

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
  /** Finalidade: tipos de tarefa para os quais o agente é indicado. Vazio = não declarado. */
  taskTypes: TaskType[]
  /** Modelo usado quando a execução não escolhe outro. */
  defaultModel: ModelRef | null
  /** Parâmetros usados quando a execução não os substitui. */
  defaultProfile: ExecutionProfile
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

/** Por que os agentes não podem ser alterados agora. */
export type AgentsStorageBlock = 'newer-version' | 'unreadable' | 'damaged' | 'backup-failed'

/** Estado do armazenamento de agentes. `block: null` significa que gravar é permitido. */
export interface AgentsStorageStatus {
  block: AgentsStorageBlock | null
}

/** Agente como entregue ao Renderer: definição persistida + disponibilidade calculada. */
export interface AgentRecord {
  definition: AgentDefinition
  availability: AgentAvailability
}

export interface AvailabilityContext {
  tools: readonly ToolCatalogEntry[]
  /** Se um motor de inferência real, pronto, tem o modelo do agente instalado. */
  engineAvailable: boolean
}

export function evaluateAgentAvailability(agent: AgentDefinition, ctx: AvailabilityContext): AgentAvailability {
  if (agent.state === 'archived') return { status: 'archived', issues: [] }

  const issues: AgentIssue[] = []
  if (agent.state === 'draft') issues.push({ code: 'draft', message: 'Agente em rascunho.' })
  if (!agent.defaultModel) issues.push({ code: 'missing-model', message: 'Nenhum modelo selecionado.' })
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

  if (agent.defaultModel && !ctx.engineAvailable) {
    issues.push({ code: 'engine-unavailable', message: 'Nenhum motor de inferência disponível com este modelo instalado.' })
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
  'taskTypes',
  'defaultModel',
  'defaultProfile',
  'tools',
  'requestedPermissions',
  'state'
] as const

function readDraft(c: Checker, input: unknown, extraKeys: readonly string[]): AgentDraft | undefined {
  const obj = c.record(input, '$', [...DRAFT_KEYS, ...extraKeys])
  if (!obj) return undefined

  const draft = {
    id: readSlug(c, obj['id'], '$.id'),
    name: c.string(obj['name'], '$.name', { min: 1, max: AGENT_LIMITS.name }),
    description: c.string(obj['description'], '$.description', { max: AGENT_LIMITS.description }),
    version: c.string(obj['version'], '$.version', { pattern: SEMVER_PATTERN, patternMessage: 'use versão semântica, ex.: 1.0.0' }),
    instructions: c.string(obj['instructions'], '$.instructions', { max: AGENT_LIMITS.instructions }),
    taskTypes: c.array(obj['taskTypes'], '$.taskTypes', (v, p) => c.oneOf(v, p, TASK_TYPES), { max: TASK_TYPES.length, unique: true }),
    defaultModel: c.nullable(obj['defaultModel'], '$.defaultModel', (v, p) => readModelRef(c, v, p)),
    defaultProfile: readExecutionProfile(c, obj['defaultProfile'], '$.defaultProfile'),
    tools: c.array(obj['tools'], '$.tools', (v, p) => readSlug(c, v, p), { max: AGENT_LIMITS.tools, unique: true }),
    requestedPermissions: c.array(obj['requestedPermissions'], '$.requestedPermissions', (v, p) => c.oneOf(v, p, TOOL_PERMISSIONS), {
      unique: true
    }),
    state: c.oneOf(obj['state'], '$.state', AGENT_CONFIG_STATES)
  }

  if (draft.name !== undefined && !draft.name.trim()) c.fail('$.name', 'não pode ficar em branco')
  if (draft.state === 'ready') {
    if (draft.defaultModel === null) c.fail('$.defaultModel', 'obrigatório quando o agente está pronto')
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

// ---------------------------------------------------------------------------
// Migração do formato gravado
// ---------------------------------------------------------------------------

/**
 * Correspondência explícita entre `engineId` da v1 e provedores reais. Vazia:
 * nenhum motor existiu na v1, então nenhum id antigo aponta para um provedor.
 */
export const LEGACY_ENGINE_PROVIDERS: Readonly<Record<string, string>> = {}

/**
 * `agents.json` v1 → v2:
 * - `model: { engineId, modelId }` → `defaultModel: { providerId, modelId }`. `engineId` só
 *   vira provedor se constar em `LEGACY_ENGINE_PROVIDERS`; sem correspondência, o modelo
 *   fica sem vínculo (`providerId: null`) e o valor antigo permanece na cópia do arquivo v1;
 * - `settings` → `defaultProfile`, com os demais parâmetros nos padrões;
 * - `taskTypes: []` (finalidade ainda não declarada).
 * Formas inesperadas seguem como estão, para a validação recusá-las e o
 * armazenamento guardar a cópia do original.
 */
function legacyProvider(engineId: unknown): unknown {
  if (typeof engineId !== 'string') return engineId
  return Object.hasOwn(LEGACY_ENGINE_PROVIDERS, engineId) ? LEGACY_ENGINE_PROVIDERS[engineId] : null
}

export function migrateAgentsV1(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data['agents'])) return data
  return {
    ...data,
    agents: data['agents'].map((agent: unknown) => {
      if (!isRecord(agent) || !('model' in agent) || !('settings' in agent)) return agent
      const { model, settings, ...rest } = agent
      return {
        ...rest,
        taskTypes: [],
        defaultModel: isRecord(model) ? { providerId: legacyProvider(model['engineId']), modelId: model['modelId'] } : model,
        defaultProfile: isRecord(settings) ? { ...DEFAULT_EXECUTION_PROFILE, ...settings } : settings
      }
    })
  }
}

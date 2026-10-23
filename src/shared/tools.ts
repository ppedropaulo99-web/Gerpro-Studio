/**
 * Contratos de ferramentas. Uma ferramenta é declarada por `ToolDefinition`
 * (o que faz, o que recebe, o que devolve e quais permissões exige) e, no
 * futuro, executada por um `ToolExecutor` registrado no Main.
 *
 * Nesta etapa nenhuma ferramenta é executada: o catálogo só descreve.
 */

import type { StructuredError } from './errors'
import type { PluginPermission } from './plugins'
import type { ValidationIssue } from './validation'
import { isRecord } from './validation'

/** Ferramentas e plugins compartilham o mesmo vocabulário de permissões. */
export type ToolPermission = PluginPermission

export const TOOL_PERMISSIONS = ['network', 'filesystem:read', 'filesystem:write', 'process'] as const satisfies readonly ToolPermission[]

/** Subconjunto de JSON Schema suficiente para descrever entradas e saídas. */
export type JsonSchema =
  | { type: 'string'; description?: string; enum?: string[]; minLength?: number; maxLength?: number }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'null'; description?: string }
  | { type: 'array'; description?: string; items: JsonSchema; maxItems?: number }
  | {
      type: 'object'
      description?: string
      properties: Record<string, JsonSchema>
      required?: string[]
      additionalProperties?: boolean
    }

export type ToolSource = 'builtin' | 'plugin'

export interface ToolDefinition {
  id: string
  name: string
  description: string
  version: string
  source: ToolSource
  /** Plugin que contribui a ferramenta, quando `source === 'plugin'`. */
  pluginId?: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  permissions: ToolPermission[]
}

/**
 * - `not-implemented`: declarada, mas sem executor (todas, nesta etapa).
 * - `disabled`: desativada pelo usuário.
 * - `available`: tem executor e está ativa.
 */
export type ToolAvailability = 'available' | 'disabled' | 'not-implemented'

export interface ToolCatalogEntry {
  definition: ToolDefinition
  enabled: boolean
  availability: ToolAvailability
}

// ---------------------------------------------------------------------------
// Execução futura (somente contrato)
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
  runId: string
  agentId: string
  /** Permissões efetivamente concedidas pelo usuário para esta execução. */
  grantedPermissions: readonly ToolPermission[]
  signal: AbortSignal
}

export type ToolExecutionResult = { ok: true; output: unknown } | { ok: false; error: StructuredError }

/**
 * Implementação de uma ferramenta. O Main deverá validar `input` contra
 * `definition.inputSchema` e conferir permissões antes de chamar `execute`.
 */
export interface ToolExecutor {
  readonly definition: ToolDefinition
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult>
}

/** Permissões exigidas pela ferramenta e ainda não concedidas. */
export function missingPermissions(definition: ToolDefinition, granted: readonly ToolPermission[]): ToolPermission[] {
  return definition.permissions.filter((p) => !granted.includes(p))
}

/** Valida um valor contra o subconjunto de JSON Schema acima. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown, path = '$'): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const fail = (p: string, message: string) => issues.push({ path: p, message })

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') fail(path, 'deve ser um texto')
      else {
        if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, `mínimo de ${schema.minLength} caracteres`)
        if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, `máximo de ${schema.maxLength} caracteres`)
        if (schema.enum && !schema.enum.includes(value)) fail(path, `deve ser um de: ${schema.enum.join(', ')}`)
      }
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'deve ser um número')
      else {
        if (schema.type === 'integer' && !Number.isInteger(value)) fail(path, 'deve ser inteiro')
        if (schema.minimum !== undefined && value < schema.minimum) fail(path, `deve ser ≥ ${schema.minimum}`)
        if (schema.maximum !== undefined && value > schema.maximum) fail(path, `deve ser ≤ ${schema.maximum}`)
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') fail(path, 'deve ser verdadeiro ou falso')
      break
    case 'null':
      if (value !== null) fail(path, 'deve ser nulo')
      break
    case 'array':
      if (!Array.isArray(value)) fail(path, 'deve ser uma lista')
      else {
        if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, `máximo de ${schema.maxItems} itens`)
        value.forEach((item, i) => issues.push(...validateAgainstSchema(schema.items, item, `${path}[${i}]`)))
      }
      break
    case 'object':
      if (!isRecord(value)) fail(path, 'deve ser um objeto')
      else {
        for (const key of schema.required ?? []) {
          if (!(key in value)) fail(`${path}.${key}`, 'campo obrigatório')
        }
        for (const [key, item] of Object.entries(value)) {
          const child = schema.properties[key]
          if (child) issues.push(...validateAgainstSchema(child, item, `${path}.${key}`))
          else if (schema.additionalProperties === false) fail(`${path}.${key}`, 'campo não permitido')
        }
      }
      break
  }
  return issues
}

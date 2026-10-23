/**
 * Perfis de execução: os parâmetros que determinam COMO um modelo roda.
 *
 * O agente guarda um modelo e um perfil padrão; cada execução pode
 * substituir o modelo e parte do perfil (`RunOverrides`). A resolução é pura e
 * acontece no Main, ao iniciar a execução, contra o inventário real do provedor.
 *
 * O perfil fica embutido no agente. Perfis nomeados e reutilizáveis ficam para
 * quando houver onde guardá-los.
 */

import {
  readModelRef,
  sameModel,
  type ModelRef,
  type ProviderModelEntry,
  type ResolvedModelRef
} from './inference'
import { Checker, type ValidationResult } from './validation'

/**
 * Valores de configuração, não medições. Repassados ao provedor, exceto
 * `timeoutSeconds`, que o próprio app aplica (cancela a geração ao esgotar).
 */
export interface ExecutionProfile {
  /** 0–2 */
  temperature: number
  /** 0–1 */
  topP: number
  /** `null` usa o padrão do provedor. */
  maxOutputTokens: number | null
  /** Janela de contexto pedida; `null` usa o padrão do provedor. */
  contextLength: number | null
  /** Semente para respostas reproduzíveis; `null` = aleatória. */
  seed: number | null
  /** Threads de CPU; `null` deixa o provedor decidir. */
  cpuThreads: number | null
  /** `cpu-only` impede o uso da GPU (útil quando a VRAM está ocupada). */
  gpuMode: 'auto' | 'cpu-only'
  /** Limite de tempo da geração, aplicado pelo app. */
  timeoutSeconds: number
}

export const GPU_MODES = ['auto', 'cpu-only'] as const

export const EXECUTION_LIMITS = {
  maxOutputTokens: { min: 1, max: 1_000_000 },
  contextLength: { min: 256, max: 1_048_576 },
  seed: { min: 0, max: 2 ** 31 - 1 },
  cpuThreads: { min: 1, max: 256 },
  timeoutSeconds: { min: 10, max: 3_600 }
} as const

export const DEFAULT_EXECUTION_PROFILE: ExecutionProfile = {
  temperature: 0.7,
  topP: 0.95,
  maxOutputTokens: null,
  contextLength: null,
  seed: null,
  cpuThreads: null,
  gpuMode: 'auto',
  timeoutSeconds: 300
}

const PROFILE_KEYS = Object.keys(DEFAULT_EXECUTION_PROFILE) as Array<keyof ExecutionProfile>

/** Substituição parcial do perfil para uma única execução. */
export type ExecutionProfileOverride = Partial<ExecutionProfile>

/** O que uma execução pode substituir em relação ao padrão do agente. `null` = usa o padrão. */
export interface RunOverrides {
  model: ModelRef | null
  profile: ExecutionProfileOverride | null
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

type FieldReader = (c: Checker, value: unknown, path: string) => unknown

const optionalInt = (limits: { min: number; max: number }): FieldReader => (c, v, p) =>
  c.nullable(v, p, (x, q) => c.number(x, q, { integer: true, ...limits }))

const FIELD_READERS: Record<keyof ExecutionProfile, FieldReader> = {
  temperature: (c, v, p) => c.number(v, p, { min: 0, max: 2 }),
  topP: (c, v, p) => c.number(v, p, { min: 0, max: 1 }),
  maxOutputTokens: optionalInt(EXECUTION_LIMITS.maxOutputTokens),
  contextLength: optionalInt(EXECUTION_LIMITS.contextLength),
  seed: optionalInt(EXECUTION_LIMITS.seed),
  cpuThreads: optionalInt(EXECUTION_LIMITS.cpuThreads),
  gpuMode: (c, v, p) => c.oneOf(v, p, GPU_MODES),
  timeoutSeconds: (c, v, p) => c.number(v, p, { integer: true, ...EXECUTION_LIMITS.timeoutSeconds })
}

/** Lê os campos presentes; com `complete`, todos são obrigatórios. */
function readProfileFields(c: Checker, value: unknown, path: string, complete: boolean): ExecutionProfileOverride | undefined {
  const obj = c.record(value, path, PROFILE_KEYS)
  if (!obj) return undefined
  const out: Record<string, unknown> = {}
  for (const key of PROFILE_KEYS) {
    if (!(key in obj)) {
      if (complete) c.fail(`${path}.${key}`, 'obrigatório')
      continue
    }
    out[key] = FIELD_READERS[key](c, obj[key], `${path}.${key}`)
  }
  return c.ok ? (out as ExecutionProfileOverride) : undefined
}

export function readExecutionProfile(c: Checker, value: unknown, path: string): ExecutionProfile | undefined {
  return readProfileFields(c, value, path, true) as ExecutionProfile | undefined
}

export function readRunOverrides(c: Checker, value: unknown, path: string): RunOverrides | undefined {
  const obj = c.record(value, path, ['model', 'profile'])
  if (!obj) return undefined
  const model = c.nullable(obj['model'], `${path}.model`, (v, p) => readModelRef(c, v, p))
  const profile = c.nullable(obj['profile'], `${path}.profile`, (v, p) => readProfileFields(c, v, p, false))
  if (profile && Object.keys(profile).length === 0) c.fail(`${path}.profile`, 'vazio; use null para manter o padrão')
  return model !== undefined && profile !== undefined && c.ok ? { model, profile } : undefined
}

export function validateExecutionProfile(input: unknown): ValidationResult<ExecutionProfile> {
  const c = new Checker()
  return c.result(readExecutionProfile(c, input, '$'))
}

// ---------------------------------------------------------------------------
// Resolução
// ---------------------------------------------------------------------------

/** Modelo e perfil efetivos de uma execução, com o que foi substituído. */
export interface ResolvedExecution {
  model: ResolvedModelRef
  profile: ExecutionProfile
  overridden: { model: boolean; profile: boolean }
}

export type ExecutionResolutionError =
  | { code: 'no-model'; message: string }
  | { code: 'model-not-installed'; message: string }
  | { code: 'ambiguous-provider'; message: string }

export function applyProfileOverride(base: ExecutionProfile, override: ExecutionProfileOverride | null): ExecutionProfile {
  return override ? { ...base, ...override } : base
}

/**
 * Combina o padrão do agente com as substituições da execução e vincula o
 * modelo a um provedor do inventário. Só modelos instalados servem; um
 * `modelId` sem provedor oferecido por mais de um provedor é ambíguo.
 */
export function resolveExecution(
  defaults: { model: ModelRef | null; profile: ExecutionProfile },
  overrides: RunOverrides | null,
  inventory: readonly ProviderModelEntry[]
): { ok: true; value: ResolvedExecution } | { ok: false; error: ExecutionResolutionError } {
  const wanted = overrides?.model ?? defaults.model
  if (!wanted) return { ok: false, error: { code: 'no-model', message: 'Nenhum modelo definido para o agente nem para a execução.' } }

  const installed = inventory.filter((e) => e.availability === 'installed')
  const matches = installed.filter((e) =>
    wanted.providerId === null ? e.model.ref.modelId === wanted.modelId : sameModel(e.model.ref, wanted)
  )
  if (matches.length === 0) {
    return { ok: false, error: { code: 'model-not-installed', message: `O modelo "${wanted.modelId}" não está instalado em nenhum provedor disponível.` } }
  }
  if (matches.length > 1) {
    return { ok: false, error: { code: 'ambiguous-provider', message: `O modelo "${wanted.modelId}" existe em mais de um provedor; escolha qual usar.` } }
  }

  return {
    ok: true,
    value: {
      model: matches[0]!.model.ref,
      profile: applyProfileOverride(defaults.profile, overrides?.profile ?? null),
      overridden: { model: overrides?.model != null, profile: overrides?.profile != null }
    }
  }
}

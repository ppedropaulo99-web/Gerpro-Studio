/**
 * Configurações do aplicativo persistidas pelo Main. Os campos espelham a
 * tela de Configurações. Nenhum campo guarda credenciais: segredos ficam no
 * cofre cifrado do Main e são referenciados por ID.
 */

import { Checker, readSlug, type ValidationResult } from './validation'

export const LANGUAGES = ['pt-BR', 'en-US', 'es'] as const
export const DENSITIES = ['comfortable', 'compact'] as const

export interface AppSettings {
  general: {
    language: (typeof LANGUAGES)[number]
    density: (typeof DENSITIES)[number]
    /** Apenas gravado; o registro no sistema operacional fica para etapa futura. */
    startOnLogin: boolean
  }
  models: {
    /** `null` usa a pasta padrão. */
    directory: string | null
    maxRamGb: number
  }
  privacy: {
    /** Inativo nesta versão: ver `INACTIVE_PRIVACY_SETTINGS`. */
    confirmSensitiveTools: boolean
    /** Inativo nesta versão: nenhum dado é enviado. */
    telemetry: boolean
  }
  tools: {
    /** Preferência por ferramenta. Ausente = padrão do catálogo. */
    enabled: Record<string, boolean>
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: { language: 'pt-BR', density: 'comfortable', startOnLogin: false },
  models: { directory: null, maxRamGb: 16 },
  privacy: { confirmSensitiveTools: true, telemetry: false },
  tools: { enabled: {} }
}

// ---------------------------------------------------------------------------
// Preferências de segurança e privacidade ainda inativas
// ---------------------------------------------------------------------------

/**
 * Preferências de segurança e privacidade sem função nesta versão. Enquanto
 * estiverem aqui:
 * - o Main recusa alterá-las (`inactiveSettingsInPatch`);
 * - valores já gravados são preservados, mas NÃO valem como decisão:
 *   `effectivePrivacy` devolve sempre os valores seguros.
 *
 * Ao implementar uma delas, não leia o valor gravado como consentimento:
 * peça uma nova decisão explícita ao usuário (com versão própria) e só
 * então retire a preferência desta lista.
 */
export const INACTIVE_PRIVACY_SETTINGS = ['confirmSensitiveTools', 'telemetry'] as const satisfies ReadonlyArray<keyof AppSettings['privacy']>
export type InactivePrivacySetting = (typeof INACTIVE_PRIVACY_SETTINGS)[number]

/** Valores que valem enquanto as funções não existem: confirmação exigida, nenhum envio. */
export const SAFE_PRIVACY_VALUES: Readonly<Pick<AppSettings['privacy'], InactivePrivacySetting>> = {
  confirmSensitiveTools: true,
  telemetry: false
}

/** Preferências de privacidade efetivas: as inativas assumem sempre o valor seguro. */
export function effectivePrivacy(settings: AppSettings): AppSettings['privacy'] {
  return { ...settings.privacy, ...SAFE_PRIVACY_VALUES }
}

/** Preferências inativas que uma alteração tenta mudar. */
export function inactiveSettingsInPatch(patch: SettingsPatch): InactivePrivacySetting[] {
  return INACTIVE_PRIVACY_SETTINGS.filter((key) => patch.privacy?.[key] !== undefined)
}

/** Alteração parcial, um nível por seção. */
export interface SettingsPatch {
  general?: Partial<AppSettings['general']>
  models?: Partial<AppSettings['models']>
  privacy?: Partial<AppSettings['privacy']>
  tools?: { enabled?: Record<string, boolean> }
}

const MAX_TOOL_PREFS = 256

type Section = keyof AppSettings

const readers: { [K in Section]: { [F in keyof AppSettings[K]]: (c: Checker, v: unknown, p: string) => AppSettings[K][F] | undefined } } = {
  general: {
    language: (c, v, p) => c.oneOf(v, p, LANGUAGES),
    density: (c, v, p) => c.oneOf(v, p, DENSITIES),
    startOnLogin: (c, v, p) => c.boolean(v, p)
  },
  models: {
    directory: (c, v, p) => c.nullable(v, p, (x, q) => c.string(x, q, { min: 1, max: 1024 })),
    maxRamGb: (c, v, p) => c.number(v, p, { integer: true, min: 1, max: 4096 })
  },
  privacy: {
    confirmSensitiveTools: (c, v, p) => c.boolean(v, p),
    telemetry: (c, v, p) => c.boolean(v, p)
  },
  tools: {
    enabled: (c, v, p) => {
      const obj = c.record(v, p)
      if (!obj) return undefined
      const entries = Object.entries(obj)
      if (entries.length > MAX_TOOL_PREFS) return c.fail(p, `no máximo ${MAX_TOOL_PREFS} ferramentas`)
      const out: Record<string, boolean> = {}
      for (const [id, flag] of entries) {
        const key = readSlug(c, id, `${p}.${id}`)
        const value = c.boolean(flag, `${p}.${id}`)
        if (key !== undefined && value !== undefined) out[key] = value
      }
      return out
    }
  }
}

const SECTIONS = Object.keys(readers) as Section[]

function readSection(c: Checker, section: Section, value: unknown, partial: boolean): Record<string, unknown> | undefined {
  const fields = readers[section] as Record<string, (c: Checker, v: unknown, p: string) => unknown>
  const obj = c.record(value, `$.${section}`, Object.keys(fields))
  if (!obj) return undefined
  const out: Record<string, unknown> = {}
  for (const [field, read] of Object.entries(fields)) {
    const path = `$.${section}.${field}`
    if (!(field in obj)) {
      if (!partial) c.fail(path, 'campo obrigatório')
      continue
    }
    const parsed = read(c, obj[field], path)
    if (parsed !== undefined) out[field] = parsed
  }
  return out
}

export function validateSettings(input: unknown): ValidationResult<AppSettings> {
  const c = new Checker()
  const obj = c.record(input, '$', SECTIONS)
  if (!obj) return c.result<AppSettings>(undefined)
  const out: Record<string, unknown> = {}
  for (const section of SECTIONS) out[section] = readSection(c, section, obj[section], false)
  return c.result(c.ok ? (out as unknown as AppSettings) : undefined)
}

export function validateSettingsPatch(input: unknown): ValidationResult<SettingsPatch> {
  const c = new Checker()
  const obj = c.record(input, '$', SECTIONS)
  if (!obj) return c.result<SettingsPatch>(undefined)
  const out: Record<string, unknown> = {}
  for (const section of SECTIONS) {
    if (section in obj) out[section] = readSection(c, section, obj[section], true)
  }
  return c.result(c.ok ? (out as SettingsPatch) : undefined)
}

export function applySettingsPatch(settings: AppSettings, patch: SettingsPatch): AppSettings {
  return {
    general: { ...settings.general, ...patch.general },
    models: { ...settings.models, ...patch.models },
    privacy: { ...settings.privacy, ...patch.privacy },
    tools: { enabled: { ...settings.tools.enabled, ...patch.tools?.enabled } }
  }
}

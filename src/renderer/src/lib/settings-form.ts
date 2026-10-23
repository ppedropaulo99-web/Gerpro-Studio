import { validateSettingsPatch, type AppSettings, type SettingsPatch } from '@shared/settings'
import { issuesByField } from './api'

/** Valores da tela de Configurações; números ficam como texto durante a edição. */
export interface SettingsFormValues {
  language: AppSettings['general']['language']
  density: AppSettings['general']['density']
  startOnLogin: boolean
  /** Vazio = pasta padrão. */
  modelsDirectory: string
  maxRamGb: string
  confirmSensitiveTools: boolean
  telemetry: boolean
}

export type SettingsFormErrors = Partial<Record<keyof SettingsFormValues | 'form', string>>

export function formFromSettings(s: AppSettings): SettingsFormValues {
  return {
    language: s.general.language,
    density: s.general.density,
    startOnLogin: s.general.startOnLogin,
    modelsDirectory: s.models.directory ?? '',
    maxRamGb: String(s.models.maxRamGb),
    confirmSensitiveTools: s.privacy.confirmSensitiveTools,
    telemetry: s.privacy.telemetry
  }
}

const fieldOf = (path: string): keyof SettingsFormValues | undefined =>
  (
    {
      '$.general.language': 'language',
      '$.general.density': 'density',
      '$.general.startOnLogin': 'startOnLogin',
      '$.models.directory': 'modelsDirectory',
      '$.models.maxRamGb': 'maxRamGb',
      '$.privacy.confirmSensitiveTools': 'confirmSensitiveTools',
      '$.privacy.telemetry': 'telemetry'
    } as const
  )[path]

export function settingsFormErrors(issues: Parameters<typeof issuesByField>[0]): SettingsFormErrors {
  return issuesByField(issues, fieldOf)
}

/**
 * Monta a alteração com apenas os campos que mudaram em relação ao que está
 * salvo, já validada pelo contrato. `changed: false` quando não há nada a gravar.
 */
export function patchFromForm(
  saved: AppSettings,
  form: SettingsFormValues
): { ok: true; patch: SettingsPatch; changed: boolean } | { ok: false; errors: SettingsFormErrors } {
  const directory = form.modelsDirectory.trim() || null
  const maxRamGb = form.maxRamGb.trim() === '' ? Number.NaN : Number(form.maxRamGb)

  const general: NonNullable<SettingsPatch['general']> = {}
  if (form.language !== saved.general.language) general.language = form.language
  if (form.density !== saved.general.density) general.density = form.density
  if (form.startOnLogin !== saved.general.startOnLogin) general.startOnLogin = form.startOnLogin

  const models: NonNullable<SettingsPatch['models']> = {}
  if (directory !== saved.models.directory) models.directory = directory
  if (maxRamGb !== saved.models.maxRamGb) models.maxRamGb = maxRamGb

  const privacy: NonNullable<SettingsPatch['privacy']> = {}
  if (form.confirmSensitiveTools !== saved.privacy.confirmSensitiveTools) privacy.confirmSensitiveTools = form.confirmSensitiveTools
  if (form.telemetry !== saved.privacy.telemetry) privacy.telemetry = form.telemetry

  const patch: SettingsPatch = {}
  if (Object.keys(general).length) patch.general = general
  if (Object.keys(models).length) patch.models = models
  if (Object.keys(privacy).length) patch.privacy = privacy

  const result = validateSettingsPatch(patch)
  if (!result.ok) return { ok: false, errors: settingsFormErrors(result.issues) }
  return { ok: true, patch: result.value, changed: Object.keys(patch).length > 0 }
}

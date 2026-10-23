import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  inactiveSettingsInPatch,
  validateSettings,
  validateSettingsPatch,
  type AppSettings
} from '@shared/settings'
import { AppError, unwrap } from '../errors'
import { VersionedStore, type StoreStatus } from '../storage/versioned-store'

export const SETTINGS_FORMAT_VERSION = 1

export class SettingsService {
  private readonly store: VersionedStore<AppSettings>

  constructor(filePath: string, now?: () => Date) {
    this.store = new VersionedStore({
      filePath,
      format: 'gerpro.settings',
      version: SETTINGS_FORMAT_VERSION,
      defaults: () => structuredClone(DEFAULT_SETTINGS),
      parse: (data) => {
        const result = validateSettings(data)
        return result.ok ? { value: result.value, issues: [] } : { value: undefined, issues: result.issues }
      },
      now
    })
  }

  async init(): Promise<StoreStatus> {
    await this.store.load()
    return this.store.status
  }

  get(): AppSettings {
    return this.store.get()
  }

  /** Recebe dados não confiáveis (vindos do IPC) e valida antes de gravar. */
  async update(patch: unknown): Promise<AppSettings> {
    const valid = unwrap(validateSettingsPatch(patch))
    // Preferências sem função não podem ser alteradas: um valor escolhido hoje
    // viraria decisão efetiva quando a função existisse.
    const inactive = inactiveSettingsInPatch(valid)
    if (inactive.length > 0) {
      throw new AppError('invalid-state', 'Esta preferência ainda não tem função nesta versão e não pode ser alterada.', {
        details: { fields: inactive.join(', ') }
      })
    }
    return this.store.update((current) => applySettingsPatch(current, valid))
  }
}

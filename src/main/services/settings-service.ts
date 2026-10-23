import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  validateSettings,
  validateSettingsPatch,
  type AppSettings
} from '@shared/settings'
import { unwrap } from '../errors'
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
    return this.store.update((current) => applySettingsPatch(current, valid))
  }
}

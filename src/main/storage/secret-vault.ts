import { Checker, isRecord, readSlug } from '@shared/validation'
import { AppError } from '../errors'
import { VersionedStore, type ParseOutcome } from './versioned-store'

/**
 * Cofre de credenciais. Segredos só chegam ao disco cifrados pelo sistema
 * operacional (Electron `safeStorage`: DPAPI no Windows, Keychain no macOS).
 * Sem cifra disponível, o cofre se recusa a gravar: nunca há texto puro.
 *
 * Não é exposto ao Renderer nesta etapa; agentes e configurações guardam
 * apenas o ID do segredo.
 */

export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(cipher: Buffer): string
}

interface VaultData {
  entries: Record<string, { ciphertext: string; updatedAt: string }>
}

const MAX_SECRET_LENGTH = 16_384

function parseVault(data: unknown): ParseOutcome<VaultData> {
  const c = new Checker()
  const obj = c.record(data, '$', ['entries'])
  const entries: VaultData['entries'] = {}
  if (obj && isRecord(obj['entries'])) {
    for (const [id, entry] of Object.entries(obj['entries'])) {
      const path = `$.entries.${id}`
      const e = c.record(entry, path, ['ciphertext', 'updatedAt'])
      const key = readSlug(c, id, path)
      const ciphertext = e && c.string(e['ciphertext'], `${path}.ciphertext`, { min: 1, pattern: /^[A-Za-z0-9+/]+=*$/ })
      const updatedAt = e && c.isoDate(e['updatedAt'], `${path}.updatedAt`)
      if (key && ciphertext && updatedAt) entries[key] = { ciphertext, updatedAt }
    }
  } else if (obj) {
    c.fail('$.entries', 'deve ser um objeto')
  }
  return { value: obj ? { entries } : undefined, issues: c.issues }
}

export class SecretVault {
  private readonly store: VersionedStore<VaultData>
  private readonly cipher: SecretCipher

  constructor(filePath: string, cipher: SecretCipher, now?: () => Date) {
    this.cipher = cipher
    this.store = new VersionedStore({
      filePath,
      format: 'gerpro.secrets',
      version: 1,
      defaults: () => ({ entries: {} }),
      parse: parseVault,
      now
    })
  }

  isAvailable(): boolean {
    return this.cipher.isAvailable()
  }

  async has(id: string): Promise<boolean> {
    return id in (await this.store.load()).entries
  }

  async set(id: string, secret: string): Promise<void> {
    this.assertAvailable()
    const c = new Checker()
    readSlug(c, id, '$.id')
    c.string(secret, '$.secret', { min: 1, max: MAX_SECRET_LENGTH })
    if (!c.ok) throw AppError.validation(c.issues)

    const ciphertext = this.cipher.encrypt(secret).toString('base64')
    const updatedAt = new Date().toISOString()
    await this.store.update((d) => ({ entries: { ...d.entries, [id]: { ciphertext, updatedAt } } }))
  }

  async get(id: string): Promise<string | null> {
    this.assertAvailable()
    const entry = (await this.store.load()).entries[id]
    return entry ? this.cipher.decrypt(Buffer.from(entry.ciphertext, 'base64')) : null
  }

  async delete(id: string): Promise<void> {
    await this.store.update((d) => {
      const entries = { ...d.entries }
      delete entries[id]
      return { entries }
    })
  }

  private assertAvailable(): void {
    if (!this.cipher.isAvailable()) {
      throw new AppError('secret-storage-unavailable', 'Criptografia do sistema indisponível; credenciais não serão gravadas.')
    }
  }
}

import { copyFile } from 'node:fs/promises'
import { isRecord, type ValidationIssue } from '@shared/validation'
import { AppError } from '../errors'
import { readTextFileIfExists, writeFileAtomic } from './atomic-file'

/**
 * Arquivo JSON versionado, lido e gravado só pelo Main.
 *
 * Formato no disco:
 *   { "format": "gerpro.agents", "formatVersion": 1, "savedAt": "...", "data": { ... } }
 *
 * - Arquivo ausente: começa com os valores padrão.
 * - JSON corrompido ou dados inválidos: o original é copiado para
 *   `<nome>.invalid-<data>.json` antes de qualquer nova gravação.
 * - Versão mais nova que a suportada: carrega os padrões e bloqueia gravações,
 *   para não destruir dados de uma versão futura do app.
 * - Versão mais antiga: aplica as migrações em sequência.
 */

/** Resultado de uma validação tolerante: `value` pode vir parcialmente recuperado. */
export interface ParseOutcome<T> {
  value: T | undefined
  issues: ValidationIssue[]
}

export type Migration = (data: unknown) => unknown

export interface VersionedStoreOptions<T> {
  filePath: string
  format: string
  version: number
  defaults: () => T
  parse: (data: unknown) => ParseOutcome<T>
  /** `migrations[n]` converte dados da versão `n` para `n + 1`. */
  migrations?: Record<number, Migration>
  now?: () => Date
  log?: (message: string) => void
}

export type StoreLoadState = 'not-loaded' | 'missing' | 'loaded' | 'migrated' | 'recovered' | 'read-only'

export interface StoreStatus {
  state: StoreLoadState
  /** Problemas encontrados no carregamento, se houver. */
  issues: ValidationIssue[]
  /** Cópia do arquivo original quando ele precisou ser recuperado. */
  backupPath: string | null
}

export class VersionedStore<T> {
  private readonly options: VersionedStoreOptions<T>
  private value: T | undefined
  private loading: Promise<T> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private currentStatus: StoreStatus = { state: 'not-loaded', issues: [], backupPath: null }

  constructor(options: VersionedStoreOptions<T>) {
    this.options = options
  }

  get status(): StoreStatus {
    return this.currentStatus
  }

  /** Lê do disco uma única vez; depois devolve sempre o valor atual em memória. */
  async load(): Promise<T> {
    this.loading ??= this.readFromDisk().then((value) => (this.value = value))
    await this.loading
    return this.get()
  }

  /** Valor carregado. Exige `load()` antes. */
  get(): T {
    if (this.value === undefined) throw new Error(`Armazenamento ${this.options.format} usado antes de load()`)
    return this.value
  }

  /**
   * Aplica uma alteração e grava. Gravações são serializadas; se a escrita
   * falhar, o valor em memória continua o anterior.
   */
  update(mutate: (current: T) => T): Promise<T> {
    const run = async () => {
      const current = await this.load()
      if (this.currentStatus.state === 'read-only') {
        throw new AppError('storage-read-only', 'Os dados foram gravados por uma versão mais nova do aplicativo e não serão sobrescritos.')
      }
      const next = mutate(current)
      const check = this.options.parse(next)
      if (check.issues.length > 0 || check.value === undefined) {
        throw AppError.validation(check.issues)
      }
      await this.write(check.value)
      this.value = check.value
      return check.value
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async write(data: T): Promise<void> {
    const envelope = {
      format: this.options.format,
      formatVersion: this.options.version,
      savedAt: this.now().toISOString(),
      data
    }
    try {
      await writeFileAtomic(this.options.filePath, `${JSON.stringify(envelope, null, 2)}\n`)
    } catch (error) {
      this.log(`falha ao gravar ${this.options.filePath}: ${String(error)}`)
      throw new AppError('storage', 'Não foi possível gravar os dados no disco.', { retryable: true })
    }
  }

  private async readFromDisk(): Promise<T> {
    const { filePath, format, version } = this.options
    let text: string | null
    try {
      text = await readTextFileIfExists(filePath)
    } catch (error) {
      // Erro de leitura (permissão, disco): não arrisca sobrescrever o que existe.
      this.log(`falha ao ler ${filePath}: ${String(error)}`)
      return this.settle('read-only', this.options.defaults(), [{ path: '$', message: 'arquivo ilegível' }])
    }

    if (text === null) return this.settle('missing', this.options.defaults())

    let envelope: unknown
    try {
      envelope = JSON.parse(text)
    } catch {
      return this.recover(this.options.defaults(), [{ path: '$', message: 'JSON corrompido' }])
    }

    if (!isRecord(envelope) || envelope['format'] !== format || !('data' in envelope)) {
      return this.recover(this.options.defaults(), [{ path: '$', message: `não é um arquivo ${format}` }])
    }
    const fileVersion = envelope['formatVersion']
    if (typeof fileVersion !== 'number' || !Number.isInteger(fileVersion) || fileVersion < 1) {
      return this.recover(this.options.defaults(), [{ path: '$.formatVersion', message: 'versão ausente ou inválida' }])
    }
    if (fileVersion > version) {
      this.log(`${filePath} tem formato v${fileVersion}; suportado até v${version}. Gravação bloqueada.`)
      return this.settle('read-only', this.options.defaults(), [
        { path: '$.formatVersion', message: `versão ${fileVersion} é mais nova que a suportada (${version})` }
      ])
    }

    let data = envelope['data']
    for (let v = fileVersion; v < version; v++) {
      const migrate = this.options.migrations?.[v]
      if (!migrate) return this.recover(this.options.defaults(), [{ path: '$.formatVersion', message: `sem migração de v${v}` }])
      data = migrate(data)
    }

    const parsed = this.options.parse(data)
    if (parsed.value === undefined) return this.recover(this.options.defaults(), parsed.issues)
    if (parsed.issues.length > 0) return this.recover(parsed.value, parsed.issues)
    return this.settle(fileVersion < version ? 'migrated' : 'loaded', parsed.value)
  }

  private async recover(value: T, issues: ValidationIssue[]): Promise<T> {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    const backupPath = this.options.filePath.replace(/\.json$/i, '') + `.invalid-${stamp}.json`
    try {
      await copyFile(this.options.filePath, backupPath)
    } catch (error) {
      // Sem cópia de segurança, não sobrescreve o original.
      this.log(`não foi possível copiar ${this.options.filePath}: ${String(error)}`)
      return this.settle('read-only', value, issues)
    }
    this.log(`${this.options.filePath} inválido; cópia em ${backupPath}`)
    return this.settle('recovered', value, issues, backupPath)
  }

  private settle(state: StoreLoadState, value: T, issues: ValidationIssue[] = [], backupPath: string | null = null): T {
    this.currentStatus = { state, issues, backupPath }
    return value
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private log(message: string): void {
    ;(this.options.log ?? console.warn)(`[storage] ${message}`)
  }
}

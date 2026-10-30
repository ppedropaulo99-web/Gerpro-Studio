import { constants } from 'node:fs'
import { copyFile, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
 * - Com `protectOnRecovery`, dados inválidos também bloqueiam gravações, e cópias
 *   de conteúdo idêntico não se repetem.
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
  /**
   * Copia o arquivo original (`<nome>.v<versão>-<data>.json`) antes de usar
   * dados migrados. Para migrações que descartam valores sem equivalente.
   */
  backupBeforeMigration?: boolean
  /**
   * Dados inválidos bloqueiam gravações até o arquivo ser corrigido: sem isso, o
   * primeiro salvamento regrava só o que foi aproveitado. Vale para quem não pode
   * perder registros recusados; os demais arquivos continuam gravando.
   */
  protectOnRecovery?: boolean
  /** Escrita do arquivo; padrão `writeFileAtomic`. Substituível só para simular falhas em testes. */
  writer?: (filePath: string, contents: string) => Promise<void>
  /** Cópia de `protectOnRecovery`; não sobrescreve o destino. Substituível só para simular falhas em testes. */
  copier?: (source: string, target: string) => Promise<void>
  now?: () => Date
  log?: (message: string) => void
}

export type StoreLoadState = 'not-loaded' | 'missing' | 'loaded' | 'migrated' | 'recovered' | 'read-only'

/** Por que as gravações estão bloqueadas. */
export type StoreWriteBlock = 'newer-version' | 'unreadable' | 'damaged' | 'backup-failed'

const WRITE_BLOCKED: Record<StoreWriteBlock, string> = {
  'newer-version': 'Os dados foram gravados por uma versão mais nova do aplicativo e não serão sobrescritos.',
  unreadable: 'Os dados não puderam ser lidos e não serão sobrescritos.',
  damaged: 'Os dados têm registros que não puderam ser lidos. As alterações estão bloqueadas para não perdê-los.',
  'backup-failed': 'Não foi possível guardar uma cópia dos dados. As alterações estão bloqueadas para não perdê-los.'
}

export interface StoreStatus {
  state: StoreLoadState
  /** Motivo do bloqueio de gravações; `null` quando gravar é permitido. */
  writeBlock: StoreWriteBlock | null
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
  private currentStatus: StoreStatus = { state: 'not-loaded', writeBlock: null, issues: [], backupPath: null }

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
      const { writeBlock } = this.currentStatus
      if (writeBlock) throw new AppError('storage-read-only', WRITE_BLOCKED[writeBlock])
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
      await (this.options.writer ?? writeFileAtomic)(this.options.filePath,`${JSON.stringify(envelope, null, 2)}\n`)
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
      return this.settle('read-only', this.options.defaults(), [{ path: '$', message: 'arquivo ilegível' }], null, 'unreadable')
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
      const issues = [{ path: '$.formatVersion', message: `versão ${fileVersion} é mais nova que a suportada (${version})` }]
      return this.settle('read-only', this.options.defaults(), issues, null, 'newer-version')
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
    if (fileVersion < version) {
      const backupPath = this.options.backupBeforeMigration ? await this.backup(`v${fileVersion}`) : null
      if (backupPath === undefined) return this.settle('read-only', parsed.value, [], null, 'backup-failed')
      return this.settle('migrated', parsed.value, [], backupPath)
    }
    return this.settle('loaded', parsed.value)
  }

  /** Copia o original; `undefined` se a cópia falhar (o original então não é sobrescrito). */
  private async backup(label: string): Promise<string | undefined> {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    const backupPath = this.options.filePath.replace(/\.json$/i, '') + `.${label}-${stamp}.json`
    try {
      await copyFile(this.options.filePath, backupPath)
      return backupPath
    } catch (error) {
      this.log(`não foi possível copiar ${this.options.filePath}: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Guarda o original sem repetir conteúdo: uma cópia byte a byte igual é
   * reaproveitada. Cópias existentes nunca são sobrescritas, e a nova só vale
   * depois de conferida. `undefined` se não houver cópia confirmada.
   */
  private async preservedCopy(): Promise<string | undefined> {
    const { filePath, copier } = this.options
    const folder = dirname(filePath)
    const name = basename(filePath).replace(/\.json$/i, '')
    const copy = copier ?? ((source: string, target: string) => copyFile(source, target, constants.COPYFILE_EXCL))
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    try {
      const original = await readFile(filePath)
      for (const entry of await readdir(folder)) {
        if (!entry.startsWith(`${name}.invalid-`) || !entry.endsWith('.json')) continue
        if ((await readFile(join(folder, entry))).equals(original)) return join(folder, entry)
      }
      for (let n = 1; ; n++) {
        const target = join(folder, `${name}.invalid-${stamp}${n > 1 ? `-${n}` : ''}.json`)
        try {
          await copy(filePath, target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw error
        }
        if (!(await readFile(target)).equals(original)) throw new Error('cópia difere do original')
        return target
      }
    } catch (error) {
      this.log(`não foi possível copiar ${filePath}: ${String(error)}`)
      return undefined
    }
  }

  private async recover(value: T, issues: ValidationIssue[]): Promise<T> {
    const protect = this.options.protectOnRecovery === true
    const backupPath = await (protect ? this.preservedCopy() : this.backup('invalid'))
    // Sem cópia de segurança, não sobrescreve o original.
    if (backupPath === undefined) return this.settle('read-only', value, issues, null, 'backup-failed')
    this.log(`${this.options.filePath} inválido; cópia em ${backupPath}`)
    return this.settle('recovered', value, issues, backupPath, protect ? 'damaged' : null)
  }

  private settle(
    state: StoreLoadState,
    value: T,
    issues: ValidationIssue[] = [],
    backupPath: string | null = null,
    writeBlock: StoreWriteBlock | null = null
  ): T {
    this.currentStatus = { state, writeBlock, issues, backupPath }
    return value
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private log(message: string): void {
    ;(this.options.log ?? console.warn)(`[storage] ${message}`)
  }
}

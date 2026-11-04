import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { win32 } from 'node:path'
import { resolveSystemDirectory, superviseProcess, type CommandOutcome, type CommandResult, type ProcessTermination, type SpawnFn, type SpawnOptions } from './command-runner'
import { DXCORE_HELPER_ARGS, DXCORE_LIMITS } from './dxcore-contract'

/**
 * Executor do ÚNICO auxiliar empacotado com o app: `gerpro-dxcore-helper.exe`
 * (D56). Separado do `CommandRunner`, que continua restrito a executáveis da
 * pasta do sistema; os dois compartilham só a supervisão do processo
 * (`superviseProcess`).
 *
 * - Identidade: nome, subpasta e argumentos fixos no código. Quem chama passa
 *   só um `AbortSignal`: não há caminho, nome, argumento nem diretório vindo
 *   de fora. A raiz (pasta de recursos do app) é definida pelo Main, nunca
 *   pelo Renderer, por IPC ou por texto de modelo.
 * - Integridade: arquivo comum (não link), sem redirecionamento em nenhuma
 *   pasta do caminho, tamanho dentro do limite e SHA-256 igual ao valor
 *   embutido NO CÓDIGO do app (não num arquivo ao lado do executável).
 *   Conferido de novo depois da execução: arquivo trocado descarta a saída.
 * - Execução: sem shell, sem PATH, diretório de trabalho e ambiente mínimos
 *   da pasta do sistema; prazo, limites de saída e cancelamento.
 * - Uma execução por vez; nada é gravado nem registrado. Falhas são só
 *   códigos; o caminho completo nunca sai daqui.
 *
 * O auxiliar é opcional: qualquer falha leva a sondagem de volta para
 * Electron + Registro.
 */

export const DXCORE_HELPER = Object.freeze({
  /** Identificador nos resultados (o mesmo formato do catálogo). */
  id: 'gpu.dxcore-adapters',
  fileName: 'gerpro-dxcore-helper.exe',
  /** Subpasta da raiz de recursos; a arquitetura completa o caminho (`win32-x64`, `win32-arm64`). */
  directory: 'helpers',
  args: DXCORE_HELPER_ARGS,
  /** Provisório. */
  timeoutMs: DXCORE_LIMITS.timeoutMs,
  maxStdoutBytes: DXCORE_LIMITS.maxOutputBytes,
  /** O auxiliar não escreve na saída de erro; o limite só protege contra excesso. */
  maxStderrBytes: 4_096,
  /** Faixa de tamanho aceita para o executável. */
  minFileBytes: 1_024,
  maxFileBytes: 8 * 1_048_576
})

/**
 * SHA-256 esperado do auxiliar, por arquitetura. Embutido no código do app
 * (dentro do pacote), gerado pelo build do auxiliar. `null`: ainda não há
 * binário, então o auxiliar é sempre recusado (`integrity-unknown`).
 */
export const DXCORE_HELPER_SHA256: Readonly<Record<'x64' | 'arm64', string | null>> = Object.freeze({ x64: null, arm64: null })

const SHA256 = /^[0-9a-f]{64}$/
const SUPPORTED_ARCH = new Set(['x64', 'arm64'])

/** Motivos de recusa antes ou depois da execução, sem dados do sistema. */
export type HelperRejection =
  | 'unsupported-arch'
  | 'location-invalid'
  | 'not-regular-file'
  | 'symlink'
  | 'redirected'
  | 'size-invalid'
  | 'integrity-unknown'
  | 'integrity-mismatch'
  | 'integrity-changed'
  | 'io-error'
  /** Uma execução anterior não confirmou o encerramento: pode ainda estar rodando. */
  | 'previous-unconfirmed'

/**
 * Situação do processo ao fim da execução (`ProcessTermination` do supervisor),
 * ou `unknown` se o executor não sabe (erro inesperado). Opcional no tipo só
 * para simulações; o executor sempre informa. Ausente vale como `unknown`.
 */
export type HelperProcessState = ProcessTermination | 'unknown'

/** Resultado do executor: o mesmo do `CommandRunner`, mais a recusa por identidade ou integridade. */
export type HelperRunResult = (CommandResult | { kind: 'rejected'; reason: HelperRejection; commandId: string; processExited: boolean }) & {
  process?: HelperProcessState
}

export interface HelperFileStat {
  isFile(): boolean
  isSymbolicLink(): boolean
  size: number
  dev: number
  ino: number
  mtimeMs: number
}

export interface HelperFs {
  lstat(path: string): Promise<HelperFileStat>
  /** Caminho real, com links e junções resolvidos em TODAS as pastas. */
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<Buffer>
}

export interface BundledHelperDeps {
  /** Pasta de recursos do app, definida pelo Main (empacotado: `process.resourcesPath`). */
  resourcesRoot: string
  /** Hash esperado; por padrão, o embutido no código. Só para testes e para o diagnóstico manual (D58), nunca pelo app. */
  expectedSha256?: Readonly<Record<'x64' | 'arm64', string | null>>
  fs?: HelperFs
  spawn?: SpawnFn
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

const nodeFs: HelperFs = {
  lstat: (p) => lstat(p),
  realpath: (p) => realpath(p),
  readFile: (p) => readFile(p)
}

/**
 * Raiz aceita: caminho local absoluto, com letra de unidade, já normalizado,
 * sem `.`/`..`, sem caminho de rede (`\\servidor`) nem de dispositivo (`\\?\`).
 */
export function isTrustedRoot(root: unknown): root is string {
  if (typeof root !== 'string' || root.length > 240 || !/^[A-Za-z]:\\/.test(root)) return false
  if (/[\u0000-\u001f"*?<>|]/.test(root) || /:/.test(root.slice(2))) return false
  if (win32.normalize(root) !== root.replace(/\\$/, '') && win32.normalize(root) !== root) return false
  return !root.split('\\').some((segment) => segment === '.' || segment === '..')
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code

interface VerifiedFile {
  path: string
  identity: string
}

export class BundledHelperRunner {
  private readonly deps: BundledHelperDeps
  private queue: Promise<unknown> = Promise.resolve()
  /** Processo de uma execução anterior sem encerramento confirmado; limpo quando ele termina. */
  private lingering: Promise<void> | null = null

  /** Não executa nada: só confere a configuração (erro de programação se fugir das regras). */
  constructor(deps: BundledHelperDeps) {
    const hashes = deps.expectedSha256 ?? DXCORE_HELPER_SHA256
    for (const value of Object.values(hashes)) {
      if (value !== null && !SHA256.test(value)) throw new Error('Hash esperado do auxiliar em formato inválido.')
    }
    this.deps = { ...deps, expectedSha256: hashes }
  }

  /** Executa o auxiliar. Só aceita um `AbortSignal`; nunca lança exceção. Uma execução por vez. */
  run(signal?: AbortSignal): Promise<HelperRunResult> {
    // Qualquer outro valor (caminho, argumentos...) é ignorado: não há o que configurar por aqui.
    const abort = signal instanceof AbortSignal ? signal : undefined
    const previous = this.queue
    const current = (async (): Promise<HelperRunResult> => {
      // Esperando a vez: cancelar aqui não inicia processo nenhum.
      await waitOrAbort(previous, abort)
      try {
        return await this.runNow(abort)
      } catch {
        // Não deveria acontecer; nenhuma mensagem é guardada.
        return { kind: 'rejected', reason: 'io-error', commandId: DXCORE_HELPER.id, processExited: true, process: 'unknown' }
      }
    })()
    // A próxima espera por esta E pelas anteriores: uma chamada cancelada na fila
    // termina antes, mas não abre caminho para outra rodar junto com a que está em curso.
    this.queue = Promise.allSettled([previous, current])
    return current
  }

  private async runNow(signal?: AbortSignal): Promise<HelperRunResult> {
    const id = DXCORE_HELPER.id
    const done = (r: CommandOutcome | { kind: 'rejected'; reason: HelperRejection }, process: ProcessTermination = 'not-started'): HelperRunResult =>
      ({ ...r, commandId: id, processExited: process === 'not-started' || process === 'exited' || process === 'stopped', process }) as HelperRunResult
    const rejected = (reason: HelperRejection, process: ProcessTermination = 'not-started') => done({ kind: 'rejected', reason }, process)

    if (signal?.aborted) return done({ kind: 'cancelled' })
    // Nunca dois processos do auxiliar ao mesmo tempo, nem com um anterior possivelmente órfão.
    if (this.lingering) return rejected('previous-unconfirmed')
    if ((this.deps.platform ?? process.platform) !== 'win32') return done({ kind: 'unavailable', reason: 'unsupported-platform' })
    const arch = this.deps.arch ?? process.arch
    if (!SUPPORTED_ARCH.has(arch)) return rejected('unsupported-arch')
    const env = this.deps.env ?? process.env
    const systemDirectory = resolveSystemDirectory(env, arch)
    if (!systemDirectory) return done({ kind: 'unavailable', reason: 'system-directory-unknown' })

    const expected = this.deps.expectedSha256![arch as 'x64' | 'arm64']
    const verified = await this.verify(arch, expected ?? null)
    if ('kind' in verified) return verified.kind === 'unavailable' ? done(verified) : rejected(verified.reason)
    if (signal?.aborted) return done({ kind: 'cancelled' })

    const systemRoot = win32.dirname(systemDirectory)
    const options: SpawnOptions = {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Pasta do sistema: nada controlado pelo usuário no diretório de trabalho.
      cwd: systemDirectory,
      // Ambiente mínimo: sem PATH do usuário nem variáveis do app.
      env: { SystemRoot: systemRoot, windir: systemRoot, PATH: systemDirectory }
    }
    const { outcome, termination, exited } = await superviseProcess(
      verified.path,
      DXCORE_HELPER.args,
      options,
      { timeoutMs: DXCORE_HELPER.timeoutMs, maxStdoutBytes: DXCORE_HELPER.maxStdoutBytes, maxStderrBytes: DXCORE_HELPER.maxStderrBytes },
      { spawn: this.deps.spawn, now: this.deps.now },
      signal
    )

    if (termination === 'kill-failed' || termination === 'exit-unconfirmed') {
      const pending = exited
      this.lingering = pending
      void pending.then(() => {
        if (this.lingering === pending) this.lingering = null
      })
    }

    // O arquivo executado tem de ser o mesmo que foi conferido: senão, a saída não vale.
    if (outcome.kind === 'success') {
      const after = await this.verify(arch, expected ?? null)
      if ('kind' in after || after.identity !== verified.identity) return rejected('integrity-changed', termination)
    }
    return done(outcome, termination)
  }

  /** Confere identidade e integridade do arquivo. O caminho completo nunca sai do executor. */
  private async verify(arch: string, expected: string | null): Promise<VerifiedFile | { kind: 'unavailable'; reason: 'not-found' | 'permission-denied' } | { kind: 'rejected'; reason: HelperRejection }> {
    const fs = this.deps.fs ?? nodeFs
    const root = this.deps.resourcesRoot
    if (!isTrustedRoot(root)) return { kind: 'rejected', reason: 'location-invalid' }
    const directory = win32.join(root, DXCORE_HELPER.directory, `win32-${arch}`)
    const path = win32.join(directory, DXCORE_HELPER.fileName)
    // Defesa: o caminho montado continua dentro da raiz.
    if (!path.toLowerCase().startsWith(`${root.replace(/\\$/, '').toLowerCase()}\\`)) return { kind: 'rejected', reason: 'location-invalid' }

    let stat: HelperFileStat
    try {
      stat = await fs.lstat(path)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'unavailable', reason: 'not-found' }
      if (code === 'EACCES' || code === 'EPERM') return { kind: 'unavailable', reason: 'permission-denied' }
      return { kind: 'rejected', reason: 'io-error' }
    }
    if (stat.isSymbolicLink()) return { kind: 'rejected', reason: 'symlink' }
    if (!stat.isFile()) return { kind: 'rejected', reason: 'not-regular-file' }
    if (stat.size < DXCORE_HELPER.minFileBytes || stat.size > DXCORE_HELPER.maxFileBytes) return { kind: 'rejected', reason: 'size-invalid' }

    let bytes: Buffer
    try {
      // Junção ou link em qualquer pasta do caminho muda o caminho real.
      if ((await fs.realpath(path)).toLowerCase() !== path.toLowerCase()) return { kind: 'rejected', reason: 'redirected' }
      bytes = await fs.readFile(path)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'EACCES' || code === 'EPERM') return { kind: 'unavailable', reason: 'permission-denied' }
      if (code === 'ENOENT') return { kind: 'unavailable', reason: 'not-found' }
      return { kind: 'rejected', reason: 'io-error' }
    }
    if (bytes.length !== stat.size) return { kind: 'rejected', reason: 'integrity-changed' }
    if (expected === null) return { kind: 'rejected', reason: 'integrity-unknown' }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== expected) return { kind: 'rejected', reason: 'integrity-mismatch' }
    return { path, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${digest}` }
  }
}

/** Espera a execução anterior terminar, ou o cancelamento, o que vier primeiro. */
function waitOrAbort(previous: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous.then(() => undefined)
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}

/** Versão de produção: hash embutido, `fs` e `spawn` reais. Não executa nada ao criar. */
export const createDxcoreHelperRunner = (resourcesRoot: string) => new BundledHelperRunner({ resourcesRoot })

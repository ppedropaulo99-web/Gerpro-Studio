import { spawn as nodeSpawn } from 'node:child_process'
import { win32 } from 'node:path'

/**
 * Execução controlada de consultas ao Windows, para os detectores de hardware.
 *
 * Não é um executor genérico:
 * - só dois executáveis (`WINDOWS_EXECUTABLES`), resolvidos por caminho
 *   absoluto na pasta do sistema, nunca pelo PATH;
 * - só comandos de um catálogo definido no código (`defineCommands`), com
 *   argumentos fixos e validados. Quem chama passa apenas o identificador:
 *   não há nome de executável, caminho, argumento nem script vindo de fora;
 * - sem shell (`shell: false`, `windowsVerbatimArguments: false`);
 * - prazo, limite de saída e cancelamento por `AbortSignal` em toda execução;
 * - nada é executado ao importar ou construir: só `run()` inicia processos.
 *
 * Saídas não são registradas em log. O resultado devolve a saída padrão só em
 * caso de sucesso, e nunca o conteúdo da saída de erro.
 */

// ---------------------------------------------------------------------------
// Executáveis permitidos
// ---------------------------------------------------------------------------

/**
 * - `powershell`: Windows PowerShell 5.1, presente em toda instalação do
 *   Windows 10/11. Necessário para consultas CIM (ex.: núcleos físicos).
 * - `reg`: leitura do Registro (ex.: memória de vídeo em `qwMemorySize`).
 *   Só `reg query` é aceito.
 */
export const WINDOWS_EXECUTABLES = {
  powershell: ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
  reg: ['reg.exe']
} as const satisfies Record<string, readonly string[]>

export type AllowedExecutable = keyof typeof WINDOWS_EXECUTABLES

/** Argumentos obrigatórios do PowerShell: sem perfil, sem interação, sem logotipo. */
export const POWERSHELL_PREFIX = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] as const

export const COMMAND_LIMITS = {
  minTimeoutMs: 100,
  maxTimeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
  maxArgs: 16,
  maxArgLength: 4_000,
  /** Após o pedido de encerramento, quanto esperar o processo terminar. */
  killGraceMs: 2_000
} as const

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

export interface CommandDefinition {
  /** Identificador estável, ex.: `gpu.registry-vram`. */
  id: string
  executable: AllowedExecutable
  /** Argumentos completos e fixos. */
  args: readonly string[]
  timeoutMs: number
  /** Limite de bytes, aplicado separadamente à saída padrão e à de erro. */
  maxOutputBytes: number
}

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/
// Caracteres de controle não têm uso nos argumentos e mudariam a interpretação.
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/
const REG_KEY = /^HKLM\\[^\u0000-\u001f"]{1,250}$/

function argumentIssues(def: CommandDefinition): string[] {
  const issues: string[] = []
  const { args } = def
  if (!Array.isArray(args) || args.length === 0 || args.length > COMMAND_LIMITS.maxArgs) return ['quantidade de argumentos inválida']
  args.forEach((a, i) => {
    if (typeof a !== 'string' || a.length === 0 || a.length > COMMAND_LIMITS.maxArgLength) issues.push(`argumento ${i}: tamanho inválido`)
    else if (CONTROL_CHARS.test(a)) issues.push(`argumento ${i}: caractere de controle`)
  })
  if (issues.length) return issues

  if (def.executable === 'powershell') {
    // Exatamente: prefixo obrigatório + um único script definido no código.
    const prefixOk = POWERSHELL_PREFIX.every((p, i) => args[i] === p)
    if (!prefixOk || args.length !== POWERSHELL_PREFIX.length + 1) issues.push('PowerShell exige o prefixo obrigatório e um único script')
  } else {
    // Só leitura: `reg query HKLM\...` e opções de consulta.
    if (args[0] !== 'query') issues.push('reg só aceita "query"')
    if (!REG_KEY.test(args[1] ?? '')) issues.push('reg exige uma chave HKLM\\...')
    const options = args.slice(2)
    const allowed = new Set(['/v', '/ve', '/s', '/t', '/f', '/k', '/d', '/e', '/c', '/reg:64'])
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!.toLowerCase()
      if (!allowed.has(option)) {
        issues.push(`reg: opção não permitida (${options[i]})`)
        break
      }
      // `/v`, `/t` e `/f` levam um valor logo depois.
      if (option === '/v' || option === '/t' || option === '/f') i++
    }
  }
  return issues
}

/**
 * Valida e congela o catálogo. Lança erro (de programação) se algum comando
 * fugir das regras: executável fora da lista, argumentos inválidos, limites
 * fora do intervalo ou identificador repetido.
 */
export function defineCommands(definitions: readonly CommandDefinition[]): ReadonlyMap<string, Readonly<CommandDefinition>> {
  const catalog = new Map<string, Readonly<CommandDefinition>>()
  for (const def of definitions) {
    const problems: string[] = []
    if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) problems.push('identificador inválido')
    else if (catalog.has(def.id)) problems.push('identificador repetido')
    if (!Object.hasOwn(WINDOWS_EXECUTABLES, def.executable)) problems.push('executável não autorizado')
    else problems.push(...argumentIssues(def))
    if (!Number.isInteger(def.timeoutMs) || def.timeoutMs < COMMAND_LIMITS.minTimeoutMs || def.timeoutMs > COMMAND_LIMITS.maxTimeoutMs) {
      problems.push('prazo fora do intervalo')
    }
    if (!Number.isInteger(def.maxOutputBytes) || def.maxOutputBytes < 1 || def.maxOutputBytes > COMMAND_LIMITS.maxOutputBytes) {
      problems.push('limite de saída fora do intervalo')
    }
    if (problems.length) throw new Error(`Comando "${String(def.id)}" recusado: ${problems.join('; ')}`)
    catalog.set(def.id, Object.freeze({ ...def, args: Object.freeze([...def.args]) }))
  }
  return catalog
}

// ---------------------------------------------------------------------------
// Resolução dos executáveis
// ---------------------------------------------------------------------------

/**
 * Raiz do Windows aceita: unidade + caminho absoluto, sem `..` nem caracteres
 * especiais. Segmentos separados sem ambiguidade (sem retrocesso exponencial).
 */
const SYSTEM_ROOT = /^[A-Za-z]:\\(?:[^\\/:*?"<>|\u0000-\u001f;]+(?:\\[^\\/:*?"<>|\u0000-\u001f;]+)*)?\\?$/

/**
 * Pasta de executáveis nativos do sistema.
 *
 * - Processo de 64 bits (x64 ou ARM64, inclusive x64 emulado no ARM64): `System32`.
 *   No ARM64, processos x64 emulados não sofrem redirecionamento de pasta.
 * - Processo de 32 bits num Windows de 64 bits: `System32` é redirecionado
 *   para `SysWOW64`; `Sysnative` aponta para a pasta nativa.
 *
 * `null` quando a raiz do Windows não é confiável.
 */
export function resolveSystemDirectory(env: NodeJS.ProcessEnv, arch: string): string | null {
  const root = env['SystemRoot'] ?? env['windir']
  if (!root || !SYSTEM_ROOT.test(root) || root.split('\\').includes('..')) return null
  const wow64 = arch === 'ia32' && Boolean(env['PROCESSOR_ARCHITEW6432'])
  return win32.join(root, wow64 ? 'Sysnative' : 'System32')
}

export function resolveExecutable(executable: AllowedExecutable, systemDirectory: string): string {
  return win32.join(systemDirectory, ...WINDOWS_EXECUTABLES[executable])
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

export type CommandOutcome =
  | { kind: 'success'; stdout: string; durationMs: number }
  /** O comando não pode rodar aqui: outro sistema, executável ausente ou sem permissão. */
  | { kind: 'unavailable'; reason: 'unsupported-platform' | 'system-directory-unknown' | 'not-found' | 'permission-denied' }
  | { kind: 'timeout'; durationMs: number }
  | { kind: 'cancelled' }
  | {
      kind: 'failed'
      reason: 'unknown-command' | 'exit-code' | 'output-limit' | 'spawn-error'
      exitCode: number | null
    }

export type CommandResult = CommandOutcome & {
  commandId: string
  /** `false` se o processo não confirmou o encerramento dentro do prazo de tolerância. */
  processExited: boolean
}

/** O que o executor usa de um processo filho (subconjunto de `ChildProcess`). */
export interface SpawnedProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(): boolean
}

export interface SpawnOptions {
  shell: false
  windowsHide: true
  windowsVerbatimArguments: false
  stdio: ['ignore', 'pipe', 'pipe']
  cwd: string
  env: NodeJS.ProcessEnv
}

export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess

/**
 * Como o processo terminou, só pelo que foi observado (nada é inferido do prazo):
 * - `not-started`: não houve processo (falha ao iniciar);
 * - `exited`: terminou sozinho (evento `close`);
 * - `stopped`: o encerramento foi pedido e o `close` chegou dentro da tolerância;
 * - `kill-failed`: o pedido de encerramento lançou erro e o `close` não chegou;
 * - `exit-unconfirmed`: o pedido foi feito, mas o `close` não chegou na tolerância.
 * Nos dois últimos, o processo pode continuar rodando (órfão): o supervisor não
 * tem como garantir o contrário sem um Job Object.
 */
export type ProcessTermination = 'not-started' | 'exited' | 'stopped' | 'kill-failed' | 'exit-unconfirmed'

export interface SupervisedRun {
  outcome: CommandOutcome
  /** `true` só com encerramento observado (ou sem processo). */
  processExited: boolean
  termination: ProcessTermination
  /** Resolve quando o processo de fato termina, mesmo depois do resultado; nunca, se ele não terminar. */
  exited: Promise<void>
}

export interface CommandRunnerDeps {
  commands: ReadonlyMap<string, Readonly<CommandDefinition>>
  /** Substituível nos testes; padrão `child_process.spawn`. */
  spawn?: SpawnFn
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

const ERROR_TO_UNAVAILABLE: Record<string, 'not-found' | 'permission-denied'> = {
  ENOENT: 'not-found',
  EACCES: 'permission-denied',
  EPERM: 'permission-denied'
}

export class CommandRunner {
  private readonly deps: CommandRunnerDeps

  /** Não executa nada: só guarda o catálogo e as dependências. */
  constructor(deps: CommandRunnerDeps) {
    this.deps = deps
  }

  /** Executa um comando do catálogo. Nunca lança exceção. */
  async run(commandId: string, signal?: AbortSignal): Promise<CommandResult> {
    const done = (outcome: CommandOutcome, processExited = true): CommandResult => ({ ...outcome, commandId, processExited })

    const def = this.deps.commands.get(commandId)
    if (!def) return done({ kind: 'failed', reason: 'unknown-command', exitCode: null })
    if ((this.deps.platform ?? process.platform) !== 'win32') return done({ kind: 'unavailable', reason: 'unsupported-platform' })
    if (signal?.aborted) return done({ kind: 'cancelled' })

    const env = this.deps.env ?? process.env
    const systemDirectory = resolveSystemDirectory(env, this.deps.arch ?? process.arch)
    if (!systemDirectory) return done({ kind: 'unavailable', reason: 'system-directory-unknown' })

    const options: SpawnOptions = {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: systemDirectory,
      env: childEnvironment(env, systemDirectory)
    }
    const { outcome, processExited } = await superviseProcess(
      resolveExecutable(def.executable, systemDirectory),
      def.args,
      options,
      { timeoutMs: def.timeoutMs, maxStdoutBytes: def.maxOutputBytes, maxStderrBytes: def.maxOutputBytes },
      { spawn: this.deps.spawn, now: this.deps.now },
      signal
    )
    return done(outcome, processExited)
  }
}

// ---------------------------------------------------------------------------
// Supervisão de um processo (compartilhada com o executor do auxiliar empacotado)
// ---------------------------------------------------------------------------

export interface ProcessLimits {
  timeoutMs: number
  maxStdoutBytes: number
  /** A saída de erro só é contada, nunca guardada. */
  maxStderrBytes: number
}

/**
 * Inicia um processo já resolvido e validado por quem chama, e o supervisiona:
 * prazo, limites de saída, cancelamento e encerramento com tolerância. Não
 * resolve caminhos nem valida argumentos. Nunca lança exceção.
 */
export function superviseProcess(
  file: string,
  args: readonly string[],
  options: SpawnOptions,
  limits: ProcessLimits,
  deps: { spawn?: SpawnFn; now?: () => number },
  signal?: AbortSignal
): Promise<SupervisedRun> {
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn)
  const now = deps.now ?? Date.now
  const started = now()

  let child: SpawnedProcess
  try {
    child = spawn(file, args, options)
  } catch (error) {
    return Promise.resolve({ outcome: spawnFailure(error), processExited: true, termination: 'not-started', exited: Promise.resolve() })
  }

  let markExited!: () => void
  const exited = new Promise<void>((r) => (markExited = r))

  return new Promise((resolve) => {
    const stdout: Buffer[] = []
    const bytes = { stdout: 0, stderr: 0 }
    let stopping: CommandOutcome | null = null
    let killFailed = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined

    const finish = (outcome: CommandOutcome, termination: ProcessTermination) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      signal?.removeEventListener('abort', onAbort)
      const processExited = termination === 'not-started' || termination === 'exited' || termination === 'stopped'
      resolve({ outcome, processExited, termination, exited })
    }

    // Encerra o processo e espera a confirmação; sem ela, devolve mesmo assim.
    const stop = (outcome: CommandOutcome) => {
      if (stopping || settled) return
      stopping = outcome
      try {
        child.kill()
      } catch {
        // O processo pode já ter terminado; só o `close` confirma.
        killFailed = true
      }
      // Fim da tolerância sem `close`: o encerramento NÃO é presumido.
      graceTimer = setTimeout(() => finish(outcome, killFailed ? 'kill-failed' : 'exit-unconfirmed'), COMMAND_LIMITS.killGraceMs)
    }

    const onAbort = () => stop({ kind: 'cancelled' })
    timer = setTimeout(() => stop({ kind: 'timeout', durationMs: now() - started }), limits.timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes.stdout += chunk.length
      if (bytes.stdout > limits.maxStdoutBytes) stop({ kind: 'failed', reason: 'output-limit', exitCode: null })
      else if (!stopping) stdout.push(chunk)
    })
    // A saída de erro só é contada (pode conter dados do sistema); nunca guardada.
    child.stderr?.on('data', (chunk: Buffer) => {
      bytes.stderr += chunk.length
      if (bytes.stderr > limits.maxStderrBytes) stop({ kind: 'failed', reason: 'output-limit', exitCode: null })
    })

    child.on('error', (error: Error) => {
      // Falha ao iniciar: não há processo para esperar.
      if (!stopping) {
        markExited()
        finish(spawnFailure(error), 'not-started')
      }
    })

    child.on('close', (code: number | null) => {
      markExited()
      if (stopping) return finish(stopping, 'stopped')
      if (code === 0) finish({ kind: 'success', stdout: Buffer.concat(stdout).toString('utf8'), durationMs: now() - started }, 'exited')
      else finish({ kind: 'failed', reason: 'exit-code', exitCode: code }, 'exited')
    })
  })
}

/**
 * Ambiente do processo filho: o do app, mas com os módulos do PowerShell
 * restritos aos do sistema (um módulo na pasta do usuário não substitui os
 * cmdlets usados nas consultas).
 */
function childEnvironment(env: NodeJS.ProcessEnv, systemDirectory: string): NodeJS.ProcessEnv {
  return { ...env, PSModulePath: win32.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules') }
}

function spawnFailure(error: unknown): CommandOutcome {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const reason = code ? ERROR_TO_UNAVAILABLE[code] : undefined
  return reason ? { kind: 'unavailable', reason } : { kind: 'failed', reason: 'spawn-error', exitCode: null }
}

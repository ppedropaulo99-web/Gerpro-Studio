/**
 * Ciclo de vida da pasta temporária do diagnóstico manual (D55).
 *
 * O supervisor (Node, fora do Electron) cria uma pasta exclusiva, inicia o
 * Electron apontando para ela, espera o processo encerrar por completo e só
 * então remove a pasta que ELE criou. Nada de limpeza global por prefixo:
 * a remoção confere que a pasta é a mesma criada nesta execução (caminho,
 * dispositivo e inode), que fica direto na pasta temporária do sistema e que
 * não é um link. Links dentro dela são removidos sem seguir o destino.
 *
 * Usado com a remoção nativa de tipos do Node: só sintaxe apagável e
 * importações de tipo marcadas com `type`.
 */

import { basename, dirname, isAbsolute, join } from 'node:path'

export const SCRATCH_PREFIX = 'gerpro-hwdiag-'
/** Variável de ambiente pela qual o supervisor passa a pasta ao Electron. */
export const SCRATCH_ENV = 'GERPRO_HWDIAG_SCRATCH'

/** Códigos de saída do supervisor além do código do Electron. */
export const SUPERVISOR_EXIT = {
  /** Não foi possível criar a pasta temporária. */
  scratchFailed: 70,
  /** O Electron não pôde ser iniciado. */
  spawnFailed: 71,
  /** O diagnóstico terminou bem, mas a pasta temporária não foi removida. */
  cleanupFailed: 72,
  /** Interrompido (Ctrl+C). */
  interrupted: 130
} as const

export interface EntryStat {
  isDirectory(): boolean
  isSymbolicLink(): boolean
  dev: number
  ino: number
}

/** Operações de arquivo usadas; injetáveis nos testes. Nenhuma segue links. */
export interface ScratchFs {
  mkdtemp(prefix: string): string
  lstat(path: string): EntryStat
  readdir(path: string): string[]
  unlink(path: string): void
  rmdir(path: string): void
  /** Caminho real (expande nomes curtos do Windows); só para a raiz temporária e a pasta criada. */
  realpath(path: string): string
}

export interface ScratchDir {
  path: string
  dev: number
  ino: number
}

export type CleanupResult =
  | { removed: true; attempts: number }
  | { removed: false; attempts: number; reason: 'not-owned' | 'outside-temp' | 'is-link' | 'io-error'; code: string | null }

const errorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : null
}

const samePath = (a: string, b: string, platform: NodeJS.Platform) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** Cria a pasta exclusiva desta execução, direto na raiz temporária (já resolvida). */
export function createScratch(fs: ScratchFs, tmpRoot: string, prefix: string = SCRATCH_PREFIX): ScratchDir {
  const path = fs.realpath(fs.mkdtemp(join(tmpRoot, prefix)))
  const stat = fs.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('Pasta temporária inesperada.'), { code: 'ENOTDIR' })
  return { path, dev: stat.dev, ino: stat.ino }
}

/**
 * Pasta recebida pelo Electron: absoluta, direto na raiz temporária, com o
 * prefixo, diretório real (não link). `null` se qualquer condição falhar.
 */
export function acceptScratch(
  fs: Pick<ScratchFs, 'lstat' | 'realpath'>,
  raw: string | undefined,
  tmpRoot: string,
  platform: NodeJS.Platform = process.platform,
  prefix: string = SCRATCH_PREFIX
): string | null {
  if (typeof raw !== 'string' || raw === '' || !isAbsolute(raw)) return null
  try {
    const stat = fs.lstat(raw)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    const path = fs.realpath(raw)
    return samePath(dirname(path), tmpRoot, platform) && basename(path).startsWith(prefix) ? path : null
  } catch {
    return null
  }
}

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

/** Remove o conteúdo sem seguir links: link (de arquivo, de pasta ou junção) é apagado como entrada. */
function removeTree(fs: ScratchFs, dir: string): void {
  for (const name of fs.readdir(dir)) {
    const entry = join(dir, name)
    const stat = fs.lstat(entry)
    if (stat.isSymbolicLink()) {
      try {
        fs.unlink(entry)
      } catch (error) {
        // No Windows, link de pasta e junção saem com rmdir, que não percorre o destino.
        if (errorCode(error) !== 'EPERM' && errorCode(error) !== 'EISDIR') throw error
        fs.rmdir(entry)
      }
    } else if (stat.isDirectory()) {
      removeTree(fs, entry)
      fs.rmdir(entry)
    } else {
      fs.unlink(entry)
    }
  }
}

export interface CleanupOptions {
  tmpRoot: string
  platform?: NodeJS.Platform
  /** Tentativas (arquivos ainda presos por processos filhos do Chromium que acabaram de sair). */
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Prefixo da pasta (padrão: o do diagnóstico de hardware). */
  prefix?: string
}

/** Remove a pasta criada por `createScratch`, e só ela. */
export async function removeScratch(fs: ScratchFs, scratch: ScratchDir, options: CleanupOptions): Promise<CleanupResult> {
  const platform = options.platform ?? process.platform
  const attempts = options.attempts ?? 10
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  if (!samePath(dirname(scratch.path), options.tmpRoot, platform) || !basename(scratch.path).startsWith(options.prefix ?? SCRATCH_PREFIX)) {
    return { removed: false, attempts: 0, reason: 'outside-temp', code: null }
  }
  let last: string | null = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let stat: EntryStat
    try {
      stat = fs.lstat(scratch.path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { removed: true, attempts: attempt }
      return { removed: false, attempts: attempt, reason: 'io-error', code: errorCode(error) }
    }
    if (stat.isSymbolicLink()) return { removed: false, attempts: attempt, reason: 'is-link', code: null }
    if (!stat.isDirectory() || stat.dev !== scratch.dev || stat.ino !== scratch.ino) {
      return { removed: false, attempts: attempt, reason: 'not-owned', code: null }
    }
    try {
      removeTree(fs, scratch.path)
      fs.rmdir(scratch.path)
      return { removed: true, attempts: attempt }
    } catch (error) {
      last = errorCode(error)
      if (last === 'ENOENT') continue
      if (!RETRYABLE.has(last ?? '') || attempt === attempts) return { removed: false, attempts: attempt, reason: 'io-error', code: last }
      await sleep((options.delayMs ?? 200) * attempt)
    }
  }
  return { removed: false, attempts, reason: 'io-error', code: last }
}

// ── Supervisor ──────────────────────────────────────────────────────────────

export interface ChildExit {
  code: number | null
  signal: string | null
  /** Falha ao iniciar (ex.: `ENOENT`), só o código. */
  spawnError?: string | null
}

export interface ChildHandle {
  exited: Promise<ChildExit>
  /** Encerramento forçado (o Electron não respondeu à interrupção). */
  kill(): void
}

export interface SuperviseDeps {
  fs: ScratchFs
  tmpRoot: string
  platform?: NodeJS.Platform
  /** Inicia o Electron com a pasta; pode lançar exceção. */
  spawnChild(scratchPath: string): ChildHandle
  /** Registra o tratamento de Ctrl+C; devolve a função que o remove. */
  onInterrupt(handler: () => void): () => void
  /** Espera depois da interrupção antes de forçar o encerramento. */
  killGraceMs?: number
  /** Prazo total do processo do Electron. */
  maxRunMs?: number
  cleanup?: Omit<CleanupOptions, 'tmpRoot' | 'platform'>
}

export type SuperviseOutcome = 'completed' | 'child-failed' | 'interrupted' | 'killed' | 'spawn-failed' | 'scratch-failed'

export interface SuperviseResult {
  outcome: SuperviseOutcome
  exitCode: number
  childExitCode: number | null
  /** `null` quando a pasta nem chegou a ser criada. */
  cleanup: CleanupResult | null
  /** Código do erro (sem mensagem, que pode ter caminhos). */
  errorCode: string | null
}

/**
 * Cria a pasta, inicia o Electron, espera ele encerrar por completo e só
 * então remove a pasta. Nunca remove antes de o processo sair.
 */
export async function superviseDiagnostic(deps: SuperviseDeps): Promise<SuperviseResult> {
  const platform = deps.platform ?? process.platform
  let scratch: ScratchDir
  try {
    scratch = createScratch(deps.fs, deps.tmpRoot)
  } catch (error) {
    return { outcome: 'scratch-failed', exitCode: SUPERVISOR_EXIT.scratchFailed, childExitCode: null, cleanup: null, errorCode: errorCode(error) }
  }
  const cleanup = () => removeScratch(deps.fs, scratch, { ...deps.cleanup, tmpRoot: deps.tmpRoot, platform })

  let child: ChildHandle
  try {
    child = deps.spawnChild(scratch.path)
  } catch (error) {
    return { outcome: 'spawn-failed', exitCode: SUPERVISOR_EXIT.spawnFailed, childExitCode: null, cleanup: await cleanup(), errorCode: errorCode(error) }
  }

  let interrupted = false
  let killed = false
  const timers: Array<ReturnType<typeof setTimeout>> = []
  const kill = () => {
    if (killed) return
    killed = true
    child.kill()
  }
  const stopListening = deps.onInterrupt(() => {
    // O console do Windows entrega o Ctrl+C também ao Electron; a segunda vez força.
    if (interrupted) return kill()
    interrupted = true
    timers.push(setTimeout(kill, deps.killGraceMs ?? 5_000))
  })
  timers.push(setTimeout(kill, deps.maxRunMs ?? 120_000))

  let exit: ChildExit
  try {
    exit = await child.exited
  } finally {
    stopListening()
    for (const t of timers) clearTimeout(t)
  }

  const result = await cleanup()
  if (exit.spawnError) {
    return { outcome: 'spawn-failed', exitCode: SUPERVISOR_EXIT.spawnFailed, childExitCode: null, cleanup: result, errorCode: exit.spawnError }
  }
  const outcome: SuperviseOutcome = killed ? 'killed' : interrupted ? 'interrupted' : exit.code === 0 ? 'completed' : 'child-failed'
  const exitCode =
    outcome === 'completed'
      ? result.removed
        ? 0
        : SUPERVISOR_EXIT.cleanupFailed
      : outcome === 'interrupted' || outcome === 'killed'
        ? SUPERVISOR_EXIT.interrupted
        : (exit.code ?? 1) || 1
  return { outcome, exitCode, childExitCode: exit.code, cleanup: result, errorCode: null }
}

/** Texto do resultado, sem caminhos. */
export function formatSupervision(r: SuperviseResult): string {
  const lines = [`Supervisor: ${r.outcome}${r.childExitCode === null ? '' : ` (Electron saiu com ${r.childExitCode})`}${r.errorCode ? ` · erro ${r.errorCode}` : ''}`]
  if (r.cleanup === null) lines.push('Pasta temporária: não foi criada.')
  else if (r.cleanup.removed) lines.push(`Pasta temporária desta execução removida depois do encerramento do Electron (tentativas: ${r.cleanup.attempts}).`)
  else
    lines.push(
      `Pasta temporária desta execução NÃO removida: ${r.cleanup.reason}${r.cleanup.code ? ` (${r.cleanup.code})` : ''}. ` +
        `Ela fica na pasta temporária do sistema com o prefixo ${SCRATCH_PREFIX}; nenhuma outra pasta foi tocada.`
    )
  return lines.join('\n')
}

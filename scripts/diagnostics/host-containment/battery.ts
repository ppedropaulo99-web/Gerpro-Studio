/**
 * Bateria dos testes reais de contenção, Grupo A (Etapa 6C.6C.2A). Toda
 * interação com o sistema vem de `BatteryDeps` (injetável nos testes); este
 * módulo só decide a ordem, as conferências e o que fazer em cada resultado.
 *
 * Garantias:
 * - sem confirmação explícita (modo `run`) nada é iniciado;
 * - antes de iniciar qualquer processo: Windows x64, sem elevação, censo 0,
 *   trava exclusiva, artefatos com tamanho e SHA-256 aprovados, PE e
 *   identidade da variante conferidos;
 * - cada caso numa subpasta da pasta exclusiva da bateria, com as cópias
 *   conferidas de novo pelo hash; o supervisor só grava dentro dela;
 * - prazo global por caso; ao estourar, só o processo que o supervisor
 *   iniciou (pelo identificador dele) é encerrado;
 * - censo depois de cada caso; qualquer sobrevivente encerra a bateria e
 *   NUNCA é encerrado automaticamente (sem identificador do processo, a
 *   identidade não é garantida no instante do encerramento): identidades
 *   registradas, inspeção manual (6C.6C.2B);
 * - depois do caso Electron, censo só de leitura dos `electron.exe` do
 *   Electron do projeto criados durante o caso: tem de ser 0;
 * - cada caso roda uma vez; nenhuma nova tentativa automática;
 * - modo diagnóstico (6C.6C.2C, `runDiagnosis`): o MESMO caminho, com um
 *   único caso fixo (T-H1.exit-ok) e a variante diagnóstica aprovada do
 *   launcher no lugar da de testes; as mesmas pré-condições, trava, pasta
 *   exclusiva, prazo e censos.
 */

import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { checkDiagMarker, checkHostBinary, checkLockHolderBinary, checkSyntheticBinary, checkVariantIdentity, DIAG_HOST_ALLOWED_FUNCTIONS } from '../../native/pe-inspect'
import {
  ATTEMPTS,
  caseLayout,
  checkIdentity,
  completeLines,
  evaluateLockHolder,
  LOCK_HOLDER_CASES,
  LOCK_HOLDER_KILL_CLOSE_MS,
  LOCK_HOLDER_MAX_CASE_DIR,
  LOCK_HOLDER_PREFIX,
  LOCK_HOLDER_READY_TIMEOUT_MS,
  LOCK_HOLDER_RELEASE_TIMEOUT_MS,
  lockHolderArgs,
  lockHolderBaseIssues,
  lockHolderCaseDir,
  parseReadyLine,
  parseReleasedLine,
  renamePair,
  sameIdentity,
  type AttemptRecord,
  type AttemptSpec,
  type CaseLayout,
  type FsAttempt,
  type FsIdentity,
  type LockHolderCase,
  type LockHolderObservation,
  type LockHolderResult,
  type Restoration
} from './lock-holder'
import { isUnelevated, type IntegrityLevel } from '../dxcore-supervisor-checks'
import { createScratch, removeScratch, type CleanupResult, type ScratchDir, type ScratchFs } from '../scratch-lifecycle'
import {
  APPROVED_ARTIFACTS,
  APPROVED_DIAG_LAUNCHERS,
  casesFor,
  DIAGNOSIS_CASE,
  evaluateDiagnosis,
  splitDiagnosticOutput,
  type DiagnosisResult,
  type DiagVariant,
  CLOSE_AFTER_EXIT_MS,
  evaluateCase,
  evaluateElectron,
  GROUP_A_SCENARIOS,
  RENAMED_LAUNCHER_NAME,
  SYNTHETIC_HELPER_NAME,
  TEST_LAUNCHER_NAME,
  type CaseDefinition,
  type CaseObservation,
  type ElectronObservation,
  type ScenarioId,
  type TestId,
  type Verdict,
  evaluateTermination,
  HANG_READY_LINE,
  TERMINATION_CASE,
  TERMINATION_CLOSE_AFTER_KILL_MS,
  TERMINATION_KILL_AFTER_READY_MS,
  TERMINATION_READY_TIMEOUT_MS,
  type TerminationObservation,
  type TerminationResult,
  evaluateLauncherTimeout,
  type RepeatCaseId,
  evaluateFileLock,
  FILE_LOCK_CASE,
  type FileLockObservation,
  type WriteAttempt,
  type RepeatPlan,
  LAUNCHER_TIMEOUT_CASE,
  LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS,
  LOCK_HOLDER_NAME,
  type LockHolderCaseId,
  type CaseDefinition as HangCase
} from './plan'
import { BATTERY_SCRATCH_PREFIX, classifySurvivors, filetimeAtLeast, filetimeFromMs, type ProcessIdentity } from './system-checks'

/** Códigos de saída do supervisor. */
export const BATTERY_EXIT = {
  ok: 0,
  usage: 2,
  precondition: 4,
  survivors: 5,
  caseFailed: 6,
  cleanupFailed: 7,
  interrupted: 130
} as const

/** Leituras do censo do Electron depois do caso (janela de limpeza de 3 s). */
const ELECTRON_CENSUS_READS = 3

/** Marca da linha de resultado da entrada Electron. */
export const ELECTRON_RESULT_MARK = 'GERPRO-6C6C-RESULT '

export interface RawRun {
  exitCode: number | null
  stdout: string
  stderrBytes: number
  exitMs: number | null
  closeMs: number | null
  spawnError: string | null
  /** Sinal do `exit` (ex.: `SIGTERM` quando o supervisor encerrou o processo); `null` = saiu sozinho. */
  exitSignal?: string | null
}

export interface ChildRun {
  /** PID do processo iniciado pelo supervisor (`null` se não iniciou). */
  pid: number | null
  /** Resolve no `close` (ou no erro de início). */
  done: Promise<RawRun>
  /**
   * Encerra o processo iniciado, pelo identificador do próprio supervisor
   * (nunca por nome). `true` = o sistema aceitou o encerramento.
   */
  kill(): unknown
  /**
   * Resolve com os ms (desde o início) em que uma linha exatamente igual a
   * `line` chegou pela saída padrão; `null` se o processo fechar antes.
   */
  ready?(line: string): Promise<number | null>
  /**
   * Primeira linha completa da saída padrão que satisfaz `test`, com os ms
   * (desde o início) em que chegou; `null` se o processo fechar antes.
   */
  matchLine?(test: (line: string) => boolean): Promise<{ ms: number; line: string } | null>
  /**
   * Só no segurador de travas: fecha a ponta do supervisor da entrada padrão
   * (nenhum byte é escrito). `true` = fechada agora.
   */
  closeStdin?(): boolean
}

export interface BatteryFs extends ScratchFs {
  mkdirp(path: string): void
  writeFile(path: string, bytes: Uint8Array): void
  readFile(path: string): Buffer
  /** Link simbólico de arquivo; lança `EPERM` sem permissão para criar links. */
  symlinkFile(target: string, path: string): void
}

export interface BatteryDeps {
  platform: string
  arch: string
  /** Pasta temporária do sistema, já resolvida. */
  tmpRoot: string
  /** Pasta do build de testes (`native/helper-host/build/test/x64`). */
  artifactsDir: string
  fs: BatteryFs
  /** Versão do Electron do projeto; `null` se não encontrada. */
  electronVersion(): string | null
  integrityLevel(): IntegrityLevel
  /** Censo das imagens de teste; `null` se não foi possível fazê-lo. */
  census(): ProcessIdentity[] | null
  acquireLock(): 'acquired' | 'held' | 'error'
  releaseLock(): boolean
  spawnLauncher(executable: string, args: readonly string[], stdout: 'pipe' | 'ignore', cwd: string): ChildRun
  spawnElectron(scratchPath: string, caseDir: string): ChildRun
  /** Censo de `electron.exe` (identidade completa), só leitura. */
  electronCensus(): ProcessIdentity[] | null
  /** Caminho do executável do Electron do projeto (o que o supervisor inicia). */
  electronImagePath: string
  now(): number
  sleep(ms: number): Promise<void>
  /** Prazo global de um caso; `cancel` limpa o temporizador quando o processo termina antes. */
  deadline(ms: number): { reached: Promise<void>; cancel(): void }
  /** Só para testes: substitui a conferência dos artefatos (o supervisor real nunca passa isto). */
  validate?: typeof validateArtifacts
  /** Só para testes: idem, no modo diagnóstico. */
  validateDiagnosis?: (fs: Pick<BatteryFs, 'readFile'>, dir: string) => { set: ArtifactSet | null; issues: string[] }
  log(line: string): void
  /** Interrupção pedida (Ctrl+C): nenhum caso novo começa. */
  stopRequested?(): boolean
  /**
   * Só no T-F3 (6C.6C.3E): fatos do arquivo sem abri-lo para escrita
   * (existência, tipo, tamanho, atributo somente leitura).
   */
  fileFacts?(path: string): { exists: boolean; regularFile: boolean; size: number | null; readOnlyAttribute: boolean | null }
  /**
   * Só no T-F3: UMA tentativa de abrir o arquivo para escrita; qualquer
   * identificador obtido é fechado na hora, sem escrever nada.
   */
  probeWriteOpen?(path: string): WriteAttempt
  /** Só no T-F1 e no T-F4 (6C.6C.3G): pasta do build do segurador (`native/lock-holder-test/build/x64`). */
  lockHolderDir?: string
  /**
   * Inicia a cópia conferida do segurador, sem shell, com entrada, saída e
   * erro em pipe e ambiente mínimo (`lockHolderEnv`). Recusa outro executável.
   */
  spawnLockHolder?(executable: string, args: readonly string[], cwd: string): ChildRun
  /** Identidade sem seguir links (`lstat` bigint); `null` se não existir. Só objetos da pasta do caso. */
  statIdentity?(path: string): FsIdentity | null
  /** UMA renomeação (ou a restauração dela). Só os pares fixos da pasta do caso. */
  probeRename?(from: string, to: string): FsAttempt
  /** UMA exclusão. Só a cópia do alvo no T-F1. */
  probeUnlink?(path: string): FsAttempt
}

export type CaseStatus = 'pass' | 'fail' | 'skipped' | 'not-run'

export interface CaseResult {
  id: string
  test: TestId
  status: CaseStatus
  messages: string[]
  pid: number | null
  exitCode: number | null
  ms: number | null
  /** Só no modo diagnóstico. */
  diagnosis?: DiagnosisResult
}

export interface BatteryReport {
  exitCode: number
  preconditions: string[]
  results: CaseResult[]
  survivors: { owned: number; foreign: number } | null
  cleanup: CleanupResult | null
  lockReleased: boolean | null
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'erro'
}

// ── Artefatos ────────────────────────────────────────────────────────────────

export const artifactPaths = (dir: string) => ({
  launcher: win32.join(dir, TEST_LAUNCHER_NAME),
  manifest: win32.join(dir, 'test-manifest.json'),
  scenario: (id: ScenarioId) => win32.join(dir, 'scenarios', id, SYNTHETIC_HELPER_NAME)
})

export interface ArtifactSet {
  launcher: Buffer
  scenarios: Map<ScenarioId, Buffer>
  /** Só no T-F1 e no T-F4: o segurador de travas conferido. */
  lockHolder?: Buffer
}

/**
 * Lê e confere os artefatos: tamanho e SHA-256 aprovados, PE (políticas,
 * lista de importações) e identidade da variante; manifesto do build igual
 * aos valores aprovados. Problemas só como texto sem caminhos.
 */
export function validateArtifacts(fs: Pick<BatteryFs, 'readFile'>, dir: string, scenarios: readonly ScenarioId[] = GROUP_A_SCENARIOS): { set: ArtifactSet | null; issues: string[] } {
  const paths = artifactPaths(dir)
  const issues: string[] = []
  const read = (path: string, label: string): Buffer | null => {
    try {
      return fs.readFile(path)
    } catch (error) {
      issues.push(`${label}: não lido (${errorCode(error)})`)
      return null
    }
  }
  const launcher = read(paths.launcher, TEST_LAUNCHER_NAME)
  if (launcher !== null) {
    const approved = APPROVED_ARTIFACTS.launcher
    if (launcher.length !== approved.size || sha256(launcher) !== approved.sha256) issues.push(`${TEST_LAUNCHER_NAME}: tamanho ou SHA-256 diferente do aprovado`)
    const pe = checkHostBinary(launcher)
    const identity = checkVariantIdentity(launcher, 'test')
    if (pe.issues.length + identity.length > 0) issues.push(`${TEST_LAUNCHER_NAME}: PE ou identidade fora da política (${[...pe.issues, ...identity].join(', ')})`)
  }
  const set = new Map<ScenarioId, Buffer>()
  for (const id of scenarios) {
    const bytes = read(paths.scenario(id), `alvo ${id}`)
    if (bytes === null) continue
    const approved = APPROVED_ARTIFACTS.scenarios[id]
    if (bytes.length !== approved.size || sha256(bytes) !== approved.sha256) issues.push(`alvo ${id}: tamanho ou SHA-256 diferente do aprovado`)
    const pe = checkSyntheticBinary(bytes)
    if (pe.issues.length > 0) issues.push(`alvo ${id}: PE ou identidade fora da política (${pe.issues.join(', ')})`)
    set.set(id, bytes)
  }
  const manifestBytes = read(paths.manifest, 'test-manifest.json')
  if (manifestBytes !== null) {
    try {
      const m = JSON.parse(manifestBytes.toString('utf8')) as { launcher?: { sha256?: unknown }; syntheticHelpers?: Array<{ id?: unknown; sha256?: unknown }>; executed?: unknown }
      if (m.launcher?.sha256 !== APPROVED_ARTIFACTS.launcher.sha256) issues.push('test-manifest.json: launcher diferente do aprovado')
      for (const id of scenarios) {
        const entry = m.syntheticHelpers?.find((s) => s.id === id)
        if (entry?.sha256 !== APPROVED_ARTIFACTS.scenarios[id].sha256) issues.push(`test-manifest.json: alvo ${id} diferente do aprovado`)
      }
    } catch {
      issues.push('test-manifest.json: ilegível')
    }
  }
  return { set: issues.length === 0 && launcher !== null ? { launcher, scenarios: set } : null, issues }
}

/** Pasta do build diagnóstico, irmã da do build de testes. */
export const diagnosisLauncherPath = (artifactsDir: string, variant: DiagVariant) =>
  win32.join(win32.dirname(artifactsDir), 'diag', APPROVED_DIAG_LAUNCHERS[variant].variant, TEST_LAUNCHER_NAME)

/**
 * Modo diagnóstico: o alvo exit-ok (e o build de testes) conferidos como no
 * Grupo A, e a variante diagnóstica ESCOLHIDA com tamanho e SHA-256
 * aprovados, PE com a lista diagnóstica, identidade de testes e marca
 * diagnóstica certa. A outra variante nunca é lida.
 */
export function validateDiagnosisArtifacts(fs: Pick<BatteryFs, 'readFile'>, dir: string, variant: DiagVariant): { set: ArtifactSet | null; issues: string[] } {
  const approved = APPROVED_DIAG_LAUNCHERS[variant]
  const base = validateArtifacts(fs, dir, ['exit-ok'])
  const issues = [...base.issues]
  let launcher: Buffer | null = null
  try {
    launcher = fs.readFile(diagnosisLauncherPath(dir, variant))
  } catch (error) {
    issues.push(`variante diagnóstica: não lida (${errorCode(error)})`)
  }
  if (launcher !== null) {
    if (launcher.length !== approved.size || sha256(launcher) !== approved.sha256) issues.push('variante diagnóstica: tamanho ou SHA-256 diferente do aprovado')
    const pe = checkHostBinary(launcher, [], DIAG_HOST_ALLOWED_FUNCTIONS)
    const identity = [...checkVariantIdentity(launcher, 'test'), ...checkDiagMarker(launcher, approved.variant)]
    if (pe.issues.length + identity.length > 0) issues.push(`variante diagnóstica: PE ou identidade fora da política (${[...pe.issues, ...identity].join(', ')})`)
  }
  try {
    const m = JSON.parse(fs.readFile(win32.join(win32.dirname(dir), 'diag', 'diag-manifest.json')).toString('utf8')) as {
      acceptedTarget?: { sha256?: unknown; digests?: unknown }
      variants?: Array<{ id?: unknown; sha256?: unknown }>
    }
    if (m.variants?.find((v) => v.id === approved.variant)?.sha256 !== approved.sha256) issues.push('diag-manifest.json: variante diferente da aprovada')
    if (m.acceptedTarget?.sha256 !== APPROVED_ARTIFACTS.scenarios['exit-ok'].sha256 || m.acceptedTarget?.digests !== 1) issues.push('diag-manifest.json: alvo aceito diferente do exit-ok aprovado')
  } catch (error) {
    issues.push(`diag-manifest.json: não lido ou ilegível (${errorCode(error)})`)
  }
  const exitOk = base.set?.scenarios.get('exit-ok')
  return { set: issues.length === 0 && launcher !== null && exitOk !== undefined ? { launcher, scenarios: new Map([['exit-ok', exitOk]]) } : null, issues }
}

// ── Preparação de um caso ────────────────────────────────────────────────────

interface PreparedCase {
  dir: string
  launcherPath: string
  args: string[]
  /** Executáveis gravados nesta pasta (para a identidade dos sobreviventes). */
  executables: string[]
  skipped: string | null
}

function argsFor(c: CaseDefinition, modifiedHash: string | null): string[] {
  const hash = APPROVED_ARTIFACTS.scenarios[c.scenario].sha256
  switch (c.args) {
    case 'standard':
      return ['--protocol', '1', '--helper-sha256', hash]
    case 'extra-arg':
      return ['--protocol', '1', '--helper-sha256', hash, 'x']
    case 'uppercase-hash':
      return ['--protocol', '1', '--helper-sha256', hash.toUpperCase()]
    case 'protocol-2':
      return ['--protocol', '2', '--helper-sha256', hash]
    case 'other-scenario-hash':
      return ['--protocol', '1', '--helper-sha256', APPROVED_ARTIFACTS.scenarios[c.scenario === 'exit-contract' ? 'exit-ok' : 'exit-contract'].sha256]
    case 'modified-hash':
      if (modifiedHash === null) throw new Error('hash da cópia modificada ausente')
      return ['--protocol', '1', '--helper-sha256', modifiedHash]
  }
}

/** Grava e confere (pelo hash do que foi lido de volta) um arquivo da bateria. */
function writeVerified(fs: BatteryFs, path: string, bytes: Uint8Array): void {
  fs.writeFile(path, bytes)
  if (sha256(fs.readFile(path)) !== sha256(bytes)) throw Object.assign(new Error('cópia diferente do original'), { code: 'EINTEGRITY' })
}

export function prepareCase(fs: BatteryFs, scratch: string, index: number, c: CaseDefinition, artifacts: ArtifactSet): PreparedCase {
  const dir = win32.join(scratch, `${String(index + 1).padStart(2, '0')}-${c.id}`)
  const top = c.layout === 'wrong-folder' ? 'other' : 'host-test'
  const arch = win32.join(dir, top, 'win32-x64')
  fs.mkdirp(arch)
  const launcherPath = win32.join(arch, c.layout === 'renamed-launcher' ? RENAMED_LAUNCHER_NAME : TEST_LAUNCHER_NAME)
  writeVerified(fs, launcherPath, artifacts.launcher)
  const executables = [launcherPath]
  const helperPath = win32.join(arch, SYNTHETIC_HELPER_NAME)
  const scenario = artifacts.scenarios.get(c.scenario)
  if (scenario === undefined) throw Object.assign(new Error('cenário não conferido'), { code: 'EINTEGRITY' })
  let modifiedHash: string | null = null
  let skipped: string | null = null
  switch (c.layout) {
    case 'helper-missing':
      break
    case 'helper-tiny':
      writeVerified(fs, helperPath, new Uint8Array(512))
      break
    case 'helper-modified': {
      const modified = Buffer.concat([scenario, Buffer.from([0])])
      writeVerified(fs, helperPath, modified)
      modifiedHash = sha256(modified)
      executables.push(helperPath)
      break
    }
    case 'helper-symlink': {
      const real = win32.join(dir, 'real')
      fs.mkdirp(real)
      const target = win32.join(real, SYNTHETIC_HELPER_NAME)
      writeVerified(fs, target, scenario)
      executables.push(target, helperPath)
      try {
        fs.symlinkFile(target, helperPath)
      } catch (error) {
        if (errorCode(error) !== 'EPERM') throw error
        skipped = 'sem permissão para criar link simbólico nesta sessão'
      }
      break
    }
    default:
      writeVerified(fs, helperPath, scenario)
      executables.push(helperPath)
  }
  return { dir, launcherPath, args: argsFor(c, modifiedHash), executables, skipped }
}

// ── Execução de um processo com prazo global ────────────────────────────────

async function runWithDeadline(deps: BatteryDeps, run: ChildRun, deadlineMs: number): Promise<{ raw: RawRun | null; deadlineHit: boolean }> {
  let deadlineHit = false
  const timer = deps.deadline(deadlineMs)
  const first = await Promise.race([run.done, timer.reached.then(() => 'deadline' as const)])
  timer.cancel()
  if (first !== 'deadline') return { raw: first, deadlineHit }
  deadlineHit = true
  run.kill()
  // Depois de encerrar o próprio processo, o close tem de chegar (D60); senão, situação incerta.
  const settled = await Promise.race([run.done, deps.sleep(CLOSE_AFTER_EXIT_MS).then(() => null)])
  return { raw: settled, deadlineHit }
}

// ── Sobreviventes ────────────────────────────────────────────────────────────

const imageOf = (p: ProcessIdentity) => (p.path === null ? 'desconhecida' : win32.basename(p.path))

/**
 * Censo depois de um caso. Com sobreviventes, NADA é encerrado: o Node não
 * consegue garantir a identidade de um processo no instante do encerramento
 * (não há identificador do processo, só o PID, que pode ser reutilizado entre
 * a leitura e o encerramento). A bateria é interrompida e a inspeção é manual.
 * As identidades são registradas e classificadas (desta bateria ou não).
 * `null` no retorno = nenhum sobrevivente.
 */
function reportSurvivors(deps: BatteryDeps, owned: readonly string[], batteryStart: string): { owned: number; foreign: number; unknown: boolean } | null {
  const census = deps.census()
  if (census === null) {
    deps.log('Censo de processos indisponível: a bateria é interrompida (situação desconhecida). Inspeção manual necessária.')
    return { owned: 0, foreign: 0, unknown: true }
  }
  if (census.length === 0) return null
  const plan = classifySurvivors(census, owned, batteryStart)
  for (const p of plan.owned) deps.log(`Sobrevivente desta bateria: PID ${p.pid}, imagem ${imageOf(p)}, pai ${p.ppid}; NÃO encerrado. Inspeção manual necessária.`)
  for (const p of plan.foreign) deps.log(`Processo de teste FORA desta bateria: PID ${p.pid}, imagem ${imageOf(p)}; não tocado. Inspeção manual necessária.`)
  return { owned: plan.owned.length, foreign: plan.foreign.length, unknown: false }
}

/**
 * Depois do caso Electron: processos `electron.exe` do PRÓPRIO Electron do
 * projeto criados depois do início do caso (a instância iniciada e os filhos
 * dela). Só leitura; nada é encerrado. `null` = censo indisponível.
 */
function electronLeftovers(deps: BatteryDeps, caseStart: string): ProcessIdentity[] | null {
  const census = deps.electronCensus()
  if (census === null) return null
  const own = deps.electronImagePath.toLowerCase()
  return census.filter((p) => p.path !== null && p.path.toLowerCase() === own && p.created !== '0' && filetimeAtLeast(p.created, caseStart))
}

// ── Pré-condições ────────────────────────────────────────────────────────────

/** Pré-condições sem iniciar nada (também usadas por `--check-only`). */
export function checkPreconditions(
  deps: BatteryDeps,
  tests: readonly TestId[],
  validator: typeof validateArtifacts = deps.validate ?? validateArtifacts
): { failures: string[]; artifacts: ArtifactSet | null; report: string[] } {
  const failures: string[] = []
  const report: string[] = []
  if (deps.platform !== 'win32' || deps.arch !== 'x64') failures.push('não é Windows x64')
  if (!/^[A-Za-z]:\\/.test(deps.tmpRoot)) failures.push('pasta temporária do sistema não está numa unidade local')
  const level = deps.integrityLevel()
  report.push(`nível de integridade: ${level}`)
  if (!isUnelevated(level)) failures.push('supervisor elevado ou nível de integridade desconhecido')
  const census = deps.census()
  report.push(`processos de teste em execução: ${census === null ? 'desconhecido' : census.length}`)
  if (census === null || census.length > 0) failures.push('há processos de teste em execução (ou o censo falhou); nada é tocado')
  if (tests.includes('T-R1')) {
    const version = deps.electronVersion()
    report.push(`Electron do projeto: ${version ?? 'não encontrado'}`)
    if (version === null || !/^45\./.test(version)) failures.push('Electron do projeto não é a versão 45')
  }
  const { set, issues } = validator(deps.fs, deps.artifactsDir)
  report.push(`artefatos: ${issues.length === 0 ? 'tamanho, SHA-256, PE e identidade conferidos' : `${issues.length} problema(s)`}`)
  failures.push(...issues)
  return { failures, artifacts: set, report }
}

// ── Bateria ──────────────────────────────────────────────────────────────────

function parseElectron(raw: RawRun): ElectronObservation | null {
  const line = raw.stdout.split(/\r?\n/).find((l) => l.startsWith(ELECTRON_RESULT_MARK))
  if (line === undefined) return null
  try {
    const value = JSON.parse(line.slice(ELECTRON_RESULT_MARK.length)) as ElectronObservation
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

interface SequenceSpec {
  cases: readonly CaseDefinition[]
  tests: readonly TestId[]
  validator: typeof validateArtifacts
  launcherSha256: string
  /** Variante diagnóstica escolhida; `null` = bateria do Grupo A. */
  diagnosis: DiagVariant | null
}

export const runBattery = (deps: BatteryDeps, tests: readonly TestId[]): Promise<BatteryReport> =>
  runSequence(deps, { cases: casesFor(tests), tests, validator: deps.validate ?? validateArtifacts, launcherSha256: APPROVED_ARTIFACTS.launcher.sha256, diagnosis: null })

/** Execução diagnóstica ÚNICA do T-H1.exit-ok com a variante diagnóstica escolhida (6C.6C.2C/2D). */
export const runDiagnosis = (deps: BatteryDeps, variant: DiagVariant): Promise<BatteryReport> =>
  runSequence(deps, {
    cases: [DIAGNOSIS_CASE],
    tests: [DIAGNOSIS_CASE.test],
    validator: deps.validateDiagnosis ?? ((fs, dir) => validateDiagnosisArtifacts(fs, dir, variant)),
    launcherSha256: APPROVED_DIAG_LAUNCHERS[variant].sha256,
    diagnosis: variant
  })

async function runSequence(deps: BatteryDeps, spec: SequenceSpec): Promise<BatteryReport> {
  const { cases, tests } = spec
  const results: CaseResult[] = cases.map((c) => ({ id: c.id, test: c.test, status: 'not-run', messages: [], pid: null, exitCode: null, ms: null }))
  const report: BatteryReport = { exitCode: BATTERY_EXIT.precondition, preconditions: [], results, survivors: null, cleanup: null, lockReleased: null }

  const pre = checkPreconditions(deps, tests, spec.validator)
  report.preconditions = pre.report
  if (pre.failures.length > 0 || pre.artifacts === null) {
    for (const f of pre.failures) deps.log(`Pré-condição não atendida: ${f}`)
    deps.log('Nenhum processo foi iniciado.')
    return report
  }
  const lock = deps.acquireLock()
  if (lock !== 'acquired') {
    deps.log(lock === 'held' ? 'Outra bateria em andamento, ou trava antiga na pasta temporária. Nenhum processo foi iniciado.' : 'Não foi possível criar a trava. Nenhum processo foi iniciado.')
    return report
  }

  let scratch: ScratchDir | null = null
  try {
    try {
      scratch = createScratch(deps.fs, deps.tmpRoot, BATTERY_SCRATCH_PREFIX)
    } catch (error) {
      deps.log(`Pasta exclusiva não criada (${errorCode(error)}). Nenhum processo foi iniciado.`)
      return report
    }
    const batteryStart = filetimeFromMs(deps.now() - 1_000)
    const owned: string[] = []
    report.exitCode = BATTERY_EXIT.ok

    for (const [index, c] of cases.entries()) {
      const result = results[index]!
      if (deps.stopRequested?.() === true) {
        deps.log('Interrompida a pedido: nenhum caso novo começa.')
        report.exitCode = BATTERY_EXIT.interrupted
        break
      }
      let prepared: PreparedCase
      try {
        prepared = prepareCase(deps.fs, scratch.path, index, c, pre.artifacts)
      } catch (error) {
        result.status = 'fail'
        result.messages.push(`preparação falhou (${errorCode(error)}); nada iniciado neste caso`)
        report.exitCode = BATTERY_EXIT.caseFailed
        break
      }
      owned.push(...prepared.executables)
      if (prepared.skipped !== null) {
        result.status = 'skipped'
        result.messages.push(prepared.skipped)
        deps.log(`${c.id}: pulado (${prepared.skipped}).`)
        continue
      }

      const started = deps.now()
      const caseStart = filetimeFromMs(started - 1_000)
      const run = c.runner === 'electron' ? deps.spawnElectron(scratch.path, prepared.dir) : deps.spawnLauncher(prepared.launcherPath, prepared.args, c.stdout, prepared.dir)
      result.pid = run.pid
      const image = c.runner === 'electron' ? 'electron.exe (entrada de teste)' : `${win32.basename(prepared.launcherPath)}${spec.diagnosis !== null ? ` [variante diagnóstica ${spec.diagnosis}]` : ''} (SHA-256 ${spec.launcherSha256.slice(0, 12)}…)`
      deps.log(`${c.id}: iniciado PID ${run.pid ?? '-'}, imagem ${image}, alvo ${c.scenario} (SHA-256 ${APPROVED_ARTIFACTS.scenarios[c.scenario].sha256.slice(0, 12)}…), prazo ${c.deadlineMs} ms.`)
      const { raw, deadlineHit } = await runWithDeadline(deps, run, c.deadlineMs)
      result.ms = deps.now() - started

      let verdict: Verdict
      if (raw === null) {
        verdict = { pass: false, reasons: ['o processo iniciado não confirmou o fim depois de encerrado (situação incerta)'] }
      } else if (c.runner === 'electron') {
        result.exitCode = raw.exitCode
        const observed = parseElectron(raw)
        verdict =
          observed === null || raw.exitCode !== 0 || deadlineHit
            ? { pass: false, reasons: [`entrada Electron sem resultado válido (código ${raw.exitCode ?? 'nenhum'}${deadlineHit ? ', prazo estourado' : ''})`] }
            : evaluateElectron(observed)
      } else if (spec.diagnosis !== null) {
        result.exitCode = raw.exitCode
        const diagnosis = evaluateDiagnosis({ ...raw, deadlineHit }, spec.diagnosis)
        result.diagnosis = diagnosis
        const split = splitDiagnosticOutput(raw.stdout)
        // Saída do alvo: só linhas no formato do alvo sintético são mostradas; o resto, só contado.
        const targetLines = split.rest.split(/\r?\n/).filter((l) => l !== '')
        const shown = targetLines.filter((l) => /^gerpro-synthetic scenario=[a-z-]+( [a-z-]+=[0-9A-Za-z,x-]{1,64}){0,12}$/.test(l))
        for (const l of shown) deps.log(`${c.id}: saída do alvo pelo pipe: ${l}`)
        if (shown.length === 0) deps.log(`${c.id}: saída do alvo pelo pipe: nenhuma linha`)
        if (targetLines.length > shown.length) deps.log(`${c.id}: ${targetLines.length - shown.length} linha(s) fora do formato do alvo (não mostradas)`)
        if (diagnosis.fields !== null) deps.log(`${c.id}: linha diagnóstica: ${split.diagnostic[0]}`)
        for (const issue of diagnosis.issues) deps.log(`${c.id}: problema na linha diagnóstica: ${issue}`)
        for (const criterion of diagnosis.criteria) deps.log(`${c.id}: critério não atendido: ${criterion}`)
        const reasons = [...(diagnosis.verdict.pass ? [] : diagnosis.verdict.reasons), ...diagnosis.issues, ...diagnosis.criteria]
        verdict = reasons.length > 0 ? { pass: false, reasons } : diagnosis.verdict
      } else {
        result.exitCode = raw.exitCode
        const observation: CaseObservation = { ...raw, deadlineHit }
        verdict = evaluateCase(c, observation)
      }

      // Censo depois de cada caso, antes de qualquer conclusão. Nada é encerrado aqui.
      const survivors = reportSurvivors(deps, owned, batteryStart)
      if (survivors !== null) {
        report.survivors = { owned: survivors.owned, foreign: survivors.foreign }
        result.status = 'fail'
        result.messages.push(survivors.unknown ? 'censo indisponível depois do caso' : 'processo de teste sobrevivente depois do caso (não encerrado; inspeção manual)')
        report.exitCode = BATTERY_EXIT.survivors
        break
      }
      if (c.runner === 'electron') {
        // Os filhos do Chromium saem logo depois do processo principal: até 3 leituras, 1 s entre elas.
        let leftovers = electronLeftovers(deps, caseStart)
        for (let read = 1; read < ELECTRON_CENSUS_READS && leftovers !== null && leftovers.length > 0; read++) {
          await deps.sleep(1_000)
          leftovers = electronLeftovers(deps, caseStart)
        }
        if (leftovers === null || leftovers.length > 0) {
          for (const p of leftovers ?? []) deps.log(`Processo do Electron de teste ainda ativo: PID ${p.pid}, pai ${p.ppid}; NÃO encerrado. Inspeção manual necessária.`)
          result.status = 'fail'
          result.messages.push(leftovers === null ? 'censo do Electron indisponível' : 'processo do Electron de teste ainda ativo (não encerrado; inspeção manual)')
          report.exitCode = BATTERY_EXIT.survivors
          break
        }
        deps.log(`${c.id}: censo do Electron de teste depois do caso: 0.`)
      }
      if (verdict.pass) {
        result.status = 'pass'
        result.messages.push(...verdict.notes)
        deps.log(`${c.id}: aprovado (código ${result.exitCode ?? '-'}, ${result.ms} ms).`)
      } else {
        result.status = 'fail'
        result.messages.push(...verdict.reasons)
        deps.log(`${c.id}: REPROVADO: ${verdict.reasons.join('; ')}. A bateria para aqui.`)
        report.exitCode = BATTERY_EXIT.caseFailed
        break
      }
    }
    return report
  } finally {
    if (scratch !== null) {
      report.cleanup = await removeScratch(deps.fs, scratch, { tmpRoot: deps.tmpRoot, prefix: BATTERY_SCRATCH_PREFIX })
      if (!report.cleanup.removed && report.exitCode === BATTERY_EXIT.ok) report.exitCode = BATTERY_EXIT.cleanupFailed
    }
    report.lockReleased = deps.releaseLock()
    if (!report.lockReleased && report.exitCode === BATTERY_EXIT.ok) report.exitCode = BATTERY_EXIT.cleanupFailed
    const final = deps.census()
    deps.log(`Censo final: ${final === null ? 'desconhecido' : final.length}.`)
    if ((final === null || final.length > 0) && report.exitCode === BATTERY_EXIT.ok) report.exitCode = BATTERY_EXIT.survivors
  }
}

// ── Encerramento pelo supervisor: T-K1.hang (6C.6C.3A) ──────────────────────

/** Conferência dos artefatos dos modos do alvo hang (T-K1 e T-T1): launcher de testes e SÓ o alvo hang. */
export const validateTerminationArtifacts = (fs: Pick<BatteryFs, 'readFile'>, dir: string) => validateArtifacts(fs, dir, ['hang'])

export interface TerminationReport extends BatteryReport {
  termination: TerminationResult | null
  /** Observação completa do caso (tempos, código, sinal, censo); `null` se nada foi iniciado. */
  observation: TerminationObservation | null
}

/**
 * Execução ÚNICA do T-K1.hang (6C.6C.3A): o supervisor encerra o launcher
 * 500 ms depois da linha do alvo.
 */
export const runTermination = (deps: BatteryDeps): Promise<TerminationReport> => runHangCase(deps, TERMINATION_CASE, 'supervisor-kill')

/**
 * Execução ÚNICA do T-T1.hang (6C.6C.3B): o supervisor NÃO intervém; espera o
 * launcher sair sozinho pelo prazo interno. Só ao vencer o prazo externo
 * (5 s desde o início) ele encerra o launcher, e o caso reprova.
 */
export const runLauncherTimeout = (deps: BatteryDeps): Promise<TerminationReport> => runHangCase(deps, LAUNCHER_TIMEOUT_CASE, 'launcher-timeout')

/**
 * Execução ÚNICA do T-F3.hang (6C.6C.3E): igual ao T-T1 e, logo depois da
 * linha do alvo (com o launcher ativo), UMA tentativa de abrir a cópia do alvo
 * para escrita. Nada é escrito, renomeado ou apagado.
 */
export const runFileLock = (deps: BatteryDeps): Promise<TerminationReport> => runHangCase(deps, FILE_LOCK_CASE, 'file-lock')

/**
 * Roteiro comum dos casos com o alvo hang. Mesmas pré-condições, trava, pasta
 * exclusiva e censos do Grupo A. O único encerramento que o supervisor pode
 * fazer é o do launcher que ele iniciou, pelo identificador desse processo;
 * sobreviventes nunca são encerrados (inspeção manual). Sem nova tentativa.
 */
async function runHangCase(deps: BatteryDeps, c: HangCase, strategy: 'supervisor-kill' | 'launcher-timeout' | 'file-lock'): Promise<TerminationReport> {
  const result: CaseResult = { id: c.id, test: c.test, status: 'not-run', messages: [], pid: null, exitCode: null, ms: null }
  const report: TerminationReport = { exitCode: BATTERY_EXIT.precondition, preconditions: [], results: [result], survivors: null, cleanup: null, lockReleased: null, termination: null, observation: null }

  const pre = checkPreconditions(deps, [c.test], deps.validate ?? validateTerminationArtifacts)
  report.preconditions = pre.report
  if (pre.failures.length > 0 || pre.artifacts === null) {
    for (const f of pre.failures) deps.log(`Pré-condição não atendida: ${f}`)
    deps.log('Nenhum processo foi iniciado.')
    return report
  }
  const lock = deps.acquireLock()
  if (lock !== 'acquired') {
    deps.log(lock === 'held' ? 'Outra bateria em andamento, ou trava antiga na pasta temporária. Nenhum processo foi iniciado.' : 'Não foi possível criar a trava. Nenhum processo foi iniciado.')
    return report
  }

  let scratch: ScratchDir | null = null
  try {
    try {
      scratch = createScratch(deps.fs, deps.tmpRoot, BATTERY_SCRATCH_PREFIX)
    } catch (error) {
      deps.log(`Pasta exclusiva não criada (${errorCode(error)}). Nenhum processo foi iniciado.`)
      return report
    }
    const batteryStart = filetimeFromMs(deps.now() - 1_000)
    let prepared: PreparedCase
    try {
      prepared = prepareCase(deps.fs, scratch.path, 0, c, pre.artifacts)
    } catch (error) {
      result.status = 'fail'
      result.messages.push(`preparação falhou (${errorCode(error)}); nada iniciado`)
      report.exitCode = BATTERY_EXIT.caseFailed
      return report
    }

    const started = deps.now()
    const run = deps.spawnLauncher(prepared.launcherPath, prepared.args, c.stdout, prepared.dir)
    result.pid = run.pid
    const plan =
      strategy === 'supervisor-kill'
        ? `encerramento do launcher ${TERMINATION_KILL_AFTER_READY_MS} ms depois dela`
        : `sem intervenção; prazo externo ${LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS} ms desde o início`
    deps.log(
      `${c.id}: iniciado PID ${run.pid ?? '-'}, imagem ${win32.basename(prepared.launcherPath)} (SHA-256 ${APPROVED_ARTIFACTS.launcher.sha256.slice(0, 12)}…), alvo hang (SHA-256 ${APPROVED_ARTIFACTS.scenarios.hang.sha256.slice(0, 12)}…); linha do alvo em até ${TERMINATION_READY_TIMEOUT_MS} ms; ${plan}.`
    )

    let settled: RawRun | null = null
    run.done.then((r) => {
      settled = r
    })
    const obs: FileLockObservation = {
      attemptMs: null,
      launcherAliveAtAttempt: null,
      target: null,
      attempt: null,
      hashBefore: null,
      hashAfterAttempt: null,
      hashAfterRun: null,
      spawnError: null,
      pid: run.pid,
      readyMs: null,
      killRequestedMs: null,
      killAccepted: null,
      exitCode: null,
      exitSignal: null,
      exitMs: null,
      closeMs: null,
      stdout: '',
      stderrBytes: 0,
      censusAfter: null
    }

    // 1. Esperar a linha do alvo (ou o fim do processo, ou o prazo).
    const readyTimer = deps.deadline(TERMINATION_READY_TIMEOUT_MS)
    const readyOutcome = await Promise.race([
      run.ready ? run.ready(HANG_READY_LINE) : Promise.resolve(null),
      run.done.then(() => null),
      readyTimer.reached.then(() => null)
    ])
    readyTimer.cancel()
    obs.readyMs = readyOutcome
    if (obs.readyMs !== null) deps.log(`${c.id}: alvo anunciou que está rodando em ${obs.readyMs} ms.`)
    else deps.log(`${c.id}: o alvo não anunciou que estava rodando (o launcher pode ter saído ou não chegou à retomada).`)

    // 1b. T-F3: UMA tentativa de abrir o alvo em execução para escrita, com o launcher ativo.
    const helperPath = win32.join(win32.dirname(prepared.launcherPath), SYNTHETIC_HELPER_NAME)
    const hashOf = (): string | null => {
      try {
        return sha256(deps.fs.readFile(helperPath))
      } catch {
        return null
      }
    }
    if (strategy === 'file-lock' && obs.readyMs !== null) {
      obs.launcherAliveAtAttempt = settled === null
      if (!obs.launcherAliveAtAttempt) deps.log(`${c.id}: o launcher já tinha saído; nenhuma tentativa feita.`)
      else if (deps.fileFacts === undefined || deps.probeWriteOpen === undefined) deps.log(`${c.id}: tentativa indisponível neste supervisor; nenhuma tentativa feita.`)
      else {
        const facts = deps.fileFacts(helperPath)
        obs.target = { ...facts, insideScratch: helperPath.toLowerCase().startsWith(win32.join(scratch.path, win32.sep).toLowerCase()) }
        obs.hashBefore = hashOf()
        obs.attemptMs = deps.now() - started
        obs.attempt = deps.probeWriteOpen(helperPath)
        obs.hashAfterAttempt = hashOf()
        deps.log(
          `${c.id}: tentativa de abrir o alvo para escrita em ${obs.attemptMs} ms: ${obs.attempt.opened ? 'PERMITIDA (identificador fechado na hora, sem escrita)' : `recusada (${obs.attempt.code ?? '?'}, errno ${obs.attempt.errno ?? '?'})`}.`
        )
      }
    }

    // 2. Prazo do supervisor: só se o launcher ainda não terminou.
    if (strategy === 'supervisor-kill' && obs.readyMs !== null && settled === null) {
      const killTimer = deps.deadline(TERMINATION_KILL_AFTER_READY_MS)
      await Promise.race([killTimer.reached, run.done.then(() => undefined)])
      killTimer.cancel()
    } else if ((strategy === 'launcher-timeout' || strategy === 'file-lock') && settled === null) {
      // O launcher tem de sair sozinho; o prazo externo conta desde o início.
      const external = deps.deadline(Math.max(0, LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS - (deps.now() - started)))
      await Promise.race([external.reached, run.done.then(() => undefined)])
      external.cancel()
      if (settled === null) deps.log(`${c.id}: prazo externo de ${LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS} ms vencido sem o fim do launcher: o supervisor INTERVÉM.`)
    }
    if (settled === null) {
      obs.killRequestedMs = deps.now() - started
      const accepted = run.kill()
      obs.killAccepted = accepted === true
      deps.log(`${c.id}: encerramento do launcher PEDIDO em ${obs.killRequestedMs} ms, pelo identificador do processo iniciado (PID ${run.pid ?? '-'}): ${obs.killAccepted ? 'aceito' : 'NÃO aceito'}.`)
      const closeTimer = deps.deadline(TERMINATION_CLOSE_AFTER_KILL_MS)
      await Promise.race([run.done.then(() => undefined), closeTimer.reached])
      closeTimer.cancel()
    } else {
      deps.log(`${c.id}: o launcher terminou sozinho antes do prazo do supervisor; nenhum encerramento pedido pelo supervisor.`)
    }
    result.ms = deps.now() - started

    const raw = settled as RawRun | null
    if (raw !== null) {
      obs.spawnError = raw.spawnError
      obs.exitCode = raw.exitCode
      obs.exitSignal = raw.exitSignal ?? null
      obs.exitMs = raw.exitMs
      obs.closeMs = raw.closeMs
      obs.stdout = raw.stdout
      obs.stderrBytes = raw.stderrBytes
      result.exitCode = raw.exitCode
      deps.log(`${c.id}: exit ${raw.exitMs ?? '-'} ms (código ${raw.exitCode ?? '-'}, sinal ${raw.exitSignal ?? '-'}), close ${raw.closeMs ?? '-'} ms.`)
      for (const l of raw.stdout.split(/\r?\n/).filter((x) => x !== '')) deps.log(`${c.id}: saída do alvo pelo pipe: ${l === HANG_READY_LINE ? l : '(linha fora do formato, não mostrada)'}`)
    } else {
      deps.log(`${c.id}: o close NÃO chegou em ${TERMINATION_CLOSE_AFTER_KILL_MS} ms depois do pedido: situação incerta.`)
    }

    if (strategy === 'file-lock') obs.hashAfterRun = hashOf()

    // 3. Censo logo depois. Nada é encerrado aqui.
    const census = deps.census()
    obs.censusAfter = census === null ? null : census.length
    deps.log(`${c.id}: censo logo depois do encerramento: ${obs.censusAfter ?? 'desconhecido'}.`)
    if (census === null || census.length > 0) {
      if (census !== null) {
        const plan = classifySurvivors(census, prepared.executables, batteryStart)
        for (const p of plan.owned) deps.log(`Sobrevivente desta execução: PID ${p.pid}, imagem ${imageOf(p)}, pai ${p.ppid}; NÃO encerrado. Inspeção manual necessária.`)
        for (const p of plan.foreign) deps.log(`Processo de teste FORA desta execução: PID ${p.pid}, imagem ${imageOf(p)}; não tocado. Inspeção manual necessária.`)
        report.survivors = { owned: plan.owned.length, foreign: plan.foreign.length }
      } else {
        deps.log('Censo de processos indisponível: situação desconhecida. Inspeção manual necessária.')
        report.survivors = { owned: 0, foreign: 0 }
      }
    }

    const termination = strategy === 'supervisor-kill' ? evaluateTermination(obs) : strategy === 'file-lock' ? evaluateFileLock(obs) : evaluateLauncherTimeout(obs)
    report.termination = termination
    report.observation = obs
    for (const e of termination.evidence) deps.log(`${c.id}: evidência: ${e}`)
    if (report.survivors !== null) {
      result.status = 'fail'
      result.messages.push('processo de teste sobrevivente ou censo indisponível (não encerrado; inspeção manual)')
      report.exitCode = BATTERY_EXIT.survivors
    } else if (termination.verdict.pass) {
      result.status = 'pass'
      report.exitCode = BATTERY_EXIT.ok
      deps.log(`${c.id}: aprovado (${result.ms} ms).`)
    } else {
      result.status = 'fail'
      result.messages.push(...termination.verdict.reasons)
      report.exitCode = BATTERY_EXIT.caseFailed
      deps.log(`${c.id}: REPROVADO: ${termination.verdict.reasons.join('; ')}.`)
    }
    return report
  } finally {
    if (scratch !== null) {
      report.cleanup = await removeScratch(deps.fs, scratch, { tmpRoot: deps.tmpRoot, prefix: BATTERY_SCRATCH_PREFIX })
      if (!report.cleanup.removed && report.exitCode === BATTERY_EXIT.ok) report.exitCode = BATTERY_EXIT.cleanupFailed
    }
    report.lockReleased = deps.releaseLock()
    if (!report.lockReleased && report.exitCode === BATTERY_EXIT.ok) report.exitCode = BATTERY_EXIT.cleanupFailed
    const final = deps.census()
    deps.log(`Censo final: ${final === null ? 'desconhecido' : final.length}.`)
    if ((final === null || final.length > 0) && report.exitCode === BATTERY_EXIT.ok) report.exitCode = BATTERY_EXIT.survivors
  }
}

// ── Segurador de travas: T-F1.exit-ok e T-F4.exit-ok (6C.6C.3G) ─────────────

/** Bytes do segurador: tamanho e SHA-256 aprovados, PE com a lista explícita, identidade do segurador. */
export function lockHolderIssues(bytes: Buffer): string[] {
  const approved = APPROVED_ARTIFACTS.lockHolder
  const issues: string[] = []
  if (bytes.length !== approved.size || sha256(bytes) !== approved.sha256) issues.push(`${LOCK_HOLDER_NAME}: tamanho ou SHA-256 diferente do aprovado`)
  const pe = checkLockHolderBinary(bytes)
  if (pe.issues.length + pe.unexpectedFunctions.length > 0) issues.push(`${LOCK_HOLDER_NAME}: PE ou identidade fora da política (${[...pe.issues, ...pe.unexpectedFunctions].join(', ')})`)
  return issues
}

/**
 * Artefatos do T-F1 e do T-F4: o build de testes como no Grupo A, só com o
 * alvo exit-ok (copiado, nunca executado), e o segurador de travas com
 * tamanho, SHA-256, PE e identidade aprovados; o manifesto do build do
 * segurador igual ao aprovado (nunca a fonte da verdade).
 */
export function validateLockHolderArtifacts(fs: Pick<BatteryFs, 'readFile'>, dir: string, lockHolderDir: string | undefined): { set: ArtifactSet | null; issues: string[] } {
  const base = validateArtifacts(fs, dir, ['exit-ok'])
  const issues = [...base.issues]
  let holder: Buffer | null = null
  if (lockHolderDir === undefined) issues.push('segurador: pasta do build não informada')
  else {
    try {
      holder = fs.readFile(win32.join(lockHolderDir, LOCK_HOLDER_NAME))
    } catch (error) {
      issues.push(`${LOCK_HOLDER_NAME}: não lido (${errorCode(error)})`)
    }
    if (holder !== null) issues.push(...lockHolderIssues(holder))
    try {
      const m = JSON.parse(fs.readFile(win32.join(lockHolderDir, 'lock-holder-manifest.json')).toString('utf8')) as { sha256?: unknown; size?: unknown }
      if (m.sha256 !== APPROVED_ARTIFACTS.lockHolder.sha256 || m.size !== APPROVED_ARTIFACTS.lockHolder.size) issues.push('lock-holder-manifest.json: diferente do aprovado')
    } catch (error) {
      issues.push(`lock-holder-manifest.json: não lido ou ilegível (${errorCode(error)})`)
    }
  }
  return { set: issues.length === 0 && base.set !== null && holder !== null ? { ...base.set, lockHolder: holder } : null, issues }
}

/** Funções do supervisor exigidas por um caso (uma por tipo de tentativa). */
function missingLockHolderDeps(deps: BatteryDeps, c: LockHolderCase): string[] {
  const missing: string[] = []
  if (deps.spawnLockHolder === undefined) missing.push('início do segurador')
  if (deps.statIdentity === undefined) missing.push('leitura de identidade')
  const kinds = new Set(c.attempts.map((id) => ATTEMPTS[id].kind))
  if (kinds.has('open-rw') && deps.probeWriteOpen === undefined) missing.push('abertura para escrita')
  if (kinds.has('rename') && deps.probeRename === undefined) missing.push('renomeação')
  if (kinds.has('unlink') && deps.probeUnlink === undefined) missing.push('exclusão')
  return missing
}

/** Pré-condições do T-F1/T-F4 sem iniciar nada (também usadas por `--check-only`). */
export function checkLockHolderPreconditions(deps: BatteryDeps, caseId: LockHolderCaseId): { failures: string[]; artifacts: ArtifactSet | null; report: string[] } {
  const c = LOCK_HOLDER_CASES[caseId]
  const pre = checkPreconditions(deps, [c.test], deps.validate ?? ((fs, dir) => validateLockHolderArtifacts(fs, dir, deps.lockHolderDir)))
  const failures = [...pre.failures]
  const base = lockHolderBaseIssues(deps.tmpRoot)
  failures.push(...base)
  const missing = missingLockHolderDeps(deps, c)
  if (missing.length > 0) failures.push(`supervisor sem: ${missing.join(', ')}`)
  if (pre.artifacts !== null && pre.artifacts.lockHolder === undefined) failures.push('segurador de travas não conferido')
  const report = [
    ...pre.report,
    `segurador aprovado: ${LOCK_HOLDER_NAME}, ${APPROVED_ARTIFACTS.lockHolder.size} bytes, SHA-256 ${APPROVED_ARTIFACTS.lockHolder.sha256}`,
    `pasta temporária para o segurador: ${base.length === 0 ? 'aceita (TMP e TEMP do segurador = esta pasta)' : `${base.length} problema(s)`}`,
    `caso ${c.id}: modo ${c.mode}; tentativas, uma vez cada: ${c.attempts.map((id) => ATTEMPTS[id].label).join(', ')}`
  ]
  return { failures, artifacts: failures.length === 0 ? pre.artifacts : null, report }
}

/** Monta a pasta do caso: cópia conferida do exit-ok no layout do launcher e cópia conferida do segurador FORA de host-test. */
function prepareLockHolderCase(fs: BatteryFs, scratch: string, c: LockHolderCase, artifacts: ArtifactSet): CaseLayout {
  const layout = caseLayout(lockHolderCaseDir(scratch, c))
  const exitOk = artifacts.scenarios.get(c.scenario)
  if (exitOk === undefined || artifacts.lockHolder === undefined) throw Object.assign(new Error('artefato não conferido'), { code: 'EINTEGRITY' })
  fs.mkdirp(layout.arch)
  writeVerified(fs, layout.file, exitOk)
  fs.mkdirp(layout.holderDir)
  writeVerified(fs, layout.holder, artifacts.lockHolder)
  return layout
}

export interface LockHolderReport extends BatteryReport {
  lockHolder: LockHolderResult | null
  /** Observação completa; `null` se o segurador não foi iniciado. */
  observation: LockHolderObservation | null
}

/**
 * Execução ÚNICA do T-F1.exit-ok ou do T-F4.exit-ok (6C.6C.3G). Roteiro:
 *  1. pré-condições (censo 0, sem elevação, artefatos e segurador aprovados), trava da bateria;
 *  2. pasta exclusiva; cópias conferidas pelo hash;
 *  3. cópia do segurador conferida de novo (tamanho, SHA-256, PE, identidade) logo antes de iniciar;
 *  4. só o segurador é iniciado; prontidão em até 2 s;
 *  5. volume e índice dos objetos conferidos contra a prontidão;
 *  6. as tentativas do caso, na ordem, uma vez cada; uma que funcione interrompe
 *     o cenário e só o objeto temporário movido é restaurado (identidade conferida);
 *  7. resultados registrados;
 *  8. liberação só pelo fechamento da entrada padrão;
 *  9. `released reason=stdin` e código 0 em até 1 s;
 * 10. censo 0, limpeza da pasta exclusiva, trava liberada, censo final.
 * Falha em qualquer ponto depois do início: só o segurador iniciado é
 * encerrado, pelo identificador do processo (nunca por nome). Sem nova tentativa.
 */
export async function runLockHolderCase(deps: BatteryDeps, caseId: LockHolderCaseId): Promise<LockHolderReport> {
  const c = LOCK_HOLDER_CASES[caseId]
  const result: CaseResult = { id: c.id, test: c.test, status: 'not-run', messages: [], pid: null, exitCode: null, ms: null }
  const report: LockHolderReport = { exitCode: BATTERY_EXIT.precondition, preconditions: [], results: [result], survivors: null, cleanup: null, lockReleased: null, lockHolder: null, observation: null }

  const pre = checkLockHolderPreconditions(deps, caseId)
  report.preconditions = pre.report
  const { spawnLockHolder, statIdentity, probeRename, probeUnlink, probeWriteOpen } = deps
  if (pre.failures.length > 0 || pre.artifacts === null || spawnLockHolder === undefined || statIdentity === undefined) {
    for (const f of pre.failures) deps.log(`Pré-condição não atendida: ${f}`)
    deps.log('Nenhum processo foi iniciado.')
    return report
  }
  const readIdentity: (path: string) => FsIdentity | null = statIdentity
  const lock = deps.acquireLock()
  if (lock !== 'acquired') {
    deps.log(lock === 'held' ? 'Outra bateria em andamento, ou trava antiga na pasta temporária. Nenhum processo foi iniciado.' : 'Não foi possível criar a trava. Nenhum processo foi iniciado.')
    return report
  }

  let scratch: ScratchDir | null = null
  try {
    try {
      scratch = createScratch(deps.fs, deps.tmpRoot, BATTERY_SCRATCH_PREFIX)
    } catch (error) {
      deps.log(`Pasta exclusiva não criada (${errorCode(error)}). Nenhum processo foi iniciado.`)
      return report
    }
    const batteryStart = filetimeFromMs(deps.now() - 1_000)
    let layout: CaseLayout
    try {
      layout = prepareLockHolderCase(deps.fs, scratch.path, c, pre.artifacts)
    } catch (error) {
      result.status = 'fail'
      result.messages.push(`preparação falhou (${errorCode(error)}); nada iniciado`)
      report.exitCode = BATTERY_EXIT.caseFailed
      return report
    }
    if (layout.caseDir.length > LOCK_HOLDER_MAX_CASE_DIR) {
      result.status = 'fail'
      result.messages.push(`pasta do caso com ${layout.caseDir.length} caracteres (limite do segurador ${LOCK_HOLDER_MAX_CASE_DIR}); nada iniciado`)
      report.exitCode = BATTERY_EXIT.caseFailed
      return report
    }

    // 3. Conferência imediatamente antes de iniciar: a cópia que vai ser executada.
    let copyIssues: string[]
    try {
      copyIssues = lockHolderIssues(deps.fs.readFile(layout.holder))
    } catch (error) {
      copyIssues = [`cópia do segurador não lida (${errorCode(error)})`]
    }
    if (copyIssues.length > 0) {
      result.status = 'fail'
      result.messages.push(...copyIssues, 'nada iniciado')
      report.exitCode = BATTERY_EXIT.caseFailed
      deps.log(`${c.id}: cópia do segurador recusada logo antes do início: ${copyIssues.join('; ')}. Nada iniciado.`)
      return report
    }
    deps.log(`${c.id}: cópia do segurador conferida logo antes do início (${APPROVED_ARTIFACTS.lockHolder.size} bytes, SHA-256 ${APPROVED_ARTIFACTS.lockHolder.sha256.slice(0, 12)}…, PE e identidade).`)

    const hashOf = (): string | null => {
      try {
        return sha256(deps.fs.readFile(layout.file))
      } catch {
        return null
      }
    }
    const statsOf = () => (c.mode === 'file' ? { file: readIdentity(layout.file) } : { top: readIdentity(layout.top), arch: readIdentity(layout.arch) })
    const obs: LockHolderObservation = {
      caseId,
      spawnError: null,
      pid: null,
      readyMs: null,
      ready: null,
      unexpectedFirstLine: false,
      identityIssues: null,
      identityAfterIssues: null,
      attempts: [],
      attemptsStopped: null,
      holderAliveThroughAttempts: null,
      releaseRequestedMs: null,
      killRequestedMs: null,
      killAccepted: null,
      exitCode: null,
      exitSignal: null,
      exitMs: null,
      closeMs: null,
      stdout: '',
      stderrBytes: 0,
      hashBefore: hashOf(),
      hashAfterAttempts: null,
      hashAfterRelease: null,
      censusAfter: null
    }

    // 4. Só o segurador aprovado.
    const started = deps.now()
    const run = spawnLockHolder(layout.holder, lockHolderArgs(c, layout.caseDir), layout.holderDir)
    result.pid = run.pid
    obs.pid = run.pid
    let settled: RawRun | null = null
    run.done.then((r) => {
      settled = r
    })
    deps.log(`${c.id}: iniciado PID ${run.pid ?? '-'}, imagem ${LOCK_HOLDER_NAME} (SHA-256 ${APPROVED_ARTIFACTS.lockHolder.sha256.slice(0, 12)}…), modo ${c.mode}; prontidão em até ${LOCK_HOLDER_READY_TIMEOUT_MS} ms.`)

    const readyTimer = deps.deadline(LOCK_HOLDER_READY_TIMEOUT_MS)
    const first = await Promise.race([
      run.matchLine ? run.matchLine((l) => l.startsWith(LOCK_HOLDER_PREFIX)) : Promise.resolve(null),
      run.done.then(() => null),
      readyTimer.reached.then(() => null)
    ])
    readyTimer.cancel()
    if (first !== null) {
      obs.readyMs = first.ms
      obs.ready = parseReadyLine(first.line)
      obs.unexpectedFirstLine = obs.ready === null
    }
    const readyOk = obs.ready !== null && obs.readyMs !== null && obs.readyMs <= LOCK_HOLDER_READY_TIMEOUT_MS
    deps.log(
      readyOk
        ? `${c.id}: prontidão em ${obs.readyMs} ms: mode=${obs.ready!.mode} volume=${obs.ready!.volume} index=${obs.ready!.indexes.join(',')}.`
        : `${c.id}: prontidão ${first === null ? `não recebida em ${LOCK_HOLDER_READY_TIMEOUT_MS} ms (ou o segurador saiu)` : 'fora do formato ou do prazo'}.`
    )

    // 5–7. Identidade e tentativas (só com prontidão válida). Um erro do próprio supervisor
    // interrompe as tentativas, mas nunca pula a liberação, o encerramento e a limpeza.
    if (readyOk) {
      try {
        identityAndAttempts()
      } catch (error) {
        obs.attemptsStopped = `erro do supervisor durante as tentativas (${errorCode(error)})`
        deps.log(`${c.id}: ${obs.attemptsStopped}.`)
      }
      obs.hashAfterAttempts = hashOf()
    }
    function identityAndAttempts(): void {
      const before = statsOf()
      obs.identityIssues = checkIdentity(c, obs.ready!, before)
      for (const issue of obs.identityIssues) deps.log(`${c.id}: identidade: ${issue}`)
      if (obs.identityIssues.length === 0) {
        deps.log(`${c.id}: identidade conferida (volume e índice iguais aos da prontidão).`)
        const originalOf = (target: AttemptSpec['target']) => (target === 'file' ? before.file : target === 'top' ? before.top : before.arch) ?? null
        const perform = (spec: AttemptSpec): FsAttempt => {
          if (spec.kind === 'open-rw') {
            const w = probeWriteOpen!(layout.file)
            return { succeeded: w.opened, code: w.code, errno: w.errno }
          }
          if (spec.kind === 'unlink') return probeUnlink!(layout.file)
          const { from, to } = renamePair(layout, spec.target)
          return probeRename!(from, to)
        }
        const restore = (spec: AttemptSpec): Restoration => {
          const { from, to } = renamePair(layout, spec.target)
          if (!sameIdentity(originalOf(spec.target), readIdentity(to))) return { identityMatched: false, result: null }
          return { identityMatched: true, result: probeRename!(to, from) }
        }
        obs.holderAliveThroughAttempts = true
        for (const id of c.attempts) {
          if ((settled as RawRun | null) !== null) {
            obs.holderAliveThroughAttempts = false
            obs.attemptsStopped = 'o segurador saiu antes da tentativa (trava sem garantia)'
            break
          }
          const spec = ATTEMPTS[id]
          const record: AttemptRecord = { id, ms: deps.now() - started, result: perform(spec), restoration: null }
          obs.attempts.push(record)
          deps.log(`${c.id}: ${spec.label} em ${record.ms} ms: ${record.result.succeeded ? 'FUNCIONOU' : `recusada (${record.result.code ?? '?'}, errno ${record.result.errno ?? '?'})`}.`)
          if (record.result.succeeded) {
            // Registrada sem mascarar; nada mais é tentado. Só o objeto temporário movido volta, se for o mesmo.
            if (spec.kind === 'rename') {
              record.restoration = restore(spec)
              deps.log(`${c.id}: restauração: ${record.restoration.identityMatched ? (record.restoration.result?.succeeded ? 'feita' : `falhou (${record.restoration.result?.code ?? '?'})`) : 'NÃO feita (identidade diferente)'}.`)
            }
            obs.attemptsStopped = `${spec.label} funcionou: cenário interrompido, nenhuma outra tentativa`
            break
          }
        }
        if ((settled as RawRun | null) !== null) obs.holderAliveThroughAttempts = false
        obs.identityAfterIssues = checkIdentity(c, obs.ready!, statsOf())
      }
    }

    // 8–9. Liberação só pelo fechamento da entrada padrão; prazo de 1 s.
    if ((settled as RawRun | null) === null && obs.readyMs !== null) {
      obs.releaseRequestedMs = deps.now() - started
      const closed = run.closeStdin?.() === true
      deps.log(`${c.id}: liberação pedida em ${obs.releaseRequestedMs} ms (entrada padrão ${closed ? 'fechada' : 'NÃO fechada'}).`)
      const releaseTimer = deps.deadline(LOCK_HOLDER_RELEASE_TIMEOUT_MS)
      await Promise.race([run.done.then(() => undefined), releaseTimer.reached])
      releaseTimer.cancel()
      if ((settled as RawRun | null) === null) deps.log(`${c.id}: o segurador não terminou em ${LOCK_HOLDER_RELEASE_TIMEOUT_MS} ms depois do pedido.`)
    }
    // Falha: só o processo iniciado, pelo identificador dele.
    if ((settled as RawRun | null) === null) {
      obs.killRequestedMs = deps.now() - started
      obs.killAccepted = run.kill() === true
      deps.log(`${c.id}: encerramento do segurador PEDIDO em ${obs.killRequestedMs} ms, pelo identificador do processo iniciado (PID ${run.pid ?? '-'}): ${obs.killAccepted ? 'aceito' : 'NÃO aceito'}.`)
      const closeTimer = deps.deadline(LOCK_HOLDER_KILL_CLOSE_MS)
      await Promise.race([run.done.then(() => undefined), closeTimer.reached])
      closeTimer.cancel()
    }
    result.ms = deps.now() - started

    const raw = settled as RawRun | null
    if (raw !== null) {
      obs.spawnError = raw.spawnError
      obs.exitCode = raw.exitCode
      obs.exitSignal = raw.exitSignal ?? null
      obs.exitMs = raw.exitMs
      obs.closeMs = raw.closeMs
      obs.stdout = raw.stdout
      obs.stderrBytes = raw.stderrBytes
      result.exitCode = raw.exitCode
      deps.log(`${c.id}: exit ${raw.exitMs ?? '-'} ms (código ${raw.exitCode ?? '-'}, sinal ${raw.exitSignal ?? '-'}), close ${raw.closeMs ?? '-'} ms.`)
      for (const l of completeLines(raw.stdout)) {
        const known = parseReadyLine(l) !== null || parseReleasedLine(l) !== null
        deps.log(`${c.id}: saída do segurador: ${known ? l : '(linha fora do formato, não mostrada)'}`)
      }
    } else {
      deps.log(`${c.id}: o close NÃO chegou depois do pedido de encerramento: situação incerta.`)
    }
    obs.hashAfterRelease = hashOf()

    // 10. Censo logo depois. Nada é encerrado aqui.
    const census = deps.census()
    obs.censusAfter = census === null ? null : census.length
    deps.log(`${c.id}: censo logo depois: ${obs.censusAfter ?? 'desconhecido'}.`)
    if (census === null || census.length > 0) {
      if (census !== null) {
        const plan = classifySurvivors(census, [layout.holder], batteryStart)
        for (const p of plan.owned) deps.log(`Sobrevivente desta execução: PID ${p.pid}, imagem ${imageOf(p)}, pai ${p.ppid}; NÃO encerrado. Inspeção manual necessária.`)
        for (const p of plan.foreign) deps.log(`Processo de teste FORA desta execução: PID ${p.pid}, imagem ${imageOf(p)}; não tocado. Inspeção manual necessária.`)
        report.survivors = { owned: plan.owned.length, foreign: plan.foreign.length }
      } else {
        deps.log('Censo de processos indisponível: situação desconhecida. Inspeção manual necessária.')
        report.survivors = { owned: 0, foreign: 0 }
      }
    }

    const evaluation = evaluateLockHolder(obs)
    report.lockHolder = evaluation
    report.observation = obs
    for (const e of evaluation.evidence) deps.log(`${c.id}: evidência: ${e}`)
    if (report.survivors !== null) {
      result.status = 'fail'
      result.messages.push('processo de teste sobrevivente ou censo indisponível (não encerrado; inspeção manual)')
      if (!evaluation.verdict.pass) result.messages.push(...evaluation.verdict.reasons)
      report.exitCode = BATTERY_EXIT.survivors
    } else if (evaluation.verdict.pass) {
      result.status = 'pass'
      report.exitCode = BATTERY_EXIT.ok
      deps.log(`${c.id}: aprovado (${result.ms} ms).`)
    } else {
      result.status = 'fail'
      result.messages.push(...evaluation.verdict.reasons)
      report.exitCode = BATTERY_EXIT.caseFailed
      deps.log(`${c.id}: REPROVADO: ${evaluation.verdict.reasons.join('; ')}.`)
    }
    return report
  } finally {
    if (scratch !== null) {
      report.cleanup = await removeScratch(deps.fs, scratch, { tmpRoot: deps.tmpRoot, prefix: BATTERY_SCRATCH_PREFIX })
      if (!report.cleanup.removed && report.exitCode === BATTERY_EXIT.ok) report.exitCode = BATTERY_EXIT.cleanupFailed
    }
    report.lockReleased = deps.releaseLock()
    if (!report.lockReleased && report.exitCode === BATTERY_EXIT.ok) report.exitCode = BATTERY_EXIT.cleanupFailed
    const final = deps.census()
    deps.log(`Censo final: ${final === null ? 'desconhecido' : final.length}.`)
    if ((final === null || final.length > 0) && report.exitCode === BATTERY_EXIT.ok) report.exitCode = BATTERY_EXIT.survivors
  }
}

/** Resumo sem caminhos. */
export function formatReport(r: BatteryReport, title = 'Bateria de contenção, Grupo A:'): string {
  const lines = [title]
  for (const p of r.preconditions) lines.push(`  pré-condição: ${p}`)
  for (const c of r.results) {
    lines.push(`  ${c.id}: ${c.status}${c.exitCode === null ? '' : ` (código ${c.exitCode})`}${c.ms === null ? '' : ` · ${c.ms} ms`}${c.messages.length > 0 ? ` · ${c.messages.join('; ')}` : ''}`)
    for (const o of c.diagnosis?.observations ?? []) lines.push(`    observação: ${o}`)
  }
  if (r.survivors) lines.push(`  sobreviventes (nenhum encerrado; inspeção manual): ${r.survivors.owned} desta bateria, ${r.survivors.foreign} fora dela`)
  if (r.cleanup) lines.push(`  pasta exclusiva: ${r.cleanup.removed ? 'removida' : `NÃO removida (${r.cleanup.reason})`}`)
  if (r.lockReleased !== null) lines.push(`  trava: ${r.lockReleased ? 'liberada' : 'NÃO liberada (remova manualmente)'}`)
  lines.push(`  código do supervisor: ${r.exitCode}`)
  return lines.join('\n')
}

// ── Repetição: T-K1.hang e T-T1.hang (6C.6C.3C) ─────────────────────────────

export interface RepeatRow {
  /** Número da execução no lote (1..20). */
  index: number
  /** Número da execução dentro do caso (1..10). */
  round: number
  id: RepeatCaseId
  status: CaseStatus
  pid: number | null
  readyMs: number | null
  /** T-K1: do pedido de encerramento; T-T1: `null` (sem intervenção). */
  killRequestedMs: number | null
  exitMs: number | null
  closeMs: number | null
  exitCode: number | null
  exitSignal: string | null
  /** O supervisor pediu o encerramento do launcher (previsto no T-K1; reprova no T-T1). */
  supervisorKill: boolean
  censusAfter: number | null
  cleanup: boolean | null
  lockReleased: boolean | null
  reasons: string[]
}

export interface RepeatReport {
  exitCode: number
  plan: RepeatPlan
  rows: RepeatRow[]
  /** Motivo da interrupção; `null` = lote completo. */
  stoppedBy: string | null
  finalCensus: number | null
}

/**
 * Lote de repetições. Para cada execução, em sequência:
 * - antes: nenhuma pasta exclusiva residual (`gerpro-6c6c-*`) na pasta
 *   temporária; depois, o próprio roteiro confere de novo censo 0, trava
 *   livre e identidade e integridade dos artefatos;
 * - o MESMO roteiro e os MESMOS critérios da execução isolada do caso;
 * - qualquer resultado diferente de aprovado encerra o lote, sem nova tentativa.
 */
export async function runHangRepeat(deps: BatteryDeps, plan: RepeatPlan): Promise<RepeatReport> {
  const report: RepeatReport = { exitCode: BATTERY_EXIT.ok, plan, rows: [], stoppedBy: null, finalCensus: null }
  const run = { [TERMINATION_CASE.id]: runTermination, [LAUNCHER_TIMEOUT_CASE.id]: runLauncherTimeout } as Record<RepeatCaseId, (d: BatteryDeps) => Promise<TerminationReport>>
  let index = 0
  outer: for (const id of plan.cases) {
    for (let round = 1; round <= plan.times; round++) {
      index++
      if (deps.stopRequested?.() === true) {
        report.stoppedBy = 'interrompido a pedido: nenhuma execução nova começa'
        report.exitCode = BATTERY_EXIT.interrupted
        break outer
      }
      let residual: string[]
      try {
        residual = deps.fs.readdir(deps.tmpRoot).filter((n) => n.startsWith(BATTERY_SCRATCH_PREFIX))
      } catch (error) {
        report.stoppedBy = `pasta temporária ilegível antes da execução ${index} (${errorCode(error)})`
        report.exitCode = BATTERY_EXIT.precondition
        break outer
      }
      if (residual.length > 0) {
        report.stoppedBy = `pasta exclusiva residual antes da execução ${index}; nada iniciado`
        report.exitCode = BATTERY_EXIT.precondition
        break outer
      }
      deps.log(`── Execução ${index} (${id}, ${round}/${plan.times}) ──`)
      const r = await run[id](deps)
      const o = r.observation
      const result = r.results[0]!
      const row: RepeatRow = {
        index,
        round,
        id,
        status: result.status,
        pid: result.pid,
        readyMs: o?.readyMs ?? null,
        killRequestedMs: o?.killRequestedMs ?? null,
        exitMs: o?.exitMs ?? null,
        closeMs: o?.closeMs ?? null,
        exitCode: o?.exitCode ?? null,
        exitSignal: o?.exitSignal ?? null,
        supervisorKill: o?.killRequestedMs !== null && o?.killRequestedMs !== undefined,
        censusAfter: o?.censusAfter ?? null,
        cleanup: r.cleanup?.removed ?? null,
        lockReleased: r.lockReleased,
        reasons: result.status === 'pass' ? [] : result.status === 'not-run' ? ['pré-condição, trava ou pasta exclusiva: nada iniciado'] : [...result.messages]
      }
      report.rows.push(row)
      if (r.exitCode !== BATTERY_EXIT.ok || result.status !== 'pass') {
        report.stoppedBy = `execução ${index} (${id}, ${round}/${plan.times}) não aprovada: ${row.reasons.join('; ') || `código do supervisor ${r.exitCode}`}`
        report.exitCode = r.exitCode === BATTERY_EXIT.ok ? BATTERY_EXIT.caseFailed : r.exitCode
        break outer
      }
    }
  }
  const final = deps.census()
  report.finalCensus = final === null ? null : final.length
  deps.log(`Censo final do lote: ${report.finalCensus ?? 'desconhecido'}.`)
  if ((final === null || final.length > 0) && report.exitCode === BATTERY_EXIT.ok) report.exitCode = BATTERY_EXIT.survivors
  return report
}

const ms = (v: number | null) => (v === null ? '-' : String(v))

/** Tabela do lote (sem caminhos) e estatísticas por caso. */
export function formatRepeatReport(r: RepeatReport): string {
  const lines = [`Lote de repetição (${r.plan.cases.join(', ')}; ${r.plan.times}× cada; sequencial):`]
  lines.push('  nº | caso      | rodada | resultado | linha ms | fim ms | código | intervenção do supervisor | censo depois | limpeza')
  for (const row of r.rows) {
    const end = row.id === TERMINATION_CASE.id ? row.closeMs : row.exitMs
    const code = row.exitCode !== null ? String(row.exitCode) : row.exitSignal ?? '-'
    const kill = row.supervisorKill ? (row.id === TERMINATION_CASE.id ? `sim, previsto (pedido em ${ms(row.killRequestedMs)} ms)` : 'SIM (não previsto)') : 'não'
    lines.push(
      `  ${String(row.index).padStart(2)} | ${row.id} | ${String(row.round).padStart(2)}/${r.plan.times} | ${row.status.padEnd(9)} | ${ms(row.readyMs).padStart(8)} | ${ms(end).padStart(6)} | ${code.padEnd(7)} | ${kill} | ${ms(row.censusAfter)} | ${row.cleanup === true && row.lockReleased === true ? 'completa' : `pasta ${row.cleanup ?? '-'}, trava ${row.lockReleased ?? '-'}`}`
    )
  }
  for (const id of r.plan.cases) {
    const rows = r.rows.filter((x) => x.id === id)
    const pass = rows.filter((x) => x.status === 'pass').length
    const stat = (label: string, values: number[]) =>
      values.length === 0 ? `${label}: -` : `${label}: mín ${Math.min(...values)}, máx ${Math.max(...values)}, média ${Math.round(values.reduce((a, b) => a + b, 0) / values.length)} ms`
    const ready = rows.flatMap((x) => (x.readyMs === null ? [] : [x.readyMs]))
    const end = rows.flatMap((x) => {
      const v = id === TERMINATION_CASE.id ? x.closeMs : x.exitMs
      return v === null ? [] : [v]
    })
    const span = rows.flatMap((x) => {
      if (id === TERMINATION_CASE.id) return x.killRequestedMs === null || x.closeMs === null ? [] : [x.closeMs - x.killRequestedMs]
      return x.readyMs === null || x.exitMs === null ? [] : [x.exitMs - x.readyMs]
    })
    lines.push(`  ${id}: ${rows.length} executada(s), ${pass} aprovada(s)`)
    lines.push(`    ${stat('linha do alvo', ready)}`)
    lines.push(`    ${stat(id === TERMINATION_CASE.id ? 'close (fim do alvo)' : 'exit (código 27)', end)}`)
    lines.push(`    ${stat(id === TERMINATION_CASE.id ? 'do pedido até o close' : 'da linha até o exit', span)}`)
  }
  lines.push(`  interrupção: ${r.stoppedBy ?? 'nenhuma (lote completo)'}`)
  lines.push(`  censo final do lote: ${r.finalCensus ?? 'desconhecido'}`)
  lines.push(`  código do supervisor: ${r.exitCode}`)
  return lines.join('\n')
}

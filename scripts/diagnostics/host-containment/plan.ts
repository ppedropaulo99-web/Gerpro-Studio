/**
 * Plano dos testes reais de contenção, Grupo A (Etapa 6C.6C.2A; roteiro em
 * docs/11-testes-contencao.md). Só dados e funções puras: nada aqui cria
 * processo, abre arquivo ou consulta o sistema.
 *
 * Cada caso roda UMA vez por bateria. Não há repetição automática nem nova
 * tentativa: qualquer resultado diferente do esperado encerra a bateria.
 */

// ── Artefatos aprovados (6C.6C.1) ────────────────────────────────────────────

export type ScenarioId = 'exit-ok' | 'exit-contract' | 'exit-out-of-contract' | 'hang' | 'spawn-child' | 'memory' | 'job-probe'

export interface ApprovedFile {
  readonly size: number
  readonly sha256: string
}

/**
 * Hashes COMPLETOS aprovados (`docs/11`, seções 7 e 13). O supervisor
 * recalcula o hash de cada arquivo (origem e cópia) e recusa qualquer
 * diferença. O `test-manifest.json` do build é conferido contra estes
 * valores; nunca é a fonte da verdade.
 * - Alvos sintéticos: 6C.6C.1 (inalterados na 6C.6C.2E).
 * - Launcher de testes: 6C.6C.2E, com `DETACHED_PROCESS`. O da 6C.6C.1
 *   (`CREATE_NO_WINDOW`, SHA-256 `94507dc4…58d1eb`) não é mais aceito.
 */
export const APPROVED_ARTIFACTS = Object.freeze({
  launcher: Object.freeze({ size: 115_200, sha256: '4b7f9c7f5ddf21049276b0b9333cce9aaf95857dc8968698e1372adcb90e2e26' }),
  scenarios: Object.freeze({
    'exit-ok': Object.freeze({ size: 106_496, sha256: '8616bddbd4a7f530f9c48b5abd55ee3ea14fdc1b4dcdbfaf1a23e61ad4c6ac44' }),
    'exit-contract': Object.freeze({ size: 106_496, sha256: 'fbd4e54263dd188de43d2df1e18f53d16ed3400116a6268444023a537eab4dc9' }),
    'exit-out-of-contract': Object.freeze({ size: 106_496, sha256: '2068082f62bde1b8de84cfa9d3175560073ace17c779f58a1ac22caf45d5fe64' }),
    hang: Object.freeze({ size: 106_496, sha256: 'd88431fb48cd5067c439d5a4a0f3e6397f5da1dd6a4a63887876c9ca7b255461' }),
    'spawn-child': Object.freeze({ size: 108_032, sha256: '097a4c3cccb11d7e1a282264a118b0468d5edae1d66e59f7bb916c2ecad456cd' }),
    memory: Object.freeze({ size: 109_056, sha256: 'cc8c56b831c9f698167a101b4083bc7454c361cdc093234cab6731622f4c9d32' }),
    'job-probe': Object.freeze({ size: 108_032, sha256: 'ea78c3fcbceec3f18c80eeeced3a32a5c58f59d266d881eb28483c197dd4ffcb' })
  }) satisfies Record<ScenarioId, ApprovedFile>,
  /**
   * Segurador de travas só de teste (6C.6C.3F; registrado na 6C.6C.3G): só
   * para T-F1.exit-ok e T-F4.exit-ok. Conferido (tamanho, SHA-256, PE e
   * identidade) nas pré-condições e de novo na cópia, logo antes de iniciar.
   */
  lockHolder: Object.freeze({ size: 114_176, sha256: '74a99a07290c9850b13de7cb10a35893fe8e53755a59b91f4a15ac6db5e359e0' }) satisfies ApprovedFile
})

export const TEST_LAUNCHER_NAME = 'gerpro-helper-host-test.exe'
export const SYNTHETIC_HELPER_NAME = 'gerpro-synthetic-helper.exe'
/** Nome usado só no caso T-E1 `renamed-launcher` (também entra no censo). */
export const RENAMED_LAUNCHER_NAME = 'gerpro-helper-host-test-renamed.exe'
/** Segurador de travas só de teste (T-F1 e T-F4; 6C.6C.3G). */
export const LOCK_HOLDER_NAME = 'gerpro-lock-holder-test.exe'
/** Imagens que só existem nos testes: o censo de processos olha só estas. */
export const CENSUS_IMAGES = Object.freeze([TEST_LAUNCHER_NAME, SYNTHETIC_HELPER_NAME, RENAMED_LAUNCHER_NAME, LOCK_HOLDER_NAME])

/** Cenários usados pelo Grupo A (o `hang` fica para o Grupo B). */
export const GROUP_A_SCENARIOS: readonly ScenarioId[] = Object.freeze(['exit-ok', 'exit-contract', 'exit-out-of-contract', 'spawn-child', 'memory', 'job-probe'])

// ── Casos ────────────────────────────────────────────────────────────────────

/**
 * `T-K1` (6C.6C.3A), `T-T1` (6C.6C.3B) e `T-F3` (6C.6C.3E) só existem nos modos restritos do alvo hang;
 * `T-F1` e `T-F4` (6C.6C.3G), só no modo restrito do segurador de travas. Nenhum está no Grupo A.
 */
export type TestId = 'T-E1' | 'T-H1' | 'T-F5' | 'T-R1' | 'T-R2' | 'T-R4' | 'T-M1' | 'T-K1' | 'T-T1' | 'T-F3' | 'T-F1' | 'T-F4'
export const GROUP_A_TESTS: readonly TestId[] = Object.freeze(['T-E1', 'T-H1', 'T-F5', 'T-R1', 'T-R2', 'T-R4', 'T-M1'])

/** Como a pasta do caso é montada (sempre dentro da pasta exclusiva da bateria). */
export type Layout =
  | 'standard'
  | 'wrong-folder'
  | 'renamed-launcher'
  | 'helper-missing'
  | 'helper-tiny'
  | 'helper-symlink'
  | 'helper-modified'

/** Argumentos do launcher. `standard` = `--protocol 1 --helper-sha256 <hash do cenário>`. */
export type ArgsKind = 'standard' | 'extra-arg' | 'uppercase-hash' | 'protocol-2' | 'other-scenario-hash' | 'modified-hash'

export interface CaseObservation {
  /** Código de saída do launcher; `null` se não saiu sozinho. */
  exitCode: number | null
  /** Saída padrão (limitada), só texto ASCII do alvo sintético. */
  stdout: string
  /** Bytes na saída de erro (o launcher e o alvo não escrevem nela). */
  stderrBytes: number
  /** Milissegundos até `exit` e até `close`, desde o início. */
  exitMs: number | null
  closeMs: number | null
  /** O prazo global do caso estourou e o supervisor encerrou o processo que iniciou. */
  deadlineHit: boolean
  /** Código do erro ao iniciar (ex.: ENOENT), sem mensagem. */
  spawnError: string | null
}

export interface ElectronObservation {
  direct: { exitCode: number | null; line: string | null } | null
  viaLauncher: { exitCode: number | null; line: string | null } | null
  electronVersion: string | null
}

export interface CaseDefinition {
  readonly id: string
  readonly test: TestId
  /** Testes cujo resultado também sai deste caso (ex.: T-F5 sai do T-H1 exit-ok). */
  readonly alsoCovers?: readonly TestId[]
  readonly runner: 'node' | 'electron'
  readonly scenario: ScenarioId
  readonly layout: Layout
  readonly args: ArgsKind
  readonly stdout: 'pipe' | 'ignore'
  /** Prazo global: o supervisor encerra o processo que iniciou se passar disto. */
  readonly deadlineMs: number
  readonly expectedExit: number
  readonly description: string
}

/** Prazo de um caso com o launcher (o próprio launcher tem no máximo 2,5 s). */
const LAUNCHER_DEADLINE_MS = 5_000
/** Prazo do caso T-R1 (Electron + duas execuções curtas). */
const ELECTRON_DEADLINE_MS = 30_000
/** Depois do `exit`, o `close` tem de chegar neste prazo (D60). */
export const CLOSE_AFTER_EXIT_MS = 2_000
/** Limite de leitura da saída padrão. */
export const MAX_STDOUT_BYTES = 4_096

const node = (c: Omit<CaseDefinition, 'runner' | 'deadlineMs' | 'stdout'> & { stdout?: 'pipe' | 'ignore' }): CaseDefinition =>
  Object.freeze({ runner: 'node', deadlineMs: LAUNCHER_DEADLINE_MS, stdout: 'pipe', ...c })

export const GROUP_A_CASES: readonly CaseDefinition[] = Object.freeze([
  // T-E1: falhas antes da retomada; o alvo (exit-ok) nunca pode escrever a linha.
  node({ id: 'T-E1.extra-arg', test: 'T-E1', scenario: 'exit-ok', layout: 'standard', args: 'extra-arg', expectedExit: 20, description: 'argumento a mais' }),
  node({ id: 'T-E1.uppercase-hash', test: 'T-E1', scenario: 'exit-ok', layout: 'standard', args: 'uppercase-hash', expectedExit: 20, description: 'hash em maiúsculas' }),
  node({ id: 'T-E1.protocol-2', test: 'T-E1', scenario: 'exit-ok', layout: 'standard', args: 'protocol-2', expectedExit: 20, description: 'versão de protocolo 2' }),
  node({ id: 'T-E1.stdout-not-pipe', test: 'T-E1', scenario: 'exit-ok', layout: 'standard', args: 'standard', stdout: 'ignore', expectedExit: 21, description: 'saída padrão que não é pipe' }),
  node({ id: 'T-E1.wrong-folder', test: 'T-E1', scenario: 'exit-ok', layout: 'wrong-folder', args: 'standard', expectedExit: 23, description: 'launcher fora de host-test\\win32-x64' }),
  node({ id: 'T-E1.renamed-launcher', test: 'T-E1', scenario: 'exit-ok', layout: 'renamed-launcher', args: 'standard', expectedExit: 23, description: 'launcher renomeado' }),
  node({ id: 'T-E1.helper-missing', test: 'T-E1', scenario: 'exit-ok', layout: 'helper-missing', args: 'standard', expectedExit: 23, description: 'alvo ausente' }),
  node({ id: 'T-E1.helper-tiny', test: 'T-E1', scenario: 'exit-ok', layout: 'helper-tiny', args: 'standard', expectedExit: 23, description: 'alvo com menos de 1 KiB' }),
  node({ id: 'T-E1.helper-symlink', test: 'T-E1', scenario: 'exit-ok', layout: 'helper-symlink', args: 'standard', expectedExit: 23, description: 'alvo como link simbólico (pulado sem permissão para criar link)' }),
  node({ id: 'T-E1.other-scenario-hash', test: 'T-E1', scenario: 'exit-ok', layout: 'standard', args: 'other-scenario-hash', expectedExit: 24, description: 'hash de outro cenário no argumento' }),
  node({ id: 'T-E1.modified-helper', test: 'T-E1', scenario: 'exit-ok', layout: 'helper-modified', args: 'modified-hash', expectedExit: 24, description: 'cópia com 1 byte a mais e o hash dessa cópia (fora dos fixados)' }),
  // T-H1 (e T-F5 no exit-ok): saída herdada, códigos repassados, close depois do exit.
  node({ id: 'T-H1.exit-ok', test: 'T-H1', alsoCovers: ['T-F5'], scenario: 'exit-ok', layout: 'standard', args: 'standard', expectedExit: 0, description: 'saída normal; arquivo travado durante CreateProcessW (H-F5)' }),
  node({ id: 'T-H1.exit-contract', test: 'T-H1', scenario: 'exit-contract', layout: 'standard', args: 'standard', expectedExit: 12, description: 'código do contrato repassado' }),
  node({ id: 'T-H1.exit-out-of-contract', test: 'T-H1', scenario: 'exit-out-of-contract', layout: 'standard', args: 'standard', expectedExit: 28, description: 'código fora do contrato vira 28' }),
  // T-R2 e T-R4: descendentes comuns e com saída do job, sempre suspensos.
  node({ id: 'T-R2.spawn-child', test: 'T-R2', alsoCovers: ['T-R4'], scenario: 'spawn-child', layout: 'standard', args: 'standard', expectedExit: 0, description: 'descendente comum e com CREATE_BREAKAWAY_FROM_JOB recusados' }),
  // T-M1 (parte sintética): picos de memória do job.
  node({ id: 'T-M1.memory', test: 'T-M1', scenario: 'memory', layout: 'standard', args: 'standard', expectedExit: 0, description: '64 MiB reservados e tocados; picos do job relatados' }),
  // T-R1: job da libuv no Electron 45 (direto) e job J (pelo launcher).
  Object.freeze({
    id: 'T-R1.electron-job',
    test: 'T-R1',
    runner: 'electron',
    scenario: 'job-probe',
    layout: 'standard',
    args: 'standard',
    stdout: 'pipe',
    deadlineMs: ELECTRON_DEADLINE_MS,
    expectedExit: 0,
    description: 'Electron 45 inicia job-probe direto e pelo launcher'
  } satisfies CaseDefinition)
])

/** Pré-condições verificáveis, por teste (as comuns valem para todos). */
export const PRECONDITIONS: Readonly<Record<'common' | TestId, readonly string[]>> = Object.freeze({
  common: [
    'Windows x64 nativo (process.platform = win32, process.arch = x64)',
    'supervisor sem elevação (whoami /groups: nível médio ou baixo)',
    'nenhum processo com as imagens de teste em execução (censo = 0)',
    'trava exclusiva da bateria obtida (nenhuma outra bateria em andamento)',
    'launcher de testes e alvos com tamanho e SHA-256 iguais aos aprovados, PE e identidade da variante conferidos',
    'pasta temporária do sistema em unidade local (X:\\...), não em rede'
  ],
  'T-E1': ['cópia de exit-ok conferida; cada caso numa subpasta própria'],
  'T-H1': ['cópias de exit-ok, exit-contract e exit-out-of-contract conferidas'],
  'T-F5': ['coberto pela execução T-H1.exit-ok (o launcher sempre cria o alvo com o arquivo travado)'],
  'T-R1': ['Electron do projeto na versão 45 (node_modules/electron/package.json)', 'cópia de job-probe conferida'],
  'T-R2': ['cópia de spawn-child conferida'],
  'T-R4': ['coberto pela execução T-R2.spawn-child'],
  'T-M1': ['cópia de memory conferida'],
  'T-K1': ['cópia de hang conferida; só pelo modo --terminate=T-K1.hang'],
  'T-T1': ['cópia de hang conferida; só pelo modo --launcher-timeout=T-T1.hang'],
  'T-F3': ['cópia de hang conferida; só pelo modo --file-lock=T-F3.hang'],
  'T-F1': ['segurador de travas e cópia de exit-ok conferidos; só pelo modo --file-lock=T-F1.exit-ok'],
  'T-F4': ['segurador de travas e cópia de exit-ok conferidos; só pelo modo --file-lock=T-F4.exit-ok']
})

// ── Avaliação ────────────────────────────────────────────────────────────────

export type Verdict = { pass: true; notes: string[] } | { pass: false; reasons: string[] }

const SYNTHETIC_LINE = /^gerpro-synthetic scenario=([a-z-]+)(.*)$/
const lines = (stdout: string) => stdout.split(/\r?\n/).filter((l) => l !== '')

/** Valores numéricos `chave=valor` da linha do alvo. */
export function lineFields(line: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const part of line.split(' ').slice(1)) {
    const at = part.indexOf('=')
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1)
  }
  return fields
}

/** Linha esperada de cada cenário (além do código). */
function checkScenarioLine(scenario: ScenarioId, line: string): string[] {
  const f = lineFields(line)
  switch (scenario) {
    case 'spawn-child':
      return /^denied,error=\d+$/.test(f.plain ?? '') && /^denied,error=\d+$/.test(f.breakaway ?? '') ? [] : ['descendente criado ou resultado ilegível (contenção a rever)']
    case 'memory': {
      const committed = Number(f.committed)
      const peakProcess = Number(f['peak-process'])
      const peakJob = Number(f['peak-job'])
      if (f['in-job'] !== '1') return ['alvo fora de job']
      if (committed !== 64 * 1024 * 1024) return ['alocação diferente de 64 MiB']
      if (!(peakProcess >= committed)) return ['pico do processo menor que a alocação']
      if (!(peakJob >= peakProcess)) return ['pico do job menor que o do processo']
      return []
    }
    case 'job-probe':
      return f['in-job'] === '1' && f['limit-flags'] === '0x2408' && f['active-limit'] === '1' && f.active === '1' && f.total === '1'
        ? []
        : ['job imediato diferente de J (KILL_ON_JOB_CLOSE | ACTIVE_PROCESS | DIE_ON_UNHANDLED_EXCEPTION, limite 1)']
    default:
      return []
  }
}

/** Avalia um caso executado pelo Node. Qualquer reprovação encerra a bateria. */
export function evaluateCase(c: CaseDefinition, o: CaseObservation): Verdict {
  const reasons: string[] = []
  if (o.spawnError !== null) reasons.push(`launcher não iniciou (${o.spawnError})`)
  if (o.deadlineHit) reasons.push(`prazo global de ${c.deadlineMs} ms estourado`)
  if (o.exitCode !== c.expectedExit) reasons.push(`código ${o.exitCode ?? 'nenhum'}, esperado ${c.expectedExit}`)
  if (o.stderrBytes > 0) reasons.push('saída de erro não vazia')
  if (o.exitMs !== null && o.closeMs !== null && o.closeMs - o.exitMs > CLOSE_AFTER_EXIT_MS) reasons.push('close mais de 2 s depois do exit')
  if (o.exitMs !== null && o.closeMs !== null && o.closeMs < o.exitMs) reasons.push('close antes do exit')
  if (o.closeMs === null && !o.deadlineHit && o.spawnError === null) reasons.push('close não chegou')
  const out = lines(o.stdout)
  const synthetic = out.filter((l) => SYNTHETIC_LINE.test(l))
  if (out.length !== synthetic.length) reasons.push('saída padrão com texto inesperado')
  const preResume = c.expectedExit >= 20 && c.expectedExit <= 26
  if (preResume || c.stdout === 'ignore') {
    // Falha antes da retomada: o alvo nunca pode ter escrito nada.
    if (synthetic.length > 0) reasons.push('o alvo escreveu a linha: foi retomado indevidamente')
  } else if (synthetic.length !== 1) {
    reasons.push(`esperada 1 linha do alvo, vieram ${synthetic.length}`)
  } else {
    const line = synthetic[0]!
    if (SYNTHETIC_LINE.exec(line)?.[1] !== c.scenario) reasons.push('linha de outro cenário')
    reasons.push(...checkScenarioLine(c.scenario, line))
  }
  if (reasons.length > 0) return { pass: false, reasons }
  const notes = c.alsoCovers?.includes('T-F5') ? ['H-F5 confirmada: CreateProcessW abriu o alvo travado só com FILE_SHARE_READ'] : []
  return { pass: true, notes }
}

/** T-R1: a execução pelo launcher tem de mostrar J; a direta é registrada (decide o T-K2). */
export function evaluateElectron(o: ElectronObservation): Verdict {
  const reasons: string[] = []
  if (o.electronVersion === null || !/^45\./.test(o.electronVersion)) reasons.push('Electron diferente da versão 45')
  if (o.viaLauncher === null) reasons.push('execução pelo launcher ausente')
  else {
    if (o.viaLauncher.exitCode !== 0) reasons.push(`launcher saiu com ${o.viaLauncher.exitCode ?? 'nenhum'}, esperado 0`)
    if (o.viaLauncher.line === null) reasons.push('linha do alvo ausente (pelo launcher)')
    else reasons.push(...checkScenarioLine('job-probe', o.viaLauncher.line))
  }
  if (o.direct === null || o.direct.exitCode !== 0 || o.direct.line === null) reasons.push('execução direta sem resultado')
  if (reasons.length > 0) return { pass: false, reasons }
  const direct = lineFields(o.direct!.line!)
  return { pass: true, notes: [`job da libuv (direto): in-job=${direct['in-job'] ?? '?'} limit-flags=${direct['limit-flags'] ?? '-'}`] }
}

// ── Argumentos do supervisor ────────────────────────────────────────────────

export const CONFIRM_RUN = '--confirm-host-containment-run'
export const CHECK_ONLY = '--check-only'
export const GROUP_FLAG = '--group='
export const ONLY_FLAG = '--only='

export type SupervisorMode = { mode: 'plan' } | { mode: 'check' } | { mode: 'run'; tests: readonly TestId[] } | { mode: 'usage-error'; reason: string }

/**
 * Só o Grupo A é aceito. `--only=` restringe a testes do Grupo A (T-F5 e
 * T-R4 não rodam sozinhos: saem de T-H1 e T-R2). Sem confirmação explícita,
 * nada é executado.
 */
export function parseSupervisorArgs(argv: readonly string[]): SupervisorMode {
  const known = argv.every((a) => a === CONFIRM_RUN || a === CHECK_ONLY || a.startsWith(GROUP_FLAG) || a.startsWith(ONLY_FLAG))
  if (!known) return { mode: 'usage-error', reason: 'argumento desconhecido' }
  if (new Set(argv.map((a) => a.split('=')[0])).size !== argv.length) return { mode: 'usage-error', reason: 'argumento repetido' }
  const confirm = argv.includes(CONFIRM_RUN)
  const check = argv.includes(CHECK_ONLY)
  const group = argv.find((a) => a.startsWith(GROUP_FLAG))?.slice(GROUP_FLAG.length)
  const only = argv.find((a) => a.startsWith(ONLY_FLAG))?.slice(ONLY_FLAG.length)
  if (confirm && check) return { mode: 'usage-error', reason: `${CHECK_ONLY} não executa: use-o sem ${CONFIRM_RUN}` }
  if (check) return group === undefined && only === undefined ? { mode: 'check' } : { mode: 'usage-error', reason: `${CHECK_ONLY} não aceita outros argumentos` }
  if (!confirm) return group === undefined && only === undefined ? { mode: 'plan' } : { mode: 'usage-error', reason: `execução exige ${CONFIRM_RUN}` }
  if (group !== 'A') return { mode: 'usage-error', reason: 'só o Grupo A está autorizado (--group=A)' }
  if (only === undefined) return { mode: 'run', tests: GROUP_A_TESTS }
  const requested = only.split(',')
  const runnable: TestId[] = ['T-E1', 'T-H1', 'T-R1', 'T-R2', 'T-M1']
  if (requested.length === 0 || requested.some((t) => !runnable.includes(t as TestId))) return { mode: 'usage-error', reason: `--only aceita só ${runnable.join(', ')}` }
  if (new Set(requested).size !== requested.length) return { mode: 'usage-error', reason: 'teste repetido em --only' }
  return { mode: 'run', tests: requested as TestId[] }
}

/** Casos de uma seleção, na ordem do roteiro. */
export const casesFor = (tests: readonly TestId[]): CaseDefinition[] => GROUP_A_CASES.filter((c) => tests.includes(c.test))

// ── Diagnóstico da falha do T-H1 (6C.6C.2C) ─────────────────────────────────

/**
 * Único caso que o modo diagnóstico executa. O filtro NÃO aceita outro valor:
 * não há lista, curinga nem combinação com `--group`/`--only`.
 */
export const DIAGNOSIS_CASE_ID = 'T-H1.exit-ok'
export const DIAGNOSE_FLAG = '--diagnose='

/** O caso é o MESMO do Grupo A (alvo exit-ok, layout e argumentos padrão, código esperado 0). */
export const DIAGNOSIS_CASE: CaseDefinition = GROUP_A_CASES.find((c) => c.id === DIAGNOSIS_CASE_ID)!

/**
 * Variante diagnóstica aprovada (`build-host-diag-artifacts.mjs`), aceitando
 * SÓ o resumo do exit-ok, com tamanho e SHA-256 fixados:
 * - `detached`: `DETACHED_PROCESS` (executada uma vez na 6C.6C.2D; a mesma
 *   criação da produção desde a 6C.6C.2E).
 * A variante `nowindow` da 6C.6C.2C (`CREATE_NO_WINDOW`, SHA-256
 * `8faa7b81…784c1`) saiu da lista: os fontes não a produzem mais.
 * A variante é escolhida SEMPRE de forma explícita (`--diag-variant=`).
 */
export type DiagVariant = 'detached'
export const DIAG_VARIANTS: readonly DiagVariant[] = Object.freeze(['detached'])
export const APPROVED_DIAG_LAUNCHERS: Readonly<Record<DiagVariant, { readonly variant: DiagVariant; readonly size: number; readonly sha256: string }>> = Object.freeze({
  detached: Object.freeze({ variant: 'detached' as const, size: 128_000, sha256: '16acca858157e94e8032e31d98eecda1a253b90d998a68f845f79c75853bdac3' })
})
export const DIAG_VARIANT_FLAG = '--diag-variant='

export const DIAG_LINE_PREFIX = 'gerpro-host-diag v=1'
const DIAG_LINE = /^gerpro-host-diag v=1( [a-z-]+=[0-9A-Za-z,x-]{1,128}){1,40}$/

/** Separa a linha diagnóstica do launcher do resto da saída padrão. */
export function splitDiagnosticOutput(stdout: string): { diagnostic: string[]; rest: string } {
  const all = stdout.split(/\r?\n/)
  const diagnostic = all.filter((l) => l.startsWith('gerpro-host-diag'))
  return { diagnostic, rest: all.filter((l) => !l.startsWith('gerpro-host-diag')).join('\n') }
}

/** Campos da linha diagnóstica; `null` se o formato não for o esperado (só ASCII, chaves e valores fixos). */
export function parseDiagnosticLine(line: string): Record<string, string> | null {
  if (!DIAG_LINE.test(line)) return null
  const fields: Record<string, string> = {}
  for (const part of line.slice(DIAG_LINE_PREFIX.length + 1).split(' ')) {
    const at = part.indexOf('=')
    const key = part.slice(0, at)
    if (key in fields) return null
    fields[key] = part.slice(at + 1)
  }
  return fields
}

/** Códigos NTSTATUS que importam aqui (documentados em ntstatus.h). */
export const KNOWN_STATUS: Readonly<Record<string, string>> = Object.freeze({
  '0x00000000': 'saída normal (0)',
  '0xC0000142': 'STATUS_DLL_INIT_FAILED (inicialização de DLL falhou)',
  '0xC0000005': 'STATUS_ACCESS_VIOLATION',
  '0xC0000409': 'STATUS_STACK_BUFFER_OVERRUN (fail fast)',
  '0xC000013A': 'STATUS_CONTROL_C_EXIT',
  '0xC0000022': 'STATUS_ACCESS_DENIED',
  '0xC0000135': 'STATUS_DLL_NOT_FOUND',
  '0xC0000417': 'STATUS_INVALID_CRUNTIME_PARAMETER'
})

/** Mensagens da porta de conclusão do job (winnt.h). */
export const JOB_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  '1': 'END_OF_JOB_TIME',
  '2': 'END_OF_PROCESS_TIME',
  '3': 'ACTIVE_PROCESS_LIMIT',
  '4': 'ACTIVE_PROCESS_ZERO',
  '6': 'NEW_PROCESS',
  '7': 'EXIT_PROCESS',
  '8': 'ABNORMAL_EXIT_PROCESS',
  '9': 'PROCESS_MEMORY_LIMIT',
  '10': 'JOB_MEMORY_LIMIT',
  '11': 'NOTIFICATION_LIMIT'
})

export interface DiagnosisResult {
  /** Avaliação do caso como no Grupo A (sem a linha diagnóstica). */
  verdict: Verdict
  /** Campos da linha diagnóstica; `null` se ausente ou ilegível. */
  fields: Record<string, string> | null
  /** Problemas da própria linha diagnóstica (ausente, repetida, incoerente). */
  issues: string[]
  /**
   * Critérios de aprovação da 6C.6C.2D, além do caso em si: código bruto 0,
   * alvo em J antes da retomada (1 ativo, 1 no total, 0 encerrados), nenhum
   * processo excedente em J, nenhum encerramento pelo launcher. Vazio = todos
   * atendidos.
   */
  criteria: string[]
  /** Observações em texto, SEM conclusão sobre a causa. */
  observations: string[]
}

const acct = (value: string | undefined) => {
  const m = /^(\d+),(\d+),(\d+)$/.exec(value ?? '')
  return m ? { active: Number(m[1]), total: Number(m[2]), terminated: Number(m[3]) } : null
}

/**
 * Avalia a execução diagnóstica. A linha só descreve o que o launcher viu:
 * contagens e mensagens do job NÃO identificam o processo extra (o launcher
 * não abre outros processos), e a entrega das mensagens não é garantida.
 */
export function evaluateDiagnosis(o: CaseObservation, variant: DiagVariant): DiagnosisResult {
  const { diagnostic, rest } = splitDiagnosticOutput(o.stdout)
  const verdict = evaluateCase(DIAGNOSIS_CASE, { ...o, stdout: rest })
  const issues: string[] = []
  const observations: string[] = []
  const criteria: string[] = []
  if (diagnostic.length !== 1) {
    issues.push(`esperada 1 linha diagnóstica, vieram ${diagnostic.length}`)
    return { verdict, fields: null, issues, criteria: ['sem linha diagnóstica: critérios não verificáveis'], observations }
  }
  const fields = parseDiagnosticLine(diagnostic[0]!)
  if (fields === null) {
    issues.push('linha diagnóstica fora do formato')
    return { verdict, fields, issues, criteria: ['linha diagnóstica ilegível: critérios não verificáveis'], observations }
  }
  if (fields.creation !== variant) issues.push(`variante de criação ${fields.creation ?? '?'} (esperada ${variant})`)
  if (fields.digests !== '1') issues.push('variante diagnóstica aceitando mais de um alvo')
  if (o.exitCode === null || fields.host !== String(o.exitCode)) issues.push('código na linha diferente do código de saída do launcher')

  const raw = fields.raw
  if (raw !== undefined && raw !== '-') observations.push(`código bruto do alvo: ${raw}${KNOWN_STATUS[raw] ? ` = ${KNOWN_STATUS[raw]}` : ' (não catalogado aqui)'}`)
  else observations.push(`código bruto do alvo indisponível (GetExitCodeProcess=${fields.gec ?? '?'}, erro ${fields['gec-err'] ?? '?'})`)
  for (const [key, label] of [
    ['pre-acct', 'antes da retomada'],
    ['wait-acct', 'depois da espera'],
    ['exit-acct', 'depois de GetExitCodeProcess']
  ] as const) {
    const a = acct(fields[key])
    if (a === null) observations.push(`contabilidade de J ${label}: ${fields[key] ?? '?'}`)
    else observations.push(`contabilidade de J ${label}: ativos ${a.active}, total ${a.total}, encerrados por limite ${a.terminated}`)
  }
  const post = acct(fields['exit-acct']) ?? acct(fields['wait-acct'])
  if (post !== null && post.total > 1) observations.push('mais de um processo foi associado a J depois da retomada (a identidade do outro não é conhecida pelo launcher)')
  if (post !== null && post.terminated > 0) observations.push('J registrou encerramento por violação de limite')
  const messages = (fields.msgs ?? '-') === '-' ? [] : fields.msgs!.split(',')
  const named = messages.map((m) => {
    const who = m.slice(-1)
    return `${JOB_MESSAGES[m.slice(0, -1)] ?? `tipo ${m.slice(0, -1)}`}(${who === 'h' ? 'alvo' : who === 'o' ? 'outro' : 'sem id'})`
  })
  observations.push(`mensagens de J: ${named.length === 0 ? 'nenhuma recebida (entrega não garantida)' : named.join(', ')}`)
  if (messages.some((m) => m.startsWith('3') && m.length === 2)) observations.push('mensagem ACTIVE_PROCESS_LIMIT recebida: o limite de processos ativos foi excedido')
  if (messages.some((m) => m.endsWith('o'))) observations.push('mensagem com identificador de outro processo (não o alvo)')
  observations.push(`retomada: ${fields.resume ?? '?'} · espera: ${fields.wait ?? '?'} · encerramentos pelo launcher: ${fields.term ?? '?'}`)

  // Critérios de aprovação (6C.6C.2D).
  if (fields.raw !== '0x00000000') criteria.push(`código bruto do alvo ${fields.raw ?? '?'} (esperado 0x00000000)`)
  if (fields.host !== '0') criteria.push(`código do launcher ${fields.host ?? '?'} (esperado 0)`)
  const pre = acct(fields['pre-acct'])
  if (fields['pre-contained'] !== '1' || fields['pre-injob'] !== '1' || pre === null || pre.active !== 1 || pre.total !== 1 || pre.terminated !== 0) {
    criteria.push('associação a J antes da retomada não demonstrada (pre-contained, pre-injob, pre-acct=1,1,0)')
  }
  if (fields.resume !== '1') criteria.push(`ResumeThread devolveu ${fields.resume ?? '?'} (esperado 1)`)
  if (fields.wait !== '0x00000000') criteria.push(`espera terminou com ${fields.wait ?? '?'} (esperado WAIT_OBJECT_0)`)
  for (const key of ['wait-acct', 'exit-acct'] as const) {
    const a = acct(fields[key])
    if (a === null || a.active !== 0 || a.total !== 1 || a.terminated !== 0) criteria.push(`${key}=${fields[key] ?? '?'}: processo excedente, ativo ou encerrado por limite em J (esperado 0,1,0)`)
  }
  if (!/^\d+,\d+,0$/.test(fields['wait-ids'] ?? '')) criteria.push('lista de J com outro processo depois da espera')
  if (messages.some((m) => m.endsWith('o') || m.startsWith('3'))) criteria.push('mensagem de J de outro processo ou de limite excedido')
  if (fields.term !== '0') criteria.push(`o launcher encerrou processos (term=${fields.term ?? '?'})`)
  return { verdict, fields, issues, criteria, observations }
}

export type DiagnosisArgs = { mode: 'diagnose'; variant: DiagVariant } | { mode: 'check-diagnose'; variant: DiagVariant }

/**
 * Filtro restrito: `--diagnose=` só aceita exatamente `T-H1.exit-ok`, com a
 * variante diagnóstica escolhida explicitamente (`--diag-variant=detached`), nunca junto com `--group` ou `--only`. Sem
 * confirmação explícita, só confere.
 */
export function parseDiagnosisArgs(argv: readonly string[]): DiagnosisArgs | { mode: 'usage-error'; reason: string } | null {
  const diagnose = argv.filter((a) => a.startsWith(DIAGNOSE_FLAG))
  if (diagnose.length === 0) return null
  if (diagnose.length > 1) return { mode: 'usage-error', reason: 'argumento repetido' }
  if (diagnose[0]!.slice(DIAGNOSE_FLAG.length) !== DIAGNOSIS_CASE_ID) return { mode: 'usage-error', reason: `${DIAGNOSE_FLAG} aceita só ${DIAGNOSIS_CASE_ID}` }
  const variants = argv.filter((a) => a.startsWith(DIAG_VARIANT_FLAG))
  if (variants.length !== 1) return { mode: 'usage-error', reason: `${DIAG_VARIANT_FLAG} obrigatório, uma vez (${DIAG_VARIANTS.join(' ou ')})` }
  const variant = variants[0]!.slice(DIAG_VARIANT_FLAG.length)
  if (!(DIAG_VARIANTS as readonly string[]).includes(variant)) return { mode: 'usage-error', reason: `${DIAG_VARIANT_FLAG} aceita só ${DIAG_VARIANTS.join(' ou ')}` }
  const others = argv.filter((a) => !a.startsWith(DIAGNOSE_FLAG) && !a.startsWith(DIAG_VARIANT_FLAG))
  if (others.length === 1 && others[0] === CHECK_ONLY) return { mode: 'check-diagnose', variant: variant as DiagVariant }
  if (others.length === 1 && others[0] === CONFIRM_RUN) return { mode: 'diagnose', variant: variant as DiagVariant }
  return { mode: 'usage-error', reason: `${DIAGNOSE_FLAG} aceita só ${DIAG_VARIANT_FLAG} e ${CONFIRM_RUN} ou ${CHECK_ONLY}, sem --group nem --only` }
}

// ── Encerramento pelo supervisor: T-K1.hang (6C.6C.3A) ──────────────────────

/**
 * Único caso que o modo de encerramento executa: o alvo `hang` pelo launcher
 * de testes. Quando a linha `state=waiting` chega, o supervisor espera um
 * prazo curto e encerra o LAUNCHER que ele próprio iniciou, pelo identificador
 * desse processo (`child.kill()`), antes do prazo interno do launcher (2 s).
 * O alvo só pode terminar porque o último identificador de J (o do launcher)
 * foi fechado: `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Sozinho, o alvo só
 * sairia em 30 s.
 *
 * O filtro NÃO aceita outro valor, lista, curinga, executável ou cenário.
 */
export const TERMINATION_CASE_ID = 'T-K1.hang'
export const TERMINATE_FLAG = '--terminate='

/** Prazo interno do launcher para o alvo (`kHelperWaitMs` em main.cpp). */
export const LAUNCHER_HELPER_WAIT_MS = 2_000
/** O alvo tem de anunciar que está rodando até este instante (desde o início do launcher). */
export const TERMINATION_READY_TIMEOUT_MS = 1_500
/** Prazo do supervisor: encerrar o launcher este tempo depois da linha do alvo. */
export const TERMINATION_KILL_AFTER_READY_MS = 500
/** Depois do pedido de encerramento, `exit` e `close` têm de chegar neste prazo. */
export const TERMINATION_CLOSE_AFTER_KILL_MS = 2_000
/** Prazo próprio do alvo `hang` (`kSelfDeadlineMs`): um fim antes disto não é dele. */
export const HANG_SELF_DEADLINE_MS = 30_000
/** Única linha que o alvo `hang` escreve, antes de esperar. */
export const HANG_READY_LINE = 'gerpro-synthetic scenario=hang state=waiting'

/** O caso: mesma montagem e argumentos padrão do Grupo A, com o alvo `hang`. */
export const TERMINATION_CASE: CaseDefinition = Object.freeze({
  id: TERMINATION_CASE_ID,
  test: 'T-K1',
  runner: 'node',
  scenario: 'hang',
  layout: 'standard',
  args: 'standard',
  stdout: 'pipe',
  deadlineMs: TERMINATION_READY_TIMEOUT_MS + TERMINATION_KILL_AFTER_READY_MS + TERMINATION_CLOSE_AFTER_KILL_MS,
  // Não há código esperado do launcher: ele não pode sair sozinho (ver evaluateTermination).
  expectedExit: -1,
  description: 'hang pelo launcher; o supervisor encerra o launcher pelo identificador dele; o alvo tem de terminar com J'
} satisfies CaseDefinition)

export interface TerminationObservation {
  spawnError: string | null
  pid: number | null
  /** Ms (desde o início) em que a linha do alvo chegou; `null` = não chegou. */
  readyMs: number | null
  /** Ms em que o supervisor pediu o encerramento; `null` = não pediu. */
  killRequestedMs: number | null
  /** Resultado de `child.kill()`: `true` = o sistema aceitou o encerramento. */
  killAccepted: boolean | null
  exitCode: number | null
  exitSignal: string | null
  exitMs: number | null
  closeMs: number | null
  stdout: string
  stderrBytes: number
  /** Censo logo depois do `close` (número de processos de teste); `null` = indisponível. */
  censusAfter: number | null
}

export interface TerminationResult {
  verdict: Verdict
  /** Evidências em texto, separando o que foi pedido do que foi observado. */
  evidence: string[]
}

/**
 * Avalia o T-K1.hang. Aprovado só se:
 * - o alvo anunciou que estava rodando (o launcher só retoma o alvo depois de
 *   confirmar que ele está em J);
 * - o launcher NÃO saiu sozinho e o pedido de encerramento foi aceito;
 * - o `exit` do launcher veio desse encerramento (`SIGTERM`, sem código próprio);
 * - o `close` chegou (todas as pontas de escrita do pipe fechadas, inclusive a
 *   herdada pelo alvo) no prazo e bem antes do prazo próprio do alvo;
 * - o censo logo depois deu 0.
 */
export function evaluateTermination(o: TerminationObservation): TerminationResult {
  const reasons: string[] = []
  const evidence: string[] = []
  if (o.spawnError !== null) reasons.push(`launcher não iniciou (${o.spawnError})`)
  const out = o.stdout.split(/\r?\n/).filter((l) => l !== '')

  // 1. Alvo iniciado (e retomado dentro de J).
  if (o.readyMs === null) reasons.push('o alvo não anunciou que estava rodando')
  else evidence.push(`alvo iniciado: linha "${HANG_READY_LINE}" recebida em ${o.readyMs} ms (o launcher só retoma o alvo depois de confirmar IsProcessInJob em J)`)
  if (out.length !== 1 || out[0] !== HANG_READY_LINE) reasons.push(`saída padrão diferente da única linha do alvo hang (${out.length} linha(s))`)
  if (o.stderrBytes > 0) reasons.push('saída de erro não vazia')

  // 2. Prazo do supervisor e pedido de encerramento.
  if (o.killRequestedMs === null) reasons.push('o supervisor não pediu o encerramento do launcher')
  else {
    const after = o.readyMs === null ? null : o.killRequestedMs - o.readyMs
    evidence.push(
      `encerramento PEDIDO em ${o.killRequestedMs} ms${after === null ? '' : ` (${after} ms depois da linha; prazo configurado ${TERMINATION_KILL_AFTER_READY_MS} ms)`}, pelo identificador do processo iniciado (PID ${o.pid ?? '-'})`
    )
    if (o.killAccepted !== true) reasons.push('pedido de encerramento não aceito (o launcher pode ter saído sozinho)')
    else evidence.push('pedido de encerramento aceito pelo sistema')
  }

  // 3. Encerramento do launcher OBSERVADO.
  if (o.exitMs === null) reasons.push('exit do launcher não observado')
  else if (o.killRequestedMs !== null && o.exitMs < o.killRequestedMs) reasons.push(`o launcher saiu sozinho antes do pedido (código ${o.exitCode ?? '-'})`)
  else if (o.exitSignal !== 'SIGTERM' || o.exitCode !== null) reasons.push(`fim do launcher diferente do encerramento pedido (código ${o.exitCode ?? '-'}, sinal ${o.exitSignal ?? '-'})`)
  else evidence.push(`encerramento do launcher OBSERVADO: exit em ${o.exitMs} ms (${o.exitMs - (o.killRequestedMs ?? o.exitMs)} ms depois do pedido), sinal SIGTERM, sem código próprio`)

  // 4. Encerramento do alvo OBSERVADO: o close só chega quando a ponta de escrita do alvo também fechou.
  if (o.closeMs === null) reasons.push('close não chegou: o alvo pode estar vivo (situação incerta)')
  else if (o.exitMs !== null && o.closeMs < o.exitMs) reasons.push('close antes do exit')
  else if (o.killRequestedMs !== null && o.closeMs - o.killRequestedMs > TERMINATION_CLOSE_AFTER_KILL_MS) reasons.push(`close ${o.closeMs - o.killRequestedMs} ms depois do pedido (limite ${TERMINATION_CLOSE_AFTER_KILL_MS} ms)`)
  else if (o.readyMs !== null && o.closeMs - o.readyMs >= HANG_SELF_DEADLINE_MS) reasons.push('o alvo pode ter saído pelo próprio prazo (30 s), não por J')
  else
    evidence.push(
      `encerramento do alvo OBSERVADO: close em ${o.closeMs} ms (${o.closeMs - (o.killRequestedMs ?? o.closeMs)} ms depois do pedido); todas as pontas de escrita do pipe fechadas, inclusive a herdada pelo alvo; sozinho, o alvo só sairia em ${HANG_SELF_DEADLINE_MS} ms, e o launcher (único dono de J) foi encerrado sem chegar ao próprio prazo`
    )

  // 5. Censo logo depois.
  if (o.censusAfter === null) reasons.push('censo logo depois do encerramento indisponível')
  else if (o.censusAfter > 0) reasons.push(`censo logo depois do encerramento: ${o.censusAfter} processo(s) de teste`)
  else evidence.push('censo logo depois do close: 0 processos de teste')

  return { verdict: reasons.length > 0 ? { pass: false, reasons } : { pass: true, notes: [] }, evidence }
}

export type TerminationArgs = { mode: 'terminate' } | { mode: 'check-terminate' }

/**
 * Filtro restrito: `--terminate=` só aceita exatamente `T-K1.hang`, com
 * `--confirm-host-containment-run` ou `--check-only` e nada mais (nem
 * `--group`, `--only`, `--diagnose` ou `--diag-variant`). `null` = o
 * argumento não foi usado.
 */
export function parseTerminationArgs(argv: readonly string[]): TerminationArgs | { mode: 'usage-error'; reason: string } | null {
  const terminate = argv.filter((a) => a.startsWith(TERMINATE_FLAG))
  if (terminate.length === 0) return null
  if (terminate.length > 1) return { mode: 'usage-error', reason: 'argumento repetido' }
  if (terminate[0]!.slice(TERMINATE_FLAG.length) !== TERMINATION_CASE_ID) return { mode: 'usage-error', reason: `${TERMINATE_FLAG} aceita só ${TERMINATION_CASE_ID}` }
  const others = argv.filter((a) => !a.startsWith(TERMINATE_FLAG))
  if (others.length === 1 && others[0] === CHECK_ONLY) return { mode: 'check-terminate' }
  if (others.length === 1 && others[0] === CONFIRM_RUN) return { mode: 'terminate' }
  return { mode: 'usage-error', reason: `${TERMINATE_FLAG} aceita só ${CONFIRM_RUN} ou ${CHECK_ONLY}, sem outros argumentos` }
}

// ── Prazo interno do launcher: T-T1.hang (6C.6C.3B) ─────────────────────────

/**
 * Único caso do modo de prazo interno: o alvo `hang` pelo launcher de testes,
 * SEM intervenção do supervisor. O launcher espera o alvo por
 * `kHelperWaitMs` (2 s); ao vencer, chama `TerminateJobObject(J, 27)` (ou,
 * se isso falhar, `TerminateProcess` no alvo) e espera o fim do alvo pelo
 * identificador do processo por até `kTerminateConfirmMs` (500 ms). Sai com
 * 27 só se o fim foi confirmado; senão, 29.
 *
 * O prazo externo do supervisor é o mesmo de todos os casos do launcher no
 * Grupo A (5 s desde o início): maior que o pior caso do launcher (linha em
 * até 1,5 s + 2 s de espera + 2 × 500 ms de confirmação = 4,5 s). Só ao
 * vencer o supervisor intervém (encerra o launcher pelo identificador), e o
 * caso reprova.
 */
export const LAUNCHER_TIMEOUT_CASE_ID = 'T-T1.hang'
export const LAUNCHER_TIMEOUT_FLAG = '--launcher-timeout='

/** Espera de confirmação do fim depois de `TerminateJobObject` (`kTerminateConfirmMs` em main.cpp). */
export const LAUNCHER_TERMINATE_CONFIRM_MS = 500
/** Prazo externo do supervisor, desde o início do launcher (o mesmo dos casos do Grupo A). */
export const LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS = LAUNCHER_DEADLINE_MS
/** Código do launcher: prazo vencido e fim do alvo confirmado. */
export const EXIT_HOST_TIMEOUT = 27
/** Código do launcher: fim do alvo NÃO confirmado. */
export const EXIT_HOST_UNCONFIRMED = 29
/**
 * Janela aceita entre a linha do alvo e o `exit` do launcher. A linha sai logo
 * depois da retomada, quando a espera de 2 s já começou: no mínimo 2 s menos
 * uma folga de 500 ms para a entrega da linha; no máximo 2 s mais as duas
 * esperas de confirmação possíveis.
 */
export const LAUNCHER_TIMEOUT_MIN_MS = LAUNCHER_HELPER_WAIT_MS - 500
export const LAUNCHER_TIMEOUT_MAX_MS = LAUNCHER_HELPER_WAIT_MS + 2 * LAUNCHER_TERMINATE_CONFIRM_MS

export const LAUNCHER_TIMEOUT_CASE: CaseDefinition = Object.freeze({
  id: LAUNCHER_TIMEOUT_CASE_ID,
  test: 'T-T1',
  runner: 'node',
  scenario: 'hang',
  layout: 'standard',
  args: 'standard',
  stdout: 'pipe',
  deadlineMs: LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS,
  expectedExit: EXIT_HOST_TIMEOUT,
  description: 'hang pelo launcher, sem intervenção: o prazo interno vence, o launcher encerra J, confirma o fim do alvo e sai com 27'
} satisfies CaseDefinition)

/**
 * Avalia o T-T1.hang. Aprovado só se: o alvo anunciou que estava rodando; o
 * supervisor NÃO interveio; o launcher saiu sozinho com 27 (fim do alvo
 * confirmado por ele) dentro da janela esperada depois da linha; o `close`
 * chegou logo depois (pipe fechado também pelo alvo); o censo logo depois deu 0.
 * Código 29 reprova: o launcher não confirmou o fim do alvo.
 */
export function evaluateLauncherTimeout(o: TerminationObservation): TerminationResult {
  const reasons: string[] = []
  const evidence: string[] = []
  if (o.spawnError !== null) reasons.push(`launcher não iniciou (${o.spawnError})`)
  const out = o.stdout.split(/\r?\n/).filter((l) => l !== '')

  if (o.readyMs === null) reasons.push('o alvo não anunciou que estava rodando')
  else evidence.push(`alvo iniciado: linha "${HANG_READY_LINE}" recebida em ${o.readyMs} ms (o launcher só retoma o alvo depois de confirmar IsProcessInJob em J)`)
  if (out.length !== 1 || out[0] !== HANG_READY_LINE) reasons.push(`saída padrão diferente da única linha do alvo hang (${out.length} linha(s))`)
  if (o.stderrBytes > 0) reasons.push('saída de erro não vazia')

  if (o.killRequestedMs !== null) reasons.push(`o supervisor precisou intervir (encerramento pedido em ${o.killRequestedMs} ms, prazo externo ${LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS} ms)`)
  else evidence.push(`supervisor não interveio (nenhum encerramento pedido; prazo externo ${LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS} ms)`)

  if (o.exitMs === null) reasons.push('exit do launcher não observado')
  else if (o.exitSignal !== null) reasons.push(`launcher encerrado por sinal ${o.exitSignal}, não pelo próprio prazo`)
  else if (o.exitCode === EXIT_HOST_UNCONFIRMED) reasons.push('código 29: o launcher NÃO confirmou o fim do alvo depois do prazo (investigar)')
  else if (o.exitCode !== EXIT_HOST_TIMEOUT) reasons.push(`código ${o.exitCode ?? 'nenhum'}, esperado ${EXIT_HOST_TIMEOUT}`)
  else {
    evidence.push(`launcher saiu SOZINHO com ${EXIT_HOST_TIMEOUT} em ${o.exitMs} ms: prazo interno de ${LAUNCHER_HELPER_WAIT_MS} ms vencido, TerminateJobObject PEDIDO e fim do alvo CONFIRMADO pelo launcher (identificador do processo, até ${LAUNCHER_TERMINATE_CONFIRM_MS} ms)`)
    if (o.readyMs !== null) {
      const elapsed = o.exitMs - o.readyMs
      if (elapsed < LAUNCHER_TIMEOUT_MIN_MS || elapsed > LAUNCHER_TIMEOUT_MAX_MS) reasons.push(`exit ${elapsed} ms depois da linha (esperado entre ${LAUNCHER_TIMEOUT_MIN_MS} e ${LAUNCHER_TIMEOUT_MAX_MS} ms)`)
      else evidence.push(`tempo observado da linha até o exit: ${elapsed} ms (janela ${LAUNCHER_TIMEOUT_MIN_MS}–${LAUNCHER_TIMEOUT_MAX_MS} ms)`)
    }
  }

  if (o.closeMs === null) reasons.push('close não chegou: o alvo pode estar vivo (situação incerta)')
  else if (o.exitMs !== null && o.closeMs < o.exitMs) reasons.push('close antes do exit')
  else if (o.exitMs !== null && o.closeMs - o.exitMs > CLOSE_AFTER_EXIT_MS) reasons.push(`close ${o.closeMs - o.exitMs} ms depois do exit (limite ${CLOSE_AFTER_EXIT_MS} ms)`)
  else if (o.readyMs !== null && o.closeMs - o.readyMs >= HANG_SELF_DEADLINE_MS) reasons.push('o alvo pode ter saído pelo próprio prazo (30 s), não por J')
  else evidence.push(`fim do alvo OBSERVADO pelo supervisor: close em ${o.closeMs} ms (${o.exitMs === null ? '-' : o.closeMs - o.exitMs} ms depois do exit), pipe fechado também pelo alvo, muito antes do prazo próprio dele (${HANG_SELF_DEADLINE_MS} ms)`)

  if (o.censusAfter === null) reasons.push('censo logo depois do encerramento indisponível')
  else if (o.censusAfter > 0) reasons.push(`censo logo depois do encerramento: ${o.censusAfter} processo(s) de teste`)
  else evidence.push('censo logo depois do close: 0 processos de teste')

  return { verdict: reasons.length > 0 ? { pass: false, reasons } : { pass: true, notes: [] }, evidence }
}

export type LauncherTimeoutArgs = { mode: 'launcher-timeout' } | { mode: 'check-launcher-timeout' }

/**
 * Filtro restrito: `--launcher-timeout=` só aceita exatamente `T-T1.hang`, com
 * `--confirm-host-containment-run` ou `--check-only` e nada mais (nem
 * `--group`, `--only`, `--diagnose`, `--diag-variant` ou `--terminate`).
 */
export function parseLauncherTimeoutArgs(argv: readonly string[]): LauncherTimeoutArgs | { mode: 'usage-error'; reason: string } | null {
  const flag = argv.filter((a) => a.startsWith(LAUNCHER_TIMEOUT_FLAG))
  if (flag.length === 0) return null
  if (flag.length > 1) return { mode: 'usage-error', reason: 'argumento repetido' }
  if (flag[0]!.slice(LAUNCHER_TIMEOUT_FLAG.length) !== LAUNCHER_TIMEOUT_CASE_ID) return { mode: 'usage-error', reason: `${LAUNCHER_TIMEOUT_FLAG} aceita só ${LAUNCHER_TIMEOUT_CASE_ID}` }
  const others = argv.filter((a) => !a.startsWith(LAUNCHER_TIMEOUT_FLAG))
  if (others.length === 1 && others[0] === CHECK_ONLY) return { mode: 'check-launcher-timeout' }
  if (others.length === 1 && others[0] === CONFIRM_RUN) return { mode: 'launcher-timeout' }
  return { mode: 'usage-error', reason: `${LAUNCHER_TIMEOUT_FLAG} aceita só ${CONFIRM_RUN} ou ${CHECK_ONLY}, sem outros argumentos` }
}

// ── Repetição: T-K1.hang e T-T1.hang (6C.6C.3C) ─────────────────────────────

/**
 * Modo restrito de repetição. Só os dois casos do alvo hang, cada um no
 * máximo 10 vezes, em sequência (nunca em paralelo), parando na primeira
 * falha, sem nova tentativa. Cada execução usa o MESMO roteiro e os MESMOS
 * critérios das execuções isoladas (6C.6C.3A e 6C.6C.3B).
 *
 * Uso: `--repeat=T-K1.hang,T-T1.hang --times=10 --confirm-host-containment-run`
 * (ou `--check-only`). A ordem do lote é sempre a de `REPEAT_CASES`
 * (T-K1 primeiro), qualquer que seja a ordem na lista.
 */
export const REPEAT_FLAG = '--repeat='
export const TIMES_FLAG = '--times='
export const REPEAT_MAX_TIMES = 10
export const REPEAT_CASES = Object.freeze([TERMINATION_CASE_ID, LAUNCHER_TIMEOUT_CASE_ID] as const)
export type RepeatCaseId = (typeof REPEAT_CASES)[number]
export interface RepeatPlan {
  readonly cases: readonly RepeatCaseId[]
  readonly times: number
}

export type RepeatArgs = { mode: 'repeat'; plan: RepeatPlan } | { mode: 'check-repeat'; plan: RepeatPlan }

export function parseRepeatArgs(argv: readonly string[]): RepeatArgs | { mode: 'usage-error'; reason: string } | null {
  const repeat = argv.filter((a) => a.startsWith(REPEAT_FLAG))
  const times = argv.filter((a) => a.startsWith(TIMES_FLAG))
  if (repeat.length === 0 && times.length === 0) return null
  if (repeat.length !== 1 || times.length !== 1) return { mode: 'usage-error', reason: `${REPEAT_FLAG} e ${TIMES_FLAG} obrigatórios, uma vez cada` }
  const listed = repeat[0]!.slice(REPEAT_FLAG.length).split(',')
  if (listed.some((id) => !(REPEAT_CASES as readonly string[]).includes(id))) return { mode: 'usage-error', reason: `${REPEAT_FLAG} aceita só ${REPEAT_CASES.join(', ')}` }
  if (new Set(listed).size !== listed.length) return { mode: 'usage-error', reason: 'caso repetido em --repeat' }
  const rawTimes = times[0]!.slice(TIMES_FLAG.length)
  if (!/^[1-9][0-9]?$/.test(rawTimes) || Number(rawTimes) > REPEAT_MAX_TIMES) return { mode: 'usage-error', reason: `${TIMES_FLAG} aceita de 1 a ${REPEAT_MAX_TIMES}` }
  const plan: RepeatPlan = Object.freeze({ cases: REPEAT_CASES.filter((id) => listed.includes(id)), times: Number(rawTimes) })
  const others = argv.filter((a) => !a.startsWith(REPEAT_FLAG) && !a.startsWith(TIMES_FLAG))
  if (others.length === 1 && others[0] === CHECK_ONLY) return { mode: 'check-repeat', plan }
  if (others.length === 1 && others[0] === CONFIRM_RUN) return { mode: 'repeat', plan }
  return { mode: 'usage-error', reason: `${REPEAT_FLAG} aceita só ${TIMES_FLAG} e ${CONFIRM_RUN} ou ${CHECK_ONLY}, sem outros argumentos` }
}

// ── Trava pela imagem em execução: T-F3.hang (6C.6C.3E) ─────────────────────

/**
 * Único caso do modo `--file-lock`: o alvo `hang` pelo launcher de testes,
 * como no T-T1 (sem intervenção, código 27), com UMA tentativa do supervisor
 * de abrir a cópia do alvo para escrita enquanto ele roda (H-F3).
 *
 * O launcher fecha a própria trava do arquivo no passo 13, antes do
 * `ResumeThread`: durante a tentativa, a única coisa que pode recusar a
 * escrita é a seção de imagem do processo em execução.
 *
 * A tentativa é a do Node (`fs.openSync(caminho, 'r+')`, isto é, libuv
 * `CreateFileW` com `GENERIC_READ | GENERIC_WRITE`, `FILE_SHARE_READ |
 * FILE_SHARE_WRITE | FILE_SHARE_DELETE`, `OPEN_EXISTING`). Qualquer
 * identificador obtido é fechado na hora, sem escrever.
 */
export const FILE_LOCK_CASE_ID = 'T-F3.hang'
export const FILE_LOCK_FLAG = '--file-lock='

/** Erro do libuv esperado: `ERROR_SHARING_VIOLATION` (32) do Windows vira `EBUSY`. */
export const H_F3_EXPECTED_CODE = 'EBUSY'

export const FILE_LOCK_CASE: CaseDefinition = Object.freeze({
  ...LAUNCHER_TIMEOUT_CASE,
  id: FILE_LOCK_CASE_ID,
  test: 'T-F3',
  description: 'hang pelo launcher, sem intervenção; uma tentativa de abrir o alvo em execução para escrita (H-F3); depois, código 27 como no T-T1'
} satisfies CaseDefinition)

export interface WriteAttempt {
  /** O sistema abriu o arquivo para escrita (o identificador foi fechado na hora, sem escrita). */
  opened: boolean
  /** Código do erro (libuv), ex.: `EBUSY`; `null` se abriu. */
  code: string | null
  /** Número do erro do libuv (negativo); `null` se abriu. */
  errno: number | null
}

export interface FileLockObservation extends TerminationObservation {
  /** Ms (desde o início) da tentativa; `null` = não houve tentativa. */
  attemptMs: number | null
  /** O launcher ainda não tinha saído no instante da tentativa. */
  launcherAliveAtAttempt: boolean | null
  /** Conferência do caminho antes da tentativa, sem abrir para escrita. */
  target: { exists: boolean; regularFile: boolean; size: number | null; readOnlyAttribute: boolean | null; insideScratch: boolean } | null
  attempt: WriteAttempt | null
  /** SHA-256 da cópia: antes da tentativa, logo depois e depois do fim do launcher. */
  hashBefore: string | null
  hashAfterAttempt: string | null
  hashAfterRun: string | null
}

/**
 * Avalia o T-F3.hang: os critérios do T-T1 (sem mudança) e mais:
 * - tentativa feita com o launcher ainda ativo e antes do `exit` 27 (logo, com
 *   o alvo rodando: o 27 só sai se o alvo ainda estava vivo no fim do prazo);
 * - caminho conferido antes: existe, é arquivo comum, tamanho aprovado, sem
 *   atributo somente leitura, dentro da pasta exclusiva;
 * - recusa com `EBUSY` (violação de compartilhamento). Outra recusa (`EPERM`,
 *   `EACCES`, `ENOENT`…) NÃO confirma o H-F3;
 * - conteúdo idêntico ao aprovado antes, logo depois e no fim.
 */
export function evaluateFileLock(o: FileLockObservation): TerminationResult {
  const base = evaluateLauncherTimeout(o)
  const reasons: string[] = base.verdict.pass ? [] : [...base.verdict.reasons]
  const evidence = [...base.evidence]
  const approved = APPROVED_ARTIFACTS.scenarios.hang

  if (o.attemptMs === null || o.attempt === null) reasons.push('a tentativa de abertura para escrita não foi feita')
  else {
    if (o.launcherAliveAtAttempt !== true) reasons.push('o launcher não estava ativo no instante da tentativa')
    if (o.exitMs !== null && o.attemptMs >= o.exitMs) reasons.push('tentativa depois do fim do launcher')
    else if (o.launcherAliveAtAttempt === true && o.readyMs !== null)
      evidence.push(`tentativa em ${o.attemptMs} ms (${o.attemptMs - o.readyMs} ms depois da linha do alvo), com o launcher ativo; o código 27 posterior mostra que o alvo ainda rodava no fim do prazo interno, depois da tentativa`)
  }

  const t = o.target
  if (t === null) reasons.push('caminho do alvo não conferido antes da tentativa')
  else if (!t.insideScratch) reasons.push('caminho do alvo fora da pasta exclusiva')
  else if (!t.exists || !t.regularFile) reasons.push('arquivo do alvo ausente ou não é arquivo comum (a recusa não seria do H-F3)')
  else if (t.size !== approved.size) reasons.push(`tamanho do alvo ${t.size ?? '?'} diferente do aprovado`)
  else if (t.readOnlyAttribute !== false) reasons.push('atributo somente leitura presente ou desconhecido (a recusa poderia vir dele)')
  else evidence.push(`caminho conferido antes: arquivo comum na pasta exclusiva, ${t.size} bytes, sem atributo somente leitura`)

  const a = o.attempt
  if (a !== null) {
    if (a.opened) reasons.push('H-F3 REFUTADA: o arquivo em execução foi aberto para escrita (fechado na hora, sem escrever)')
    else if (a.code !== H_F3_EXPECTED_CODE) reasons.push(`recusa com ${a.code ?? '?'} (errno ${a.errno ?? '?'}): não é violação de compartilhamento; não confirma o H-F3`)
    else evidence.push(`abertura para escrita RECUSADA: ${a.code} (errno ${a.errno ?? '?'}), que o libuv usa para ERROR_SHARING_VIOLATION (32) e ERROR_LOCK_VIOLATION (33) do Windows`)
  }

  const hashes = [
    ['antes da tentativa', o.hashBefore],
    ['logo depois', o.hashAfterAttempt],
    ['depois do fim do launcher', o.hashAfterRun]
  ] as const
  const wrong = hashes.filter(([, h]) => h !== approved.sha256)
  if (wrong.length > 0) reasons.push(`conteúdo do alvo não conferido ou diferente do aprovado (${wrong.map(([l]) => l).join(', ')})`)
  else evidence.push(`conteúdo do alvo idêntico ao aprovado (SHA-256 ${approved.sha256.slice(0, 12)}…) antes, logo depois e no fim`)

  return { verdict: reasons.length > 0 ? { pass: false, reasons } : { pass: true, notes: [] }, evidence }
}

/**
 * Casos do segurador de travas (6C.6C.3G): reproduções sem o launcher. O
 * segurador (`gerpro-lock-holder-test.exe`) abre os objetos com as MESMAS
 * flags do launcher; o supervisor faz as tentativas. T-F2 não está aqui.
 */
export const LOCK_HOLDER_CASE_IDS = Object.freeze(['T-F1.exit-ok', 'T-F4.exit-ok'] as const)
export type LockHolderCaseId = (typeof LOCK_HOLDER_CASE_IDS)[number]
/** Únicos valores de `--file-lock=`: um caso por execução. */
export const FILE_LOCK_CASE_IDS = Object.freeze([FILE_LOCK_CASE_ID, ...LOCK_HOLDER_CASE_IDS] as const)
export type FileLockCaseId = (typeof FILE_LOCK_CASE_IDS)[number]

export type FileLockArgs = { mode: 'file-lock'; caseId: FileLockCaseId } | { mode: 'check-file-lock'; caseId: FileLockCaseId }

/**
 * Filtro restrito: `--file-lock=` aceita exatamente UM de `T-F3.hang`,
 * `T-F1.exit-ok` ou `T-F4.exit-ok` (sem lista, curinga, caminho nem outra
 * grafia), com `--confirm-host-containment-run` ou `--check-only` e nada mais.
 */
export function parseFileLockArgs(argv: readonly string[]): FileLockArgs | { mode: 'usage-error'; reason: string } | null {
  const flag = argv.filter((a) => a.startsWith(FILE_LOCK_FLAG))
  if (flag.length === 0) return null
  if (flag.length > 1) return { mode: 'usage-error', reason: 'argumento repetido' }
  const caseId = flag[0]!.slice(FILE_LOCK_FLAG.length)
  if (!(FILE_LOCK_CASE_IDS as readonly string[]).includes(caseId)) return { mode: 'usage-error', reason: `${FILE_LOCK_FLAG} aceita só um de ${FILE_LOCK_CASE_IDS.join(', ')}` }
  const others = argv.filter((a) => !a.startsWith(FILE_LOCK_FLAG))
  if (others.length === 1 && others[0] === CHECK_ONLY) return { mode: 'check-file-lock', caseId: caseId as FileLockCaseId }
  if (others.length === 1 && others[0] === CONFIRM_RUN) return { mode: 'file-lock', caseId: caseId as FileLockCaseId }
  return { mode: 'usage-error', reason: `${FILE_LOCK_FLAG} aceita só ${CONFIRM_RUN} ou ${CHECK_ONLY}, sem outros argumentos` }
}

export const isLockHolderCase = (id: FileLockCaseId): id is LockHolderCaseId => (LOCK_HOLDER_CASE_IDS as readonly string[]).includes(id)

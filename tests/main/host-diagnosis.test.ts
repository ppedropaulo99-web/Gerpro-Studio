import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  BATTERY_EXIT,
  diagnosisLauncherPath,
  runDiagnosis,
  validateDiagnosisArtifacts,
  type BatteryDeps,
  type BatteryFs,
  type ChildRun,
  type RawRun
} from '../../scripts/diagnostics/host-containment/battery'
import {
  APPROVED_ARTIFACTS,
  APPROVED_DIAG_LAUNCHERS,
  CHECK_ONLY,
  CONFIRM_RUN,
  DIAGNOSIS_CASE,
  DIAGNOSIS_CASE_ID,
  evaluateDiagnosis,
  GROUP_A_CASES,
  parseDiagnosisArgs,
  parseDiagnosticLine,
  parseSupervisorArgs,
  splitDiagnosticOutput,
  type CaseObservation
} from '../../scripts/diagnostics/host-containment/plan'
import { BATTERY_SCRATCH_PREFIX, filetimeFromMs, type ProcessIdentity } from '../../scripts/diagnostics/host-containment/system-checks'
import {
  checkDiagMarker,
  DIAG_EXTRA_FUNCTIONS,
  DIAG_HOST_ALLOWED_FUNCTIONS,
  DIAG_LINE_PREFIX as PE_DIAG_PREFIX,
  HOST_ALLOWED_FUNCTIONS,
  HOST_FORBIDDEN_FUNCTIONS
} from '../../scripts/native/pe-inspect'
import { diagnosticBlocks, nonDiagnostic, resolveDiagnostic } from '../support/launcher-views'

// Etapa 6C.6C.2C: variante diagnóstica do launcher de testes e filtro
// restrito do supervisor. Nada é compilado nem executado aqui; os processos,
// o censo e a trava são simulados.

const ROOT = join(import.meta.dirname, '../..')
const HOST = join(ROOT, 'native', 'helper-host')
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const count = (text: string, pattern: RegExp) => [...text.matchAll(new RegExp(pattern.source, 'g'))].length

// ── Fontes ──────────────────────────────────────────────────────────────────

describe('variante diagnóstica: fontes', () => {
  const raw = read(HOST, 'src', 'main.cpp')
  const views = {
    production: code(nonDiagnostic(raw)),
    diag: code(resolveDiagnostic(raw, { diag: true, detached: false }))
  }

  it('blocos diagnósticos fechados, sem aninhamento, e nada diagnóstico fora deles', () => {
    const blocks = diagnosticBlocks(raw)
    assert.ok(blocks.length >= 9)
    for (const b of blocks) assert.doesNotMatch(b.first + (b.second ?? ''), /#if/)
    const lines = raw.split(/\n/).filter((l) => !l.startsWith('//') && l.includes('GERPRO_HOST_DIAG_'))
    for (const l of lines) assert.match(l, /^#if defined\(GERPRO_HOST_DIAG_BUILD\)$/, l)
    assert.equal(lines.filter((l) => l.startsWith('#if')).length, blocks.length, 'todo #if diagnóstico é um bloco reconhecido')
    assert.doesNotMatch(views.production, /diag::|host_diag|GetQueuedCompletionStatus|CreateIoCompletionPort/)
  })

  it('as três visões têm a mesma sequência de contenção e as mesmas saídas, na mesma ordem', () => {
    const exits = (view: string) => [...view.matchAll(/kExitHost[A-Za-z]+|MapHelperExit/g)].map((m) => m[0])
    const order = [
      'ParseArguments(argc, argv, expected)',
      'LockHelperFile(helperFile',
      'DigestInSet(expected',
      'CreateContainmentJob(job)',
      '::CreateProcessW(',
      '::IsProcessInJob(process.get(), job.get(), &inJob)',
      'HashOpenFile(helperFile.get(), helperSize, mapped)',
      'helperFile.Close();',
      '::ResumeThread(thread.get())',
      '::WaitForSingleObject(process.get(), kHelperWaitMs)',
      '::GetExitCodeProcess(process.get(), &helperExit)',
      'JobAccountingIs(job.get(), 0)'
    ]
    const testView = code(nonDiagnostic(raw).replace(/#if defined\(GERPRO_HOST_TEST_BUILD\)\n([\s\S]*?)#endif\n/g, '$1'))
    for (const [name, view] of Object.entries({ production: views.production, diag: views.diag })) {
      assert.equal(count(view, /::CreateProcessW\(/), 1, name)
      assert.equal(count(view, /::ResumeThread\(/), 1, name)
      assert.match(view, /PROC_THREAD_ATTRIBUTE_JOB_LIST, jobList/, name)
      assert.match(view, /CREATE_SUSPENDED \| EXTENDED_STARTUPINFO_PRESENT \| DETACHED_PROCESS \| CREATE_UNICODE_ENVIRONMENT/, name)
      assert.match(view, /DWORD childPolicy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;/, name)
      assert.doesNotMatch(view, /AssignProcessToJobObject|BREAKAWAY|OpenProcess/, name)
      const at = order.map((needle) => view.indexOf(needle))
      assert.ok(at.every((i) => i >= 0), name)
      assert.deepEqual([...at].sort((a, b) => a - b), at, `${name}: ordem`)
      assert.deepEqual(exits(view), exits(testView), `${name}: mesmas saídas`)
    }
  })

  it('6C.6C.2E: uma única forma de criação (DETACHED_PROCESS) em produção, testes e diagnóstico; nenhuma chave de comparação', () => {
    for (const view of [views.production, views.diag]) {
      assert.equal(count(view, /DETACHED_PROCESS/), 1)
      assert.doesNotMatch(view, /CREATE_NO_WINDOW|CREATE_NEW_CONSOLE/)
    }
    assert.doesNotMatch(raw, /GERPRO_HOST_DIAG_DETACHED/)
    assert.doesNotMatch(read(HOST, 'test-artifacts', 'host_diag.cpp'), /GERPRO_HOST_DIAG_DETACHED|"nowindow"/)
    assert.match(code(read(HOST, 'test-artifacts', 'host_diag.cpp')), /constexpr char kCreationVariant\[\] = "detached";/)
    const build = code(read(ROOT, 'scripts', 'native', 'build-host-diag-artifacts.mjs'))
    assert.doesNotMatch(build, /GERPRO_HOST_DIAG_DETACHED|nowindow/)
  })

  it('host_diag: só consultas ao job, ao processo criado e à porta própria; uma escrita, na saída padrão', () => {
    const h = read(HOST, 'test-artifacts', 'host_diag.h')
    const cpp = code(read(HOST, 'test-artifacts', 'host_diag.cpp'))
    assert.match(h, /#if !defined\(GERPRO_HOST_DIAG_BUILD\) \|\| !defined\(GERPRO_HOST_TEST_BUILD\)\n#error/)
    assert.doesNotMatch(cpp, /OpenProcess|CreateProcess|TerminateProcess|TerminateJobObject|AssignProcessToJobObject|CreateFile|GetModuleFileName|QueryFullProcessImageName|GetEnvironment|GetUserName|GetComputerName|LoadLibrary|GetProcAddress|new |malloc/)
    assert.equal(count(cpp, /::WriteFile\(/), 1)
    assert.match(cpp, /::GetFileType\(output\) != FILE_TYPE_PIPE\) return;/)
    assert.equal(count(cpp, /::GetQueuedCompletionStatus\([^;]*, 0\)/), 1, 'drenagem sem espera')
    assert.match(cpp, /line\.Text\("gerpro-host-diag v=1"\)/)
  })

  it('build diagnóstico: grava só em build/test/diag*, controles idênticos e apagados, nada executado', () => {
    const s = code(read(ROOT, 'scripts', 'native', 'build-host-diag-artifacts.mjs'))
    assert.equal(count(s, /writeFileSync\(/), 2)
    assert.match(s, /\['diag', 'diag-repro'\]\.includes\(name\)/)
    assert.doesNotMatch(s, /spawn|execFile|exec\(|OUTPUT_DIR|'resources'/)
    assert.match(s, /productionIdentical: sha256\(readFileSync\(productionControl\)\) === inputs\.productionHash/)
    assert.match(s, /testIdentical: sha256\(readFileSync\(testControl\)\) === APPROVED_ARTIFACTS\.launcher\.sha256/)
    assert.match(s, /rmSync\(join\(dir, 'control'\)/)
    assert.match(s, /checkDiagMarker\(bytes, v\.id\)/)
    assert.match(s, /singleDigestHeader\(inputs\.exitOkHash\)/)
    const production = code(read(ROOT, 'scripts', 'native', 'build-helper-host.mjs'))
    assert.doesNotMatch(production, /DIAG|host_diag/)
  })
})

// ── PE ──────────────────────────────────────────────────────────────────────

describe('variante diagnóstica: política de PE', () => {
  it('lista diagnóstica = lista do launcher + só as duas funções da porta de conclusão', () => {
    assert.deepEqual(DIAG_HOST_ALLOWED_FUNCTIONS['kernel32.dll'], [...HOST_ALLOWED_FUNCTIONS['kernel32.dll'], ...DIAG_EXTRA_FUNCTIONS])
    assert.deepEqual(DIAG_HOST_ALLOWED_FUNCTIONS['bcrypt.dll'], HOST_ALLOWED_FUNCTIONS['bcrypt.dll'])
    assert.deepEqual([...DIAG_EXTRA_FUNCTIONS], ['CreateIoCompletionPort', 'GetQueuedCompletionStatus'])
    assert.ok((HOST_FORBIDDEN_FUNCTIONS as readonly string[]).includes('OpenProcess'))
    assert.ok(DIAG_EXTRA_FUNCTIONS.every((f) => !(HOST_FORBIDDEN_FUNCTIONS as readonly string[]).includes(f)))
  })

  it('marca diagnóstica: ausente nas outras variantes, presente com a forma de criação certa', () => {
    const plain = Buffer.from('MZ ... gerpro-helper-host-test.exe', 'latin1')
    const nowindow = Buffer.from(`MZ ${PE_DIAG_PREFIX} creation nowindow`, 'latin1')
    const detached = Buffer.from(`MZ ${PE_DIAG_PREFIX} creation detached`, 'latin1')
    assert.deepEqual(checkDiagMarker(plain, 'absent'), [])
    assert.deepEqual(checkDiagMarker(nowindow, 'absent'), ['wrong-variant-identity'])
    assert.deepEqual(checkDiagMarker(nowindow, 'detached'), ['wrong-variant-identity'])
    assert.deepEqual(checkDiagMarker(detached, 'nowindow'), ['wrong-variant-identity'])
    assert.deepEqual(checkDiagMarker(detached, 'detached'), [])
    assert.deepEqual(checkDiagMarker(plain, 'detached'), ['wrong-variant-identity'])
  })
})

// ── Filtro restrito ─────────────────────────────────────────────────────────

const V = '--diag-variant=detached'

describe('filtro diagnóstico: só T-H1.exit-ok, sem ampliar permissões', () => {
  it('aceita exatamente T-H1.exit-ok com confirmação (executa) ou --check-only (só confere)', () => {
    assert.deepEqual(parseDiagnosisArgs([`--diagnose=${DIAGNOSIS_CASE_ID}`, V, CONFIRM_RUN]), { mode: 'diagnose', variant: 'detached' })
    assert.deepEqual(parseDiagnosisArgs([CONFIRM_RUN, '--diag-variant=detached', `--diagnose=${DIAGNOSIS_CASE_ID}`]), { mode: 'diagnose', variant: 'detached' })
    assert.deepEqual(parseDiagnosisArgs([`--diagnose=${DIAGNOSIS_CASE_ID}`, '--diag-variant=detached', CHECK_ONLY]), { mode: 'check-diagnose', variant: 'detached' })
  })

  it('sem o filtro, nada muda no supervisor do Grupo A', () => {
    assert.equal(parseDiagnosisArgs(['--group=A', CONFIRM_RUN]), null)
    assert.equal(parseDiagnosisArgs([]), null)
    // O parser do Grupo A não conhece o filtro: recusa.
    assert.equal(parseSupervisorArgs([`--diagnose=${DIAGNOSIS_CASE_ID}`, CONFIRM_RUN]).mode, 'usage-error')
    // A variante sozinha não abre o modo diagnóstico, e o Grupo A não a aceita.
    assert.equal(parseDiagnosisArgs([V, '--group=A', CONFIRM_RUN]), null)
    assert.equal(parseSupervisorArgs([V, '--group=A', CONFIRM_RUN]).mode, 'usage-error')
  })

  const rejected: Array<[string, string[]]> = [
    ['outro caso do T-H1', [V, '--diagnose=T-H1.exit-contract', CONFIRM_RUN]],
    ['só o teste', [V, '--diagnose=T-H1', CONFIRM_RUN]],
    ['lista', [V, `--diagnose=${DIAGNOSIS_CASE_ID},T-E1.extra-arg`, CONFIRM_RUN]],
    ['curinga', [V, '--diagnose=*', CONFIRM_RUN]],
    ['maiúsculas', [V, '--diagnose=T-H1.EXIT-OK', CONFIRM_RUN]],
    ['vazio', [V, '--diagnose=', CONFIRM_RUN]],
    ['sem confirmação', [V, `--diagnose=${DIAGNOSIS_CASE_ID}`]],
    ['com --group', [V, `--diagnose=${DIAGNOSIS_CASE_ID}`, '--group=A', CONFIRM_RUN]],
    ['com --only', [V, `--diagnose=${DIAGNOSIS_CASE_ID}`, '--only=T-H1', CONFIRM_RUN]],
    ['repetido', [V, `--diagnose=${DIAGNOSIS_CASE_ID}`, `--diagnose=${DIAGNOSIS_CASE_ID}`, CONFIRM_RUN]],
    ['confirmação e --check-only', [V, `--diagnose=${DIAGNOSIS_CASE_ID}`, CONFIRM_RUN, CHECK_ONLY]],
    ['confirmação repetida', [V, `--diagnose=${DIAGNOSIS_CASE_ID}`, CONFIRM_RUN, CONFIRM_RUN]],
    ['argumento desconhecido', [V, `--diagnose=${DIAGNOSIS_CASE_ID}`, CONFIRM_RUN, '--repeat=2']],
    ['sem variante', [`--diagnose=${DIAGNOSIS_CASE_ID}`, CONFIRM_RUN]],
    ['variante desconhecida', [`--diagnose=${DIAGNOSIS_CASE_ID}`, '--diag-variant=both', CONFIRM_RUN]],
    ['variante em maiúsculas', [`--diagnose=${DIAGNOSIS_CASE_ID}`, '--diag-variant=DETACHED', CONFIRM_RUN]],
    ['variante vazia', [`--diagnose=${DIAGNOSIS_CASE_ID}`, '--diag-variant=', CONFIRM_RUN]],
    ['duas variantes', [`--diagnose=${DIAGNOSIS_CASE_ID}`, V, '--diag-variant=detached', CONFIRM_RUN]],
    ['variante nowindow (retirada na 6C.6C.2E)', [`--diagnose=${DIAGNOSIS_CASE_ID}`, '--diag-variant=nowindow', CONFIRM_RUN]]
  ]
  for (const [name, argv] of rejected) {
    it(`recusa: ${name}`, () => assert.equal(parseDiagnosisArgs(argv)?.mode, 'usage-error'))
  }

  it('o caso diagnóstico é o MESMO T-H1.exit-ok do Grupo A', () => {
    const original = GROUP_A_CASES.find((c) => c.id === 'T-H1.exit-ok')
    assert.equal(DIAGNOSIS_CASE, original)
    assert.equal(DIAGNOSIS_CASE.scenario, 'exit-ok')
    assert.equal(DIAGNOSIS_CASE.runner, 'node')
    assert.equal(DIAGNOSIS_CASE.expectedExit, 0)
    assert.equal(DIAGNOSIS_CASE.args, 'standard')
  })
})

// ── Linha diagnóstica ───────────────────────────────────────────────────────

const LINE_28 =
  'gerpro-host-diag v=1 creation=detached digests=1 port=1 port-err=0 create=1 create-err=0 pre-contained=1 pre-injob=1 pre-acct=1,1,0 pre-ids=1,1,0 resume=1 resume-err=0 wait=0x00000000 wait-err=0 wait-acct=0,2,1 wait-ids=0,0,0 gec=1 gec-err=0 raw=0xC0000142 exit-acct=0,2,1 term=0 term-job=- term-err=- term-wait=- msgs=6h,3n,7h,4n msgs-dropped=0 host=28'
const LINE_0 = LINE_28.replace('wait-acct=0,2,1', 'wait-acct=0,1,0').replace('exit-acct=0,2,1', 'exit-acct=0,1,0').replace('raw=0xC0000142', 'raw=0x00000000').replace('msgs=6h,3n,7h,4n', 'msgs=6h,7h,4n').replace('host=28', 'host=0')
const obs = (exitCode: number, stdout: string): CaseObservation => ({ exitCode, stdout, stderrBytes: 0, exitMs: 40, closeMs: 41, deadlineHit: false, spawnError: null })

describe('linha diagnóstica: leitura e avaliação', () => {
  it('separa a linha diagnóstica da saída do alvo', () => {
    const { diagnostic, rest } = splitDiagnosticOutput(`gerpro-synthetic scenario=exit-ok\n${LINE_0}\n`)
    assert.deepEqual(diagnostic, [LINE_0])
    assert.equal(rest.trim(), 'gerpro-synthetic scenario=exit-ok')
  })

  it('formato fixo: só chaves e valores ASCII previstos; caminhos e texto livre são recusados', () => {
    assert.equal(parseDiagnosticLine(LINE_28)?.raw, '0xC0000142')
    assert.equal(parseDiagnosticLine(`${LINE_28} path=C:\\Users\\x`), null)
    assert.equal(parseDiagnosticLine(`${LINE_28} host=0`), null, 'chave repetida')
    assert.equal(parseDiagnosticLine('gerpro-host-diag v=2 host=0'), null)
    assert.equal(parseDiagnosticLine(`${LINE_28} nome=João`), null)
  })

  it('reprodução do 28: caso reprovado, linha válida, observações sem conclusão', () => {
    const d = evaluateDiagnosis(obs(28, `${LINE_28}\n`), 'detached')
    assert.equal(d.verdict.pass, false)
    assert.deepEqual(d.issues, [])
    assert.equal(d.fields?.raw, '0xC0000142')
    const text = d.observations.join('\n')
    assert.match(text, /STATUS_DLL_INIT_FAILED/)
    assert.match(text, /antes da retomada: ativos 1, total 1, encerrados por limite 0/)
    assert.match(text, /mais de um processo foi associado a J/)
    assert.match(text, /a identidade do outro não é conhecida/)
    assert.match(text, /ACTIVE_PROCESS_LIMIT/)
    assert.doesNotMatch(text, /conhost|confirmad/i)
    assert.ok(d.criteria.some((c) => c.includes('0xC0000142')))
    assert.ok(d.criteria.some((c) => c.includes('código do launcher 28')))
  })

  it('critérios da 6C.6C.2D: tudo atendido só com código bruto 0, J com 1 processo e nada excedente', () => {
    const detached = LINE_0
    const ok = evaluateDiagnosis(obs(0, `gerpro-synthetic scenario=exit-ok\n${detached}\n`), 'detached')
    assert.equal(ok.verdict.pass, true)
    assert.deepEqual(ok.issues, [])
    assert.deepEqual(ok.criteria, [])
    const variants: Array<[string, RegExp]> = [
      [detached.replace('pre-acct=1,1,0', 'pre-acct=0,0,0'), /associação a J antes da retomada/],
      [detached.replace('pre-injob=1', 'pre-injob=0'), /associação a J antes da retomada/],
      [detached.replace('exit-acct=0,1,0', 'exit-acct=0,2,0'), /exit-acct=0,2,0/],
      [detached.replace('wait-acct=0,1,0', 'wait-acct=0,1,1'), /wait-acct=0,1,1/],
      [detached.replace('wait-ids=0,0,0', 'wait-ids=1,1,1'), /outro processo/],
      [detached.replace('msgs=6h,7h,4n', 'msgs=6h,6o,7h,4n'), /outro processo ou de limite/],
      [detached.replace('msgs=6h,7h,4n', 'msgs=6h,3n,7h,4n'), /outro processo ou de limite/],
      [detached.replace('term=0', 'term=1'), /encerrou processos/],
      [detached.replace('resume=1', 'resume=0'), /ResumeThread devolveu 0/],
      [detached.replace('wait=0x00000000', 'wait=0x00000102'), /espera terminou com 0x00000102/]
    ]
    for (const [line, expected] of variants) {
      const d = evaluateDiagnosis(obs(0, `gerpro-synthetic scenario=exit-ok\n${line}\n`), 'detached')
      assert.match(d.criteria.join(' | '), expected, line)
    }
    // Uma linha de outra forma de criação é incoerente.
    assert.match(evaluateDiagnosis(obs(0, `gerpro-synthetic scenario=exit-ok\n${detached.replace('creation=detached', 'creation=nowindow')}\n`), 'detached').issues.join(), /variante de criação nowindow/)
  })

  it('sem reprodução: caso aprovado (código 0 e linha do alvo)', () => {
    const d = evaluateDiagnosis(obs(0, `gerpro-synthetic scenario=exit-ok\n${LINE_0}\n`), 'detached')
    assert.equal(d.verdict.pass, true)
    assert.deepEqual(d.issues, [])
  })

  it('linha ausente, repetida ou incoerente vira problema', () => {
    assert.deepEqual(evaluateDiagnosis(obs(28, ''), 'detached').issues, ['esperada 1 linha diagnóstica, vieram 0'])
    assert.deepEqual(evaluateDiagnosis(obs(28, `${LINE_28}\n${LINE_28}\n`), 'detached').issues, ['esperada 1 linha diagnóstica, vieram 2'])
    assert.deepEqual(evaluateDiagnosis(obs(27, `${LINE_28}\n`), 'detached').issues, ['código na linha diferente do código de saída do launcher'])
    assert.match(evaluateDiagnosis(obs(28, `${LINE_28.replace('creation=detached', 'creation=nowindow')}\n`), 'detached').issues.join(), /variante de criação nowindow/)
    assert.match(evaluateDiagnosis(obs(28, `${LINE_28.replace('digests=1', 'digests=7')}\n`), 'detached').issues.join(), /mais de um alvo/)
  })
})

// ── Supervisor (simulado) ───────────────────────────────────────────────────

let tmpRoot: string
beforeEach(() => {
  tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'gerpro-diag-test-')))
})
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const fs: BatteryFs = {
  mkdtemp: (prefix) => mkdtempSync(prefix),
  lstat: (path) => lstatSync(path),
  readdir: (path) => readdirSync(path),
  unlink: (path) => unlinkSync(path),
  rmdir: (path) => rmdirSync(path),
  realpath: (path) => realpathSync.native(path),
  mkdirp: (path) => mkdirSync(path, { recursive: true }),
  writeFile: (path, bytes) => writeFileSync(path, bytes, { flag: 'wx' }),
  readFile: (path) => readFileSync(path),
  symlinkFile: () => {
    throw Object.assign(new Error('sem permissão'), { code: 'EPERM' })
  }
}

interface Rec {
  spawns: Array<{ executable: string; args: readonly string[]; stdout: string }>
  electron: number
  logs: string[]
  killed: number
}

function fakeDeps(overrides: Partial<BatteryDeps> = {}, run?: () => RawRun, census?: () => ProcessIdentity[] | null): { d: BatteryDeps; rec: Rec } {
  const rec: Rec = { spawns: [], electron: 0, logs: [], killed: 0 }
  const d: BatteryDeps = {
    platform: 'win32',
    arch: 'x64',
    tmpRoot,
    artifactsDir: join(tmpRoot, 'nao-usado'),
    fs,
    validate: () => {
      throw new Error('o modo diagnóstico não pode usar a conferência do Grupo A')
    },
    validateDiagnosis: () => ({ set: { launcher: Buffer.from('diag'), scenarios: new Map([['exit-ok', Buffer.from('alvo exit-ok')]]) }, issues: [] }),
    electronVersion: () => '45.0.0',
    integrityLevel: () => 'medium',
    census: census ?? (() => []),
    acquireLock: () => 'acquired',
    releaseLock: () => true,
    spawnLauncher(executable, args, stdout) {
      rec.spawns.push({ executable, args, stdout })
      const raw = run ? run() : { exitCode: 28, stdout: `${LINE_28}\n`, stderrBytes: 0, exitMs: 50, closeMs: 51, spawnError: null }
      return { pid: 4242, done: Promise.resolve(raw), kill: () => rec.killed++ } satisfies ChildRun
    },
    spawnElectron() {
      rec.electron++
      throw new Error('o modo diagnóstico não inicia Electron')
    },
    electronCensus: () => [],
    electronImagePath: 'C:\\proj\\electron.exe',
    now: () => Date.now(),
    sleep: async () => {},
    deadline: () => ({ reached: new Promise<void>(() => {}), cancel: () => {} }),
    log: (line) => rec.logs.push(line),
    ...overrides
  }
  return { d, rec }
}

describe('supervisor no modo diagnóstico (simulado)', () => {
  it('uma única execução: T-H1.exit-ok, variante diagnóstica, argumentos padrão com o hash do exit-ok', async () => {
    const { d, rec } = fakeDeps()
    const report = await runDiagnosis(d, 'detached')
    assert.equal(rec.spawns.length, 1)
    assert.equal(rec.electron, 0)
    assert.equal(report.results.length, 1)
    assert.equal(report.results[0]!.id, DIAGNOSIS_CASE_ID)
    assert.deepEqual(rec.spawns[0]!.args, ['--protocol', '1', '--helper-sha256', APPROVED_ARTIFACTS.scenarios['exit-ok'].sha256])
    assert.equal(rec.spawns[0]!.stdout, 'pipe')
    assert.match(rec.spawns[0]!.executable, /host-test\\win32-x64\\gerpro-helper-host-test\.exe$/)
    // A cópia gravada é a variante diagnóstica (conferida pelos bytes).
    assert.ok(rec.logs.some((l) => l.includes('[variante diagnóstica detached]') && l.includes(APPROVED_DIAG_LAUNCHERS.detached.sha256.slice(0, 12))))
    // Reprovado (28), sem nova tentativa; linha registrada; pasta removida.
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(report.results[0]!.diagnosis?.fields?.raw, '0xC0000142')
    assert.ok(rec.logs.some((l) => l.startsWith(`${DIAGNOSIS_CASE_ID}: linha diagnóstica: gerpro-host-diag v=1`)))
    assert.equal(report.cleanup?.removed, true)
    assert.equal(rec.killed, 0)
    assert.deepEqual(readdirSync(tmpRoot).filter((n) => n.startsWith(BATTERY_SCRATCH_PREFIX)), [])
  })

  it('sem as pré-condições, nada é iniciado', async () => {
    for (const override of [
      { integrityLevel: () => 'high' as const },
      { validateDiagnosis: () => ({ set: null, issues: ['variante diagnóstica: tamanho ou SHA-256 diferente do aprovado'] }) },
      { acquireLock: () => 'held' as const },
      { census: () => [{ pid: 9, ppid: 1, created: '1', path: 'C:\\x\\gerpro-helper-host-test.exe' }] }
    ] satisfies Array<Partial<BatteryDeps>>) {
      const { d, rec } = fakeDeps(override)
      const report = await runDiagnosis(d, 'detached')
      assert.equal(report.exitCode, BATTERY_EXIT.precondition)
      assert.equal(rec.spawns.length, 0)
    }
  })

  it('sobrevivente depois do caso: para, registra e não encerra nada', async () => {
    let calls = 0
    let owned = ''
    const census = (): ProcessIdentity[] => (++calls === 1 ? [] : [{ pid: 501, ppid: 1, created: filetimeFromMs(Date.now() + 60_000), path: owned }])
    const { d, rec } = fakeDeps(
      {
        spawnLauncher(executable, args, stdout) {
          rec.spawns.push({ executable, args, stdout })
          owned = executable.replace('gerpro-helper-host-test.exe', 'gerpro-synthetic-helper.exe')
          return { pid: 1, done: Promise.resolve({ exitCode: 28, stdout: `${LINE_28}\n`, stderrBytes: 0, exitMs: 5, closeMs: 6, spawnError: null }), kill: () => rec.killed++ }
        }
      },
      undefined,
      census
    )
    const report = await runDiagnosis(d, 'detached')
    assert.equal(report.exitCode, BATTERY_EXIT.survivors)
    assert.equal(rec.killed, 0)
    assert.ok(rec.logs.some((l) => l.includes('PID 501') && l.includes('NÃO encerrado')))
  })

  it('prazo estourado: só o processo iniciado é encerrado, pelo próprio identificador', async () => {
    let resolveDone: (raw: RawRun) => void = () => {}
    const { d, rec } = fakeDeps({
      deadline: () => ({ reached: Promise.resolve(), cancel: () => {} }),
      spawnLauncher(executable, args, stdout) {
        rec.spawns.push({ executable, args, stdout })
        const done = new Promise<RawRun>((r) => (resolveDone = r))
        return {
          pid: 7,
          done,
          kill: () => {
            rec.killed++
            resolveDone({ exitCode: null, stdout: '', stderrBytes: 0, exitMs: 5_000, closeMs: 5_001, spawnError: null })
          }
        }
      }
    })
    const report = await runDiagnosis(d, 'detached')
    assert.equal(rec.killed, 1)
    assert.equal(rec.spawns.length, 1)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
  })
})

describe('conferência dos artefatos do modo diagnóstico', () => {
  for (const [variant, other] of [['detached', 'nowindow']] as const) {
    it(`variante ${variant}: lê só ela (nunca a ${other}) e recusa quando não há bytes aprovados`, () => {
      const seen: string[] = []
      const dir = join(tmpRoot, 'test', 'x64')
      const { set, issues } = validateDiagnosisArtifacts(
        {
          readFile(path: string) {
            seen.push(path)
            throw Object.assign(new Error('ausente'), { code: 'ENOENT' })
          }
        },
        dir,
        variant
      )
      assert.equal(set, null)
      assert.ok(issues.some((i) => i.startsWith('variante diagnóstica: não lida')))
      assert.ok(seen.includes(diagnosisLauncherPath(dir, variant)))
      assert.ok(seen.every((p) => !p.includes(`\\${other}\\`)))
      assert.ok(diagnosisLauncherPath(dir, variant).endsWith(join('diag', variant, 'gerpro-helper-host-test.exe')))
    })
  }

  it('variante detached: uma única execução, com o hash fixado dela e a mesma bateria', async () => {
    const { d, rec } = fakeDeps({}, () => ({
      exitCode: 0,
      stdout: `gerpro-synthetic scenario=exit-ok\n${LINE_0}\n`,
      stderrBytes: 0,
      exitMs: 40,
      closeMs: 41,
      spawnError: null
    }))
    const report = await runDiagnosis(d, 'detached')
    assert.equal(rec.spawns.length, 1)
    assert.equal(report.exitCode, BATTERY_EXIT.ok)
    assert.equal(report.results[0]!.status, 'pass')
    assert.ok(rec.logs.some((l) => l.includes('[variante diagnóstica detached]') && l.includes(APPROVED_DIAG_LAUNCHERS.detached.sha256.slice(0, 12))))
    assert.ok(rec.logs.some((l) => l === `${DIAGNOSIS_CASE_ID}: saída do alvo pelo pipe: gerpro-synthetic scenario=exit-ok`))
  })

  it('saída fora do formato do alvo não é mostrada, só contada', async () => {
    const { d, rec } = fakeDeps({}, () => ({ exitCode: 28, stdout: `C:\\Users\\alguem\\x\n${LINE_28}\n`, stderrBytes: 0, exitMs: 4, closeMs: 5, spawnError: null }))
    await runDiagnosis(d, 'detached')
    assert.ok(!rec.logs.some((l) => l.includes('alguem')))
    assert.ok(rec.logs.some((l) => l.includes('1 linha(s) fora do formato do alvo')))
  })

  it('o supervisor real não substitui a conferência e só chama runDiagnosis pelo filtro', () => {
    const entry = code(read(ROOT, 'scripts', 'diagnostics', 'run-host-containment.mjs'))
    assert.doesNotMatch(entry, /\bvalidateDiagnosis\s*:/)
    // 6C.6C.3A: o filtro de encerramento (T-K1.hang) vem antes; o diagnóstico continua antes do Grupo A.
    assert.match(entry, /const mode = plan\.parseFileLockArgs\(argv\) \?\? plan\.parseRepeatArgs\(argv\) \?\? plan\.parseLauncherTimeoutArgs\(argv\) \?\? plan\.parseTerminationArgs\(argv\) \?\? plan\.parseDiagnosisArgs\(argv\) \?\? plan\.parseSupervisorArgs\(argv\)/)
    assert.equal(count(entry, /battery\.runDiagnosis\(/), 1)
    assert.match(entry, /battery\.runDiagnosis\(\{ \.\.\.deps, stopRequested: \(\) => stop \}, mode\.variant\)/)
    assert.match(entry, /\} else if \(mode\.mode === 'diagnose'\) \{/)
    // Nenhuma variante padrão: a escolha vem só do argumento explícito.
    assert.doesNotMatch(entry, /'nowindow'|'detached'/)
    const b = code(read(ROOT, 'scripts', 'diagnostics', 'host-containment', 'battery.ts'))
    assert.doesNotMatch(b, /'nowindow'|'detached'/)
  })
})

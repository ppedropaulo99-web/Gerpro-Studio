import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  APPROVED_ARTIFACTS,
  casesFor,
  CENSUS_IMAGES,
  CONFIRM_RUN,
  evaluateCase,
  evaluateElectron,
  GROUP_A_CASES,
  GROUP_A_TESTS,
  parseSupervisorArgs,
  PRECONDITIONS,
  type CaseDefinition,
  type CaseObservation
} from '../../scripts/diagnostics/host-containment/plan'
import { censusArgs, censusScript, classifySurvivors, filetimeAtLeast, filetimeFromMs, parseCensus } from '../../scripts/diagnostics/host-containment/system-checks'
import { SCENARIOS, SYNTHETIC_HELPER_NAME, TEST_LAUNCHER_NAME } from '../../scripts/native/host-test-scenarios'

// Plano do Grupo A e verificações de sistema do supervisor (6C.6C.2A): só
// lógica pura. Nada é executado.

const ROOT = join(import.meta.dirname, '../..')
const byId = (id: string) => GROUP_A_CASES.find((c) => c.id === id)!
const observed = (o: Partial<CaseObservation> = {}): CaseObservation => ({
  exitCode: 0,
  stdout: '',
  stderrBytes: 0,
  exitMs: 40,
  closeMs: 45,
  deadlineHit: false,
  spawnError: null,
  ...o
})

describe('plano do Grupo A', () => {
  it('só testes do Grupo A, cada caso com prazo, esperado e pré-condições', () => {
    assert.deepEqual([...GROUP_A_TESTS], ['T-E1', 'T-H1', 'T-F5', 'T-R1', 'T-R2', 'T-R4', 'T-M1'])
    const ids = GROUP_A_CASES.map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const c of GROUP_A_CASES) {
      assert.ok(c.deadlineMs > 0 && c.deadlineMs <= 30_000, c.id)
      assert.ok(Number.isInteger(c.expectedExit), c.id)
      assert.notEqual(c.scenario, 'hang', `${c.id}: o hang é do Grupo B`)
      assert.ok(PRECONDITIONS[c.test].length > 0, c.id)
    }
    for (const t of GROUP_A_TESTS) assert.ok(GROUP_A_CASES.some((c) => c.test === t || c.alsoCovers?.includes(t)), t)
    assert.ok(PRECONDITIONS.common.length >= 5)
  })

  it('T-E1 cobre 20, 21, 23 e 24; T-H1, T-R2 e T-M1 esperam os códigos do roteiro', () => {
    const e1 = GROUP_A_CASES.filter((c) => c.test === 'T-E1')
    assert.deepEqual([...new Set(e1.map((c) => c.expectedExit))].sort(), [20, 21, 23, 24])
    assert.equal(byId('T-H1.exit-ok').expectedExit, 0)
    assert.equal(byId('T-H1.exit-contract').expectedExit, 12)
    assert.equal(byId('T-H1.exit-out-of-contract').expectedExit, 28)
    for (const s of SCENARIOS) {
      const c = GROUP_A_CASES.find((x) => x.scenario === s.id && x.args === 'standard' && x.layout === 'standard' && x.stdout === 'pipe')
      if (c) assert.equal(c.expectedExit, s.expectedHostExit, s.id)
    }
  })

  it('hashes aprovados = tabela da 6C.6C.1 (docs/11) e nomes = módulo de cenários', () => {
    const doc = readFileSync(join(ROOT, 'docs', '11-testes-contencao.md'), 'utf8')
    assert.ok(doc.includes(APPROVED_ARTIFACTS.launcher.sha256))
    for (const [id, a] of Object.entries(APPROVED_ARTIFACTS.scenarios)) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/)
      assert.ok(doc.includes(a.sha256), id)
    }
    assert.deepEqual(Object.keys(APPROVED_ARTIFACTS.scenarios), SCENARIOS.map((s) => s.id))
    assert.ok(CENSUS_IMAGES.includes(TEST_LAUNCHER_NAME) && CENSUS_IMAGES.includes(SYNTHETIC_HELPER_NAME))
    assert.ok(CENSUS_IMAGES.every((i) => !/dxcore|gerpro-helper-host\.exe/.test(i)))
  })

  it('casesFor respeita a seleção e a ordem', () => {
    assert.deepEqual(casesFor(['T-M1']).map((c) => c.id), ['T-M1.memory'])
    assert.equal(casesFor(GROUP_A_TESTS).length, GROUP_A_CASES.length)
  })
})

describe('argumentos do supervisor', () => {
  it('sem confirmação nada roda; só o Grupo A', () => {
    assert.deepEqual(parseSupervisorArgs([]), { mode: 'plan' })
    assert.deepEqual(parseSupervisorArgs(['--check-only']), { mode: 'check' })
    assert.equal(parseSupervisorArgs(['--group=A']).mode, 'usage-error')
    assert.equal(parseSupervisorArgs([CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseSupervisorArgs(['--group=B', CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseSupervisorArgs(['--check-only', CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseSupervisorArgs(['--group=A', CONFIRM_RUN, CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseSupervisorArgs(['--group=A', CONFIRM_RUN, '--repeat=3']).mode, 'usage-error')
    assert.deepEqual(parseSupervisorArgs(['--group=A', CONFIRM_RUN]), { mode: 'run', tests: GROUP_A_TESTS })
  })

  it('--only: só testes executáveis do Grupo A, sem repetição', () => {
    assert.deepEqual(parseSupervisorArgs(['--group=A', CONFIRM_RUN, '--only=T-E1,T-M1']), { mode: 'run', tests: ['T-E1', 'T-M1'] })
    for (const bad of ['T-T1', 'T-F5', 'T-R4', 'T-E1,T-E1', '', 'T-K1']) assert.equal(parseSupervisorArgs(['--group=A', CONFIRM_RUN, `--only=${bad}`]).mode, 'usage-error', bad)
  })
})

describe('avaliação dos casos', () => {
  const line = (s: string) => `gerpro-synthetic scenario=${s}\n`

  it('falha antes da retomada: código certo e nenhuma linha do alvo', () => {
    const c = byId('T-E1.extra-arg')
    assert.deepEqual(evaluateCase(c, observed({ exitCode: 20 })), { pass: true, notes: [] })
    const resumed = evaluateCase(c, observed({ exitCode: 20, stdout: line('exit-ok') }))
    assert.ok(!resumed.pass && resumed.reasons.some((r) => r.includes('retomado indevidamente')))
    assert.ok(!evaluateCase(c, observed({ exitCode: 23 })).pass)
  })

  it('T-H1/T-F5: linha do cenário, código, ordem e prazo do close', () => {
    const c = byId('T-H1.exit-ok')
    const ok = evaluateCase(c, observed({ stdout: line('exit-ok') }))
    assert.ok(ok.pass && ok.notes.some((n) => n.includes('H-F5')))
    assert.ok(!evaluateCase(c, observed({ exitCode: 25 })).pass)
    assert.ok(!evaluateCase(c, observed({ stdout: line('exit-contract') })).pass)
    assert.ok(!evaluateCase(c, observed({ stdout: line('exit-ok'), closeMs: 30, exitMs: 40 })).pass)
    assert.ok(!evaluateCase(c, observed({ stdout: line('exit-ok'), exitMs: 40, closeMs: 2_100 })).pass)
    assert.ok(!evaluateCase(c, observed({ stdout: line('exit-ok'), closeMs: null })).pass)
    assert.ok(!evaluateCase(c, observed({ stdout: `${line('exit-ok')}texto extra\n` })).pass)
    assert.ok(!evaluateCase(c, observed({ stdout: line('exit-ok'), stderrBytes: 1 })).pass)
    assert.ok(!evaluateCase(c, observed({ stdout: line('exit-ok'), deadlineHit: true })).pass)
  })

  it('T-R2/T-R4: os dois descendentes recusados; criado → reprovado', () => {
    const c = byId('T-R2.spawn-child')
    assert.ok(evaluateCase(c, observed({ stdout: 'gerpro-synthetic scenario=spawn-child plain=denied,error=5 breakaway=denied,error=5\n' })).pass)
    assert.ok(!evaluateCase(c, observed({ stdout: 'gerpro-synthetic scenario=spawn-child plain=created,in-job=1,ended=1 breakaway=denied,error=5\n' })).pass)
  })

  it('T-M1: picos coerentes com 64 MiB', () => {
    const c = byId('T-M1.memory')
    const m = 64 * 1024 * 1024
    assert.ok(evaluateCase(c, observed({ stdout: `gerpro-synthetic scenario=memory committed=${m} in-job=1 peak-process=${m + 4096} peak-job=${m + 8192}\n` })).pass)
    assert.ok(!evaluateCase(c, observed({ stdout: `gerpro-synthetic scenario=memory committed=${m} in-job=1 peak-process=${m - 1} peak-job=${m}\n` })).pass)
    assert.ok(!evaluateCase(c, observed({ stdout: `gerpro-synthetic scenario=memory committed=${m} in-job=0\n` })).pass)
  })

  it('T-R1: J pelo launcher é obrigatório; o job direto só é registrado', () => {
    const j = 'gerpro-synthetic scenario=job-probe in-job=1 limit-flags=0x2408 active-limit=1 active=1 total=1 peak-process=1 peak-job=1'
    const direct = 'gerpro-synthetic scenario=job-probe in-job=1 limit-flags=0x3c00 active-limit=0 active=2 total=9 peak-process=1 peak-job=1'
    const ok = evaluateElectron({ electronVersion: '45.0.0', direct: { exitCode: 0, line: direct }, viaLauncher: { exitCode: 0, line: j } })
    assert.ok(ok.pass && ok.notes[0]!.includes('0x3c00'))
    assert.ok(!evaluateElectron({ electronVersion: '45.0.0', direct: { exitCode: 0, line: direct }, viaLauncher: { exitCode: 0, line: direct } }).pass)
    assert.ok(!evaluateElectron({ electronVersion: '44.1.0', direct: { exitCode: 0, line: direct }, viaLauncher: { exitCode: 0, line: j } }).pass)
    assert.ok(!evaluateElectron({ electronVersion: '45.0.0', direct: null, viaLauncher: { exitCode: 0, line: j } }).pass)
  })

  it('todo caso do Node tem avaliação que reprova código diferente do esperado', () => {
    for (const c of GROUP_A_CASES.filter((x: CaseDefinition) => x.runner === 'node')) {
      assert.ok(!evaluateCase(c, observed({ exitCode: c.expectedExit + 1 })).pass, c.id)
    }
  })
})

describe('censo e sobreviventes', () => {
  it('script fixo, codificado, só com as imagens de teste', () => {
    const script = censusScript()
    for (const image of CENSUS_IMAGES) assert.ok(script.includes(`Name='${image}'`))
    assert.doesNotMatch(script, /Stop-Process|Kill|Terminate|Remove-|Set-/i)
    const args = censusArgs()
    assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    assert.equal(Buffer.from(args[5]!, 'base64').toString('utf16le'), script)
    assert.throws(() => censusScript(["x' OR Name='*"]))
  })

  it('leitura do censo: formato estrito e marca final', () => {
    assert.deepEqual(parseCensus('end\r\n'), [])
    assert.deepEqual(parseCensus('10|4|133000000000000000|C:\\T\\a.exe\r\n11|10|0|\r\nend'), [
      { pid: 10, ppid: 4, created: '133000000000000000', path: 'C:\\T\\a.exe' },
      { pid: 11, ppid: 10, created: '0', path: null }
    ])
    assert.equal(parseCensus('10|4|1|C:\\a.exe'), null)
    assert.equal(parseCensus('lixo\nend'), null)
    assert.equal(parseCensus(''), null)
  })

  it('só é "desta bateria" o processo com caminho copiado por ela e criado depois do início', () => {
    const start = filetimeFromMs(Date.UTC(2026, 10, 4))
    const later = filetimeFromMs(Date.UTC(2026, 10, 4, 0, 1))
    const earlier = filetimeFromMs(Date.UTC(2026, 10, 3))
    const owned = ['C:\\Tmp\\gerpro-6c6c-x\\01-a\\host-test\\win32-x64\\gerpro-synthetic-helper.exe']
    const plan = classifySurvivors(
      [
        { pid: 1, ppid: 0, created: later, path: owned[0]!.toUpperCase() },
        { pid: 2, ppid: 0, created: earlier, path: owned[0]! },
        { pid: 3, ppid: 0, created: later, path: 'C:\\outro\\gerpro-synthetic-helper.exe' },
        { pid: 4, ppid: 0, created: later, path: null },
        { pid: 5, ppid: 0, created: '0', path: owned[0]! }
      ],
      owned,
      start
    )
    assert.deepEqual(plan.owned.map((p) => p.pid), [1])
    assert.deepEqual(plan.foreign.map((p) => p.pid), [2, 3, 4, 5])
  })

  it('comparação de FILETIME em texto', () => {
    assert.ok(filetimeAtLeast('133000000000000001', '133000000000000000'))
    assert.ok(filetimeAtLeast('133000000000000000', '133000000000000000'))
    assert.ok(!filetimeAtLeast('99', '100'))
  })

  it('FILETIME a partir de milissegundos', () => {
    assert.equal(filetimeFromMs(0), '116444736000000000')
  })
})

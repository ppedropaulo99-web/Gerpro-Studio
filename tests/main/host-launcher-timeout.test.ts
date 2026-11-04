import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { BATTERY_EXIT, runLauncherTimeout, type BatteryDeps, type BatteryFs, type ChildRun, type RawRun } from '../../scripts/diagnostics/host-containment/battery'
import {
  APPROVED_ARTIFACTS,
  CHECK_ONLY,
  CONFIRM_RUN,
  EXIT_HOST_TIMEOUT,
  EXIT_HOST_UNCONFIRMED,
  evaluateLauncherTimeout,
  GROUP_A_CASES,
  GROUP_A_TESTS,
  HANG_READY_LINE,
  HANG_SELF_DEADLINE_MS,
  LAUNCHER_HELPER_WAIT_MS,
  LAUNCHER_TERMINATE_CONFIRM_MS,
  LAUNCHER_TIMEOUT_CASE,
  LAUNCHER_TIMEOUT_CASE_ID,
  LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS,
  LAUNCHER_TIMEOUT_FLAG,
  LAUNCHER_TIMEOUT_MAX_MS,
  LAUNCHER_TIMEOUT_MIN_MS,
  parseDiagnosisArgs,
  parseLauncherTimeoutArgs,
  parseSupervisorArgs,
  parseTerminationArgs,
  TERMINATION_READY_TIMEOUT_MS,
  type TerminationObservation
} from '../../scripts/diagnostics/host-containment/plan'
import { BATTERY_SCRATCH_PREFIX, type ProcessIdentity } from '../../scripts/diagnostics/host-containment/system-checks'

// Modo de prazo interno T-T1.hang (6C.6C.3B) com o sistema SIMULADO: nenhum
// processo é iniciado. Só a pasta exclusiva é real (raiz temporária do teste).

const ROOT = join(import.meta.dirname, '../..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

let tmpRoot: string
beforeEach(() => {
  tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'gerpro-launcher-timeout-test-')))
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

const fakeValidate = () => ({ set: { launcher: Buffer.from('launcher'), scenarios: new Map([['hang' as const, Buffer.from('alvo hang')]]) }, issues: [] as string[] })

const SELF_27: RawRun = { exitCode: 27, exitSignal: null, stdout: `${HANG_READY_LINE}\n`, stderrBytes: 0, exitMs: 2_260, closeMs: 2_262, spawnError: null }

interface Rec {
  spawns: Array<{ executable: string; args: readonly string[]; stdout: string }>
  kills: number
  logs: string[]
  lockReleased: number
  censusCalls: number
  deadlines: number[]
}

function deps(run: (rec: Rec) => ChildRun, overrides: Partial<BatteryDeps> = {}, census: () => ProcessIdentity[] | null = () => []): { d: BatteryDeps; rec: Rec } {
  const rec: Rec = { spawns: [], kills: 0, logs: [], lockReleased: 0, censusCalls: 0, deadlines: [] }
  const d: BatteryDeps = {
    platform: 'win32',
    arch: 'x64',
    tmpRoot,
    artifactsDir: join(tmpRoot, 'nao-usado'),
    fs,
    validate: fakeValidate,
    electronVersion: () => '45.0.0',
    integrityLevel: () => 'medium',
    census: () => {
      rec.censusCalls++
      return census()
    },
    acquireLock: () => 'acquired',
    releaseLock: () => {
      rec.lockReleased++
      return true
    },
    spawnLauncher(executable, args, stdout) {
      rec.spawns.push({ executable, args, stdout })
      return run(rec)
    },
    spawnElectron: () => {
      throw new Error('o modo de prazo interno nunca inicia o Electron')
    },
    electronCensus: () => [],
    electronImagePath: 'C:\\x\\electron.exe',
    now: () => Date.now(),
    sleep: async () => {},
    // Prazos nunca vencem, salvo quando o teste diz o contrário.
    deadline: (ms) => {
      rec.deadlines.push(ms)
      return { reached: new Promise<void>(() => {}), cancel: () => {} }
    },
    log: (line) => rec.logs.push(line),
    ...overrides
  }
  return { d, rec }
}

/** Launcher simulado que sai sozinho (prazo interno) com o resultado dado. */
const exitsAlone =
  (outcome: RawRun = SELF_27) =>
  (rec: Rec): ChildRun => {
    let resolveDone!: (r: RawRun) => void
    const done = new Promise<RawRun>((r) => (resolveDone = r))
    setTimeout(() => resolveDone(outcome), 5)
    return {
      pid: 5151,
      done,
      ready: () => Promise.resolve(250),
      kill: () => {
        rec.kills++
        return true
      }
    }
  }

const leftovers = () => readdirSync(tmpRoot).filter((n) => n.startsWith(BATTERY_SCRATCH_PREFIX))

// ── Filtro restrito ─────────────────────────────────────────────────────────

describe('modo de prazo interno: filtro restrito', () => {
  const T = `${LAUNCHER_TIMEOUT_FLAG}${LAUNCHER_TIMEOUT_CASE_ID}`
  it('aceita só T-T1.hang, com confirmação explícita ou só conferência', () => {
    assert.deepEqual(parseLauncherTimeoutArgs([T, CONFIRM_RUN]), { mode: 'launcher-timeout' })
    assert.deepEqual(parseLauncherTimeoutArgs([CONFIRM_RUN, T]), { mode: 'launcher-timeout' })
    assert.deepEqual(parseLauncherTimeoutArgs([T, CHECK_ONLY]), { mode: 'check-launcher-timeout' })
    assert.equal(parseLauncherTimeoutArgs([CONFIRM_RUN, '--group=A']), null)
  })
  for (const [label, argv] of [
    ['sem confirmação', [T]],
    ['outro caso', [`${LAUNCHER_TIMEOUT_FLAG}T-K1.hang`, CONFIRM_RUN]],
    ['outro cenário', [`${LAUNCHER_TIMEOUT_FLAG}T-T1.exit-ok`, CONFIRM_RUN]],
    ['minúsculas', [`${LAUNCHER_TIMEOUT_FLAG}t-t1.hang`, CONFIRM_RUN]],
    ['curinga', [`${LAUNCHER_TIMEOUT_FLAG}*`, CONFIRM_RUN]],
    ['lista', [`${LAUNCHER_TIMEOUT_FLAG}T-T1.hang,T-K1.hang`, CONFIRM_RUN]],
    ['vazio', [LAUNCHER_TIMEOUT_FLAG, CONFIRM_RUN]],
    ['repetido', [T, T, CONFIRM_RUN]],
    ['com conferência e execução', [T, CHECK_ONLY, CONFIRM_RUN]],
    ['com --group', [T, '--group=A', CONFIRM_RUN]],
    ['com --group=B', [T, '--group=B', CONFIRM_RUN]],
    ['com --only', [T, '--only=T-E1', CONFIRM_RUN]],
    ['com --diagnose', [T, '--diagnose=T-H1.exit-ok', '--diag-variant=detached', CONFIRM_RUN]],
    ['com --terminate', [T, '--terminate=T-K1.hang', CONFIRM_RUN]],
    ['com executável', [T, CONFIRM_RUN, 'C:\\x\\outro.exe']]
  ] as const) {
    it(`recusa: ${label}`, () => assert.equal(parseLauncherTimeoutArgs(argv)?.mode, 'usage-error'))
  }
  it('os outros modos não aceitam T-T1 nem --launcher-timeout', () => {
    assert.equal(parseSupervisorArgs([T, CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseSupervisorArgs(['--group=A', '--only=T-T1', CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseTerminationArgs(['--terminate=T-T1.hang', CONFIRM_RUN])?.mode, 'usage-error')
    assert.equal(parseTerminationArgs(['--terminate=T-K1.hang', T, CONFIRM_RUN])?.mode, 'usage-error')
    assert.equal(parseDiagnosisArgs(['--diagnose=T-T1.hang', '--diag-variant=detached', CONFIRM_RUN])?.mode, 'usage-error')
    assert.ok(!GROUP_A_TESTS.includes('T-T1'))
    assert.ok(GROUP_A_CASES.every((c) => c.test !== 'T-T1'))
  })
  it('a entrada usa o filtro e o roteiro próprios', () => {
    const entry = read('scripts', 'diagnostics', 'run-host-containment.mjs')
    assert.match(entry, /const mode = plan\.parseFileLockArgs\(argv\) \?\? plan\.parseRepeatArgs\(argv\) \?\? plan\.parseLauncherTimeoutArgs\(argv\) \?\? plan\.parseTerminationArgs\(argv\)/)
    assert.match(entry, /battery\.runLauncherTimeout\(deps\)/)
  })
})

// ── Caso e prazos ───────────────────────────────────────────────────────────

describe('modo de prazo interno: caso e prazos', () => {
  it('o caso é o alvo hang, montagem e argumentos padrão, código esperado 27', () => {
    assert.equal(LAUNCHER_TIMEOUT_CASE.scenario, 'hang')
    assert.equal(LAUNCHER_TIMEOUT_CASE.layout, 'standard')
    assert.equal(LAUNCHER_TIMEOUT_CASE.args, 'standard')
    assert.equal(LAUNCHER_TIMEOUT_CASE.expectedExit, 27)
  })
  it('prazos e códigos coerentes com os fontes C++', () => {
    const main = read('native', 'helper-host', 'src', 'main.cpp')
    const codes = read('native', 'helper-host', 'src', 'exit_codes.h')
    assert.match(main, new RegExp(`constexpr DWORD kHelperWaitMs = ${LAUNCHER_HELPER_WAIT_MS};`))
    assert.match(main, new RegExp(`constexpr DWORD kTerminateConfirmMs = ${LAUNCHER_TERMINATE_CONFIRM_MS};`))
    assert.match(codes, new RegExp(`constexpr int kExitHostTimeout = ${EXIT_HOST_TIMEOUT};`))
    assert.match(codes, new RegExp(`constexpr int kExitHostUnconfirmed = ${EXIT_HOST_UNCONFIRMED};`))
    // Prazo vencido: encerra J e devolve 27 só com o fim confirmado; senão 29.
    assert.match(main, /if \(wait == WAIT_TIMEOUT\) \{\n\s+return TerminateAndConfirm\(job\.get\(\), process\.get\(\), kExitHostTimeout\) \? kExitHostTimeout : kExitHostUnconfirmed;/)
    assert.match(main, /if \(!::TerminateJobObject\(job, code\)\) ::TerminateProcess\(process, code\);\n\s+return ::WaitForSingleObject\(process, kTerminateConfirmMs\) == WAIT_OBJECT_0;/)
  })
  it('o prazo externo é o mesmo do Grupo A e cobre o pior caso do launcher, com folga', () => {
    assert.equal(LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS, 5_000)
    assert.ok(GROUP_A_CASES.filter((c) => c.runner === 'node').every((c) => c.deadlineMs === LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS))
    const worst = TERMINATION_READY_TIMEOUT_MS + LAUNCHER_HELPER_WAIT_MS + 2 * LAUNCHER_TERMINATE_CONFIRM_MS
    assert.ok(LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS >= worst + 500, `${worst}`)
    assert.ok(LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS < HANG_SELF_DEADLINE_MS)
    assert.equal(LAUNCHER_TIMEOUT_MIN_MS, 1_500)
    assert.equal(LAUNCHER_TIMEOUT_MAX_MS, 3_000)
  })
})

// ── Avaliação ───────────────────────────────────────────────────────────────

const OK: TerminationObservation = {
  spawnError: null,
  pid: 5151,
  readyMs: 250,
  killRequestedMs: null,
  killAccepted: null,
  exitCode: 27,
  exitSignal: null,
  exitMs: 2_260,
  closeMs: 2_262,
  stdout: `${HANG_READY_LINE}\n`,
  stderrBytes: 0,
  censusAfter: 0
}

describe('modo de prazo interno: avaliação', () => {
  it('aprova o roteiro completo e separa pedido de observado', () => {
    const r = evaluateLauncherTimeout(OK)
    assert.equal(r.verdict.pass, true)
    const text = r.evidence.join('\n')
    assert.match(text, /alvo iniciado/)
    assert.match(text, /supervisor não interveio/)
    assert.match(text, /launcher saiu SOZINHO com 27 em 2260 ms: prazo interno de 2000 ms vencido, TerminateJobObject PEDIDO e fim do alvo CONFIRMADO pelo launcher/)
    assert.match(text, /tempo observado da linha até o exit: 2010 ms/)
    assert.match(text, /fim do alvo OBSERVADO pelo supervisor: close em 2262 ms \(2 ms depois do exit\)/)
    assert.match(text, /censo logo depois do close: 0/)
  })
  for (const [label, patch, reason] of [
    ['código 29', { exitCode: 29 }, /código 29: o launcher NÃO confirmou o fim do alvo/],
    ['código 0', { exitCode: 0 }, /código 0, esperado 27/],
    ['supervisor interveio', { killRequestedMs: 5_000, killAccepted: true }, /o supervisor precisou intervir/],
    ['encerrado por sinal', { exitCode: null, exitSignal: 'SIGTERM' }, /encerrado por sinal SIGTERM/],
    ['saiu cedo demais', { exitMs: 250 + LAUNCHER_TIMEOUT_MIN_MS - 1, closeMs: 250 + LAUNCHER_TIMEOUT_MIN_MS }, /esperado entre 1500 e 3000/],
    ['saiu tarde demais', { exitMs: 250 + LAUNCHER_TIMEOUT_MAX_MS + 1, closeMs: 250 + LAUNCHER_TIMEOUT_MAX_MS + 2 }, /esperado entre 1500 e 3000/],
    ['alvo não anunciou', { readyMs: null }, /não anunciou/],
    ['saída a mais', { stdout: `${HANG_READY_LINE}\nx\n` }, /saída padrão diferente/],
    ['exit ausente', { exitMs: null }, /exit do launcher não observado/],
    ['close ausente', { closeMs: null }, /close não chegou/],
    ['close tardio', { closeMs: 2_260 + 2_001 }, /close 2001 ms depois do exit/],
    ['sobrevivente', { censusAfter: 1 }, /1 processo/],
    ['censo indisponível', { censusAfter: null }, /indisponível/]
  ] as const) {
    it(`reprova: ${label}`, () => {
      const r = evaluateLauncherTimeout({ ...OK, ...patch })
      assert.equal(r.verdict.pass, false)
      if (!r.verdict.pass) assert.match(r.verdict.reasons.join('; '), reason)
    })
  }
})

// ── Execução simulada ───────────────────────────────────────────────────────

describe('modo de prazo interno: execução (simulada)', () => {
  it('uma execução: alvo hang, launcher sai sozinho com 27, nenhum encerramento pelo supervisor', async () => {
    const { d, rec } = deps(exitsAlone())
    const report = await runLauncherTimeout(d)
    assert.equal(report.exitCode, BATTERY_EXIT.ok, rec.logs.join('\n'))
    assert.equal(rec.spawns.length, 1)
    assert.equal(rec.kills, 0)
    assert.deepEqual(rec.spawns[0]!.args, ['--protocol', '1', '--helper-sha256', APPROVED_ARTIFACTS.scenarios.hang.sha256])
    assert.match(rec.spawns[0]!.executable, /\\01-T-T1\.hang\\host-test\\win32-x64\\gerpro-helper-host-test\.exe$/)
    assert.equal(report.results[0]!.status, 'pass')
    assert.equal(report.results[0]!.exitCode, 27)
    assert.ok(rec.deadlines.some((ms) => ms > 4_000 && ms <= LAUNCHER_TIMEOUT_EXTERNAL_DEADLINE_MS), `prazo externo: ${rec.deadlines.join(',')}`)
    assert.ok(rec.logs.some((l) => l.includes('nenhum encerramento pedido pelo supervisor')))
    assert.equal(report.cleanup?.removed, true)
    assert.equal(rec.lockReleased, 1)
    assert.ok(rec.censusCalls >= 3)
    assert.deepEqual(leftovers(), [])
  })

  it('código 29: reprovado, nenhum encerramento pelo supervisor', async () => {
    const { d, rec } = deps(exitsAlone({ ...SELF_27, exitCode: 29 }))
    const report = await runLauncherTimeout(d)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.kills, 0)
    assert.match(report.results[0]!.messages.join(';'), /código 29/)
  })

  it('prazo externo vencido: o supervisor encerra o launcher uma vez, pelo identificador, e o caso reprova', async () => {
    let resolveDone!: (r: RawRun) => void
    const { d, rec } = deps(
      (r) => ({
        pid: 6161,
        done: new Promise<RawRun>((res) => (resolveDone = res)),
        ready: () => Promise.resolve(250),
        kill: () => {
          r.kills++
          resolveDone({ ...SELF_27, exitCode: null, exitSignal: 'SIGTERM', exitMs: 5_001, closeMs: 5_003 })
          return true
        }
      }),
      { deadline: () => ({ reached: Promise.resolve(), cancel: () => {} }) }
    )
    const report = await runLauncherTimeout(d)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.kills, 1)
    assert.ok(rec.logs.some((l) => l.includes('o supervisor INTERVÉM')))
    assert.match(report.results[0]!.messages.join(';'), /precisou intervir/)
  })

  it('alvo que demora a anunciar: o supervisor NÃO encerra antes do prazo externo', async () => {
    const { d, rec } = deps((r) => {
      let resolveDone!: (x: RawRun) => void
      const done = new Promise<RawRun>((res) => (resolveDone = res))
      setTimeout(() => resolveDone(SELF_27), 5)
      return { pid: 1, done, ready: () => new Promise(() => {}), kill: () => (r.kills++, true) }
    })
    const report = await runLauncherTimeout(d)
    assert.equal(rec.kills, 0)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.match(report.results[0]!.messages.join(';'), /não anunciou/)
  })

  it('pré-condição falha ou trava ocupada: nada é iniciado', async () => {
    for (const o of [{ integrityLevel: () => 'high' as const }, { acquireLock: () => 'held' as const }]) {
      const { d, rec } = deps(exitsAlone(), o)
      const report = await runLauncherTimeout(d)
      assert.equal(report.exitCode, BATTERY_EXIT.precondition)
      assert.equal(rec.spawns.length, 0)
    }
  })
})

import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { BATTERY_EXIT, formatRepeatReport, runHangRepeat, type BatteryDeps, type BatteryFs, type ChildRun, type RawRun } from '../../scripts/diagnostics/host-containment/battery'
import {
  CHECK_ONLY,
  CONFIRM_RUN,
  HANG_READY_LINE,
  parseDiagnosisArgs,
  parseLauncherTimeoutArgs,
  parseRepeatArgs,
  parseSupervisorArgs,
  parseTerminationArgs,
  REPEAT_CASES,
  REPEAT_MAX_TIMES,
  TERMINATION_KILL_AFTER_READY_MS
} from '../../scripts/diagnostics/host-containment/plan'
import { BATTERY_SCRATCH_PREFIX, type ProcessIdentity } from '../../scripts/diagnostics/host-containment/system-checks'

// Modo de repetição (6C.6C.3C) com o sistema SIMULADO: nenhum processo é
// iniciado. Só as pastas exclusivas são reais (raiz temporária do teste).

const ROOT = join(import.meta.dirname, '../..')

let tmpRoot: string
beforeEach(() => {
  tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'gerpro-repeat-test-')))
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

const KILLED: RawRun = { exitCode: null, exitSignal: 'SIGTERM', stdout: `${HANG_READY_LINE}\n`, stderrBytes: 0, exitMs: 760, closeMs: 761, spawnError: null }
const SELF_27: RawRun = { exitCode: 27, exitSignal: null, stdout: `${HANG_READY_LINE}\n`, stderrBytes: 0, exitMs: 2_260, closeMs: 2_261, spawnError: null }

interface Rec {
  spawns: string[]
  kills: number
  active: number
  maxActive: number
  logs: string[]
}

/**
 * Launcher simulado pelo nome da pasta do caso: T-K1 só termina quando
 * encerrado; T-T1 sai sozinho. `t1Outcome` permite falhar uma rodada do T-T1.
 */
function deps(opts: { t1Outcome?: (n: number) => RawRun; census?: (rec: Rec) => ProcessIdentity[] | null; overrides?: Partial<BatteryDeps> } = {}) {
  const rec: Rec = { spawns: [], kills: 0, active: 0, maxActive: 0, logs: [] }
  let t1 = 0
  const track = (done: Promise<RawRun>) => {
    rec.active++
    rec.maxActive = Math.max(rec.maxActive, rec.active)
    done.then(() => rec.active--)
  }
  const d: BatteryDeps = {
    platform: 'win32',
    arch: 'x64',
    tmpRoot,
    artifactsDir: join(tmpRoot, 'nao-usado'),
    fs,
    validate: fakeValidate,
    electronVersion: () => '45.0.0',
    integrityLevel: () => 'medium',
    census: () => (opts.census ? opts.census(rec) : []),
    acquireLock: () => 'acquired',
    releaseLock: () => true,
    spawnLauncher(executable): ChildRun {
      rec.spawns.push(executable)
      let resolveDone!: (r: RawRun) => void
      const done = new Promise<RawRun>((r) => (resolveDone = r))
      track(done)
      if (executable.includes('T-K1.hang')) {
        return {
          pid: 100 + rec.spawns.length,
          done,
          ready: () => Promise.resolve(250),
          kill: () => {
            rec.kills++
            resolveDone(KILLED)
            return true
          }
        }
      }
      const outcome = opts.t1Outcome ? opts.t1Outcome(++t1) : SELF_27
      setTimeout(() => resolveDone(outcome), 2)
      return {
        pid: 200 + rec.spawns.length,
        done,
        ready: () => Promise.resolve(250),
        kill: () => {
          rec.kills++
          return true
        }
      }
    },
    spawnElectron: () => {
      throw new Error('o modo de repetição nunca inicia o Electron')
    },
    electronCensus: () => [],
    electronImagePath: 'C:\\x\\electron.exe',
    now: () => Date.now(),
    sleep: async () => {},
    // Só o prazo do supervisor no T-K1 (500 ms depois da linha) vence; os outros nunca.
    deadline: (ms) => ({ reached: ms === TERMINATION_KILL_AFTER_READY_MS ? Promise.resolve() : new Promise<void>(() => {}), cancel: () => {} }),
    log: (line) => rec.logs.push(line),
    ...opts.overrides
  }
  return { d, rec }
}

const PLAN = { cases: [...REPEAT_CASES], times: 10 }
const leftovers = () => readdirSync(tmpRoot).filter((n) => n.startsWith(BATTERY_SCRATCH_PREFIX))

// ── Filtro restrito ─────────────────────────────────────────────────────────

describe('modo de repetição: filtro restrito', () => {
  const R = '--repeat=T-K1.hang,T-T1.hang'
  it('aceita só T-K1.hang e T-T1.hang, de 1 a 10 vezes, com confirmação ou só conferência', () => {
    assert.deepEqual(parseRepeatArgs([R, '--times=10', CONFIRM_RUN]), { mode: 'repeat', plan: { cases: ['T-K1.hang', 'T-T1.hang'], times: 10 } })
    assert.deepEqual(parseRepeatArgs(['--repeat=T-T1.hang,T-K1.hang', '--times=3', CONFIRM_RUN]), { mode: 'repeat', plan: { cases: ['T-K1.hang', 'T-T1.hang'], times: 3 } })
    assert.deepEqual(parseRepeatArgs(['--repeat=T-T1.hang', '--times=1', CHECK_ONLY]), { mode: 'check-repeat', plan: { cases: ['T-T1.hang'], times: 1 } })
    assert.equal(REPEAT_MAX_TIMES, 10)
    assert.equal(parseRepeatArgs(['--group=A', CONFIRM_RUN]), null)
  })
  for (const [label, argv] of [
    ['sem confirmação', [R, '--times=10']],
    ['sem --times', [R, CONFIRM_RUN]],
    ['sem --repeat', ['--times=10', CONFIRM_RUN]],
    ['11 vezes', [R, '--times=11', CONFIRM_RUN]],
    ['0 vezes', [R, '--times=0', CONFIRM_RUN]],
    ['zero à esquerda', [R, '--times=05', CONFIRM_RUN]],
    ['número inválido', [R, '--times=dez', CONFIRM_RUN]],
    ['negativo', [R, '--times=-1', CONFIRM_RUN]],
    ['100 vezes', [R, '--times=100', CONFIRM_RUN]],
    ['outro caso', ['--repeat=T-K1.hang,T-E1', '--times=1', CONFIRM_RUN]],
    ['outro cenário', ['--repeat=T-T1.exit-ok', '--times=1', CONFIRM_RUN]],
    ['curinga', ['--repeat=*', '--times=1', CONFIRM_RUN]],
    ['minúsculas', ['--repeat=t-k1.hang', '--times=1', CONFIRM_RUN]],
    ['vazio', ['--repeat=', '--times=1', CONFIRM_RUN]],
    ['caso duplicado (passaria de 10)', ['--repeat=T-K1.hang,T-K1.hang', '--times=10', CONFIRM_RUN]],
    ['--repeat duas vezes', [R, R, '--times=1', CONFIRM_RUN]],
    ['--times duas vezes', [R, '--times=5', '--times=5', CONFIRM_RUN]],
    ['conferência e execução', [R, '--times=1', CHECK_ONLY, CONFIRM_RUN]],
    ['com --group', [R, '--times=1', '--group=A', CONFIRM_RUN]],
    ['com --only', [R, '--times=1', '--only=T-E1', CONFIRM_RUN]],
    ['com --terminate', [R, '--times=1', '--terminate=T-K1.hang', CONFIRM_RUN]],
    ['com --launcher-timeout', [R, '--times=1', '--launcher-timeout=T-T1.hang', CONFIRM_RUN]],
    ['com --diagnose', [R, '--times=1', '--diagnose=T-H1.exit-ok', '--diag-variant=detached', CONFIRM_RUN]],
    ['com executável', [R, '--times=1', CONFIRM_RUN, 'C:\\x\\outro.exe']]
  ] as const) {
    it(`recusa: ${label}`, () => assert.equal(parseRepeatArgs(argv)?.mode, 'usage-error'))
  }
  it('os outros modos não aceitam --repeat nem --times', () => {
    for (const argv of [['--repeat=T-K1.hang', CONFIRM_RUN], ['--times=10', '--group=A', CONFIRM_RUN]]) {
      assert.equal(parseSupervisorArgs(argv).mode, 'usage-error')
    }
    assert.equal(parseTerminationArgs(['--terminate=T-K1.hang', '--times=10', CONFIRM_RUN])?.mode, 'usage-error')
    assert.equal(parseLauncherTimeoutArgs(['--launcher-timeout=T-T1.hang', '--times=10', CONFIRM_RUN])?.mode, 'usage-error')
    assert.equal(parseDiagnosisArgs(['--diagnose=T-H1.exit-ok', '--diag-variant=detached', '--times=10', CONFIRM_RUN])?.mode, 'usage-error')
  })
  it('a entrada decide o filtro de repetição primeiro e usa o roteiro próprio', () => {
    const entry = readFileSync(join(ROOT, 'scripts', 'diagnostics', 'run-host-containment.mjs'), 'utf8')
    assert.match(entry, /const mode = plan\.parseFileLockArgs\(argv\) \?\? plan\.parseRepeatArgs\(argv\) \?\? plan\.parseLauncherTimeoutArgs\(argv\)/)
    assert.match(entry, /battery\.runHangRepeat\(\{ \.\.\.deps, stopRequested: \(\) => stop \}, mode\.plan\)/)
  })
})

// ── Execução simulada ───────────────────────────────────────────────────────

describe('modo de repetição: execução (simulada)', () => {
  it('lote completo: 10 × T-K1 e depois 10 × T-T1, em sequência, mesmos critérios', async () => {
    const { d, rec } = deps()
    const report = await runHangRepeat(d, PLAN)
    assert.equal(report.exitCode, BATTERY_EXIT.ok, rec.logs.join('\n'))
    assert.equal(rec.spawns.length, 20)
    assert.equal(rec.maxActive, 1, 'nunca dois launchers ao mesmo tempo')
    assert.equal(rec.kills, 10, 'só os 10 do T-K1, um cada')
    assert.deepEqual(
      report.rows.map((r) => r.id),
      [...Array(10).fill('T-K1.hang'), ...Array(10).fill('T-T1.hang')]
    )
    assert.ok(report.rows.every((r) => r.status === 'pass' && r.censusAfter === 0 && r.cleanup === true && r.lockReleased === true))
    assert.ok(report.rows.filter((r) => r.id === 'T-K1.hang').every((r) => r.supervisorKill && r.exitSignal === 'SIGTERM'))
    assert.ok(report.rows.filter((r) => r.id === 'T-T1.hang').every((r) => !r.supervisorKill && r.exitCode === 27))
    assert.equal(report.stoppedBy, null)
    assert.equal(report.finalCensus, 0)
    assert.deepEqual(leftovers(), [])
    const text = formatRepeatReport(report)
    assert.equal(text.split('\n').filter((l) => /^\s+\d+ \| T-[KT]1\.hang/.test(l)).length, 20)
    assert.match(text, /T-K1\.hang: 10 executada\(s\), 10 aprovada\(s\)/)
    assert.match(text, /T-T1\.hang: 10 executada\(s\), 10 aprovada\(s\)/)
    assert.match(text, /da linha até o exit: mín 2010, máx 2010, média 2010 ms/)
    assert.match(text, /interrupção: nenhuma/)
  })

  it('para na primeira falha (T-T1 com 29 na rodada 2), sem nova tentativa', async () => {
    const { d, rec } = deps({ t1Outcome: (n) => (n === 2 ? { ...SELF_27, exitCode: 29 } : SELF_27) })
    const report = await runHangRepeat(d, PLAN)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.spawns.length, 12)
    assert.equal(report.rows.length, 12)
    assert.equal(report.rows.at(-1)!.status, 'fail')
    assert.match(report.stoppedBy!, /execução 12 \(T-T1\.hang, 2\/10\) não aprovada: .*código 29/)
    assert.deepEqual(leftovers(), [])
  })

  it('sobrevivente depois de uma execução: lote interrompido, nada encerrado pelo supervisor além do launcher', async () => {
    let calls = 0
    const { d, rec } = deps({
      // Pré-condição da 1ª execução: 0; logo depois da 1ª: 1 sobrevivente.
      census: () => (++calls === 2 ? [{ pid: 9, ppid: 101, created: '999999999999999999', path: 'C:\\x\\gerpro-synthetic-helper.exe' }] : [])
    })
    const report = await runHangRepeat(d, PLAN)
    assert.equal(report.exitCode, BATTERY_EXIT.survivors)
    assert.equal(rec.spawns.length, 1)
    assert.equal(rec.kills, 1)
  })

  it('pasta exclusiva residual antes de uma execução: nada é iniciado', async () => {
    mkdirSync(join(tmpRoot, `${BATTERY_SCRATCH_PREFIX}antiga`))
    const { d, rec } = deps()
    const report = await runHangRepeat(d, PLAN)
    assert.equal(report.exitCode, BATTERY_EXIT.precondition)
    assert.equal(rec.spawns.length, 0)
    assert.match(report.stoppedBy!, /residual antes da execução 1/)
  })

  it('trava ocupada: a execução não começa e o lote para', async () => {
    const { d, rec } = deps({ overrides: { acquireLock: () => 'held' } })
    const report = await runHangRepeat(d, PLAN)
    assert.equal(report.exitCode, BATTERY_EXIT.precondition)
    assert.equal(rec.spawns.length, 0)
    assert.equal(report.rows[0]!.status, 'not-run')
  })

  it('interrupção pedida: nenhuma execução nova começa', async () => {
    let n = 0
    const { d, rec } = deps({ overrides: { stopRequested: () => ++n > 3 } })
    const report = await runHangRepeat(d, PLAN)
    assert.equal(report.exitCode, BATTERY_EXIT.interrupted)
    assert.equal(rec.spawns.length, 3)
  })
})

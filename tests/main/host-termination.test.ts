import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  BATTERY_EXIT,
  runTermination,
  validateTerminationArtifacts,
  type BatteryDeps,
  type BatteryFs,
  type ChildRun,
  type RawRun
} from '../../scripts/diagnostics/host-containment/battery'
import {
  APPROVED_ARTIFACTS,
  CHECK_ONLY,
  CONFIRM_RUN,
  evaluateTermination,
  GROUP_A_CASES,
  GROUP_A_TESTS,
  HANG_READY_LINE,
  HANG_SELF_DEADLINE_MS,
  LAUNCHER_HELPER_WAIT_MS,
  parseDiagnosisArgs,
  parseSupervisorArgs,
  parseTerminationArgs,
  TERMINATE_FLAG,
  TERMINATION_CASE,
  TERMINATION_CASE_ID,
  TERMINATION_CLOSE_AFTER_KILL_MS,
  TERMINATION_KILL_AFTER_READY_MS,
  TERMINATION_READY_TIMEOUT_MS,
  type TerminationObservation
} from '../../scripts/diagnostics/host-containment/plan'
import { BATTERY_SCRATCH_PREFIX, type ProcessIdentity } from '../../scripts/diagnostics/host-containment/system-checks'

// Modo de encerramento T-K1.hang (6C.6C.3A) com o sistema SIMULADO: nenhum
// processo é iniciado. Só a pasta exclusiva é real (raiz temporária do teste).

const ROOT = join(import.meta.dirname, '../..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

let tmpRoot: string
beforeEach(() => {
  tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'gerpro-termination-test-')))
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

const KILLED: RawRun = { exitCode: null, exitSignal: 'SIGTERM', stdout: `${HANG_READY_LINE}\n`, stderrBytes: 0, exitMs: 700, closeMs: 712, spawnError: null }

interface Rec {
  spawns: Array<{ executable: string; args: readonly string[]; stdout: string }>
  kills: number
  logs: string[]
  lockReleased: number
  censusCalls: number
}

/** `run` recebe o registro para contar os encerramentos pedidos. */
function deps(run: (rec: Rec) => ChildRun, overrides: Partial<BatteryDeps> = {}, census: () => ProcessIdentity[] | null = () => []): { d: BatteryDeps; rec: Rec } {
  const rec: Rec = { spawns: [], kills: 0, logs: [], lockReleased: 0, censusCalls: 0 }
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
      throw new Error('o modo de encerramento nunca inicia o Electron')
    },
    electronCensus: () => [],
    electronImagePath: 'C:\\x\\electron.exe',
    now: () => Date.now(),
    sleep: async () => {},
    // Prazos vencem na hora: a ordem dos eventos decide o resultado.
    deadline: () => ({ reached: Promise.resolve(), cancel: () => {} }),
    log: (line) => rec.logs.push(line),
    ...overrides
  }
  return { d, rec }
}

/** Launcher simulado que só termina quando o supervisor o encerra. */
const hangUntilKilled =
  (outcome: RawRun = KILLED, readyMs: number | null = 210) =>
  (rec: Rec): ChildRun => {
    let resolveDone!: (r: RawRun) => void
    const done = new Promise<RawRun>((r) => (resolveDone = r))
    return {
      pid: 4242,
      done,
      ready: () => (readyMs === null ? new Promise(() => {}) : Promise.resolve(readyMs)),
      kill: () => {
        rec.kills++
        resolveDone(outcome)
        return true
      }
    }
  }

const leftovers = () => readdirSync(tmpRoot).filter((n) => n.startsWith(BATTERY_SCRATCH_PREFIX))

// ── Filtro restrito ─────────────────────────────────────────────────────────

describe('modo de encerramento: filtro restrito', () => {
  const T = `${TERMINATE_FLAG}${TERMINATION_CASE_ID}`
  it('aceita só T-K1.hang, com confirmação explícita ou só conferência', () => {
    assert.deepEqual(parseTerminationArgs([T, CONFIRM_RUN]), { mode: 'terminate' })
    assert.deepEqual(parseTerminationArgs([CONFIRM_RUN, T]), { mode: 'terminate' })
    assert.deepEqual(parseTerminationArgs([T, CHECK_ONLY]), { mode: 'check-terminate' })
    assert.equal(parseTerminationArgs([CONFIRM_RUN, '--group=A']), null)
  })
  for (const [label, argv] of [
    ['sem confirmação', [T]],
    ['outro caso', [`${TERMINATE_FLAG}T-T1.hang`, CONFIRM_RUN]],
    ['outro cenário', [`${TERMINATE_FLAG}T-K1.exit-ok`, CONFIRM_RUN]],
    ['minúsculas', [`${TERMINATE_FLAG}t-k1.hang`, CONFIRM_RUN]],
    ['curinga', [`${TERMINATE_FLAG}*`, CONFIRM_RUN]],
    ['lista', [`${TERMINATE_FLAG}T-K1.hang,T-K1.hang`, CONFIRM_RUN]],
    ['vazio', [TERMINATE_FLAG, CONFIRM_RUN]],
    ['repetido', [T, T, CONFIRM_RUN]],
    ['com conferência e execução', [T, CHECK_ONLY, CONFIRM_RUN]],
    ['com --group', [T, '--group=A', CONFIRM_RUN]],
    ['com --group=B', [T, '--group=B', CONFIRM_RUN]],
    ['com --only', [T, '--only=T-E1', CONFIRM_RUN]],
    ['com --diagnose', [T, '--diagnose=T-H1.exit-ok', '--diag-variant=detached', CONFIRM_RUN]],
    ['com executável', [T, CONFIRM_RUN, 'C:\\x\\outro.exe']],
    ['com --helper', [T, CONFIRM_RUN, '--helper=x']]
  ] as const) {
    it(`recusa: ${label}`, () => assert.equal(parseTerminationArgs(argv)?.mode, 'usage-error'))
  }
  it('o Grupo A e o diagnóstico não aceitam --terminate nem o caso hang', () => {
    assert.equal(parseSupervisorArgs([T, CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseSupervisorArgs(['--group=B', CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseSupervisorArgs(['--group=A', '--only=T-K1', CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseDiagnosisArgs(['--diagnose=T-K1.hang', '--diag-variant=detached', CONFIRM_RUN])?.mode, 'usage-error')
    assert.ok(!GROUP_A_TESTS.includes('T-K1'))
    assert.ok(GROUP_A_CASES.every((c) => c.scenario !== 'hang' && c.test !== 'T-K1'))
  })
  it('a entrada decide os filtros restritos (prazo interno, encerramento) antes dos outros', () => {
    const entry = read('scripts', 'diagnostics', 'run-host-containment.mjs')
    assert.match(entry, /const mode = plan\.parseFileLockArgs\(argv\) \?\? plan\.parseRepeatArgs\(argv\) \?\? plan\.parseLauncherTimeoutArgs\(argv\) \?\? plan\.parseTerminationArgs\(argv\) \?\? plan\.parseDiagnosisArgs\(argv\) \?\? plan\.parseSupervisorArgs\(argv\)/)
    assert.match(entry, /battery\.runTermination\(deps\)/)
    assert.match(entry, /battery\.validateTerminationArtifacts/)
  })
})

// ── Caso e prazos ───────────────────────────────────────────────────────────

describe('modo de encerramento: caso e prazos', () => {
  it('o caso é o alvo hang com montagem e argumentos padrão, pelo launcher de testes', () => {
    assert.equal(TERMINATION_CASE.scenario, 'hang')
    assert.equal(TERMINATION_CASE.runner, 'node')
    assert.equal(TERMINATION_CASE.layout, 'standard')
    assert.equal(TERMINATION_CASE.args, 'standard')
    assert.equal(TERMINATION_CASE.stdout, 'pipe')
  })
  it('prazos coerentes com os fontes: o supervisor encerra antes do prazo interno do launcher', () => {
    const main = read('native', 'helper-host', 'src', 'main.cpp')
    const synthetic = read('native', 'helper-host', 'test-artifacts', 'synthetic_helper.cpp')
    assert.match(main, new RegExp(`constexpr DWORD kHelperWaitMs = ${LAUNCHER_HELPER_WAIT_MS};`))
    assert.match(synthetic, new RegExp(`constexpr DWORD kSelfDeadlineMs = ${HANG_SELF_DEADLINE_MS};`))
    assert.ok(synthetic.includes(`Append("${HANG_READY_LINE}");`))
    // A linha sai depois da retomada, logo o prazo interno começa antes dela: sobra no mínimo 1 s.
    assert.ok(TERMINATION_KILL_AFTER_READY_MS + 1_000 <= LAUNCHER_HELPER_WAIT_MS)
    assert.ok(TERMINATION_READY_TIMEOUT_MS + TERMINATION_KILL_AFTER_READY_MS + TERMINATION_CLOSE_AFTER_KILL_MS < HANG_SELF_DEADLINE_MS)
  })
  it('o launcher cria J com KILL_ON_JOB_CLOSE e só retoma o alvo depois de IsProcessInJob', () => {
    const main = read('native', 'helper-host', 'src', 'main.cpp')
    assert.match(main, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/)
    assert.ok(main.indexOf('::IsProcessInJob(') < main.indexOf('::ResumeThread('))
  })
})

// ── Avaliação ───────────────────────────────────────────────────────────────

const OK: TerminationObservation = {
  spawnError: null,
  pid: 4242,
  readyMs: 210,
  killRequestedMs: 712,
  killAccepted: true,
  exitCode: null,
  exitSignal: 'SIGTERM',
  exitMs: 715,
  closeMs: 730,
  stdout: `${HANG_READY_LINE}\n`,
  stderrBytes: 0,
  censusAfter: 0
}

describe('modo de encerramento: avaliação', () => {
  it('aprova o roteiro completo e separa pedido de observado', () => {
    const r = evaluateTermination(OK)
    assert.equal(r.verdict.pass, true)
    const text = r.evidence.join('\n')
    assert.match(text, /alvo iniciado/)
    assert.match(text, /encerramento PEDIDO em 712 ms \(502 ms depois da linha; prazo configurado 500 ms\), pelo identificador do processo iniciado \(PID 4242\)/)
    assert.match(text, /encerramento do launcher OBSERVADO: exit em 715 ms/)
    assert.match(text, /encerramento do alvo OBSERVADO: close em 730 ms/)
    assert.match(text, /censo logo depois do close: 0/)
  })
  for (const [label, patch, reason] of [
    ['alvo não anunciou', { readyMs: null }, /não anunciou/],
    ['saída a mais', { stdout: `${HANG_READY_LINE}\nx\n` }, /saída padrão diferente/],
    ['saída de erro', { stderrBytes: 3 }, /saída de erro/],
    ['sem pedido', { killRequestedMs: null, killAccepted: null }, /não pediu/],
    ['pedido não aceito', { killAccepted: false }, /não aceito/],
    ['launcher saiu sozinho com 27', { exitCode: 27, exitSignal: null, exitMs: 600 }, /saiu sozinho/],
    ['fim com código próprio', { exitCode: 27, exitSignal: null }, /diferente do encerramento pedido/],
    ['exit não observado', { exitMs: null }, /exit do launcher não observado/],
    ['close ausente', { closeMs: null }, /close não chegou/],
    ['close tardio', { closeMs: 712 + TERMINATION_CLOSE_AFTER_KILL_MS + 1 }, /close \d+ ms depois do pedido/],
    ['close antes do exit', { closeMs: 714 }, /close antes do exit/],
    ['sobrevivente', { censusAfter: 1 }, /1 processo/],
    ['censo indisponível', { censusAfter: null }, /indisponível/],
    ['erro ao iniciar', { spawnError: 'ENOENT' }, /não iniciou/]
  ] as const) {
    it(`reprova: ${label}`, () => {
      const r = evaluateTermination({ ...OK, ...patch })
      assert.equal(r.verdict.pass, false)
      if (!r.verdict.pass) assert.match(r.verdict.reasons.join('; '), reason)
    })
  }
})

// ── Execução simulada ───────────────────────────────────────────────────────

describe('modo de encerramento: execução (simulada)', () => {
  it('uma execução: alvo hang, encerramento único pelo identificador, censos, limpeza', async () => {
    const { d, rec } = deps(hangUntilKilled())
    const report = await runTermination(d)
    assert.equal(report.exitCode, BATTERY_EXIT.ok, rec.logs.join('\n'))
    assert.equal(rec.spawns.length, 1)
    assert.equal(rec.kills, 1)
    assert.deepEqual(rec.spawns[0]!.args, ['--protocol', '1', '--helper-sha256', APPROVED_ARTIFACTS.scenarios.hang.sha256])
    assert.equal(rec.spawns[0]!.stdout, 'pipe')
    assert.match(rec.spawns[0]!.executable, /\\01-T-K1\.hang\\host-test\\win32-x64\\gerpro-helper-host-test\.exe$/)
    assert.equal(report.results.length, 1)
    assert.equal(report.results[0]!.status, 'pass')
    assert.equal(report.termination?.verdict.pass, true)
    assert.equal(report.cleanup?.removed, true)
    assert.equal(rec.lockReleased, 1)
    assert.ok(rec.censusCalls >= 3, 'pré-condição, logo depois e final')
    assert.ok(rec.logs.some((l) => /encerramento do launcher PEDIDO em \d+ ms, pelo identificador do processo iniciado \(PID 4242\): aceito/.test(l)))
    assert.ok(rec.logs.some((l) => l.includes('censo logo depois do encerramento: 0')))
    assert.ok(rec.logs.some((l) => l === 'Censo final: 0.'))
    assert.deepEqual(leftovers(), [])
  })

  it('launcher que sai sozinho (27): nenhum encerramento pedido, reprovado', async () => {
    const { d, rec } = deps(() => ({
      pid: 1,
      done: Promise.resolve({ exitCode: 27, exitSignal: null, stdout: `${HANG_READY_LINE}\n`, stderrBytes: 0, exitMs: 2_300, closeMs: 2_310, spawnError: null }),
      ready: () => new Promise(() => {}),
      kill: () => {
        throw new Error('não pode encerrar um processo que já terminou')
      }
    }))
    const report = await runTermination(d)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.kills, 0)
    assert.ok(rec.logs.some((l) => l.includes('terminou sozinho')))
    assert.deepEqual(leftovers(), [])
  })

  it('alvo que não anuncia: o launcher iniciado é encerrado uma vez e o caso reprova', async () => {
    const { d, rec } = deps(hangUntilKilled(KILLED, null))
    const report = await runTermination(d)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.kills, 1)
    assert.match(report.results[0]!.messages.join(';'), /não anunciou/)
  })

  it('close que não chega: situação incerta, sobrevivente registrado e NUNCA encerrado', async () => {
    const created = '999999999999999999'
    let after = false
    const { d, rec } = deps(
      (r) => ({
        pid: 7,
        done: new Promise<RawRun>(() => {}),
        ready: () => Promise.resolve(200),
        kill: () => {
          r.kills++
          after = true
          return true
        }
      }),
      {},
      () => (after ? [{ pid: 8, ppid: 7, created, path: 'C:\\x\\gerpro-synthetic-helper.exe' }] : [])
    )
    const report = await runTermination(d)
    assert.equal(report.exitCode, BATTERY_EXIT.survivors)
    assert.equal(rec.kills, 1, 'só o launcher iniciado, uma vez')
    assert.ok(rec.logs.some((l) => l.includes('close NÃO chegou')))
    assert.ok(rec.logs.some((l) => /PID 8 .*NÃO encerrado|PID 8, imagem .*não tocado/.test(l)))
  })

  it('pré-condição falha: nada é iniciado', async () => {
    const { d, rec } = deps(hangUntilKilled(), { integrityLevel: () => 'high' })
    const report = await runTermination(d)
    assert.equal(report.exitCode, BATTERY_EXIT.precondition)
    assert.equal(rec.spawns.length, 0)
  })

  it('trava ocupada: nada é iniciado', async () => {
    const { d, rec } = deps(hangUntilKilled(), { acquireLock: () => 'held' })
    const report = await runTermination(d)
    assert.equal(report.exitCode, BATTERY_EXIT.precondition)
    assert.equal(rec.spawns.length, 0)
  })

  it('a conferência dos artefatos lê só o launcher de testes, o alvo hang e o manifesto', () => {
    const seen: string[] = []
    validateTerminationArtifacts({ readFile: (p) => (seen.push(p), Buffer.alloc(0)) }, 'C:\\a')
    assert.deepEqual(seen.map((p) => p.replace('C:\\a\\', '')), ['gerpro-helper-host-test.exe', 'scenarios\\hang\\gerpro-synthetic-helper.exe', 'test-manifest.json'])
  })
})

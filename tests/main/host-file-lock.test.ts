import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { BATTERY_EXIT, runFileLock, type BatteryDeps, type BatteryFs, type ChildRun, type RawRun } from '../../scripts/diagnostics/host-containment/battery'
import {
  APPROVED_ARTIFACTS,
  CHECK_ONLY,
  CONFIRM_RUN,
  evaluateFileLock,
  FILE_LOCK_CASE,
  FILE_LOCK_CASE_ID,
  FILE_LOCK_FLAG,
  GROUP_A_CASES,
  GROUP_A_TESTS,
  H_F3_EXPECTED_CODE,
  HANG_READY_LINE,
  LAUNCHER_TIMEOUT_CASE,
  parseDiagnosisArgs,
  parseFileLockArgs,
  parseLauncherTimeoutArgs,
  parseRepeatArgs,
  parseSupervisorArgs,
  parseTerminationArgs,
  type FileLockObservation,
  type WriteAttempt
} from '../../scripts/diagnostics/host-containment/plan'
import { BATTERY_SCRATCH_PREFIX } from '../../scripts/diagnostics/host-containment/system-checks'

// Modo T-F3.hang (6C.6C.3E) com o sistema SIMULADO: nenhum processo é
// iniciado e nenhum arquivo é aberto para escrita. Só a pasta exclusiva é real.

const ROOT = join(import.meta.dirname, '../..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const H = APPROVED_ARTIFACTS.scenarios.hang

let tmpRoot: string
beforeEach(() => {
  tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'gerpro-file-lock-test-')))
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

/** Bytes cujo SHA-256 não é o aprovado: a simulação substitui o hash pela leitura falsa abaixo. */
const fakeValidate = () => ({ set: { launcher: Buffer.from('launcher'), scenarios: new Map([['hang' as const, Buffer.from('alvo hang')]]) }, issues: [] as string[] })

const SELF_27: RawRun = { exitCode: 27, exitSignal: null, stdout: `${HANG_READY_LINE}\n`, stderrBytes: 0, exitMs: 2_280, closeMs: 2_281, spawnError: null }
const REFUSED: WriteAttempt = { opened: false, code: 'EBUSY', errno: -4082 }

interface Rec {
  spawns: number
  kills: number
  probes: string[]
  facts: string[]
  logs: string[]
}

function deps(opts: { attempt?: WriteAttempt; facts?: ReturnType<NonNullable<BatteryDeps['fileFacts']>>; outcome?: RawRun; readHelper?: (n: number) => Buffer; overrides?: Partial<BatteryDeps> } = {}) {
  const rec: Rec = { spawns: 0, kills: 0, probes: [], facts: [], logs: [] }
  let helperReads = 0
  const d: BatteryDeps = {
    platform: 'win32',
    arch: 'x64',
    tmpRoot,
    artifactsDir: join(tmpRoot, 'nao-usado'),
    // A cópia do alvo é lida pelo hash: a simulação devolve bytes com o hash aprovado só pelo caminho do alvo.
    fs: {
      ...fs,
      readFile: (path) => {
        if (path.endsWith('\\gerpro-synthetic-helper.exe') && opts.readHelper) return opts.readHelper(++helperReads)
        return fs.readFile(path)
      }
    },
    validate: fakeValidate,
    electronVersion: () => '45.0.0',
    integrityLevel: () => 'medium',
    census: () => [],
    acquireLock: () => 'acquired',
    releaseLock: () => true,
    spawnLauncher(): ChildRun {
      rec.spawns++
      let resolveDone!: (r: RawRun) => void
      const done = new Promise<RawRun>((r) => (resolveDone = r))
      setTimeout(() => resolveDone(opts.outcome ?? SELF_27), 5)
      return {
        pid: 7070,
        done,
        ready: () => Promise.resolve(260),
        kill: () => {
          rec.kills++
          return true
        }
      }
    },
    spawnElectron: () => {
      throw new Error('nunca')
    },
    electronCensus: () => [],
    electronImagePath: 'C:\\x\\electron.exe',
    now: () => Date.now(),
    sleep: async () => {},
    deadline: () => ({ reached: new Promise<void>(() => {}), cancel: () => {} }),
    log: (line) => rec.logs.push(line),
    fileFacts: (path) => {
      rec.facts.push(path)
      return opts.facts ?? { exists: true, regularFile: true, size: H.size, readOnlyAttribute: false }
    },
    probeWriteOpen: (path) => {
      rec.probes.push(path)
      return opts.attempt ?? REFUSED
    },
    ...opts.overrides
  }
  return { d, rec }
}

/** Leitura simulada da cópia com o hash aprovado (não temos os bytes reais aqui). */
const approvedBytes = (): Buffer => {
  const real = join(ROOT, 'native', 'helper-host', 'build', 'test', 'x64', 'scenarios', 'hang', 'gerpro-synthetic-helper.exe')
  try {
    return readFileSync(real)
  } catch {
    return Buffer.alloc(0)
  }
}
const haveRealHang = (() => {
  try {
    readFileSync(join(ROOT, 'native', 'helper-host', 'build', 'test', 'x64', 'scenarios', 'hang', 'gerpro-synthetic-helper.exe'))
    return true
  } catch {
    return false
  }
})()

const leftovers = () => readdirSync(tmpRoot).filter((n) => n.startsWith(BATTERY_SCRATCH_PREFIX))

// ── Filtro restrito ─────────────────────────────────────────────────────────

describe('modo T-F3: filtro restrito', () => {
  const F = `${FILE_LOCK_FLAG}${FILE_LOCK_CASE_ID}`
  it('aceita só T-F3.hang, com confirmação explícita ou só conferência', () => {
    assert.deepEqual(parseFileLockArgs([F, CONFIRM_RUN]), { mode: 'file-lock', caseId: FILE_LOCK_CASE_ID })
    assert.deepEqual(parseFileLockArgs([CONFIRM_RUN, F]), { mode: 'file-lock', caseId: FILE_LOCK_CASE_ID })
    assert.deepEqual(parseFileLockArgs([F, CHECK_ONLY]), { mode: 'check-file-lock', caseId: FILE_LOCK_CASE_ID })
    assert.equal(parseFileLockArgs([CONFIRM_RUN, '--group=A']), null)
  })
  for (const [label, argv] of [
    ['sem confirmação', [F]],
    ['T-F1', [`${FILE_LOCK_FLAG}T-F1`, CONFIRM_RUN]],
    ['T-F2', [`${FILE_LOCK_FLAG}T-F2.exit-ok`, CONFIRM_RUN]],
    ['T-F4', [`${FILE_LOCK_FLAG}T-F4`, CONFIRM_RUN]],
    ['outro cenário', [`${FILE_LOCK_FLAG}T-F3.exit-ok`, CONFIRM_RUN]],
    ['minúsculas', [`${FILE_LOCK_FLAG}t-f3.hang`, CONFIRM_RUN]],
    ['curinga', [`${FILE_LOCK_FLAG}*`, CONFIRM_RUN]],
    ['lista', [`${FILE_LOCK_FLAG}T-F3.hang,T-F1`, CONFIRM_RUN]],
    ['vazio', [FILE_LOCK_FLAG, CONFIRM_RUN]],
    ['repetido', [F, F, CONFIRM_RUN]],
    ['conferência e execução', [F, CHECK_ONLY, CONFIRM_RUN]],
    ['com --group', [F, '--group=A', CONFIRM_RUN]],
    ['com --only', [F, '--only=T-E1', CONFIRM_RUN]],
    ['com --diagnose', [F, '--diagnose=T-H1.exit-ok', '--diag-variant=detached', CONFIRM_RUN]],
    ['com --terminate', [F, '--terminate=T-K1.hang', CONFIRM_RUN]],
    ['com --launcher-timeout', [F, '--launcher-timeout=T-T1.hang', CONFIRM_RUN]],
    ['com --repeat', [F, '--repeat=T-K1.hang', '--times=1', CONFIRM_RUN]],
    ['com caminho', [F, CONFIRM_RUN, 'C:\\x\\alvo.exe']],
    ['com --path', [F, '--path=C:\\x', CONFIRM_RUN]]
  ] as const) {
    it(`recusa: ${label}`, () => assert.equal(parseFileLockArgs(argv)?.mode, 'usage-error'))
  }
  it('os outros modos não aceitam T-F3 nem --file-lock', () => {
    assert.equal(parseSupervisorArgs([F, CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseSupervisorArgs(['--group=A', '--only=T-F3', CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseTerminationArgs(['--terminate=T-K1.hang', F, CONFIRM_RUN])?.mode, 'usage-error')
    assert.equal(parseLauncherTimeoutArgs(['--launcher-timeout=T-T1.hang', F, CONFIRM_RUN])?.mode, 'usage-error')
    assert.equal(parseRepeatArgs(['--repeat=T-F3.hang', '--times=1', CONFIRM_RUN])?.mode, 'usage-error')
    assert.equal(parseDiagnosisArgs(['--diagnose=T-F3.hang', '--diag-variant=detached', CONFIRM_RUN])?.mode, 'usage-error')
    assert.ok(!GROUP_A_TESTS.includes('T-F3'))
    assert.ok(GROUP_A_CASES.every((c) => c.test !== 'T-F3'))
  })
  it('o caso é o T-T1 com outra identificação (mesmo alvo, prazos e código 27)', () => {
    assert.equal(FILE_LOCK_CASE.scenario, 'hang')
    assert.equal(FILE_LOCK_CASE.expectedExit, 27)
    assert.equal(FILE_LOCK_CASE.deadlineMs, LAUNCHER_TIMEOUT_CASE.deadlineMs)
    assert.equal(FILE_LOCK_CASE.layout, 'standard')
    assert.equal(FILE_LOCK_CASE.args, 'standard')
  })
})

// ── Fontes: a tentativa nunca escreve ───────────────────────────────────────

describe('modo T-F3: fontes', () => {
  const entry = read('scripts', 'diagnostics', 'run-host-containment.mjs')
  it('a entrada decide o filtro T-F3 primeiro e usa o roteiro próprio', () => {
    assert.match(entry, /const mode = plan\.parseFileLockArgs\(argv\) \?\? plan\.parseRepeatArgs\(argv\)/)
    assert.match(entry, /battery\.runFileLock\(deps\)/)
  })
  it('uma única abertura para escrita (r+), fechada no finally; nenhuma escrita, truncamento, renomeação ou exclusão', () => {
    const start = entry.indexOf('  probeWriteOpen(path) {')
    const body = entry.slice(start, entry.indexOf('\n  }', start))
    assert.equal([...entry.matchAll(/'r\+'/g)].length, 1)
    assert.match(body, /assertProbeTarget\(path\)/)
    assert.match(body, /fd = openSync\(path, 'r\+'\)/)
    assert.match(body, /finally \{\n\s+if \(fd !== null\) closeSync\(fd\)/)
    assert.doesNotMatch(body, /renameSync|unlinkSync/)
    assert.doesNotMatch(entry, /writeSync|ftruncate|truncateSync|appendFileSync|chmodSync|utimesSync/)
    // 6C.6C.3G: renomeação e exclusão existem só nas tentativas guardadas do T-F1/T-F4 (host-lock-holder.test.ts).
    assert.equal([...entry.matchAll(/renameSync\(/g)].length, 1)
    assert.equal([...entry.matchAll(/unlinkSync\(/g)].length, 3, 'trava da bateria, remoção da pasta exclusiva (D55) e a exclusão guardada do T-F1')
  })
  it('o alvo da tentativa é só a cópia do alvo sintético dentro de uma pasta exclusiva da bateria', () => {
    assert.match(entry, /function assertProbeTarget\(path\)/)
    assert.match(entry, /join\(tmpRoot, checks\.BATTERY_SCRATCH_PREFIX\)/)
    assert.match(entry, /endsWith\(`\\\\\$\{plan\.SYNTHETIC_HELPER_NAME\}`\)/)
    assert.match(entry, /fileFacts\(path\) \{\n\s+assertProbeTarget\(path\)/)
  })
  it('o launcher fecha a trava do arquivo antes da retomada (a recusa só pode vir da imagem)', () => {
    const main = read('native', 'helper-host', 'src', 'main.cpp')
    assert.ok(main.indexOf('helperFile.Close();') < main.indexOf('::ResumeThread('))
  })
})

// ── Avaliação ───────────────────────────────────────────────────────────────

const OK: FileLockObservation = {
  spawnError: null,
  pid: 7070,
  readyMs: 260,
  killRequestedMs: null,
  killAccepted: null,
  exitCode: 27,
  exitSignal: null,
  exitMs: 2_280,
  closeMs: 2_281,
  stdout: `${HANG_READY_LINE}\n`,
  stderrBytes: 0,
  censusAfter: 0,
  attemptMs: 268,
  launcherAliveAtAttempt: true,
  target: { exists: true, regularFile: true, size: H.size, readOnlyAttribute: false, insideScratch: true },
  attempt: REFUSED,
  hashBefore: H.sha256,
  hashAfterAttempt: H.sha256,
  hashAfterRun: H.sha256
}

describe('modo T-F3: avaliação', () => {
  it('aprova: recusa EBUSY com o alvo rodando, conteúdo íntegro e os critérios do T-T1', () => {
    const r = evaluateFileLock(OK)
    assert.equal(r.verdict.pass, true)
    const text = r.evidence.join('\n')
    assert.match(text, /tentativa em 268 ms \(8 ms depois da linha do alvo\), com o launcher ativo/)
    assert.match(text, /abertura para escrita RECUSADA: EBUSY \(errno -4082\)/)
    assert.match(text, /conteúdo do alvo idêntico ao aprovado/)
    assert.match(text, /launcher saiu SOZINHO com 27/)
    assert.equal(H_F3_EXPECTED_CODE, 'EBUSY')
  })
  for (const [label, patch, reason] of [
    ['abertura permitida', { attempt: { opened: true, code: null, errno: null } }, /H-F3 REFUTADA/],
    ['recusa por permissão (EPERM)', { attempt: { opened: false, code: 'EPERM', errno: -4048 } }, /EPERM .*não confirma o H-F3/],
    ['recusa por acesso (EACCES)', { attempt: { opened: false, code: 'EACCES', errno: -4092 } }, /não confirma o H-F3/],
    ['arquivo ausente (ENOENT)', { attempt: { opened: false, code: 'ENOENT', errno: -4058 } }, /não confirma o H-F3/],
    ['arquivo ausente na conferência', { target: { ...OK.target!, exists: false } }, /ausente/],
    ['não é arquivo comum', { target: { ...OK.target!, regularFile: false } }, /não é arquivo comum/],
    ['tamanho diferente', { target: { ...OK.target!, size: 1 } }, /tamanho do alvo 1/],
    ['somente leitura', { target: { ...OK.target!, readOnlyAttribute: true } }, /somente leitura/],
    ['atributo desconhecido', { target: { ...OK.target!, readOnlyAttribute: null } }, /somente leitura presente ou desconhecido/],
    ['fora da pasta exclusiva', { target: { ...OK.target!, insideScratch: false } }, /fora da pasta exclusiva/],
    ['sem conferência', { target: null }, /não conferido/],
    ['sem tentativa', { attempt: null, attemptMs: null }, /não foi feita/],
    ['launcher já tinha saído', { launcherAliveAtAttempt: false }, /não estava ativo/],
    ['tentativa depois do exit', { attemptMs: 2_300 }, /depois do fim do launcher/],
    ['hash antes diferente', { hashBefore: 'x' }, /antes da tentativa/],
    ['hash depois da tentativa diferente', { hashAfterAttempt: null }, /logo depois/],
    ['hash no fim diferente', { hashAfterRun: 'y' }, /depois do fim do launcher/],
    ['código 29', { exitCode: 29 }, /código 29/],
    ['supervisor interveio', { killRequestedMs: 5_000, killAccepted: true }, /precisou intervir/],
    ['sobrevivente', { censusAfter: 1 }, /1 processo/]
  ] as const) {
    it(`reprova: ${label}`, () => {
      const r = evaluateFileLock({ ...OK, ...patch } as FileLockObservation)
      assert.equal(r.verdict.pass, false)
      if (!r.verdict.pass) assert.match(r.verdict.reasons.join('; '), reason)
    })
  }
})

// ── Execução simulada ───────────────────────────────────────────────────────

describe('modo T-F3: execução (simulada)', () => {
  it('uma tentativa, na cópia do alvo dentro da pasta do caso, com o launcher ativo; sem intervenção', async (t) => {
    if (!haveRealHang) return t.skip('alvo hang compilado ausente (hash simulado indisponível)')
    const bytes = approvedBytes()
    // A cópia gravada na pasta do caso é o alvo hang compilado: o hash dela é o aprovado.
    const { d, rec } = deps({ overrides: { validate: () => ({ set: { launcher: Buffer.from('launcher'), scenarios: new Map([['hang' as const, bytes]]) }, issues: [] }) } })
    const report = await runFileLock(d)
    assert.equal(report.exitCode, BATTERY_EXIT.ok, rec.logs.join('\n'))
    assert.equal(rec.spawns, 1)
    assert.equal(rec.kills, 0)
    assert.equal(rec.probes.length, 1)
    assert.match(rec.probes[0]!, /\\gerpro-6c6c-[^\\]+\\01-T-F3\.hang\\host-test\\win32-x64\\gerpro-synthetic-helper\.exe$/)
    assert.deepEqual(rec.facts, rec.probes)
    assert.equal(report.results[0]!.status, 'pass')
    assert.equal(report.results[0]!.exitCode, 27)
    assert.ok(rec.logs.some((l) => /tentativa de abrir o alvo para escrita em \d+ ms: recusada \(EBUSY, errno -4082\)/.test(l)))
    assert.deepEqual(leftovers(), [])
  })

  it('abertura permitida: reprovado, sem nova tentativa, sem intervenção', async () => {
    const { d, rec } = deps({ attempt: { opened: true, code: null, errno: null } })
    const report = await runFileLock(d)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.probes.length, 1)
    assert.equal(rec.kills, 0)
    assert.match(report.results[0]!.messages.join(';'), /H-F3 REFUTADA/)
  })

  it('launcher que já saiu quando a linha chega: nenhuma tentativa', async () => {
    const { d, rec } = deps({ overrides: { spawnLauncher: () => ({ pid: 1, done: Promise.resolve(SELF_27), ready: () => Promise.resolve(260), kill: () => true }) } })
    const report = await runFileLock(d)
    assert.equal(rec.probes.length, 0)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
  })

  it('alvo que não anuncia: nenhuma tentativa', async () => {
    const { d, rec } = deps({
      overrides: {
        spawnLauncher: () => {
          let resolveDone!: (r: RawRun) => void
          const done = new Promise<RawRun>((r) => (resolveDone = r))
          setTimeout(() => resolveDone(SELF_27), 5)
          return { pid: 1, done, ready: () => new Promise(() => {}), kill: () => true }
        }
      }
    })
    const report = await runFileLock(d)
    assert.equal(rec.probes.length, 0)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
  })

  it('pré-condição falha: nada é iniciado nem tentado', async () => {
    const { d, rec } = deps({ overrides: { integrityLevel: () => 'high' } })
    const report = await runFileLock(d)
    assert.equal(report.exitCode, BATTERY_EXIT.precondition)
    assert.equal(rec.spawns, 0)
    assert.equal(rec.probes.length, 0)
  })
})

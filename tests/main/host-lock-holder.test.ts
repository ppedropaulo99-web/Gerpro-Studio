import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  BATTERY_EXIT,
  checkLockHolderPreconditions,
  lockHolderIssues,
  runLockHolderCase,
  validateLockHolderArtifacts,
  type BatteryDeps,
  type BatteryFs,
  type ChildRun,
  type RawRun
} from '../../scripts/diagnostics/host-containment/battery'
import {
  ATTEMPTS,
  CASE_REL,
  caseLayout,
  checkIdentity,
  evaluateLockHolder,
  holderImageAllowed,
  identityAllowed,
  LOCK_HOLDER_CASES,
  LOCK_HOLDER_EXPECTED_CODE,
  LOCK_HOLDER_KILL_CLOSE_MS,
  LOCK_HOLDER_READY_TIMEOUT_MS,
  LOCK_HOLDER_RELEASE_TIMEOUT_MS,
  LOCK_HOLDER_SELF_DEADLINE_MS,
  lockHolderArgs,
  lockHolderBaseIssues,
  lockHolderEnv,
  parseReadyLine,
  parseReleasedLine,
  renameAllowed,
  splitCasePath,
  unlinkAllowed,
  type FsAttempt,
  type FsIdentity,
  type LockHolderObservation,
  type ReadySignal
} from '../../scripts/diagnostics/host-containment/lock-holder'
import {
  APPROVED_ARTIFACTS,
  CENSUS_IMAGES,
  CHECK_ONLY,
  CONFIRM_RUN,
  FILE_LOCK_FLAG,
  GROUP_A_CASES,
  GROUP_A_TESTS,
  LOCK_HOLDER_NAME,
  parseDiagnosisArgs,
  parseFileLockArgs,
  parseLauncherTimeoutArgs,
  parseRepeatArgs,
  parseSupervisorArgs,
  parseTerminationArgs,
  type LockHolderCaseId
} from '../../scripts/diagnostics/host-containment/plan'
import { BATTERY_SCRATCH_PREFIX, censusScript } from '../../scripts/diagnostics/host-containment/system-checks'

// Integração do segurador de travas ao supervisor (6C.6C.3G): T-F1.exit-ok e
// T-F4.exit-ok com o segurador SIMULADO. Nenhum processo é iniciado; o
// gerpro-lock-holder-test.exe nunca é executado (só os bytes são lidos e
// copiados). Só a pasta temporária do teste é real.

const ROOT = join(import.meta.dirname, '../..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const TEST_BUILD = join(ROOT, 'native', 'helper-host', 'build', 'test', 'x64')
const HOLDER_BUILD = join(ROOT, 'native', 'lock-holder-test', 'build', 'x64')
const HOLDER_BINARY = join(HOLDER_BUILD, LOCK_HOLDER_NAME)
const EXIT_OK = APPROVED_ARTIFACTS.scenarios['exit-ok']
/** Os bytes reais existem (build local, fora do git): sem eles, a execução simulada é pulada. */
const haveBuilds = [HOLDER_BINARY, join(HOLDER_BUILD, 'lock-holder-manifest.json'), join(TEST_BUILD, 'gerpro-helper-host-test.exe'), join(TEST_BUILD, 'test-manifest.json'), join(TEST_BUILD, 'scenarios', 'exit-ok', 'gerpro-synthetic-helper.exe')].every(existsSync)
const needBuilds = { skip: haveBuilds ? false : 'builds locais do segurador ou do exit-ok ausentes' }

let tmpRoot: string
beforeEach(() => {
  tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'gerpro-lh-test-')))
})
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const realFs: BatteryFs = {
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

/** Mesma leitura de identidade da entrada (lstat bigint). */
function realIdentity(path: string): FsIdentity | null {
  try {
    const st = lstatSync(path, { bigint: true })
    return { dev: st.dev, ino: st.ino, nlink: st.nlink, kind: st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other' }
  } catch {
    return null
  }
}
const hex = (v: bigint, digits: number) => v.toString(16).padStart(digits, '0')
/** Linha de prontidão que o segurador real escreveria para os objetos da pasta do caso. */
function realReadyLine(mode: 'file' | 'directory', caseDir: string): string {
  const l = caseLayout(caseDir)
  const ids = (mode === 'file' ? [l.file] : [l.top, l.arch]).map((p) => realIdentity(p)!)
  return `gerpro-lock-holder-test v=1 ready mode=${mode} volume=${hex(ids[0]!.dev & 0xffff_ffffn, 8)} index=${ids.map((i) => hex(i.ino, 16)).join(',')}`
}
const caseDirFromArgs = (args: readonly string[]) => args.find((a) => a.startsWith('--case-dir='))!.slice('--case-dir='.length)

const REFUSED: FsAttempt = { succeeded: false, code: 'EBUSY', errno: -4082 }
const attemptFs = (op: () => void): FsAttempt => {
  try {
    op()
    return { succeeded: true, code: null, errno: null }
  } catch (error) {
    return { succeeded: false, code: (error as { code?: string }).code ?? 'erro', errno: null }
  }
}

interface Rec {
  events: string[]
  spawns: Array<{ executable: string; args: readonly string[]; cwd: string }>
  kills: number
  closes: number
  attempts: Array<{ kind: string; paths: string[] }>
  logs: string[]
}

interface HolderOpts {
  /** `never`: a prontidão não chega. */
  ready?: 'real' | 'never' | ((caseDir: string) => string)
  /** O segurador sai logo depois da prontidão (antes do pedido de liberação). */
  exitAfterReady?: boolean
  /** Resposta ao fechamento da entrada: `hang` = não sai. */
  release?: 'stdin' | 'deadline' | 'hang' | 'no-line'
  exitCodeOnRelease?: number
  stderrBytes?: number
}

interface Opts {
  holder?: HolderOpts
  /** Prazos (ms) que vencem nesta simulação (os outros nunca vencem). */
  fire?: number[]
  probes?: { open?: FsAttempt | 'real'; rename?: FsAttempt | 'real'; unlink?: FsAttempt | 'real' }
  census?: (call: number) => ReturnType<BatteryDeps['census']>
  overrides?: Partial<BatteryDeps>
  fs?: Partial<BatteryFs>
}

function deps(opts: Opts = {}) {
  const rec: Rec = { events: [], spawns: [], kills: 0, closes: 0, attempts: [], logs: [] }
  let censusCalls = 0
  const h = opts.holder ?? {}
  const fs: BatteryFs = {
    ...realFs,
    readFile: (path) => {
      if (path.endsWith(`\\${CASE_REL.holder}`)) rec.events.push('verify-holder-copy')
      return realFs.readFile(path)
    },
    ...opts.fs
  }
  const d: BatteryDeps = {
    platform: 'win32',
    arch: 'x64',
    tmpRoot,
    artifactsDir: TEST_BUILD,
    lockHolderDir: HOLDER_BUILD,
    fs,
    electronVersion: () => '45.0.0',
    integrityLevel: () => 'medium',
    census: () => {
      censusCalls++
      rec.events.push('census')
      return opts.census ? opts.census(censusCalls) : []
    },
    acquireLock: () => {
      rec.events.push('acquire-lock')
      return 'acquired'
    },
    releaseLock: () => {
      rec.events.push('release-lock')
      return true
    },
    spawnLauncher: () => {
      throw new Error('o launcher nunca é iniciado no T-F1/T-F4')
    },
    spawnElectron: () => {
      throw new Error('nunca')
    },
    electronCensus: () => [],
    electronImagePath: 'C:\\x\\electron.exe',
    now: () => Date.now(),
    sleep: async () => {},
    deadline: (ms) => ({ reached: opts.fire?.includes(ms) ? new Promise<void>((r) => setTimeout(r, 20)) : new Promise<void>(() => {}), cancel: () => {} }),
    log: (line) => rec.logs.push(line),
    spawnLockHolder(executable, args, cwd): ChildRun {
      rec.events.push('spawn')
      rec.spawns.push({ executable, args, cwd })
      const t0 = Date.now()
      let stdout = ''
      let finished = false
      let resolveDone!: (r: RawRun) => void
      const done = new Promise<RawRun>((r) => (resolveDone = r))
      const waiters: Array<{ test: (l: string) => boolean; resolve: (v: { ms: number; line: string } | null) => void }> = []
      const emit = (line: string) => {
        stdout += `${line}\n`
        for (const w of waiters.splice(0)) {
          if (w.test(line)) w.resolve({ ms: Date.now() - t0, line })
          else waiters.push(w)
        }
      }
      const finish = (exitCode: number | null, exitSignal: string | null = null) => {
        if (finished) return
        finished = true
        const ms = Date.now() - t0
        for (const w of waiters.splice(0)) w.resolve(null)
        resolveDone({ exitCode, exitSignal, stdout, stderrBytes: h.stderrBytes ?? 0, exitMs: ms, closeMs: ms, spawnError: null })
      }
      const caseDir = caseDirFromArgs(args)
      const mode = args[0] === '--mode=file' ? 'file' : 'directory'
      setTimeout(() => {
        const ready = h.ready ?? 'real'
        if (ready === 'never') return
        emit(ready === 'real' ? realReadyLine(mode, caseDir) : ready(caseDir))
        // Sai no mesmo instante: o supervisor já vê o fim antes da primeira tentativa.
        if (h.exitAfterReady) finish(0)
      }, 2)
      return {
        pid: 4242,
        done,
        matchLine: (test) => new Promise((resolve) => (finished ? resolve(null) : waiters.push({ test, resolve }))),
        closeStdin: () => {
          rec.events.push('close-stdin')
          rec.closes++
          const release = h.release ?? 'stdin'
          if (release !== 'hang')
            setTimeout(() => {
              if (release !== 'no-line') emit(`gerpro-lock-holder-test v=1 released reason=${release}`)
              finish(h.exitCodeOnRelease ?? (release === 'deadline' ? 45 : 0))
            }, 2)
          return true
        },
        kill: () => {
          rec.events.push('kill')
          rec.kills++
          setTimeout(() => finish(null, 'SIGTERM'), 1)
          return true
        }
      }
    },
    statIdentity: (path) => {
      rec.events.push('stat')
      return realIdentity(path)
    },
    probeWriteOpen: (path) => {
      rec.events.push('attempt:open-rw')
      rec.attempts.push({ kind: 'open-rw', paths: [path] })
      const p = opts.probes?.open ?? REFUSED
      if (p === 'real') return { opened: true, code: null, errno: null }
      return { opened: p.succeeded, code: p.code, errno: p.errno }
    },
    probeRename: (from, to) => {
      rec.events.push(`attempt:rename:${win32.basename(from)}`)
      rec.attempts.push({ kind: 'rename', paths: [from, to] })
      const p = opts.probes?.rename ?? REFUSED
      return p === 'real' ? attemptFs(() => renameSync(from, to)) : p
    },
    probeUnlink: (path) => {
      rec.events.push('attempt:unlink')
      rec.attempts.push({ kind: 'unlink', paths: [path] })
      const p = opts.probes?.unlink ?? REFUSED
      return p === 'real' ? attemptFs(() => unlinkSync(path)) : p
    },
    ...opts.overrides
  }
  return { d, rec }
}

const leftovers = () => readdirSync(tmpRoot).filter((n) => n.startsWith(BATTERY_SCRATCH_PREFIX))
/** `events` contém `expected` nesta ordem (subsequência). */
function assertOrder(events: readonly string[], expected: readonly string[]) {
  let at = -1
  for (const e of expected) {
    const next = events.indexOf(e, at + 1)
    assert.ok(next > at, `"${e}" fora de ordem em: ${events.join(' → ')}`)
    at = next
  }
}

// ── Filtro restrito ─────────────────────────────────────────────────────────

describe('segurador: filtro restrito (--file-lock)', () => {
  const F1 = `${FILE_LOCK_FLAG}T-F1.exit-ok`
  const F4 = `${FILE_LOCK_FLAG}T-F4.exit-ok`
  it('aceita T-F1.exit-ok e T-F4.exit-ok, um por vez, com confirmação explícita ou só conferência', () => {
    assert.deepEqual(parseFileLockArgs([F1, CONFIRM_RUN]), { mode: 'file-lock', caseId: 'T-F1.exit-ok' })
    assert.deepEqual(parseFileLockArgs([CONFIRM_RUN, F4]), { mode: 'file-lock', caseId: 'T-F4.exit-ok' })
    assert.deepEqual(parseFileLockArgs([F1, CHECK_ONLY]), { mode: 'check-file-lock', caseId: 'T-F1.exit-ok' })
    assert.deepEqual(parseFileLockArgs([F4, CHECK_ONLY]), { mode: 'check-file-lock', caseId: 'T-F4.exit-ok' })
  })
  for (const [label, argv] of [
    ['sem confirmação', [F1]],
    ['T-F2', [`${FILE_LOCK_FLAG}T-F2.exit-ok`, CONFIRM_RUN]],
    ['T-F2 (mapping)', [`${FILE_LOCK_FLAG}T-F2.mapping`, CONFIRM_RUN]],
    ['T-F1 sem cenário', [`${FILE_LOCK_FLAG}T-F1`, CONFIRM_RUN]],
    ['T-F4 com outro cenário', [`${FILE_LOCK_FLAG}T-F4.hang`, CONFIRM_RUN]],
    ['T-F1 com outro cenário', [`${FILE_LOCK_FLAG}T-F1.exit-contract`, CONFIRM_RUN]],
    ['minúsculas', [`${FILE_LOCK_FLAG}t-f1.exit-ok`, CONFIRM_RUN]],
    ['espaço', [`${FILE_LOCK_FLAG}T-F1.exit-ok `, CONFIRM_RUN]],
    ['curinga', [`${FILE_LOCK_FLAG}*`, CONFIRM_RUN]],
    ['curinga parcial', [`${FILE_LOCK_FLAG}T-F*.exit-ok`, CONFIRM_RUN]],
    ['lista', [`${FILE_LOCK_FLAG}T-F1.exit-ok,T-F4.exit-ok`, CONFIRM_RUN]],
    ['lista com T-F3', [`${FILE_LOCK_FLAG}T-F3.hang,T-F1.exit-ok`, CONFIRM_RUN]],
    ['dois casos em argumentos separados', [F1, F4, CONFIRM_RUN]],
    ['repetido', [F1, F1, CONFIRM_RUN]],
    ['conferência e execução', [F1, CHECK_ONLY, CONFIRM_RUN]],
    ['executável arbitrário', [F1, CONFIRM_RUN, 'C:\\Windows\\System32\\cmd.exe']],
    ['caminho do segurador', [`${FILE_LOCK_FLAG}C:\\x\\${LOCK_HOLDER_NAME}`, CONFIRM_RUN]],
    ['caminho externo', [F1, '--case-dir=C:\\Users', CONFIRM_RUN]],
    ['--path', [F4, '--path=C:\\x', CONFIRM_RUN]],
    ['com --group', [F1, '--group=A', CONFIRM_RUN]],
    ['com --only', [F1, '--only=T-E1', CONFIRM_RUN]],
    ['com --diagnose', [F1, '--diagnose=T-H1.exit-ok', '--diag-variant=detached', CONFIRM_RUN]],
    ['com --terminate', [F4, '--terminate=T-K1.hang', CONFIRM_RUN]],
    ['com --launcher-timeout', [F4, '--launcher-timeout=T-T1.hang', CONFIRM_RUN]],
    ['com --repeat', [F1, '--repeat=T-K1.hang', '--times=1', CONFIRM_RUN]],
    ['repetição automática (--times)', [F1, '--times=2', CONFIRM_RUN]]
  ] as const) {
    it(`recusa: ${label}`, () => assert.equal(parseFileLockArgs(argv)?.mode, 'usage-error'))
  }
  it('os outros modos não aceitam T-F1 nem T-F4', () => {
    assert.equal(parseSupervisorArgs(['--group=A', '--only=T-F1', CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseSupervisorArgs(['--group=A', '--only=T-F4', CONFIRM_RUN]).mode, 'usage-error')
    assert.equal(parseTerminationArgs(['--terminate=T-F1.exit-ok', CONFIRM_RUN])?.mode, 'usage-error')
    assert.equal(parseLauncherTimeoutArgs(['--launcher-timeout=T-F4.exit-ok', CONFIRM_RUN])?.mode, 'usage-error')
    assert.equal(parseRepeatArgs(['--repeat=T-F1.exit-ok', '--times=1', CONFIRM_RUN])?.mode, 'usage-error')
    assert.equal(parseDiagnosisArgs(['--diagnose=T-F4.exit-ok', '--diag-variant=detached', CONFIRM_RUN])?.mode, 'usage-error')
    assert.ok(!GROUP_A_TESTS.includes('T-F1') && !GROUP_A_TESTS.includes('T-F4'))
    assert.ok(GROUP_A_CASES.every((c) => c.test !== 'T-F1' && c.test !== 'T-F4'))
  })
})

// ── Artefato aprovado ───────────────────────────────────────────────────────

describe('segurador: artefato aprovado e integridade', () => {
  it('registrado com o SHA-256 e o tamanho aprovados na 6C.6C.3F', () => {
    assert.deepEqual({ ...APPROVED_ARTIFACTS.lockHolder }, { size: 114_176, sha256: '74a99a07290c9850b13de7cb10a35893fe8e53755a59b91f4a15ac6db5e359e0' })
    assert.ok(Object.isFrozen(APPROVED_ARTIFACTS.lockHolder))
  })
  it('hashes de produção inalterados (continuam nulos)', () => {
    assert.match(read('src', 'main', 'hardware', 'local', 'bundled-helper.ts'), /DXCORE_HELPER_SHA256: Readonly<Record<'x64' \| 'arm64', string \| null>> = Object\.freeze\(\{ x64: null, arm64: null \}\)/)
    assert.match(read('src', 'main', 'hardware', 'local', 'dxcore-host-contract.ts'), /DXCORE_HOST_SHA256: Readonly<Record<'x64' \| 'arm64', string \| null>> = Object\.freeze\(\{ x64: null, arm64: null \}\)/)
  })
  it('a imagem do segurador entra no censo', () => {
    assert.ok(CENSUS_IMAGES.includes(LOCK_HOLDER_NAME))
    assert.match(censusScript(), new RegExp(`Name='${LOCK_HOLDER_NAME}'`))
  })
  it('binário local (se existir): tamanho, SHA-256, PE e identidade aprovados; 1 byte a mais é recusado', { skip: existsSync(HOLDER_BINARY) ? false : 'binário ausente' }, () => {
    const bytes = readFileSync(HOLDER_BINARY)
    assert.deepEqual(lockHolderIssues(bytes), [])
    assert.ok(lockHolderIssues(Buffer.concat([bytes, Buffer.from([0])])).length > 0)
    const flipped = Buffer.from(bytes)
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff
    assert.match(lockHolderIssues(flipped).join(';'), /SHA-256 diferente/)
  })
  it('bytes que não são o segurador: recusados por hash e por PE', () => {
    const issues = lockHolderIssues(Buffer.alloc(APPROVED_ARTIFACTS.lockHolder.size))
    assert.match(issues.join(';'), /tamanho ou SHA-256 diferente/)
    assert.match(issues.join(';'), /PE ou identidade fora da política/)
  })
  it('validação: pasta do build não informada, binário ausente ou manifesto diferente são recusados', () => {
    const fakeFs = { readFile: (p: string) => (p.endsWith('lock-holder-manifest.json') ? Buffer.from(JSON.stringify({ sha256: 'x', size: 1 })) : realFs.readFile(p)) }
    assert.match(validateLockHolderArtifacts(realFs, TEST_BUILD, undefined).issues.join(';'), /pasta do build não informada/)
    assert.match(validateLockHolderArtifacts(realFs, TEST_BUILD, join(tmpRoot, 'vazio')).issues.join(';'), /não lido/)
    assert.equal(validateLockHolderArtifacts(realFs, TEST_BUILD, join(tmpRoot, 'vazio')).set, null)
    if (existsSync(HOLDER_BINARY)) assert.match(validateLockHolderArtifacts(fakeFs, TEST_BUILD, HOLDER_BUILD).issues.join(';'), /lock-holder-manifest\.json: diferente do aprovado/)
  })
  it('validação real (se os builds existirem): exit-ok e segurador conferidos, sem problemas', needBuilds, () => {
    const r = validateLockHolderArtifacts(realFs, TEST_BUILD, HOLDER_BUILD)
    assert.deepEqual(r.issues, [])
    assert.equal(r.set?.lockHolder?.length, APPROVED_ARTIFACTS.lockHolder.size)
    assert.deepEqual([...(r.set?.scenarios.keys() ?? [])], ['exit-ok'])
  })
})

// ── Protocolo do segurador ──────────────────────────────────────────────────

describe('segurador: sinais de prontidão e liberação', () => {
  const V = 'gerpro-lock-holder-test v=1 '
  it('prontidão válida nos modos file e directory', () => {
    assert.deepEqual(parseReadyLine(`${V}ready mode=file volume=0a1b2c3d index=0001000000000abc`), { mode: 'file', volume: '0a1b2c3d', indexes: ['0001000000000abc'] })
    assert.deepEqual(parseReadyLine(`${V}ready mode=directory volume=0a1b2c3d index=0001000000000abc,0002000000000def`)?.indexes, ['0001000000000abc', '0002000000000def'])
  })
  for (const line of [
    `${V}ready mode=file volume=0A1B2C3D index=0001000000000abc`,
    `${V}ready mode=file volume=0a1b2c3d index=1abc`,
    `${V}ready mode=file volume=0a1b2c3d index=0001000000000abc extra=1`,
    `${V}ready mode=other volume=0a1b2c3d index=0001000000000abc`,
    `gerpro-lock-holder-test v=2 ready mode=file volume=0a1b2c3d index=0001000000000abc`,
    ` ${V}ready mode=file volume=0a1b2c3d index=0001000000000abc`,
    `${V}released reason=stdin`
  ]) {
    it(`prontidão recusada: ${JSON.stringify(line).slice(0, 70)}`, () => assert.equal(parseReadyLine(line), null))
  }
  it('liberação: só os três motivos fixos', () => {
    assert.equal(parseReleasedLine(`${V}released reason=stdin`), 'stdin')
    assert.equal(parseReleasedLine(`${V}released reason=deadline`), 'deadline')
    assert.equal(parseReleasedLine(`${V}released reason=wait-failure`), 'wait-failure')
    assert.equal(parseReleasedLine(`${V}released reason=stdin extra`), null)
    assert.equal(parseReleasedLine(`${V}released reason=kill`), null)
  })
  it('argumentos fixos e prazos do protocolo', () => {
    assert.deepEqual(lockHolderArgs(LOCK_HOLDER_CASES['T-F1.exit-ok'], 'C:\\t\\x'), ['--mode=file', '--case-dir=C:\\t\\x'])
    assert.deepEqual(lockHolderArgs(LOCK_HOLDER_CASES['T-F4.exit-ok'], 'C:\\t\\x'), ['--mode=directory', '--case-dir=C:\\t\\x'])
    assert.equal(LOCK_HOLDER_READY_TIMEOUT_MS, 2_000)
    assert.equal(LOCK_HOLDER_RELEASE_TIMEOUT_MS, 1_000)
    assert.ok(LOCK_HOLDER_READY_TIMEOUT_MS + LOCK_HOLDER_RELEASE_TIMEOUT_MS < LOCK_HOLDER_SELF_DEADLINE_MS)
    const holderMain = read('native', 'lock-holder-test', 'src', 'main.cpp')
    assert.match(holderMain, new RegExp(`kHoldDeadlineMs = ${LOCK_HOLDER_SELF_DEADLINE_MS};`))
  })
  it('casos: tentativas previstas, nesta ordem, sem T-F2', () => {
    assert.deepEqual(LOCK_HOLDER_CASES['T-F1.exit-ok'].attempts, ['open-rw', 'rename-file', 'delete-file'])
    assert.deepEqual(LOCK_HOLDER_CASES['T-F4.exit-ok'].attempts, ['rename-top', 'rename-arch'])
    assert.deepEqual(Object.keys(LOCK_HOLDER_CASES), ['T-F1.exit-ok', 'T-F4.exit-ok'])
    assert.equal(LOCK_HOLDER_EXPECTED_CODE, 'EBUSY')
  })
  it('ambiente do segurador: só SystemRoot, windir e TMP = TEMP = pasta temporária resolvida', () => {
    assert.deepEqual(lockHolderEnv('C:\\Users\\u\\AppData\\Local\\Temp', 'C:\\Windows'), { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', TMP: 'C:\\Users\\u\\AppData\\Local\\Temp', TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp' })
  })
})

// ── Identidade ──────────────────────────────────────────────────────────────

describe('segurador: conferência de identidade', () => {
  const F1 = LOCK_HOLDER_CASES['T-F1.exit-ok']
  const F4 = LOCK_HOLDER_CASES['T-F4.exit-ok']
  // Índice NTFS com número de sequência 0x81: acima de 2^55 (Number perde os 3 bits baixos).
  const BIG = 0x0081_0000_0000_1230n
  const file: FsIdentity = { dev: 0x0a1b2c3dn, ino: BIG, nlink: 1n, kind: 'file' }
  const ready: ReadySignal = { mode: 'file', volume: '0a1b2c3d', indexes: [hex(BIG, 16)] }
  it('confere volume e índice completos (bigint), tipo e um só nome', () => {
    assert.deepEqual(checkIdentity(F1, ready, { file }), [])
    assert.ok(Number(BIG) === Number(BIG + 1n), 'o índice escolhido perde precisão como Number')
    assert.match(checkIdentity(F1, ready, { file: { ...file, ino: BIG + 1n } }).join(';'), /índice diferente/)
  })
  for (const [label, patch, reason] of [
    ['volume', { dev: 0x0a1b2c3en }, /volume diferente/],
    ['hard link', { nlink: 2n }, /2 nomes/],
    ['link', { kind: 'link' }, /tipo link/],
    ['pasta no lugar do arquivo', { kind: 'directory' }, /tipo directory/]
  ] as const) {
    it(`recusa: ${label}`, () => assert.match(checkIdentity(F1, ready, { file: { ...file, ...patch } as FsIdentity }).join(';'), reason))
  }
  it('recusa: identidade não lida, modo trocado, número de índices', () => {
    assert.match(checkIdentity(F1, ready, { file: null }).join(';'), /não lida/)
    assert.match(checkIdentity(F1, { ...ready, mode: 'directory' }, { file }).join(';'), /modo directory/)
    const top: FsIdentity = { dev: 0x0a1b2c3dn, ino: 5n, nlink: 1n, kind: 'directory' }
    const arch: FsIdentity = { ...top, ino: 6n }
    const dirReady: ReadySignal = { mode: 'directory', volume: '0a1b2c3d', indexes: [hex(5n, 16), hex(6n, 16)] }
    assert.deepEqual(checkIdentity(F4, dirReady, { top, arch }), [])
    assert.match(checkIdentity(F4, { ...dirReady, indexes: [hex(5n, 16)] }, { top, arch }).join(';'), /1 índice/)
    assert.match(checkIdentity(F4, { ...dirReady, indexes: [hex(6n, 16), hex(5n, 16)] }, { top, arch }).join(';'), /host-test: índice diferente/)
  })
})

// ── Guardas de caminho ──────────────────────────────────────────────────────

describe('segurador: guardas de caminho (entrada)', () => {
  const T = 'C:\\Users\\u\\AppData\\Local\\Temp'
  const case1 = `${T}\\gerpro-6c6c-aB3x9Z\\01-T-F1.exit-ok`
  const case4 = `${T}\\gerpro-6c6c-aB3x9Z\\01-T-F4.exit-ok`
  const l1 = caseLayout(case1)
  const l4 = caseLayout(case4)
  it('forma da pasta do caso', () => {
    assert.deepEqual(splitCasePath(T, l1.file), { caseId: 'T-F1.exit-ok', caseDir: case1, rel: CASE_REL.file })
    for (const bad of [
      `D:\\Temp\\gerpro-6c6c-aB3x9Z\\01-T-F1.exit-ok\\host-test`,
      `${T}\\gerpro-hwdiag-aB3x9Z\\01-T-F1.exit-ok\\host-test`,
      `${T}\\gerpro-6c6c-aB3x9Z\\01-T-F2.exit-ok\\host-test`,
      `${T}\\gerpro-6c6c-aB3x9Z\\01-T-F3.hang\\host-test`,
      `${T}\\gerpro-6c6c-aB3x9Z\\02-T-F1.exit-ok\\host-test`,
      `${T}\\gerpro-6c6c-aB3x9Z\\01-T-F1.exit-ok\\..\\x`,
      `${T}\\gerpro-6c6c-aB3x9Z\\01-T-F1.exit-ok/host-test`,
      `${T}\\gerpro-6c6c-a.b\\01-T-F1.exit-ok\\host-test`,
      `${T}\\gerpro-6c6c-aB3x9Z\\01-T-F1.exit-ok`
    ]) assert.equal(splitCasePath(T, bad), null, bad)
  })
  it('renomeação: só os pares fixos do caso, nos dois sentidos (tentativa e restauração)', () => {
    assert.ok(renameAllowed(T, l1.file, l1.fileRenamed))
    assert.ok(renameAllowed(T, l1.fileRenamed, l1.file))
    assert.ok(renameAllowed(T, l4.top, l4.topRenamed) && renameAllowed(T, l4.topRenamed, l4.top))
    assert.ok(renameAllowed(T, l4.arch, l4.archRenamed) && renameAllowed(T, l4.archRenamed, l4.arch))
    assert.ok(!renameAllowed(T, l4.file, l4.fileRenamed), 'arquivo no T-F4')
    assert.ok(!renameAllowed(T, l1.top, l1.topRenamed), 'pasta no T-F1')
    assert.ok(!renameAllowed(T, l1.file, l4.fileRenamed), 'entre pastas de caso')
    assert.ok(!renameAllowed(T, l1.file, `${T}\\fora.exe`), 'para fora')
    assert.ok(!renameAllowed(T, l1.file, win32.join(case1, 'outro-nome.exe')), 'outro nome')
    assert.ok(!renameAllowed(T, l4.top, l4.archRenamed), 'par trocado')
    assert.ok(!renameAllowed(T, l1.holder, win32.join(case1, 'x.exe')), 'o segurador')
  })
  it('exclusão: só a cópia do alvo no T-F1', () => {
    assert.ok(unlinkAllowed(T, l1.file))
    assert.ok(!unlinkAllowed(T, l4.file))
    assert.ok(!unlinkAllowed(T, l1.holder))
    assert.ok(!unlinkAllowed(T, l1.top))
    assert.ok(!unlinkAllowed(T, `${T}\\${'x'}.exe`))
  })
  it('identidade e executável: só objetos da pasta do caso e a cópia do segurador', () => {
    for (const p of [l1.file, l1.fileRenamed, l4.top, l4.arch, l4.topRenamed, l4.archRenamed]) assert.ok(identityAllowed(T, p), p)
    assert.ok(!identityAllowed(T, l1.holder))
    assert.ok(!identityAllowed(T, 'C:\\Windows\\System32\\kernel32.dll'))
    assert.ok(holderImageAllowed(T, l1.holder) && holderImageAllowed(T, l4.holder))
    assert.ok(!holderImageAllowed(T, join(HOLDER_BUILD, LOCK_HOLDER_NAME)), 'nunca direto do build')
    assert.ok(!holderImageAllowed(T, win32.join(case1, 'host-test', 'win32-x64', LOCK_HOLDER_NAME)))
    assert.ok(!holderImageAllowed(T, 'C:\\Windows\\System32\\cmd.exe'))
  })
  it('a pasta do segurador fica fora de host-test (pasta atual e imagem do filho não interferem no T-F4)', () => {
    assert.ok(!CASE_REL.holderDir.startsWith(CASE_REL.top))
    assert.equal(win32.dirname(l4.holder), l4.holderDir)
  })
  it('pasta temporária aceita pelo segurador', () => {
    assert.deepEqual(lockHolderBaseIssues(T), [])
    assert.match(lockHolderBaseIssues('C:\\Users\\PEDRO~1\\AppData\\Local\\Temp').join(';'), /~/)
    assert.ok(lockHolderBaseIssues('C:\\').length > 0)
    assert.ok(lockHolderBaseIssues('\\\\server\\share\\Temp').length > 0)
    assert.match(lockHolderBaseIssues(`C:\\${'a'.repeat(280)}`).join(';'), /limite do segurador/)
  })
})

// ── Avaliação ───────────────────────────────────────────────────────────────

const V = 'gerpro-lock-holder-test v=1 '
const READY_F1 = `${V}ready mode=file volume=0a1b2c3d index=0001000000000abc`
const OK_F1: LockHolderObservation = {
  caseId: 'T-F1.exit-ok',
  spawnError: null,
  pid: 4242,
  readyMs: 40,
  ready: parseReadyLine(READY_F1),
  unexpectedFirstLine: false,
  identityIssues: [],
  identityAfterIssues: [],
  attempts: [
    { id: 'open-rw', ms: 41, result: REFUSED, restoration: null },
    { id: 'rename-file', ms: 42, result: REFUSED, restoration: null },
    { id: 'delete-file', ms: 43, result: REFUSED, restoration: null }
  ],
  attemptsStopped: null,
  holderAliveThroughAttempts: true,
  releaseRequestedMs: 45,
  killRequestedMs: null,
  killAccepted: null,
  exitCode: 0,
  exitSignal: null,
  exitMs: 70,
  closeMs: 71,
  stdout: `${READY_F1}\n${V}released reason=stdin\n`,
  stderrBytes: 0,
  hashBefore: EXIT_OK.sha256,
  hashAfterAttempts: EXIT_OK.sha256,
  hashAfterRelease: EXIT_OK.sha256,
  censusAfter: 0
}

describe('segurador: avaliação', () => {
  it('aprova: prontidão, identidade, 3 recusas EBUSY, liberação pela entrada com código 0, conteúdo íntegro, censo 0', () => {
    const r = evaluateLockHolder(OK_F1)
    assert.equal(r.verdict.pass, true, r.verdict.pass ? '' : r.verdict.reasons.join('; '))
    const text = r.evidence.join('\n')
    assert.match(text, /abertura para leitura e escrita em 41 ms: recusada \(EBUSY/)
    assert.match(text, /released reason=stdin, código 0/)
  })
  const F4_READY = `${V}ready mode=directory volume=0a1b2c3d index=0001000000000abc,0001000000000abd`
  it('aprova o T-F4 com as duas renomeações recusadas', () => {
    const r = evaluateLockHolder({
      ...OK_F1,
      caseId: 'T-F4.exit-ok',
      ready: parseReadyLine(F4_READY),
      stdout: `${F4_READY}\n${V}released reason=stdin\n`,
      attempts: [
        { id: 'rename-top', ms: 41, result: REFUSED, restoration: null },
        { id: 'rename-arch', ms: 42, result: REFUSED, restoration: null }
      ]
    })
    assert.equal(r.verdict.pass, true, r.verdict.pass ? '' : r.verdict.reasons.join('; '))
  })
  const ok = REFUSED
  for (const [label, patch, reason] of [
    ['não iniciou', { spawnError: 'ENOENT' }, /não iniciou/],
    ['sem prontidão', { readyMs: null, ready: null, releaseRequestedMs: null }, /não sinalizou prontidão em 2000 ms/],
    ['prontidão ilegível', { ready: null, unexpectedFirstLine: true }, /não é uma prontidão válida/],
    ['prontidão tardia', { readyMs: 2_001 }, /prontidão em 2001 ms/],
    ['identidade divergente', { identityIssues: ['x: índice diferente do anunciado pelo segurador'] }, /identidade: x: índice diferente/],
    ['identidade não conferida', { identityIssues: null }, /não conferida/],
    ['abertura permitida', { attempts: [{ id: 'open-rw', ms: 41, result: { succeeded: true, code: null, errno: null }, restoration: null }], attemptsStopped: 'abertura para leitura e escrita funcionou: cenário interrompido, nenhuma outra tentativa' }, /H-F1 REFUTADA: abertura para leitura e escrita funcionou/],
    ['recusa por permissão', { attempts: [{ id: 'open-rw', ms: 41, result: { succeeded: false, code: 'EPERM', errno: -4048 }, restoration: null }, OK_F1.attempts[1]!, OK_F1.attempts[2]!] }, /recusada com EPERM .*não confirma H-F1/],
    ['tentativa faltando', { attempts: OK_F1.attempts.slice(0, 2) }, /2 de 3 tentativas/],
    ['tentativa repetida', { attempts: [OK_F1.attempts[0]!, OK_F1.attempts[0]!, OK_F1.attempts[1]!, OK_F1.attempts[2]!] }, /tentativa repetida/],
    ['fora de ordem', { attempts: [OK_F1.attempts[1]!, OK_F1.attempts[0]!, OK_F1.attempts[2]!] }, /fora da ordem/],
    ['segurador inativo durante as tentativas', { holderAliveThroughAttempts: false }, /não estava ativo/],
    ['objeto movido depois das tentativas', { identityAfterIssues: ['gerpro-synthetic-helper.exe: identidade não lida'] }, /depois das tentativas/],
    ['sem liberação pedida', { releaseRequestedMs: null }, /liberação não pedida/],
    ['saiu antes do pedido', { exitMs: 44, closeMs: 44 }, /saiu antes do pedido/],
    ['liberação pelo prazo próprio', { exitCode: 45, stdout: `${READY_F1}\n${V}released reason=deadline\n` }, /reason=deadline.*\(esperado reason=stdin\)[\s\S]*código 45 \(prazo próprio vencido\)/],
    ['sem sinal de liberação', { stdout: `${READY_F1}\n` }, /ausente ou ilegível/],
    ['liberação tardia', { exitMs: 1_100, closeMs: 1_100 }, /1055 ms depois do pedido \(limite 1000 ms\)/],
    ['encerrado pelo supervisor', { killRequestedMs: 1_046, killAccepted: true, exitCode: null, exitSignal: 'SIGTERM' }, /encerrou o segurador pelo identificador \(PID 4242\)/],
    ['saída a mais', { stdout: `${READY_F1}\n${V}released reason=stdin\nlixo\n` }, /3 linha/],
    ['saída de erro', { stderrBytes: 3 }, /saída de erro/],
    ['conteúdo alterado', { hashAfterAttempts: 'x' }, /depois das tentativas/],
    ['cópia removida', { hashAfterRelease: null }, /depois da liberação/],
    ['sobrevivente', { censusAfter: 1 }, /1 processo/],
    ['censo indisponível', { censusAfter: null }, /censo logo depois indisponível/]
  ] as const) {
    it(`reprova: ${label}`, () => {
      const r = evaluateLockHolder({ ...OK_F1, ...patch } as LockHolderObservation)
      assert.equal(r.verdict.pass, false)
      if (!r.verdict.pass) assert.match(r.verdict.reasons.join('; '), reason)
    })
  }
  it('rótulo de cada tentativa', () => {
    assert.equal(ATTEMPTS['rename-top'].label, 'renomeação de host-test')
    assert.equal(ATTEMPTS['rename-arch'].label, 'renomeação de win32-x64')
    assert.equal(ok.code, 'EBUSY')
  })
})

// ── Execução simulada ───────────────────────────────────────────────────────

describe('segurador: execução simulada do T-F1 e do T-F4', () => {
  it('T-F1 aprovado: ordem das operações, cada tentativa uma vez, liberação pela entrada, censo e limpeza', needBuilds, async () => {
    const { d, rec } = deps()
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.ok, rec.logs.join('\n'))
    assert.equal(report.results[0]!.status, 'pass')
    assertOrder(rec.events, ['census', 'acquire-lock', 'verify-holder-copy', 'spawn', 'stat', 'attempt:open-rw', 'attempt:rename:gerpro-synthetic-helper.exe', 'attempt:unlink', 'stat', 'close-stdin', 'census', 'release-lock', 'census'])
    assert.equal(rec.spawns.length, 1)
    assert.equal(rec.kills, 0)
    assert.equal(rec.closes, 1)
    assert.deepEqual(
      rec.attempts.map((a) => a.kind),
      ['open-rw', 'rename', 'unlink']
    )
    const { executable, args, cwd } = rec.spawns[0]!
    const caseDir = caseDirFromArgs(args)
    assert.match(caseDir, /\\gerpro-6c6c-[A-Za-z0-9]{6}\\01-T-F1\.exit-ok$/)
    assert.deepEqual(args, ['--mode=file', `--case-dir=${caseDir}`])
    assert.equal(executable, win32.join(caseDir, 'lock-holder', LOCK_HOLDER_NAME))
    assert.equal(cwd, win32.join(caseDir, 'lock-holder'))
    assert.ok(holderImageAllowed(tmpRoot, executable))
    // Todas as tentativas só em objetos da pasta do caso, e as guardas da entrada aceitariam cada uma.
    const l = caseLayout(caseDir)
    assert.deepEqual(rec.attempts[0]!.paths, [l.file])
    assert.deepEqual(rec.attempts[1]!.paths, [l.file, l.fileRenamed])
    assert.ok(renameAllowed(tmpRoot, l.file, l.fileRenamed) && unlinkAllowed(tmpRoot, l.file))
    assert.deepEqual(rec.attempts[2]!.paths, [l.file])
    assert.equal(report.observation?.hashBefore, EXIT_OK.sha256)
    assert.equal(report.observation?.hashAfterRelease, EXIT_OK.sha256)
    assert.deepEqual(report.cleanup, { removed: true, attempts: 1 })
    assert.equal(report.lockReleased, true)
    assert.deepEqual(leftovers(), [])
  })

  it('T-F4 aprovado: duas renomeações de pastas, uma vez cada, sem tocar no arquivo', needBuilds, async () => {
    const { d, rec } = deps()
    const report = await runLockHolderCase(d, 'T-F4.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.ok, rec.logs.join('\n'))
    assertOrder(rec.events, ['spawn', 'stat', 'attempt:rename:host-test', 'attempt:rename:win32-x64', 'close-stdin', 'release-lock'])
    assert.deepEqual(
      rec.attempts.map((a) => a.kind),
      ['rename', 'rename']
    )
    const caseDir = caseDirFromArgs(rec.spawns[0]!.args)
    assert.deepEqual(rec.spawns[0]!.args, ['--mode=directory', `--case-dir=${caseDir}`])
    const l = caseLayout(caseDir)
    assert.deepEqual(rec.attempts[0]!.paths, [l.top, l.topRenamed])
    assert.deepEqual(rec.attempts[1]!.paths, [l.arch, l.archRenamed])
    assert.ok(!rec.events.includes('attempt:open-rw') && !rec.events.includes('attempt:unlink'))
    assert.deepEqual(leftovers(), [])
  })

  it('prontidão que não chega em 2 s: encerra só o segurador iniciado, pelo identificador; nenhuma tentativa', needBuilds, async () => {
    const { d, rec } = deps({ holder: { ready: 'never' }, fire: [LOCK_HOLDER_READY_TIMEOUT_MS] })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.kills, 1)
    assert.equal(rec.attempts.length, 0)
    assert.equal(rec.closes, 0)
    assert.match(report.results[0]!.messages.join(';'), /não sinalizou prontidão em 2000 ms/)
    assert.ok(rec.logs.some((l) => /encerramento do segurador PEDIDO .*pelo identificador do processo iniciado \(PID 4242\)/.test(l)))
    assert.deepEqual(leftovers(), [])
  })

  it('prontidão fora do formato: nenhuma tentativa; liberação pedida; reprovado', needBuilds, async () => {
    const { d, rec } = deps({ holder: { ready: () => `${V}ready mode=file volume=zz index=1` } })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.attempts.length, 0)
    assert.equal(rec.closes, 1)
    assert.match(report.results[0]!.messages.join(';'), /não é uma prontidão válida/)
  })

  it('identidade diferente da anunciada: nenhuma tentativa; liberação pedida; reprovado', needBuilds, async () => {
    const { d, rec } = deps({ holder: { ready: (caseDir) => realReadyLine('file', caseDir).replace(/index=([0-9a-f]{16})$/, (_m, i: string) => `index=${(BigInt(`0x${i}`) ^ 1n).toString(16).padStart(16, '0')}`) } })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.attempts.length, 0)
    assert.equal(rec.closes, 1)
    assert.equal(rec.kills, 0)
    assert.match(report.results[0]!.messages.join(';'), /índice diferente do anunciado/)
  })

  it('modo da prontidão diferente do caso: recusado antes das tentativas', needBuilds, async () => {
    const { d, rec } = deps({ holder: { ready: (caseDir) => realReadyLine('directory', caseDir) } })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.attempts.length, 0)
    assert.match(report.results[0]!.messages.join(';'), /modo directory na prontidão/)
  })

  it('liberação que não chega em 1 s: encerra só o segurador iniciado; reprovado', needBuilds, async () => {
    const { d, rec } = deps({ holder: { release: 'hang' }, fire: [LOCK_HOLDER_RELEASE_TIMEOUT_MS] })
    const report = await runLockHolderCase(d, 'T-F4.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.closes, 1)
    assert.equal(rec.kills, 1)
    assertOrder(rec.events, ['close-stdin', 'kill', 'census', 'release-lock'])
    assert.match(report.results[0]!.messages.join(';'), /encerrou o segurador pelo identificador/)
    assert.deepEqual(leftovers(), [])
  })

  it('segurador que solta pelo prazo próprio (45) ou sem sinal: reprovado, sem encerramento', needBuilds, async () => {
    for (const release of ['deadline', 'no-line'] as const) {
      const { d, rec } = deps({ holder: { release } })
      const report = await runLockHolderCase(d, 'T-F1.exit-ok')
      assert.equal(report.exitCode, BATTERY_EXIT.caseFailed, release)
      assert.equal(rec.kills, 0)
      assert.match(report.results[0]!.messages.join(';'), /esperado reason=stdin/)
    }
  })

  it('segurador que sai antes das tentativas: nenhuma tentativa, nenhum encerramento, reprovado', needBuilds, async () => {
    const { d, rec } = deps({ holder: { exitAfterReady: true } })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.attempts.length, 0)
    assert.equal(rec.kills, 0)
    assert.match(report.results[0]!.messages.join(';'), /o segurador saiu antes da tentativa/)
  })

  it('abertura para escrita permitida: registrada, cenário interrompido (sem renomear nem apagar), reprovado', needBuilds, async () => {
    const { d, rec } = deps({ probes: { open: 'real' } })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.deepEqual(
      rec.attempts.map((a) => a.kind),
      ['open-rw']
    )
    assert.equal(rec.closes, 1)
    assert.match(report.results[0]!.messages.join(';'), /H-F1 REFUTADA/)
  })

  it('renomeação do arquivo permitida: registrada sem mascarar, objeto restaurado (identidade conferida), sem exclusão', needBuilds, async () => {
    const { d, rec } = deps({ probes: { rename: 'real' } })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.deepEqual(
      rec.attempts.map((a) => a.kind),
      ['open-rw', 'rename', 'rename']
    )
    const [, attempt, restore] = rec.attempts
    assert.deepEqual(restore!.paths, [...attempt!.paths].reverse(), 'só a restauração, no sentido inverso')
    const r = report.observation!.attempts[1]!
    assert.deepEqual(r.restoration, { identityMatched: true, result: { succeeded: true, code: null, errno: null } })
    assert.equal(report.observation?.hashAfterRelease, EXIT_OK.sha256)
    assert.match(report.results[0]!.messages.join(';'), /H-F1 REFUTADA: renomeação do arquivo funcionou/)
    assert.ok(report.lockHolder!.evidence.some((e) => /restauração \(renomeação de volta\): feita; o resultado da tentativa continua registrado/.test(e)))
    assert.deepEqual(leftovers(), [])
  })

  it('renomeação de host-test permitida: restaurada; win32-x64 não é tentada', needBuilds, async () => {
    const { d, rec } = deps({ probes: { rename: 'real' } })
    const report = await runLockHolderCase(d, 'T-F4.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.attempts.length, 2)
    assert.ok(rec.attempts.every((a) => a.paths.some((p) => /\\host-test(-renamed)?$/.test(p))))
    assert.deepEqual(report.observation!.attempts.map((a) => a.id), ['rename-top'])
    assert.match(report.results[0]!.messages.join(';'), /H-F4 REFUTADA: renomeação de host-test funcionou/)
  })

  it('restauração recusada se o objeto no destino não for o original', needBuilds, async () => {
    let swap = false
    const { d, rec } = deps({ probes: { rename: { succeeded: true, code: null, errno: null } } })
    const stat = d.statIdentity!
    d.statIdentity = (p) => {
      if (p.endsWith('-renamed') || p.endsWith('.renamed')) {
        swap = true
        return { dev: 1n, ino: 2n, nlink: 1n, kind: 'directory' }
      }
      return stat(p)
    }
    const report = await runLockHolderCase(d, 'T-F4.exit-ok')
    assert.ok(swap)
    assert.equal(rec.attempts.length, 1, 'nenhuma renomeação de volta')
    assert.deepEqual(report.observation!.attempts[0]!.restoration, { identityMatched: false, result: null })
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
  })

  it('exclusão permitida: registrada; nada a restaurar; a limpeza ainda remove a pasta exclusiva', needBuilds, async () => {
    const { d } = deps({ probes: { unlink: 'real' } })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(report.observation?.hashAfterRelease, null)
    assert.match(report.results[0]!.messages.join(';'), /exclusão do arquivo funcionou/)
    assert.deepEqual(leftovers(), [])
  })

  it('erro de guarda numa tentativa: tentativas param, mas liberação, censo e limpeza acontecem', needBuilds, async () => {
    const { d, rec } = deps({
      overrides: {
        probeRename: () => {
          throw new Error('renomeação fora dos pares fixos da pasta do caso')
        }
      }
    })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.closes, 1)
    assert.ok(!rec.events.includes('attempt:unlink'))
    assert.match(report.results[0]!.messages.join(';'), /erro do supervisor durante as tentativas/)
    assert.deepEqual(leftovers(), [])
  })

  it('sobrevivente depois: registrado e NUNCA encerrado (nem por nome, nem por PID)', needBuilds, async () => {
    const survivor = { pid: 999, ppid: 1, created: '1', path: `C:\\x\\${LOCK_HOLDER_NAME}` }
    const { d, rec } = deps({ census: (n) => (n === 1 ? [] : [survivor]) })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.survivors)
    assert.equal(rec.kills, 0)
    assert.deepEqual(report.survivors, { owned: 0, foreign: 1 })
    assert.ok(rec.logs.some((l) => /PID 999, imagem gerpro-lock-holder-test\.exe; não tocado/.test(l)))
  })

  it('falha de limpeza: código 7 mesmo com o caso aprovado', needBuilds, async () => {
    const { d } = deps({
      fs: {
        rmdir: (path) => {
          if (/\\gerpro-6c6c-[A-Za-z0-9]+$/.test(path)) throw Object.assign(new Error('falha'), { code: 'EIO' })
          rmdirSync(path)
        }
      }
    })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.results[0]!.status, 'pass')
    assert.equal(report.cleanup?.removed, false)
    assert.equal(report.exitCode, BATTERY_EXIT.cleanupFailed)
  })

  it('outra bateria em andamento (execução paralela): nada é criado nem iniciado', needBuilds, async () => {
    const { d, rec } = deps({ overrides: { acquireLock: () => 'held' } })
    const report = await runLockHolderCase(d, 'T-F4.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.precondition)
    assert.equal(rec.spawns.length, 0)
    assert.deepEqual(leftovers(), [])
  })

  it('pré-condições: elevado, censo > 0 ou funções ausentes: nada é iniciado', async () => {
    for (const overrides of [{ integrityLevel: () => 'high' as const }, { census: () => [{ pid: 1, ppid: 0, created: '1', path: null }] }, { spawnLockHolder: undefined }, { probeUnlink: undefined }]) {
      const { d, rec } = deps({ overrides })
      const report = await runLockHolderCase(d, 'T-F1.exit-ok')
      assert.equal(report.exitCode, BATTERY_EXIT.precondition)
      assert.equal(rec.spawns.length, 0)
      assert.ok(!rec.events.includes('acquire-lock'))
    }
    // O T-F4 não precisa da exclusão.
    const { d } = deps({ overrides: { probeUnlink: undefined, probeWriteOpen: undefined } })
    assert.ok(!checkLockHolderPreconditions(d, 'T-F4.exit-ok').failures.some((f) => /supervisor sem/.test(f)))
  })

  it('cópia do segurador adulterada antes do início: recusada, nada iniciado', needBuilds, async () => {
    const { d, rec } = deps({
      fs: {
        readFile: (path) => {
          const bytes = readFileSync(path)
          if (!path.endsWith(`\\${CASE_REL.holder}`)) return bytes
          rec.events.push('verify-holder-copy')
          // Simula a troca da cópia depois da gravação conferida (a segunda leitura é a do início).
          return rec.events.filter((e) => e === 'verify-holder-copy').length >= 2 ? Buffer.concat([bytes, Buffer.from([1])]) : bytes
        }
      }
    })
    const report = await runLockHolderCase(d, 'T-F1.exit-ok')
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.spawns.length, 0)
    assert.match(report.results[0]!.messages.join(';'), /SHA-256 diferente do aprovado/)
    assert.deepEqual(leftovers(), [])
  })

  it('sem repetição automática: mesmo reprovado, o segurador e cada tentativa só uma vez', needBuilds, async () => {
    for (const caseId of ['T-F1.exit-ok', 'T-F4.exit-ok'] as LockHolderCaseId[]) {
      const { d, rec } = deps({ probes: { open: { succeeded: false, code: 'EPERM', errno: -4048 }, rename: { succeeded: false, code: 'EACCES', errno: -4092 } } })
      const report = await runLockHolderCase(d, caseId)
      assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
      assert.equal(rec.spawns.length, 1)
      const ids = report.observation!.attempts.map((a) => a.id)
      assert.deepEqual(ids, [...LOCK_HOLDER_CASES[caseId].attempts])
      assert.match(report.results[0]!.messages.join(';'), /não confirma/)
    }
  })

  it('tempos: prazos usados pelo roteiro são os do protocolo', () => {
    assert.equal(LOCK_HOLDER_KILL_CLOSE_MS, 2_000)
  })
})

// ── Fontes da entrada ───────────────────────────────────────────────────────

describe('segurador: fontes da entrada do supervisor', () => {
  const entry = read('scripts', 'diagnostics', 'run-host-containment.mjs')
  const fnBody = (signature: string) => {
    const start = entry.indexOf(signature)
    assert.ok(start >= 0, signature)
    return entry.slice(start, entry.indexOf('\n  },', start))
  }
  it('T-F1/T-F4 vão para o roteiro do segurador; T-F3 continua no dele', () => {
    assert.match(entry, /mode\.mode === 'check-file-lock' && plan\.isLockHolderCase\(mode\.caseId\)[\s\S]*battery\.checkLockHolderPreconditions\(deps, mode\.caseId\)/)
    assert.match(entry, /mode\.mode === 'file-lock' && plan\.isLockHolderCase\(mode\.caseId\)[\s\S]*battery\.runLockHolderCase\(deps, mode\.caseId\)/)
    assert.ok(entry.indexOf('plan.isLockHolderCase(mode.caseId)') < entry.indexOf('battery.runFileLock(deps)'))
  })
  it('o segurador é iniciado só da cópia conferida, sem shell, com pipes e ambiente mínimo', () => {
    const body = fnBody('  spawnLockHolder(executable, args, cwd) {')
    assert.match(body, /if \(!holder\.holderImageAllowed\(tmpRoot, executable\)\) throw/)
    assert.match(body, /shell: false/)
    assert.match(body, /stdio: \['pipe', 'pipe', 'pipe'\]/)
    assert.match(body, /env: holder\.lockHolderEnv\(tmpRoot, trustedRoot \?\? ''\)/)
    assert.match(body, /child\.stdin\.destroy\(\)/)
    assert.doesNotMatch(body, /\.write\(|\.end\(/, 'nenhum byte na entrada')
  })
  it('renomeação e exclusão só pelas guardas, uma chamada cada', () => {
    assert.equal([...entry.matchAll(/renameSync\(/g)].length, 1)
    assert.match(fnBody('  probeRename(from, to) {'), /if \(!holder\.renameAllowed\(tmpRoot, from, to\)\) throw[\s\S]*renameSync\(from, to\)/)
    assert.match(fnBody('  probeUnlink(path) {'), /if \(!holder\.unlinkAllowed\(tmpRoot, path\)\) throw[\s\S]*unlinkSync\(path\)/)
    assert.equal([...entry.matchAll(/unlinkSync\(/g)].length, 3, 'trava, remoção da pasta exclusiva (D55) e a exclusão do T-F1')
    assert.match(fnBody('  statIdentity(path) {'), /if \(!holder\.identityAllowed\(tmpRoot, path\)\) throw[\s\S]*lstatSync\(path, \{ bigint: true \}\)/)
  })
  it('encerramento só pelo identificador do processo iniciado; nunca por nome', () => {
    assert.doesNotMatch(entry, /taskkill|Stop-Process|process\.kill\(|killall|pkill/i)
    const codeLines = entry.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    assert.deepEqual(codeLines.filter((l) => l.includes('.kill(')).map((l) => l.trim()), ['return { pid: child.pid ?? null, done, kill: () => child.kill(), ready, matchLine }'], 'só child.kill() em supervise')
    assert.match(entry, /kill: \(\) => child\.kill\(\)/)
  })
  it('a entrada não substitui conferências (só os testes passam validate)', () => {
    assert.doesNotMatch(entry, /\bvalidate:|validateDiagnosis:/)
  })
  it('o segurador não aparece no app, no IPC, no preload, no renderer nem no empacotamento', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
    for (const file of walk(join(ROOT, 'src'))) assert.doesNotMatch(readFileSync(file, 'utf8'), /lock-holder|lockholder|LOCK_HOLDER/i, file)
    assert.doesNotMatch(read('scripts', 'diagnostics', 'host-containment-electron.mjs'), /lock-holder|LOCK_HOLDER/i)
    assert.doesNotMatch(read('package.json'), /lock-holder/)
  })
})

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  BATTERY_EXIT,
  ELECTRON_RESULT_MARK,
  runBattery,
  validateArtifacts,
  type BatteryDeps,
  type BatteryFs,
  type ChildRun,
  type RawRun
} from '../../scripts/diagnostics/host-containment/battery'
import { GROUP_A_CASES, GROUP_A_TESTS, type ScenarioId } from '../../scripts/diagnostics/host-containment/plan'
import { BATTERY_SCRATCH_PREFIX, filetimeFromMs, type ProcessIdentity } from '../../scripts/diagnostics/host-containment/system-checks'

// Bateria do Grupo A com o sistema SIMULADO: nenhum processo é iniciado. A
// pasta exclusiva é real (numa raiz temporária própria do teste), os
// processos, o censo, a trava e o nível de integridade são falsos.

let tmpRoot: string
beforeEach(() => {
  tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'gerpro-battery-test-')))
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

const SCENARIO_IDS: ScenarioId[] = ['exit-ok', 'exit-contract', 'exit-out-of-contract', 'spawn-child', 'memory', 'job-probe']
/** Artefatos falsos (bytes distintos); a conferência real dos hashes é testada à parte. */
const fakeValidate = () => ({
  set: { launcher: Buffer.from('launcher'), scenarios: new Map(SCENARIO_IDS.map((id) => [id, Buffer.from(`alvo ${id}`)] as const)) },
  issues: [] as string[]
})

const M = 64 * 1024 * 1024
const LINES: Record<string, string> = {
  'exit-ok': 'gerpro-synthetic scenario=exit-ok',
  'exit-contract': 'gerpro-synthetic scenario=exit-contract',
  'exit-out-of-contract': 'gerpro-synthetic scenario=exit-out-of-contract',
  'spawn-child': 'gerpro-synthetic scenario=spawn-child plain=denied,error=5 breakaway=denied,error=5',
  memory: `gerpro-synthetic scenario=memory committed=${M} in-job=1 peak-process=${M + 4096} peak-job=${M + 4096}`
}

/** Resposta "conforme o roteiro" de cada caso, pelo nome da subpasta. */
function expectedRun(caseDir: string): RawRun {
  const id = basename(caseDir).slice(3)
  const c = GROUP_A_CASES.find((x) => x.id === id)!
  const pre = c.expectedExit >= 20 && c.expectedExit <= 26
  return { exitCode: c.expectedExit, stdout: pre ? '' : `${LINES[c.scenario]}\n`, stderrBytes: 0, exitMs: 30, closeMs: 31, spawnError: null }
}

const J = 'gerpro-synthetic scenario=job-probe in-job=1 limit-flags=0x2408 active-limit=1 active=1 total=1 peak-process=1 peak-job=1'
const electronRun = (): RawRun => ({
  exitCode: 0,
  stdout: `${ELECTRON_RESULT_MARK}${JSON.stringify({ electronVersion: '45.0.0', direct: { exitCode: 0, line: J.replace('0x2408', '0x3c00') }, viaLauncher: { exitCode: 0, line: J } })}\n`,
  stderrBytes: 0,
  exitMs: 900,
  closeMs: 905,
  spawnError: null
})

interface Recorder {
  spawns: Array<{ executable: string; args: readonly string[]; stdout: string; cwd: string }>
  electron: number
  lockReleased: number
  logs: string[]
  scratchSeen: string[]
}

const ELECTRON_EXE = 'C:\\proj\\node_modules\\electron\\dist\\electron.exe'

function deps(
  overrides: Partial<BatteryDeps> = {},
  behaviour: { run?: (cwd: string) => ChildRun; census?: () => ProcessIdentity[] | null; electronCensus?: () => ProcessIdentity[] | null } = {}
): { deps: BatteryDeps; rec: Recorder } {
  const rec: Recorder = { spawns: [], electron: 0, lockReleased: 0, logs: [], scratchSeen: [] }
  let pid = 1000
  const immediate = (raw: RawRun): ChildRun => ({ pid: ++pid, done: Promise.resolve(raw), kill: () => {} })
  const d: BatteryDeps = {
    platform: 'win32',
    arch: 'x64',
    tmpRoot,
    artifactsDir: join(tmpRoot, 'nao-usado'),
    fs,
    validate: fakeValidate,
    electronVersion: () => '45.0.0',
    integrityLevel: () => 'medium',
    census: behaviour.census ?? (() => []),
    acquireLock: () => 'acquired',
    releaseLock: () => {
      rec.lockReleased++
      return true
    },
    spawnLauncher(executable, args, stdout, cwd) {
      rec.spawns.push({ executable, args, stdout, cwd })
      return behaviour.run ? behaviour.run(cwd) : immediate(expectedRun(cwd))
    },
    spawnElectron(scratchPath) {
      rec.electron++
      rec.scratchSeen.push(scratchPath)
      return immediate(electronRun())
    },
    electronCensus: behaviour.electronCensus ?? (() => []),
    electronImagePath: ELECTRON_EXE,
    now: () => Date.now(),
    sleep: async () => {},
    deadline: () => ({ reached: new Promise<void>(() => {}), cancel: () => {} }),
    log: (line) => rec.logs.push(line),
    ...overrides
  }
  return { deps: d, rec }
}

const leftovers = () => readdirSync(tmpRoot).filter((n) => n.startsWith(BATTERY_SCRATCH_PREFIX))

describe('bateria: nada começa sem as pré-condições', () => {
  const cases: Array<[string, Partial<BatteryDeps>]> = [
    ['elevado', { integrityLevel: () => 'high' }],
    ['nível desconhecido', { integrityLevel: () => 'unknown' }],
    ['outra arquitetura', { arch: 'arm64' }],
    ['pasta temporária em rede', { tmpRoot: '\\\\servidor\\tmp' }],
    ['artefatos fora do aprovado', { validate: () => ({ set: null, issues: ['alvo exit-ok: tamanho ou SHA-256 diferente do aprovado'] }) }],
    ['Electron diferente do 45', { electronVersion: () => '44.0.0' }],
    ['trava de outra bateria', { acquireLock: () => 'held' }]
  ]
  for (const [name, override] of cases) {
    it(name, async () => {
      const { deps: d, rec } = deps(override)
      const report = await runBattery(d, GROUP_A_TESTS)
      assert.equal(report.exitCode, BATTERY_EXIT.precondition)
      assert.equal(rec.spawns.length + rec.electron, 0)
      assert.deepEqual(leftovers(), [])
    })
  }

  it('processo de teste já em execução: recusa e não toca nele', async () => {
    const census = () => [{ pid: 77, ppid: 1, created: '1', path: 'C:\\x\\gerpro-synthetic-helper.exe' }]
    const { deps: d, rec } = deps({}, { census })
    const report = await runBattery(d, GROUP_A_TESTS)
    assert.equal(report.exitCode, BATTERY_EXIT.precondition)
    assert.equal(rec.spawns.length, 0)
  })

  it('censo indisponível: recusa', async () => {
    const { deps: d, rec } = deps({}, { census: () => null })
    assert.equal((await runBattery(d, GROUP_A_TESTS)).exitCode, BATTERY_EXIT.precondition)
    assert.equal(rec.spawns.length, 0)
  })
})

describe('bateria: execução conforme o roteiro (simulada)', () => {
  it('cada caso roda uma vez, na pasta exclusiva; pasta removida e trava liberada', async () => {
    const { deps: d, rec } = deps()
    const report = await runBattery(d, GROUP_A_TESTS)
    assert.equal(report.exitCode, BATTERY_EXIT.ok, rec.logs.join('\n'))
    const nodeCases = GROUP_A_CASES.filter((c) => c.runner === 'node' && c.layout !== 'helper-symlink')
    assert.equal(rec.spawns.length, nodeCases.length)
    assert.equal(rec.electron, 1)
    assert.equal(report.results.find((r) => r.id === 'T-E1.helper-symlink')?.status, 'skipped')
    assert.ok(report.results.filter((r) => r.id !== 'T-E1.helper-symlink').every((r) => r.status === 'pass'))
    for (const s of rec.spawns) assert.ok(s.cwd.startsWith(join(tmpRoot, BATTERY_SCRATCH_PREFIX)), 'fora da pasta exclusiva')
    assert.equal(report.cleanup?.removed, true)
    assert.equal(rec.lockReleased, 1)
    assert.deepEqual(leftovers(), [])
    assert.ok(rec.logs.some((l) => /T-E1\.extra-arg: iniciado PID \d+, imagem gerpro-helper-host-test\.exe \(SHA-256 4b7f9c7f5ddf…\)/.test(l)))
  })

  it('argumentos e layout de cada caso de T-E1', async () => {
    const seen = new Map<string, { args: readonly string[]; files: string[]; launcher: string; stdout: string }>()
    const { deps: d } = deps({}, {
      run: (cwd) => {
        const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name).slice(cwd.length + 1)]))
        seen.set(basename(cwd).slice(3), { args: lastArgs, files: walk(cwd).sort(), launcher: lastExe.slice(cwd.length + 1), stdout: lastStdout })
        return { pid: 1, done: Promise.resolve(expectedRun(cwd)), kill: () => {} }
      }
    })
    let lastArgs: readonly string[] = []
    let lastExe = ''
    let lastStdout = ''
    const inner = d.spawnLauncher
    d.spawnLauncher = (executable, args, stdout, cwd) => {
      lastArgs = args
      lastExe = executable
      lastStdout = stdout
      return inner(executable, args, stdout, cwd)
    }
    await runBattery(d, ['T-E1'])
    const hash = '8616bddbd4a7f530f9c48b5abd55ee3ea14fdc1b4dcdbfaf1a23e61ad4c6ac44'
    assert.deepEqual(seen.get('T-E1.extra-arg')?.args, ['--protocol', '1', '--helper-sha256', hash, 'x'])
    assert.deepEqual(seen.get('T-E1.uppercase-hash')?.args.at(-1), hash.toUpperCase())
    assert.deepEqual(seen.get('T-E1.protocol-2')?.args.slice(0, 2), ['--protocol', '2'])
    assert.equal(seen.get('T-E1.stdout-not-pipe')?.stdout, 'ignore')
    assert.equal(seen.get('T-E1.wrong-folder')?.launcher, 'other\\win32-x64\\gerpro-helper-host-test.exe')
    assert.equal(seen.get('T-E1.renamed-launcher')?.launcher, 'host-test\\win32-x64\\gerpro-helper-host-test-renamed.exe')
    assert.deepEqual(seen.get('T-E1.helper-missing')?.files, ['host-test\\win32-x64\\gerpro-helper-host-test.exe'])
    assert.notEqual(seen.get('T-E1.other-scenario-hash')?.args.at(-1), hash)
    const modified = seen.get('T-E1.modified-helper')!
    assert.match(modified.args.at(-1)!, /^[0-9a-f]{64}$/)
    assert.notEqual(modified.args.at(-1), hash)
  })
})

describe('bateria: reprovação, prazo e sobreviventes', () => {
  it('resultado diferente do esperado: para e não roda os casos seguintes', async () => {
    const { deps: d, rec } = deps({}, { run: () => ({ pid: 5, done: Promise.resolve({ exitCode: 0, stdout: 'gerpro-synthetic scenario=exit-ok\n', stderrBytes: 0, exitMs: 1, closeMs: 2, spawnError: null }), kill: () => {} }) })
    const report = await runBattery(d, GROUP_A_TESTS)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.equal(rec.spawns.length, 1)
    assert.equal(report.results[0]!.status, 'fail')
    assert.ok(report.results.slice(1).every((r) => r.status === 'not-run'))
    assert.deepEqual(leftovers(), [])
    assert.equal(rec.lockReleased, 1)
  })

  it('prazo global: encerra só o processo iniciado, pelo próprio identificador, e reprova', async () => {
    let killed = 0
    let resolveDone!: (r: RawRun) => void
    const { deps: d } = deps(
      { deadline: () => ({ reached: Promise.resolve(), cancel: () => {} }) },
      {
        run: () => ({
          pid: 9,
          done: new Promise<RawRun>((r) => (resolveDone = r)),
          kill: () => {
            killed++
            resolveDone({ exitCode: null, stdout: '', stderrBytes: 0, exitMs: 5_000, closeMs: 5_001, spawnError: null })
          }
        })
      }
    )
    const report = await runBattery(d, ['T-E1'])
    assert.equal(killed, 1)
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.ok(report.results[0]!.messages.some((m) => m.includes('prazo global')))
  })

  it('processo que não confirma o fim depois de encerrado: situação incerta, para', async () => {
    const { deps: d } = deps({ deadline: () => ({ reached: Promise.resolve(), cancel: () => {} }) }, { run: () => ({ pid: 9, done: new Promise<RawRun>(() => {}), kill: () => {} }) })
    const report = await runBattery(d, ['T-E1'])
    assert.equal(report.exitCode, BATTERY_EXIT.caseFailed)
    assert.ok(report.results[0]!.messages.some((m) => m.includes('situação incerta')))
  })

  it('sobrevivente: nada é encerrado, identidades registradas, bateria para (inspeção manual)', async () => {
    let calls = 0
    let ownedPath = ''
    const created = filetimeFromMs(Date.now() + 60_000)
    const census = (): ProcessIdentity[] => {
      calls++
      if (calls === 1) return [] // pré-condição
      return [
        { pid: 501, ppid: 1, created, path: ownedPath },
        { pid: 502, ppid: 1, created, path: 'C:\\outro\\gerpro-synthetic-helper.exe' }
      ]
    }
    const { deps: d, rec } = deps({}, {
      census,
      run: (cwd) => {
        ownedPath = join(cwd, 'host-test', 'win32-x64', 'gerpro-synthetic-helper.exe')
        return { pid: 3, done: Promise.resolve(expectedRun(cwd)), kill: () => {} }
      }
    })
    const report = await runBattery(d, ['T-H1'])
    assert.equal(report.exitCode, BATTERY_EXIT.survivors)
    assert.deepEqual(report.survivors, { owned: 1, foreign: 1 })
    assert.equal(rec.spawns.length, 1, 'nenhum caso depois do sobrevivente')
    assert.ok(rec.logs.some((l) => l.includes('PID 501') && l.includes('NÃO encerrado')))
    assert.ok(rec.logs.some((l) => l.includes('PID 502') && l.includes('não tocado')))
    assert.equal(report.cleanup?.removed !== undefined, true)
    assert.equal(rec.lockReleased, 1)
  })

  it('Electron de teste com processo ainda ativo depois do caso: para, sem encerrar', async () => {
    const created = filetimeFromMs(Date.now() + 60_000)
    const old = filetimeFromMs(Date.now() - 3_600_000)
    let reads = 0
    const electronCensus = (): ProcessIdentity[] => {
      reads++
      return [
        { pid: 801, ppid: 800, created, path: ELECTRON_EXE.toUpperCase() },
        { pid: 900, ppid: 1, created: old, path: ELECTRON_EXE }, // outra instância, anterior ao caso: ignorada
        { pid: 901, ppid: 1, created, path: 'C:\\outro\\electron.exe' } // outro Electron: ignorado
      ]
    }
    const { deps: d, rec } = deps({}, { electronCensus })
    const report = await runBattery(d, ['T-R1'])
    assert.equal(report.exitCode, BATTERY_EXIT.survivors)
    assert.equal(reads, 3, 'três leituras na janela de limpeza')
    assert.ok(rec.logs.some((l) => l.includes('PID 801') && l.includes('NÃO encerrado')))
    assert.ok(!rec.logs.some((l) => l.includes('PID 900') || l.includes('PID 901')))
  })

  it('Electron de teste: só a instância e os filhos criados no caso contam; filhos que saem na janela não reprovam', async () => {
    const created = filetimeFromMs(Date.now() + 60_000)
    let reads = 0
    const electronCensus = (): ProcessIdentity[] => (++reads === 1 ? [{ pid: 801, ppid: 800, created, path: ELECTRON_EXE }] : [])
    const { deps: d } = deps({}, { electronCensus })
    const report = await runBattery(d, ['T-R1'])
    assert.equal(report.exitCode, BATTERY_EXIT.ok)
    assert.equal(reads, 2)
  })

  it('censo do Electron indisponível: para', async () => {
    const { deps: d } = deps({}, { electronCensus: () => null })
    assert.equal((await runBattery(d, ['T-R1'])).exitCode, BATTERY_EXIT.survivors)
  })

  it('interrupção pedida: nenhum caso novo começa', async () => {
    const { deps: d, rec } = deps({ stopRequested: () => true })
    const report = await runBattery(d, GROUP_A_TESTS)
    assert.equal(report.exitCode, BATTERY_EXIT.interrupted)
    assert.equal(rec.spawns.length, 0)
    assert.deepEqual(leftovers(), [])
  })
})

describe('conferência dos artefatos reais', () => {
  it('sem os arquivos: problemas listados, nenhum conjunto aceito', () => {
    const r = validateArtifacts(fs, join(tmpRoot, 'vazio'))
    assert.equal(r.set, null)
    assert.ok(r.issues.some((i) => i.startsWith('gerpro-helper-host-test.exe: não lido')))
  })

  it('arquivo com o nome certo e conteúdo errado: recusado pelo hash e pelo PE', () => {
    const dir = join(tmpRoot, 'falsos')
    mkdirSync(join(dir, 'scenarios', 'exit-ok'), { recursive: true })
    writeFileSync(join(dir, 'gerpro-helper-host-test.exe'), Buffer.alloc(115_200))
    writeFileSync(join(dir, 'scenarios', 'exit-ok', 'gerpro-synthetic-helper.exe'), Buffer.alloc(106_496))
    writeFileSync(join(dir, 'test-manifest.json'), '{}')
    const r = validateArtifacts(fs, dir, ['exit-ok'])
    assert.equal(r.set, null)
    assert.ok(r.issues.some((i) => i.includes('gerpro-helper-host-test.exe: tamanho ou SHA-256')))
    assert.ok(r.issues.some((i) => i.includes('alvo exit-ok: tamanho ou SHA-256')))
    assert.ok(r.issues.some((i) => i.includes('test-manifest.json: launcher diferente')))
  })

  it('os artefatos compilados nesta máquina (se existirem) passam na conferência', (t) => {
    const dir = join(import.meta.dirname, '../../native/helper-host/build/test/x64')
    if (!existsSync(join(dir, 'test-manifest.json'))) return t.skip('build de testes ausente')
    const r = validateArtifacts(fs, dir)
    assert.deepEqual(r.issues, [])
    assert.ok(r.set !== null)
  })
})

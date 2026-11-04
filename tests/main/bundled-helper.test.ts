import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe, it, mock } from 'node:test'
import {
  BundledHelperRunner,
  DXCORE_HELPER,
  DXCORE_HELPER_SHA256,
  isTrustedRoot,
  type HelperFileStat,
  type HelperFs,
  type HelperRunResult
} from '../../src/main/hardware/local/bundled-helper'
import { COMMAND_LIMITS, type SpawnedProcess, type SpawnFn, type SpawnOptions } from '../../src/main/hardware/local/command-runner'
import { DXCORE_HELPER_ARGS, DXCORE_LIMITS } from '../../src/main/hardware/local/dxcore-contract'
import { interpretHelperResult } from '../../src/main/hardware/local/dxcore/parser'
import { selectGpuList } from '../../src/main/hardware/local/dxcore/selection'
import type { GpuProbeResult } from '../../src/main/hardware/local/probes/gpu'

// Executor do auxiliar empacotado com arquivos e processos SIMULADOS: nenhum
// executável existe, nada é lido do disco e nenhum processo é iniciado.

const ROOT = 'C:\\Program Files\\Gerpro Studio\\resources'
const HELPER_PATH = `${ROOT}\\helpers\\win32-x64\\gerpro-dxcore-helper.exe`
const ARM_PATH = `${ROOT}\\helpers\\win32-arm64\\gerpro-dxcore-helper.exe`
const WINDOWS_ENV = { SystemRoot: 'C:\\Windows', PATH: 'C:\\pasta-do-usuario;C:\\ferramentas', SEGREDO: 'valor', NODE_OPTIONS: '--require x' }
const CONTENT = Buffer.alloc(4_096, 0x4d)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const HASHES = { x64: sha(CONTENT), arm64: sha(CONTENT) }
const VALID_STDOUT = JSON.stringify({ protocol: 'gerpro.dxcore-adapters', version: 1, adapters: [] })
const tick = () => new Promise<void>((r) => setImmediate(r))

/** Arquivo simulado; `realpath` diferente simula junção ou link numa pasta do caminho. */
interface FakeEntry {
  type: 'file' | 'symlink' | 'directory'
  content: Buffer
  size?: number
  ino?: number
  mtimeMs?: number
  realpath?: string
  lstatError?: string
  readError?: string
  realpathError?: string
}

function fakeFs(entries: Record<string, FakeEntry>) {
  const calls: string[] = []
  const find = (path: string) => entries[path] ?? Object.entries(entries).find(([k]) => k.toLowerCase() === path.toLowerCase())?.[1]
  const fail = (code: string) => Object.assign(new Error(`${code}: C:\\Users\\fulano`), { code })
  const fs: HelperFs = {
    async lstat(path) {
      calls.push(`lstat ${path}`)
      const e = find(path)
      if (!e) throw fail('ENOENT')
      if (e.lstatError) throw fail(e.lstatError)
      const stat: HelperFileStat = {
        isFile: () => e.type === 'file',
        isSymbolicLink: () => e.type === 'symlink',
        size: e.size ?? e.content.length,
        dev: 7,
        ino: e.ino ?? 42,
        mtimeMs: e.mtimeMs ?? 1_000
      }
      return stat
    },
    async realpath(path) {
      calls.push(`realpath ${path}`)
      const e = find(path)
      if (!e) throw fail('ENOENT')
      if (e.realpathError) throw fail(e.realpathError)
      return e.realpath ?? path
    },
    async readFile(path) {
      calls.push(`readFile ${path}`)
      const e = find(path)
      if (!e) throw fail('ENOENT')
      if (e.readError) throw fail(e.readError)
      return e.content
    }
  }
  return { fs, calls }
}

/** Processo simulado, controlado pelo teste. */
class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kills = 0
  diesOnKill = true
  killThrows = false
  kill(): boolean {
    this.kills++
    if (this.killThrows) throw new Error('acesso negado')
    if (this.diesOnKill) setImmediate(() => this.emit('close', null, 'SIGTERM'))
    return true
  }
  out(text: string | Buffer) {
    this.stdout.emit('data', Buffer.isBuffer(text) ? text : Buffer.from(text))
  }
  err(text: string) {
    this.stderr.emit('data', Buffer.from(text))
  }
  exit(code: number) {
    this.emit('close', code, null)
  }
}

interface HarnessOptions {
  entries?: Record<string, FakeEntry>
  root?: unknown
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  hashes?: { x64: string | null; arm64: string | null } | null
  spawnError?: string
}

function harness(o: HarnessOptions = {}) {
  const { fs, calls: fsCalls } = fakeFs(o.entries ?? { [HELPER_PATH]: { type: 'file', content: CONTENT } })
  const calls: Array<{ file: string; args: readonly string[]; options: SpawnOptions }> = []
  const processes: FakeProcess[] = []
  const spawn: SpawnFn = (file, args, options) => {
    calls.push({ file, args: [...args], options })
    const p = new FakeProcess()
    processes.push(p)
    if (o.spawnError) setImmediate(() => p.emit('error', Object.assign(new Error(o.spawnError), { code: o.spawnError })))
    return p
  }
  const runner = new BundledHelperRunner({
    resourcesRoot: (o.root === undefined ? ROOT : o.root) as string,
    ...(o.hashes === null ? {} : { expectedSha256: o.hashes ?? HASHES }),
    fs,
    spawn,
    platform: o.platform ?? 'win32',
    arch: o.arch ?? 'x64',
    env: o.env ?? WINDOWS_ENV
  })
  /** Espera o executor chegar ao processo (há leituras assíncronas antes). */
  const spawned = async (count = 1) => {
    for (let i = 0; i < 200 && calls.length < count; i++) await tick()
    assert.equal(calls.length, count, 'processo não iniciado')
    return processes[count - 1]!
  }
  return { runner, calls, processes, fsCalls, spawned }
}

/** Execução completa com o processo simulado terminando de um jeito. */
async function runWith(h: ReturnType<typeof harness>, finish: (p: FakeProcess) => void, signal?: AbortSignal) {
  const pending = h.runner.run(signal)
  finish(await h.spawned(h.calls.length + 1))
  return pending
}

const succeed = (stdout = VALID_STDOUT) => (p: FakeProcess) => {
  p.out(stdout)
  p.exit(0)
}

/** Nenhum resultado carrega caminho, nome de usuário ou mensagem do sistema. */
function assertSanitized(r: HelperRunResult) {
  const text = JSON.stringify(r)
  for (const leak of ['fulano', 'Program Files', 'helpers', 'gerpro-dxcore-helper', 'acesso negado', 'C:\\\\']) assert.ok(!text.includes(leak), `${leak} em ${text}`)
}

const rejectedWith = (r: HelperRunResult, reason: string) => {
  assert.equal(r.kind, 'rejected')
  assert.equal(r.kind === 'rejected' && r.reason, reason)
  assertSanitized(r)
}

describe('auxiliar empacotado: configuração fixa', () => {
  it('nome, pasta, argumentos e limites fixos; configuração congelada', () => {
    assert.ok(Object.isFrozen(DXCORE_HELPER))
    assert.equal(DXCORE_HELPER.fileName, 'gerpro-dxcore-helper.exe')
    assert.equal(DXCORE_HELPER.directory, 'helpers')
    assert.deepEqual([...DXCORE_HELPER.args], ['--protocol', '1'])
    assert.equal(DXCORE_HELPER.args, DXCORE_HELPER_ARGS)
    assert.equal(DXCORE_HELPER.timeoutMs, 3_000)
    assert.equal(DXCORE_HELPER.maxStdoutBytes, DXCORE_LIMITS.maxOutputBytes)
    assert.equal(DXCORE_HELPER.maxStderrBytes, 4_096)
  })

  it('hash de produção ainda nulo: o auxiliar real fica bloqueado (integrity-unknown), sem iniciar processo', async () => {
    assert.ok(Object.isFrozen(DXCORE_HELPER_SHA256))
    assert.deepEqual({ ...DXCORE_HELPER_SHA256 }, { x64: null, arm64: null })
    const h = harness({ hashes: null })
    rejectedWith(await h.runner.run(), 'integrity-unknown')
    assert.equal(h.calls.length, 0)
  })

  it('hash esperado em formato inválido: erro de programação ao criar, nunca ao executar', () => {
    for (const bad of ['', 'ABC', sha(CONTENT).toUpperCase(), sha(CONTENT) + '0', 'g'.repeat(64)]) {
      assert.throws(() => new BundledHelperRunner({ resourcesRoot: ROOT, expectedSha256: { x64: bad, arm64: null } }), /formato inválido/, bad)
    }
  })

  it('criar o executor não lê arquivos nem inicia processos', () => {
    const h = harness()
    assert.equal(h.fsCalls.length, 0)
    assert.equal(h.calls.length, 0)
  })
})

describe('auxiliar empacotado: caminho autorizado e execução', () => {
  it('caminho fixo, argumentos fixos, sem shell, diretório e ambiente mínimos da pasta do sistema', async () => {
    const h = harness()
    const r = await runWith(h, succeed())
    assert.equal(r.kind, 'success')
    assert.equal(r.processExited, true)
    assert.equal(h.calls.length, 1)
    const [call] = h.calls
    assert.equal(call!.file, HELPER_PATH)
    assert.deepEqual(call!.args, ['--protocol', '1'])
    assert.equal(call!.options.shell, false)
    assert.equal(call!.options.windowsVerbatimArguments, false)
    assert.equal(call!.options.windowsHide, true)
    assert.deepEqual(call!.options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(call!.options.cwd, 'C:\\Windows\\System32')
    // Nada do ambiente do app ou do usuário passa adiante (PATH do usuário, NODE_OPTIONS...).
    assert.deepEqual(call!.options.env, { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', PATH: 'C:\\Windows\\System32' })
    assert.deepEqual(interpretHelperResult(r), { status: 'ok', adapters: [] })
  })

  it('arm64: subpasta e hash da arquitetura; outras arquiteturas recusadas sem ler nada', async () => {
    const arm = harness({ arch: 'arm64', entries: { [ARM_PATH]: { type: 'file', content: CONTENT } } })
    assert.equal((await runWith(arm, succeed())).kind, 'success')
    assert.equal(arm.calls[0]!.file, ARM_PATH)
    const armUnknown = harness({ arch: 'arm64', hashes: { x64: HASHES.x64, arm64: null }, entries: { [ARM_PATH]: { type: 'file', content: CONTENT } } })
    rejectedWith(await armUnknown.runner.run(), 'integrity-unknown')
    for (const arch of ['ia32', 'arm', 'x86', '']) {
      const h = harness({ arch })
      rejectedWith(await h.runner.run(), 'unsupported-arch')
      assert.equal(h.fsCalls.length + h.calls.length, 0, arch)
    }
  })

  it('fora do Windows ou sem pasta do sistema: indisponível, sem ler nada', async () => {
    const linux = harness({ platform: 'linux' })
    assert.deepEqual(await linux.runner.run(), { kind: 'unavailable', reason: 'unsupported-platform', commandId: 'gpu.dxcore-adapters', processExited: true, process: 'not-started' })
    const noRoot = harness({ env: { PATH: 'C:\\x' } })
    assert.equal((await noRoot.runner.run()).kind, 'unavailable')
    assert.equal(linux.fsCalls.length + noRoot.fsCalls.length + linux.calls.length + noRoot.calls.length, 0)
  })

  it('argumentos inesperados na chamada são ignorados: nunca viram caminho, argumento ou opção', async () => {
    const h = harness()
    const run = h.runner.run as unknown as (...a: unknown[]) => Promise<HelperRunResult>
    const pending = run.call(h.runner, 'C:\\Windows\\System32\\cmd.exe', ['/c', 'calc'], { shell: true, cwd: 'C:\\Users\\fulano' })
    succeed()(await h.spawned())
    assert.equal((await pending).kind, 'success')
    assert.equal(h.calls[0]!.file, HELPER_PATH)
    assert.deepEqual(h.calls[0]!.args, ['--protocol', '1'])
    assert.equal(h.calls[0]!.options.shell, false)
    assert.equal(h.calls[0]!.options.cwd, 'C:\\Windows\\System32')
  })

  it('caracteres de shell na raiz não executam nada: sem shell, o caminho é um único argumento do sistema', async () => {
    const root = 'C:\\app & calc'
    const path = `${root}\\helpers\\win32-x64\\gerpro-dxcore-helper.exe`
    const h = harness({ root, entries: { [path]: { type: 'file', content: CONTENT } } })
    assert.equal((await runWith(h, succeed())).kind, 'success')
    assert.equal(h.calls[0]!.file, path)
    assert.equal(h.calls[0]!.options.shell, false)
    assert.deepEqual(h.calls[0]!.args, ['--protocol', '1'])
    // Os metacaracteres que o Windows não aceita em nomes são recusados antes de qualquer leitura.
    for (const bad of ['C:\\app | calc', 'C:\\app > x', 'C:\\app "x"', 'C:\\app\nx']) {
      const r = harness({ root: bad })
      rejectedWith(await r.runner.run(), 'location-invalid')
      assert.equal(r.fsCalls.length + r.calls.length, 0, bad)
    }
  })
})

describe('auxiliar empacotado: caminho não autorizado', () => {
  it('raiz fora da política: relativa, de rede, de dispositivo, com `..`, não normalizada, fluxo alternativo ou não texto', async () => {
    const bad: unknown[] = [
      'resources',
      '.\\resources',
      '\\resources',
      '\\\\servidor\\share\\resources',
      '\\\\?\\C:\\app\\resources',
      '\\\\.\\C:\\app',
      'C:\\app\\..\\Windows\\System32',
      'C:\\app\\.\\resources',
      'C:\\app\\\\resources',
      'C:/app/resources',
      'C:\\app/resources',
      'C:\\app:stream',
      'C:resources',
      'C:\\app\\recursos*',
      'C:\\' + 'a'.repeat(300),
      '',
      null,
      42,
      { toString: () => ROOT }
    ]
    for (const root of bad) {
      assert.equal(isTrustedRoot(root), false, String(root))
      const h = harness({ root })
      rejectedWith(await h.runner.run(), 'location-invalid')
      assert.equal(h.fsCalls.length + h.calls.length, 0, String(root))
    }
    for (const root of [ROOT, `${ROOT}\\`, 'D:\\Gerpro', 'C:\\']) assert.equal(isTrustedRoot(root), true, root)
  })

  it('link simbólico no lugar do executável: recusado sem ler nem executar', async () => {
    const h = harness({ entries: { [HELPER_PATH]: { type: 'symlink', content: CONTENT } } })
    rejectedWith(await h.runner.run(), 'symlink')
    assert.equal(h.calls.length, 0)
    assert.ok(!h.fsCalls.some((c) => c.startsWith('readFile')))
  })

  it('junção ou link numa pasta do caminho (caminho real diferente): recusado; só diferença de maiúsculas é aceita', async () => {
    const h = harness({ entries: { [HELPER_PATH]: { type: 'file', content: CONTENT, realpath: 'C:\\Users\\fulano\\AppData\\gerpro-dxcore-helper.exe' } } })
    rejectedWith(await h.runner.run(), 'redirected')
    assert.equal(h.calls.length, 0)
    const caseOnly = harness({ entries: { [HELPER_PATH]: { type: 'file', content: CONTENT, realpath: HELPER_PATH.toUpperCase() } } })
    assert.equal((await runWith(caseOnly, succeed())).kind, 'success')
  })

  it('pasta no lugar do executável: recusada', async () => {
    const h = harness({ entries: { [HELPER_PATH]: { type: 'directory', content: Buffer.alloc(0), size: 4_096 } } })
    rejectedWith(await h.runner.run(), 'not-regular-file')
    assert.equal(h.calls.length, 0)
  })
})

describe('auxiliar empacotado: arquivo ausente, sem permissão ou adulterado', () => {
  it('executável ausente (ou pasta ausente): indisponível, sem iniciar processo', async () => {
    const cases: Array<Record<string, FakeEntry>> = [{}, { [HELPER_PATH]: { type: 'file', content: CONTENT, lstatError: 'ENOTDIR' } }]
    for (const entries of cases) {
      const h = harness({ entries })
      const r = await h.runner.run()
      assert.deepEqual(r, { kind: 'unavailable', reason: 'not-found', commandId: 'gpu.dxcore-adapters', processExited: true, process: 'not-started' })
      assert.equal(h.calls.length, 0)
      assert.deepEqual(interpretHelperResult(r), { status: 'helper-unavailable' })
    }
  })

  it('falha de permissão ao consultar, ler ou iniciar: indisponível, sem mensagem do sistema', async () => {
    for (const entry of [
      { lstatError: 'EACCES' },
      { lstatError: 'EPERM' },
      { readError: 'EACCES' },
      { realpathError: 'EPERM' }
    ]) {
      const h = harness({ entries: { [HELPER_PATH]: { type: 'file', content: CONTENT, ...entry } } })
      const r = await h.runner.run()
      assert.deepEqual(r, { kind: 'unavailable', reason: 'permission-denied', commandId: 'gpu.dxcore-adapters', processExited: true, process: 'not-started' }, JSON.stringify(entry))
      assert.equal(h.calls.length, 0)
    }
    const spawnDenied = harness({ spawnError: 'EACCES' })
    const pending = spawnDenied.runner.run()
    await spawnDenied.spawned()
    const r = await pending
    assert.equal(r.kind, 'unavailable')
    assertSanitized(r)
  })

  it('outros erros de leitura: recusa genérica, sem a mensagem', async () => {
    for (const entry of [{ lstatError: 'EIO' }, { readError: 'EBUSY' }, { realpathError: 'ELOOP' }]) {
      const h = harness({ entries: { [HELPER_PATH]: { type: 'file', content: CONTENT, ...entry } } })
      rejectedWith(await h.runner.run(), 'io-error')
      assert.equal(h.calls.length, 0)
    }
  })

  it('tamanho fora da faixa: recusado antes de ler o conteúdo', async () => {
    for (const size of [0, DXCORE_HELPER.minFileBytes - 1, DXCORE_HELPER.maxFileBytes + 1]) {
      const h = harness({ entries: { [HELPER_PATH]: { type: 'file', content: CONTENT, size } } })
      rejectedWith(await h.runner.run(), 'size-invalid')
      assert.ok(!h.fsCalls.some((c) => c.startsWith('readFile')), String(size))
    }
  })

  it('conteúdo diferente do hash esperado: recusado sem executar', async () => {
    const tampered = Buffer.from(CONTENT)
    tampered[100] = 0x00
    const h = harness({ entries: { [HELPER_PATH]: { type: 'file', content: tampered } } })
    rejectedWith(await h.runner.run(), 'integrity-mismatch')
    assert.equal(h.calls.length, 0)
  })

  it('arquivo mudou entre a consulta e a leitura (tamanho diferente): recusado', async () => {
    const h = harness({ entries: { [HELPER_PATH]: { type: 'file', content: CONTENT, size: CONTENT.length + 10 } } })
    rejectedWith(await h.runner.run(), 'integrity-changed')
    assert.equal(h.calls.length, 0)
  })

  it('arquivo trocado durante a execução (conteúdo, identidade ou data): saída descartada', async () => {
    const changes: Array<(e: FakeEntry) => void> = [
      (e) => (e.content = Buffer.alloc(CONTENT.length, 0x41)),
      (e) => (e.ino = 99),
      (e) => (e.mtimeMs = 2_000),
      (e) => (e.type = 'symlink'),
      (e) => (e.lstatError = 'ENOENT')
    ]
    for (const change of changes) {
      const entry: FakeEntry = { type: 'file', content: CONTENT }
      const h = harness({ entries: { [HELPER_PATH]: entry } })
      const r = await runWith(h, (p) => {
        change(entry)
        succeed()(p)
      })
      rejectedWith(r, 'integrity-changed')
      assert.ok(!('stdout' in r))
      assert.deepEqual(interpretHelperResult(r), { status: 'helper-rejected' })
    }
  })
})

describe('auxiliar empacotado: prazo, cancelamento, limites e códigos de saída', () => {
  it('prazo de 3 s: processo encerrado; resultado só depois de ele terminar', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness()
    const pending = h.runner.run()
    const p = await h.spawned()
    t.mock.timers.tick(DXCORE_HELPER.timeoutMs - 1)
    assert.equal(p.kills, 0)
    t.mock.timers.tick(1)
    assert.equal(p.kills, 1)
    const r = await pending
    assert.equal(r.kind, 'timeout')
    assert.equal(r.processExited, true)
    assert.deepEqual(interpretHelperResult(r), { status: 'timeout' })
  })

  it('cancelamento durante a execução encerra o processo; sinal já cancelado nem lê o arquivo', async () => {
    const h = harness()
    const controller = new AbortController()
    const pending = h.runner.run(controller.signal)
    const p = await h.spawned()
    controller.abort()
    const r = await pending
    assert.equal(r.kind, 'cancelled')
    assert.equal(p.kills, 1)
    assert.equal(r.processExited, true)

    const before = { fs: h.fsCalls.length, spawn: h.calls.length }
    assert.equal((await h.runner.run(AbortSignal.abort())).kind, 'cancelled')
    assert.deepEqual({ fs: h.fsCalls.length, spawn: h.calls.length }, before)
  })

  it('cancelado durante a verificação do arquivo: não inicia o processo', async () => {
    const h = harness()
    const controller = new AbortController()
    const pending = h.runner.run(controller.signal)
    controller.abort()
    assert.equal((await pending).kind, 'cancelled')
    assert.equal(h.calls.length, 0)
  })

  it('processo que não termina ao ser encerrado, ou encerramento que falha: resultado após a tolerância, sinalizado', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    for (const setup of [(p: FakeProcess) => (p.diesOnKill = false), (p: FakeProcess) => (p.killThrows = true)]) {
      const h = harness()
      const pending = h.runner.run()
      const p = await h.spawned()
      setup(p)
      t.mock.timers.tick(DXCORE_HELPER.timeoutMs)
      assert.equal(p.kills, 1)
      t.mock.timers.tick(COMMAND_LIMITS.killGraceMs)
      const r = await pending
      assert.equal(r.kind, 'timeout')
      assert.equal(r.processExited, false)
      assertSanitized(r)
    }
  })

  it('situação do processo: só o encerramento observado conta; o fim da tolerância nunca vira "encerrado"', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    // Terminou sozinho; encerrado a pedido (prazo, cancelamento); não iniciado.
    assert.equal((await runWith(harness(), succeed())).process, 'exited')
    const timedOut = harness()
    const pendingTimeout = timedOut.runner.run()
    await timedOut.spawned()
    t.mock.timers.tick(DXCORE_HELPER.timeoutMs)
    assert.deepEqual([(await pendingTimeout).kind, (await pendingTimeout).process], ['timeout', 'stopped'])
    const controller = new AbortController()
    const cancelled = harness()
    const pendingCancel = cancelled.runner.run(controller.signal)
    await cancelled.spawned()
    controller.abort()
    assert.deepEqual([(await pendingCancel).kind, (await pendingCancel).process], ['cancelled', 'stopped'])
    assert.equal((await harness().runner.run(AbortSignal.abort())).process, 'not-started')
    assert.equal((await harness({ hashes: null }).runner.run()).process, 'not-started')

    // Sem `close` na tolerância: `exit-unconfirmed`; pedido de encerramento com erro: `kill-failed`.
    for (const [configure, expected] of [
      [(p: FakeProcess) => (p.diesOnKill = false), 'exit-unconfirmed'],
      [(p: FakeProcess) => (p.killThrows = true), 'kill-failed']
    ] as const) {
      const h = harness()
      const pending = h.runner.run()
      const p = await h.spawned()
      configure(p)
      t.mock.timers.tick(DXCORE_HELPER.timeoutMs)
      t.mock.timers.tick(COMMAND_LIMITS.killGraceMs)
      const r = await pending
      assert.deepEqual([r.processExited, r.process], [false, expected])
      // O `close` tardio não muda o resultado já devolvido.
      p.exit(0)
      assert.equal(r.process, expected)
    }

    // Pedido de encerramento com erro, mas o `close` chega dentro da tolerância: encerrado, confirmado.
    const late = harness()
    const pendingLate = late.runner.run()
    const p = await late.spawned()
    p.killThrows = true
    t.mock.timers.tick(DXCORE_HELPER.timeoutMs)
    p.emit('close', null, null)
    const r = await pendingLate
    assert.deepEqual([r.processExited, r.process], [true, 'stopped'])
  })

  it('processo anterior sem encerramento confirmado: nenhuma execução nova até ele terminar de fato', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness()
    const first = h.runner.run()
    const orphan = await h.spawned()
    orphan.diesOnKill = false
    t.mock.timers.tick(DXCORE_HELPER.timeoutMs)
    t.mock.timers.tick(COMMAND_LIMITS.killGraceMs)
    assert.equal((await first).process, 'exit-unconfirmed')

    // Enquanto ele pode estar rodando: recusa, sem ler o arquivo nem iniciar outro processo.
    const before = { fs: h.fsCalls.length, spawn: h.calls.length }
    const blocked = await h.runner.run()
    assert.deepEqual(blocked, { kind: 'rejected', reason: 'previous-unconfirmed', commandId: DXCORE_HELPER.id, processExited: true, process: 'not-started' })
    assert.deepEqual(interpretHelperResult(blocked), { status: 'helper-rejected' })
    assert.deepEqual({ fs: h.fsCalls.length, spawn: h.calls.length }, before)

    // Quando o processo enfim termina, a próxima execução volta a valer.
    orphan.exit(0)
    await tick()
    const next = h.runner.run()
    ;(await h.spawned(2)).out(VALID_STDOUT)
    h.processes[1]!.exit(0)
    assert.equal((await next).kind, 'success')
  })

  it('saída excessiva: 64 KiB aceitos; um byte a mais encerra o processo; saída de erro limitada e nunca guardada', async () => {
    const exact = harness()
    const atLimit = await runWith(exact, (p) => {
      p.out(Buffer.alloc(DXCORE_LIMITS.maxOutputBytes, 0x20))
      p.exit(0)
    })
    assert.equal(atLimit.kind, 'success')

    const over = harness()
    const pending = over.runner.run()
    const p = await over.spawned()
    p.out(Buffer.alloc(DXCORE_LIMITS.maxOutputBytes, 0x20))
    p.out('x')
    const r = await pending
    assert.deepEqual(r, { kind: 'failed', reason: 'output-limit', exitCode: null, commandId: 'gpu.dxcore-adapters', processExited: true, process: 'stopped' })
    assert.equal(p.kills, 1)
    assert.deepEqual(interpretHelperResult(r), { status: 'output-limit' })

    const stderr = harness()
    const pendingErr = stderr.runner.run()
    const q = await stderr.spawned()
    q.err('C:\\Users\\fulano '.repeat(400))
    const e = await pendingErr
    assert.equal(e.kind, 'failed')
    assertSanitized(e)
  })

  it('códigos de saída: definidos pelo protocolo, desconhecidos e negativos viram `crashed`; nada da saída é guardado', async () => {
    const cases: Array<[number, string]> = [
      [10, 'dxcore-unavailable'],
      [11, 'factory-failed'],
      [12, 'enumeration-failed'],
      [13, 'output-failed'],
      [64, 'usage'],
      [1, 'crashed'],
      [99, 'crashed'],
      [3221225477, 'crashed'],
      [-1, 'crashed']
    ]
    for (const [code, status] of cases) {
      const h = harness()
      const r = await runWith(h, (p) => {
        p.out('{"segredo":"C:\\\\Users\\\\fulano"}')
        p.exit(code)
      })
      assert.deepEqual(r, { kind: 'failed', reason: 'exit-code', exitCode: code, commandId: 'gpu.dxcore-adapters', processExited: true, process: 'exited' })
      assert.deepEqual(interpretHelperResult(r), { status }, String(code))
    }
  })

  it('duas chamadas simultâneas: uma por vez; a segunda só verifica e inicia depois que a primeira termina', async () => {
    const h = harness()
    const first = h.runner.run()
    const second = h.runner.run()
    const p1 = await h.spawned(1)
    for (let i = 0; i < 20; i++) await tick()
    assert.equal(h.calls.length, 1)
    const lstatsBefore = h.fsCalls.filter((c) => c.startsWith('lstat')).length
    succeed()(p1)
    assert.equal((await first).kind, 'success')
    const p2 = await h.spawned(2)
    assert.ok(h.fsCalls.filter((c) => c.startsWith('lstat')).length > lstatsBefore)
    succeed()(p2)
    assert.equal((await second).kind, 'success')
  })

  it('chamada cancelada enquanto espera a vez: não inicia, e a próxima continua esperando a que está em curso', async () => {
    const h = harness()
    const first = h.runner.run()
    const controller = new AbortController()
    const second = h.runner.run(controller.signal)
    const third = h.runner.run()
    const p1 = await h.spawned(1)
    controller.abort()
    assert.equal((await second).kind, 'cancelled')
    for (let i = 0; i < 20; i++) await tick()
    assert.equal(h.calls.length, 1, 'a terceira não pode rodar junto com a primeira')
    succeed()(p1)
    assert.equal((await first).kind, 'success')
    succeed()(await h.spawned(2))
    assert.equal((await third).kind, 'success')
  })

  it('não grava nada em log', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => mock.method(console, m, () => undefined))
    try {
      await harness({ entries: {} }).runner.run()
      await harness({ entries: { [HELPER_PATH]: { type: 'symlink', content: CONTENT } } }).runner.run()
      const h = harness()
      await runWith(h, (p) => {
        p.err('erro sensível')
        p.exit(1)
      })
      assert.ok(spies.every((s) => s.mock.callCount() === 0))
    } finally {
      spies.forEach((s) => s.mock.restore())
    }
  })
})

describe('auxiliar empacotado: fallback para Electron + Registro', () => {
  it('auxiliar ausente, recusado, inválido ou com falha: a sondagem atual é devolvida sem alteração', async () => {
    // Resultado atual simulado: a seleção tem de devolvê-lo intacto (mesmo objeto).
    const electron = Object.freeze({ marcador: 'resultado atual' }) as unknown as GpuProbeResult
    const registry = { status: 'failed' as const, deviceKeys: null, sizes: null }
    const scenarios: Array<[string, () => Promise<HelperRunResult>, string]> = [
      ['ausente', () => harness({ entries: {} }).runner.run(), 'helper-unavailable'],
      ['hash nulo (produção)', () => harness({ hashes: null }).runner.run(), 'helper-rejected'],
      ['adulterado', () => harness({ entries: { [HELPER_PATH]: { type: 'file', content: Buffer.alloc(CONTENT.length, 1) } } }).runner.run(), 'helper-rejected'],
      ['link', () => harness({ entries: { [HELPER_PATH]: { type: 'symlink', content: CONTENT } } }).runner.run(), 'helper-rejected'],
      ['raiz inválida', () => harness({ root: 'resources' }).runner.run(), 'helper-rejected'],
      ['saída inválida', () => runWith(harness(), succeed('{"protocol":"outro"}')), 'invalid-output'],
      ['código desconhecido', () => runWith(harness(), (p) => p.exit(7)), 'crashed']
    ]
    for (const [label, run, status] of scenarios) {
      const dxcore = interpretHelperResult(await run())
      assert.equal(dxcore.status, status, label)
      const selection = selectGpuList({ dxcore, electron: { result: electron, raw: null }, registry })
      assert.equal(selection.source, 'electron', label)
      assert.equal(selection.result, electron, label)
      assert.equal(selection.rejection, 'source-unavailable', label)
      assert.deepEqual(selection.traces, [], label)
    }
  })
})

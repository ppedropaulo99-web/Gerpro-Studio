import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { DetectionAbortedError } from '../../src/main/hardware/detection-errors'
import { BundledHelperRunner, DXCORE_HELPER, type HelperFs, type HelperRunResult } from '../../src/main/hardware/local/bundled-helper'
import { COMMAND_LIMITS, type CommandResult, type SpawnedProcess, type SpawnFn } from '../../src/main/hardware/local/command-runner'
import { GPU_COMMAND_IDS, type GpuCommandId } from '../../src/main/hardware/local/commands'
import { captureGpuSources } from '../../src/main/hardware/local/dxcore/capture'
import { deviceKeysFrom, parseRegistryOutput, probeGpus, type GpuApi } from '../../src/main/hardware/local/probes/gpu'
import {
  createLocalHardwareDetector,
  LocalHardwareDetector,
  type DxcoreHelper,
  type GpuSourceDiagnostics,
  type LocalDetectionResult,
  type LocalHardwareDetectorDeps
} from '../../src/main/hardware/local/local-hardware-detector'
import { validateHardwareProfile } from '../../src/shared/hardware'

// Integração estrutural do DXCore ao detector local (Etapa 6C.5B), só com
// auxiliar, arquivos, processos, Electron e Registro SIMULADOS: nenhum
// executável é lido ou iniciado e nenhuma API do sistema é consultada.

const GiB = 1024 ** 3
const NOW = new Date('2026-11-03T12:00:00.000Z')
const KEY = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
const reg = (name: string, type: string, entries: Array<[string, string]>) =>
  entries.map(([k, v]) => `${KEY}\\${k}\r\n    ${name}    ${type}    ${v}\r\n`).join('\r\n')
const ok = (commandId: string, stdout: string): CommandResult => ({ kind: 'success', stdout, durationMs: 1, commandId, processExited: true })
const fail = (commandId: string): CommandResult => ({ kind: 'failed', reason: 'exit-code', exitCode: 1, commandId, processExited: true })
const tick = () => new Promise<void>((r) => setImmediate(r))
const ticks = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick()
}

const NVIDIA = { vendorId: 0x10de, deviceId: 0x2504, deviceString: 'NVIDIA GeForce RTX 3060' }
const INTEL = { vendorId: 0x8086, deviceId: 0xa780, deviceString: 'Intel(R) UHD Graphics 770' }
const REGISTRY: Record<GpuCommandId, string> = {
  [GPU_COMMAND_IDS.deviceIds]: reg('MatchingDeviceId', 'REG_SZ', [
    ['0000', 'pci\\ven_10de&dev_2504&subsys_397d1462'],
    ['0001', 'pci\\ven_8086&dev_a780']
  ]),
  [GPU_COMMAND_IDS.memorySizes]: reg('HardwareInformation.qwMemorySize', 'REG_QWORD', [
    ['0000', '0x300000000'],
    ['0001', '0x8000000']
  ])
}

// ── Respostas simuladas do auxiliar (protocolo 1) ───────────────────────────

const LUIDS = { nv: '00000000:0000C0DE', intel: '00000000:0000BEEF', software: '00000000:0000FACE' }
const wireNv = (o: Record<string, unknown> = {}) => ({
  luid: LUIDS.nv,
  vendorId: 0x10de,
  deviceId: 0x2504,
  description: 'NVIDIA GeForce RTX 3060 (DXCore)',
  isHardware: true,
  isIntegrated: false,
  dedicatedAdapterMemory: String(12n * 1024n ** 3n),
  dedicatedSystemMemory: '0',
  sharedSystemMemory: String(16n * 1024n ** 3n),
  ...o
})
const wireIntel = (o: Record<string, unknown> = {}) => ({
  ...wireNv(),
  luid: LUIDS.intel,
  vendorId: 0x8086,
  deviceId: 0xa780,
  description: 'Intel(R) UHD Graphics 770 (DXCore)',
  isIntegrated: true,
  dedicatedAdapterMemory: String(128n * 1024n ** 2n),
  ...o
})
const wireSoftware = () => ({ ...wireNv(), luid: LUIDS.software, vendorId: 0x1414, deviceId: 0x008c, description: 'Microsoft Basic Render Driver', isHardware: false, isIntegrated: null, dedicatedAdapterMemory: '0' })
const stdoutOf = (adapters: unknown[]) => JSON.stringify({ protocol: 'gerpro.dxcore-adapters', version: 1, adapters })
/** Integrada primeiro: a ordem da lista vem do DXCore, não do Electron. */
const VALID_STDOUT = stdoutOf([wireIntel(), wireNv(), wireSoftware()])

const id = DXCORE_HELPER.id
const success = (stdout: string): HelperRunResult => ({ kind: 'success', stdout, durationMs: 5, commandId: id, processExited: true })

/** Auxiliar simulado (sem executor): devolve um resultado pronto e registra as chamadas. */
function scripted(result: HelperRunResult | Error | ((signal: AbortSignal) => Promise<HelperRunResult>)) {
  const signals: AbortSignal[] = []
  const helper: DxcoreHelper = {
    async run(signal) {
      signals.push(signal!)
      if (result instanceof Error) throw result
      return typeof result === 'function' ? result(signal!) : result
    }
  }
  return { helper, signals }
}

// ── Executor real do auxiliar com arquivo e processo simulados ──────────────

const ROOT = 'C:\\Program Files\\Gerpro Studio\\resources'
const HELPER_PATH = `${ROOT}\\helpers\\win32-x64\\gerpro-dxcore-helper.exe`
const CONTENT = Buffer.alloc(4_096, 0x4d)
const HASH = createHash('sha256').update(CONTENT).digest('hex')

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
  succeed(stdout: string) {
    this.stdout.emit('data', Buffer.from(stdout))
    this.emit('close', 0, null)
  }
}

/**
 * `BundledHelperRunner` de verdade sobre `fs` e `spawn` simulados.
 * `hash: null` usa o hash embutido no código (hoje `null`: sempre recusado).
 */
function realRunner(o: { file?: 'file' | 'missing' | 'symlink'; hash?: string | null } = {}) {
  const file = o.file ?? 'file'
  const enoent = () => Object.assign(new Error('ENOENT C:\\Users\\fulano'), { code: 'ENOENT' })
  const fs: HelperFs = {
    async lstat(path) {
      if (file === 'missing' || path.toLowerCase() !== HELPER_PATH.toLowerCase()) throw enoent()
      return { isFile: () => file === 'file', isSymbolicLink: () => file === 'symlink', size: CONTENT.length, dev: 1, ino: 2, mtimeMs: 3 }
    },
    realpath: async (path) => path,
    readFile: async () => CONTENT
  }
  const processes: FakeProcess[] = []
  const spawn: SpawnFn = () => {
    const p = new FakeProcess()
    processes.push(p)
    return p
  }
  const hash = o.hash === undefined ? HASH : o.hash
  const runner = new BundledHelperRunner({
    resourcesRoot: ROOT,
    ...(hash === null ? {} : { expectedSha256: { x64: hash, arm64: hash } }),
    fs,
    spawn,
    platform: 'win32',
    arch: 'x64',
    env: { SystemRoot: 'C:\\Windows' }
  })
  const results: Array<Promise<HelperRunResult>> = []
  const helper: DxcoreHelper = {
    run(signal) {
      const r = runner.run(signal)
      results.push(r)
      return r
    }
  }
  const spawned = async (count = 1) => {
    for (let i = 0; i < 200 && processes.length < count; i++) await tick()
    assert.equal(processes.length, count, 'processo não iniciado')
    return processes[count - 1]!
  }
  return { runner, helper, processes, results, spawned }
}

// ── Detector com dependências simuladas ─────────────────────────────────────

function setup(o: Partial<LocalHardwareDetectorDeps> & { devices?: unknown[]; registry?: Partial<Record<GpuCommandId, string>> } = {}) {
  const commands: string[] = []
  const registry = o.registry ?? REGISTRY
  const gpu: GpuApi = {
    getGPUInfo: async () => ({ gpuDevice: o.devices ?? [NVIDIA, INTEL] }),
    runCommand: async (cmd: GpuCommandId) => (commands.push(cmd), registry[cmd] === undefined ? fail(cmd) : ok(cmd, registry[cmd]!))
  }
  const deps: LocalHardwareDetectorDeps = {
    storageTarget: { kind: 'app-data', path: 'C:\\Users\\fulano\\AppData\\Roaming\\Gerpro Studio\\storage' },
    cpu: { cpus: () => Array.from({ length: 8 }, () => ({ model: 'CPU Sintética' })), machine: () => 'x86_64', arch: () => 'x64', availableParallelism: () => 8 },
    memory: { totalmem: () => 32 * GiB, freemem: () => 20 * GiB, platform: () => 'win32' },
    os: { platform: () => 'win32', release: () => '10.0.26200', version: () => 'Windows 11 Pro', machine: () => 'x86_64' },
    storage: { statfs: async () => ({ bsize: 4096, blocks: (1000 * GiB) / 4096, bavail: (400 * GiB) / 4096 }), platform: 'win32' },
    gpu,
    platform: 'win32',
    now: () => NOW,
    ...o
  }
  return { detector: new LocalHardwareDetector(deps), commands }
}

const NOT_QUERIED: GpuSourceDiagnostics = {
  source: 'electron',
  dxcoreStatus: 'not-queried',
  parseError: null,
  rejection: null,
  traces: [],
  helperStop: null,
  helperProcess: 'not-queried'
}
const isAborted = (reason: 'cancelled' | 'timeout') => (e: unknown) => e instanceof DetectionAbortedError && e.reason === reason
const withoutSource = (r: LocalDetectionResult) => {
  const { gpuSource: _, ...rest } = r.diagnostics
  return rest
}

/**
 * Paridade do fallback: com o auxiliar falhando, perfil e diagnóstico (exceto
 * a fonte da GPU) iguais, por `deepEqual`, aos do detector sem DXCore; as
 * consultas ao Registro também são as mesmas (nenhuma a mais).
 */
async function assertFallbackParity(dxcore: DxcoreHelper, o: Parameters<typeof setup>[0] = {}): Promise<GpuSourceDiagnostics> {
  const base = setup(o)
  const without = await base.detector.collect()
  const s = setup({ ...o, dxcore })
  const withDx = await s.detector.collect()
  assert.deepEqual(withDx.profile, without.profile)
  assert.deepEqual(withoutSource(withDx), withoutSource(without))
  assert.deepEqual(without.diagnostics.gpuSource, NOT_QUERIED)
  assert.deepEqual(s.commands, base.commands)
  assert.equal(withDx.diagnostics.gpuSource.source, 'electron')
  assert.deepEqual(withDx.diagnostics.gpuSource.traces, [])
  return withDx.diagnostics.gpuSource
}

describe('detector local + DXCore: sem a dependência', () => {
  it('comportamento idêntico ao de antes: fonte Electron, DXCore não consultado', async () => {
    const { profile, diagnostics } = await setup().detector.collect()
    assert.ok(validateHardwareProfile(profile).ok)
    assert.deepEqual(diagnostics.gpuSource, NOT_QUERIED)
    assert.deepEqual(profile.gpus, [
      { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3060', vramGb: 12, sharedMemory: null },
      { vendor: 'intel', model: 'Intel(R) UHD Graphics 770', vramGb: 0.13, sharedMemory: null }
    ])
  })

  it('montagem de produção: sem raiz, ou raiz nula, não há auxiliar; com raiz, nada roda ao montar', () => {
    let gpuCalls = 0
    const getGPUInfo = async () => (gpuCalls++, {})
    for (const helperResourcesRoot of [undefined, null, ROOT, 'relativo']) {
      const detector = createLocalHardwareDetector({ storageTarget: null, getGPUInfo, helperResourcesRoot })
      assert.ok(detector instanceof LocalHardwareDetector)
    }
    assert.equal(gpuCalls, 0)
  })
})

describe('detector local + DXCore: lista do DXCore aceita (auxiliar simulado)', () => {
  it('saída válida: lista e ordem do DXCore, classificação de memória, VRAM confirmada pelo Registro', async () => {
    const { helper, signals } = scripted(success(VALID_STDOUT))
    const s = setup({ dxcore: helper })
    const { profile, diagnostics } = await s.detector.collect()
    assert.ok(validateHardwareProfile(profile).ok)
    assert.deepEqual(profile.gpus, [
      { vendor: 'intel', model: 'Intel(R) UHD Graphics 770 (DXCore)', vramGb: null, sharedMemory: true },
      { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3060 (DXCore)', vramGb: 12, sharedMemory: false }
    ])
    assert.deepEqual(profile.provenance.quality.gpus, [
      { vendor: 'detected', model: 'detected', vramGb: 'unavailable', sharedMemory: 'detected' },
      { vendor: 'detected', model: 'detected', vramGb: 'detected', sharedMemory: 'detected' }
    ])
    assert.deepEqual(diagnostics.gpuSource, {
      source: 'dxcore',
      dxcoreStatus: 'ok',
      parseError: null,
      rejection: null,
      traces: [
        { vram: 'not-dedicated', registry: 'match' },
        { vram: 'registry-confirmed', registry: 'match' }
      ],
      helperStop: null,
      // Simulação sem a situação do processo: fica `unknown`, nunca presumida.
      helperProcess: 'unknown'
    })
    assert.deepEqual(diagnostics.gpuReasons, [{ vramGb: 'not-dedicated' }, {}])
    // O software renderer do DXCore é ignorado; o Registro foi lido uma vez por consulta.
    assert.equal(diagnostics.ignoredGpus, 1)
    assert.equal(diagnostics.gpuRegistry, 'ok')
    assert.deepEqual(s.commands, [GPU_COMMAND_IDS.deviceIds, GPU_COMMAND_IDS.memorySizes])
    // Uma execução por coleta, com um sinal.
    assert.equal(signals.length, 1)
    assert.ok(signals[0] instanceof AbortSignal)
  })

  it('diagnóstico sanitizado: sem LUID, identificador PCI, nome, caminho ou saída do auxiliar', async () => {
    const { helper } = scripted(success(VALID_STDOUT))
    const { diagnostics } = await setup({ dxcore: helper }).detector.collect()
    const text = JSON.stringify(diagnostics)
    for (const forbidden of [
      ...Object.values(LUIDS),
      'C0DE',
      '10de',
      '4318',
      '2504',
      'a780',
      'NVIDIA',
      'Intel',
      'DXCore)',
      'gerpro.dxcore',
      'Program Files',
      'helpers',
      'fulano',
      'HKEY'
    ]) {
      assert.ok(!text.includes(forbidden), forbidden)
    }
    // Só chaves enumeradas.
    assert.deepEqual(Object.keys(diagnostics.gpuSource).sort(), ['dxcoreStatus', 'helperProcess', 'helperStop', 'parseError', 'rejection', 'source', 'traces'])
  })

  it('executor real com arquivo e processo simulados (hash de teste): mesma lista', async () => {
    const r = realRunner()
    const pending = setup({ dxcore: r.helper }).detector.collect()
    ;(await r.spawned()).succeed(VALID_STDOUT)
    const { diagnostics, profile } = await pending
    assert.equal(diagnostics.gpuSource.source, 'dxcore')
    assert.equal(profile.gpus![1]!.sharedMemory, false)
    assert.equal(r.results.length, 1)
  })
})

describe('detector local + DXCore: fallback para Electron + Registro (paridade por deepEqual)', () => {
  it('auxiliar ausente', async () => {
    const source = await assertFallbackParity(realRunner({ file: 'missing' }).helper)
    assert.equal(source.dxcoreStatus, 'helper-unavailable')
    assert.equal(source.rejection, 'source-unavailable')
    assert.deepEqual([source.helperStop, source.helperProcess], [null, 'not-started'])
  })

  it('hash não configurado (o embutido, hoje null): recusado sem iniciar processo', async () => {
    const r = realRunner({ hash: null })
    const source = await assertFallbackParity(r.helper)
    assert.equal(source.dxcoreStatus, 'helper-rejected')
    assert.equal(source.helperProcess, 'not-started')
    assert.equal(r.processes.length, 0)
    assert.equal((await r.results[0]!).kind, 'rejected')
  })

  it('executável recusado (link) ou com hash diferente', async () => {
    for (const r of [realRunner({ file: 'symlink' }), realRunner({ hash: 'f'.repeat(64) })]) {
      assert.equal((await assertFallbackParity(r.helper)).dxcoreStatus, 'helper-rejected')
      assert.equal(r.processes.length, 0)
    }
  })

  it('erros do auxiliar: exceção, código de saída do protocolo, encerramento anormal, falha ao iniciar', async () => {
    const cases: Array<[HelperRunResult | Error, string]> = [
      [new Error('inesperado C:\\Users\\fulano'), 'helper-unavailable'],
      [{ kind: 'failed', reason: 'exit-code', exitCode: 11, commandId: id, processExited: true }, 'factory-failed'],
      [{ kind: 'failed', reason: 'exit-code', exitCode: 13, commandId: id, processExited: true }, 'output-failed'],
      [{ kind: 'failed', reason: 'exit-code', exitCode: -1073741819, commandId: id, processExited: true }, 'crashed'],
      [{ kind: 'failed', reason: 'spawn-error', exitCode: null, commandId: id, processExited: true }, 'helper-unavailable'],
      [{ kind: 'failed', reason: 'output-limit', exitCode: null, commandId: id, processExited: true }, 'output-limit'],
      [{ kind: 'cancelled', commandId: id, processExited: true }, 'cancelled']
    ]
    for (const [result, status] of cases) {
      const source = await assertFallbackParity(scripted(result).helper)
      assert.equal(source.dxcoreStatus, status, status)
      assert.equal(source.rejection, 'source-unavailable')
    }
  })

  it('tempo esgotado do auxiliar (resultado do executor)', async () => {
    const source = await assertFallbackParity(scripted({ kind: 'timeout', durationMs: 3_000, commandId: id, processExited: true }).helper)
    assert.equal(source.dxcoreStatus, 'timeout')
  })

  it('saída inválida: só o código do erro de leitura vai ao diagnóstico', async () => {
    for (const stdout of ['não é JSON C:\\Users\\fulano', stdoutOf([wireNv({ luid: 'abc' })]), JSON.stringify({ protocol: 'outro', version: 1, adapters: [] })]) {
      const source = await assertFallbackParity(scripted(success(stdout)).helper)
      assert.equal(source.dxcoreStatus, 'invalid-output')
      assert.equal(typeof source.parseError, 'string')
      assert.ok(!JSON.stringify(source).includes('fulano'))
    }
  })

  it('lista do DXCore incoerente: LUID repetido, hardware indefinido, nenhum adaptador de hardware', async () => {
    const cases: Array<[unknown[], string]> = [
      [[wireNv(), wireIntel({ luid: LUIDS.nv })], 'luid-duplicate'],
      [[wireNv({ isHardware: null }), wireIntel()], 'hardware-flag-unknown'],
      [[wireSoftware()], 'no-hardware-adapters'],
      [[wireNv({ luid: '00000000:00000000' }), wireIntel()], 'luid-invalid']
    ]
    for (const [adapters, rejection] of cases) {
      const source = await assertFallbackParity(scripted(success(stdoutOf(adapters))).helper)
      assert.equal(source.dxcoreStatus, 'ok')
      assert.equal(source.rejection, rejection, rejection)
    }
  })

  it('composição PCI diferente da do Electron: lista inteira descartada, nada é associado por nome ou posição', async () => {
    const cases = [
      stdoutOf([wireNv()]),
      stdoutOf([wireNv(), wireIntel(), wireNv({ luid: '00000000:00000ABC' })]),
      stdoutOf([wireNv({ deviceId: 0x2505 }), wireIntel()])
    ]
    for (const stdout of cases) {
      const source = await assertFallbackParity(scripted(success(stdout)).helper)
      assert.equal(source.rejection, 'lists-disagree')
    }
    // Electron com um adaptador sem par: composição desconhecida, também descartada.
    const source = await assertFallbackParity(scripted(success(VALID_STDOUT)).helper, { devices: [NVIDIA, { deviceString: 'Sem par' }] })
    assert.equal(source.rejection, 'lists-disagree')
  })

  it('Registro indisponível não muda a paridade do fallback', async () => {
    await assertFallbackParity(scripted(new Error('x')).helper, { registry: {} })
  })
})

describe('detector local + DXCore: cancelamento, prazos e paralelismo (relógio e executor simulados)', () => {
  it('cancelado antes da execução: nada roda (nem o auxiliar, nem o Registro)', async () => {
    const r = realRunner()
    const s = setup({ dxcore: r.helper })
    await assert.rejects(s.detector.collect(AbortSignal.abort()), isAborted('cancelled'))
    assert.equal(r.results.length, 0)
    assert.equal(r.processes.length, 0)
    assert.deepEqual(s.commands, [])
  })

  it('cancelado enquanto o auxiliar espera na fila: rejeita sem perfil e não inicia outro processo', async () => {
    const r = realRunner()
    // Uma execução anterior ainda em curso no mesmo executor.
    const previous = r.runner.run()
    const first = await r.spawned()
    const controller = new AbortController()
    const pending = setup({ dxcore: r.helper }).detector.collect(controller.signal)
    for (let i = 0; i < 50 && r.results.length === 0; i++) await tick()
    assert.equal(r.results.length, 1)
    controller.abort()
    await assert.rejects(pending, isAborted('cancelled'))
    assert.equal((await r.results[0]!).kind, 'cancelled')
    first.succeed(VALID_STDOUT)
    assert.equal((await previous).kind, 'success')
    await ticks()
    assert.equal(r.processes.length, 1)
  })

  it('cancelado durante a execução: o processo é encerrado e a coleta rejeita', async () => {
    const r = realRunner()
    const controller = new AbortController()
    const pending = setup({ dxcore: r.helper }).detector.collect(controller.signal)
    const p = await r.spawned()
    controller.abort()
    await assert.rejects(pending, isAborted('cancelled'))
    await ticks()
    assert.equal(p.kills, 1)
    const result = await r.results[0]!
    assert.equal(result.kind, 'cancelled')
    assert.equal(result.processExited, true)
    assert.equal(result.process, 'stopped')
  })

  it('prazo global vence com o auxiliar em execução: rejeita como tempo esgotado', async () => {
    const r = realRunner()
    const pending = setup({ dxcore: r.helper }).detector.collect(AbortSignal.timeout(30))
    const p = await r.spawned()
    await assert.rejects(pending, isAborted('timeout'))
    await ticks()
    assert.equal(p.kills, 1)
  })

  it('prazo do auxiliar (3 s): processo encerrado, fallback com paridade', async (t) => {
    const base = await setup().detector.collect()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const r = realRunner()
    const pending = setup({ dxcore: r.helper }).detector.collect()
    const p = await r.spawned()
    t.mock.timers.tick(DXCORE_HELPER.timeoutMs - 1)
    assert.equal(p.kills, 0)
    t.mock.timers.tick(1)
    assert.equal(p.kills, 1)
    const result = await pending
    assert.deepEqual(result.profile, base.profile)
    assert.deepEqual(withoutSource(result), withoutSource(base))
    assert.equal(result.diagnostics.gpuSource.dxcoreStatus, 'timeout')
    assert.deepEqual([result.diagnostics.gpuSource.helperStop, result.diagnostics.gpuSource.helperProcess], ['helper-timeout', 'stopped'])
  })

  it('processo que demora a encerrar, ou encerramento com erro: a coleta espera só a tolerância, segue com o fallback e NÃO presume o encerramento', async (t) => {
    const base = await setup().detector.collect()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    for (const [configure, expected] of [
      [(p: FakeProcess) => (p.diesOnKill = false), 'exit-unconfirmed'],
      [(p: FakeProcess) => (p.killThrows = true), 'kill-failed']
    ] as const) {
      const r = realRunner()
      let settled = false
      const pending = setup({ dxcore: r.helper })
        .detector.collect()
        .finally(() => (settled = true))
      const p = await r.spawned()
      configure(p)
      t.mock.timers.tick(DXCORE_HELPER.timeoutMs)
      assert.equal(p.kills, 1)
      await ticks()
      assert.equal(settled, false)
      t.mock.timers.tick(COMMAND_LIMITS.killGraceMs)
      const result = await pending
      assert.equal((await r.results[0]!).processExited, false)
      assert.deepEqual(result.profile, base.profile)
      assert.deepEqual(withoutSource(result), withoutSource(base))
      assert.equal(result.diagnostics.gpuSource.dxcoreStatus, 'timeout')
      assert.deepEqual([result.diagnostics.gpuSource.helperStop, result.diagnostics.gpuSource.helperProcess], ['helper-timeout', expected])
    }
  })

  it('processo anterior possivelmente órfão: a coleta seguinte não inicia outro, cai no fallback e volta ao normal quando ele termina', async (t) => {
    const base = await setup().detector.collect()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const r = realRunner()
    const first = setup({ dxcore: r.helper }).detector.collect()
    const orphan = await r.spawned()
    orphan.diesOnKill = false
    t.mock.timers.tick(DXCORE_HELPER.timeoutMs)
    t.mock.timers.tick(COMMAND_LIMITS.killGraceMs)
    assert.equal((await first).diagnostics.gpuSource.helperProcess, 'exit-unconfirmed')

    const second = await setup({ dxcore: r.helper }).detector.collect()
    assert.equal(r.processes.length, 1)
    assert.deepEqual(second.profile, base.profile)
    assert.deepEqual([second.diagnostics.gpuSource.dxcoreStatus, second.diagnostics.gpuSource.helperProcess], ['helper-rejected', 'not-started'])
    assert.deepEqual(await r.results[1]!, { kind: 'rejected', reason: 'previous-unconfirmed', commandId: id, processExited: true, process: 'not-started' })

    orphan.emit('close', null, null)
    await tick()
    const third = setup({ dxcore: r.helper }).detector.collect()
    ;(await r.spawned(2)).succeed(VALID_STDOUT)
    assert.equal((await third).diagnostics.gpuSource.source, 'dxcore')
    // Uma execução por coleta, sem nova tentativa.
    assert.equal(r.results.length, 3)
  })

  it('orçamento da GPU esgotado com o auxiliar em execução: política atual (GPU identificada, VRAM por prazo), auxiliar cancelado', async () => {
    const pendingCommand = (cmd: GpuCommandId, signal?: AbortSignal) =>
      new Promise<CommandResult>((resolve) => signal!.addEventListener('abort', () => resolve({ kind: 'cancelled', commandId: cmd, processExited: true }), { once: true }))
    const o = { budget: { gpuTotalMs: 20 }, gpu: { getGPUInfo: async () => ({ gpuDevice: [NVIDIA, INTEL] }), runCommand: pendingCommand } }
    const without = await setup(o).detector.collect(AbortSignal.timeout(2_000))
    const r = realRunner()
    const withDx = await setup({ ...o, dxcore: r.helper }).detector.collect(AbortSignal.timeout(2_000))
    assert.deepEqual(withDx.profile, without.profile)
    assert.deepEqual(withoutSource(withDx), withoutSource(without))
    assert.equal(withDx.diagnostics.gpuRegistry, 'timeout')
    assert.equal(withDx.diagnostics.gpuSource.dxcoreStatus, 'cancelled')
    // Distinto do cancelamento do usuário (que rejeita a coleta) e do prazo do próprio auxiliar.
    assert.deepEqual([withDx.diagnostics.gpuSource.helperStop, withDx.diagnostics.gpuSource.helperProcess], ['gpu-budget', 'stopped'])
    assert.equal(r.processes[0]!.kills, 1)
  })

  it('falha da fonte Electron: lista do DXCore vale sozinha; sem DXCore válido, igual ao detector sem ele', async () => {
    const broken = { getGPUInfo: async () => Promise.reject(new Error('GPU process C:\\Users\\fulano')), runCommand: async (cmd: GpuCommandId) => ok(cmd, REGISTRY[cmd]) }
    const { profile, diagnostics } = await setup({ gpu: broken, dxcore: scripted(success(VALID_STDOUT)).helper }).detector.collect()
    assert.equal(diagnostics.gpuSource.source, 'dxcore')
    assert.deepEqual(profile.gpus, [
      { vendor: 'intel', model: 'Intel(R) UHD Graphics 770 (DXCore)', vramGb: null, sharedMemory: true },
      { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3060 (DXCore)', vramGb: 12, sharedMemory: false }
    ])
    // A sondagem atual não chega ao Registro sem a lista do Electron; a VRAM vem do próprio adaptador.
    assert.equal(diagnostics.gpuRegistry, 'not-queried')
    assert.deepEqual(diagnostics.gpuSource.traces, [
      { vram: 'not-dedicated', registry: 'registry-unavailable' },
      { vram: 'dxcore', registry: 'registry-unavailable' }
    ])
    const source = await assertFallbackParity(scripted({ kind: 'timeout', durationMs: 3_000, commandId: id, processExited: true }).helper, { gpu: broken })
    assert.equal(source.dxcoreStatus, 'timeout')
  })

  it('operações paralelas com tempos diferentes: mesmo resultado, uma execução do auxiliar, uma consulta por identificador', async () => {
    const outcomes: string[] = []
    for (const helperFirst of [true, false]) {
      const order: string[] = []
      let releaseHelper!: () => void
      let releaseRegistry!: () => void
      const helperGate = new Promise<void>((r) => (releaseHelper = r))
      const registryGate = new Promise<void>((r) => (releaseRegistry = r))
      const { helper, signals } = scripted(async () => (await helperGate, order.push('helper'), success(VALID_STDOUT)))
      const commands: string[] = []
      const gpu: GpuApi = {
        getGPUInfo: async () => ({ gpuDevice: [NVIDIA, INTEL] }),
        runCommand: async (cmd) => (commands.push(cmd), await registryGate, order.push(cmd), ok(cmd, REGISTRY[cmd]))
      }
      const pending = setup({ gpu, dxcore: helper }).detector.collect()
      await ticks()
      if (helperFirst) {
        releaseHelper()
        await ticks()
        releaseRegistry()
      } else {
        releaseRegistry()
        await ticks()
        releaseHelper()
      }
      const result = await pending
      assert.equal(order[0], helperFirst ? 'helper' : GPU_COMMAND_IDS.deviceIds)
      assert.equal(signals.length, 1)
      assert.deepEqual(commands, [GPU_COMMAND_IDS.deviceIds, GPU_COMMAND_IDS.memorySizes])
      outcomes.push(JSON.stringify(result))
    }
    assert.equal(outcomes[0], outcomes[1])
  })
})

describe('captura das fontes da GPU (dxcore/capture)', () => {
  it('transparente: probeGpus com a captura dá o mesmo resultado e as mesmas chamadas', async () => {
    const variants: Array<Partial<Record<GpuCommandId, string>>> = [REGISTRY, {}, { [GPU_COMMAND_IDS.deviceIds]: REGISTRY[GPU_COMMAND_IDS.deviceIds] }]
    for (const registry of variants) {
      const calls: Array<string[]> = [[], []]
      const api = (i: number): GpuApi => ({
        getGPUInfo: async () => (calls[i]!.push('info'), { gpuDevice: [NVIDIA, INTEL] }),
        runCommand: async (cmd) => (calls[i]!.push(cmd), registry[cmd] === undefined ? fail(cmd) : ok(cmd, registry[cmd]!))
      })
      const direct = await probeGpus(api(0))
      const captured = await probeGpus(captureGpuSources(api(1)).api)
      assert.deepEqual(captured, direct)
      assert.deepEqual(calls[1], calls[0])
    }
  })

  it('cada consulta roda no máximo uma vez; repetição recebe a mesma resposta', async () => {
    let runs = 0
    const capture = captureGpuSources({ runCommand: async (cmd) => (runs++, ok(cmd, REGISTRY[cmd])) })
    const a = await capture.api.runCommand!(GPU_COMMAND_IDS.deviceIds)
    const b = await capture.api.runCommand!(GPU_COMMAND_IDS.deviceIds)
    assert.equal(a, b)
    assert.equal(runs, 1)
    await capture.api.runCommand!(GPU_COMMAND_IDS.memorySizes)
    assert.equal(runs, 2)
  })

  it('erros passam iguais; ausência de getGPUInfo/runCommand é preservada', async () => {
    const error = new Error('falhou')
    const capture = captureGpuSources({ getGPUInfo: async () => Promise.reject(error), runCommand: async () => Promise.reject(error) })
    await assert.rejects(capture.api.getGPUInfo!('basic'), (e) => e === error)
    await assert.rejects(capture.api.runCommand!(GPU_COMMAND_IDS.deviceIds), (e) => e === error)
    assert.equal(capture.electronRaw(), null)
    assert.deepEqual(capture.registry('failed'), { status: 'failed', deviceKeys: null, sizes: null })
    assert.deepEqual(Object.keys(captureGpuSources({}).api), [])
    assert.deepEqual(Object.keys(captureGpuSources({ getGPUInfo: async () => ({}) }).api), ['getGPUInfo'])
  })

  it('snapshot do Registro: as respostas já lidas, interpretadas como pela sondagem', async () => {
    const raw = { gpuDevice: [NVIDIA, INTEL] }
    const capture = captureGpuSources({ getGPUInfo: async () => raw, runCommand: async (cmd) => ok(cmd, REGISTRY[cmd]) })
    const probe = await probeGpus(capture.api)
    assert.equal(capture.electronRaw(), raw)
    const ids = parseRegistryOutput(REGISTRY[GPU_COMMAND_IDS.deviceIds], 'MatchingDeviceId')
    assert.deepEqual(capture.registry(probe.registry), {
      status: 'ok',
      deviceKeys: deviceKeysFrom(ids!),
      sizes: parseRegistryOutput(REGISTRY[GPU_COMMAND_IDS.memorySizes], 'HardwareInformation.qwMemorySize')
    })
  })
})

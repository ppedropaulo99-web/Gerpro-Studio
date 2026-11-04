import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { CommandResult } from '../../src/main/hardware/local/command-runner'
import { GPU_COMMAND_IDS, type GpuCommandId } from '../../src/main/hardware/local/commands'
import { DetectionAbortedError } from '../../src/main/hardware/detection-errors'
import { COMMAND_LIMITS } from '../../src/main/hardware/local/command-runner'
import {
  createLocalHardwareDetector,
  DETECTION_BUDGET,
  deriveConfidence,
  LocalHardwareDetector,
  type LocalHardwareDetectorDeps
} from '../../src/main/hardware/local/local-hardware-detector'
import type { CpuApi } from '../../src/main/hardware/local/probes/cpu'
import type { GpuApi } from '../../src/main/hardware/local/probes/gpu'
import type { MemoryApi } from '../../src/main/hardware/local/probes/memory'
import type { OsApi } from '../../src/main/hardware/local/probes/os'
import type { StorageApi } from '../../src/main/hardware/local/probes/storage'
import { PROFILE_FIELDS, validateHardwareProfile, type HardwareProfile } from '../../src/shared/hardware'

// Hardware SIMULADO: nenhuma API do sistema, processo ou Registro real é consultado.

const GiB = 1024 ** 3
const NOW = new Date('2026-11-03T12:00:00.000Z')
const KEY = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
/** Caminho com nome de usuário: não pode aparecer no perfil nem no diagnóstico. */
const APP_DATA = 'C:\\Users\\fulano\\AppData\\Roaming\\Gerpro Studio\\storage'

const reg = (name: string, type: string, entries: Array<[string, string]>) =>
  entries.map(([k, v]) => `${KEY}\\${k}\r\n    ${name}    ${type}    ${v}\r\n`).join('\r\n')
const ok = (commandId: string, stdout: string): CommandResult => ({ kind: 'success', stdout, durationMs: 1, commandId, processExited: true })
const fail = (commandId: string): CommandResult => ({ kind: 'failed', reason: 'exit-code', exitCode: 1, commandId, processExited: true })

const NVIDIA = { vendorId: 0x10de, deviceId: 0x2504, deviceString: 'NVIDIA GeForce RTX 3060' }
const INTEL = { vendorId: 0x8086, deviceId: 0xa780, deviceString: 'Intel(R) UHD Graphics 770' }
const REGISTRY: Partial<Record<GpuCommandId, string>> = {
  [GPU_COMMAND_IDS.deviceIds]: reg('MatchingDeviceId', 'REG_SZ', [
    ['0000', 'pci\\ven_10de&dev_2504&subsys_397d1462'],
    ['0001', 'pci\\ven_8086&dev_a780']
  ]),
  [GPU_COMMAND_IDS.memorySizes]: reg('HardwareInformation.qwMemorySize', 'REG_QWORD', [
    ['0000', '0x300000000'],
    ['0001', '0x8000000']
  ])
}

/** Dependências simuladas, todas registrando as chamadas. */
function setup(o: Partial<LocalHardwareDetectorDeps> & { devices?: unknown[]; registry?: Partial<Record<GpuCommandId, string>> } = {}) {
  const calls: string[] = []
  const spy = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A) => (calls.push(name), fn(...a))
  const cpu: CpuApi = {
    cpus: spy('cpus', () => Array.from({ length: 16 }, () => ({ model: 'CPU Sintética 8C' }))),
    machine: spy('cpu.machine', () => 'x86_64'),
    arch: spy('cpu.arch', () => 'x64'),
    availableParallelism: spy('availableParallelism', () => 16)
  }
  const memory: MemoryApi = { totalmem: spy('totalmem', () => 32 * GiB), freemem: spy('freemem', () => 20 * GiB), platform: spy('mem.platform', () => 'win32') }
  const os: OsApi = {
    platform: spy('os.platform', () => 'win32'),
    release: spy('release', () => '10.0.26200'),
    version: spy('version', () => 'Windows 11 Pro'),
    machine: spy('os.machine', () => 'x86_64')
  }
  const storage: StorageApi = {
    statfs: spy('statfs', async () => ({ bsize: 4096, blocks: (1000 * GiB) / 4096, bavail: (400 * GiB) / 4096 })),
    platform: 'win32'
  }
  const registry = o.registry ?? REGISTRY
  const gpu: GpuApi = {
    getGPUInfo: spy('getGPUInfo', async () => ({ gpuDevice: o.devices ?? [NVIDIA] })),
    runCommand: spy('runCommand', async (id: GpuCommandId) => (registry[id] === undefined ? fail(id) : ok(id, registry[id]!)))
  }
  const deps: LocalHardwareDetectorDeps = {
    storageTarget: { kind: 'app-data', path: APP_DATA },
    cpu,
    memory,
    os,
    storage,
    gpu,
    platform: 'win32',
    now: () => NOW,
    ...o
  }
  return { detector: new LocalHardwareDetector(deps), calls }
}

const valid = (p: HardwareProfile) => {
  const r = validateHardwareProfile(p)
  assert.ok(r.ok, JSON.stringify(r.ok ? null : r.issues))
  assert.equal(p.provenance.source, 'local-detector')
  const all = [...Object.values(p.provenance.quality.fields), ...(p.provenance.quality.gpus ?? []).flatMap((g) => Object.values(g))]
  assert.ok(!all.includes('simulated'))
}

const isAborted = (reason: 'cancelled' | 'timeout') => (e: unknown) => e instanceof DetectionAbortedError && e.reason === reason

describe('LocalHardwareDetector: composição', () => {
  it('hardware completo: perfil v4 válido, qualidade por atributo', async () => {
    const { detector } = setup({ devices: [INTEL, NVIDIA] })
    const { profile, diagnostics } = await detector.collect()
    valid(profile)
    assert.deepEqual(profile.cpu, { model: 'CPU Sintética 8C', architecture: 'x64', physicalCores: null, logicalCores: 16 })
    assert.deepEqual(profile.memory, { totalGb: 32, availableGb: 20 })
    assert.deepEqual(profile.storage, { freeGb: 400, totalGb: 1000 })
    assert.deepEqual(profile.os, { platform: 'windows', version: '11 (build 26200)', architecture: 'x64' })
    assert.deepEqual(profile.gpus, [
      { vendor: 'intel', model: 'Intel(R) UHD Graphics 770', vramGb: 0.13, sharedMemory: null },
      { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3060', vramGb: 12, sharedMemory: null }
    ])
    assert.equal(profile.acceleration, null)
    assert.deepEqual(profile.provenance.quality.fields, {
      'cpu.model': 'detected',
      'cpu.architecture': 'detected',
      'cpu.physicalCores': 'unavailable',
      'cpu.logicalCores': 'detected',
      'memory.totalGb': 'detected',
      'memory.availableGb': 'detected',
      gpus: 'detected',
      'storage.freeGb': 'detected',
      'storage.totalGb': 'detected',
      'os.platform': 'detected',
      'os.version': 'detected',
      'os.architecture': 'detected',
      acceleration: 'unavailable'
    })
    assert.deepEqual(Object.keys(profile.provenance.quality.fields), [...PROFILE_FIELDS])
    assert.deepEqual(profile.provenance.quality.gpus, [
      { vendor: 'detected', model: 'detected', vramGb: 'detected', sharedMemory: 'unavailable' },
      { vendor: 'detected', model: 'detected', vramGb: 'detected', sharedMemory: 'unavailable' }
    ])
    // Essenciais conhecidos, mas não tudo detectado: confiança média, nunca alta.
    assert.equal(profile.provenance.confidence, 'medium')
    assert.equal(profile.provenance.detectorId, 'local-hardware')
    assert.equal(profile.provenance.collectedAt, NOW.toISOString())
    assert.deepEqual(diagnostics.reasons, { 'cpu.physicalCores': 'requires-system-query', acceleration: 'not-probed' })
    assert.equal(diagnostics.storageVolume, 'C:\\')
    assert.equal(diagnostics.storageKind, 'app-data')
    assert.equal(diagnostics.gpuRegistry, 'ok')
    // `detect` devolve o mesmo perfil.
    assert.deepEqual(await setup({ devices: [INTEL, NVIDIA] }).detector.detect(new AbortController().signal), profile)
  })

  it('CPU parcialmente identificada: o restante continua', async () => {
    const { detector } = setup({
      cpu: { cpus: () => { throw new Error('x') }, machine: () => 'ARM64', availableParallelism: () => 12 }
    })
    const { profile } = await detector.collect()
    valid(profile)
    assert.deepEqual(profile.cpu, { model: null, architecture: 'arm64', physicalCores: null, logicalCores: 12 })
    assert.equal(profile.provenance.quality.fields['cpu.model'], 'unavailable')
    assert.equal(profile.provenance.quality.fields['cpu.logicalCores'], 'estimated')
    assert.deepEqual(profile.memory, { totalGb: 32, availableGb: 20 })
    assert.equal(profile.provenance.confidence, 'medium')
  })

  it('RAM parcialmente identificada: total mantido, livre desconhecida, confiança baixa', async () => {
    const { detector } = setup({ memory: { totalmem: () => 16 * GiB, freemem: () => 64 * GiB, platform: () => 'win32' } })
    const { profile, diagnostics } = await detector.collect()
    valid(profile)
    assert.deepEqual(profile.memory, { totalGb: 16, availableGb: null })
    assert.equal(profile.provenance.quality.fields['memory.availableGb'], 'unavailable')
    assert.equal(diagnostics.reasons['memory.availableGb'], 'inconsistent')
    assert.equal(profile.provenance.confidence, 'low')
  })

  it('armazenamento indisponível: seção nula, sem zero inventado', async () => {
    const denied = Object.assign(new Error('EACCES: C:\\Users\\fulano'), { code: 'EACCES' })
    const { detector } = setup({ storage: { statfs: async () => Promise.reject(denied), platform: 'win32' } })
    const { profile, diagnostics } = await detector.collect()
    valid(profile)
    assert.equal(profile.storage, null)
    assert.equal(profile.provenance.quality.fields['storage.freeGb'], 'unavailable')
    assert.equal(diagnostics.reasons['storage.freeGb'], 'permission-denied')
    assert.equal(diagnostics.storageVolume, 'C:\\')
    assert.equal(profile.provenance.confidence, 'low')
    // Sem alvo definido pelo Main: nada é consultado.
    const none = setup({ storageTarget: null })
    const r = await none.detector.collect()
    assert.equal(r.profile.storage, null)
    assert.equal(r.diagnostics.reasons['storage.freeGb'], 'no-target')
    assert.equal(r.diagnostics.storageVolume, null)
    assert.ok(!none.calls.includes('statfs'))
  })

  it('caminho recusado (rede ou relativo) não é consultado', async () => {
    for (const path of ['\\\\servidor\\share', 'relativo\\pasta', 'C:pasta']) {
      const s = setup({ storageTarget: { kind: 'app-data', path } })
      const { profile, diagnostics } = await s.detector.collect()
      assert.equal(profile.storage, null)
      assert.equal(diagnostics.reasons['storage.freeGb'], 'invalid-target')
      assert.ok(!s.calls.includes('statfs'), path)
    }
  })

  it('GPU sem VRAM: identificação mantida', async () => {
    const { detector } = setup({ registry: {} })
    const { profile, diagnostics } = await detector.collect()
    valid(profile)
    assert.deepEqual(profile.gpus, [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3060', vramGb: null, sharedMemory: null }])
    assert.equal(profile.provenance.quality.gpus![0]!.vramGb, 'unavailable')
    assert.deepEqual(diagnostics.gpuReasons, [{ vramGb: 'registry-failed', sharedMemory: 'no-evidence' }])
  })

  it('GPU com memória não classificada e sem modelo: sem heurística de fabricante', async () => {
    const { detector } = setup({ devices: [{ vendorId: 0x8086, deviceId: 0x56a0 }], registry: {} })
    const { profile } = await detector.collect()
    valid(profile)
    assert.deepEqual(profile.gpus, [{ vendor: 'intel', model: null, vramGb: null, sharedMemory: null }])
    assert.deepEqual(profile.provenance.quality.gpus, [{ vendor: 'detected', model: 'unavailable', vramGb: 'unavailable', sharedMemory: 'unavailable' }])
  })

  it('múltiplas GPUs idênticas: VRAM indisponível nas duas, nunca somada', async () => {
    const twin = { vendorId: 0x10de, deviceId: 0x2204, deviceString: 'NVIDIA GeForce RTX 3090' }
    const { detector } = setup({
      devices: [twin, twin],
      registry: {
        [GPU_COMMAND_IDS.deviceIds]: reg('MatchingDeviceId', 'REG_SZ', [['0000', 'pci\\ven_10de&dev_2204'], ['0001', 'pci\\ven_10de&dev_2204']]),
        [GPU_COMMAND_IDS.memorySizes]: reg('HardwareInformation.qwMemorySize', 'REG_QWORD', [['0000', '0x600000000'], ['0001', '0x600000000']])
      }
    })
    const { profile, diagnostics } = await detector.collect()
    valid(profile)
    assert.deepEqual(profile.gpus?.map((g) => g.vramGb), [null, null])
    assert.deepEqual(diagnostics.gpuReasons.map((r) => r.vramGb), ['ambiguous-identical-adapters', 'ambiguous-identical-adapters'])
  })
})

describe('LocalHardwareDetector: falhas parciais', () => {
  it('falha isolada da GPU não afeta CPU, memória, sistema e armazenamento', async () => {
    const { detector } = setup({ gpu: { getGPUInfo: async () => Promise.reject(new Error('gpu process crashed')) } })
    const { profile, diagnostics } = await detector.collect()
    valid(profile)
    assert.equal(profile.gpus, null)
    assert.equal(profile.provenance.quality.fields.gpus, 'unavailable')
    assert.equal(diagnostics.reasons.gpus, 'api-error')
    assert.equal(profile.cpu?.model, 'CPU Sintética 8C')
    assert.deepEqual(profile.storage, { freeGb: 400, totalGb: 1000 })
  })

  it('exceção inesperada dentro de uma sondagem fica restrita a ela', async () => {
    const exploding = new Proxy({}, { get: () => { throw new Error('inesperado') } }) as CpuApi
    const { detector } = setup({ cpu: exploding })
    const { profile, diagnostics } = await detector.collect()
    valid(profile)
    assert.equal(profile.cpu, null)
    assert.equal(diagnostics.reasons['cpu.model'], 'probe-error')
    assert.deepEqual(profile.memory, { totalGb: 32, availableGb: 20 })
    assert.equal(profile.gpus?.length, 1)
  })

  it('falhas simultâneas: perfil válido, tudo indisponível, confiança baixa', async () => {
    const { detector } = setup({
      cpu: {},
      memory: {},
      os: {},
      storage: { platform: 'win32' },
      gpu: {}
    })
    const { profile } = await detector.collect()
    valid(profile)
    assert.deepEqual([profile.cpu, profile.memory, profile.gpus, profile.storage, profile.os, profile.acceleration], [null, null, null, null, null, null])
    assert.ok(Object.values(profile.provenance.quality.fields).every((q) => q === 'unavailable'))
    assert.equal(profile.provenance.confidence, 'low')
  })
})

describe('LocalHardwareDetector: cancelamento e prazo', () => {
  it('cancelado antes: rejeita sem consultar nada', async () => {
    const { detector, calls } = setup()
    await assert.rejects(detector.detect(AbortSignal.abort()), isAborted('cancelled'))
    assert.deepEqual(calls, [])
  })

  it('cancelado durante as sondagens síncronas: nenhuma sondagem nova começa', async () => {
    const controller = new AbortController()
    const { detector, calls } = setup({
      cpu: { cpus: () => (controller.abort(), [{ model: 'x' }]), machine: () => 'x64' }
    })
    await assert.rejects(detector.collect(controller.signal), isAborted('cancelled'))
    assert.deepEqual(calls, [])
  })

  it('cancelado durante a GPU: rejeita sem perfil e sem consultar o Registro', async () => {
    const controller = new AbortController()
    let started!: () => void
    const gpuStarted = new Promise<void>((resolve) => (started = resolve))
    const commands: string[] = []
    const { detector } = setup({
      gpu: {
        getGPUInfo: () => (started(), new Promise(() => undefined)),
        runCommand: async (id) => (commands.push(id), fail(id))
      }
    })
    const pending = detector.collect(controller.signal)
    await gpuStarted
    controller.abort()
    await assert.rejects(pending, isAborted('cancelled'))
    assert.deepEqual(commands, [])
  })

  it('cancelado enquanto o disco não responde: desiste sem esperar o prazo do disco', async () => {
    const controller = new AbortController()
    const { detector } = setup({ storage: { statfs: () => new Promise(() => undefined), platform: 'win32' } })
    const started = Date.now()
    const pending = detector.collect(controller.signal)
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending, isAborted('cancelled'))
    assert.ok(Date.now() - started < 1_000)
  })

  it('prazo global esgotado: rejeita como tempo esgotado, sem perfil', async () => {
    const { detector } = setup({ gpu: { getGPUInfo: () => new Promise(() => undefined) } })
    const started = Date.now()
    await assert.rejects(detector.detect(AbortSignal.timeout(30)), isAborted('timeout'))
    assert.ok(Date.now() - started < 1_000)
  })

  it('prazo de uma sondagem não é cancelamento: a coleta conclui com o atributo indisponível', async () => {
    // Disco sem resposta: prazo próprio (injetado, sem trocar temporizadores globais).
    const { detector } = setup({ storage: { statfs: () => new Promise(() => undefined), platform: 'win32' }, budget: { storageMs: 5 } })
    const { profile, diagnostics } = await detector.collect(AbortSignal.timeout(2_000))
    valid(profile)
    assert.equal(profile.storage, null)
    assert.equal(diagnostics.reasons['storage.freeGb'], 'timeout')
    assert.deepEqual(profile.memory, { totalGb: 32, availableGb: 20 })
  })
})

/** Promessa controlada pelo teste. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('LocalHardwareDetector: prazos e cancelamento por etapa', () => {
  it('cancelado durante a memória ou o sistema: as sondagens seguintes não começam', async () => {
    const c1 = new AbortController()
    const s1 = setup({ memory: { totalmem: () => (c1.abort(), 16 * GiB), freemem: () => GiB, platform: () => 'win32' } })
    await assert.rejects(s1.detector.collect(c1.signal), isAborted('cancelled'))
    assert.ok(!s1.calls.some((c) => ['os.platform', 'statfs', 'getGPUInfo'].includes(c)), s1.calls.join())

    const c2 = new AbortController()
    const s2 = setup({ os: { platform: () => (c2.abort(), 'win32'), release: () => '10.0.1' } })
    await assert.rejects(s2.detector.collect(c2.signal), isAborted('cancelled'))
    assert.ok(!s2.calls.some((c) => ['statfs', 'getGPUInfo'].includes(c)), s2.calls.join())
  })

  it('cancelado durante a consulta ao Registro: o executor recebe o sinal (encerra o processo) e nada é devolvido', async () => {
    const controller = new AbortController()
    const received: AbortSignal[] = []
    let commandStarted!: () => void
    const started = new Promise<void>((r) => (commandStarted = r))
    const { detector } = setup({
      gpu: {
        getGPUInfo: async () => ({ gpuDevice: [NVIDIA] }),
        runCommand: (id, signal) => {
          received.push(signal!)
          commandStarted()
          // Como o executor real: termina só quando o sinal o interrompe.
          return new Promise<CommandResult>((resolve) =>
            signal!.addEventListener('abort', () => resolve({ kind: 'cancelled', commandId: id, processExited: true }), { once: true })
          )
        }
      }
    })
    const pending = detector.collect(controller.signal)
    await started
    controller.abort()
    await assert.rejects(pending, isAborted('cancelled'))
    assert.equal(received.length, 1)
    assert.equal(received[0]!.aborted, true)
  })

  it('orçamento da GPU vence antes do prazo global: perfil sai com a GPU identificada e a VRAM indisponível por prazo', async () => {
    const { detector } = setup({
      budget: { gpuTotalMs: 20 },
      gpu: {
        getGPUInfo: async () => ({ gpuDevice: [NVIDIA] }),
        runCommand: (id, signal) =>
          new Promise<CommandResult>((resolve) =>
            signal!.addEventListener('abort', () => resolve({ kind: 'cancelled', commandId: id, processExited: true }), { once: true })
          )
      }
    })
    const { profile, diagnostics } = await detector.collect(AbortSignal.timeout(2_000))
    valid(profile)
    assert.deepEqual(profile.gpus, [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3060', vramGb: null, sharedMemory: null }])
    assert.equal(diagnostics.gpuRegistry, 'timeout')
    assert.equal(diagnostics.gpuReasons[0]!.vramGb, 'registry-timeout')
    // Os outros atributos não foram afetados.
    assert.deepEqual(profile.storage, { freeGb: 400, totalGb: 1000 })
  })

  it('prazo global próximo do limite: vence antes do orçamento da GPU e rejeita como tempo esgotado', async () => {
    const { detector } = setup({ budget: { gpuTotalMs: 10_000, gpuInfoMs: 10_000 }, gpu: { getGPUInfo: () => new Promise(() => undefined) } })
    const started = Date.now()
    await assert.rejects(detector.collect(AbortSignal.timeout(40)), isAborted('timeout'))
    assert.ok(Date.now() - started < 1_000)
  })

  it('resultados tardios após o cancelamento não são usados nem disparam novas consultas', async () => {
    const controller = new AbortController()
    const info = deferred<unknown>()
    const disk = deferred<{ bsize: number; blocks: number; bavail: number }>()
    const calls: string[] = []
    const { detector } = setup({
      storage: { statfs: () => (calls.push('statfs'), disk.promise), platform: 'win32' },
      gpu: { getGPUInfo: () => (calls.push('getGPUInfo'), info.promise), runCommand: async (id) => (calls.push(id), fail(id)) }
    })
    const pending = detector.collect(controller.signal)
    await new Promise((r) => setImmediate(r))
    controller.abort()
    await assert.rejects(pending, isAborted('cancelled'))
    // Chegam depois: nada mais é consultado e a coleta já terminou sem perfil.
    info.resolve({ gpuDevice: [NVIDIA] })
    disk.resolve({ bsize: 4096, blocks: 1, bavail: 1 })
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    assert.deepEqual(calls, ['statfs', 'getGPUInfo'])
  })

  it('os prazos padrão cabem no prazo global do serviço (15 s), contando o encerramento dos processos', () => {
    const KILL_GRACE_MS = COMMAND_LIMITS.killGraceMs
    // Lido do serviço (constante não exportada), para o teste acompanhar uma mudança dele.
    const match = /const DETECT_TIMEOUT_MS = ([\d_]+)/.exec(readFileSync(join(import.meta.dirname, '../../src/main/hardware/hardware-advisor-service.ts'), 'utf8'))
    const SERVICE_TIMEOUT_MS = Number(match![1]!.replaceAll('_', ''))
    assert.equal(SERVICE_TIMEOUT_MS, 15_000)
    assert.ok(DETECTION_BUDGET.gpuTotalMs + KILL_GRACE_MS < SERVICE_TIMEOUT_MS)
    assert.ok(DETECTION_BUDGET.storageMs < SERVICE_TIMEOUT_MS)
    assert.ok(DETECTION_BUDGET.gpuInfoMs < DETECTION_BUDGET.gpuTotalMs)
  })
})

describe('LocalHardwareDetector: confiança', () => {
  it('alta só com tudo detectado; parcial nunca alta', () => {
    const all = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, 'detected'])) as Parameters<typeof deriveConfidence>[0]
    assert.equal(deriveConfidence(all, []), 'high')
    assert.equal(deriveConfidence(all, [{ vendor: 'detected', model: 'detected', vramGb: 'detected', sharedMemory: 'unavailable' }]), 'medium')
    assert.equal(deriveConfidence({ ...all, acceleration: 'unavailable' }, []), 'medium')
    assert.equal(deriveConfidence({ ...all, 'memory.totalGb': 'unavailable' }, []), 'low')
    assert.equal(deriveConfidence({ ...all, gpus: 'unavailable' }, null), 'low')
  })
})

describe('LocalHardwareDetector: isolamento', () => {
  const ROOT = join(import.meta.dirname, '../..')
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
  const LOCAL = join('src', 'main', 'hardware', 'local')

  it('disponível só no Windows; consultar a disponibilidade não lê o hardware', async () => {
    const win = setup()
    assert.deepEqual(await win.detector.availability(), { available: true, reason: null })
    const linux = setup({ platform: 'linux' })
    assert.equal((await linux.detector.availability()).available, false)
    assert.deepEqual([...win.calls, ...linux.calls], [])
  })

  it('construir não consulta nada (inclusive a montagem de produção)', () => {
    let gpuCalls = 0
    const detector = createLocalHardwareDetector({ storageTarget: { kind: 'app-data', path: APP_DATA }, getGPUInfo: async () => (gpuCalls++, {}) })
    assert.ok(detector instanceof LocalHardwareDetector)
    assert.equal(gpuCalls, 0)
    setup()
  })

  it('perfil e diagnóstico não carregam caminho, usuário, identificadores PCI nem mensagens do sistema', async () => {
    const denied = Object.assign(new Error('EACCES C:\\Users\\fulano'), { code: 'EACCES' })
    for (const deps of [{}, { storage: { statfs: async () => Promise.reject(denied), platform: 'win32' as const } }]) {
      const text = JSON.stringify(await setup({ devices: [INTEL, NVIDIA], ...deps }).detector.collect())
      for (const forbidden of ['fulano', 'Users', 'AppData', 'Gerpro Studio', '10de', 'ven_', 'subsys', 'HKEY']) {
        assert.ok(!text.includes(forbidden), forbidden)
      }
    }
  })

  it('sem persistência, sem rede e sem processos próprios', () => {
    const files = walk(LOCAL).filter((f) => f.endsWith('.ts'))
    for (const file of files) {
      const src = read(file)
      assert.ok(!/node:(net|http|https|dns|tls|dgram)|\bfetch\(|XMLHttpRequest|WebSocket/.test(src), `${file}: rede`)
      assert.ok(!/writeFile|appendFile|mkdir|createWriteStream|unlink|\brename\(|localStorage|console\./.test(src), `${file}: gravação/log`)
    }
    const detector = read(join(LOCAL, 'local-hardware-detector.ts'))
    assert.ok(!/child_process|from 'electron'|node:fs/.test(detector))
    // O executor usado é o existente, com o catálogo autorizado (sem comandos novos).
    assert.match(detector, /new CommandRunner\(\{ commands: HARDWARE_COMMANDS \}\)/)
  })

  it('nada no app usa o detector: serviço, inicialização, IPC, Preload e Renderer seguem como antes', () => {
    const users = [...walk('src/main'), ...walk('src/preload'), ...walk('src/renderer'), ...walk('src/shared')]
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith(LOCAL))
      .filter((f) => /local-hardware-detector|LocalHardwareDetector|createLocalHardwareDetector|getGPUInfo/.test(read(f)))
    assert.deepEqual(users, [])
    assert.match(read('src/main/services/index.ts'), /localDetector: new UnimplementedLocalDetector\(\)/)
  })
})

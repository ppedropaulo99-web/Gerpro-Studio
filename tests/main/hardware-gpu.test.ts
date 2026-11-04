import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CommandRunner, type CommandResult, type SpawnFn } from '../../src/main/hardware/local/command-runner'
import { DISPLAY_CLASS_KEY, GPU_COMMAND_IDS, HARDWARE_COMMANDS, type GpuCommandId } from '../../src/main/hardware/local/commands'
import { gpusToProfile, parseRegistryOutput, probeGpus, type GpuApi, type GpuProbeResult } from '../../src/main/hardware/local/probes/gpu'
import { uniformQuality, validateHardwareProfile, type HardwareProfile } from '../../src/shared/hardware'

// Respostas SIMULADAS do Electron e do Registro: nenhuma consulta real é feita.

const KEY = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'

const dev = (vendorId: number, deviceId: number, deviceString?: string) => ({
  active: true,
  vendorId,
  deviceId,
  driverVendor: 'Fabricante',
  driverVersion: '31.0.15.1234',
  ...(deviceString === undefined ? {} : { deviceString })
})

/** Saída no formato de `reg query <chave> /s /v <nome>`. */
const regOutput = (name: string, type: string, entries: Array<[string, string]>) =>
  `\r\n${entries.map(([subkey, data]) => `${KEY}\\${subkey}\r\n    ${name}    ${type}    ${data}\r\n`).join('\r\n')}\r\nFim da pesquisa: ${entries.length} correspondência(s) encontrada(s).\r\n`
const ids = (...entries: Array<[string, string]>) => regOutput('MatchingDeviceId', 'REG_SZ', entries)
const sizes = (...entries: Array<[string, string]>) => regOutput('HardwareInformation.qwMemorySize', 'REG_QWORD', entries)

const success = (commandId: string, stdout: string): CommandResult => ({ kind: 'success', stdout, durationMs: 3, commandId, processExited: true })
const failed = (commandId: string): CommandResult => ({ kind: 'failed', reason: 'exit-code', exitCode: 1, commandId, processExited: true })

const GiB = (n: number) => `0x${(n * 1024 ** 3).toString(16)}`

/** API simulada; registra cada chamada. */
function fake(devices: unknown[] | (() => Promise<unknown>), registry: Partial<Record<GpuCommandId, string | CommandResult>> = {}) {
  const calls: string[] = []
  const api: GpuApi = {
    getGPUInfo: async (type) => {
      calls.push(`getGPUInfo:${type}`)
      return typeof devices === 'function' ? devices() : { auxAttributes: { glRenderer: 'x' }, gpuDevice: devices }
    },
    runCommand: async (id) => {
      calls.push(id)
      const r = registry[id]
      if (r === undefined) return failed(id)
      return typeof r === 'string' ? success(id, r) : r
    }
  }
  return { api, calls }
}

const NVIDIA_3060 = dev(0x10de, 0x2504, 'NVIDIA GeForce RTX 3060')
const NVIDIA_IDS: [string, string] = ['0000', 'pci\\ven_10de&dev_2504&subsys_397d1462&rev_a1']

/** Resumo legível: [fabricante, modelo, VRAM, compartilhada] com qualidades. */
const summary = (r: GpuProbeResult) =>
  r.gpus.value?.map((g) => ({
    vendor: g.vendor.value,
    model: g.model.value,
    vram: g.vramGb.value,
    vramQuality: g.vramGb.quality,
    vramReason: g.vramGb.quality === 'unavailable' ? g.vramGb.reason : null,
    shared: g.sharedMemory.value
  }))

/** O resultado cabe no contrato v4, como parte de um perfil real. */
function assertValidProfile(r: GpuProbeResult) {
  const { gpus, gpuQuality } = gpusToProfile(r)
  const data = { cpu: null, memory: { totalGb: 16, availableGb: 8 }, gpus, storage: null, os: null, acceleration: null }
  const quality = uniformQuality(data, 'detected')
  quality.fields.gpus = r.gpus.quality
  quality.gpus = gpuQuality
  const profile: HardwareProfile = { ...data, provenance: { source: 'local-detector', detectorId: 'gpu-test', collectedAt: '2026-11-03T12:00:00.000Z', confidence: 'medium', quality } }
  const v = validateHardwareProfile(profile)
  assert.ok(v.ok, JSON.stringify(v.ok ? null : v.issues))
}

describe('GPU: identificação e VRAM por fabricante', () => {
  it('NVIDIA com VRAM conhecida', async () => {
    const { api, calls } = fake([NVIDIA_3060], { [GPU_COMMAND_IDS.deviceIds]: ids(NVIDIA_IDS), [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(12)]) })
    const r = await probeGpus(api)
    assert.deepEqual(summary(r), [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3060', vram: 12, vramQuality: 'detected', vramReason: null, shared: null }])
    assert.equal(r.gpus.quality, 'detected')
    assert.equal(r.registry, 'ok')
    assert.deepEqual(calls, ['getGPUInfo:basic', GPU_COMMAND_IDS.deviceIds, GPU_COMMAND_IDS.memorySizes])
    assertValidProfile(r)
  })

  it('AMD com VRAM conhecida', async () => {
    const { api } = fake([dev(0x1002, 0x73bf, 'AMD Radeon RX 6800')], {
      [GPU_COMMAND_IDS.deviceIds]: ids(['0000', 'PCI\\VEN_1002&DEV_73BF&SUBSYS_0E3A1002&REV_C3']),
      [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(16)])
    })
    const r = await probeGpus(api)
    assert.deepEqual(summary(r)?.map((g) => [g.vendor, g.vram, g.shared]), [['amd', 16, null]])
    assertValidProfile(r)
  })

  it('Intel integrada: a memória informada não é presumida como VRAM dedicada nem como compartilhada', async () => {
    const { api } = fake([dev(0x8086, 0xa780, 'Intel(R) UHD Graphics 770')], {
      [GPU_COMMAND_IDS.deviceIds]: ids(['0000', 'pci\\ven_8086&dev_a780&subsys_7d251462']),
      [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', '0x8000000'])
    })
    const r = await probeGpus(api)
    const [gpu] = r.gpus.value!
    assert.equal(gpu!.vendor.value, 'intel')
    assert.equal(gpu!.vramGb.value, 0.13) // 128 MiB: o que o driver informa (reserva), não a memória total
    assert.equal(gpu!.sharedMemory.value, null)
    assert.equal(gpu!.sharedMemory.quality, 'unavailable')
    assertValidProfile(r)
  })

  it('Intel Arc dedicada: o fabricante não a torna integrada', async () => {
    const { api } = fake([dev(0x8086, 0x56a0, 'Intel(R) Arc(TM) A770 Graphics')], {
      [GPU_COMMAND_IDS.deviceIds]: ids(['0000', 'pci\\ven_8086&dev_56a0']),
      [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(16)])
    })
    const r = await probeGpus(api)
    assert.deepEqual(summary(r)?.map((g) => [g.vendor, g.model, g.vram, g.shared]), [['intel', 'Intel(R) Arc(TM) A770 Graphics', 16, null]])
  })

  it('GPU sem modelo: fabricante e VRAM continuam valendo', async () => {
    const { api } = fake([dev(0x10de, 0x2504)], {
      [GPU_COMMAND_IDS.deviceIds]: ids(NVIDIA_IDS),
      [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(12)])
    })
    const r = await probeGpus(api)
    const [gpu] = r.gpus.value!
    assert.equal(gpu!.model.value, null)
    assert.equal(gpu!.model.quality, 'unavailable')
    assert.equal(gpu!.vendor.value, 'nvidia')
    assert.equal(gpu!.vramGb.value, 12)
    assertValidProfile(r)
    // Nome só com espaços ou caracteres de controle também não vale como modelo.
    const blank = await probeGpus(fake([dev(0x10de, 0x2504, ' \u0000\t ')]).api)
    assert.equal(blank.gpus.value![0]!.model.value, null)
  })

  it('GPU sem VRAM informada: identificação preservada', async () => {
    // O Registro tem a subchave do adaptador, mas sem `qwMemorySize` para ela.
    const { api } = fake([NVIDIA_3060], {
      [GPU_COMMAND_IDS.deviceIds]: ids(NVIDIA_IDS, ['0001', 'pci\\ven_8086&dev_a780']),
      [GPU_COMMAND_IDS.memorySizes]: sizes(['0001', GiB(1)])
    })
    const r = await probeGpus(api)
    assert.deepEqual(summary(r)?.map((g) => [g.model, g.vram, g.vramReason]), [['NVIDIA GeForce RTX 3060', null, 'not-reported']])
    assertValidProfile(r)
    // Sem nenhuma memória no Registro, a consulta termina com erro: VRAM indisponível.
    const none = await probeGpus(fake([NVIDIA_3060], { [GPU_COMMAND_IDS.deviceIds]: ids(NVIDIA_IDS) }).api)
    assert.deepEqual(summary(none)?.map((g) => [g.model, g.vram, g.vramReason]), [['NVIDIA GeForce RTX 3060', null, 'registry-failed']])
  })

  it('classificação de memória desconhecida em todas as GPUs, com qualidade indisponível', async () => {
    const { api } = fake([NVIDIA_3060, dev(0x8086, 0xa780, 'Intel(R) UHD Graphics 770')])
    const r = await probeGpus(api)
    assert.ok(r.gpus.value!.every((g) => g.sharedMemory.value === null && g.sharedMemory.quality === 'unavailable'))
    const { gpus, gpuQuality } = gpusToProfile(r)
    assert.ok(gpus!.every((g) => g.sharedMemory === null))
    assert.ok(gpuQuality!.every((q) => q.sharedMemory === 'unavailable'))
  })
})

describe('GPU: várias placas e associação com o Registro', () => {
  it('fabricantes diferentes (notebook): associação pelo identificador, não pela posição', async () => {
    // Ordem do Electron: Intel, NVIDIA. Ordem do Registro: NVIDIA (0000), Intel (0001).
    const { api } = fake([dev(0x8086, 0xa7a0, 'Intel(R) Iris(R) Xe Graphics'), dev(0x10de, 0x28e0, 'NVIDIA GeForce RTX 4060 Laptop GPU')], {
      [GPU_COMMAND_IDS.deviceIds]: ids(['0000', 'pci\\ven_10de&dev_28e0&subsys_0b0c1028'], ['0001', 'pci\\ven_8086&dev_a7a0&subsys_0b0c1028']),
      [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(8)], ['0001', '0x8000000'])
    })
    const r = await probeGpus(api)
    assert.deepEqual(summary(r)?.map((g) => [g.vendor, g.vram]), [
      ['intel', 0.13],
      ['nvidia', 8]
    ])
    // A VRAM da dedicada não foi para a integrada.
    assert.notEqual(r.gpus.value![0]!.vramGb.value, 8)
    assertValidProfile(r)
  })

  it('duas GPUs idênticas: sem atribuição por posição nem por valores iguais', async () => {
    const twin = dev(0x10de, 0x2204, 'NVIDIA GeForce RTX 3090')
    const { api } = fake([twin, twin], {
      [GPU_COMMAND_IDS.deviceIds]: ids(['0000', 'pci\\ven_10de&dev_2204&subsys_1'], ['0001', 'pci\\ven_10de&dev_2204&subsys_2']),
      [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(24)], ['0001', GiB(24)])
    })
    const r = await probeGpus(api)
    assert.deepEqual(summary(r)?.map((g) => [g.model, g.vram, g.vramQuality, g.vramReason]), [
      ['NVIDIA GeForce RTX 3090', null, 'unavailable', 'ambiguous-identical-adapters'],
      ['NVIDIA GeForce RTX 3090', null, 'unavailable', 'ambiguous-identical-adapters']
    ])
    assertValidProfile(r)
  })

  it('correspondência ambígua no Registro: VRAM indisponível, identificação mantida', async () => {
    // Um adaptador, duas subchaves com o mesmo identificador (ex.: driver antigo ainda registrado).
    const { api } = fake([NVIDIA_3060], {
      [GPU_COMMAND_IDS.deviceIds]: ids(NVIDIA_IDS, ['0003', 'pci\\ven_10de&dev_2504&subsys_00000000']),
      [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(12)], ['0003', GiB(8)])
    })
    const r = await probeGpus(api)
    assert.deepEqual(summary(r)?.map((g) => [g.model, g.vram, g.vramReason]), [['NVIDIA GeForce RTX 3060', null, 'ambiguous-registry-match']])
  })

  it('sem subchave correspondente: a única memória do Registro não é atribuída a outro adaptador', async () => {
    const { api } = fake([NVIDIA_3060], {
      [GPU_COMMAND_IDS.deviceIds]: ids(['0000', 'pci\\ven_1002&dev_73bf']),
      [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(16)])
    })
    const r = await probeGpus(api)
    assert.deepEqual(summary(r)?.map((g) => [g.vram, g.vramReason]), [[null, 'no-registry-match']])
  })

  it('só subchaves diretas de adaptador contam; dispositivos fora do PCI são ignorados', async () => {
    const output = [
      `${KEY}\\0000\\Settings`,
      '    MatchingDeviceId    REG_SZ    pci\\ven_10de&dev_2504',
      '',
      `${KEY}\\0001`,
      '    MatchingDeviceId    REG_SZ    root\\basicdisplay',
      '',
      `${KEY}\\0002`,
      '    MatchingDeviceId    REG_SZ    pci\\ven_10de&dev_2504&rev_a1',
      ''
    ].join('\r\n')
    const { api } = fake([NVIDIA_3060], { [GPU_COMMAND_IDS.deviceIds]: output, [GPU_COMMAND_IDS.memorySizes]: sizes(['0002', GiB(12)]) })
    const r = await probeGpus(api)
    assert.equal(r.gpus.value![0]!.vramGb.value, 12)
  })

  it('adaptador sem identificador PCI: VRAM indisponível, sem consultar o Registro', async () => {
    const { api, calls } = fake([{ deviceString: 'Adaptador sem identificador' }])
    const r = await probeGpus(api)
    assert.deepEqual(summary(r), [{ vendor: null, model: 'Adaptador sem identificador', vram: null, vramQuality: 'unavailable', vramReason: 'no-device-id', shared: null }])
    assert.equal(gpusToProfile(r).gpus![0]!.vendor, 'unknown')
    assert.equal(r.registry, 'not-queried')
    assert.deepEqual(calls, ['getGPUInfo:basic'])
    assertValidProfile(r)
  })
})

describe('GPU: valores do Registro', () => {
  const withSizes = (stdout: string) =>
    probeGpus(fake([NVIDIA_3060], { [GPU_COMMAND_IDS.deviceIds]: ids(NVIDIA_IDS), [GPU_COMMAND_IDS.memorySizes]: stdout }).api)
  const reason = async (stdout: string) => summary(await withSizes(stdout))![0]!.vramReason

  it('valores acima de 4 GB são lidos em 64 bits, sem truncar', async () => {
    assert.equal(summary(await withSizes(sizes(['0000', GiB(24)])))![0]!.vram, 24)
    assert.equal(summary(await withSizes(sizes(['0000', GiB(80)])))![0]!.vram, 80)
    assert.equal(summary(await withSizes(sizes(['0000', '0x17FFFFFFF'])))![0]!.vram, 6) // 6 GiB − 1 byte
  })

  it('tipo, formato e faixa inválidos não viram VRAM', async () => {
    assert.equal(await reason(regOutput('HardwareInformation.qwMemorySize', 'REG_SZ', [['0000', '12884901888']])), 'invalid-type')
    assert.equal(await reason(regOutput('HardwareInformation.qwMemorySize', 'REG_BINARY', [['0000', '0000000003000000']])), 'invalid-type')
    assert.equal(await reason(sizes(['0000', '0x0'])), 'invalid-value')
    assert.equal(await reason(sizes(['0000', '0x100'])), 'invalid-value') // 256 bytes: abaixo do plausível
    assert.equal(await reason(sizes(['0000', '0x20000000000'])), 'invalid-value') // 2 TiB: acima do plausível
    assert.equal(await reason(sizes(['0000', '0x12345678901234567'])), 'invalid-value') // mais de 64 bits
    assert.equal(await reason(sizes(['0000', '12GB'])), 'invalid-value')
    assert.equal(await reason(sizes(['0000', '-0x1'])), 'invalid-value')
    assert.equal(await reason(sizes(['0000', GiB(12)], ['0000', GiB(8)])), 'invalid-value') // repetido na mesma subchave
  })

  it('identificador PCI malformado: a associação inteira é recusada', async () => {
    const r = await probeGpus(
      fake([NVIDIA_3060], { [GPU_COMMAND_IDS.deviceIds]: ids(['0000', 'pci\\ven_10de&dev_25']), [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(12)]) }).api
    )
    assert.equal(r.registry, 'invalid-output')
    assert.equal(summary(r)![0]!.vramReason, 'registry-invalid-output')
    assert.equal(summary(r)![0]!.model, 'NVIDIA GeForce RTX 3060')
  })

  it('saída irreconhecível do Registro', async () => {
    const r = await probeGpus(fake([NVIDIA_3060], { [GPU_COMMAND_IDS.deviceIds]: 'ERRO: texto inesperado\r\n' }).api)
    assert.equal(r.registry, 'invalid-output')
    assert.equal(parseRegistryOutput('', 'MatchingDeviceId'), null)
  })
})

describe('GPU: falhas, prazo e cancelamento', () => {
  it('Registro indisponível: identificação preservada, VRAM indisponível', async () => {
    for (const result of [
      { kind: 'unavailable', reason: 'not-found', commandId: 'x', processExited: true },
      { kind: 'failed', reason: 'spawn-error', exitCode: null, commandId: 'x', processExited: true }
    ] satisfies CommandResult[]) {
      const r = await probeGpus(fake([NVIDIA_3060], { [GPU_COMMAND_IDS.deviceIds]: result }).api)
      assert.equal(r.gpus.value![0]!.model.value, 'NVIDIA GeForce RTX 3060')
      assert.equal(r.gpus.value![0]!.vramGb.value, null)
      assert.match(summary(r)![0]!.vramReason!, /^registry-(unavailable|failed)$/)
    }
    const noRunner = await probeGpus({ getGPUInfo: async () => ({ gpuDevice: [NVIDIA_3060] }) })
    assert.equal(noRunner.registry, 'unavailable')
    const throwing = await probeGpus({ getGPUInfo: async () => ({ gpuDevice: [NVIDIA_3060] }), runCommand: async () => Promise.reject(new Error('x')) })
    assert.equal(throwing.registry, 'failed')
  })

  it('fora do Windows o executor real recusa sem iniciar processo', async () => {
    let spawned = false
    const spawn: SpawnFn = () => {
      spawned = true
      throw new Error('não deveria iniciar processo')
    }
    const runner = new CommandRunner({ commands: HARDWARE_COMMANDS, spawn, platform: 'linux' })
    const r = await probeGpus({ getGPUInfo: async () => ({ gpuDevice: [NVIDIA_3060] }), runCommand: (id, signal) => runner.run(id, signal) })
    assert.equal(spawned, false)
    assert.equal(r.registry, 'unavailable')
    assert.equal(r.gpus.value![0]!.vendor.value, 'nvidia')
  })

  it('falhas do Electron: API ausente, erro, formato inválido', async () => {
    assert.equal((await probeGpus({})).gpus.quality, 'unavailable')
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => Promise.reject(new Error('gpu process crashed')), 'api-error'],
      [() => Promise.resolve(null), 'invalid-value'],
      [() => Promise.resolve({ gpuDevice: 'x' }), 'invalid-value'],
      [() => Promise.resolve({ gpuDevice: [] }), 'no-devices'],
      [() => Promise.resolve({ gpuDevice: Array.from({ length: 17 }, () => NVIDIA_3060) }), 'too-many-devices'],
      [() => Promise.resolve({ gpuDevice: [{ vendorId: 0, deviceId: 0 }, null, 'x'] }), 'no-identifiable-device']
    ]
    for (const [getGPUInfo, reason] of cases) {
      const r = await probeGpus({ getGPUInfo })
      assert.equal(r.gpus.value, null)
      assert.ok(r.gpus.quality === 'unavailable' && r.gpus.reason === reason, reason)
      assert.deepEqual(gpusToProfile(r), { gpus: null, quality: { gpus: 'unavailable' }, gpuQuality: null })
    }
    // Mensagem de erro do sistema não vai para o resultado.
    const r = await probeGpus({ getGPUInfo: () => Promise.reject(new Error('C:\\Users\\fulano\\segredo')) })
    assert.ok(!JSON.stringify(r).includes('fulano'))
  })

  it('prazo do Electron: indisponível, sem rejeição solta depois do prazo', async () => {
    const loose: unknown[] = []
    const onLoose = (e: unknown) => loose.push(e)
    process.on('unhandledRejection', onLoose)
    try {
      const late = () => new Promise((_, reject) => setTimeout(() => reject(new Error('tarde')), 30))
      const r = await probeGpus({ getGPUInfo: late }, { timeoutMs: 5 })
      assert.ok(r.gpus.quality === 'unavailable' && r.gpus.reason === 'timeout')
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.deepEqual(loose, [])
    } finally {
      process.off('unhandledRejection', onLoose)
    }
  })

  it('cancelamento antes, durante a leitura do Electron e antes do Registro', async () => {
    const before = fake([NVIDIA_3060])
    const aborted = AbortSignal.abort()
    const r1 = await probeGpus(before.api, { signal: aborted })
    assert.ok(r1.gpus.quality === 'unavailable' && r1.gpus.reason === 'cancelled')
    assert.deepEqual(before.calls, [])

    const during = new AbortController()
    const r2Promise = probeGpus({ getGPUInfo: () => new Promise(() => undefined) }, { signal: during.signal, timeoutMs: 10_000 })
    during.abort()
    const r2 = await r2Promise
    assert.ok(r2.gpus.quality === 'unavailable' && r2.gpus.reason === 'cancelled')

    // Cancelado depois da primeira consulta: a segunda não é iniciada.
    const between = new AbortController()
    const calls: string[] = []
    const r3 = await probeGpus(
      {
        getGPUInfo: async () => ({ gpuDevice: [NVIDIA_3060] }),
        runCommand: async (id) => {
          calls.push(id)
          between.abort()
          return success(id, ids(NVIDIA_IDS))
        }
      },
      { signal: between.signal }
    )
    assert.deepEqual(calls, [GPU_COMMAND_IDS.deviceIds])
    assert.equal(r3.registry, 'cancelled')
    assert.equal(summary(r3)![0]!.vramReason, 'registry-cancelled')
    assert.equal(summary(r3)![0]!.model, 'NVIDIA GeForce RTX 3060')
  })

  it('prazo e cancelamento do executor viram VRAM indisponível', async () => {
    for (const [result, expected] of [
      [{ kind: 'timeout', durationMs: 5000, commandId: 'x', processExited: true }, 'registry-timeout'],
      [{ kind: 'cancelled', commandId: 'x', processExited: false }, 'registry-cancelled']
    ] as const) {
      const r = await probeGpus(fake([NVIDIA_3060], { [GPU_COMMAND_IDS.deviceIds]: ids(NVIDIA_IDS), [GPU_COMMAND_IDS.memorySizes]: result }).api)
      assert.equal(summary(r)![0]!.vramReason, expected)
      assert.equal(summary(r)![0]!.vendor, 'nvidia')
    }
  })
})

describe('GPU: adaptadores virtuais e por software', () => {
  it('só o renderizador por software: nenhuma GPU (estimado), sem consultar o Registro', async () => {
    const { api, calls } = fake([dev(0x1414, 0x008c, 'Microsoft Basic Render Driver')])
    const r = await probeGpus(api)
    assert.deepEqual(r.gpus.value, [])
    assert.equal(r.gpus.quality, 'estimated')
    assert.equal(r.ignored, 1)
    assert.deepEqual(calls, ['getGPUInfo:basic'])
    assertValidProfile(r)
  })

  it('renderizador por software ao lado de uma GPU real é deixado de fora', async () => {
    const r = await probeGpus(fake([dev(0x1414, 0x008c, 'Microsoft Basic Render Driver'), NVIDIA_3060]).api)
    assert.deepEqual(summary(r)?.map((g) => g.model), ['NVIDIA GeForce RTX 3060'])
    assert.equal(r.ignored, 1)
  })

  it('GPU virtual de máquina virtual: fabricante "outro", sem memória presumida', async () => {
    const { api } = fake([dev(0x15ad, 0x0405, 'VMware SVGA 3D')], { [GPU_COMMAND_IDS.deviceIds]: ids(['0000', 'pci\\ven_15ad&dev_0405&subsys_040515ad']) })
    const r = await probeGpus(api)
    assert.deepEqual(summary(r)?.map((g) => [g.vendor, g.model, g.vram, g.shared]), [['other', 'VMware SVGA 3D', null, null]])
    assertValidProfile(r)
  })
})

describe('GPU: sem efeitos colaterais e sem execução automática', () => {
  const ROOT = join(import.meta.dirname, '../..')
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

  it('o catálogo tem só as duas consultas de leitura autorizadas', () => {
    assert.deepEqual([...HARDWARE_COMMANDS.keys()], [GPU_COMMAND_IDS.deviceIds, GPU_COMMAND_IDS.memorySizes])
    assert.equal(DISPLAY_CLASS_KEY, 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}')
    assert.deepEqual(HARDWARE_COMMANDS.get(GPU_COMMAND_IDS.deviceIds)!.args, ['query', DISPLAY_CLASS_KEY, '/s', '/v', 'MatchingDeviceId'])
    assert.deepEqual(HARDWARE_COMMANDS.get(GPU_COMMAND_IDS.memorySizes)!.args, ['query', DISPLAY_CLASS_KEY, '/s', '/v', 'HardwareInformation.qwMemorySize'])
    for (const def of HARDWARE_COMMANDS.values()) {
      assert.equal(def.executable, 'reg')
      assert.ok(Object.isFrozen(def) && Object.isFrozen(def.args))
    }
  })

  it('a sondagem só chama o que recebe: getGPUInfo("basic") uma vez e as duas consultas do catálogo', async () => {
    const { api, calls } = fake([NVIDIA_3060], { [GPU_COMMAND_IDS.deviceIds]: ids(NVIDIA_IDS), [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(12)]) })
    await probeGpus(api)
    assert.deepEqual(calls, ['getGPUInfo:basic', GPU_COMMAND_IDS.deviceIds, GPU_COMMAND_IDS.memorySizes])
  })

  it('o resultado não carrega identificadores de dispositivo, subchaves nem dados de driver', async () => {
    const { api } = fake([NVIDIA_3060], { [GPU_COMMAND_IDS.deviceIds]: ids(NVIDIA_IDS), [GPU_COMMAND_IDS.memorySizes]: sizes(['0000', GiB(12)]) })
    const text = JSON.stringify([await probeGpus(api), gpusToProfile(await probeGpus(api))])
    for (const forbidden of ['10de', '2504', 'ven_', 'subsys', '397d1462', '0000', 'HKEY', '31.0.15', 'Fabricante']) {
      assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), forbidden)
    }
  })

  it('importar não executa nada; o Electron não é importado pela sondagem', () => {
    // Só o código conta: os comentários citam `app.getGPUInfo` para documentar a origem.
    const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
    const src = code('src/main/hardware/local/probes/gpu.ts')
    assert.ok(!/from 'electron'|require\(|\bapp\.|console\./.test(src))
    const catalog = code('src/main/hardware/local/commands.ts')
    assert.ok(!/\.run\(|spawn|child_process/.test(catalog))
  })

  it('nada no app chama a sondagem de GPU nem o catálogo (serviço, inicialização, IPC, Preload, Renderer)', () => {
    for (const file of [
      'src/main/index.ts',
      'src/main/services/index.ts',
      'src/main/hardware/hardware-advisor-service.ts',
      'src/main/hardware/detectors.ts',
      'src/preload/index.ts'
    ]) {
      const src = read(file)
      assert.ok(!/probeGpus|HARDWARE_COMMANDS|getGPUInfo|hardware\/local/.test(src), file)
    }
  })
})

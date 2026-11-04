import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CommandResult } from '../../src/main/hardware/local/command-runner'
import { GPU_COMMAND_IDS, type GpuCommandId } from '../../src/main/hardware/local/commands'
import type { DxcoreAdapter } from '../../src/main/hardware/local/dxcore-contract'
import { interpretHelperResult, type DxcoreSource } from '../../src/main/hardware/local/dxcore/parser'
import { electronPairsFrom, registryFor, sameComposition, selectGpuList, validateDxcoreList, type RegistrySnapshot } from '../../src/main/hardware/local/dxcore/selection'
import { deviceKeysFrom, parseRegistryOutput, probeGpus, type GpuProbeResult } from '../../src/main/hardware/local/probes/gpu'

// Seleção da fonte da lista de GPUs com dados simulados: DXCore, Electron e Registro.

const GiB = 1024n ** 3n
const NV = { vendorId: 0x10de, deviceId: 0x25a2 }
const INTEL = { vendorId: 0x8086, deviceId: 0x9a49 }
const SOFTWARE = { vendorId: 0x1414, deviceId: 0x008c }

const KEY = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
const reg = (name: string, type: string, entries: Array<[string, string]>) => entries.map(([k, v]) => `${KEY}\\${k}\r\n    ${name}    ${type}    ${v}\r\n`).join('\r\n')
const ids = (entries: Array<[string, string]>) => reg('MatchingDeviceId', 'REG_SZ', entries)
const sizes = (entries: Array<[string, string]>) => reg('HardwareInformation.qwMemorySize', 'REG_QWORD', entries)
const hex = (n: bigint) => `0x${n.toString(16)}`

const DEFAULT_IDS = ids([
  ['0000', 'pci\\ven_10de&dev_25a2&subsys_0b0e1025'],
  ['0001', 'pci\\ven_8086&dev_9a49&subsys_0b0e1025']
])
const DEFAULT_SIZES = sizes([
  ['0000', hex(4n * GiB)],
  ['0001', hex(GiB)]
])

const electronRaw = (...devices: Array<Record<string, unknown>>) => ({
  gpuDevice: devices.map((d) => ({ deviceString: d === NV ? 'NVIDIA GeForce RTX 3050 Laptop GPU' : 'Outro adaptador', active: true, ...d }))
})

/** Snapshot do Registro como a sondagem atual o lê. */
function snapshot(idsOut: string | null = DEFAULT_IDS, sizesOut: string | null = DEFAULT_SIZES): RegistrySnapshot {
  const idValues = idsOut === null ? null : parseRegistryOutput(idsOut, 'MatchingDeviceId')
  const sizeValues = sizesOut === null ? null : parseRegistryOutput(sizesOut, 'HardwareInformation.qwMemorySize')
  return { status: idValues && sizeValues ? 'ok' : 'failed', deviceKeys: idValues ? deviceKeysFrom(idValues) : null, sizes: sizeValues }
}

/** Electron sem resposta (`getGPUInfo` falha). */
const NO_ELECTRON = Symbol('sem Electron')

/** Resultado da sondagem ATUAL (Electron + Registro), sem alteração. */
async function currentProbe(raw: unknown, idsOut: string | null = DEFAULT_IDS, sizesOut: string | null = DEFAULT_SIZES): Promise<GpuProbeResult> {
  const out: Record<GpuCommandId, string | null> = { [GPU_COMMAND_IDS.deviceIds]: idsOut, [GPU_COMMAND_IDS.memorySizes]: sizesOut }
  return probeGpus({
    getGPUInfo: async () => {
      if (raw === NO_ELECTRON) throw new Error('indisponível')
      return raw
    },
    runCommand: async (id): Promise<CommandResult> => {
      const stdout = out[id]
      return stdout === null
        ? { kind: 'failed', reason: 'exit-code', exitCode: 1, commandId: id, processExited: true }
        : { kind: 'success', stdout, durationMs: 1, commandId: id, processExited: true }
    }
  })
}

let luidSeq = 0x100
const dx = (o: Partial<DxcoreAdapter> = {}): DxcoreAdapter => ({
  luid: `00000000:${(luidSeq++).toString(16).toUpperCase().padStart(8, '0')}`,
  ...NV,
  description: 'NVIDIA GeForce RTX 3050 Laptop GPU',
  isHardware: true,
  isIntegrated: false,
  dedicatedAdapterMemory: 4148166656n,
  dedicatedSystemMemory: 0n,
  sharedSystemMemory: 8n * GiB,
  ...o
})
const dxIntel = (o: Partial<DxcoreAdapter> = {}) => dx({ ...INTEL, description: 'Intel(R) UHD Graphics', isIntegrated: true, dedicatedAdapterMemory: 128n * 1024n ** 2n, ...o })
const dxSoftware = () => dx({ ...SOFTWARE, description: 'Microsoft Basic Render Driver', isHardware: false, isIntegrated: null, dedicatedAdapterMemory: 0n })
const ok = (...adapters: DxcoreAdapter[]): DxcoreSource => ({ status: 'ok', adapters })

const LAPTOP = electronRaw(NV, INTEL, SOFTWARE)

async function select(dxcore: DxcoreSource, raw: unknown = LAPTOP, registry: [string | null, string | null] = [DEFAULT_IDS, DEFAULT_SIZES]) {
  const result = await currentProbe(raw, ...registry)
  return { selection: selectGpuList({ dxcore, electron: { result, raw }, registry: snapshot(...registry) }), electron: result }
}

const summary = (r: GpuProbeResult) =>
  r.gpus.value?.map((g) => [g.vendor.value, g.model.value ?? (g.model.quality === 'unavailable' ? g.model.reason : null), g.vramGb.value ?? (g.vramGb.quality === 'unavailable' ? g.vramGb.reason : null), g.sharedMemory.value ?? (g.sharedMemory.quality === 'unavailable' ? g.sharedMemory.reason : null)]) ?? null

describe('seleção da fonte: DXCore como fonte principal', () => {
  it('notebook híbrido: lista do DXCore; NVIDIA dedicada com VRAM do Registro confirmada; Intel integrada sem VRAM', async () => {
    const { selection } = await select(ok(dx(), dxIntel(), dxSoftware()))
    assert.equal(selection.source, 'dxcore')
    assert.equal(selection.rejection, null)
    assert.deepEqual(summary(selection.result), [
      ['nvidia', 'NVIDIA GeForce RTX 3050 Laptop GPU', 4, false],
      ['intel', 'Intel(R) UHD Graphics', 'not-dedicated', true]
    ])
    assert.equal(selection.result.ignored, 1)
    assert.equal(selection.result.gpus.quality, 'detected')
    assert.deepEqual(selection.traces, [
      { vram: 'registry-confirmed', registry: 'match' },
      { vram: 'not-dedicated', registry: 'match' }
    ])
  })

  it('VRAM divergente entre Registro e DXCore: indisponível; classificação mantida', async () => {
    const { selection } = await select(ok(dx(), dxIntel(), dxSoftware()), LAPTOP, [DEFAULT_IDS, sizes([['0000', hex(6n * GiB)]])])
    assert.deepEqual(summary(selection.result)![0], ['nvidia', 'NVIDIA GeForce RTX 3050 Laptop GPU', 'sources-diverge', false])
  })

  it('Registro indisponível, ambíguo ou com valor inválido: VRAM do próprio adaptador do DXCore', async () => {
    const ambiguous = ids([
      ['0000', 'pci\\ven_10de&dev_25a2'],
      ['0002', 'pci\\ven_10de&dev_25a2'],
      ['0001', 'pci\\ven_8086&dev_9a49']
    ])
    for (const registry of [
      [null, null],
      [ambiguous, DEFAULT_SIZES],
      [DEFAULT_IDS, sizes([['0000', '0x10']])],
      [DEFAULT_IDS, null]
    ] as Array<[string | null, string | null]>) {
      const { selection } = await select(ok(dx(), dxIntel(), dxSoftware()), LAPTOP, registry)
      assert.equal(selection.source, 'dxcore')
      assert.deepEqual(summary(selection.result)![0], ['nvidia', 'NVIDIA GeForce RTX 3050 Laptop GPU', 3.86, false], JSON.stringify(registry))
      assert.equal(selection.traces[0]!.vram, 'dxcore')
    }
  })

  it('GPUs idênticas: cada uma com os próprios atributos; o Registro nunca é associado pelo par', async () => {
    const raw = electronRaw(NV, NV)
    const { selection } = await select(ok(dx({ dedicatedAdapterMemory: 8n * GiB }), dx({ dedicatedAdapterMemory: 4n * GiB })), raw, [ids([['0000', 'pci\\ven_10de&dev_25a2']]), sizes([['0000', hex(8n * GiB)]])])
    assert.equal(selection.source, 'dxcore')
    assert.deepEqual(summary(selection.result)!.map((g) => g[2]), [8, 4])
    assert.deepEqual(selection.traces.map((t) => [t.vram, t.registry]), [
      ['dxcore', 'ambiguous'],
      ['dxcore', 'ambiguous']
    ])
  })

  it('atributo indisponível numa GPU não recusa a lista', async () => {
    const { selection } = await select(ok(dx({ isIntegrated: null, description: null }), dxIntel({ dedicatedAdapterMemory: null }), dxSoftware()))
    assert.equal(selection.source, 'dxcore')
    assert.deepEqual(summary(selection.result), [
      ['nvidia', 'not-reported', 'not-dedicated', 'integrated-unknown'],
      ['intel', 'Intel(R) UHD Graphics', 'not-dedicated', true]
    ])
    const discreteNoMemory = await select(ok(dx({ dedicatedAdapterMemory: null }), dxIntel()))
    assert.deepEqual(summary(discreteNoMemory.selection.result)![0], ['nvidia', 'NVIDIA GeForce RTX 3050 Laptop GPU', 'not-dedicated', 'dedicated-memory-unknown'])
  })

  it('Electron indisponível: a lista válida do DXCore vale sozinha', async () => {
    const { selection, electron } = await select(ok(dx(), dxIntel()), NO_ELECTRON)
    assert.equal(electron.gpus.value, null)
    assert.equal(selection.source, 'dxcore')
    assert.equal(selection.result.gpus.value?.length, 2)
  })
})

describe('seleção da fonte: alternativa Electron + Registro (comportamento atual preservado)', () => {
  const fallbackCases: Array<[string, DxcoreSource, string]> = [
    ['auxiliar ausente', { status: 'helper-unavailable' }, 'source-unavailable'],
    ['DXCore ausente no Windows', { status: 'dxcore-unavailable' }, 'source-unavailable'],
    ['prazo', { status: 'timeout' }, 'source-unavailable'],
    ['resposta inválida', { status: 'invalid-output', parseError: 'unknown-field' }, 'source-unavailable'],
    ['isHardware desconhecido', ok(dx(), dxIntel(), dx({ ...SOFTWARE, isHardware: null })), 'hardware-flag-unknown'],
    ['só software', ok(dxSoftware()), 'no-hardware-adapters'],
    ['hardware sem identificadores', ok(dx({ deviceId: null }), dxIntel()), 'hardware-id-unknown'],
    ['hardware com fabricante 0', ok(dx({ vendorId: 0 }), dxIntel()), 'hardware-id-unknown'],
    ['LUID ausente', ok(dx({ luid: null }), dxIntel()), 'luid-invalid'],
    ['LUID nulo', ok(dx({ luid: '00000000:00000000' }), dxIntel()), 'luid-invalid'],
    ['LUID repetido', ok(dx({ luid: '00000000:0000AAAA' }), dxIntel({ luid: '00000000:0000AAAA' })), 'luid-duplicate'],
    ['LUID repetido com o software', ok(dx(), dxIntel({ luid: '00000000:0000BBBB' }), { ...dxSoftware(), luid: '00000000:0000BBBB' }), 'luid-duplicate'],
    ['multiplicidade divergente (A, A, B × A, B)', ok(dx(), dx(), dxIntel()), 'lists-disagree'],
    ['composição divergente', ok(dx(), dxIntel({ deviceId: 0x46a6 })), 'lists-disagree'],
    ['GPU a menos no DXCore', ok(dx()), 'lists-disagree']
  ]
  for (const [name, dxcore, rejection] of fallbackCases) {
    it(`${name}: lista do Electron intacta (${rejection})`, async () => {
      const { selection, electron } = await select(dxcore)
      assert.equal(selection.source, 'electron')
      assert.equal(selection.rejection, rejection)
      assert.equal(selection.result, electron, 'o mesmo resultado da sondagem atual, sem cópia nem alteração')
      assert.deepEqual(summary(selection.result), [
        ['nvidia', 'NVIDIA GeForce RTX 3050 Laptop GPU', 4, 'no-evidence'],
        ['intel', 'Outro adaptador', 1, 'no-evidence']
      ])
      assert.deepEqual(selection.traces, [])
    })
  }

  it('resposta inválida: o motivo do parser fica no diagnóstico', async () => {
    const { selection } = await select({ status: 'invalid-output', parseError: 'invalid-uint64' })
    assert.deepEqual([selection.dxcoreStatus, selection.parseError, selection.rejection], ['invalid-output', 'invalid-uint64', 'source-unavailable'])
  })

  it('adaptador do Electron sem par: composição desconhecida, alternativa', async () => {
    const raw = { gpuDevice: [{ vendorId: 0x10de, deviceString: 'NVIDIA' }, { ...INTEL }] }
    const { selection } = await select(ok(dx(), dxIntel()), raw)
    assert.deepEqual([selection.source, selection.rejection], ['electron', 'lists-disagree'])
  })

  it('Electron só com o renderizador por software e DXCore com hardware: alternativa ([] estimado)', async () => {
    const { selection } = await select(ok(dx()), electronRaw(SOFTWARE))
    assert.deepEqual([selection.source, selection.rejection], ['electron', 'lists-disagree'])
    assert.deepEqual(selection.result.gpus, { value: [], quality: 'estimated' })
  })

  it('as duas fontes indisponíveis: nenhuma GPU inventada', async () => {
    const { selection } = await select({ status: 'crashed' }, NO_ELECTRON)
    assert.equal(selection.source, 'electron')
    assert.deepEqual(selection.result.gpus, { value: null, quality: 'unavailable', reason: 'api-error' })
  })
})

describe('peças da seleção', () => {
  it('composição por multiconjunto: a multiplicidade conta e a ordem não', () => {
    assert.equal(sameComposition(['a', 'b'], ['b', 'a']), true)
    assert.equal(sameComposition(['a', 'a', 'b'], ['a', 'b']), false)
    assert.equal(sameComposition(['a', 'a', 'b'], ['a', 'b', 'b']), false)
    assert.equal(sameComposition([], []), true)
  })

  it('pares do Electron: renderizador por software ignorado só pelo par exato', () => {
    assert.deepEqual(electronPairsFrom(LAPTOP), ['10de:25a2', '8086:9a49'])
    // Microsoft com outro dispositivo não é ignorado: sem par confiável de software, conta.
    assert.deepEqual(electronPairsFrom(electronRaw({ vendorId: 0x1414, deviceId: 0x0001 })), ['1414:0001'])
    assert.equal(electronPairsFrom({ gpuDevice: [{ vendorId: 0x10de }] }), null)
    assert.equal(electronPairsFrom(null), null)
  })

  it('validação da lista separa recusa da lista e atributos por GPU', () => {
    const partial = dx({ isIntegrated: null, dedicatedAdapterMemory: null, description: null })
    const software = dxSoftware()
    // Atributos ausentes numa GPU: lista aceita, software fora e contado.
    assert.deepEqual(validateDxcoreList(ok(partial, software)), { ok: true, hardware: [partial], ignored: 1 })
    assert.deepEqual(validateDxcoreList({ status: 'timeout' }), { ok: false, reason: 'source-unavailable' })
  })

  it('Registro por GPU: ausente (not-reported) ≠ presente e inválido (invalid-value); válido associa', () => {
    const NV_PAIR = '10de:25a2'
    const INTEL_PAIR = '8086:9a49'
    // Valor válido.
    assert.deepEqual(registryFor(NV_PAIR, 1, snapshot()), { kind: 'match', bytes: 4n * GiB })
    // Ausente na subchave associada (caso real da 6C.4A: só a dedicada tem o valor).
    const onlyNvidia = snapshot(DEFAULT_IDS, sizes([['0000', hex(4n * GiB)]]))
    assert.deepEqual(registryFor(INTEL_PAIR, 1, onlyNvidia), { kind: 'none', reason: 'not-reported' })
    assert.deepEqual(registryFor(NV_PAIR, 1, onlyNvidia), { kind: 'match', bytes: 4n * GiB })
    // Presente, mas inválido: formato, faixa, tipo e repetição.
    const invalid: Array<[string, string]> = [
      ['formato', sizes([['0001', 'abc']])],
      ['abaixo da faixa', sizes([['0001', hex(1024n)]])],
      ['acima da faixa', sizes([['0001', hex(2n * 1024n * GiB)]])],
      ['tipo', reg('HardwareInformation.qwMemorySize', 'REG_BINARY', [['0001', '00000040']])],
      ['repetido', `${sizes([['0001', hex(GiB)]])}\r\n    HardwareInformation.qwMemorySize    REG_QWORD    ${hex(GiB)}\r\n`]
    ]
    for (const [label, out] of invalid) assert.deepEqual(registryFor(INTEL_PAIR, 1, snapshot(DEFAULT_IDS, out)), { kind: 'none', reason: 'invalid-value' }, label)
    // Demais estados, inalterados.
    assert.deepEqual(registryFor(NV_PAIR, 2, snapshot()), { kind: 'none', reason: 'ambiguous' }) // GPUs idênticas no DXCore
    const twoSubkeys = ids([['0000', 'pci\\ven_10de&dev_25a2'], ['0001', 'pci\\ven_10de&dev_25a2']])
    assert.deepEqual(registryFor(NV_PAIR, 1, snapshot(twoSubkeys)), { kind: 'none', reason: 'ambiguous' }) // duas subchaves com o par
    assert.deepEqual(registryFor('1002:73df', 1, snapshot()), { kind: 'none', reason: 'no-match' })
    assert.deepEqual(registryFor(NV_PAIR, 1, snapshot(null)), { kind: 'none', reason: 'registry-unavailable' })
    // Nenhuma subchave com o valor: `reg query` falha, sem como distinguir de outra falha.
    assert.deepEqual(registryFor(NV_PAIR, 1, snapshot(DEFAULT_IDS, null)), { kind: 'none', reason: 'registry-unavailable' })
  })

  it('rastreio da seleção: integrada sem valor no Registro aparece como not-reported', async () => {
    const { selection } = await select(ok(dx(), dxIntel(), dxSoftware()), LAPTOP, [DEFAULT_IDS, sizes([['0000', hex(4n * GiB)]])])
    assert.equal(selection.source, 'dxcore')
    assert.deepEqual(selection.traces, [
      { vram: 'registry-confirmed', registry: 'match' },
      { vram: 'not-dedicated', registry: 'not-reported' }
    ])
  })

  it('privacidade: nada de LUID, pares PCI, memória bruta ou descrição recusada no resultado', async () => {
    // Pelo caminho real: resposta do protocolo → parser (que sanitiza) → seleção.
    const wire = (a: DxcoreAdapter, description: string | null) => ({
      ...a,
      description,
      dedicatedAdapterMemory: a.dedicatedAdapterMemory?.toString() ?? null,
      dedicatedSystemMemory: a.dedicatedSystemMemory?.toString() ?? null,
      sharedSystemMemory: a.sharedSystemMemory?.toString() ?? null
    })
    const stdout = JSON.stringify({
      protocol: 'gerpro.dxcore-adapters',
      version: 1,
      adapters: [
        wire(dx({ luid: '00000000:0000C0DE' }), 'NVIDIA GeForce RTX 3050 Laptop GPU'),
        wire(dxIntel({ luid: '00000000:0000FACE' }), 'PCI\\VEN_8086&DEV_9A49'),
        wire(dxSoftware(), null)
      ]
    })
    const source = interpretHelperResult({ kind: 'success', stdout, durationMs: 1, commandId: 'gpu.dxcore-adapters', processExited: true })
    assert.equal(source.status, 'ok')
    const { selection } = await select(source)
    const text = JSON.stringify(selection)
    for (const forbidden of ['C0DE', 'FACE', '10de', '25a2', '8086', '9a49', 'VEN_', '4148166656', 'subsys']) assert.ok(!text.includes(forbidden), forbidden)
    assert.deepEqual(summary(selection.result)![1], ['intel', 'not-reported', 'not-dedicated', true])
  })
})

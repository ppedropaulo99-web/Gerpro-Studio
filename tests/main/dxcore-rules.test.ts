import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { UINT64_MAX, VRAM_AGREEMENT, type DxcoreAdapter } from '../../src/main/hardware/local/dxcore-contract'
import { classifyMemory, resolveVram, vramAgrees, vramToProfile, vramWithinLimits } from '../../src/main/hardware/local/dxcore/rules'

// Regras de classificação e VRAM com adaptadores simulados.

const MiB = 1024n ** 2n
const GiB = 1024n ** 3n
const TiB = 1024n ** 4n
const adapter = (o: Partial<DxcoreAdapter> = {}): DxcoreAdapter => ({
  luid: '00000000:0000ABCD',
  vendorId: 0x10de,
  deviceId: 0x25a2,
  description: 'NVIDIA GeForce RTX 3050 Laptop GPU',
  isHardware: true,
  isIntegrated: false,
  dedicatedAdapterMemory: 4n * GiB,
  dedicatedSystemMemory: 0n,
  sharedSystemMemory: 8n * GiB,
  ...o
})

describe('classificação de memória (DXCore)', () => {
  it('integrada: true, mesmo com memória "dedicada" grande (reserva de APU)', () => {
    assert.deepEqual(classifyMemory(adapter({ vendorId: 0x1002, isIntegrated: true, dedicatedAdapterMemory: 8n * GiB })), { sharedMemory: true, evidence: 'dxcore-integrated' })
    assert.deepEqual(classifyMemory(adapter({ isIntegrated: true, dedicatedAdapterMemory: null })), { sharedMemory: true, evidence: 'dxcore-integrated' })
  })

  it('dedicada: false só com memória dedicada válida', () => {
    assert.deepEqual(classifyMemory(adapter()), { sharedMemory: false, evidence: 'dxcore-discrete-with-dedicated-memory' })
  })

  it('IsIntegrated desconhecido, memória ausente ou contraditória: null com motivo', () => {
    assert.deepEqual(classifyMemory(adapter({ isIntegrated: null })), { sharedMemory: null, reason: 'integrated-unknown' })
    assert.deepEqual(classifyMemory(adapter({ dedicatedAdapterMemory: null })), { sharedMemory: null, reason: 'dedicated-memory-unknown' })
    for (const bytes of [0n, 16n * MiB - 1n, TiB + 1n, UINT64_MAX]) {
      assert.deepEqual(classifyMemory(adapter({ dedicatedAdapterMemory: bytes })), { sharedMemory: null, reason: 'dedicated-memory-conflict' }, String(bytes))
    }
    for (const bytes of [16n * MiB, TiB]) assert.equal(classifyMemory(adapter({ dedicatedAdapterMemory: bytes })).sharedMemory, false, String(bytes))
  })

  it('software, virtual ou não comprovado: indisponível', () => {
    assert.deepEqual(classifyMemory(adapter({ isHardware: false, isIntegrated: true })), { sharedMemory: null, reason: 'not-hardware' })
    assert.deepEqual(classifyMemory(adapter({ isHardware: null })), { sharedMemory: null, reason: 'not-hardware' })
  })

  it('sem heurística: fabricante, nome e memória compartilhada não mudam a classificação', () => {
    // Intel dedicada (Arc) e AMD integrada: decide só IsIntegrated.
    assert.equal(classifyMemory(adapter({ vendorId: 0x8086, description: 'Intel(R) Arc(TM) A770' })).sharedMemory, false)
    assert.equal(classifyMemory(adapter({ vendorId: 0x1002, description: 'AMD Radeon(TM) Graphics', isIntegrated: true })).sharedMemory, true)
    assert.equal(classifyMemory(adapter({ description: null })).sharedMemory, false)
    // Memória do sistema não substitui a dedicada ausente.
    assert.deepEqual(classifyMemory(adapter({ dedicatedAdapterMemory: null, dedicatedSystemMemory: 4n * GiB, sharedSystemMemory: 16n * GiB })), {
      sharedMemory: null,
      reason: 'dedicated-memory-unknown'
    })
  })
})

describe('VRAM (DXCore + Registro)', () => {
  it('concordância: 64 MiB ou 5% do maior valor, em bigint e sem estouro', () => {
    assert.equal(vramAgrees(4n * GiB, 4n * GiB), true)
    assert.equal(vramAgrees(256n * MiB, 256n * MiB + VRAM_AGREEMENT.minBytes), true)
    assert.equal(vramAgrees(256n * MiB, 256n * MiB + VRAM_AGREEMENT.minBytes + 1n), false)
    // 5% de 100 GiB = 5 GiB: no limite concorda, um byte além não.
    assert.equal(vramAgrees(100n * GiB, 95n * GiB), true)
    assert.equal(vramAgrees(100n * GiB, 95n * GiB - 1n), false)
    // RTX 3050 típica: Registro 4 GiB, DXCore um pouco menos.
    assert.equal(vramAgrees(4n * GiB, 4148166656n), true)
    assert.equal(vramAgrees(UINT64_MAX, UINT64_MAX - 1n), true)
    assert.equal(vramAgrees(UINT64_MAX, 0n), false)
    assert.equal(vramAgrees(-1n, 0n), false)
  })

  it('faixa conferida em bytes nas duas pontas', () => {
    assert.equal(vramWithinLimits(16n * MiB - 1n), false)
    assert.equal(vramWithinLimits(16n * MiB), true)
    assert.equal(vramWithinLimits(TiB), true)
    assert.equal(vramWithinLimits(TiB + 1n), false)
  })

  it('integrada e não classificada: sem VRAM; memória do sistema nunca vira VRAM', () => {
    const integrated = adapter({ isIntegrated: true, dedicatedAdapterMemory: 512n * MiB })
    assert.deepEqual(resolveVram(integrated, classifyMemory(integrated), { kind: 'match', bytes: 512n * MiB }), { vramBytes: null, reason: 'not-dedicated' })
    const unknown = adapter({ isIntegrated: null })
    assert.deepEqual(resolveVram(unknown, classifyMemory(unknown), { kind: 'none', reason: 'no-match' }), { vramBytes: null, reason: 'not-dedicated' })
    const onlyShared = adapter({ dedicatedAdapterMemory: null, sharedSystemMemory: 16n * GiB })
    assert.deepEqual(resolveVram(onlyShared, classifyMemory(onlyShared), { kind: 'none', reason: 'no-match' }), { vramBytes: null, reason: 'not-dedicated' })
    // Dedicada com memória do sistema não nula: a VRAM é só a DedicatedAdapterMemory (nada somado nem substituído).
    const withSystem = adapter({ dedicatedAdapterMemory: 4148166656n, dedicatedSystemMemory: 2n * GiB, sharedSystemMemory: 16n * GiB })
    assert.deepEqual(resolveVram(withSystem, classifyMemory(withSystem), { kind: 'none', reason: 'not-reported' }), { vramBytes: 4148166656n, source: 'dxcore' })
    // DedicatedAdapterMemory zerada com DedicatedSystemMemory grande: conflito, nunca a memória do sistema.
    const systemOnly = adapter({ dedicatedAdapterMemory: 0n, dedicatedSystemMemory: 4n * GiB, sharedSystemMemory: 16n * GiB })
    assert.deepEqual(classifyMemory(systemOnly), { sharedMemory: null, reason: 'dedicated-memory-conflict' })
    assert.deepEqual(resolveVram(systemOnly, classifyMemory(systemOnly), { kind: 'match', bytes: 4n * GiB }), { vramBytes: null, reason: 'not-dedicated' })
  })

  it('dedicada: Registro inequívoco concordante vale; divergente anula; sem Registro vale o DXCore', () => {
    const a = adapter({ dedicatedAdapterMemory: 4148166656n })
    const c = classifyMemory(a)
    assert.deepEqual(resolveVram(a, c, { kind: 'match', bytes: 4n * GiB }), { vramBytes: 4n * GiB, source: 'registry-confirmed' })
    assert.deepEqual(resolveVram(a, c, { kind: 'match', bytes: 6n * GiB }), { vramBytes: null, reason: 'sources-diverge' })
    for (const reason of ['registry-unavailable', 'no-match', 'ambiguous', 'not-reported', 'invalid-value'] as const) {
      assert.deepEqual(resolveVram(a, c, { kind: 'none', reason }), { vramBytes: 4148166656n, source: 'dxcore' }, reason)
    }
    // Registro fora da faixa (não deveria chegar aqui): nunca vira valor válido.
    assert.deepEqual(resolveVram(a, c, { kind: 'match', bytes: 2n * TiB }), { vramBytes: null, reason: 'out-of-range' })
  })

  it('apresentação: GB só no fim; sem NaN, infinito, negativo ou arredondamento que valide o inválido', () => {
    assert.deepEqual(vramToProfile({ vramBytes: 4n * GiB, source: 'registry-confirmed' }), { value: 4, quality: 'detected' })
    assert.deepEqual(vramToProfile({ vramBytes: 4148166656n, source: 'dxcore' }), { value: 3.86, quality: 'detected' })
    assert.deepEqual(vramToProfile({ vramBytes: 16n * MiB, source: 'dxcore' }), { value: 0.02, quality: 'detected' })
    assert.deepEqual(vramToProfile({ vramBytes: TiB, source: 'dxcore' }), { value: 1024, quality: 'detected' })
    for (const bytes of [16n * MiB - 1n, TiB + 1n, UINT64_MAX, -1n]) {
      assert.deepEqual(vramToProfile({ vramBytes: bytes, source: 'dxcore' }), { value: null, quality: 'unavailable', reason: 'out-of-range' }, String(bytes))
    }
    assert.deepEqual(vramToProfile({ vramBytes: null, reason: 'sources-diverge' }), { value: null, quality: 'unavailable', reason: 'sources-diverge' })
  })
})

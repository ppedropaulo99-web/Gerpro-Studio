import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEMO_PROFILES, DemoHardwareDetector } from '../../src/main/hardware/detectors'
import { BUILTIN_TOOLS } from '../../src/main/tools/catalog'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import {
  DEMO_SCENARIOS,
  GPU_FIELDS,
  migrateHardwareV1,
  migrateHardwareV3,
  PROFILE_FIELDS,
  uniformQuality,
  validateAnalysisRecord,
  validateHardwareProfile,
  type DataQuality,
  type GpuInfo,
  type HardwareProfile,
  type HardwareProfileData,
  type HardwareProvenance
} from '../../src/shared/hardware'
import { estimateLocalCapability, recommendAgent, type RecommendationCandidate } from '../../src/shared/recommendations'

// Perfis de teste: dados inventados, não medidos em nenhum computador.

const COLLECTED_AT = '2026-10-23T12:00:00.000Z'

const data = (name: keyof typeof DEMO_PROFILES, extra: Partial<HardwareProfileData> = {}): HardwareProfileData => {
  const { confidence: _c, ageDays: _a, ...rest } = DEMO_PROFILES[name]
  return { ...structuredClone(rest), ...extra }
}

/** Perfil "lido" por um detector real, com a qualidade dada (padrão: tudo detectado). */
const real = (d: HardwareProfileData, quality = uniformQuality(d, 'detected')): HardwareProfile => ({
  ...d,
  provenance: { source: 'local-detector', detectorId: 'local-test', collectedAt: COLLECTED_AT, confidence: 'medium', quality }
})

const demo = (d: HardwareProfileData, quality = uniformQuality(d, 'simulated')): HardwareProfile => ({
  ...d,
  provenance: { source: 'demo', detectorId: 'demo-test', collectedAt: COLLECTED_AT, confidence: 'high', quality }
})

const paths = (p: unknown) => {
  const r = validateHardwareProfile(p)
  return r.ok ? [] : r.issues.map((i) => i.path)
}

describe('contrato v2: qualidade por atributo', () => {
  it('cada atributo e cada GPU têm qualidade própria', () => {
    const q = uniformQuality(data('workstation'), 'detected')
    assert.deepEqual(Object.keys(q.fields).sort(), [...PROFILE_FIELDS].sort())
    assert.equal(q.gpus?.length, 1)
    assert.deepEqual(Object.keys(q.gpus![0]!).sort(), [...GPU_FIELDS].sort())
  })

  it('atributos ausentes saem como indisponíveis, nunca como detectados', () => {
    const d = data('partial', {
      cpu: { model: 'CPU de teste', architecture: 'x64', physicalCores: null, logicalCores: 8 },
      memory: null
    })
    const q = uniformQuality(d, 'detected')
    for (const f of ['cpu.physicalCores', 'memory.totalGb', 'memory.availableGb', 'gpus', 'storage.freeGb', 'storage.totalGb', 'acceleration'] as const) {
      assert.equal(q.fields[f], 'unavailable', f)
    }
    for (const f of ['cpu.model', 'cpu.logicalCores', 'os.version'] as const) assert.equal(q.fields[f], 'detected', f)
    assert.equal(q.gpus, null)
  })

  it('por GPU: VRAM ausente e fabricante desconhecido são indisponíveis', () => {
    const d = data('workstation', {
      gpus: [
        { vendor: 'nvidia', model: 'GPU de teste A', vramGb: 8, sharedMemory: false },
        { vendor: 'unknown', model: 'Adaptador de teste B', vramGb: null, sharedMemory: true }
      ]
    })
    const q = uniformQuality(d, 'detected')
    assert.deepEqual(q.gpus, [
      { vendor: 'detected', model: 'detected', vramGb: 'detected', sharedMemory: 'detected' },
      { vendor: 'unavailable', model: 'detected', vramGb: 'unavailable', sharedMemory: 'detected' }
    ])
    assert.equal(validateHardwareProfile(real(d, q)).ok, true)
  })

  it('aceita combinações reais de detectado, estimado e indisponível', () => {
    const d = data('workstation', { cpu: { model: 'CPU de teste', architecture: 'x64', physicalCores: 6, logicalCores: 12 }, acceleration: null })
    const q = uniformQuality(d, 'detected')
    q.fields['cpu.physicalCores'] = 'estimated'
    q.gpus![0]!.sharedMemory = 'estimated'
    q.gpus![0]!.vramGb = 'estimated'
    const r = validateHardwareProfile(real(d, q))
    assert.ok(r.ok)
    assert.equal(r.value.provenance.quality.fields['cpu.physicalCores'], 'estimated')
    assert.equal(r.value.provenance.quality.fields.acceleration, 'unavailable')
  })

  it('rejeita valor ausente marcado como detectado ou estimado', () => {
    const d = data('partial')
    for (const quality of ['detected', 'estimated'] as const) {
      const q = uniformQuality(d, 'detected')
      q.fields.gpus = quality
      q.fields['storage.freeGb'] = quality
      assert.deepEqual(paths(real(d, q)), ['$.provenance.quality.fields.gpus', '$.provenance.quality.fields.storage.freeGb'])
    }
    const noCores = data('workstation', { cpu: { model: 'CPU de teste', architecture: 'x64', physicalCores: null, logicalCores: 8 } })
    const q = uniformQuality(noCores, 'detected')
    q.fields['cpu.physicalCores'] = 'detected'
    assert.deepEqual(paths(real(noCores, q)), ['$.provenance.quality.fields.cpu.physicalCores'])

    const noVram = data('workstation', { gpus: [{ vendor: 'amd', model: 'GPU de teste', vramGb: null, sharedMemory: false }] })
    const qv = uniformQuality(noVram, 'detected')
    qv.gpus![0]!.vramGb = 'estimated'
    assert.deepEqual(paths(real(noVram, qv)), ['$.provenance.quality.gpus[0].vramGb'])
  })

  it('rejeita valor presente marcado como indisponível', () => {
    const d = data('workstation')
    const q = uniformQuality(d, 'detected')
    q.fields['memory.totalGb'] = 'unavailable'
    q.gpus![0]!.model = 'unavailable'
    assert.deepEqual(paths(real(d, q)), ['$.provenance.quality.fields.memory.totalGb', '$.provenance.quality.gpus[0].model'])
  })

  it('perfil demonstrativo só tem dados simulados; perfil real nunca tem', () => {
    const d = data('workstation')
    assert.equal(validateHardwareProfile(demo(d)).ok, true)
    assert.equal(validateHardwareProfile(real(d)).ok, true)

    const demoClaimingDetected = demo(d, uniformQuality(d, 'detected'))
    assert.ok(paths(demoClaimingDetected).every((p) => p.startsWith('$.provenance.quality.')))
    assert.ok(paths(demoClaimingDetected).length > 0)

    const realWithSimulated = uniformQuality(d, 'detected')
    realWithSimulated.fields['os.version'] = 'simulated'
    assert.deepEqual(paths(real(d, realWithSimulated)), ['$.provenance.quality.fields.os.version'])
  })

  it('a lista de qualidade das GPUs acompanha a lista de GPUs', () => {
    const d = data('workstation')
    const q = uniformQuality(d, 'detected')
    assert.deepEqual(paths(real(d, { ...q, gpus: [] })), ['$.provenance.quality.gpus'])
    assert.deepEqual(paths(real(d, { ...q, gpus: null })), ['$.provenance.quality.gpus'])
    const none = data('modest') // gpus: [] (verificado: nenhuma)
    assert.equal(validateHardwareProfile(real(none)).ok, true)
    assert.deepEqual(paths(real(none, { ...uniformQuality(none, 'detected'), gpus: null })), ['$.provenance.quality.gpus'])
  })

  it('estrutura estrita: sem campos extras, sem campos faltando, sem qualidades desconhecidas', () => {
    const d = data('workstation')
    const q = uniformQuality(d, 'detected')
    const { 'cpu.model': _m, ...missing } = q.fields
    assert.ok(paths(real(d, { ...q, fields: missing as typeof q.fields })).includes('$.provenance.quality.fields.cpu.model'))
    assert.ok(paths(real(d, { ...q, fields: { ...q.fields, 'cpu.serial': 'detected' } as typeof q.fields })).length > 0)
    assert.ok(paths(real(d, { ...q, fields: { ...q.fields, 'os.version': 'certo' as DataQuality } })).includes('$.provenance.quality.fields.os.version'))
    const extra = { ...real(d), provenance: { ...real(d).provenance, quality: { ...q, notes: 'x' } } }
    assert.ok(paths(extra).includes('$.provenance.quality.notes'))
  })
})

describe('contrato v2: núcleos físicos desconhecidos', () => {
  const unknownCores = data('workstation', { cpu: { model: 'CPU de teste', architecture: 'arm64', physicalCores: null, logicalCores: 10 } })

  it('mantém os demais dados da CPU', () => {
    const r = validateHardwareProfile(real(unknownCores))
    assert.ok(r.ok)
    assert.deepEqual(r.value.cpu, { model: 'CPU de teste', architecture: 'arm64', physicalCores: null, logicalCores: 10 })
  })

  it('continua validando os valores numéricos quando informados', () => {
    const bad = data('workstation', { cpu: { model: 'CPU de teste', architecture: 'x64', physicalCores: 0, logicalCores: 4 } })
    assert.ok(paths(real(bad)).includes('$.cpu.physicalCores'))
    const inverted = data('workstation', { cpu: { model: 'CPU de teste', architecture: 'x64', physicalCores: 8, logicalCores: 4 } })
    assert.ok(paths(real(inverted)).includes('$.cpu.logicalCores'))
  })

  it('recomendações tratam como desconhecido, sem inventar número', () => {
    const tools = new ToolRegistry(BUILTIN_TOOLS).list({})
    const candidate: RecommendationCandidate = {
      agentId: 'a',
      name: 'A',
      origin: 'example',
      taskTypes: ['chat'],
      requirements: { source: 'declared', minRamGb: 4, recommendedRamGb: 8, preferredVramGb: 64, diskGb: 5, minCpuCores: 4 },
      modelRef: 'm',
      model: null,
      tools: []
    }
    const noGpu = { ...unknownCores, gpus: [] }
    const rec = recommendAgent(candidate, { hardware: real(noGpu), task: 'any', tools, engineAvailable: false })
    const cpu = rec.reasons.filter((r) => r.factor === 'cpu')
    assert.deepEqual(
      cpu.map((r) => r.kind),
      ['unknown']
    )
    assert.ok(!cpu.some((r) => /null/.test(r.message)))
    const capability = estimateLocalCapability(real(noGpu))
    assert.ok(capability.reasons.some((r) => r.factor === 'cpu' && r.kind === 'unknown'))
    assert.ok(!capability.reasons.some((r) => /null/.test(r.message)))
  })
})

describe('contrato v2: detector demonstrativo', () => {
  it('todo cenário produz perfil válido, com dados presentes simulados e ausentes indisponíveis', async () => {
    for (const scenario of DEMO_SCENARIOS.filter((s) => s !== 'error')) {
      const p = await new DemoHardwareDetector(scenario).detect(new AbortController().signal)
      assert.equal(validateHardwareProfile(p).ok, true, scenario)
      const qualities = [...Object.values(p.provenance.quality.fields), ...(p.provenance.quality.gpus ?? []).flatMap((g) => Object.values(g))]
      assert.ok(qualities.every((q) => q === 'simulated' || q === 'unavailable'), scenario)
      assert.ok(qualities.includes('simulated'), scenario)
    }
    const partial = await new DemoHardwareDetector('partial').detect(new AbortController().signal)
    assert.equal(partial.provenance.quality.fields.gpus, 'unavailable')
    assert.equal(partial.provenance.quality.fields['storage.freeGb'], 'unavailable')
  })
})

describe('migração v1 → v2 (função)', () => {
  const v1Provenance = { source: 'demo', detectorId: 'demo-partial', collectedAt: COLLECTED_AT, confidence: 'low' }
  const v1Consent = { localAnalysis: { status: 'granted', decidedAt: COLLECTED_AT, scope: 'demo-only' }, serverSharing: { status: 'not-asked', decidedAt: null } }
  const v1File = (profile: Record<string, unknown>) => ({
    consent: structuredClone(v1Consent),
    lastAnalysis: { mode: 'demo', attemptedAt: COLLECTED_AT, outcome: { kind: 'completed', profile } }
  })

  it('perfil demonstrativo continua demonstrativo e ganha qualidade simulada', () => {
    const migrated = migrateHardwareV1(v1File({ ...data('partial'), provenance: v1Provenance })) as { consent: unknown; lastAnalysis: unknown }
    assert.deepEqual(migrated.consent, v1Consent, 'consentimento copiado sem alteração')
    const record = validateAnalysisRecord(migrated.lastAnalysis)
    assert.ok(record.ok && record.value.outcome.kind === 'completed')
    const provenance = record.value.outcome.profile.provenance as HardwareProvenance
    assert.equal(provenance.source, 'demo')
    assert.equal(provenance.quality.fields['cpu.model'], 'simulated')
    assert.equal(provenance.quality.fields.gpus, 'unavailable')
    assert.equal(provenance.quality.gpus, null)
  })

  it('perfil real da v1 é descartado, sem presumir como foi obtido; o consentimento fica', () => {
    const migrated = migrateHardwareV1(v1File({ ...data('workstation'), provenance: { ...v1Provenance, source: 'local-detector' } }))
    assert.deepEqual(migrated, { consent: v1Consent, lastAnalysis: null })
  })

  it('registros sem perfil passam sem alteração', () => {
    const unavailable = { consent: v1Consent, lastAnalysis: { mode: 'real', attemptedAt: COLLECTED_AT, outcome: { kind: 'unavailable', reason: 'x' } } }
    assert.deepEqual(migrateHardwareV1(unavailable), unavailable)
    const empty = { consent: v1Consent, lastAnalysis: null }
    assert.deepEqual(migrateHardwareV1(empty), empty)
  })

  it('nunca lança exceção; dados fora do formato seguem para a validação como vieram', () => {
    const odd = [
      null,
      undefined,
      42,
      'texto',
      [],
      { lastAnalysis: 'x' },
      { lastAnalysis: { outcome: null } },
      { lastAnalysis: { outcome: { kind: 'completed', profile: 7 } } },
      { lastAnalysis: { outcome: { kind: 'completed', profile: { provenance: 'x' } } } },
      { lastAnalysis: { outcome: { kind: 'completed', profile: { provenance: { source: 'outro' } } } } }
    ]
    for (const input of odd) assert.deepEqual(migrateHardwareV1(input), input)
    // Perfil demonstrativo malformado: ganha qualidade, mas continua inválido.
    const broken = migrateHardwareV1(v1File({ cpu: 'x', gpus: 'y', provenance: v1Provenance })) as { lastAnalysis: unknown }
    assert.equal(validateAnalysisRecord(broken.lastAnalysis).ok, false)
  })
})

describe('contrato v3: perfis parcialmente detectados', () => {
  const partial = (o: Partial<HardwareProfileData>) => real(data('workstation', o))

  it('CPU parcial: sem modelo e sem arquitetura, os núcleos lógicos permanecem', () => {
    const p = partial({ cpu: { model: null, architecture: null, physicalCores: null, logicalCores: 16 } })
    const r = validateHardwareProfile(p)
    assert.ok(r.ok)
    assert.deepEqual(r.value.cpu, { model: null, architecture: null, physicalCores: null, logicalCores: 16 })
    assert.equal(r.value.provenance.quality.fields['cpu.model'], 'unavailable')
    assert.equal(r.value.provenance.quality.fields['cpu.logicalCores'], 'detected')
  })

  it('memória, sistema e armazenamento parciais', () => {
    assert.ok(validateHardwareProfile(partial({ memory: { totalGb: 16, availableGb: null } })).ok)
    assert.ok(validateHardwareProfile(partial({ memory: { totalGb: null, availableGb: 3 } })).ok)
    assert.ok(validateHardwareProfile(partial({ os: { platform: 'windows', version: null, architecture: null } })).ok)
    assert.ok(validateHardwareProfile(partial({ storage: { freeGb: 50, totalGb: null } })).ok)
  })

  it('seção sem nenhum atributo conhecido deve ser `null` (forma única para "nada")', () => {
    const empty = {
      cpu: { model: null, architecture: null, physicalCores: null, logicalCores: null },
      memory: { totalGb: null, availableGb: null },
      storage: { freeGb: null, totalGb: null },
      os: { platform: null, version: null, architecture: null }
    }
    for (const [section, value] of Object.entries(empty)) {
      assert.ok(paths(partial({ [section]: value })).includes(`$.${section}`), section)
    }
  })

  it('atributos continuam obrigatórios como chave: desconhecido é `null` explícito, não ausente', () => {
    const p = partial({}) as unknown as { cpu: Record<string, unknown> }
    delete p.cpu['model']
    assert.ok(paths(p).includes('$.cpu.model'))
  })

  it('coerência valor × qualidade vale para cada atributo da seção', () => {
    const d = data('workstation', { memory: { totalGb: 16, availableGb: null }, os: { platform: 'windows', version: null, architecture: 'x64' } })
    const q = uniformQuality(d, 'detected')
    assert.equal(q.fields['memory.availableGb'], 'unavailable')
    q.fields['memory.availableGb'] = 'estimated'
    q.fields['os.version'] = 'detected'
    q.fields['memory.totalGb'] = 'unavailable'
    assert.deepEqual(paths(real(d, q)).sort(), [
      '$.provenance.quality.fields.memory.availableGb',
      '$.provenance.quality.fields.memory.totalGb',
      '$.provenance.quality.fields.os.version'
    ])
  })

  it('regras entre atributos só se aplicam quando os dois são conhecidos', () => {
    assert.ok(paths(partial({ memory: { totalGb: 8, availableGb: 9 } })).includes('$.memory.availableGb'))
    assert.ok(paths(partial({ storage: { freeGb: 9, totalGb: 8 } })).includes('$.storage.freeGb'))
    assert.ok(paths(partial({ cpu: { model: null, architecture: 'x64', physicalCores: 8, logicalCores: 4 } })).includes('$.cpu.logicalCores'))
    assert.equal(validateHardwareProfile(partial({ cpu: { model: null, architecture: null, physicalCores: 8, logicalCores: null } })).ok, true)
  })

  it('perfis demonstrativos continuam válidos e simulados; um demonstrativo parcial também', () => {
    for (const name of Object.keys(DEMO_PROFILES) as Array<keyof typeof DEMO_PROFILES>) assert.equal(validateHardwareProfile(demo(data(name))).ok, true, name)
    const p = demo(data('workstation', { memory: { totalGb: 32, availableGb: null } }))
    assert.ok(validateHardwareProfile(p).ok)
    assert.equal(p.provenance.quality.fields['memory.totalGb'], 'simulated')
    assert.equal(p.provenance.quality.fields['memory.availableGb'], 'unavailable')
  })
})

describe('recomendações com dados ausentes', () => {
  const tools = new ToolRegistry(BUILTIN_TOOLS).list({})
  const candidate: RecommendationCandidate = {
    agentId: 'a',
    name: 'A',
    origin: 'example',
    taskTypes: ['chat'],
    requirements: { source: 'declared', minRamGb: 6, recommendedRamGb: 10, preferredVramGb: 64, diskGb: 5, minCpuCores: 4 },
    modelRef: 'm',
    model: null,
    tools: []
  }
  const noGpu = (o: Partial<HardwareProfileData>) => real(data('workstation', { gpus: [], ...o }))
  const rec = (p: HardwareProfile) => recommendAgent(candidate, { hardware: p, task: 'any', tools, engineAvailable: false })
  const clean = (r: { reasons: Array<{ message: string }> }) => assert.ok(!r.reasons.some((x) => /null|NaN|undefined/.test(x.message)), JSON.stringify(r.reasons))

  it('RAM total desconhecida: resultado indeterminado, sem bloqueio inventado', () => {
    const r = rec(noGpu({ memory: { totalGb: null, availableGb: 2 } }))
    assert.equal(r.fit, 'unknown')
    assert.ok(!r.reasons.some((x) => x.kind === 'blocker'))
    clean(r)
    const c = estimateLocalCapability(noGpu({ memory: { totalGb: null, availableGb: 2 } }))
    assert.equal(c.level, 'unknown')
    assert.equal(c.maxModelSizeGb, null)
  })

  it('RAM livre desconhecida: conservador (com ressalva), nunca "compatível" pleno', () => {
    const r = rec(noGpu({ memory: { totalGb: 32, availableGb: null } }))
    assert.equal(r.fit, 'limited')
    assert.ok(r.reasons.some((x) => x.factor === 'memory' && x.kind === 'unknown'))
    clean(r)
    // Com a memória livre conhecida e suficiente, a ressalva de memória desaparece.
    const full = rec(noGpu({ memory: { totalGb: 32, availableGb: 20 } }))
    assert.ok(!full.reasons.some((x) => x.factor === 'memory' && x.kind !== 'positive'))
  })

  it('espaço livre desconhecido: sem bloqueio de disco e sem comparação', () => {
    const r = rec(noGpu({ storage: { freeGb: null, totalGb: 1000 } }))
    assert.ok(r.reasons.some((x) => x.factor === 'storage' && x.kind === 'unknown'))
    assert.ok(!r.reasons.some((x) => x.factor === 'storage' && x.kind === 'blocker'))
    clean(r)
    assert.ok(estimateLocalCapability(noGpu({ storage: { freeGb: null, totalGb: 1000 } })).reasons.some((x) => x.factor === 'storage' && x.kind === 'unknown'))
  })

  it('CPU e sistema parciais não alteram a adequação calculada pela memória', () => {
    const full = rec(noGpu({ acceleration: ['avx2'] }))
    const partialCpu = rec(noGpu({ acceleration: ['avx2'], cpu: { model: null, architecture: null, physicalCores: 12, logicalCores: null }, os: { platform: null, version: null, architecture: 'x64' } }))
    assert.equal(partialCpu.fit, full.fit)
    clean(partialCpu)
  })
})

describe('contrato v4: GPUs parcialmente identificadas', () => {
  const withGpus = (gpus: GpuInfo[]) => data('workstation', { gpus })

  it('GPU sem modelo e com classificação desconhecida é representável', () => {
    const d = withGpus([{ vendor: 'nvidia', model: null, vramGb: 8, sharedMemory: null }])
    const q = uniformQuality(d, 'detected')
    assert.deepEqual(q.gpus, [{ vendor: 'detected', model: 'unavailable', vramGb: 'detected', sharedMemory: 'unavailable' }])
    assert.deepEqual(paths(real(d)), [])
  })

  it('basta um atributo conhecido para a GPU continuar na lista', () => {
    for (const gpu of [
      { vendor: 'amd', model: null, vramGb: null, sharedMemory: null },
      { vendor: 'unknown', model: 'Adaptador X', vramGb: null, sharedMemory: null },
      { vendor: 'unknown', model: null, vramGb: null, sharedMemory: true }
    ] satisfies GpuInfo[]) {
      assert.deepEqual(paths(real(withGpus([gpu]))), [], JSON.stringify(gpu))
    }
  })

  it('GPU sem nenhum atributo conhecido é recusada', () => {
    const d = withGpus([{ vendor: 'unknown', model: null, vramGb: null, sharedMemory: null }])
    assert.ok(paths(real(d)).includes('$.gpus[0]'))
  })

  it('modelo ou classificação ausentes não podem ser dados como detectados', () => {
    const d = withGpus([{ vendor: 'nvidia', model: null, vramGb: 8, sharedMemory: null }])
    const q = uniformQuality(d, 'detected')
    q.gpus![0] = { vendor: 'detected', model: 'detected', vramGb: 'detected', sharedMemory: 'estimated' }
    assert.deepEqual(paths(real(d, q)).sort(), ['$.provenance.quality.gpus[0].model', '$.provenance.quality.gpus[0].sharedMemory'])
  })

  it('tipos continuam validados: modelo vazio e classificação não booleana são recusados', () => {
    const bad = withGpus([{ vendor: 'nvidia', model: '', vramGb: 8, sharedMemory: 'talvez' as unknown as boolean }])
    assert.deepEqual(paths(real(bad)).sort(), ['$.gpus[0].model', '$.gpus[0].sharedMemory'])
  })

  it('perfis no formato anterior (modelo e classificação presentes) continuam válidos', () => {
    for (const name of Object.keys(DEMO_PROFILES) as Array<keyof typeof DEMO_PROFILES>) assert.deepEqual(paths(demo(data(name))), [], name)
  })

  it('migração v3 → v4 devolve os dados sem alteração', () => {
    const file = { consent: { x: 1 }, lastAnalysis: { outcome: { kind: 'completed', profile: demo(data('workstation')) } } }
    const copy = structuredClone(file)
    assert.equal(migrateHardwareV3(file), file)
    assert.deepEqual(file, copy)
    assert.equal(migrateHardwareV3('não é objeto'), 'não é objeto')
  })
})

describe('recomendações com classificação de memória desconhecida', () => {
  const tools = new ToolRegistry(BUILTIN_TOOLS).list({})
  const candidate: RecommendationCandidate = {
    agentId: 'a',
    name: 'A',
    origin: 'example',
    taskTypes: ['chat'],
    requirements: { source: 'declared', minRamGb: 12, recommendedRamGb: 18, preferredVramGb: 12, diskGb: 5, minCpuCores: 4 },
    modelRef: 'm',
    model: null,
    tools: []
  }
  const profile = (gpus: GpuInfo[]) => real(data('workstation', { gpus, memory: { totalGb: 8, availableGb: 6 } }))
  const rec = (p: HardwareProfile) => recommendAgent(candidate, { hardware: p, task: 'any', tools, engineAvailable: false })
  const unknownKind: GpuInfo = { vendor: 'intel', model: 'Intel(R) Arc(TM) A770 Graphics', vramGb: 16, sharedMemory: null }

  it('VRAM informada sem classificação não conta como dedicada', () => {
    const r = rec(profile([unknownKind]))
    assert.ok(!r.reasons.some((x) => x.factor === 'gpu' && x.kind === 'positive'))
    assert.ok(r.reasons.some((x) => x.factor === 'gpu' && x.kind === 'unknown' && /Tipo de memória da GPU não identificado/.test(x.message)))
    assert.ok(r.reasons.some((x) => x.factor === 'memory' && x.kind === 'blocker'))
    // A mesma GPU comprovadamente dedicada mudaria o resultado.
    const dedicated = rec(profile([{ ...unknownKind, sharedMemory: false }]))
    assert.ok(dedicated.reasons.some((x) => x.factor === 'gpu' && x.kind === 'positive'))
  })

  it('capacidade estimada: a VRAM de classificação desconhecida não aumenta o limite', () => {
    const without = estimateLocalCapability(profile([]))
    const unknown = estimateLocalCapability(profile([unknownKind]))
    assert.equal(unknown.maxModelSizeGb, without.maxModelSizeGb)
  })

  it('VRAM desconhecida não vira zero nem é inventada', () => {
    const r = rec(profile([{ vendor: 'nvidia', model: null, vramGb: null, sharedMemory: false }]))
    assert.ok(r.reasons.some((x) => x.factor === 'gpu' && x.kind === 'unknown' && /VRAM da GPU não informada/.test(x.message)))
    assert.ok(!r.reasons.some((x) => /0 GB|null|NaN|undefined/.test(x.message)))
  })
})

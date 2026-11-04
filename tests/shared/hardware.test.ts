import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEMO_PROFILES } from '../../src/main/hardware/detectors'
import { BUILTIN_TOOLS } from '../../src/main/tools/catalog'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import {
  consentCovers,
  CURRENT_GRANT_SCOPE,
  deriveAnalysisStatus,
  SCOPE_REQUIRED,
  NO_CONSENT,
  validateAnalysisRecord,
  validateAnalysisRequest,
  validateHardwareConsent,
  validateHardwareProfile,
  validateLocalConsentChange,
  uniformQuality,
  type AnalysisRecord,
  type HardwareConsent,
  type HardwareProfile,
  type HardwareProfileData,
  type HardwareProvenance
} from '../../src/shared/hardware'
import {
  estimateLocalCapability,
  estimateRequirementsFromModel,
  recommendAgent,
  recommendAgents,
  type ModelProfile,
  type RecommendationCandidate,
  type RecommendationContext
} from '../../src/shared/recommendations'

const provenance = { source: 'demo', detectorId: 'demo-test', collectedAt: '2026-10-23T12:00:00.000Z', confidence: 'high' } as const
/** Perfil demonstrativo; a qualidade acompanha os dados depois de aplicar `extra`. */
const profile = (name: keyof typeof DEMO_PROFILES, extra: Partial<HardwareProfileData> = {}, prov: Partial<HardwareProvenance> = {}): HardwareProfile => {
  const { confidence: _c, ageDays: _a, ...rest } = DEMO_PROFILES[name]
  const data: HardwareProfileData = { ...structuredClone(rest), ...extra }
  return { ...data, provenance: { ...provenance, quality: uniformQuality(data, 'simulated'), ...prov } }
}
/** O mesmo perfil, como se lido por um detector real. */
const realProfile = ({ provenance: p, ...data }: HardwareProfile): HardwareProfile => ({
  ...data,
  provenance: { ...p, source: 'local-detector', detectorId: 'local-test', quality: uniformQuality(data, 'detected') }
})
const granted: HardwareConsent = { ...NO_CONSENT, localAnalysis: { status: 'granted', decidedAt: '2026-10-23T12:00:00.000Z', scope: 'demo-only' } }
const NOW = new Date('2026-10-24T12:00:00.000Z')

describe('contratos de hardware', () => {
  it('perfis demonstrativos são válidos', () => {
    for (const name of Object.keys(DEMO_PROFILES) as Array<keyof typeof DEMO_PROFILES>) {
      assert.equal(validateHardwareProfile(profile(name)).ok, true, name)
    }
  })

  it('rejeita valores incoerentes ou campos extras', () => {
    const bad = profile('workstation', {
      memory: { totalGb: 8, availableGb: 16 },
      cpu: { model: 'x', architecture: 'x64', physicalCores: 8, logicalCores: 4 },
      storage: { freeGb: -1, totalGb: 10 }
    })
    const r = validateHardwareProfile({ ...bad, serialNumber: 'ABC123' })
    assert.equal(r.ok, false)
    assert.deepEqual(r.ok ? [] : r.issues.map((i) => i.path).sort(), ['$.cpu.logicalCores', '$.memory.availableGb', '$.serialNumber', '$.storage.freeGb'])
  })

  it('aceita desconhecido (null) e diferencia de "nenhum" ([])', () => {
    const r = validateHardwareProfile(profile('workstation', { gpus: null, acceleration: [], storage: null }))
    assert.ok(r.ok && r.value.gpus === null && r.value.acceleration?.length === 0)
  })

  it('exige origem, data e confiabilidade', () => {
    assert.equal(validateHardwareProfile(profile('workstation', {}, { collectedAt: 'ontem' })).ok, false)
    assert.equal(validateHardwareProfile(profile('workstation', {}, { confidence: 'certeza' as 'high' })).ok, false)
    const { quality: _q, ...withoutQuality } = profile('workstation').provenance
    assert.equal(validateHardwareProfile({ ...profile('workstation'), provenance: withoutQuality }).ok, false)
  })

  it('consentimento: envio ao servidor não pode ser autorizado nesta versão', () => {
    assert.equal(validateHardwareConsent(granted).ok, true)
    const server = { ...granted, serverSharing: { status: 'granted', decidedAt: '2026-10-23T12:00:00Z' } }
    assert.equal(validateHardwareConsent(server).ok, false)
    assert.equal(validateHardwareConsent({ ...NO_CONSENT, localAnalysis: { status: 'granted', decidedAt: null, scope: 'demo-only' } }).ok, false)
  })

  it('consentimento: autorização exige escopo explícito, sem presunção', () => {
    const at = '2026-10-23T12:00:00Z'
    assert.equal(validateHardwareConsent({ ...NO_CONSENT, localAnalysis: { status: 'granted', decidedAt: at } }).ok, false, 'sem campo scope')
    assert.equal(validateHardwareConsent({ ...NO_CONSENT, localAnalysis: { status: 'granted', decidedAt: at, scope: null } }).ok, false)
    assert.equal(validateHardwareConsent({ ...NO_CONSENT, localAnalysis: { status: 'granted', decidedAt: at, scope: 'tudo' } }).ok, false)
    assert.equal(validateHardwareConsent({ ...NO_CONSENT, localAnalysis: { status: 'revoked', decidedAt: at, scope: 'demo-only' } }).ok, false)
  })

  it('autorização demonstrativa não cobre detecção real; a real cobre ambas', () => {
    const real: HardwareConsent = { ...NO_CONSENT, localAnalysis: { ...granted.localAnalysis, scope: 'device-detection' } }
    assert.equal(consentCovers(granted, SCOPE_REQUIRED.demo), true)
    assert.equal(consentCovers(granted, SCOPE_REQUIRED.real), false)
    assert.equal(consentCovers(real, SCOPE_REQUIRED.real), true)
    assert.equal(consentCovers(real, SCOPE_REQUIRED.demo), true)
    assert.equal(consentCovers(NO_CONSENT, SCOPE_REQUIRED.demo), false)
    assert.equal(CURRENT_GRANT_SCOPE, 'demo-only')
  })

  it('análise demonstrativa precisa de perfil marcado como demonstração', () => {
    const record = { mode: 'demo', attemptedAt: provenance.collectedAt, outcome: { kind: 'completed', profile: profile('workstation') } }
    assert.equal(validateAnalysisRecord(record).ok, true)
    // Perfil real válido por si só: quem o recusa é a regra do registro demonstrativo.
    const real = realProfile(profile('workstation'))
    assert.equal(validateHardwareProfile(real).ok, true)
    const disguised = { ...record, outcome: { kind: 'completed', profile: real } }
    assert.equal(validateAnalysisRecord(disguised).ok, false)
  })

  it('valida pedidos de análise e mudanças de consentimento vindos do IPC', () => {
    assert.deepEqual(validateAnalysisRequest({ mode: 'demo' }), { ok: true, value: { mode: 'demo', scenario: 'workstation' } })
    assert.equal(validateAnalysisRequest({ mode: 'real', scenario: 'modest' }).ok, false)
    assert.equal(validateAnalysisRequest({ mode: 'demo', scenario: 'supercomputador' }).ok, false)
    assert.deepEqual(validateLocalConsentChange({ granted: false, deleteData: true }), { ok: true, value: { granted: false, deleteData: true } })
    assert.equal(validateLocalConsentChange({ granted: true, deleteData: true }).ok, false)
    assert.equal(validateLocalConsentChange({ granted: 'sim' }).ok, false)
  })
})

describe('estados da análise', () => {
  const record = (outcome: AnalysisRecord['outcome']): AnalysisRecord => ({ mode: 'demo', attemptedAt: NOW.toISOString(), outcome })

  it('cobre os seis estados', () => {
    assert.equal(deriveAnalysisStatus(NO_CONSENT, null, NOW), 'not-authorized')
    assert.equal(deriveAnalysisStatus(granted, null, NOW), 'awaiting-analysis')
    assert.equal(deriveAnalysisStatus(granted, record({ kind: 'unavailable', reason: 'x' }), NOW), 'unavailable')
    assert.equal(deriveAnalysisStatus(granted, record({ kind: 'error', message: 'x' }), NOW), 'error')
    assert.equal(deriveAnalysisStatus(granted, record({ kind: 'completed', profile: profile('workstation') }), NOW), 'completed')
    const old = profile('workstation', {}, { collectedAt: '2026-07-01T00:00:00Z' })
    assert.equal(deriveAnalysisStatus(granted, record({ kind: 'completed', profile: old }), NOW), 'stale')
  })

  it('sem autorização vigente, dados existentes não contam', () => {
    const revoked = { ...NO_CONSENT, localAnalysis: { status: 'revoked', decidedAt: NOW.toISOString(), scope: null } } as const
    assert.equal(deriveAnalysisStatus(revoked, record({ kind: 'completed', profile: profile('workstation') }), NOW), 'not-authorized')
  })
})

describe('motor de recomendações', () => {
  const tools = new ToolRegistry(BUILTIN_TOOLS).list({})
  const model = (o: Partial<ModelProfile> = {}): ModelProfile => ({
    id: 'm',
    name: 'Modelo 8B',
    sizeGb: 4.9,
    contextLength: 32768,
    capabilities: ['chat', 'tools'],
    availability: 'installed',
    source: 'local-provider',
    ...o
  })
  const candidate = (o: Partial<RecommendationCandidate> = {}): RecommendationCandidate => ({
    agentId: 'a',
    name: 'A',
    origin: 'example',
    taskTypes: ['chat'],
    requirements: null,
    modelRef: 'm',
    model: model(),
    tools: [],
    ...o
  })
  const ctx = (o: Partial<RecommendationContext> = {}): RecommendationContext => ({
    hardware: profile('workstation'),
    task: 'any',
    tools,
    engineAvailable: false,
    ...o
  })

  it('hardware adequado: recomendado, mas nunca executável sem motor', () => {
    const r = recommendAgent(candidate(), ctx())
    assert.equal(r.fit, 'recommended-local')
    assert.equal(r.executableNow, false)
    assert.ok(r.reasons.some((x) => x.factor === 'engine'))
  })

  it('com motor, modelo instalado e sem ferramentas pendentes, passa a ser executável', () => {
    assert.equal(recommendAgent(candidate(), ctx({ engineAvailable: true })).executableNow, true)
    assert.equal(recommendAgent(candidate({ tools: ['calculator'] }), ctx({ engineAvailable: true })).executableNow, false)
  })

  it('pouca memória e disco no perfil: não recomendado (needs-resources), com motivos', () => {
    const big = candidate({ model: model({ name: 'Grande', sizeGb: 10.2, availability: 'not-installed' }) })
    const r = recommendAgent(big, ctx({ hardware: profile('modest') }))
    assert.equal(r.fit, 'needs-resources')
    assert.deepEqual(r.reasons.filter((x) => x.kind === 'blocker').map((x) => x.factor).sort(), ['memory', 'storage'])
  })

  it('sem perfil (não autorizado): compatibilidade desconhecida, com a explicação recebida', () => {
    const r = recommendAgent(candidate(), ctx({ hardware: null, hardwareNote: 'Análise não autorizada.' }))
    assert.equal(r.fit, 'unknown')
    assert.ok(r.reasons.some((x) => x.message === 'Análise não autorizada.'))
  })

  it('modelo fora da biblioteca: desconhecida', () => {
    assert.equal(recommendAgent(candidate({ model: null, modelRef: 'misterioso' }), ctx()).fit, 'unknown')
  })

  it('perfil parcial (GPU e disco desconhecidos) não vira recomendação plena', () => {
    const r = recommendAgent(candidate({ model: model({ availability: 'not-installed' }) }), ctx({ hardware: profile('partial') }))
    assert.equal(r.fit, 'limited')
    assert.ok(r.reasons.some((x) => x.kind === 'unknown' && x.factor === 'gpu'))
    assert.ok(r.reasons.some((x) => x.kind === 'unknown' && x.factor === 'storage'))
  })

  it('memória total desconhecida: desconhecida', () => {
    assert.equal(recommendAgent(candidate(), ctx({ hardware: profile('workstation', { memory: null }) })).fit, 'unknown')
  })

  it('não decide por critério isolado: mesma RAM, resultados diferentes por disco, GPU e CPU', () => {
    const notInstalled = candidate({ model: model({ availability: 'not-installed' }) })
    const base = profile('workstation')
    assert.equal(recommendAgent(notInstalled, ctx({ hardware: base })).fit, 'recommended-local')
    assert.equal(recommendAgent(notInstalled, ctx({ hardware: { ...base, storage: { freeGb: 3, totalGb: 500 } } })).fit, 'needs-resources')
    assert.equal(recommendAgent(notInstalled, ctx({ hardware: { ...base, gpus: [] } })).fit, 'limited')
    const weakCpu = { ...base, gpus: [], cpu: { ...base.cpu!, physicalCores: 2, logicalCores: 2 } }
    assert.ok(recommendAgent(notInstalled, ctx({ hardware: weakCpu })).reasons.some((r) => r.factor === 'cpu'))
    // VRAM suficiente compensa RAM menor que o modelo.
    const bigModel = candidate({ model: model({ sizeGb: 9 }) })
    const lowRamBigGpu = { ...base, memory: { totalGb: 8, availableGb: 6 }, gpus: [{ vendor: 'other' as const, model: 'G', vramGb: 24, sharedMemory: false }] }
    assert.equal(recommendAgent(bigModel, ctx({ hardware: lowRamBigGpu })).fit, 'recommended-local')
  })

  it('requisitos declarados prevalecem sobre a estimativa do modelo', () => {
    const declared = { minRamGb: 40, recommendedRamGb: 64, preferredVramGb: 40, diskGb: 5, minCpuCores: 8, source: 'declared' as const }
    const r = recommendAgent(candidate({ requirements: declared }), ctx())
    assert.equal(r.fit, 'needs-resources')
    assert.equal(r.requirements?.source, 'declared')
  })

  it('tipo de tarefa ordena e justifica, sem alterar a adequação ao hardware', () => {
    const coder = candidate({ agentId: 'coder', name: 'Coder', taskTypes: ['code'] })
    const chat = candidate({ agentId: 'chat', name: 'Chat', taskTypes: ['chat'] })
    const unknown = candidate({ agentId: 'novo', name: 'Novo', taskTypes: null, origin: 'saved' })
    const recs = recommendAgents([chat, unknown, coder], ctx({ task: 'code' }))
    assert.deepEqual(recs.map((r) => `${r.agentId}:${r.taskMatch}`), ['coder:match', 'novo:unknown', 'chat:mismatch'])
    assert.equal(recs.find((r) => r.agentId === 'chat')!.fit, 'recommended-local')
  })

  it('ferramentas: sem implementação é observação; desativada é limitação', () => {
    const disabledCtx = ctx({ tools: new ToolRegistry(BUILTIN_TOOLS, new Set(['calculator'])).list({ calculator: false }) })
    assert.equal(recommendAgent(candidate({ tools: ['web-search'] }), ctx()).fit, 'recommended-local')
    assert.equal(recommendAgent(candidate({ tools: ['calculator'] }), disabledCtx).fit, 'limited')
  })

  it('estimativa de requisitos cresce com o modelo e o contexto', () => {
    const small = estimateRequirementsFromModel({ sizeGb: 2, contextLength: 8192 })
    const large = estimateRequirementsFromModel({ sizeGb: 20, contextLength: 131072 })
    assert.ok(large.minRamGb > small.minRamGb && large.recommendedRamGb > large.minRamGb)
    assert.equal(large.minCpuCores, 6)
  })
})

describe('compatibilidade estimada com processamento local', () => {
  it('classifica perfis e explica', () => {
    assert.equal(estimateLocalCapability(profile('workstation')).level, 'medium')
    assert.equal(estimateLocalCapability(profile('workstation', { memory: { totalGb: 64, availableGb: 40 } })).level, 'high')
    assert.equal(estimateLocalCapability(profile('modest')).level, 'low')
    assert.equal(estimateLocalCapability(profile('modest', { memory: { totalGb: 4, availableGb: 1 } })).level, 'insufficient')
    assert.equal(estimateLocalCapability(null).level, 'unknown')
    assert.equal(estimateLocalCapability(profile('workstation', { memory: null })).level, 'unknown')
    assert.ok(estimateLocalCapability(profile('partial')).reasons.some((r) => r.kind === 'unknown'))
  })
})

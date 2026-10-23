import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CompatibilityAssessment, CompatibilityTest } from '../../src/shared/compatibility'
import {
  ESTIMATE_RULES,
  evaluateCompatibility,
  recommendModels,
  type EvaluationContext,
  type EvaluationStep,
  type RecommendationRequest,
  type TaskQualityEvidence
} from '../../src/shared/compatibility-evaluator'
import { DEFAULT_EXECUTION_PROFILE, type ExecutionProfile } from '../../src/shared/execution'
import { validateHardwareProfile, type GpuInfo, type HardwareProfile } from '../../src/shared/hardware'
import { validateProviderModel, type ProviderModel, type ProviderModelEntry } from '../../src/shared/inference'

// ---------------------------------------------------------------------------
// Perfis SINTÉTICOS: valores inventados para teste, não medidos em nenhum computador.
// ---------------------------------------------------------------------------

const GiB = ESTIMATE_RULES.bytesPerGb
const NOW = '2026-10-23T12:00:00.000Z'
const synthetic = { source: 'demo', detectorId: 'synthetic-test', collectedAt: NOW, confidence: 'high' } as const

const dedicated = (vramGb: number | null): GpuInfo => ({ vendor: 'other', model: 'GPU dedicada sintética', vramGb, sharedMemory: false })
const integrated: GpuInfo = { vendor: 'other', model: 'GPU integrada sintética', vramGb: null, sharedMemory: true }

function hw(totalGb: number, availableGb: number, gpus: GpuInfo[] | null, extra: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    cpu: { model: 'CPU sintética', architecture: 'x64', physicalCores: 8, logicalCores: 16 },
    memory: { totalGb, availableGb },
    gpus,
    storage: { freeGb: 200, totalGb: 500 },
    os: { platform: 'windows', version: '11', architecture: 'x64' },
    acceleration: [],
    provenance: synthetic,
    ...extra
  }
}

const SYNTHETIC = {
  /** 8 GB de RAM, sem GPU dedicada. */
  ram8: hw(8, 5, []),
  /** 16 GB de RAM + GPU dedicada de 4 GB. */
  ram16vram4: hw(16, 10, [dedicated(4)]),
  /** 16 GB de RAM com GPU integrada. */
  ram16integrated: hw(16, 9, [integrated]),
  /** 32 GB de RAM + GPU dedicada de 12 GB. */
  ram32vram12: hw(32, 24, [dedicated(12)])
} as const

const completed = (profile: HardwareProfile) =>
  ({ status: 'completed', analysis: { mode: 'demo', attemptedAt: NOW, outcome: { kind: 'completed', profile } } }) as const

// Modelos sintéticos: tamanhos exatos em GiB e memória de contexto conhecida.
function model(modelId: string, o: Partial<ProviderModel> = {}): ProviderModel {
  return {
    ref: { providerId: 'local-a', modelId },
    digest: `sha256-${modelId}`,
    location: 'local',
    displayName: modelId,
    family: null,
    parameterSize: null,
    quantization: 'Q4_K_M',
    format: 'gguf',
    sizeBytes: 4 * GiB,
    contextLength: 32768,
    contextBytesPerToken: 131072, // 8192 tokens = 1 GiB
    capabilities: ['chat'],
    ...o
  }
}
const installed = (m: ProviderModel): ProviderModelEntry => ({ model: m, availability: 'installed' })
const notInstalled = (m: ProviderModel): ProviderModelEntry => ({ model: m, availability: 'not-installed' })

const SMALL = model('pequeno-2b', { sizeBytes: 2 * GiB, contextLength: 8192 })
const MEDIUM = model('medio-7b', { sizeBytes: 4.5 * GiB })
const LARGE = model('grande-14b', { sizeBytes: 8 * GiB, contextBytesPerToken: 262144 })

const profile = (o: Partial<ExecutionProfile> = {}): ExecutionProfile => ({ ...DEFAULT_EXECUTION_PROFILE, contextLength: 8192, ...o })

function ctx(o: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    profile: profile(),
    task: 'any',
    minContextTokens: null,
    hardware: completed(SYNTHETIC.ram32vram12),
    deviceKey: 'dispositivo-sintetico',
    priorAssessments: [],
    taskEvidence: [],
    now: NOW,
    ...o
  }
}

function request(target: ProviderModel, inventory: ProviderModelEntry[], o: Partial<EvaluationContext> = {}): RecommendationRequest {
  return { ...ctx(o), target: target.ref, inventory }
}

function tested(m: ProviderModel, test: Partial<CompatibilityTest>, o: { profile?: ExecutionProfile; deviceKey?: string | null; digest?: string | null } = {}): CompatibilityAssessment {
  const p = o.profile ?? profile()
  return {
    basis: {
      model: m.ref,
      modelDigest: o.digest === undefined ? m.digest : o.digest,
      profile: { contextLength: p.contextLength, gpuMode: p.gpuMode, cpuThreads: p.cpuThreads },
      deviceKey: o.deviceKey === undefined ? 'dispositivo-sintetico' : o.deviceKey,
      rulesVersion: 1
    },
    state: 'not-verified',
    reasons: [],
    hardwareSource: 'demo',
    assessedAt: '2026-10-20T12:00:00.000Z',
    lastTest: { at: '2026-10-20T12:00:00.000Z', outcome: 'success', errorCode: null, metrics: null, ...test },
    alternatives: []
  }
}

const rules = (e: { steps: Array<{ rule: string }> }) => e.steps.map((s) => s.rule)
const step = (e: { steps: EvaluationStep[] }, rule: string) => e.steps.find((s) => s.rule === rule)

// ---------------------------------------------------------------------------

describe('compatibilidade: fixtures sintéticas', () => {
  it('perfis e modelos sintéticos respeitam os contratos', () => {
    for (const p of Object.values(SYNTHETIC)) assert.deepEqual(validateHardwareProfile(p), { ok: true, value: p })
    for (const m of [SMALL, MEDIUM, LARGE]) assert.deepEqual(validateProviderModel(installed(m)), { ok: true, value: installed(m) })
  })
})

describe('compatibilidade: quatro perfis sintéticos', () => {
  const at = (p: HardwareProfile, m: ProviderModel, o: Partial<EvaluationContext> = {}) =>
    evaluateCompatibility(installed(m), ctx({ hardware: completed(p), ...o }))

  it('8 GB, sem GPU: médio cabe na RAM; grande não', () => {
    const medium = at(SYNTHETIC.ram8, MEDIUM)
    assert.equal(medium.state, 'estimated-compatible')
    assert.equal(medium.estimate!.placement, 'cpu')
    assert.equal(medium.estimate!.requiredGb, 5.5)
    assert.equal(medium.estimate!.usableRamGb, 6)
    // 5,5 GB cabem nos 6 utilizáveis, mas só 5 estavam livres: liberar memória (ou reduzir o contexto), não "incompatível".
    assert.equal(medium.memoryNow, 'insufficient')
    assert.deepEqual(medium.assessment.alternatives.map((a) => a.kind), ['free-memory', 'profile-adjustment'])

    const large = at(SYNTHETIC.ram8, LARGE)
    assert.equal(large.state, 'not-recommended')
    assert.equal(large.estimate!.ramGb, 10)
  })

  it('16 GB + 4 GB de VRAM: execução parcial na GPU, sem afirmar camadas nem desempenho', () => {
    const large = at(SYNTHETIC.ram16vram4, LARGE)
    assert.equal(large.state, 'estimated-compatible')
    assert.equal(large.estimate!.placement, 'gpu-partial')
    assert.equal(large.estimate!.gpuGb, 3.6)
    assert.equal(large.estimate!.ramGb, 6.4)
    assert.match(step(large, 'resources.placement')!.message, /divisão de camadas e o desempenho .* não são estimados/)
  })

  it('16 GB com GPU integrada: só a RAM conta', () => {
    const large = at(SYNTHETIC.ram16integrated, LARGE)
    assert.equal(large.estimate!.placement, 'shared-memory')
    assert.equal(large.estimate!.gpuGb, 0)
    assert.equal(large.estimate!.ramGb, 10)
    assert.equal(large.state, 'estimated-compatible')
  })

  it('32 GB + 12 GB de VRAM: grande cabe inteiro na VRAM; `cpu-only` muda o posicionamento', () => {
    const large = at(SYNTHETIC.ram32vram12, LARGE)
    assert.equal(large.estimate!.placement, 'gpu-full')
    assert.equal(large.estimate!.gpuGb, 10)
    assert.equal(large.state, 'estimated-compatible')
    const cpu = at(SYNTHETIC.ram32vram12, LARGE, { profile: profile({ gpuMode: 'cpu-only' }) })
    assert.equal(cpu.estimate!.placement, 'cpu')
    assert.equal(cpu.estimate!.ramGb, 10)
  })
})

describe('compatibilidade: dados ausentes', () => {
  it('sem consentimento não há perfil, mesmo com uma análise gravada', () => {
    const e = evaluateCompatibility(installed(MEDIUM), ctx({ hardware: { ...completed(SYNTHETIC.ram32vram12), status: 'not-authorized' } }))
    assert.equal(e.state, 'not-verified')
    assert.equal(e.estimate, null)
    assert.equal(e.assessment.hardwareSource, null)
    assert.match(step(e, 'resources.hardware-profile')!.message, /não autorizada/)
    const r = recommendModels(request(MEDIUM, [installed(MEDIUM), installed(SMALL)], { hardware: { status: 'not-authorized', analysis: null } }))
    assert.equal(r.decision, 'insufficient-data')
    assert.deepEqual(r.installedAlternatives, [])
  })

  it('tamanho do modelo ou RAM desconhecidos: não verificado', () => {
    assert.equal(evaluateCompatibility(installed(model('x', { sizeBytes: null })), ctx()).state, 'not-verified')
    assert.equal(evaluateCompatibility(installed(MEDIUM), ctx({ hardware: completed(hw(16, 8, [], { memory: null })) })).state, 'not-verified')
  })

  it('memória por token desconhecida: o contexto fica fora da estimativa, declarado como desconhecido', () => {
    const e = evaluateCompatibility(installed(model('x', { contextBytesPerToken: null })), ctx())
    assert.equal(e.estimate!.contextGb, null)
    assert.deepEqual(e.estimate!.unknownComponents, ['context'])
    assert.equal(step(e, 'resources.context-memory')!.message.includes('não informada'), true)
    assert.equal(e.steps.find((s) => s.rule === 'resources.context-memory')!.kind, 'unknown')
  })

  it('GPU dedicada com VRAM desconhecida: não caber na RAM não basta para desaconselhar', () => {
    const p = completed(hw(8, 6, [dedicated(null)]))
    const e = evaluateCompatibility(installed(LARGE), ctx({ hardware: p }))
    assert.equal(e.estimate!.placement, 'unknown-vram')
    assert.equal(e.state, 'not-verified')
    // Se cabe só na RAM, a estimativa vale sem precisar da VRAM.
    assert.equal(evaluateCompatibility(installed(SMALL), ctx({ hardware: p })).state, 'estimated-compatible')
  })

  it('GPU não identificada (`gpus: null`) é tratada como desconhecida, não como ausente', () => {
    const e = evaluateCompatibility(installed(LARGE), ctx({ hardware: completed(hw(8, 6, null)) }))
    assert.equal(e.estimate!.placement, 'unknown-gpu')
    assert.equal(e.state, 'not-verified')
  })

  it('contexto máximo do modelo desconhecido: elegibilidade desconhecida, não recusada', () => {
    const e = evaluateCompatibility(installed(model('x', { contextLength: null })), ctx({ minContextTokens: 16384, profile: profile({ contextLength: 16384 }) }))
    assert.equal(e.eligibility, 'unknown')
    assert.notEqual(e.state, 'confirmed-incompatible')
  })
})

describe('compatibilidade: elegibilidade', () => {
  it('modelo remoto nunca é opção local nem alternativa', () => {
    const remote = model('nuvem-70b', { location: 'remote', sizeBytes: 1 * GiB })
    const e = evaluateCompatibility(installed(remote), ctx())
    assert.equal(e.eligibility, 'ineligible')
    assert.equal(e.state, 'not-recommended')
    const r = recommendModels(request(LARGE, [installed(LARGE), installed(remote)], { hardware: completed(SYNTHETIC.ram8) }))
    assert.ok(![...r.installedAlternatives, ...r.notInstalledAlternatives].some((a) => a.evaluation.model.modelId === 'nuvem-70b'))
  })

  it('modelo sem capacidade de chat é inelegível', () => {
    const e = evaluateCompatibility(installed(model('embed', { capabilities: ['embedding'] })), ctx())
    assert.equal(e.eligibility, 'ineligible')
    assert.ok(rules(e).includes('eligibility.chat'))
  })

  it('contexto insuficiente para a tarefa: modelo inelegível; perfil curto demais: ajuste', () => {
    const short = evaluateCompatibility(installed(SMALL), ctx({ minContextTokens: 16384 }))
    assert.equal(short.eligibility, 'ineligible')
    const r = recommendModels(request(MEDIUM, [installed(MEDIUM)], { minContextTokens: 16384, profile: profile({ contextLength: 4096 }) }))
    assert.equal(r.decision, 'adjust-profile')
    assert.deepEqual(r.profileAdjustment!.override, { contextLength: 16384 })
    assert.equal(r.profileAdjustment!.evaluation.state, 'estimated-compatible')
  })

  it('perfil acima do contexto do modelo: ajuste para o máximo do modelo', () => {
    const r = recommendModels(request(SMALL, [installed(SMALL)], { profile: profile({ contextLength: 32768 }) }))
    assert.equal(r.target!.state, 'not-recommended')
    assert.equal(r.decision, 'adjust-profile')
    assert.deepEqual(r.profileAdjustment!.override, { contextLength: 8192 })
  })
})

describe('compatibilidade: disponibilidade', () => {
  it('modelo não instalado nunca é recomendado como disponível', () => {
    const r = recommendModels(request(MEDIUM, [notInstalled(MEDIUM), notInstalled(SMALL)]))
    assert.notEqual(r.decision, 'use-target')
    assert.notEqual(r.decision, 'use-alternative')
    assert.deepEqual(r.installedAlternatives, [])
    assert.deepEqual(r.notInstalledAlternatives.map((a) => a.evaluation.model.modelId), ['pequeno-2b'])
    assert.match(r.notInstalledAlternatives[0]!.reason, /Não instalado/)
    assert.ok(r.rationale.some((t) => /não está instalado/.test(t)))
  })

  it('modelo fora do inventário e modelo ambíguo entre provedores', () => {
    assert.equal(recommendModels(request(model('inexistente'), [installed(SMALL)])).targetIssue, 'not-in-inventory')
    const other = model('medio-7b', { ref: { providerId: 'local-b', modelId: 'medio-7b' } })
    const r = recommendModels({ ...request(MEDIUM, [installed(MEDIUM), installed(other)]), target: { providerId: null, modelId: 'medio-7b' } })
    assert.equal(r.targetIssue, 'ambiguous-provider')
    assert.equal(r.target, null)
  })

  it('alternativas instaladas e não instaladas ficam em listas separadas', () => {
    const r = recommendModels(request(LARGE, [installed(LARGE), installed(SMALL), notInstalled(MEDIUM)], { hardware: completed(SYNTHETIC.ram8) }))
    assert.equal(r.decision, 'use-alternative')
    assert.deepEqual(r.installedAlternatives.map((a) => a.evaluation.model.modelId), ['pequeno-2b'])
    assert.deepEqual(r.notInstalledAlternatives.map((a) => a.evaluation.model.modelId), ['medio-7b'])
    assert.equal(r.installedAlternatives[0]!.kind, 'smaller-model')
  })
})

describe('compatibilidade: testes anteriores', () => {
  it('teste válido nas mesmas condições prevalece sobre a estimativa', () => {
    const e = evaluateCompatibility(installed(LARGE), ctx({ hardware: completed(SYNTHETIC.ram8), priorAssessments: [tested(LARGE, {})] }))
    assert.equal(e.estimateState, 'not-recommended')
    assert.equal(e.state, 'tested-compatible')
    assert.equal(e.assessment.lastTest!.outcome, 'success')
  })

  it('teste invalidado por digest, contexto ou dispositivo é ignorado; amostragem não invalida', () => {
    const base = { hardware: completed(SYNTHETIC.ram8) }
    const cases: CompatibilityAssessment[] = [
      tested(LARGE, {}, { digest: 'sha256-antigo' }),
      tested(LARGE, {}, { profile: profile({ contextLength: 4096 }) }),
      tested(LARGE, {}, { deviceKey: 'outro-dispositivo' })
    ]
    for (const prior of cases) {
      const e = evaluateCompatibility(installed(LARGE), ctx({ ...base, priorAssessments: [prior] }))
      assert.equal(e.state, 'not-recommended')
      assert.equal(e.assessment.lastTest, null)
      assert.ok(rules(e).includes('evidence.validity'))
    }
    // Sem dispositivo identificado, nenhum teste vale.
    const unknownDevice = evaluateCompatibility(installed(LARGE), ctx({ ...base, deviceKey: null, priorAssessments: [tested(LARGE, {}, { deviceKey: null })] }))
    assert.equal(unknownDevice.state, 'not-recommended')
    const sampling = evaluateCompatibility(installed(LARGE), ctx({ ...base, profile: profile({ temperature: 0.1, seed: 7 }), priorAssessments: [tested(LARGE, {})] }))
    assert.equal(sampling.state, 'tested-compatible')
  })

  it('falta de memória em teste é transitória: nunca confirma incompatibilidade', () => {
    const e = evaluateCompatibility(
      installed(MEDIUM),
      ctx({ priorAssessments: [tested(MEDIUM, { outcome: 'failure', errorCode: 'insufficient-memory' })] })
    )
    assert.equal(e.estimateState, 'estimated-compatible')
    assert.equal(e.state, 'not-recommended')
    assert.notEqual(e.state, 'confirmed-incompatible')
    assert.match(step(e, 'evidence.failure')!.message, /transitória/)
    assert.ok(e.assessment.alternatives.some((a) => a.kind === 'free-memory'))
  })

  it('tempo esgotado ou cancelamento não mudam a estimativa; recusa do provedor confirma', () => {
    const timeout = evaluateCompatibility(installed(MEDIUM), ctx({ priorAssessments: [tested(MEDIUM, { outcome: 'failure', errorCode: 'timeout' })] }))
    assert.equal(timeout.state, 'estimated-compatible')
    const cancelled = evaluateCompatibility(installed(MEDIUM), ctx({ priorAssessments: [tested(MEDIUM, { outcome: 'failure', errorCode: 'cancelled' })] }))
    assert.equal(cancelled.state, 'estimated-compatible')
    const refused = evaluateCompatibility(installed(MEDIUM), ctx({ priorAssessments: [tested(MEDIUM, { outcome: 'failure', errorCode: 'model-unsupported' })] }))
    assert.equal(refused.state, 'confirmed-incompatible')
  })

  it('só o teste mais recente do modelo conta', () => {
    const older = tested(MEDIUM, { at: '2026-10-01T00:00:00.000Z', outcome: 'failure', errorCode: 'insufficient-memory' })
    const newer = tested(MEDIUM, { at: '2026-10-22T00:00:00.000Z' })
    assert.equal(evaluateCompatibility(installed(MEDIUM), ctx({ priorAssessments: [newer, older] })).state, 'tested-compatible')
    assert.equal(evaluateCompatibility(installed(MEDIUM), ctx({ priorAssessments: [older, newer] })).state, 'tested-compatible')
  })
})

describe('compatibilidade: adequação à tarefa', () => {
  const evidence = (m: ProviderModel, rating: TaskQualityEvidence['rating'], o: Partial<TaskQualityEvidence> = {}): TaskQualityEvidence => ({
    model: m.ref,
    modelDigest: m.digest,
    task: 'code',
    rating,
    source: 'avaliacao-sintetica',
    assessedAt: NOW,
    ...o
  })

  it('sem avaliação de qualidade, a adequação é desconhecida e não pesa', () => {
    const e = evaluateCompatibility(installed(MEDIUM), ctx({ task: 'code' }))
    assert.equal(e.taskFit, 'unknown')
    assert.equal(e.state, 'estimated-compatible')
    assert.equal(evaluateCompatibility(installed(MEDIUM), ctx()).taskFit, 'not-applicable')
  })

  it('avaliação de outro digest é ignorada; avaliações divergentes ficam desconhecidas', () => {
    assert.equal(evaluateCompatibility(installed(MEDIUM), ctx({ task: 'code', taskEvidence: [evidence(MEDIUM, 'suitable', { modelDigest: 'sha256-x' })] })).taskFit, 'unknown')
    const mixed = [evidence(MEDIUM, 'suitable'), evidence(MEDIUM, 'unsuitable', { source: 'outra' })]
    assert.equal(evaluateCompatibility(installed(MEDIUM), ctx({ task: 'code', taskEvidence: mixed })).taskFit, 'unknown')
  })

  it('modelo avaliado como inadequado não é recomendado para a tarefa', () => {
    const r = recommendModels(request(MEDIUM, [installed(MEDIUM), installed(SMALL)], { task: 'code', taskEvidence: [evidence(MEDIUM, 'unsuitable')] }))
    assert.equal(r.target!.taskFit, 'unsuitable')
    assert.equal(r.decision, 'use-alternative')
    assert.equal(r.installedAlternatives[0]!.evaluation.model.modelId, 'pequeno-2b')
  })

  it('adequado com evidência vem antes de desconhecido', () => {
    const a = model('a-modelo', { sizeBytes: 1 * GiB })
    const z = model('z-modelo', { sizeBytes: 1 * GiB })
    const r = recommendModels(
      request(LARGE, [installed(LARGE), installed(a), installed(z)], { hardware: completed(SYNTHETIC.ram8), task: 'code', taskEvidence: [evidence(z, 'suitable')] })
    )
    assert.deepEqual(r.installedAlternatives.map((x) => x.evaluation.model.modelId), ['z-modelo', 'a-modelo'])
  })
})

describe('compatibilidade: ordenação e reprodutibilidade', () => {
  const twins = [
    model('gemeo', { ref: { providerId: 'local-b', modelId: 'gemeo' }, sizeBytes: 1 * GiB }),
    model('gemeo', { ref: { providerId: 'local-a', modelId: 'gemeo' }, sizeBytes: 1 * GiB }),
    model('beta', { sizeBytes: 1 * GiB }),
    model('alfa', { sizeBytes: 1 * GiB })
  ]

  it('empates resolvidos por provedor e id, independentemente da ordem do inventário', () => {
    const order = (inv: ProviderModelEntry[]) =>
      recommendModels(request(LARGE, [installed(LARGE), ...inv], { hardware: completed(SYNTHETIC.ram8) })).installedAlternatives.map(
        (a) => `${a.evaluation.model.providerId}/${a.evaluation.model.modelId}`
      )
    const expected = ['local-a/alfa', 'local-a/beta', 'local-a/gemeo', 'local-b/gemeo']
    assert.deepEqual(order(twins.map(installed)), expected)
    assert.deepEqual(order([...twins].reverse().map(installed)), expected)
  })

  it('testado vem antes de estimado', () => {
    const r = recommendModels(
      request(LARGE, [installed(LARGE), ...twins.map(installed)], { hardware: completed(SYNTHETIC.ram8), priorAssessments: [tested(twins[0]!, {})] })
    )
    assert.equal(`${r.installedAlternatives[0]!.evaluation.model.providerId}/${r.installedAlternatives[0]!.evaluation.model.modelId}`, 'local-b/gemeo')
  })

  it('entradas idênticas produzem resultados idênticos', () => {
    const make = () => request(LARGE, [installed(LARGE), installed(MEDIUM), installed(SMALL), notInstalled(model('extra', { sizeBytes: GiB }))], { hardware: completed(SYNTHETIC.ram16vram4) })
    assert.deepEqual(recommendModels(make()), recommendModels(make()))
  })
})

describe('compatibilidade: ajuste de perfil antes de trocar de modelo', () => {
  it('reduz o contexto quando isso basta, mesmo havendo modelo menor instalado', () => {
    // 4,5 GB de pesos + 4 GB de contexto (32768 tokens) não cabem em 8 GB; com 8192 tokens, cabem.
    // O compacto (1,5 GB + 4 GB) caberia sem ajuste, mas o modelo pedido tem preferência.
    const compact = model('compacto-3b', { sizeBytes: 1.5 * GiB })
    const r = recommendModels(request(MEDIUM, [installed(MEDIUM), installed(compact)], { hardware: completed(SYNTHETIC.ram8), profile: profile({ contextLength: 32768 }) }))
    assert.equal(r.target!.state, 'not-recommended')
    assert.equal(r.decision, 'adjust-profile')
    assert.deepEqual(r.profileAdjustment!.override, { contextLength: 8192 })
    assert.equal(r.profileAdjustment!.evaluation.estimate!.requiredGb, 5.5)
    assert.deepEqual(r.installedAlternatives.map((a) => a.evaluation.model.modelId), ['compacto-3b'])
  })

  it('não propõe redução abaixo do que a tarefa exige', () => {
    const r = recommendModels(
      request(MEDIUM, [installed(MEDIUM)], { hardware: completed(SYNTHETIC.ram8), profile: profile({ contextLength: 32768 }), minContextTokens: 16384 })
    )
    assert.equal(r.profileAdjustment, null)
    assert.equal(r.decision, 'no-suitable-option')
  })

  it('quando nenhum ajuste basta, sugere outro modelo instalado', () => {
    const r = recommendModels(request(LARGE, [installed(LARGE), installed(SMALL)], { hardware: completed(SYNTHETIC.ram8) }))
    assert.equal(r.profileAdjustment, null)
    assert.equal(r.decision, 'use-alternative')
  })
})

describe('compatibilidade: memória de contexto desconhecida', () => {
  const noKv = model('medio-sem-kv', { sizeBytes: 4.5 * GiB, contextBytesPerToken: null })
  const largeNoKv = model('grande-sem-kv', { sizeBytes: 8 * GiB, contextBytesPerToken: null })
  const at8 = (m: ProviderModel, o: Partial<EvaluationContext> = {}) => evaluateCompatibility(installed(m), ctx({ hardware: completed(SYNTHETIC.ram8), ...o }))

  it('pesos conhecidos e contexto desconhecido: estimativa incompleta, componente registrado', () => {
    const e = at8(noKv)
    assert.deepEqual(e.estimate!.unknownComponents, ['context'])
    assert.equal(e.estimate!.requiredGb, 4.5)
    assert.equal(step(e, 'resources.ram-fit')!.kind, 'unknown')
    // Perfil no contexto padrão do provedor: a mesma incerteza.
    const providerDefault = at8(MEDIUM, { profile: profile({ contextLength: null }) })
    assert.deepEqual(providerDefault.estimate!.unknownComponents, ['context'])
    assert.equal(providerDefault.state, 'not-verified')
  })

  it('cabe considerando só os pesos: não verificado, nunca estimado como compatível', () => {
    const e = at8(noKv)
    assert.equal(e.estimateState, 'not-verified')
    assert.equal(e.state, 'not-verified')
    assert.equal(e.memoryNow, 'unknown')
    assert.match(step(e, 'resources.ram-fit')!.message, /não é possível dizer se o total cabe/)
    const r = recommendModels(request(noKv, [installed(noKv)], { hardware: completed(SYNTHETIC.ram8) }))
    assert.equal(r.decision, 'insufficient-data')
    assert.equal(r.profileAdjustment, null)
  })

  it('não cabe nem considerando só os pesos: não recomendado (piso já excede), sem confirmar', () => {
    const e = at8(largeNoKv)
    assert.equal(e.state, 'not-recommended')
    assert.match(step(e, 'resources.ram-fit')!.message, /mesmo sem contar o contexto/)
    // VRAM desconhecida continua não verificada.
    assert.equal(evaluateCompatibility(installed(largeNoKv), ctx({ hardware: completed(hw(8, 6, [dedicated(null)])) })).state, 'not-verified')
  })

  it('teste real válido prevalece sobre a estimativa incompleta, que continua marcada como tal', () => {
    const e = at8(noKv, { priorAssessments: [tested(noKv, {})] })
    assert.equal(e.estimateState, 'not-verified')
    assert.equal(e.state, 'tested-compatible')
    assert.deepEqual(e.estimate!.unknownComponents, ['context'])
    assert.equal(e.estimate!.source, 'estimate')
    const r = recommendModels(request(noKv, [installed(noKv)], { hardware: completed(SYNTHETIC.ram8), priorAssessments: [tested(noKv, {})] }))
    assert.equal(r.decision, 'use-target')
    assert.ok(r.rationale.some((t) => /memória livre atual não é conhecida/.test(t)))
  })
})

describe('compatibilidade: capacidade × memória livre agora', () => {
  it('capacidade suficiente e memória livre insuficiente: liberar memória, sem incompatibilidade', () => {
    // 5,5 GB cabem nos 6 utilizáveis de 8 GB, mas só 5 GB estavam livres.
    const r = recommendModels(request(MEDIUM, [installed(MEDIUM), installed(SMALL)], { hardware: completed(SYNTHETIC.ram8) }))
    assert.equal(r.target!.state, 'estimated-compatible')
    assert.equal(r.target!.memoryNow, 'insufficient')
    assert.equal(r.decision, 'free-memory')
    assert.match(r.rationale[0]!, /libere memória antes de usar/)
    // Opção secundária: contexto reduzido que caberia na memória livre agora.
    assert.deepEqual(r.profileAdjustment!.override, { contextLength: 4096 })
    assert.equal(r.profileAdjustment!.evaluation.memoryNow, 'sufficient')
    assert.ok(r.target!.assessment.alternatives.some((a) => a.kind === 'free-memory'))
  })

  it('capacidade suficiente e memória livre suficiente: usar o modelo pedido', () => {
    const r = recommendModels(request(MEDIUM, [installed(MEDIUM)], { hardware: completed(hw(8, 6, [])) }))
    assert.equal(r.target!.memoryNow, 'sufficient')
    assert.equal(r.decision, 'use-target')
    assert.ok(!r.target!.assessment.alternatives.some((a) => a.kind === 'free-memory'))
  })

  it('memória livre desconhecida (análise desatualizada): usa a capacidade e avisa', () => {
    const stale = { ...completed(SYNTHETIC.ram8), status: 'stale' } as const
    const r = recommendModels(request(MEDIUM, [installed(MEDIUM)], { hardware: stale }))
    assert.equal(r.target!.estimate!.availableRamGb, null)
    assert.equal(r.target!.memoryNow, 'unknown')
    assert.equal(r.target!.state, 'estimated-compatible')
    assert.equal(r.decision, 'use-target')
    assert.ok(r.rationale.some((t) => /memória livre atual não é conhecida/.test(t)))
  })

  it('GPU integrada compartilhando RAM: o modelo inteiro conta na memória livre', () => {
    // 10 GB na RAM: cabem nos 12 utilizáveis de 16 GB, mas só 9 GB estavam livres.
    const r = recommendModels(request(LARGE, [installed(LARGE)], { hardware: completed(SYNTHETIC.ram16integrated) }))
    assert.equal(r.target!.estimate!.placement, 'shared-memory')
    assert.equal(r.target!.memoryNow, 'insufficient')
    assert.equal(r.decision, 'free-memory')
    assert.deepEqual(r.profileAdjustment!.override, { contextLength: 4096 })
    const roomy = recommendModels(request(LARGE, [installed(LARGE)], { hardware: completed(hw(16, 11, [integrated])) }))
    assert.equal(roomy.decision, 'use-target')
  })

  it('não cabe na capacidade: a falta de memória livre não vira sugestão de liberar memória', () => {
    const e = evaluateCompatibility(installed(LARGE), ctx({ hardware: completed(SYNTHETIC.ram8) }))
    assert.equal(e.state, 'not-recommended')
    assert.ok(!e.assessment.alternatives.some((a) => a.kind === 'free-memory'))
  })

  it('ajuste pela memória livre também respeita o contexto mínimo da tarefa', () => {
    const r = recommendModels(request(MEDIUM, [installed(MEDIUM)], { hardware: completed(SYNTHETIC.ram8), minContextTokens: 8192 }))
    assert.equal(r.decision, 'free-memory')
    assert.equal(r.profileAdjustment, null)
  })

  it('alternativas com memória livre suficiente vêm antes', () => {
    const tight = model('a-justo', { sizeBytes: 4.5 * GiB })
    const r = recommendModels(request(LARGE, [installed(LARGE), installed(tight), installed(SMALL)], { hardware: completed(SYNTHETIC.ram8) }))
    assert.deepEqual(r.installedAlternatives.map((a) => a.evaluation.model.modelId), ['pequeno-2b', 'a-justo'])
    assert.match(r.installedAlternatives[1]!.reason, /Memória livre insuficiente/)
  })
})

describe('compatibilidade: recursos não são qualidade', () => {
  it('toda recomendação de uso declara que recursos não garantem qualidade', () => {
    const anyTask = recommendModels(request(MEDIUM, [installed(MEDIUM)], { hardware: completed(SYNTHETIC.ram32vram12) }))
    assert.equal(anyTask.decision, 'use-target')
    assert.ok(anyTask.rationale.some((t) => /não diz nada sobre a qualidade/.test(t)))
    const code = recommendModels(request(MEDIUM, [installed(MEDIUM)], { hardware: completed(SYNTHETIC.ram32vram12), task: 'code' }))
    assert.equal(code.target!.taskFit, 'unknown')
    assert.ok(code.rationale.some((t) => /Qualidade para a tarefa não avaliada/.test(t)))
    assert.ok(!JSON.stringify(code).includes('adequado para'))
  })
})

describe('compatibilidade: nada é apresentado como medição', () => {
  it('estimativas são marcadas e não trazem métricas de desempenho', () => {
    const r = recommendModels(request(LARGE, [installed(LARGE), installed(MEDIUM), installed(SMALL)], { hardware: completed(SYNTHETIC.ram16vram4) }))
    const json = JSON.stringify(r)
    assert.doesNotMatch(json, /"measured"|tokensPerSecond|timeToFirstToken|loadMs/)
    assert.equal(r.target!.estimate!.source, 'estimate')
    assert.doesNotMatch(json, /\bmedid[oa]s?\b/i)
  })
})

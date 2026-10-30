import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { RunService } from '../../src/main/runs/run-service'
import { demoRunRequest, SimulatedInferenceProvider } from '../../src/main/runs/simulated-provider'
import { validateAgentDraft } from '../../src/shared/agents'
import {
  COMPATIBILITY_RULES_VERSION,
  COMPATIBILITY_STATES,
  compatibilityBasis,
  effectiveState,
  isConfirmedState,
  stateAfterTest,
  stateFromEstimate,
  type CompatibilityAssessment,
  type CompatibilityState
} from '../../src/shared/compatibility'
import { DEFAULT_EXECUTION_PROFILE, resolveExecution, validateExecutionProfile, type ExecutionProfile } from '../../src/shared/execution'
import {
  INFERENCE_ERROR_CODES,
  INFERENCE_ERROR_NATURE,
  inferenceError,
  isRealProvider,
  sameModel,
  toStructuredError,
  validateInferenceEvent,
  validateModelRef,
  validateProviderModel,
  type ModelCapability,
  type ModelRef,
  type ProviderModelEntry
} from '../../src/shared/inference'
import { validateRunRequest } from '../../src/shared/runs'
import { draftFromForm, formFromDefinition } from '../../src/renderer/src/lib/agent-form'
import { agentDraft, VirtualScheduler } from '../support/fixtures'

const SRC = join(import.meta.dirname, '../../src')
const paths = (r: { ok: boolean; issues?: Array<{ path: string }> }) => (r.ok ? [] : r.issues!.map((i) => i.path))

const entry = (providerId: string, modelId: string, availability: ProviderModelEntry['availability'] = 'installed'): ProviderModelEntry => ({
  model: {
    ref: { providerId, modelId },
    digest: null,
    location: 'local',
    displayName: modelId,
    family: null,
    parameterSize: null,
    quantization: null,
    format: null,
    sizeBytes: null,
    contextLength: null,
    contextBytesPerToken: null,
    capabilities: ['chat']
  },
  availability
})

describe('identidade de modelos', () => {
  it('provedor + identificador; aceita ids reais de provedores e recusa controle e espaços nas pontas', () => {
    for (const modelId of ['llama3.2:3b', 'org/modelo-x:q4_k_m', 'qwen2.5-coder:7b-instruct']) {
      assert.ok(validateModelRef({ providerId: 'provedor-local', modelId }).ok, modelId)
    }
    assert.ok(validateModelRef({ providerId: null, modelId: 'aurora-8b-instruct' }).ok)
    for (const modelId of ['', ' x', 'x ', 'a\nb', 'x'.repeat(201)]) assert.equal(validateModelRef({ providerId: null, modelId }).ok, false, JSON.stringify(modelId))
    assert.deepEqual(paths(validateModelRef({ providerId: 'Provedor X', modelId: 'm', extra: 1 })).sort(), ['$.extra', '$.providerId'])
    assert.ok(sameModel({ providerId: 'p', modelId: 'm' }, { providerId: 'p', modelId: 'm' }))
    assert.ok(!sameModel({ providerId: null, modelId: 'm' }, { providerId: 'p', modelId: 'm' }))
  })

  it('modelo informado pelo provedor: identidade separada da disponibilidade, campos desconhecidos recusados', () => {
    assert.ok(validateProviderModel(entry('provedor-local', 'llama3.2:3b')).ok)
    const withDigest = entry('provedor-local', 'llama3.2:3b')
    assert.ok(validateProviderModel({ ...withDigest, model: { ...withDigest.model, digest: 'sha256:a80c4f17acd5' } }).ok)
    assert.equal(validateProviderModel({ ...withDigest, model: { ...withDigest.model, digest: 'sha256 x' } }).ok, false)
    const bad = entry('provedor-local', 'm')
    const broken = { ...bad, model: { ...bad.model, ref: { providerId: null, modelId: 'm' }, sizeBytes: -1, capabilities: ['chat', 'telepatia'], extra: true } }
    assert.deepEqual(paths(validateProviderModel(broken)).sort(), ['$.model.capabilities[1]', '$.model.extra', '$.model.ref.providerId', '$.model.sizeBytes'])
    assert.equal(validateProviderModel({ ...entry('p', 'm'), availability: 'ready' }).ok, false)
  })
})

describe('perfil de execução', () => {
  it('padrão válido; limites numéricos e campos desconhecidos recusados', () => {
    assert.ok(validateExecutionProfile(DEFAULT_EXECUTION_PROFILE).ok)
    const bad = { ...DEFAULT_EXECUTION_PROFILE, contextLength: 100, seed: -1, cpuThreads: 0, gpuMode: 'max', timeoutSeconds: 5, maxOutputTokens: 1.5, extra: 1 }
    assert.deepEqual(paths(validateExecutionProfile(bad)).sort(), [
      '$.contextLength',
      '$.cpuThreads',
      '$.extra',
      '$.gpuMode',
      '$.maxOutputTokens',
      '$.seed',
      '$.timeoutSeconds'
    ])
    const { timeoutSeconds: _t, ...incomplete } = DEFAULT_EXECUTION_PROFILE
    assert.deepEqual(paths(validateExecutionProfile(incomplete)), ['$.timeoutSeconds'])
  })

  it('agente: finalidade validada e perfil completo obrigatório', () => {
    assert.deepEqual(paths(validateAgentDraft(agentDraft({ taskTypes: ['code', 'code'] }))), ['$.taskTypes'])
    assert.deepEqual(paths(validateAgentDraft(agentDraft({ taskTypes: ['culinaria' as never] }))), ['$.taskTypes[0]'])
    const { gpuMode: _g, ...profile } = DEFAULT_EXECUTION_PROFILE
    assert.deepEqual(paths(validateAgentDraft({ ...agentDraft(), defaultProfile: profile })), ['$.defaultProfile.gpuMode'])
  })
})

describe('resolução de modelo e perfil por execução', () => {
  const profile: ExecutionProfile = { ...DEFAULT_EXECUTION_PROFILE, temperature: 0.3 }
  const inventory = [entry('provedor-a', 'llama3.2:3b'), entry('provedor-a', 'qwen:7b'), entry('provedor-b', 'qwen:7b'), entry('provedor-a', 'baixando:1b', 'downloading')]

  it('usa o padrão do agente e vincula o provedor quando é único', () => {
    const r = resolveExecution({ model: { providerId: null, modelId: 'llama3.2:3b' }, profile }, null, inventory)
    assert.deepEqual(r, { ok: true, value: { model: { providerId: 'provedor-a', modelId: 'llama3.2:3b' }, profile, overridden: { model: false, profile: false } } })
  })

  it('a execução substitui o modelo e parte do perfil, sem alterar o agente', () => {
    const r = resolveExecution(
      { model: { providerId: null, modelId: 'llama3.2:3b' }, profile },
      { model: { providerId: 'provedor-b', modelId: 'qwen:7b' }, profile: { temperature: 1.2, seed: 42 } },
      inventory
    )
    assert.ok(r.ok)
    assert.deepEqual(r.value.model, { providerId: 'provedor-b', modelId: 'qwen:7b' })
    assert.deepEqual(r.value.profile, { ...profile, temperature: 1.2, seed: 42 })
    assert.deepEqual(r.value.overridden, { model: true, profile: true })
    assert.equal(profile.temperature, 0.3)
  })

  it('sem modelo, não instalado (inclusive baixando) ou ambíguo: erro explicado', () => {
    const code = (r: ReturnType<typeof resolveExecution>) => (r.ok ? 'ok' : r.error.code)
    assert.equal(code(resolveExecution({ model: null, profile }, null, inventory)), 'no-model')
    assert.equal(code(resolveExecution({ model: { providerId: null, modelId: 'baixando:1b' }, profile }, null, inventory)), 'model-not-installed')
    assert.equal(code(resolveExecution({ model: { providerId: 'provedor-b', modelId: 'llama3.2:3b' }, profile }, null, inventory)), 'model-not-installed')
    assert.equal(code(resolveExecution({ model: { providerId: null, modelId: 'qwen:7b' }, profile }, null, inventory)), 'ambiguous-provider')
  })

  describe('capacidade de conversa', () => {
    const capable = (providerId: string, modelId: string, capabilities: ModelCapability[]): ProviderModelEntry => {
      const base = entry(providerId, modelId)
      return { ...base, model: { ...base.model, capabilities } }
    }
    const code = (model: ModelRef | null, list: ProviderModelEntry[], overrides: ModelRef | null = null) => {
      const r = resolveExecution({ model, profile }, overrides ? { model: overrides, profile: null } : null, list)
      return r.ok ? 'ok' : r.error.code
    }
    const named = (modelId: string, providerId: string | null = null): ModelRef => ({ providerId, modelId })

    it('aceita chat, sozinho ou com outras capacidades', () => {
      assert.equal(code(named('m'), [capable('a', 'm', ['chat'])]), 'ok')
      assert.equal(code(named('m'), [capable('a', 'm', ['chat', 'vision', 'tools', 'embedding'])]), 'ok')
    })

    it('recusa quem declara capacidades sem chat, com mensagem para o usuário', () => {
      assert.equal(code(named('m'), [capable('a', 'm', ['embedding'])]), 'model-unsupported')
      assert.equal(code(named('m'), [capable('a', 'm', ['vision', 'tools'])]), 'model-unsupported')
      const r = resolveExecution({ model: named('m'), profile }, null, [capable('a', 'm', ['embedding'])])
      assert.ok(!r.ok)
      assert.equal(r.error.message, 'Este modelo não oferece suporte a conversas. Escolha um modelo compatível.')
    })

    it('lista vazia é capacidade desconhecida: não impede', () => {
      assert.equal(code(named('m'), [capable('a', 'm', [])]), 'ok')
    })

    it('modelo inexistente continua sendo "não instalado"', () => {
      assert.equal(code(named('outro'), [capable('a', 'm', ['embedding'])]), 'model-not-installed')
    })

    it('vale para o modelo da execução, não para o padrão do agente', () => {
      const list = [capable('a', 'embed', ['embedding']), capable('a', 'chat', ['chat'])]
      assert.equal(code(named('embed'), list, named('chat', 'a')), 'ok')
      assert.equal(code(named('chat'), list, named('embed', 'a')), 'model-unsupported')
    })

    it('em mais de um provedor: decide o escolhido; sem provedor segue ambíguo', () => {
      const list = [capable('a', 'm', ['embedding']), capable('b', 'm', ['chat'])]
      assert.equal(code(named('m', 'a'), list), 'model-unsupported')
      assert.equal(code(named('m', 'b'), list), 'ok')
      assert.equal(code(named('m'), list), 'ambiguous-provider')
    })

    it('providerId null vincula ao único provedor antes de avaliar', () => {
      const r = resolveExecution({ model: named('m'), profile }, null, [capable('a', 'm', ['chat'])])
      assert.ok(r.ok)
      assert.deepEqual(r.value.model, { providerId: 'a', modelId: 'm' })
    })
  })
})

describe('pedido de execução real (fronteira IPC)', () => {
  const ok = { agentId: 'revisor', input: 'Revise este trecho.', overrides: null }

  it('aceita pedido simples e com substituições', () => {
    assert.ok(validateRunRequest(ok).ok)
    assert.ok(validateRunRequest({ ...ok, overrides: { model: { providerId: 'p', modelId: 'm:1b' }, profile: { temperature: 0 } } }).ok)
    assert.ok(validateRunRequest({ ...ok, overrides: { model: null, profile: { gpuMode: 'cpu-only' } } }).ok)
  })

  it('recusa entrada vazia ou grande demais, substituições inválidas e campos extras', () => {
    const bad = (o: object) => paths(validateRunRequest({ ...ok, ...o }))
    assert.deepEqual(bad({ input: '   ' }), ['$.input'])
    assert.deepEqual(bad({ input: 'x'.repeat(32_001) }), ['$.input'])
    assert.deepEqual(bad({ agentId: '../x' }), ['$.agentId'])
    assert.deepEqual(bad({ overrides: { model: null, profile: {} } }), ['$.overrides.profile'])
    assert.deepEqual(bad({ overrides: { model: null, profile: { temperature: 3, apiKey: 'x' } } }).sort(), ['$.overrides.profile.apiKey', '$.overrides.profile.temperature'])
    assert.deepEqual(bad({ overrides: { model: null } }), ['$.overrides.profile'])
    assert.deepEqual(bad({ stream: true }), ['$.stream'])
    assert.equal(validateRunRequest('rodar').ok, false)
  })
})

describe('eventos de streaming, métricas e erros', () => {
  it('eventos válidos passam; tamanho, tipo e campos desconhecidos são recusados', () => {
    assert.ok(validateInferenceEvent({ type: 'loading' }).ok)
    assert.ok(validateInferenceEvent({ type: 'delta', text: 'Olá' }).ok)
    assert.equal(validateInferenceEvent({ type: 'delta', text: 'x'.repeat(65_537) }).ok, false)
    assert.equal(validateInferenceEvent({ type: 'delta', text: 'x', extra: 1 }).ok, false)
    assert.equal(validateInferenceEvent({ type: 'tool-call' }).ok, false)
    assert.ok(validateInferenceEvent({ type: 'done', finishReason: 'stop', metrics: null }).ok)
  })

  it('métricas só como medição real, com limites', () => {
    const metrics = {
      source: 'measured',
      measuredAt: '2026-10-23T12:00:00.000Z',
      loadMs: 1200,
      timeToFirstTokenMs: 350.5,
      totalMs: 4000,
      promptTokens: 42,
      outputTokens: 128,
      outputTokensPerSecond: 31.6,
      peakMemoryBytes: null
    }
    assert.ok(validateInferenceEvent({ type: 'done', finishReason: 'length', metrics }).ok)
    assert.equal(validateInferenceEvent({ type: 'done', finishReason: 'stop', metrics: { ...metrics, source: 'estimated' } }).ok, false)
    assert.equal(validateInferenceEvent({ type: 'done', finishReason: 'stop', metrics: { ...metrics, outputTokens: -1 } }).ok, false)
    assert.equal(validateInferenceEvent({ type: 'done', finishReason: 'stop', metrics: { ...metrics, outputTokens: 1.5 } }).ok, false)
  })

  it('erro tipado: "tentar de novo" vem da natureza do código, não do provedor', () => {
    const event = validateInferenceEvent({ type: 'error', error: { code: 'insufficient-memory', message: 'sem memória' } })
    assert.deepEqual(event, { ok: true, value: { type: 'error', error: { code: 'insufficient-memory', message: 'sem memória', retryable: true } } })
    assert.equal(inferenceError('model-unsupported', 'x').retryable, false)
    assert.equal(validateInferenceEvent({ type: 'error', error: { code: 'insufficient-memory', message: 'x', retryable: false } }).ok, false)
    // Evento montado com `inferenceError` (retryable coerente) é aceito.
    assert.ok(validateInferenceEvent({ type: 'error', error: inferenceError('timeout', 'x') }).ok)
    assert.deepEqual(toStructuredError(inferenceError('timeout', 'Tempo esgotado.')), {
      code: 'inference',
      message: 'Tempo esgotado.',
      retryable: true,
      details: { inferenceCode: 'timeout' }
    })
  })
})

describe('compatibilidade: estimada, testada e confirmada', () => {
  it('recomendações do Hardware Advisor só produzem estados de estimativa', () => {
    assert.equal(stateFromEstimate('recommended-local'), 'estimated-compatible')
    assert.equal(stateFromEstimate('limited'), 'estimated-compatible')
    assert.equal(stateFromEstimate('needs-resources'), 'not-recommended')
    assert.equal(stateFromEstimate('unknown'), 'not-verified')
    for (const fit of ['recommended-local', 'limited', 'needs-resources', 'unknown'] as const) assert.ok(!isConfirmedState(stateFromEstimate(fit)))
  })

  it('só sucesso real ou recusa permanente do provedor confirmam algo', () => {
    assert.equal(stateAfterTest('not-recommended', { outcome: 'success', errorCode: null }), 'tested-compatible')
    assert.equal(stateAfterTest('estimated-compatible', { outcome: 'failure', errorCode: 'model-unsupported' }), 'confirmed-incompatible')
  })

  it('falha de memória nunca vira incompatibilidade confirmada, e não apaga um sucesso anterior', () => {
    assert.equal(stateAfterTest('estimated-compatible', { outcome: 'failure', errorCode: 'insufficient-memory' }), 'not-recommended')
    assert.equal(stateAfterTest('not-verified', { outcome: 'failure', errorCode: 'insufficient-memory' }), 'not-recommended')
    assert.equal(stateAfterTest('tested-compatible', { outcome: 'failure', errorCode: 'insufficient-memory' }), 'tested-compatible')
  })

  it('nenhuma falha transitória ou alheia ao modelo leva a "confirmed-incompatible"', () => {
    const nonPermanent = INFERENCE_ERROR_CODES.filter((c) => INFERENCE_ERROR_NATURE[c] !== 'permanent')
    for (const current of COMPATIBILITY_STATES.filter((s) => s !== 'confirmed-incompatible')) {
      for (const errorCode of nonPermanent) {
        assert.notEqual(stateAfterTest(current, { outcome: 'failure', errorCode }), 'confirmed-incompatible', `${current} + ${errorCode}`)
      }
    }
    assert.equal(stateAfterTest('estimated-compatible', { outcome: 'failure', errorCode: 'timeout' }), 'estimated-compatible')
    assert.equal(stateAfterTest('estimated-compatible', { outcome: 'failure', errorCode: 'provider-unavailable' }), 'estimated-compatible')
  })
})

describe('compatibilidade: validade da avaliação', () => {
  const model = { providerId: 'provedor-local', modelId: 'llama3.2:3b' }
  const basis = compatibilityBasis(model, 'sha256:aaa', DEFAULT_EXECUTION_PROFILE, 'dispositivo-1')
  const assessed = (state: CompatibilityState, b = basis): CompatibilityAssessment => ({
    basis: b,
    state,
    reasons: [],
    hardwareSource: 'local-detector',
    assessedAt: '2026-10-23T12:00:00.000Z',
    lastTest: null,
    alternatives: []
  })

  it('nas mesmas condições, o estado continua valendo', () => {
    for (const state of COMPATIBILITY_STATES) assert.equal(effectiveState(assessed(state), basis), state)
  })

  it('teste deixa de valer se mudar modelo, digest, perfil relevante ou dispositivo', () => {
    const changed = [
      compatibilityBasis({ ...model, modelId: 'llama3.2:1b' }, 'sha256:aaa', DEFAULT_EXECUTION_PROFILE, 'dispositivo-1'),
      compatibilityBasis({ ...model, providerId: 'outro' }, 'sha256:aaa', DEFAULT_EXECUTION_PROFILE, 'dispositivo-1'),
      compatibilityBasis(model, 'sha256:bbb', DEFAULT_EXECUTION_PROFILE, 'dispositivo-1'),
      compatibilityBasis(model, 'sha256:aaa', { ...DEFAULT_EXECUTION_PROFILE, contextLength: 32_768 }, 'dispositivo-1'),
      compatibilityBasis(model, 'sha256:aaa', { ...DEFAULT_EXECUTION_PROFILE, gpuMode: 'cpu-only' }, 'dispositivo-1'),
      compatibilityBasis(model, 'sha256:aaa', { ...DEFAULT_EXECUTION_PROFILE, cpuThreads: 4 }, 'dispositivo-1'),
      compatibilityBasis(model, 'sha256:aaa', DEFAULT_EXECUTION_PROFILE, 'dispositivo-2')
    ]
    for (const state of ['tested-compatible', 'confirmed-incompatible'] as const) {
      for (const current of changed) assert.equal(effectiveState(assessed(state), current), 'not-verified', JSON.stringify(current))
    }
  })

  it('parâmetros de amostragem não invalidam o teste', () => {
    const sampling = compatibilityBasis(model, 'sha256:aaa', { ...DEFAULT_EXECUTION_PROFILE, temperature: 1.5, seed: 3 }, 'dispositivo-1')
    assert.equal(effectiveState(assessed('tested-compatible'), sampling), 'tested-compatible')
  })

  it('teste sem digest ou sem dispositivo identificado não é confirmação', () => {
    const noDigest = compatibilityBasis(model, null, DEFAULT_EXECUTION_PROFILE, 'dispositivo-1')
    const noDevice = compatibilityBasis(model, 'sha256:aaa', DEFAULT_EXECUTION_PROFILE, null)
    assert.equal(effectiveState(assessed('tested-compatible', noDigest), noDigest), 'not-verified')
    assert.equal(effectiveState(assessed('confirmed-incompatible', noDevice), noDevice), 'not-verified')
  })

  it('nova versão das regras invalida estimativas, mas não resultados de teste', () => {
    const newRules = { ...basis, rulesVersion: COMPATIBILITY_RULES_VERSION + 1 }
    assert.equal(effectiveState(assessed('estimated-compatible'), newRules), 'not-verified')
    assert.equal(effectiveState(assessed('not-recommended'), newRules), 'not-verified')
    assert.equal(effectiveState(assessed('tested-compatible'), newRules), 'tested-compatible')
  })
})

describe('separação entre execuções simuladas e reais', () => {
  it('execução simulada registra o modelo simulado e o texto simulado, nunca métricas', async () => {
    const scheduler = new VirtualScheduler()
    const agent = { ...agentDraft(), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    const service = new RunService({
      providers: [new SimulatedInferenceProvider({ scheduler, stepDelayMs: 10 })],
      findAgent: (id) => (id === agent.id ? agent : undefined),
      scheduler,
      now: scheduler.now
    })
    const run = await service.start(demoRunRequest({ agentId: agent.id, scenario: 'success' }))
    await scheduler.advance(1_000)
    const done = service.get(run.id)!
    assert.equal(done.origin, 'simulated')
    assert.equal(done.execution?.model.providerId, 'simulado')
    assert.ok(done.output.startsWith('[Resposta simulada]'))
    assert.equal(done.metrics, null)
    service.dispose()
  })

  it('o provedor simulado não é motor real', () => {
    assert.equal(isRealProvider(new SimulatedInferenceProvider().info), false)
    assert.equal(isRealProvider({ id: 'x', displayName: 'X', kind: 'external' }), true)
  })
})

describe('formulário de agente preserva o que não edita', () => {
  const catalog: never[] = []

  it('trocar o modelo desfaz o vínculo com o provedor; manter, preserva', () => {
    const draft = agentDraft({ tools: [], defaultModel: { providerId: 'provedor-local', modelId: 'aurora-8b-instruct' } })
    const same = draftFromForm(formFromDefinition(draft), catalog)
    assert.ok(same.ok && same.draft.defaultModel?.providerId === 'provedor-local')
    const other = draftFromForm({ ...formFromDefinition(draft), modelId: 'koda-coder-6b' }, catalog)
    assert.deepEqual(other.ok && other.draft.defaultModel, { providerId: null, modelId: 'koda-coder-6b' })
  })
})

describe('contratos independentes de provedor', () => {
  it('agentes, execuções, perfis, compatibilidade e interface não citam provedor específico nem endpoints', () => {
    const files = [
      ...['agents.ts', 'runs.ts', 'execution.ts', 'compatibility.ts', 'inference.ts'].map((f) => join(SRC, 'shared', f)),
      ...readdirSync(join(SRC, 'renderer/src'), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && /\.(tsx?|css)$/.test(e.name))
        .map((e) => join(e.parentPath, e.name))
    ]
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
      // Comentários podem citar o Ollama como exemplo; código não.
      const withoutComments = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      assert.doesNotMatch(withoutComments, /ollama|https?:\/\/|localhost|11434|fetch\(/i, file)
    }
  })
})

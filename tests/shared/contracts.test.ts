import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateAgentAvailability, validateAgentDefinition, validateAgentDraft } from '../../src/shared/agents'
import {
  applyRunTransition,
  canTransitionRun,
  isTerminalRunState,
  RUN_TRANSITIONS,
  validateDemoRunRequest,
  validateRunId,
  type RunRecord,
  type RunState
} from '../../src/shared/runs'
import { applySettingsPatch, DEFAULT_SETTINGS, validateSettings, validateSettingsPatch } from '../../src/shared/settings'
import { validateAgainstSchema, type JsonSchema, type ToolCatalogEntry } from '../../src/shared/tools'
import { agentDraft } from '../support/fixtures'

const paths = (r: { ok: boolean; issues?: Array<{ path: string }> }) => (r.ok ? [] : r.issues!.map((i) => i.path))

describe('agentes: validação', () => {
  it('aceita um rascunho completo', () => {
    const result = validateAgentDraft(agentDraft())
    assert.equal(result.ok, true)
  })

  it('rejeita ID fora do padrão, versão inválida e campos extras', () => {
    const result = validateAgentDraft({ ...agentDraft({ id: 'Agente X', version: '1.0' }), apiKey: 'sk-123' })
    assert.equal(result.ok, false)
    assert.deepEqual(paths(result).sort(), ['$.apiKey', '$.id', '$.version'])
  })

  it('rejeita valores de tipo errado vindos de fora do TypeScript', () => {
    const result = validateAgentDraft({ ...agentDraft(), settings: { temperature: '0.7', topP: 3, maxOutputTokens: 1.5 } })
    assert.deepEqual(paths(result).sort(), ['$.settings.maxOutputTokens', '$.settings.temperature', '$.settings.topP'])
    assert.equal(validateAgentDraft(null).ok, false)
    assert.equal(validateAgentDraft([]).ok, false)
  })

  it('exige modelo e instruções quando o estado é "ready", mas não em rascunho', () => {
    const incomplete = { model: null, instructions: '  ' }
    assert.deepEqual(paths(validateAgentDraft(agentDraft({ ...incomplete, state: 'ready' }))).sort(), ['$.instructions', '$.model'])
    assert.equal(validateAgentDraft(agentDraft({ ...incomplete, state: 'draft' })).ok, true)
  })

  it('rejeita ferramentas e permissões repetidas ou desconhecidas', () => {
    assert.deepEqual(paths(validateAgentDraft(agentDraft({ tools: ['calculator', 'calculator'] }))), ['$.tools'])
    assert.deepEqual(paths(validateAgentDraft({ ...agentDraft(), requestedPermissions: ['root'] })), ['$.requestedPermissions[0]'])
  })

  it('definição completa exige datas ISO', () => {
    assert.equal(validateAgentDefinition({ ...agentDraft(), createdAt: '2026-10-23T00:00:00.000Z', updatedAt: 'ontem' }).ok, false)
    assert.equal(validateAgentDefinition({ ...agentDraft(), createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z' }).ok, true)
  })
})

describe('agentes: disponibilidade', () => {
  const entry = (id: string, availability: ToolCatalogEntry['availability'], permissions: ToolCatalogEntry['definition']['permissions'] = []) =>
    ({
      definition: { id, name: id, description: '', version: '0.1.0', source: 'builtin', permissions, inputSchema: { type: 'null' }, outputSchema: { type: 'null' } },
      enabled: availability !== 'disabled',
      availability
    }) satisfies ToolCatalogEntry
  const definition = (o = {}) => ({ ...agentDraft(o), createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' })

  it('fica disponível só quando tudo está presente', () => {
    const result = evaluateAgentAvailability(definition(), { tools: [entry('calculator', 'available')], engineAvailable: true })
    assert.deepEqual(result, { status: 'available', issues: [] })
  })

  it('aponta motor ausente, ferramenta sem implementação, desconhecida e permissão faltante', () => {
    const result = evaluateAgentAvailability(definition({ tools: ['calculator', 'web-search', 'ghost'] }), {
      tools: [entry('calculator', 'not-implemented'), entry('web-search', 'disabled', ['network'])],
      engineAvailable: false
    })
    assert.equal(result.status, 'unavailable')
    assert.deepEqual(
      result.issues.map((i) => i.code),
      ['tool-not-implemented', 'tool-disabled', 'missing-permission', 'unknown-tool', 'engine-unavailable']
    )
  })

  it('agente arquivado não é avaliado', () => {
    assert.equal(evaluateAgentAvailability(definition({ state: 'archived' }), { tools: [], engineAvailable: false }).status, 'archived')
  })
})

describe('ferramentas: esquema', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['query'],
    additionalProperties: false
  }

  it('aceita entrada válida', () => {
    assert.deepEqual(validateAgainstSchema(schema, { query: 'x', limit: 5, tags: ['a'] }), [])
  })

  it('aponta cada problema com caminho', () => {
    const issues = validateAgainstSchema(schema, { limit: 2.5, tags: ['a', 1], extra: true })
    assert.deepEqual(issues.map((i) => i.path).sort(), ['$.extra', '$.limit', '$.query', '$.tags[1]'])
  })
})

describe('execuções: transições de estado', () => {
  const base: RunRecord = {
    id: 'run-1',
    agentId: 'a',
    origin: 'simulated',
    state: 'pending',
    createdAt: '2026-10-23T12:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    progress: { percent: 0, step: null },
    messages: [],
    error: null,
    cancelRequested: false
  }
  const states = Object.keys(RUN_TRANSITIONS) as RunState[]

  it('só permite os caminhos previstos', () => {
    const allowed = states.flatMap((from) => states.filter((to) => canTransitionRun(from, to)).map((to) => `${from}→${to}`))
    assert.deepEqual(allowed, [
      'pending→running',
      'pending→failed',
      'pending→cancelled',
      'running→completed',
      'running→failed',
      'running→cancelled'
    ])
  })

  it('estados terminais são finais', () => {
    assert.deepEqual(states.filter(isTerminalRunState), ['completed', 'failed', 'cancelled'])
  })

  it('registra início e término e não altera o original', () => {
    const running = applyRunTransition(base, 'running', new Date('2026-10-23T12:00:01Z'))
    const done = applyRunTransition(running, 'completed', new Date('2026-10-23T12:00:05Z'))
    assert.equal(base.state, 'pending')
    assert.equal(done.startedAt, '2026-10-23T12:00:01.000Z')
    assert.equal(done.finishedAt, '2026-10-23T12:00:05.000Z')
    assert.equal(done.progress.percent, 100)
  })

  it('lança erro em transição inválida', () => {
    const done = applyRunTransition(applyRunTransition(base, 'running', new Date()), 'completed', new Date())
    assert.throws(() => applyRunTransition(done, 'running', new Date()), /inválida/)
    assert.throws(() => applyRunTransition(base, 'completed', new Date()), /inválida/)
  })

  it('valida pedidos e IDs vindos do IPC', () => {
    assert.equal(validateDemoRunRequest({ agentId: 'a', scenario: 'success' }).ok, true)
    assert.equal(validateDemoRunRequest({ agentId: 'a', scenario: 'real' }).ok, false)
    assert.equal(validateDemoRunRequest({ agentId: 'a', scenario: 'success', origin: 'real' }).ok, false)
    assert.equal(validateRunId('run-abc-123').ok, true)
    assert.equal(validateRunId('../../etc').ok, false)
  })
})

describe('configurações', () => {
  it('os padrões são válidos', () => {
    assert.equal(validateSettings(DEFAULT_SETTINGS).ok, true)
  })

  it('rejeita configuração incompleta ou com campos extras', () => {
    const { privacy: _privacy, ...missing } = DEFAULT_SETTINGS
    assert.deepEqual(paths(validateSettings(missing)), ['$.privacy'])
    assert.deepEqual(paths(validateSettings({ ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, token: 'x' } })), [
      '$.general.token'
    ])
  })

  it('aplica alteração parcial validada', () => {
    const patch = validateSettingsPatch({ general: { density: 'compact' }, tools: { enabled: { terminal: true } } })
    assert.equal(patch.ok, true)
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch.ok ? patch.value : {})
    assert.equal(next.general.density, 'compact')
    assert.equal(next.general.language, 'pt-BR')
    assert.deepEqual(next.tools.enabled, { terminal: true })
    assert.equal(DEFAULT_SETTINGS.general.density, 'comfortable')
  })

  it('rejeita alteração com valores inválidos', () => {
    assert.deepEqual(paths(validateSettingsPatch({ models: { maxRamGb: -1 } })), ['$.models.maxRamGb'])
    assert.deepEqual(paths(validateSettingsPatch({ tools: { enabled: { 'Bad Id': true } } })), ['$.tools.enabled.Bad Id'])
    assert.deepEqual(paths(validateSettingsPatch({ secrets: {} })), ['$.secrets'])
  })
})

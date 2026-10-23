import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AppError } from '../../src/main/errors'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { createServices } from '../../src/main/services'
import { AGENTS_FORMAT_VERSION, AgentService } from '../../src/main/services/agent-service'
import { SettingsService } from '../../src/main/services/settings-service'
import { BUILTIN_TOOLS } from '../../src/main/tools/catalog'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import type { AgentRecord } from '../../src/shared/agents'
import { IpcChannels } from '../../src/shared/ipc'
import type { RunRecord } from '../../src/shared/runs'
import { DEFAULT_SETTINGS, effectivePrivacy, INACTIVE_PRIVACY_SETTINGS } from '../../src/shared/settings'
import { agentDraft, fakeClock, tempDir } from '../support/fixtures'

async function setup() {
  const dir = await tempDir()
  const now = fakeClock()
  const settings = new SettingsService(join(dir, 'settings.json'), now)
  await settings.init()
  const tools = new ToolRegistry(BUILTIN_TOOLS)
  const agents = new AgentService({ filePath: join(dir, 'agents.json'), tools, settings, engineAvailable: () => false, now })
  await agents.init()
  return { dir, settings, tools, agents }
}

const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code

describe('catálogo de ferramentas', () => {
  it('nenhuma ferramenta tem executor nesta etapa', () => {
    const list = new ToolRegistry(BUILTIN_TOOLS).list({})
    assert.equal(list.length, 7)
    assert.ok(list.every((t) => t.availability === 'not-implemented'))
  })

  it('preferências do usuário prevalecem sobre o padrão', () => {
    const registry = new ToolRegistry(BUILTIN_TOOLS, new Set(['terminal', 'calculator']))
    const byId = Object.fromEntries(registry.list({ terminal: true, calculator: false }).map((t) => [t.definition.id, t]))
    assert.equal(byId['terminal']!.availability, 'available')
    assert.equal(byId['calculator']!.availability, 'disabled')
  })
})

describe('serviço de configurações', () => {
  it('persiste alterações parciais', async () => {
    const { dir, settings } = await setup()
    await settings.update({ models: { maxRamGb: 32 }, general: { density: 'compact' } })
    const reopened = new SettingsService(join(dir, 'settings.json'))
    await reopened.init()
    assert.equal(reopened.get().models.maxRamGb, 32)
    assert.equal(reopened.get().general.density, 'compact')
    assert.equal(reopened.get().general.language, 'pt-BR')
  })

  it('rejeita alteração inválida sem gravar', async () => {
    const { settings } = await setup()
    await assert.rejects(settings.update({ general: { language: 'klingon' } }), isCode('validation'))
    await assert.rejects(settings.update('x'), isCode('validation'))
    assert.equal(settings.get().general.language, 'pt-BR')
  })
})

describe('preferências de segurança e privacidade inativas', () => {
  /** settings.json gravado por uma versão anterior, com escolhas diferentes dos padrões seguros. */
  async function withStoredChoices() {
    const dir = await tempDir()
    const file = join(dir, 'settings.json')
    const data = { ...DEFAULT_SETTINGS, privacy: { confirmSensitiveTools: false, telemetry: true } }
    await writeFile(file, JSON.stringify({ format: 'gerpro.settings', formatVersion: 1, savedAt: '2026-10-20T10:00:00.000Z', data }))
    const settings = new SettingsService(file)
    await settings.init()
    return { file, settings }
  }

  it('são exatamente a confirmação de ferramentas sensíveis e a telemetria', () => {
    assert.deepEqual([...INACTIVE_PRIVACY_SETTINGS].sort(), ['confirmSensitiveTools', 'telemetry'])
  })

  it('o Main recusa alterá-las, inclusive junto com outros campos, sem gravar nada', async () => {
    const { dir, settings } = await setup()
    const file = join(dir, 'settings.json')
    await settings.update({ general: { density: 'compact' } })
    const before = await readFile(file, 'utf8')
    for (const privacy of [{ telemetry: true }, { confirmSensitiveTools: false }, { telemetry: false }]) {
      await assert.rejects(settings.update({ models: { maxRamGb: 64 }, privacy }), isCode('invalid-state'))
    }
    assert.equal(await readFile(file, 'utf8'), before, 'arquivo intacto')
    assert.equal(settings.get().models.maxRamGb, 16)
    assert.deepEqual(effectivePrivacy(settings.get()), { confirmSensitiveTools: true, telemetry: false })
  })

  it('escolhas gravadas antes são preservadas, mas não valem como decisão', async () => {
    const { file, settings } = await withStoredChoices()
    assert.deepEqual(settings.get().privacy, { confirmSensitiveTools: false, telemetry: true }, 'nada apagado ao carregar')
    assert.deepEqual(effectivePrivacy(settings.get()), { confirmSensitiveTools: true, telemetry: false }, 'valores seguros valem')

    // Alterar outra preferência não sobrescreve as escolhas anteriores.
    await settings.update({ general: { language: 'es' } })
    const reopened = new SettingsService(file)
    await reopened.init()
    assert.equal(reopened.get().general.language, 'es')
    assert.deepEqual(reopened.get().privacy, { confirmSensitiveTools: false, telemetry: true })
  })

  it('pelo IPC, a recusa chega como erro estruturado', async () => {
    const dir = await tempDir()
    const services = await createServices(dir, { stepDelayMs: 1 })
    const handlers = createDataHandlers(services)
    const result = await invokeHandler(IpcChannels.settingsUpdate, handlers[IpcChannels.settingsUpdate]!, [{ privacy: { telemetry: true } }])
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.error.code, 'invalid-state')
    assert.equal(!result.ok && result.error.details?.['fields'], 'telemetry')
    services.runs.dispose()
  })
})

describe('serviço de agentes', () => {
  it('cria com datas do Main, atualiza preservando a criação e persiste', async () => {
    const { dir, agents, settings, tools } = await setup()
    const created = await agents.create(agentDraft())
    assert.equal(created.definition.createdAt, created.definition.updatedAt)

    const updated = await agents.update(agentDraft({ name: 'Assistente 2', version: '1.1.0' }))
    assert.equal(updated.definition.createdAt, created.definition.createdAt)
    assert.notEqual(updated.definition.updatedAt, created.definition.updatedAt)

    const reopened = new AgentService({ filePath: join(dir, 'agents.json'), tools, settings, engineAvailable: () => false })
    await reopened.init()
    assert.deepEqual(reopened.list().map((a) => a.definition.name), ['Assistente 2'])
  })

  it('criar não sobrescreve um ID existente; atualizar exige que ele exista', async () => {
    const { agents } = await setup()
    await agents.create(agentDraft())
    await assert.rejects(agents.create(agentDraft({ name: 'Outro' })), isCode('conflict'))
    assert.equal(agents.list()[0]!.definition.name, 'Assistente Geral')
    await assert.rejects(agents.update(agentDraft({ id: 'nao-existe' })), isCode('not-found'))
    assert.equal(agents.list().length, 1)
  })

  it('rejeita datas enviadas pelo Renderer', async () => {
    const { agents } = await setup()
    await assert.rejects(agents.create({ ...agentDraft(), createdAt: '1999-01-01T00:00:00Z' }), isCode('validation'))
  })

  it('agente pronto continua indisponível: sem motor e sem ferramentas implementadas', async () => {
    const { agents } = await setup()
    const record = await agents.create(agentDraft({ tools: ['web-search'], requestedPermissions: ['network'] }))
    assert.equal(record.availability.status, 'unavailable')
    assert.deepEqual(record.availability.issues.map((i) => i.code).sort(), ['engine-unavailable', 'tool-not-implemented'])
  })

  it('rejeita ferramenta que não existe no catálogo', async () => {
    const { agents } = await setup()
    await assert.rejects(agents.create(agentDraft({ tools: ['ferramenta-fantasma'] })), isCode('validation'))
    assert.equal(agents.list().length, 0)
  })

  it('remove e informa quando não encontra', async () => {
    const { agents } = await setup()
    await agents.create(agentDraft())
    await agents.remove('assistente-geral')
    assert.equal(agents.list().length, 0)
    await assert.rejects(agents.remove('assistente-geral'), isCode('not-found'))
    await assert.rejects(agents.remove({ id: 'x' }), isCode('validation'))
  })

  it('arquivo com um agente inválido: mantém os válidos e guarda cópia do original', async () => {
    const { dir, settings, tools } = await setup()
    const file = join(dir, 'agents.json')
    const good = { ...agentDraft({ id: 'bom' }), createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
    const original = JSON.stringify({ format: 'gerpro.agents', formatVersion: AGENTS_FORMAT_VERSION, savedAt: 'x', data: { agents: [good, { id: 'ruim' }] } })
    await writeFile(file, original)
    const service = new AgentService({ filePath: file, tools, settings, engineAvailable: () => false })
    const status = await service.init()
    assert.equal(status.state, 'recovered')
    assert.deepEqual(service.list().map((a) => a.definition.id), ['bom'])
    assert.equal(await readFile(status.backupPath!, 'utf8'), original)
  })
})

describe('handlers IPC', () => {
  it('valida número de argumentos e devolve erros estruturados', async () => {
    const dir = await tempDir()
    const services = await createServices(dir)
    const handlers = createDataHandlers(services)
    try {
      const extra = await invokeHandler('x', handlers[IpcChannels.agentsList], [1])
      assert.equal(extra.ok, false)
      assert.equal(!extra.ok && extra.error.code, 'validation')

      const bad = await invokeHandler('x', handlers[IpcChannels.agentsCreate], [{ id: 'x' }])
      assert.equal(!bad.ok && bad.error.code, 'validation')
      assert.ok(!bad.ok && bad.error.issues!.length > 0)

      const saved = await invokeHandler('x', handlers[IpcChannels.agentsCreate], [agentDraft()])
      assert.equal(saved.ok, true)

      const run = await invokeHandler('x', handlers[IpcChannels.runsStartDemo], [{ agentId: 'assistente-geral', scenario: 'success' }])
      assert.equal(run.ok && (run.data as { origin: string }).origin, 'simulated')

      const unknownAgent = await invokeHandler('x', handlers[IpcChannels.runsStartDemo], [{ agentId: 'nao-existe', scenario: 'success' }])
      assert.equal(!unknownAgent.ok && unknownAgent.error.code, 'not-found')
      const badScenario = await invokeHandler('x', handlers[IpcChannels.runsStartDemo], [{ agentId: 'assistente-geral', scenario: 'erro' }])
      assert.equal(!badScenario.ok && badScenario.error.code, 'validation')

      // runs:start: argumentos validados no Main, erros estruturados.
      const start = handlers[IpcChannels.runsStart]
      const simulatedModel = { providerId: 'simulado', modelId: 'resposta-curta' }
      for (const args of [[], [null], [{ agentId: 'assistente-geral', input: 'Olá' }], [{ agentId: 'assistente-geral', input: 'Olá', overrides: null }, 1]]) {
        const refused = await invokeHandler('x', start, args)
        assert.equal(!refused.ok && refused.error.code, 'validation', JSON.stringify(args))
      }
      const notInstalled = await invokeHandler('x', start, [{ agentId: 'assistente-geral', input: 'Olá', overrides: null }])
      assert.ok(!notInstalled.ok && notInstalled.error.code === 'inference' && notInstalled.error.details?.['inferenceCode'] === 'model-not-found')
      const started = await invokeHandler('x', start, [{ agentId: 'assistente-geral', input: 'Olá', overrides: { model: simulatedModel, profile: null } }])
      assert.ok(started.ok)
      assert.deepEqual((started.data as RunRecord).execution?.model, simulatedModel)
      assert.equal((started.data as RunRecord).origin, 'simulated')

      // A simulação não torna o agente operacional: o motor real continua indisponível.
      assert.deepEqual(services.runs.capabilities(), { infrastructure: 'functional', simulation: 'available', realEngine: 'unavailable' })
      const listed = await invokeHandler('x', handlers[IpcChannels.agentsList], [])
      const agent = listed.ok && (listed.data as AgentRecord[])[0]
      assert.ok(agent && agent.availability.issues.some((i) => i.code === 'engine-unavailable'))
    } finally {
      services.runs.dispose()
    }
  })

  it('erros inesperados não vazam detalhes internos', async () => {
    const spec = { arity: 0, run: () => { throw new Error('C:\\Users\\segredo\\arquivo.json') } }
    const original = console.error
    console.error = () => undefined
    try {
      const result = await invokeHandler('x', spec, [])
      assert.deepEqual(result, { ok: false, error: { code: 'internal', message: 'Erro interno no processo principal.', retryable: false } })
    } finally {
      console.error = original
    }
  })
})

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AppError } from '../../src/main/errors'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { createServices } from '../../src/main/services'
import { AgentService } from '../../src/main/services/agent-service'
import { SettingsService } from '../../src/main/services/settings-service'
import { BUILTIN_TOOLS } from '../../src/main/tools/catalog'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import { IpcChannels } from '../../src/shared/ipc'
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
    await settings.update({ models: { maxRamGb: 32 }, privacy: { telemetry: true } })
    const reopened = new SettingsService(join(dir, 'settings.json'))
    await reopened.init()
    assert.equal(reopened.get().models.maxRamGb, 32)
    assert.equal(reopened.get().privacy.telemetry, true)
    assert.equal(reopened.get().general.language, 'pt-BR')
  })

  it('rejeita alteração inválida sem gravar', async () => {
    const { settings } = await setup()
    await assert.rejects(settings.update({ general: { language: 'klingon' } }), isCode('validation'))
    await assert.rejects(settings.update('x'), isCode('validation'))
    assert.equal(settings.get().general.language, 'pt-BR')
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
    const original = JSON.stringify({ format: 'gerpro.agents', formatVersion: 1, savedAt: 'x', data: { agents: [good, { id: 'ruim' }] } })
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
      assert.equal(!unknownAgent.ok && unknownAgent.error.code, 'invalid-state')
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

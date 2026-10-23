import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AGENTS_FORMAT_VERSION, AgentService } from '../../src/main/services/agent-service'
import { SettingsService } from '../../src/main/services/settings-service'
import { BUILTIN_TOOLS } from '../../src/main/tools/catalog'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import { LEGACY_ENGINE_PROVIDERS, migrateAgentsV1 } from '../../src/shared/agents'
import { DEFAULT_EXECUTION_PROFILE } from '../../src/shared/execution'
import { tempDir } from '../support/fixtures'

const dates = { createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z' }

/** Agente como gravado pelo formato 1. */
const v1Agent = (o: Record<string, unknown> = {}) => ({
  id: 'revisor',
  name: 'Revisor',
  description: 'Revisa código.',
  version: '1.2.0',
  instructions: 'Revise com cuidado.',
  model: { engineId: null, modelId: 'koda-coder-6b' },
  settings: { temperature: 0.2, topP: 0.8, maxOutputTokens: 1024 },
  tools: ['calculator'],
  requestedPermissions: [],
  state: 'ready',
  ...dates,
  ...o
})

async function open(agents: unknown[], formatVersion = 1) {
  const dir = await tempDir()
  const file = join(dir, 'agents.json')
  const original = JSON.stringify({ format: 'gerpro.agents', formatVersion, savedAt: '2026-09-02T10:00:00.000Z', data: { agents } })
  await writeFile(file, original)
  const settings = new SettingsService(join(dir, 'settings.json'))
  await settings.init()
  const tools = new ToolRegistry(BUILTIN_TOOLS)
  const make = () => new AgentService({ filePath: file, tools, settings, engineAvailable: () => false })
  const service = make()
  const status = await service.init()
  return { file, original, service, status, make }
}

describe('agents.json: migração do formato 1 para o 2', () => {
  it('converte modelo e parâmetros sem perder nada', async () => {
    const { service, status } = await open([
      v1Agent(),
      v1Agent({ id: 'vinculado', model: { engineId: 'provedor-local', modelId: 'aurora-8b-instruct' } }),
      v1Agent({ id: 'rascunho', state: 'draft', model: null, settings: { temperature: 1.1, topP: 1, maxOutputTokens: null } })
    ])
    assert.equal(status.state, 'migrated')
    const [revisor, vinculado, rascunho] = service.list().map((r) => r.definition)

    assert.deepEqual(revisor, {
      id: 'revisor',
      name: 'Revisor',
      description: 'Revisa código.',
      version: '1.2.0',
      instructions: 'Revise com cuidado.',
      taskTypes: [],
      defaultModel: { providerId: null, modelId: 'koda-coder-6b' },
      defaultProfile: { ...DEFAULT_EXECUTION_PROFILE, temperature: 0.2, topP: 0.8, maxOutputTokens: 1024 },
      tools: ['calculator'],
      requestedPermissions: [],
      state: 'ready',
      ...dates
    })
    // `engineId` antigo sem correspondência explícita não vira provedor real.
    assert.deepEqual(LEGACY_ENGINE_PROVIDERS, {})
    assert.deepEqual(vinculado!.defaultModel, { providerId: null, modelId: 'aurora-8b-instruct' })
    assert.equal(rascunho!.defaultModel, null)
    assert.equal(rascunho!.defaultProfile.temperature, 1.1)
  })

  it('copia o original v1 antes de migrar, inclusive o engineId descartado', async () => {
    const legacy = v1Agent({ model: { engineId: 'motor-antigo', modelId: 'aurora-8b-instruct' } })
    const { original, status } = await open([legacy])
    assert.equal(status.state, 'migrated')
    assert.match(status.backupPath!, /agents\.v1-.+\.json$/)
    const backup = await readFile(status.backupPath!, 'utf8')
    assert.equal(backup, original)
    assert.match(backup, /"engineId":"motor-antigo"/)
  })

  it('id de provedor só é atribuído pela tabela de correspondência', () => {
    const migrated = migrateAgentsV1({ agents: [v1Agent({ model: { engineId: 'constructor', modelId: 'm' } })] }) as {
      agents: Array<{ defaultModel: unknown }>
    }
    assert.deepEqual(migrated.agents[0]!.defaultModel, { providerId: null, modelId: 'm' })
  })

  it('só regrava no formato 2 quando há alteração; o original v1 fica intacto até lá', async () => {
    const { file, original, service, make } = await open([v1Agent()])
    assert.equal(await readFile(file, 'utf8'), original)

    const { createdAt: _c, updatedAt: _u, ...draft } = service.find('revisor')!
    await service.update({ ...draft, name: 'Revisor 2' })

    const disk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(disk.formatVersion, AGENTS_FORMAT_VERSION)
    assert.equal(disk.data.agents[0].defaultProfile.topP, 0.8)
    assert.ok(!('settings' in disk.data.agents[0]) && !('model' in disk.data.agents[0]))

    const reopened = make()
    assert.equal((await reopened.init()).state, 'loaded')
    assert.equal(reopened.find('revisor')!.createdAt, dates.createdAt)
  })

  it('agente v1 inválido: os válidos migram e o arquivo original é copiado', async () => {
    const { original, service, status } = await open([v1Agent(), v1Agent({ id: 'quebrado', settings: { temperature: 9, topP: 0.5, maxOutputTokens: null } })])
    assert.equal(status.state, 'recovered')
    assert.deepEqual(service.list().map((r) => r.definition.id), ['revisor'])
    assert.equal(await readFile(status.backupPath!, 'utf8'), original)
  })

  it('formas inesperadas não são "consertadas" pela migração', () => {
    assert.equal(migrateAgentsV1(null), null)
    assert.deepEqual(migrateAgentsV1({ agents: 'x' }), { agents: 'x' })
    assert.deepEqual(migrateAgentsV1({ agents: [1, { id: 'sem-modelo' }] }), { agents: [1, { id: 'sem-modelo' }] })
    // Campo extra em `settings` continua lá, para a validação recusar.
    const migrated = migrateAgentsV1({ agents: [v1Agent({ settings: { temperature: 1, topP: 1, maxOutputTokens: null, apiKey: 'x' } })] }) as {
      agents: Array<{ defaultProfile: Record<string, unknown> }>
    }
    assert.equal(migrated.agents[0]!.defaultProfile['apiKey'], 'x')
  })

  it('arquivo de versão futura continua protegido contra gravação', async () => {
    const { status } = await open([], AGENTS_FORMAT_VERSION + 1)
    assert.equal(status.state, 'read-only')
  })
})

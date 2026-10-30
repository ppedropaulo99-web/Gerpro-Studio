import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { createServices, type Services } from '../../src/main/services'
import { AGENTS_FORMAT_VERSION, AgentService, type AgentServiceDeps } from '../../src/main/services/agent-service'
import { SettingsService } from '../../src/main/services/settings-service'
import { BUILTIN_TOOLS } from '../../src/main/tools/catalog'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import type { AgentDefinition, AgentsStorageStatus } from '../../src/shared/agents'
import { DEFAULT_EXECUTION_PROFILE } from '../../src/shared/execution'
import { IpcChannels } from '../../src/shared/ipc'
import { agentDraft, tempDir } from '../support/fixtures'

const dates = { createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z' }
const stored = (o: Parameters<typeof agentDraft>[0] = {}) => ({ ...agentDraft({ tools: [], ...o }), ...dates })
const envelope = (agents: unknown[], formatVersion = AGENTS_FORMAT_VERSION) =>
  JSON.stringify({ format: 'gerpro.agents', formatVersion, savedAt: dates.updatedAt, data: { agents } })

type Overrides = Partial<Pick<AgentServiceDeps, 'now' | 'copier'>>

async function open(text: string, overrides: Overrides = {}) {
  const dir = await tempDir()
  const file = join(dir, 'agents.json')
  await writeFile(file, text)
  const settings = new SettingsService(join(dir, 'settings.json'))
  await settings.init()
  const tools = new ToolRegistry(BUILTIN_TOOLS)
  const make = (more: Overrides = overrides) => new AgentService({ filePath: file, tools, settings, engineAvailable: () => false, ...more })
  const service = make()
  const status = await service.init()
  return { dir, file, service, status, make }
}

const backups = async (dir: string) => (await readdir(dir)).filter((name) => name.startsWith('agents.invalid-')).sort()
const onDisk = async (file: string) => JSON.parse(await readFile(file, 'utf8')).data.agents as AgentDefinition[]
const blocked = { code: 'storage-read-only' }

const valid = stored({ id: 'valido' })
const incompatible = { ...stored({ id: 'incompativel' }), campoNovo: { guardado: true } }
const { createdAt: _createdAt, updatedAt: _updatedAt, ...validDraft } = valid

describe('agents.json: proteção do arquivo', () => {
  it('agente incompatível bloqueia criar, atualizar e excluir, e o arquivo não muda', async () => {
    const original = envelope([valid, incompatible])
    const { file, service } = await open(original)
    await assert.rejects(service.create(agentDraft({ id: 'novo', tools: [] })), blocked)
    await assert.rejects(service.update({ ...validDraft, name: 'Outro nome' }), blocked)
    await assert.rejects(service.remove('valido'), blocked)
    assert.equal(await readFile(file, 'utf8'), original)
    assert.deepEqual((await onDisk(file)).map((a) => a.id), ['valido', 'incompativel'], 'o recusado segue no arquivo principal')
  })

  it('agentes válidos seguem disponíveis para consulta e execução', async () => {
    const { service, status } = await open(envelope([valid, incompatible]))
    assert.equal(status.state, 'recovered')
    assert.equal(status.writeBlock, 'damaged')
    assert.deepEqual(service.list().map((a) => a.definition.id), ['valido'])
    assert.equal(service.find('valido')?.name, valid.name)
    assert.deepEqual(status.issues.map((i) => i.path), ['$.agents[1].campoNovo'])
  })

  it('JSON corrompido não é substituído nem por criação de agente', async () => {
    const { file, service, status } = await open('{ quebrado')
    assert.equal(status.writeBlock, 'damaged')
    assert.deepEqual(service.list(), [])
    await assert.rejects(service.create(agentDraft({ id: 'novo', tools: [] })), blocked)
    assert.equal(await readFile(file, 'utf8'), '{ quebrado')
    assert.equal(await readFile(status.backupPath!, 'utf8'), '{ quebrado')
  })

  it('formato v1 com agente inválido não é migrado para o disco', async () => {
    const original = envelope([{ id: 'quebrado' }], 1)
    const { file, service } = await open(original)
    await assert.rejects(service.create(agentDraft({ id: 'novo', tools: [] })), blocked)
    assert.equal(await readFile(file, 'utf8'), original)
  })

  it('sem cópia de segurança, as gravações continuam bloqueadas', async () => {
    const original = envelope([valid, incompatible])
    const { dir, file, service, status } = await open(original, { copier: () => Promise.reject(new Error('disco cheio')) })
    assert.equal(status.state, 'read-only')
    assert.equal(status.writeBlock, 'backup-failed')
    assert.equal(status.backupPath, null)
    assert.deepEqual(service.list().map((a) => a.definition.id), ['valido'])
    await assert.rejects(service.create(agentDraft({ id: 'novo', tools: [] })), /cópia/)
    assert.equal(await readFile(file, 'utf8'), original)
    assert.deepEqual(await backups(dir), [])
  })

  it('cópia incompleta não conta como cópia de segurança', async () => {
    const { status } = await open(envelope([valid, incompatible]), { copier: (_source, target) => writeFile(target, 'pedaço') })
    assert.equal(status.writeBlock, 'backup-failed')
  })

  it('formato mais novo continua protegido, sem nenhuma cópia', async () => {
    const original = envelope([valid], AGENTS_FORMAT_VERSION + 1)
    const { dir, file, service, status } = await open(original)
    assert.equal(status.state, 'read-only')
    assert.equal(status.writeBlock, 'newer-version')
    await assert.rejects(service.create(agentDraft({ id: 'novo', tools: [] })), /versão mais nova/)
    assert.equal(await readFile(file, 'utf8'), original)
    assert.deepEqual(await backups(dir), [])
  })

  it('arquivo ilegível: nada é gravado e não há cópia a afirmar', async () => {
    const dir = await tempDir()
    const file = join(dir, 'agents.json')
    // Uma pasta no lugar do arquivo: leitura falha de verdade, sem depender de permissões do sistema.
    await mkdir(file)
    const settings = new SettingsService(join(dir, 'settings.json'))
    await settings.init()
    const service = new AgentService({ filePath: file, tools: new ToolRegistry(BUILTIN_TOOLS), settings, engineAvailable: () => false })
    const status = await service.init()
    assert.equal(status.state, 'read-only')
    assert.equal(status.writeBlock, 'unreadable')
    assert.equal(status.backupPath, null)
    assert.deepEqual(service.storageStatus(), { block: 'unreadable' })
    assert.deepEqual(service.list(), [])
    await assert.rejects(service.create(agentDraft({ id: 'novo', tools: [] })), /não puderam ser lidos/)
  })

  it('reabrir mantém a proteção', async () => {
    const original = envelope([valid, incompatible])
    const { file, make } = await open(original)
    const reopened = make()
    assert.equal((await reopened.init()).writeBlock, 'damaged')
    await assert.rejects(reopened.remove('valido'), blocked)
    assert.equal(await readFile(file, 'utf8'), original)
  })

  it('corrigido o arquivo, a abertura seguinte volta ao normal', async () => {
    const { file, make } = await open(envelope([valid, incompatible]))
    await writeFile(file, envelope([valid]))
    const reopened = make()
    assert.equal((await reopened.init()).writeBlock, null)
    await reopened.create(agentDraft({ id: 'novo', tools: [] }))
    assert.deepEqual((await onDisk(file)).map((a) => a.id), ['valido', 'novo'])
  })

  it('arquivo válido e arquivo ausente continuam permitindo tudo', async () => {
    const { file, service, status } = await open(envelope([valid]))
    assert.equal(status.state, 'loaded')
    assert.equal(status.writeBlock, null)
    await service.create(agentDraft({ id: 'novo', tools: [] }))
    await service.update({ ...validDraft, name: 'Outro nome' })
    await service.remove('novo')
    assert.deepEqual((await onDisk(file)).map((a) => a.name), ['Outro nome'])

    const dir = await tempDir()
    const services = await createServices(dir, { stepDelayMs: 1 })
    assert.deepEqual(services.agents.storageStatus(), { block: null })
    await services.agents.create(agentDraft({ id: 'primeiro', tools: [] }))
    services.runs.dispose()
  })
})

describe('agents.json: cópias de segurança', () => {
  const now = (iso: string) => () => new Date(iso)

  it('conteúdo idêntico não gera outra cópia, ainda que o nome ou a data sejam outros', async () => {
    const original = envelope([valid, incompatible])
    const { dir, status, make } = await open(original, { now: now('2026-10-01T10:00:00Z') })
    const reopened = await make({ now: now('2026-10-02T10:00:00Z') }).init()
    assert.equal(reopened.backupPath, status.backupPath)
    assert.equal((await backups(dir)).length, 1)
  })

  it('conteúdo alterado recebe nova cópia, e a anterior fica como estava', async () => {
    const first = envelope([valid, incompatible])
    const { dir, file, status, make } = await open(first, { now: now('2026-10-01T10:00:00Z') })
    const second = envelope([{ ...incompatible, name: 'Mudou' }, valid])
    await writeFile(file, second)
    const reopened = await make({ now: now('2026-10-02T10:00:00Z') }).init()
    assert.notEqual(reopened.backupPath, status.backupPath)
    assert.equal((await backups(dir)).length, 2)
    assert.equal(await readFile(status.backupPath!, 'utf8'), first)
    assert.equal(await readFile(reopened.backupPath!, 'utf8'), second)
  })

  it('nome coincidente com outro conteúdo não sobrescreve a cópia existente', async () => {
    const fixed = now('2026-10-01T10:00:00Z')
    const first = envelope([valid, incompatible])
    const { dir, file, status, make } = await open(first, { now: fixed })
    const second = envelope([incompatible])
    await writeFile(file, second)
    const reopened = await make({ now: fixed }).init()
    assert.equal((await backups(dir)).length, 2)
    assert.equal(await readFile(status.backupPath!, 'utf8'), first)
    assert.equal(await readFile(reopened.backupPath!, 'utf8'), second)
  })

  it('cópias já existentes não são apagadas, e o original não muda para compará-las', async () => {
    const original = envelope([valid, incompatible])
    const { dir, file, make } = await open(original, { now: now('2026-10-01T10:00:00Z') })
    await writeFile(join(dir, 'agents.invalid-antiga.json'), 'de outra época')
    await make({ now: now('2026-10-02T10:00:00Z') }).init()
    assert.equal(await readFile(join(dir, 'agents.invalid-antiga.json'), 'utf8'), 'de outra época')
    assert.equal(await readFile(file, 'utf8'), original)
    assert.equal((await backups(dir)).length, 2)
  })
})

describe('agents.json: bloqueio pelos canais do Main', () => {
  const opened: Services[] = []
  after(() => opened.forEach((s) => s.runs.dispose()))

  async function boot(contents: string) {
    const dir = await tempDir()
    await writeFile(join(dir, 'agents.json'), contents)
    const services = await createServices(dir, { stepDelayMs: 1 })
    opened.push(services)
    const handlers = createDataHandlers(services)
    return { file: join(dir, 'agents.json'), call: (channel: keyof typeof handlers, ...args: unknown[]) => invokeHandler('x', handlers[channel], args), services }
  }

  it('chamadas diretas são recusadas, sem depender da interface', async () => {
    const original = envelope([valid, incompatible])
    const { call, file } = await boot(original)
    for (const [channel, arg] of [
      [IpcChannels.agentsCreate, agentDraft({ id: 'novo', tools: [] })],
      [IpcChannels.agentsUpdate, validDraft],
      [IpcChannels.agentsDelete, 'valido']
    ] as const) {
      const result = await call(channel, arg)
      assert.equal(!result.ok && result.error.code, 'storage-read-only', channel)
      assert.ok(!result.ok && !/agents\.json|\$\.agents|campoNovo/.test(JSON.stringify(result.error)), 'nada do arquivo no erro')
    }
    assert.equal(await readFile(file, 'utf8'), original)
  })

  const cases: Array<[string, string, AgentsStorageStatus['block']]> = [
    ['válido', envelope([valid]), null],
    ['incompatível', envelope([valid, incompatible]), 'damaged'],
    ['corrompido', '{ quebrado', 'damaged'],
    ['versão futura', envelope([valid], AGENTS_FORMAT_VERSION + 1), 'newer-version']
  ]
  for (const [label, contents, block] of cases) {
    it(`o estado exposto corresponde ao real: arquivo ${label}`, async () => {
      const { call, services } = await boot(contents)
      const result = await call(IpcChannels.agentsStorageStatus)
      assert.deepEqual(result, { ok: true, data: { block } })
      assert.deepEqual(result.ok && result.data, services.agents.storageStatus())
      const write = await call(IpcChannels.agentsCreate, agentDraft({ id: 'novo', tools: [] }))
      assert.equal(write.ok, block === null, 'o que o estado diz é o que o Main faz')
    })
  }

  it('o estado não leva caminhos nem conteúdo do arquivo', async () => {
    const { call } = await boot(envelope([valid, incompatible]))
    const result = await call(IpcChannels.agentsStorageStatus)
    assert.ok(result.ok)
    assert.deepEqual(Object.keys(result.data as object), ['block'])
  })

  it('o canal não aceita argumentos', async () => {
    const { call } = await boot(envelope([valid]))
    const result = await call(IpcChannels.agentsStorageStatus, '../outro.json')
    assert.equal(!result.ok && result.error.code, 'validation')
  })
})

describe('agents.json: compatibilidade ao salvar outro agente', () => {
  it('não altera nenhum dos agentes existentes, nem depois de reabrir', async () => {
    const agents = [
      stored({ id: 'sem-provedor', defaultModel: { providerId: null, modelId: 'llama3.2:3b' } }),
      stored({ id: 'com-provedor', defaultModel: { providerId: 'ollama', modelId: 'llama3.2:3b' } }),
      stored({ id: 'tipos', taskTypes: ['data', 'code'] }),
      stored({
        id: 'avancado',
        defaultProfile: { ...DEFAULT_EXECUTION_PROFILE, temperature: 0.2, topP: 0.5, maxOutputTokens: 900, contextLength: 8192, seed: 0, cpuThreads: 6, gpuMode: 'cpu-only', timeoutSeconds: 120 }
      }),
      stored({ id: 'acesso', tools: ['web-search', 'filesystem'], requestedPermissions: ['filesystem:read'] }),
      stored({ id: 'sem-ferramenta-instalada', tools: ['fantasma'], requestedPermissions: ['process'] }),
      stored({ id: 'arquivado', state: 'archived' }),
      stored({ id: 'rascunho', state: 'draft', defaultModel: null, instructions: '' })
    ]
    const { file, service, status, make } = await open(envelope(agents))
    assert.equal(status.state, 'loaded')
    await service.create(agentDraft({ id: 'novo', tools: [] }))

    const after = await onDisk(file)
    assert.deepEqual(after.filter((a) => a.id !== 'novo'), agents)

    const reopened = make()
    assert.equal((await reopened.init()).state, 'loaded')
    assert.deepEqual(reopened.list().filter((r) => r.definition.id !== 'novo').map((r) => r.definition), agents)
  })
})

describe('Ferramenta desconhecida', () => {
  const haunted = stored({ id: 'assombrado', tools: ['calculator', 'fantasma'], requestedPermissions: ['process'] })
  const { createdAt: _c, updatedAt: _u, ...draft } = haunted

  it('abrir mantém a referência, sem tratá-la como ferramenta disponível', async () => {
    const { service, status } = await open(envelope([haunted]))
    assert.equal(status.state, 'loaded')
    const [record] = service.list()
    assert.deepEqual(record!.definition.tools, ['calculator', 'fantasma'])
    assert.ok(record!.availability.issues.some((i) => i.code === 'unknown-tool' && i.toolId === 'fantasma'))
  })

  it('salvar com a referência é recusado e não toca o arquivo', async () => {
    const original = envelope([haunted])
    const { file, service } = await open(original)
    await assert.rejects(service.update({ ...draft, name: 'Outro nome' }), { code: 'validation' })
    assert.equal(await readFile(file, 'utf8'), original)
  })

  it('remover só essa referência persiste após reabrir, com o restante intacto', async () => {
    const { file, service, make } = await open(envelope([haunted]))
    await service.update({ ...draft, tools: ['calculator'] })
    const [saved] = await onDisk(file)
    assert.deepEqual(saved!.tools, ['calculator'])
    assert.deepEqual(saved!.requestedPermissions, ['process'])
    assert.equal(saved!.createdAt, dates.createdAt)

    const reopened = make()
    assert.equal((await reopened.init()).state, 'loaded')
    assert.deepEqual(reopened.find('assombrado')!.tools, ['calculator'])
    assert.ok(!reopened.list()[0]!.availability.issues.some((i) => i.code === 'unknown-tool'))
  })
})

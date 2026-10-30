import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { createServices, type Services } from '../../src/main/services'
import type { AgentDraft, AgentIssue, AgentRecord, AgentsStorageBlock } from '../../src/shared/agents'
import type { Conversation } from '../../src/shared/conversations'
import type { Result, StructuredError } from '../../src/shared/errors'
import type { ModelCapability, ModelRef, ProviderOverview, ProviderState } from '../../src/shared/inference'
import { IpcChannels } from '../../src/shared/ipc'
import type { RunRecord } from '../../src/shared/runs'
import { draftFromForm, formFromDefinition } from '../../src/renderer/src/lib/agent-form'
import { agentModelField } from '../../src/renderer/src/lib/agent-model'
import { agentOptionLabel, agentsInventoryNotice, agentStatus, agentStorageNotice, conversationAgentNotice, conversationNotes, TOOLS_NOTICE } from '../../src/renderer/src/lib/agent-status'
import { eligibleModels, modelKey, sendRequestFrom } from '../../src/renderer/src/lib/real-runs'
import type { Resource } from '../../src/renderer/src/lib/use-resource'
import { chunk, closedUrl, fakeOllama, final, json, stream, tag } from '../support/fake-ollama'
import { agentDraft, settle, tempDir } from '../support/fixtures'

const entry = (providerId: string, modelId: string, capabilities: ModelCapability[] = ['chat']) => ({
  availability: 'installed' as const,
  model: {
    ref: { providerId, modelId },
    digest: null,
    location: 'local' as const,
    displayName: modelId,
    family: null,
    parameterSize: null,
    quantization: null,
    format: null,
    sizeBytes: null,
    contextLength: null,
    contextBytesPerToken: null,
    capabilities
  }
})

const provider = (id: string, state: ProviderState, models: ReturnType<typeof entry>[] | null): ProviderOverview => ({
  info: { id, displayName: `Motor ${id}`, kind: 'external' },
  status: { providerId: id, state, version: null, checkedAt: null, message: null },
  models
})

const ready = (...providers: ProviderOverview[]): Resource<ProviderOverview[]> => ({ status: 'ready', data: providers })
const LOADING: Resource<ProviderOverview[]> = { status: 'loading' }
const FAILED: Resource<ProviderOverview[]> = { status: 'error', error: { code: 'internal', message: 'falhou', retryable: true } as StructuredError }
const OFF = ready(provider('local', 'unreachable', null))
const INSTALLED = ready(provider('local', 'ready', [entry('local', 'llama3.1:8b'), entry('local', 'qwen3:8b')]))
const LEGACY: ModelRef = { providerId: null, modelId: 'llama3.1:8b' }

const record = (overrides: Partial<AgentDraft> = {}, issues: AgentIssue[] = []): AgentRecord => ({
  definition: { ...agentDraft({ tools: [], defaultModel: LEGACY, ...overrides }), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  availability: { status: issues.length > 0 ? 'unavailable' : 'available', issues }
})
const texts = (view: ReturnType<typeof agentStatus>, kind: string) => view.notes.filter((n) => n.kind === kind).map((n) => n.text)

describe('Situação do agente: estado persistido', () => {
  it('pronto com modelo instalado: pode conversar, sem observações', () => {
    const view = agentStatus(record(), INSTALLED)
    assert.equal(view.executability, 'conversable')
    assert.deepEqual(view.badge, { tone: 'success', label: 'Pode conversar' })
    assert.equal(view.canOpen, true)
    assert.deepEqual(view.notes, [])
  })

  it('rascunho: identificado, e aceito como o RunService aceita', () => {
    const view = agentStatus(record({ state: 'draft', instructions: '', defaultModel: null }), INSTALLED)
    assert.equal(view.executability, 'conversable')
    assert.equal(view.canOpen, true)
    assert.match(texts(view, 'state')[0]!, /rascunho/i)
    assert.match(texts(view, 'model')[0]!, /Sem modelo padrão/)
    assert.match(texts(view, 'instructions')[0]!, /Sem instruções/)
    assert.equal(agentOptionLabel(record({ state: 'draft' }).definition), 'Assistente Geral (rascunho)')
    assert.equal(agentOptionLabel(record().definition), 'Assistente Geral')
  })

  it('arquivado: bloqueado em qualquer inventário e sem aviso de modelo', () => {
    for (const providers of [INSTALLED, OFF, FAILED, LOADING]) {
      const view = agentStatus(record({ state: 'archived', defaultModel: { providerId: null, modelId: 'removido:1b' } }), providers)
      assert.equal(view.executability, 'blocked')
      assert.equal(view.canOpen, false)
      assert.equal(view.actionTitle, 'Agente arquivado não pode ser executado')
      assert.notEqual(view.badge.tone, 'danger')
      assert.deepEqual(texts(view, 'model'), [])
    }
  })

  it('nada aqui altera o agente: a definição sai como entrou', () => {
    const agent = record({ state: 'draft' })
    const before = structuredClone(agent)
    agentStatus(agent, OFF)
    agentStatus(agent, FAILED)
    assert.deepEqual(agent, before)
  })
})

describe('Situação do agente: ferramentas', () => {
  it('pronto sem ferramentas não recebe aviso de ferramentas', () => {
    assert.deepEqual(texts(agentStatus(record({ tools: [] }), INSTALLED), 'tools'), [])
  })

  it('ferramentas sem implementação geram aviso, não "indisponível" nem bloqueio', () => {
    const view = agentStatus(
      record({ tools: ['calculator'] }, [{ code: 'tool-not-implemented', message: 'Ferramenta "Calculadora" ainda não tem implementação.', toolId: 'calculator' }]),
      INSTALLED
    )
    assert.equal(view.executability, 'conversable')
    assert.equal(view.canOpen, true)
    assert.deepEqual(texts(view, 'tools'), [TOOLS_NOTICE])
    assert.match(TOOLS_NOTICE, /ainda não estão disponíveis/)
    assert.match(TOOLS_NOTICE, /pode continuar sem essas ferramentas/)
  })

  it('demais pendências de ferramenta continuam visíveis e não bloqueiam', () => {
    const issue: AgentIssue = { code: 'missing-permission', message: '"Busca na Web" exige a permissão network.', toolId: 'web-search', permission: 'network' }
    const view = agentStatus(record({ tools: ['web-search'] }, [issue]), INSTALLED)
    assert.equal(view.executability, 'conversable')
    assert.deepEqual(texts(view, 'tools'), [TOOLS_NOTICE, '"Busca na Web" exige a permissão Rede.'])
  })
})

describe('Situação do agente: modelos', () => {
  it('modelo instalado e compatível: sem aviso', () => {
    assert.deepEqual(texts(agentStatus(record(), INSTALLED), 'model'), [])
  })

  it('ausência confirmada: informa, e continua conversável com outro modelo', () => {
    const view = agentStatus(record({ defaultModel: { providerId: null, modelId: 'removido:1b' } }), INSTALLED)
    assert.equal(view.executability, 'conversable')
    assert.match(texts(view, 'model')[0]!, /"removido:1b" não está instalado\. Ele continua salvo no agente/)
  })

  it('motor respondeu sem modelos: ausência confirmada, sem nada para conversar', () => {
    const view = agentStatus(record(), ready(provider('local', 'ready', [])))
    assert.equal(view.executability, 'no-model')
    assert.equal(view.badge.label, 'Sem modelo instalado')
    assert.equal(view.canOpen, true, 'Conversas explica o que falta')
    assert.match(texts(view, 'model')[0]!, /não está instalado/)
  })

  it('Ollama desligado: não afirma remoção', () => {
    const view = agentStatus(record(), OFF)
    assert.equal(view.executability, 'no-engine')
    assert.equal(view.badge.label, 'Motor não responde')
    assert.notEqual(view.badge.tone, 'danger')
    assert.match(texts(view, 'model')[0]!, /Não foi possível verificar/)
    assert.doesNotMatch(texts(view, 'model')[0]!, /não está instalado|removido/)
  })

  it('falha na consulta do inventário: não verificado, nunca lista vazia', () => {
    const view = agentStatus(record(), FAILED)
    assert.equal(view.executability, 'unverified')
    assert.equal(view.badge.label, 'Não verificado')
    assert.equal(view.badge.tone, 'neutral')
    assert.match(texts(view, 'model')[0]!, /Não foi possível verificar/)
  })

  it('consulta em andamento: nada é afirmado', () => {
    const view = agentStatus(record(), LOADING)
    assert.equal(view.executability, 'checking')
    assert.deepEqual(texts(view, 'model'), [])
  })

  it('modelo incompatível com conversa: avisa, sem confundir com ausente', () => {
    const view = agentStatus(
      record({ defaultModel: { providerId: 'local', modelId: 'embed:1b' } }),
      ready(provider('local', 'ready', [entry('local', 'embed:1b', ['embedding']), entry('local', 'qwen3:8b')]))
    )
    assert.equal(view.executability, 'conversable')
    assert.match(texts(view, 'model')[0]!, /não serve para conversa/)
  })

  it('só modelos incompatíveis: não há com o que conversar', () => {
    const view = agentStatus(record({ defaultModel: { providerId: 'local', modelId: 'embed:1b' } }), ready(provider('local', 'ready', [entry('local', 'embed:1b', ['embedding'])])))
    assert.equal(view.executability, 'no-model')
  })

  it('referência ambígua: pede a escolha, sem vincular a um provedor', () => {
    const providers = ready(provider('a', 'ready', [entry('a', 'llama3.1:8b')]), provider('b', 'ready', [entry('b', 'llama3.1:8b')]))
    const agent = record()
    const view = agentStatus(agent, providers)
    assert.equal(view.executability, 'conversable')
    assert.match(texts(view, 'model')[0]!, /mais de um provedor/)
    assert.deepEqual(agent.definition.defaultModel, LEGACY)
  })

  it('agente antigo com providerId null: reconhecido como instalado e preservado ao salvar', () => {
    const agent = record()
    assert.deepEqual(texts(agentStatus(agent, INSTALLED), 'model'), [])
    const saved = draftFromForm(formFromDefinition(agent.definition), [])
    assert.ok(saved.ok)
    assert.deepEqual(saved.draft.defaultModel, LEGACY)
  })

  it('o card e o editor leem o mesmo estado do modelo', () => {
    const agent = record({ defaultModel: { providerId: null, modelId: 'removido:1b' } })
    assert.equal(agentModelField(formFromDefinition(agent.definition), INSTALLED).configured, 'missing')
    assert.equal(agentModelField(formFromDefinition(agent.definition), OFF).configured, 'unverified')
  })
})

describe('Situação do agente: avisos de lista e de Conversas', () => {
  it('aviso único do inventário, sem cor de erro', () => {
    assert.equal(agentsInventoryNotice(INSTALLED), null)
    assert.equal(agentsInventoryNotice(LOADING), null)
    assert.equal(agentsInventoryNotice(FAILED)?.tone, 'warning')
    assert.match(agentsInventoryNotice(OFF)!.text, /não está respondendo/)
  })

  it('Conversas recebe só o que muda a conversa', () => {
    const view = agentStatus(record({ state: 'draft', tools: ['calculator'], instructions: '', defaultModel: { providerId: null, modelId: 'removido:1b' } }), INSTALLED)
    assert.deepEqual(conversationNotes(view).map((n) => n.kind), ['model', 'instructions'])
  })
})

describe('Armazenamento de agentes protegido', () => {
  const notice = (block: AgentsStorageBlock | null) => agentStorageNotice({ block })
  const BLOCKS = ['damaged', 'backup-failed', 'newer-version', 'unreadable'] as const

  it('sem bloqueio, não há aviso', () => {
    assert.equal(notice(null), null)
  })

  it('todo bloqueio é informado, sem caminhos nem conteúdo', () => {
    for (const block of BLOCKS) {
      assert.match(notice(block)!, /bloqueadas/, block)
      assert.doesNotMatch(notice(block)!, /agents\.json|[A-Z]:\\|\$\.agents/, block)
    }
  })

  it('só afirma haver cópia de segurança quando ela foi confirmada', () => {
    assert.match(notice('damaged')!, /há uma cópia de segurança/)
    assert.match(notice('backup-failed')!, /não foi possível confirmar uma cópia/)
    for (const block of ['backup-failed', 'newer-version', 'unreadable'] as const) assert.doesNotMatch(notice(block)!, /há uma cópia/, block)
  })

  it('Conversas: com o armazenamento protegido, não afirma que o agente foi excluído', () => {
    const texto = conversationAgentNotice(false, { block: 'damaged' })
    assert.match(texto, /não foi possível carregar/i)
    assert.match(texto, /mensagens foram preservadas/)
    assert.doesNotMatch(texto, /excluído|arquivado/)
  })

  it('Conversas: agente lido e arquivado, ou armazenamento normal, mantém a explicação de sempre', () => {
    assert.match(conversationAgentNotice(true, { block: 'damaged' }), /excluído ou arquivado/)
    assert.match(conversationAgentNotice(false, { block: null }), /excluído ou arquivado/)
    assert.match(conversationAgentNotice(false, null), /excluído ou arquivado/)
  })

  it('Menu: Esc devolve o foco ao botão, e texto auxiliar mantém o contraste em superfícies destacadas', () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
    assert.match(read('src/renderer/src/components/ui/Menu.tsx'), /setOpen\(false\)\n.*\n\s+rootRef\.current\?\.querySelector<HTMLElement>\('button'\)\?\.focus\(\)/)
    assert.match(read('src/renderer/src/components/runs/RunParts.tsx'), /className="muted">Detalhe:/)
    assert.match(read('src/renderer/src/styles/pages.css'), /\.chat__item--active \.subtle \{\n  color: var\(--text-muted\);/)
  })

  it('Conversas: escolher outro agente usa o modelo padrão dele', () => {
    const PAGE = readFileSync(join(process.cwd(), 'src/renderer/src/pages/ConversationsPage.tsx'), 'utf8')
    assert.match(PAGE, /onChange=\{\(e\) => chooseAgent\(e\.target\.value\)\}/)
    assert.match(PAGE, /modelForAgent\(options, key, chosen\?\.definition\.defaultModel \?\? null, requestedModel\)/)
  })

  it('Conversas: a tela consulta o estado e não convida a criar agente quando isso está bloqueado', () => {
    const PAGE = readFileSync(join(process.cwd(), 'src/renderer/src/pages/ConversationsPage.tsx'), 'utf8')
    assert.match(PAGE, /const storage = useResource\(\(\) => window\.gerpro\.agents\.storageStatus\(\)\)/)
    assert.match(PAGE, /title=\{agentsLocked \? 'Nenhum agente disponível' : 'Crie um agente para começar'\}/)
    assert.match(PAGE, /'Agente não carregado'/)
  })

  it('a página mostra o aviso e desabilita o que grava', () => {
    const AGENTS = readFileSync(join(process.cwd(), 'src/renderer/src/pages/AgentsPage.tsx'), 'utf8')
    assert.match(AGENTS, /window\.gerpro\.agents\.storageStatus\(\)/)
    assert.match(AGENTS, /\{storageNotice && \(\s*<Notice tone="warning"/)
    assert.match(AGENTS, /disabled=\{saved\.state\.status !== 'ready' \|\| locked\}/)
    assert.equal(AGENTS.match(/disabled: locked/g)?.length, 4, 'editar, restaurar, arquivar e excluir')
    assert.match(AGENTS, /canDuplicate=\{[^}]*!locked\}/)
  })

  it('o Preload expõe só a consulta do estado', () => {
    const PRELOAD = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    assert.match(PRELOAD, /storageStatus: \(\) => ipcRenderer\.invoke\(IpcChannels\.agentsStorageStatus\)/)
  })
})

describe('Telas', () => {
  const read = (path: string) => readFileSync(join(import.meta.dirname, '../../src/renderer/src', path), 'utf8')
  const AGENTS = read('pages/AgentsPage.tsx')
  const CONVERSATIONS = read('pages/ConversationsPage.tsx')

  it('Agentes: indicador e ação vêm da mesma função; o estado gravado aparece à parte', () => {
    assert.match(AGENTS, /const status = agentStatus\(record, providers\.state\)/)
    assert.match(AGENTS, /<StatusBadge tone=\{status\.badge\.tone\}>\{status\.badge\.label\}<\/StatusBadge>/)
    assert.match(AGENTS, /disabled=\{!status\.canOpen\}\s+title=\{status\.actionTitle\}/)
    assert.match(AGENTS, /<Tag>Estado: \{agentConfigState\[def\.state\]\}<\/Tag>/)
    assert.doesNotMatch(AGENTS, /availability\.status|agentAvailability|execução real não está habilitada/)
  })

  it('Agentes: textos refletem o produto atual', () => {
    assert.match(AGENTS, /a execução de ferramentas ainda não está disponível/)
    assert.doesNotMatch(read('lib/status.ts'), /'Indisponível'/)
  })

  it('Conversas: arquivados fora da lista, rascunhos identificados e observações do agente', () => {
    assert.match(CONVERSATIONS, /filter\(\(a\) => a\.definition\.state !== 'archived'\)/)
    assert.match(CONVERSATIONS, /label: agentOptionLabel\(a\.definition\)/)
    assert.match(CONVERSATIONS, /conversationNotes\(agentStatus\(agent, providers\.state\)\)/)
    assert.doesNotMatch(CONVERSATIONS, /'Agente indisponível'/)
  })

  it('recomendações não dizem que um agente salvo é inexecutável', () => {
    assert.match(read('components/hardware/AgentRecommendations.tsx'), /rec\.origin === 'example' && !rec\.executableNow/)
  })

  it('o editor avisa sobre ferramentas, sem depender de disponibilidade antiga', () => {
    const editor = read('components/agents/AgentEditor.tsx')
    assert.match(editor, /<Notice tone="info">\{TOOLS_PLANNED_NOTICE\}<\/Notice>/)
    assert.doesNotMatch(editor, /aparece como disponível/)
  })
})

describe('Situação do agente com o Main real', () => {
  function bridge(services: Services) {
    const handlers = createDataHandlers(services)
    const call = async <T>(channel: keyof typeof handlers, ...args: unknown[]) => (await invokeHandler(channel, handlers[channel], args)) as Result<T>
    after(() => {
      services.conversations.dispose()
      services.runs.dispose()
    })
    return call
  }

  const resource = (result: Result<ProviderOverview[]>): Resource<ProviderOverview[]> =>
    result.ok ? { status: 'ready', data: result.data } : { status: 'error', error: result.error }

  async function engine() {
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.2:3b')] }), 'POST /api/chat': stream([chunk('Olá'), final()]) })
    after(() => fake.close())
    const services = await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: fake.url })
    return { services, call: bridge(services) }
  }

  /** Envia como Conversas: com o modelo instalado escolhido, nunca o padrão do agente. */
  async function send(services: Services, call: ReturnType<typeof bridge>, agentId: string, providers: ProviderOverview[]) {
    const options = eligibleModels(providers)
    const request = sendRequestFrom({ agentId, modelKey: modelKey(options[0]!.ref), input: 'Olá' }, options, null)
    const result = await call<{ conversation: Conversation; run: RunRecord }>(IpcChannels.conversationsSend, request)
    if (!result.ok) return result
    const deadline = Date.now() + 3_000
    while (services.runs.get(result.data.run.id)?.state !== 'completed') {
      assert.ok(Date.now() < deadline, 'execução não terminou')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await settle()
    await services.conversations.whenSaved()
    return result
  }

  it('o que a tela indica é o que o Main faz, em cada estado e configuração', async () => {
    const { services, call } = await engine()
    const list = await call<ProviderOverview[]>(IpcChannels.providersList)
    assert.ok(list.ok)
    const providers = resource(list)

    const cases: Array<[string, Partial<AgentDraft>]> = [
      ['pronto', { state: 'ready', tools: [], defaultModel: { providerId: null, modelId: 'llama3.2:3b' } }],
      ['rascunho', { state: 'draft', tools: [], instructions: '', defaultModel: null }],
      ['com-ferramentas', { state: 'ready', tools: ['calculator'], defaultModel: { providerId: null, modelId: 'llama3.2:3b' } }],
      ['modelo-ausente', { state: 'ready', tools: [], defaultModel: { providerId: 'ollama', modelId: 'removido:1b' } }],
      ['arquivado', { state: 'archived', tools: [], defaultModel: { providerId: null, modelId: 'llama3.2:3b' } }]
    ]
    for (const [id, overrides] of cases) {
      const created = await call<AgentRecord>(IpcChannels.agentsCreate, agentDraft({ id, ...overrides }))
      assert.ok(created.ok, id)
      const view = agentStatus(created.data, providers)
      const sent = await send(services, call, id, list.data)
      assert.equal(sent.ok, view.executability === 'conversable', `${id}: tela e Main divergem`)
      assert.equal(view.canOpen, id !== 'arquivado', id)
      if (!sent.ok) {
        assert.equal(sent.error.code, 'invalid-state')
        assert.equal(sent.error.message, view.actionTitle + '.')
      }
    }
  })

  it('as ferramentas declaradas não chegam ao modelo e as instruções, sim', async () => {
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.2:3b')] }), 'POST /api/chat': stream([chunk('Olá'), final()]) })
    after(() => fake.close())
    const services = await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: fake.url })
    const call = bridge(services)
    await call(IpcChannels.agentsCreate, agentDraft({ id: 'com-ferramentas', tools: ['calculator'], instructions: 'Seja objetivo.', defaultModel: { providerId: null, modelId: 'llama3.2:3b' } }))
    const list = await call<ProviderOverview[]>(IpcChannels.providersList)
    assert.ok(list.ok)
    assert.ok((await send(services, call, 'com-ferramentas', list.data)).ok)
    const body = JSON.stringify(fake.chats[0])
    assert.match(body, /Seja objetivo\./)
    assert.doesNotMatch(body, /calculator|"tools"/)
  })

  it('Ollama desligado: agente salvo sem mudança, e a tela não promete conversa', async () => {
    const call = bridge(await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: await closedUrl() }))
    const created = await call<AgentRecord>(IpcChannels.agentsCreate, agentDraft({ tools: [], defaultModel: LEGACY }))
    assert.ok(created.ok)
    const list = await call<ProviderOverview[]>(IpcChannels.providersList)
    const view = agentStatus(created.data, resource(list))
    assert.equal(view.executability, 'no-engine')
    assert.equal(view.canOpen, true)
    assert.deepEqual(created.data.definition.defaultModel, LEGACY)
    assert.ok(list.ok)
    assert.deepEqual(eligibleModels(list.data), [], 'Conversas fica sem modelo para enviar')
  })
})

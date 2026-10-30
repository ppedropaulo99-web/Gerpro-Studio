import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { createServices, type Services } from '../../src/main/services'
import { parseAgentsFile } from '../../src/main/services/agent-service'
import type { AgentDraft, AgentRecord } from '../../src/shared/agents'
import type { Conversation } from '../../src/shared/conversations'
import type { Result } from '../../src/shared/errors'
import { DEFAULT_EXECUTION_PROFILE } from '../../src/shared/execution'
import type { ProviderOverview } from '../../src/shared/inference'
import { IpcChannels } from '../../src/shared/ipc'
import { recommendAgent, TASK_TYPES } from '../../src/shared/recommendations'
import type { RunRecord } from '../../src/shared/runs'
import type { ToolCatalogEntry } from '../../src/shared/tools'
import { exampleAgentProfiles } from '../../src/renderer/src/data/agent-requirements'
import { agents as exampleAgents } from '../../src/renderer/src/data/agents'
import { buildCandidates } from '../../src/renderer/src/lib/advisor'
import {
  advancedSummary,
  agentActionMessage,
  agentFormChanged,
  agentFormErrors,
  draftFromForm,
  emptyAgentForm,
  formFromDefinition,
  formFromExample,
  formPermissions,
  hasAdvancedError,
  toggledTaskTypes,
  unknownTools,
  type AgentFormValues
} from '../../src/renderer/src/lib/agent-form'
import { agentModelField, withModelChoice } from '../../src/renderer/src/lib/agent-model'
import { agentStatus } from '../../src/renderer/src/lib/agent-status'
import { eligibleModels, modelKey, sendRequestFrom } from '../../src/renderer/src/lib/real-runs'
import { chunk, fakeOllama, final, json, stream, tag } from '../support/fake-ollama'
import { agentDraft, settle, tempDir } from '../support/fixtures'

const CUSTOM = { temperature: 0.2, topP: 0.5, maxOutputTokens: 900, contextLength: 8192, seed: 42, cpuThreads: 6, gpuMode: 'cpu-only' as const, timeoutSeconds: 120 }
const tool = (id: string, permissions: string[] = []) => ({ definition: { id, permissions } }) as unknown as ToolCatalogEntry
const form = (overrides: Partial<AgentDraft> = {}) => formFromDefinition(agentDraft({ tools: [], ...overrides }))
const saved = (f: AgentFormValues, catalog: ToolCatalogEntry[] = []) => {
  const result = draftFromForm(f, catalog)
  assert.ok(result.ok, JSON.stringify(result))
  return result.draft
}

describe('Configurações básicas', () => {
  it('carrega nome, descrição, instruções, modelo, tipos e estado do agente', () => {
    const f = form({ name: 'Meu agente', description: 'Faz algo.', instructions: 'Seja direto.', taskTypes: ['code'], state: 'ready', defaultModel: { providerId: 'ollama', modelId: 'llama3.2:3b' } })
    assert.deepEqual([f.name, f.description, f.instructions, f.modelId, f.taskTypes, f.state], ['Meu agente', 'Faz algo.', 'Seja direto.', 'llama3.2:3b', ['code'], 'ready'])
  })

  it('agente novo começa em rascunho, sem modelo e com os padrões', () => {
    const f = emptyAgentForm()
    assert.equal(f.state, 'draft')
    assert.equal(f.modelId, '')
    assert.equal(advancedSummary(f), 'Valores padrão')
    assert.deepEqual(saved({ ...f, id: 'novo', name: 'Novo' }).defaultProfile, DEFAULT_EXECUTION_PROFILE)
  })
})

describe('Configurações avançadas', () => {
  it('carrega todos os parâmetros do perfil', () => {
    const f = form({ defaultProfile: { ...CUSTOM } })
    assert.deepEqual(
      [f.temperature, f.topP, f.maxOutputTokens, f.contextLength, f.seed, f.cpuThreads, f.gpuMode, f.timeoutSeconds],
      ['0.2', '0.5', '900', '8192', '42', '6', 'cpu-only', '120']
    )
  })

  it('semente 0 é um valor, não vazio', () => {
    const f = form({ defaultProfile: { ...DEFAULT_EXECUTION_PROFILE, seed: 0 } })
    assert.equal(f.seed, '0')
    assert.equal(saved(f).defaultProfile.seed, 0)
  })

  it('o resumo mostra o que está guardado com a seção recolhida', () => {
    assert.equal(advancedSummary(form()), 'Valores padrão')
    assert.equal(advancedSummary({ ...form(), seed: '7' }), '1 ajuste personalizado')
    assert.equal(advancedSummary(form({ defaultProfile: { ...CUSTOM }, tools: ['calculator', 'terminal'] })), '8 ajustes personalizados · 2 ferramentas declaradas')
    assert.equal(advancedSummary(form({ tools: ['calculator'] })), 'Valores padrão · 1 ferramenta declarada')
  })

  it('recolher a seção não muda nada: a edição vive no formulário', () => {
    const initial = form({ defaultProfile: { ...CUSTOM } })
    const edited = { ...initial, seed: '7' }
    assert.equal(agentFormChanged(initial, edited), true)
    assert.deepEqual(saved(edited).defaultProfile, { ...CUSTOM, seed: 7 })
  })

  it('edita e devolve cada parâmetro convertido; vírgula decimal é aceita', () => {
    const f: AgentFormValues = { ...form(), temperature: '0,3', topP: '0.8', maxOutputTokens: '500', contextLength: '4096', seed: '1', cpuThreads: '4', gpuMode: 'cpu-only', timeoutSeconds: '60' }
    assert.deepEqual(saved(f).defaultProfile, { temperature: 0.3, topP: 0.8, maxOutputTokens: 500, contextLength: 4096, seed: 1, cpuThreads: 4, gpuMode: 'cpu-only', timeoutSeconds: 60 })
  })

  it('vazio volta a "padrão do motor" nos opcionais', () => {
    const f = { ...form({ defaultProfile: { ...CUSTOM } }), maxOutputTokens: '', contextLength: '', seed: '', cpuThreads: '' }
    const profile = saved(f).defaultProfile
    assert.deepEqual([profile.maxOutputTokens, profile.contextLength, profile.seed, profile.cpuThreads], [null, null, null, null])
  })

  it('valores inválidos são recusados com mensagem própria, e abrem a área avançada', () => {
    const cases: Array<[keyof AgentFormValues, string, RegExp]> = [
      ['temperature', '3', /de 0 a 2/],
      ['temperature', '', /de 0 a 2/],
      ['topP', '2', /de 0 a 1/],
      ['maxOutputTokens', '0', /inteiro de 1 a 1\.000\.000/],
      ['contextLength', '100', /inteiro de 256 a/],
      ['seed', '-1', /inteiro de 0 a/],
      ['cpuThreads', '1.5', /inteiro de 1 a 256/],
      ['timeoutSeconds', '5', /inteiro de 10 a 3\.600 segundos/],
      ['timeoutSeconds', '', /inteiro de 10 a 3\.600 segundos/]
    ]
    for (const [field, value, expected] of cases) {
      const result = draftFromForm({ ...form(), [field]: value }, [])
      assert.ok(!result.ok, `${field}=${value}`)
      assert.match(result.errors[field]!, expected)
      assert.doesNotMatch(result.errors[field]!, /\$\.|≥|≤|finito/)
      assert.equal(hasAdvancedError(result.errors), true, field)
    }
  })

  it('erros básicos não abrem a área avançada', () => {
    assert.equal(hasAdvancedError({ name: 'x', instructions: 'y', modelId: 'z', taskTypes: 'w' }), false)
    assert.equal(hasAdvancedError({ version: 'x' }), true)
    assert.equal(hasAdvancedError({ id: 'x' }), true)
  })

  it('nome vazio deixa o ID inválido, mas o erro a corrigir é básico', () => {
    const result = draftFromForm({ ...emptyAgentForm(), name: '' }, [])
    assert.ok(!result.ok)
    assert.ok(result.errors.name && result.errors.id)
    assert.equal(hasAdvancedError(result.errors), false)
  })
})

describe('Mensagens', () => {
  it('campos básicos falam com quem configura, sem caminhos do contrato', () => {
    const result = draftFromForm({ ...form({ state: 'ready' }), name: '   ', instructions: '', modelId: '', boundModel: null, version: 'um' }, [])
    assert.ok(!result.ok)
    assert.equal(result.errors.name, 'Dê um nome ao agente.')
    assert.equal(result.errors.version, 'Use o formato 1.0.0.')
    assert.match(result.errors.instructions!, /obrigatórias no estado Pronto; para deixar para depois, use Rascunho/)
    assert.match(result.errors.modelId!, /obrigatório no estado Pronto/)
  })

  it('ID: distingue formato inválido de ID já usado', () => {
    assert.match(agentFormErrors([{ path: '$.id', message: 'use letras minúsculas, dígitos e hífen (até 64)' }]).id!, /minúsculas, números e hífen/)
    assert.equal(agentFormErrors([{ path: '$.id', message: 'ID já em uso' }]).id, 'Este ID já está em uso. Escolha outro.')
  })

  it('agente pronto sem modelo continua recusado, e o estado não muda sozinho', () => {
    const initial = emptyAgentForm()
    assert.equal(draftFromForm({ ...initial, id: 'a', name: 'A', state: 'ready' }, []).ok, false)
    assert.equal(saved({ ...initial, id: 'a', name: 'A' }).state, 'draft')
  })
})

describe('Preservação', () => {
  it('abrir e salvar sem mexer devolve o mesmo agente, campo a campo', () => {
    const draft = agentDraft({
      taskTypes: ['support', 'chat'],
      defaultProfile: { ...CUSTOM },
      defaultModel: { providerId: null, modelId: 'llama3.1:8b' },
      tools: ['web-search'],
      requestedPermissions: ['network'],
      state: 'draft'
    })
    assert.deepEqual(saved(formFromDefinition(draft), [tool('web-search', ['network'])]), draft)
  })

  it('agente antigo: permissões gravadas continuam iguais enquanto as ferramentas não mudam', () => {
    const faltando = agentDraft({ tools: ['web-search'], requestedPermissions: [] })
    assert.deepEqual(saved(formFromDefinition(faltando), [tool('web-search', ['network'])]).requestedPermissions, [])
    const sobrando = agentDraft({ tools: ['calculator'], requestedPermissions: ['network'] })
    assert.deepEqual(saved(formFromDefinition(sobrando), [tool('calculator')]).requestedPermissions, ['network'])
  })

  it('mudar as ferramentas recalcula as permissões; desfazer volta às gravadas', () => {
    const catalog = [tool('web-search', ['network']), tool('calculator')]
    const initial = form({ tools: ['calculator'], requestedPermissions: [] })
    assert.deepEqual(saved({ ...initial, tools: ['calculator', 'web-search'] }, catalog).requestedPermissions, ['network'])
    assert.deepEqual(saved({ ...initial, tools: ['calculator'] }, catalog).requestedPermissions, [])
  })

  it('sem alterações pendentes falsas: valores decimais e inteiros fazem o caminho de ida e volta', () => {
    const initial = form({ defaultProfile: { ...CUSTOM, temperature: 0.35 } })
    const reopened = formFromDefinition(saved(initial))
    assert.equal(agentFormChanged(initial, reopened), false)
  })

  it('alterações pendentes reais, em cada parâmetro avançado', () => {
    const initial = form()
    for (const [key, value] of Object.entries({ temperature: '1', topP: '0.1', maxOutputTokens: '1', contextLength: '256', seed: '0', cpuThreads: '1', gpuMode: 'cpu-only', timeoutSeconds: '10' })) {
      assert.equal(agentFormChanged(initial, { ...initial, [key]: value }), true, key)
      assert.equal(agentFormChanged(initial, { ...initial }), false, key)
    }
  })

  it('campo desconhecido no arquivo: o agente é recusado na leitura e o problema é relatado', () => {
    const definition = { ...agentDraft(), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    const outcome = parseAgentsFile({ agents: [definition, { ...definition, id: 'com-extra', campoNovo: 1 }] })
    assert.deepEqual(outcome.value?.agents.map((a) => a.id), [definition.id])
    assert.ok(outcome.issues.some((i) => i.path === '$.agents[1].campoNovo'))
  })
})

describe('Ferramentas desconhecidas', () => {
  const catalog = [tool('web-search', ['network']), tool('calculator')]
  const haunted = (o: Partial<AgentDraft> = {}) => form({ tools: ['calculator', 'fantasma'], requestedPermissions: ['process'], ...o })

  it('identifica só o que o catálogo não conhece, sem tirar nada do formulário', () => {
    const initial = haunted()
    assert.deepEqual(unknownTools(initial.tools, catalog), ['fantasma'])
    assert.deepEqual(initial.tools, ['calculator', 'fantasma'])
    assert.deepEqual(unknownTools(['calculator'], catalog), [])
  })

  it('abrir e salvar sem mexer mantém referência e permissões', () => {
    const draft = saved(haunted(), catalog)
    assert.deepEqual(draft.tools, ['calculator', 'fantasma'])
    assert.deepEqual(draft.requestedPermissions, ['process'])
  })

  it('remover a referência é uma alteração, e não muda as outras ferramentas nem as permissões', () => {
    const initial = haunted()
    const removed = { ...initial, tools: ['calculator'] }
    assert.equal(agentFormChanged(initial, removed), true)
    const draft = saved(removed, catalog)
    assert.deepEqual(draft.tools, ['calculator'])
    assert.deepEqual(draft.requestedPermissions, ['process'])
  })

  it('remover não concede a permissão que uma ferramenta conhecida exigiria', () => {
    const removed = { ...haunted({ tools: ['web-search', 'fantasma'], requestedPermissions: [] }), tools: ['web-search'] }
    assert.deepEqual(formPermissions(removed, catalog), [])
  })

  it('mudar uma ferramenta conhecida recalcula, sem perder o que não dá para atribuir', () => {
    const initial = haunted()
    assert.deepEqual(formPermissions({ ...initial, tools: ['calculator', 'fantasma', 'web-search'] }, catalog), ['network', 'process'])
  })

  it('agente novo continua com as permissões vindas das ferramentas escolhidas', () => {
    assert.deepEqual(formPermissions({ ...emptyAgentForm(), tools: ['web-search'] }, catalog), ['network'])
  })

  it('arquivar pela lista: a recusa orienta, sem caminhos do contrato, e o código segue no erro', () => {
    const error = { code: 'validation' as const, message: 'Dados inválidos: $.tools: ferramenta desconhecida: fantasma', retryable: false, issues: [{ path: '$.tools', message: 'ferramenta desconhecida: fantasma' }] }
    const text = agentActionMessage(error)
    assert.match(text, /Remova a referência/)
    assert.match(text, /Editar › Configurações avançadas › Ferramentas/)
    assert.doesNotMatch(text, /\$\.tools|Dados inválidos/)
    assert.equal(error.code, 'validation')
  })

  it('outros erros da lista seguem com a mensagem do Main', () => {
    assert.equal(agentActionMessage({ code: 'storage-read-only', message: 'Bloqueado.', retryable: false }), 'Bloqueado.')
  })

  it('a recusa do Main vira uma orientação, na área avançada', () => {
    const errors = agentFormErrors([{ path: '$.tools', message: 'ferramenta desconhecida: fantasma' }])
    assert.match(errors.tools!, /não reconhecida. Remova a referência/)
    assert.equal(hasAdvancedError(errors), true)
  })
})

describe('Regressões de etapas anteriores', () => {
  const INVENTORY = {
    status: 'ready' as const,
    data: [
      {
        info: { id: 'local', displayName: 'Motor local', kind: 'external' as const },
        status: { providerId: 'local', state: 'ready' as const, version: null, checkedAt: null, message: null },
        models: []
      }
    ] satisfies ProviderOverview[]
  }

  it('seletor de modelos: avançados não tocam o modelo, e providerId null é restaurado', () => {
    const legacy = { providerId: null, modelId: 'llama3.1:8b' }
    const initial = form({ defaultModel: legacy })
    const edited = { ...initial, temperature: '1' }
    const field = agentModelField(edited, INVENTORY, initial)
    assert.equal(withModelChoice(edited, field.selectedKey, field), edited)
    assert.deepEqual(saved(edited).defaultModel, legacy)
  })

  it('tipos de tarefa: seguem iguais com avançados alterados', () => {
    const initial = form({ taskTypes: ['support', 'chat'] })
    const edited = { ...initial, seed: '1', taskTypes: toggledTaskTypes(initial.taskTypes, 'code', true, initial.taskTypes) }
    assert.deepEqual(toggledTaskTypes(edited.taskTypes, 'code', false, initial.taskTypes), ['support', 'chat'])
  })

  it('disponibilidade: parâmetros avançados não mudam a situação do agente', () => {
    const base = agentDraft({ tools: [] })
    const record = (draft: AgentDraft): AgentRecord => ({ definition: { ...draft, createdAt: '', updatedAt: '' }, availability: { status: 'available', issues: [] } })
    const other = saved({ ...formFromDefinition(base), timeoutSeconds: '60', gpuMode: 'cpu-only' })
    assert.deepEqual(agentStatus(record(other), INVENTORY), agentStatus(record(base), INVENTORY))
  })
})

describe('Exemplos', () => {
  const catalog = exampleAgents.flatMap((a) => a.tools).map((id) => tool(id))

  it('todo exemplo tem perfil com o mesmo ID, então a correspondência é exata', () => {
    assert.deepEqual(exampleAgents.map((a) => a.id).sort(), Object.keys(exampleAgentProfiles).sort())
  })

  it('copia os tipos de tarefa, em ordem canônica; segue rascunho e sem modelo', () => {
    for (const example of exampleAgents) {
      const f = formFromExample(example, new Set(), catalog)
      assert.deepEqual([...f.taskTypes].sort(), [...exampleAgentProfiles[example.id]!.taskTypes].sort(), example.id)
      assert.deepEqual(f.taskTypes, TASK_TYPES.filter((t) => f.taskTypes.includes(t)))
      assert.equal(f.state, 'draft')
      assert.equal(f.modelId, '')
      assert.equal(f.boundModel, null)
      assert.equal(saved(f, catalog).defaultModel, null)
    }
  })

  it('o agente criado aparece como indicado nas recomendações, como o exemplo', () => {
    const example = exampleAgents.find((a) => a.id === 'revisor-codigo')!
    const draft = saved(formFromExample(example, new Set(), catalog), catalog)
    const record: AgentRecord = { definition: { ...draft, createdAt: '', updatedAt: '' }, availability: { status: 'available', issues: [] } }
    const [candidate] = buildCandidates([record], [], [], {})
    assert.equal(recommendAgent(candidate!, { hardware: null, task: 'code', tools: [], engineAvailable: false }).taskMatch, 'match')
  })

  it('agentes já salvos não mudam: os tipos só entram na criação', () => {
    const f = formFromDefinition(agentDraft({ id: 'revisor-codigo', taskTypes: [] }))
    assert.deepEqual(f.taskTypes, [])
  })
})

describe('Editor', () => {
  const EDITOR = readFileSync(join(import.meta.dirname, '../../src/renderer/src/components/agents/AgentEditor.tsx'), 'utf8')

  it('área avançada: recolhida por padrão, em elemento nativo que mantém os campos', () => {
    assert.match(EDITOR, /const \[advancedOpen, setAdvancedOpen\] = useState\(false\)/)
    assert.match(EDITOR, /<details className="advanced" open=\{advancedOpen \|\| tools\.status === 'error'\} onToggle/)
    assert.match(EDITOR, /<summary className="advanced__summary">/)
    assert.match(EDITOR, /\{advancedSummary\(form\)\}/)
    assert.match(EDITOR, /if \(hasAdvancedError\(found\)\) setAdvancedOpen\(true\)/)
  })

  it('básico antes do avançado; técnicos e ferramentas só na área avançada', () => {
    const advanced = EDITOR.indexOf('<details className="advanced"')
    for (const label of ['label="Nome"', 'label="Estado"', 'label="Descrição"', 'label="Instruções"', 'label="Modelo de IA"', 'Tipos de tarefa']) {
      const at = EDITOR.indexOf(label)
      assert.ok(at !== -1 && at < advanced, label)
    }
    for (const label of ['label="Temperatura"', 'label="Top P"', 'label="Semente"', 'label="Threads de CPU"', 'label="Uso da GPU"', 'label="Tempo limite (segundos)"', 'label="ID"', 'label="Versão"', 'title="Ferramentas"']) {
      assert.ok(!EDITOR.includes(label) || EDITOR.indexOf(label) > advanced, label)
    }
  })

  it('ferramentas: aviso sempre visível na área, sem prometer execução', () => {
    assert.match(EDITOR, /<Notice tone="info">\{TOOLS_PLANNED_NOTICE\}<\/Notice>/)
    assert.match(EDITOR, /'not-implemented': 'Ainda não executada'/)
    assert.doesNotMatch(EDITOR, /Capacidades que o agente poderá usar/)
  })

  it('ferramenta desconhecida: aviso, remoção explícita e nenhuma chave para ativá-la', () => {
    assert.match(EDITOR, /tools\.status === 'ready' \? unknownTools\(form\.tools, catalog\) : \[\]/)
    assert.match(EDITOR, /<Button onClick=\{\(\) => toggleTool\(id, false\)\}>Remover referência<\/Button>/)
    assert.match(EDITOR, /Será removida ao salvar/)
    assert.equal(EDITOR.match(/<SwitchRow/g)?.length, 1, 'chaves só para ferramentas do catálogo')
  })

  it('cada campo numérico mostra o próprio erro', () => {
    for (const key of ['temperature', 'topP', 'maxOutputTokens', 'contextLength', 'seed', 'cpuThreads', 'timeoutSeconds']) {
      assert.match(EDITOR, new RegExp(`set\\('${key}', e\\.target\\.value\\)`), key)
      assert.match(EDITOR, new RegExp(`<FieldError>\\{errors\\.${key}\\}</FieldError>`), key)
    }
  })
})

describe('Parâmetros com o Main real', () => {
  function bridge(services: Services) {
    const handlers = createDataHandlers(services)
    const call = async <T>(channel: keyof typeof handlers, ...args: unknown[]) => (await invokeHandler(channel, handlers[channel], args)) as Result<T>
    after(() => {
      services.conversations.dispose()
      services.runs.dispose()
    })
    return call
  }

  it('do formulário ao motor: salva, recarrega do disco e cada parâmetro chega à execução em Conversas', async () => {
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.2:3b')] }), 'POST /api/chat': stream([chunk('Olá'), final()]) })
    after(() => fake.close())
    const dir = await tempDir()
    const first = bridge(await createServices(dir, { stepDelayMs: 1, ollamaBaseUrl: fake.url }))
    const created = await first<AgentRecord>(IpcChannels.agentsCreate, agentDraft({ tools: [], defaultModel: { providerId: null, modelId: 'llama3.2:3b' } }))
    assert.ok(created.ok)
    const edited: AgentFormValues = {
      ...formFromDefinition(created.data.definition),
      temperature: '0.2',
      topP: '0.5',
      maxOutputTokens: '900',
      contextLength: '8192',
      seed: '42',
      cpuThreads: '6',
      gpuMode: 'cpu-only',
      timeoutSeconds: '120'
    }
    assert.ok((await first<AgentRecord>(IpcChannels.agentsUpdate, saved(edited))).ok)

    const services = await createServices(dir, { stepDelayMs: 1, ollamaBaseUrl: fake.url })
    const call = bridge(services)
    const listed = await call<AgentRecord[]>(IpcChannels.agentsList)
    assert.ok(listed.ok)
    assert.deepEqual(listed.data[0]!.definition.defaultProfile, CUSTOM)

    const providers = await call<ProviderOverview[]>(IpcChannels.providersList)
    assert.ok(providers.ok)
    const options = eligibleModels(providers.data)
    const request = sendRequestFrom({ agentId: listed.data[0]!.definition.id, modelKey: modelKey(options[0]!.ref), input: 'Olá' }, options, null)
    const sent = await call<{ conversation: Conversation; run: RunRecord }>(IpcChannels.conversationsSend, request)
    assert.ok(sent.ok)
    assert.equal(sent.data.run.execution?.profile.timeoutSeconds, 120, 'o RunService aplica este prazo')
    const deadline = Date.now() + 3_000
    while (services.runs.get(sent.data.run.id)?.state !== 'completed') {
      assert.ok(Date.now() < deadline, 'execução não terminou')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await settle()
    await services.conversations.whenSaved()

    const body = fake.chats[0] as { options: Record<string, number> }
    assert.deepEqual(body.options, { temperature: 0.2, top_p: 0.5, num_predict: 900, num_ctx: 8192, seed: 42, num_thread: 6, num_gpu: 0 })
  })

  it('ferramenta desconhecida: a recusa do Main chega ao formulário como orientação', async () => {
    const call = bridge(await createServices(await tempDir(), { stepDelayMs: 1 }))
    const created = await call<AgentRecord>(IpcChannels.agentsCreate, agentDraft({ tools: ['calculator'], requestedPermissions: ['process'] }))
    assert.ok(created.ok)
    const refused = await call<AgentRecord>(IpcChannels.agentsUpdate, agentDraft({ tools: ['calculator', 'fantasma'], requestedPermissions: ['process'] }))
    assert.ok(!refused.ok)
    assert.match(agentFormErrors(refused.error.issues!).tools!, /Remova a referência/)
  })

  it('o Main recusa o que passar pelo formulário, com erro levado ao campo', async () => {
    const call = bridge(await createServices(await tempDir(), { stepDelayMs: 1 }))
    const refused = await call<AgentRecord>(IpcChannels.agentsCreate, agentDraft({ tools: [], defaultProfile: { ...DEFAULT_EXECUTION_PROFILE, timeoutSeconds: 1 } }))
    assert.ok(!refused.ok)
    assert.match(agentFormErrors(refused.error.issues!).timeoutSeconds!, /10 a 3\.600 segundos/)
  })
})

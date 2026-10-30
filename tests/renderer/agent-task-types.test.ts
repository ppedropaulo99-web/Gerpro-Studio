import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { createServices, type Services } from '../../src/main/services'
import type { AgentRecord } from '../../src/shared/agents'
import type { Conversation } from '../../src/shared/conversations'
import type { Result } from '../../src/shared/errors'
import type { ProviderOverview } from '../../src/shared/inference'
import { IpcChannels } from '../../src/shared/ipc'
import type { RunRecord } from '../../src/shared/runs'
import { recommendAgent, TASK_LABELS, TASK_TYPES, type TaskType } from '../../src/shared/recommendations'
import { buildCandidates } from '../../src/renderer/src/lib/advisor'
import {
  agentFormChanged,
  agentFormErrors,
  draftFromForm,
  formFromDefinition,
  taskTypeOptions,
  taskTypesSummary,
  toggledTaskTypes
} from '../../src/renderer/src/lib/agent-form'
import { agentModelField, withModelChoice } from '../../src/renderer/src/lib/agent-model'
import { models as libraryModels } from '../../src/renderer/src/data/models'
import { chunk, fakeOllama, final, json, stream, tag } from '../support/fake-ollama'
import { agentDraft, settle, tempDir } from '../support/fixtures'

const form = (taskTypes: TaskType[]) => formFromDefinition(agentDraft({ taskTypes }))

/** Marca ou desmarca como o editor faz, a partir do formulário inicial. */
const toggle = (current: ReturnType<typeof form>, type: TaskType, selected: boolean, initial = current) => ({
  ...current,
  taskTypes: toggledTaskTypes(current.taskTypes, type, selected, initial.taskTypes)
})

const saved = (f: ReturnType<typeof form>) => {
  const result = draftFromForm(f, [{ definition: { id: 'calculator', permissions: [] } }] as never)
  assert.ok(result.ok)
  return result.draft
}

describe('Tipos de tarefa: opções', () => {
  it('oferece todos os tipos do contrato, com o rótulo das recomendações e na ordem de TASK_TYPES', () => {
    assert.deepEqual(taskTypeOptions.map((o) => o.value), [...TASK_TYPES])
    assert.deepEqual(taskTypeOptions.map((o) => o.label), [
      'Conversa e produtividade',
      'Programação',
      'Pesquisa',
      'Análise de dados',
      'Leitura de documentos',
      'Atendimento'
    ])
    for (const { value, label } of taskTypeOptions) assert.equal(label.toLowerCase(), TASK_LABELS[value])
  })

  it('resume a seleção em ordem canônica, sem identificadores internos', () => {
    assert.equal(taskTypesSummary([]), 'Nenhum tipo selecionado.')
    assert.equal(taskTypesSummary(['code']), 'Selecionados: Programação')
    assert.equal(taskTypesSummary(['support', 'chat']), 'Selecionados: Conversa e produtividade, Atendimento')
  })
})

describe('Tipos de tarefa: formulário', () => {
  it('agente sem tipos: continua vazio, opcional mesmo em "Pronto"', () => {
    const f = form([])
    assert.equal(f.state, 'ready')
    assert.deepEqual(f.taskTypes, [])
    assert.deepEqual(saved(f).taskTypes, [])
  })

  it('agente existente carrega um ou vários tipos e salva a lista como estava, mesmo fora da ordem canônica', () => {
    assert.deepEqual(saved(form(['code'])).taskTypes, ['code'])
    assert.deepEqual(saved(form(['support', 'chat', 'research'])).taskTypes, ['support', 'chat', 'research'])
  })

  it('incluir e remover atualizam a seleção, em ordem canônica', () => {
    const initial = form(['research'])
    const added = toggle(initial, 'chat', true)
    assert.deepEqual(added.taskTypes, ['chat', 'research'])
    assert.deepEqual(toggle(added, 'research', false, initial).taskTypes, ['chat'])
    assert.deepEqual(toggle(initial, 'research', false).taskTypes, [])
  })

  it('a ordem de marcação não muda o resultado', () => {
    const initial = form([])
    const a = toggle(toggle(initial, 'support', true), 'code', true, initial)
    const b = toggle(toggle(initial, 'code', true), 'support', true, initial)
    assert.deepEqual(a.taskTypes, ['code', 'support'])
    assert.deepEqual(a.taskTypes, b.taskTypes)
  })

  it('selecionar e desfazer restaura a lista original, inclusive a ordem gravada', () => {
    const initial = form(['support', 'chat'])
    const changed = toggle(initial, 'code', true)
    assert.deepEqual(changed.taskTypes, ['chat', 'code', 'support'])
    const back = toggle(changed, 'code', false, initial)
    assert.deepEqual(back.taskTypes, ['support', 'chat'])
    assert.equal(agentFormChanged(initial, back), false)

    const removed = toggle(initial, 'chat', false)
    assert.deepEqual(toggle(removed, 'chat', true, initial).taskTypes, ['support', 'chat'])
  })

  it('alterações pendentes: reais detectadas; a ordem sozinha não conta', () => {
    const initial = form(['chat', 'code'])
    assert.equal(agentFormChanged(initial, toggle(initial, 'data', true)), true)
    assert.equal(agentFormChanged(initial, toggle(initial, 'code', false)), true)
    assert.equal(agentFormChanged(initial, { ...initial, taskTypes: ['code', 'chat'] }), false)
  })

  it('nenhum outro campo muda ao alterar os tipos', () => {
    const initial = form(['chat'])
    const { taskTypes: _changed, ...rest } = toggle(initial, 'code', true)
    const { taskTypes: _before, ...expected } = initial
    assert.deepEqual(rest, expected)
    assert.deepEqual({ ...saved(toggle(initial, 'code', true)), taskTypes: [] }, { ...saved(initial), taskTypes: [] })
  })

  it('erro do contrato vai para o campo, sem caminho nem identificadores internos', () => {
    const errors = agentFormErrors([{ path: '$.taskTypes[0]', message: 'deve ser um de: chat, code' }])
    assert.equal(errors.taskTypes, 'Escolha apenas os tipos de tarefa da lista.')
    assert.equal(errors.form, undefined)
  })

  it('o seletor de modelos não é afetado, e a escolha de modelo mantém os tipos', () => {
    const initial = form(['support', 'chat'])
    const inventory = {
      status: 'ready' as const,
      data: [
        {
          info: { id: 'local', displayName: 'Motor local', kind: 'external' as const },
          status: { providerId: 'local', state: 'ready' as const, version: null, checkedAt: null, message: null },
          models: []
        }
      ] satisfies ProviderOverview[]
    }
    const changed = toggle(initial, 'code', true)
    const field = agentModelField(changed, inventory, initial)
    assert.equal(field.selectedKey, agentModelField(initial, inventory, initial).selectedKey)
    assert.equal(withModelChoice(changed, field.selectedKey, field), changed)
    assert.deepEqual(saved(changed).defaultModel, agentDraft().defaultModel)
  })
})

describe('Tipos de tarefa: editor', () => {
  const EDITOR = readFileSync(join(import.meta.dirname, '../../src/renderer/src/components/agents/AgentEditor.tsx'), 'utf8')

  it('botões nativos com estado acessível, agrupados e rotulados, sem identificadores na tela', () => {
    assert.match(EDITOR, /role="group" aria-labelledby=\{taskTypesLabel\}/)
    assert.match(EDITOR, /type="button"\s+className="task-chip"\s+aria-pressed=\{selected\}/)
    assert.match(EDITOR, /toggledTaskTypes\(form\.taskTypes, value, !selected, initial\.taskTypes\)/)
    assert.match(EDITOR, /taskTypesSummary\(form\.taskTypes\)/)
    assert.match(EDITOR, /<FieldError>\{errors\.taskTypes\}<\/FieldError>/)
  })

  it('o estado não depende só da cor', () => {
    assert.match(EDITOR, /selected \? <Check size=\{13\} aria-hidden \/> : <Plus size=\{13\} aria-hidden \/>/)
  })
})

describe('Tipos de tarefa com o Main real', () => {
  function bridge(services: Services) {
    const handlers = createDataHandlers(services)
    const call = async <T>(channel: keyof typeof handlers, ...args: unknown[]) => (await invokeHandler(channel, handlers[channel], args)) as Result<T>
    after(() => {
      services.conversations.dispose()
      services.runs.dispose()
    })
    return call
  }

  const taskMatchFor = (records: AgentRecord[], task: TaskType) => {
    const [candidate] = buildCandidates(records, [], libraryModels, {})
    return recommendAgent(candidate!, { hardware: null, task, tools: [], engineAvailable: false }).taskMatch
  }

  it('persiste, recarrega do disco e chega ao taskMatch', async () => {
    const dir = await tempDir()
    const call = bridge(await createServices(dir, { stepDelayMs: 1 }))
    const created = await call<AgentRecord>(IpcChannels.agentsCreate, agentDraft({ tools: [] }))
    assert.ok(created.ok)
    assert.equal(taskMatchFor([created.data], 'code'), 'unknown', 'sem tipos = não declarado')

    const initial = formFromDefinition(created.data.definition)
    const one = toggle(initial, 'code', true)
    const many = toggle(one, 'research', true, initial)
    const updated = await call<AgentRecord>(IpcChannels.agentsUpdate, saved(many))
    assert.ok(updated.ok)

    const reopened = bridge(await createServices(dir, { stepDelayMs: 1 }))
    const listed = await reopened<AgentRecord[]>(IpcChannels.agentsList)
    assert.ok(listed.ok)
    assert.deepEqual(listed.data[0]!.definition.taskTypes, ['code', 'research'])
    assert.equal(taskMatchFor(listed.data, 'code'), 'match')
    assert.equal(taskMatchFor(listed.data, 'research'), 'match')
    assert.equal(taskMatchFor(listed.data, 'support'), 'mismatch')

    const cleared = await reopened<AgentRecord>(IpcChannels.agentsUpdate, saved(formFromDefinition({ ...listed.data[0]!.definition, taskTypes: [] })))
    assert.ok(cleared.ok)
    assert.equal(taskMatchFor([cleared.data], 'code'), 'unknown', 'remover tudo volta a não declarado')
  })

  it('salvar sem alterar mantém a ordem gravada; arquivar também', async () => {
    const call = bridge(await createServices(await tempDir(), { stepDelayMs: 1 }))
    const created = await call<AgentRecord>(IpcChannels.agentsCreate, agentDraft({ tools: [], taskTypes: ['support', 'chat'] }))
    assert.ok(created.ok)
    const again = await call<AgentRecord>(IpcChannels.agentsUpdate, saved(formFromDefinition(created.data.definition)))
    assert.ok(again.ok)
    assert.deepEqual(again.data.definition.taskTypes, ['support', 'chat'])
    const { createdAt: _c, updatedAt: _u, ...draft } = again.data.definition
    const archived = await call<AgentRecord>(IpcChannels.agentsUpdate, { ...draft, state: 'archived' })
    assert.ok(archived.ok)
    assert.deepEqual(archived.data.definition.taskTypes, ['support', 'chat'])
  })

  it('agente com tipos conversa normalmente, e os tipos não vão para o modelo', async () => {
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.2:3b')] }), 'POST /api/chat': stream([chunk('Olá'), final()]) })
    after(() => fake.close())
    const services = await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: fake.url })
    const call = bridge(services)
    await call(IpcChannels.agentsCreate, agentDraft({ tools: [], taskTypes: ['support', 'chat'], defaultModel: { providerId: null, modelId: 'llama3.2:3b' } }))
    const sent = await call<{ conversation: Conversation; run: RunRecord }>(IpcChannels.conversationsSend, {
      conversationId: null,
      agentId: 'assistente-geral',
      model: { providerId: 'ollama', modelId: 'llama3.2:3b' },
      input: 'Olá'
    })
    assert.ok(sent.ok)
    const deadline = Date.now() + 3_000
    while (services.runs.get(sent.data.run.id)?.state !== 'completed') {
      assert.ok(Date.now() < deadline, 'execução não terminou')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await settle()
    await services.conversations.whenSaved()
    assert.doesNotMatch(JSON.stringify(fake.chats[0]), /taskTypes|support/)
  })
})

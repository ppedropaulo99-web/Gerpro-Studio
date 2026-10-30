import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { SIMULATED_PROVIDER_ID } from '../../src/main/runs/simulated-provider'
import { createServices, type Services } from '../../src/main/services'
import type { AgentDraft, AgentRecord } from '../../src/shared/agents'
import type { Result, StructuredError } from '../../src/shared/errors'
import type { ModelCapability, ModelRef, ProviderOverview, ProviderState } from '../../src/shared/inference'
import { IpcChannels } from '../../src/shared/ipc'
import type { ToolCatalogEntry } from '../../src/shared/tools'
import { agents as exampleAgents } from '../../src/renderer/src/data/agents'
import { agentFormChanged, draftFromForm, emptyAgentForm, formFromDefinition, formFromExample, formModelRef } from '../../src/renderer/src/lib/agent-form'
import { agentModelField, CONFIGURED_MODEL_KEY, NO_MODEL_KEY, ORIGINAL_MODEL_KEY, withModelChoice, type AgentModelField } from '../../src/renderer/src/lib/agent-model'
import { modelKey } from '../../src/renderer/src/lib/real-runs'
import type { Resource } from '../../src/renderer/src/lib/use-resource'
import { closedUrl, fakeOllama, json, tag } from '../support/fake-ollama'
import { agentDraft, tempDir } from '../support/fixtures'

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

const provider = (id: string, state: ProviderState, models: ReturnType<typeof entry>[] | null, kind: 'external' | 'simulated' = 'external'): ProviderOverview => ({
  info: { id, displayName: id === 'local' ? 'Motor local' : `Motor ${id}`, kind },
  status: { providerId: id, state, version: null, checkedAt: null, message: null },
  models
})

const ready = (...providers: ProviderOverview[]): Resource<ProviderOverview[]> => ({ status: 'ready', data: providers })
const LOADING: Resource<ProviderOverview[]> = { status: 'loading' }
const FAILED: Resource<ProviderOverview[]> = { status: 'error', error: { code: 'internal', message: 'falhou', retryable: true } as StructuredError }
const models = (...ids: string[]) => provider('local', 'ready', ids.map((id) => entry('local', id)))

/** Formulário de um agente salvo com `defaultModel`. */
const saved = (defaultModel: ModelRef | null) => formFromDefinition(agentDraft({ defaultModel }))
const LEGACY: ModelRef = { providerId: null, modelId: 'llama3.1:8b' }
const BOUND: ModelRef = { providerId: 'local', modelId: 'llama3.1:8b' }
const CATALOG: ToolCatalogEntry[] = []

const keys = (field: AgentModelField) => field.choices.map((c) => c.key)
const labels = (field: AgentModelField) => field.choices.map((c) => c.label)
const assertSaves = (form: ReturnType<typeof saved>, expected: ModelRef | null) => {
  const result = draftFromForm(form, CATALOG)
  assert.ok(result.ok)
  assert.deepEqual(result.draft.defaultModel, expected)
}

describe('Campo de modelo do agente: inventário', () => {
  it('carregando: nada é afirmado e o modelo configurado continua selecionado', () => {
    const field = agentModelField(saved(LEGACY), LOADING)
    assert.equal(field.inventory, 'loading')
    assert.equal(field.configured, 'unverified')
    assert.equal(field.selectedKey, CONFIGURED_MODEL_KEY)
    assert.deepEqual(labels(field), ['Nenhum modelo selecionado', 'Llama 3.1 (8B)'])
    assert.equal(field.notice, null)
    assert.equal(field.problem, null)
  })

  it('falha na consulta: o modelo fica como não verificado, nunca como removido', () => {
    const field = agentModelField(saved(LEGACY), FAILED)
    assert.equal(field.inventory, 'failed')
    assert.equal(field.configured, 'unverified')
    assert.equal(field.choices[1]!.label, 'Llama 3.1 (8B) — não verificado')
    assert.match(field.notice!.text, /Não foi possível verificar.*continua salvo/)
  })

  it('sem modelo configurado e sem inventário: nada selecionado', () => {
    for (const resource of [LOADING, FAILED]) {
      const field = agentModelField(emptyAgentForm(), resource)
      assert.equal(field.configured, 'none')
      assert.equal(field.selectedKey, NO_MODEL_KEY)
      assert.deepEqual(keys(field), [NO_MODEL_KEY])
    }
  })

  it('provedor inacessível, consultado e vazio e sem provedor são estados diferentes', () => {
    assert.equal(agentModelField(emptyAgentForm(), ready(provider('local', 'unreachable', null))).inventory, 'unavailable')
    assert.equal(agentModelField(emptyAgentForm(), ready(provider('local', 'ready', []))).inventory, 'empty')
    assert.equal(agentModelField(emptyAgentForm(), ready(provider(SIMULATED_PROVIDER_ID, 'ready', [entry(SIMULATED_PROVIDER_ID, 'x')], 'simulated'))).inventory, 'no-provider')
    assert.match(agentModelField(emptyAgentForm(), ready(provider('local', 'unreachable', null))).problem!.text, /não está respondendo/)
    assert.match(agentModelField(emptyAgentForm(), ready(provider('local', 'ready', []))).problem!.text, /não há modelos de conversa/)
  })

  it('provedor pronto sem lista conta como não consultado, não como vazio', () => {
    const field = agentModelField(saved(LEGACY), ready(provider('local', 'ready', null)))
    assert.equal(field.inventory, 'unavailable')
    assert.equal(field.configured, 'unverified')
    assert.match(field.problem!.text, /Não foi possível consultar/)
    assert.doesNotMatch(field.problem!.text, /não há modelos/)
  })

  it('só modelos sem conversa instalados: estado próprio e nenhuma opção', () => {
    const field = agentModelField(emptyAgentForm(), ready(provider('local', 'ready', [entry('local', 'embed', ['embedding'])])))
    assert.equal(field.inventory, 'no-chat-models')
    assert.deepEqual(keys(field), [NO_MODEL_KEY])
  })

  it('o provedor simulado nunca vira opção nem confirma um modelo', () => {
    const simulated = provider(SIMULATED_PROVIDER_ID, 'ready', [entry(SIMULATED_PROVIDER_ID, 'llama3.1:8b')], 'simulated')
    const field = agentModelField(saved(LEGACY), ready(simulated, provider('local', 'ready', [])))
    assert.equal(field.configured, 'missing')
    assert.ok(field.choices.every((c) => c.ref?.providerId !== SIMULATED_PROVIDER_ID))
  })
})

describe('Campo de modelo do agente: modelo configurado', () => {
  it('um modelo instalado NÃO é selecionado sozinho', () => {
    const field = agentModelField(emptyAgentForm(), ready(models('llama3.2:3b')))
    assert.equal(field.inventory, 'ready')
    assert.equal(field.configured, 'none')
    assert.equal(field.selectedKey, NO_MODEL_KEY)
    assert.equal(field.notice, null)
  })

  it('vários modelos: nome amigável, identificador exato e ordem estável', () => {
    const field = agentModelField(emptyAgentForm(), ready(models('qwen3:8b', 'llama3.2:3b')))
    assert.deepEqual(field.choices.slice(1).map((c) => [c.label, c.ref?.modelId]), [
      ['Qwen 3 (8B)', 'qwen3:8b'],
      ['Llama 3.2 (3B)', 'llama3.2:3b']
    ])
    assert.deepEqual(field, agentModelField(emptyAgentForm(), ready(models('qwen3:8b', 'llama3.2:3b'))), 'mesma entrada, mesmo resultado')
  })

  it('agente com provedor definido e modelo instalado', () => {
    const field = agentModelField(saved(BOUND), ready(models('llama3.1:8b', 'qwen3:8b')))
    assert.equal(field.configured, 'installed')
    assert.equal(field.unbound, false)
    assert.equal(field.selectedKey, modelKey({ providerId: 'local', modelId: 'llama3.1:8b' }))
    assert.ok(!keys(field).includes(CONFIGURED_MODEL_KEY))
  })

  it('agente antigo com providerId null: reconhecido sem ser vinculado', () => {
    const form = saved(LEGACY)
    const field = agentModelField(form, ready(models('llama3.1:8b')))
    assert.equal(field.configured, 'installed')
    assert.equal(field.unbound, true)
    assert.equal(field.selectedKey, modelKey({ providerId: 'local', modelId: 'llama3.1:8b' }))
    assert.deepEqual(formModelRef(form), LEGACY)
  })

  it('modelo removido: só é "não instalado" se o provedor respondeu, e nenhum outro o substitui', () => {
    const field = agentModelField(saved(LEGACY), ready(models('qwen3:8b')))
    assert.equal(field.configured, 'missing')
    assert.equal(field.selectedKey, CONFIGURED_MODEL_KEY)
    assert.equal(field.choices[1]!.label, 'Llama 3.1 (8B) — não instalado')
    assert.deepEqual(field.choices[1]!.ref, LEGACY)
    assert.match(field.notice!.text, /"llama3\.1:8b" não está instalado.*continua salvo/)
  })

  it('Ollama desligado: modelo não verificado e configuração mantida', () => {
    const field = agentModelField(saved(BOUND), ready(provider('local', 'unreachable', null)))
    assert.equal(field.inventory, 'unavailable')
    assert.equal(field.configured, 'unverified')
    assert.equal(field.selectedKey, CONFIGURED_MODEL_KEY)
    assert.deepEqual(field.choices[1]!.ref, BOUND)
  })

  it('modelo instalado sem capacidade de conversa não é confundido com ausente', () => {
    const field = agentModelField(saved({ providerId: null, modelId: 'embed' }), ready(provider('local', 'ready', [entry('local', 'embed', ['embedding']), entry('local', 'a:1b')])))
    assert.equal(field.configured, 'incompatible')
    assert.equal(field.selectedKey, CONFIGURED_MODEL_KEY)
    assert.match(field.choices[1]!.label, /não disponível para conversa/)
  })

  it('capacidades desconhecidas não excluem o modelo, como em Conversas', () => {
    const field = agentModelField(saved(LEGACY), ready(provider('local', 'ready', [entry('local', 'llama3.1:8b', [])])))
    assert.equal(field.configured, 'installed')
  })

  it('correspondência ambígua: sem provedor vinculado, nenhum é escolhido', () => {
    const field = agentModelField(saved(LEGACY), ready(models('llama3.1:8b'), provider('b', 'ready', [entry('b', 'llama3.1:8b')])))
    assert.equal(field.configured, 'ambiguous')
    assert.equal(field.selectedKey, CONFIGURED_MODEL_KEY)
    assert.deepEqual(field.choices[1]!.ref, LEGACY)
    assert.deepEqual(field.choices.slice(2).map((c) => c.label), ['Llama 3.1 (8B) · Motor local', 'Llama 3.1 (8B) · Motor b'])
  })

  it('com provedor vinculado, a ambiguidade não existe e outro provedor não o substitui', () => {
    const both = ready(models('llama3.1:8b'), provider('b', 'ready', [entry('b', 'llama3.1:8b')]))
    assert.equal(agentModelField(saved(BOUND), both).selectedKey, modelKey({ providerId: 'local', modelId: 'llama3.1:8b' }))

    const onlyOther = ready(models('qwen3:8b'), provider('b', 'ready', [entry('b', 'llama3.1:8b')]))
    assert.equal(agentModelField(saved(BOUND), onlyOther).configured, 'missing')

    const down = ready(provider('local', 'unreachable', null), provider('b', 'ready', [entry('b', 'llama3.1:8b')]))
    assert.equal(agentModelField(saved(BOUND), down).configured, 'unverified', 'não verificado no provedor vinculado')
  })

  it('sem vínculo e com um provedor sem responder: ausência não é confirmada', () => {
    const partial = ready(models('qwen3:8b'), provider('b', 'unreachable', null))
    assert.equal(agentModelField(saved(LEGACY), partial).configured, 'unverified')
    assert.equal(agentModelField(saved(LEGACY), ready(models('llama3.1:8b'), provider('b', 'unreachable', null))).configured, 'installed')
  })

  it('provedor vinculado que não está mais registrado: não verificado', () => {
    assert.equal(agentModelField(saved({ providerId: 'antigo', modelId: 'x' }), ready(models('x'))).configured, 'unverified')
  })
})

describe('Campo de modelo do agente: preservação e escolha explícita', () => {
  const resources: Array<[string, Resource<ProviderOverview[]>]> = [
    ['carregando', LOADING],
    ['falha', FAILED],
    ['desligado', ready(provider('local', 'unreachable', null))],
    ['sem modelos', ready(provider('local', 'ready', []))],
    ['modelo removido', ready(models('qwen3:8b'))],
    ['modelo instalado', ready(models('llama3.1:8b'))]
  ]

  for (const [name, resource] of resources) {
    it(`abrir e salvar sem alterar mantém o agente (${name})`, () => {
      for (const ref of [LEGACY, BOUND]) {
        const form = saved(ref)
        const field = agentModelField(form, resource)
        const after = withModelChoice(form, field.selectedKey, field)
        assert.equal(after, form, 'manter a seleção não altera o formulário')
        assertSaves(after, ref)
      }
    })
  }

  it('escolha explícita de outro modelo registra identificador e provedor', () => {
    const form = saved(LEGACY)
    const field = agentModelField(form, ready(models('llama3.1:8b', 'qwen3:8b')))
    const chosen = withModelChoice(form, modelKey({ providerId: 'local', modelId: 'qwen3:8b' }), field)
    assert.equal(chosen.modelId, 'qwen3:8b')
    assertSaves(chosen, { providerId: 'local', modelId: 'qwen3:8b' })
    assert.equal(agentFormChanged(form, chosen), true)
  })

  it('escolher em uma lista ambígua vincula o provedor escolhido', () => {
    const form = saved(LEGACY)
    const field = agentModelField(form, ready(models('llama3.1:8b'), provider('b', 'ready', [entry('b', 'llama3.1:8b')])))
    assertSaves(withModelChoice(form, modelKey({ providerId: 'b', modelId: 'llama3.1:8b' }), field), { providerId: 'b', modelId: 'llama3.1:8b' })
  })

  it('modelo ausente: escolher a opção dele mantém tudo; trocar exige outra escolha', () => {
    const form = saved(BOUND)
    const field = agentModelField(form, ready(models('qwen3:8b')))
    assert.equal(withModelChoice(form, CONFIGURED_MODEL_KEY, field), form)
    assertSaves(withModelChoice(form, modelKey({ providerId: 'local', modelId: 'qwen3:8b' }), field), { providerId: 'local', modelId: 'qwen3:8b' })
  })

  it('"nenhum modelo" só limpa por escolha explícita', () => {
    const form = { ...saved(BOUND), state: 'draft' as const }
    const cleared = withModelChoice(form, NO_MODEL_KEY, agentModelField(form, ready(models('llama3.1:8b'))))
    assert.equal(cleared.modelId, '')
    assertSaves(cleared, null)
    assert.equal(draftFromForm({ ...cleared, state: 'ready' }, CATALOG).ok, false, 'agente pronto continua exigindo modelo')
  })

  it('chave fora da lista não altera o formulário', () => {
    const form = saved(LEGACY)
    assert.equal(withModelChoice(form, 'local\u0000sumiu', agentModelField(form, ready(models('llama3.1:8b')))), form)
  })

  it('atualizar o inventário não altera o formulário', () => {
    const form = saved(LEGACY)
    const before = JSON.stringify(form)
    const states = resources.map(([, resource]) => agentModelField(form, resource).configured)
    assert.deepEqual(states, ['unverified', 'unverified', 'unverified', 'missing', 'missing', 'installed'])
    assert.equal(JSON.stringify(form), before)
    assert.equal(agentFormChanged(saved(LEGACY), form), false)
  })

  it('voltar ao modelo original restaura providerId null, sem vincular e sem alteração pendente', () => {
    const initial = saved(LEGACY)
    const inventory = ready(models('llama3.1:8b', 'qwen3:8b'))
    const other = withModelChoice(initial, modelKey({ providerId: 'local', modelId: 'qwen3:8b' }), agentModelField(initial, inventory, initial))
    assertSaves(other, { providerId: 'local', modelId: 'qwen3:8b' })

    const field = agentModelField(other, inventory, initial)
    const back = withModelChoice(other, modelKey({ providerId: 'local', modelId: 'llama3.1:8b' }), field)
    assertSaves(back, LEGACY)
    assert.equal(agentFormChanged(initial, back), false)
  })

  it('voltar ao original também restaura um provedor vinculado', () => {
    const initial = saved(BOUND)
    const inventory = ready(models('llama3.1:8b', 'qwen3:8b'))
    const other = withModelChoice(initial, modelKey({ providerId: 'local', modelId: 'qwen3:8b' }), agentModelField(initial, inventory, initial))
    const back = withModelChoice(other, modelKey(BOUND as { providerId: string; modelId: string }), agentModelField(other, inventory, initial))
    assertSaves(back, BOUND)
    assert.equal(agentFormChanged(initial, back), false)
  })

  it('modelo original fora da lista continua disponível para voltar depois de outra escolha', () => {
    for (const [resource, state, suffix] of [
      [ready(models('qwen3:8b')), 'missing', 'não instalado'],
      [ready(provider('local', 'ready', [entry('local', 'llama3.1:8b', ['embedding']), entry('local', 'qwen3:8b')])), 'incompatible', 'não disponível para conversa']
    ] as const) {
      const initial = saved(LEGACY)
      assert.equal(agentModelField(initial, resource, initial).configured, state)
      const other = withModelChoice(initial, modelKey({ providerId: 'local', modelId: 'qwen3:8b' }), agentModelField(initial, resource, initial))
      const field = agentModelField(other, resource, initial)
      const original = field.choices.find((c) => c.kind === 'original')!
      assert.equal(original.key, ORIGINAL_MODEL_KEY)
      assert.equal(original.label, `Llama 3.1 (8B) — ${suffix}`)
      assert.equal(agentFormChanged(initial, withModelChoice(other, original.key, field)), false)
    }
  })

  it('o original fica como opção durante a atualização da lista, e o formulário não muda', () => {
    const initial = saved(LEGACY)
    const other = withModelChoice(initial, modelKey({ providerId: 'local', modelId: 'qwen3:8b' }), agentModelField(initial, ready(models('llama3.1:8b', 'qwen3:8b')), initial))
    const before = JSON.stringify(other)
    for (const resource of [LOADING, FAILED, ready(provider('local', 'unreachable', null))]) {
      const field = agentModelField(other, resource, initial)
      assert.equal(field.identifier, 'qwen3:8b')
      assert.deepEqual(field.choices.map((c) => c.kind), ['none', 'configured', 'original'])
      assert.equal(agentFormChanged(initial, withModelChoice(other, ORIGINAL_MODEL_KEY, field)), false)
    }
    assert.equal(JSON.stringify(other), before)
  })

  it('em lista ambígua, escolher um provedor vincula: não é restauração do original sem vínculo', () => {
    const initial = saved(LEGACY)
    const inventory = ready(models('llama3.1:8b', 'qwen3:8b'), provider('b', 'ready', [entry('b', 'llama3.1:8b')]))
    const field = agentModelField(initial, inventory, initial)
    assertSaves(withModelChoice(initial, modelKey({ providerId: 'local', modelId: 'llama3.1:8b' }), field), BOUND)

    const other = withModelChoice(initial, modelKey({ providerId: 'local', modelId: 'qwen3:8b' }), field)
    const back = agentModelField(other, inventory, initial)
    assert.deepEqual(back.choices.find((c) => c.kind === 'original')?.ref, LEGACY)
    assertSaves(withModelChoice(other, ORIGINAL_MODEL_KEY, back), LEGACY)
  })

  it('agente novo não tem original a restaurar: "nenhum modelo" volta ao estado de partida', () => {
    const initial = emptyAgentForm()
    const inventory = ready(models('qwen3:8b'))
    const chosen = withModelChoice(initial, modelKey({ providerId: 'local', modelId: 'qwen3:8b' }), agentModelField(initial, inventory, initial))
    const field = agentModelField(chosen, inventory, initial)
    assert.equal(field.restore, null)
    assert.equal(agentFormChanged(initial, withModelChoice(chosen, NO_MODEL_KEY, field)), false)
  })

  it('identificador técnico acompanha o modelo selecionado, instalado ou não', () => {
    assert.equal(agentModelField(emptyAgentForm(), ready(models('a:1b'))).identifier, null)
    assert.equal(agentModelField(saved(LEGACY), ready(models('llama3.1:8b'))).identifier, 'llama3.1:8b')
    assert.equal(agentModelField(saved(LEGACY), ready(provider('local', 'unreachable', null))).identifier, 'llama3.1:8b')
  })

  it('falha na consulta explica o problema; carregando não afirma nada', () => {
    assert.equal(agentModelField(emptyAgentForm(), FAILED).problem?.tone, 'danger')
    assert.match(agentModelField(emptyAgentForm(), FAILED).problem!.text, /Atualizar lista/)
    assert.equal(agentModelField(emptyAgentForm(), LOADING).problem, null)
  })

  it('não instalado, não verificado, incompatível e provedor indisponível têm textos diferentes', () => {
    const texts = [
      agentModelField(saved(LEGACY), ready(models('qwen3:8b'))).choices[1]!.label,
      agentModelField(saved(LEGACY), FAILED).choices[1]!.label,
      agentModelField(saved(LEGACY), ready(provider('local', 'ready', [entry('local', 'llama3.1:8b', ['embedding'])]))).choices[1]!.label
    ]
    assert.deepEqual(texts, ['Llama 3.1 (8B) — não instalado', 'Llama 3.1 (8B) — não verificado', 'Llama 3.1 (8B) — não disponível para conversa'])
    assert.doesNotMatch(agentModelField(saved(LEGACY), ready(provider('local', 'unreachable', null))).notice!.text, /não está instalado/)
  })

  it('a chave do modelo configurado não colide com a de um modelo instalado', () => {
    const field = agentModelField(saved({ providerId: null, modelId: 'configured' }), ready(models('outro:1b')))
    assert.equal(field.configured, 'missing')
    assert.equal(new Set(keys(field)).size, field.choices.length)
  })
})

describe('Agentes criados a partir de exemplos', () => {
  it('nenhum exemplo copia modelo fictício: rascunho sem modelo, com nome, descrição e ferramentas', () => {
    const catalog = exampleAgents.flatMap((a) => a.tools).map((id) => ({ definition: { id, permissions: [] } })) as unknown as ToolCatalogEntry[]
    for (const example of exampleAgents) {
      const form = formFromExample(example, new Set(), catalog)
      assert.equal(form.modelId, '')
      assert.equal(form.boundModel, null)
      assert.equal(form.state, 'draft')
      assert.equal(form.name, example.name)
      assert.equal(form.description, example.description)
      assert.deepEqual(form.tools, example.tools)
      const draft = draftFromForm(form, catalog)
      assert.ok(draft.ok)
      assert.equal(draft.draft.defaultModel, null)
      assert.equal(agentModelField(form, ready(models('llama3.2:3b'))).selectedKey, NO_MODEL_KEY, 'nada é pré-selecionado')
    }
  })

  it('exemplo pronto continua exigindo modelo até o usuário escolher um instalado', () => {
    const form = { ...formFromExample(exampleAgents[0]!, new Set(), []), instructions: 'Seja objetivo.', state: 'ready' as const }
    const refused = draftFromForm(form, [])
    assert.ok(!refused.ok)
    assert.match(refused.errors.modelId!, /obrigatório/)
    const field = agentModelField(form, ready(models('llama3.2:3b')))
    assertSaves(withModelChoice(form, field.choices[1]!.key, field), { providerId: 'local', modelId: 'llama3.2:3b' })
  })
})

describe('Editor de agentes: seletor de modelo', () => {
  const EDITOR = readFileSync(join(import.meta.dirname, '../../src/renderer/src/components/agents/AgentEditor.tsx'), 'utf8')

  it('consome a lógica do campo e o inventário do Main, sem descoberta própria', () => {
    assert.match(EDITOR, /window\.gerpro\.providers\.list\(\)/)
    assert.match(EDITOR, /agentModelField\(form, providers\.state, initial\)/)
    assert.match(EDITOR, /withModelChoice\(form, key, model\)/)
    assert.doesNotMatch(EDITOR, /eligibleModels|matchesModelRef|runs\.start|conversations\.send/)
  })

  it('o identificador não é mais digitado; a escolha só vem do seletor', () => {
    assert.doesNotMatch(EDITOR, /set\('modelId'|set\('boundModel'|ID do modelo|aurora-8b/)
    assert.match(EDITOR, /value=\{model\.selectedKey\}/)
    assert.match(EDITOR, /onChange=\{\(e\) => chooseModel\(e\.target\.value\)\}/)
  })

  it('mostra identificador, carregamento, problemas, avisos e "Atualizar lista"', () => {
    assert.match(EDITOR, /Identificador: <span className="mono">\{model\.identifier\}<\/span>/)
    assert.match(EDITOR, /Consultando os modelos instalados/)
    assert.match(EDITOR, /model\.problem && <Notice tone=\{model\.problem\.tone\}>/)
    assert.match(EDITOR, /model\.notice && <Notice tone=\{model\.notice\.tone\}>/)
    assert.match(EDITOR, /onClick=\{providers\.reload\}>\s*Atualizar lista/)
  })

  it('salvar não depende do inventário', () => {
    const button = EDITOR.slice(EDITOR.indexOf('variant="primary"'))
    assert.doesNotMatch(button, /providers|model\.|modelsLoading/)
    assert.doesNotMatch(EDITOR.slice(EDITOR.indexOf('async function save'), EDITOR.indexOf('const stateOptions')), /providers|model\./)
  })
})

describe('Campo de modelo do agente com o Main real', () => {
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

  it('Ollama desligado: agente antigo é aberto e salvo sem nenhuma mudança no modelo', async () => {
    const call = bridge(await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: await closedUrl() }))
    const created = await call<AgentRecord>(IpcChannels.agentsCreate, agentDraft({ defaultModel: LEGACY }))
    assert.ok(created.ok)

    const form = formFromDefinition(created.data.definition)
    const field = agentModelField(form, resource(await call<ProviderOverview[]>(IpcChannels.providersList)))
    assert.equal(field.inventory, 'unavailable')
    assert.equal(field.configured, 'unverified')

    const draft = draftFromForm(withModelChoice(form, field.selectedKey, field), CATALOG)
    assert.ok(draft.ok)
    const updated = await call<AgentRecord>(IpcChannels.agentsUpdate, draft.draft satisfies AgentDraft)
    assert.ok(updated.ok)
    assert.deepEqual(updated.data.definition.defaultModel, LEGACY)
  })

  it('Ollama desligado: rascunho novo salva sem modelo e agente pronto continua exigindo modelo', async () => {
    const call = bridge(await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: await closedUrl() }))
    const form = { ...emptyAgentForm(), id: 'rascunho', name: 'Rascunho', instructions: 'Seja objetivo.' }
    const draft = draftFromForm(form, CATALOG)
    assert.ok(draft.ok)
    const created = await call<AgentRecord>(IpcChannels.agentsCreate, draft.draft)
    assert.ok(created.ok)
    assert.equal(created.data.definition.defaultModel, null)

    assert.equal(draftFromForm({ ...form, state: 'ready' }, CATALOG).ok, false)
    const refused = await call<AgentRecord>(IpcChannels.agentsUpdate, { ...draft.draft, state: 'ready' })
    assert.ok(!refused.ok)
  })

  it('atualizar a lista depois de instalar e remover modelos muda o campo, nunca o formulário', async () => {
    const tags = (...names: string[]) => json({ models: names.map((name) => tag(name)) })
    const fake = await fakeOllama({ 'GET /api/tags': tags('qwen3:8b') })
    after(() => fake.close())
    const call = bridge(await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: fake.url }))
    const form = saved(LEGACY)
    const before = JSON.stringify(form)
    const field = async () => agentModelField(form, resource(await call<ProviderOverview[]>(IpcChannels.providersList)), form)

    assert.equal((await field()).configured, 'missing')
    fake.routes.set('GET /api/tags', tags('qwen3:8b', 'llama3.1:8b'))
    const installed = await field()
    assert.equal(installed.configured, 'installed')
    assert.deepEqual(installed.choices.map((c) => c.label), ['Nenhum modelo selecionado', 'Qwen 3 (8B)', 'Llama 3.1 (8B)'])
    fake.routes.set('GET /api/tags', tags())
    const removed = await field()
    assert.equal(removed.inventory, 'empty')
    assert.equal(removed.configured, 'missing')
    assert.equal(JSON.stringify(form), before)
  })

  it('Ollama real falso: lista, modelo sem conversa e escolha explícita chegam ao disco com o provedor', async () => {
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.1:8b'), tag('qwen3:8b'), tag('embed:1b', { capabilities: ['embedding'] })] }) })
    after(() => fake.close())
    const call = bridge(await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: fake.url }))
    const created = await call<AgentRecord>(IpcChannels.agentsCreate, agentDraft({ defaultModel: LEGACY }))
    assert.ok(created.ok)

    const form = formFromDefinition(created.data.definition)
    const field = agentModelField(form, resource(await call<ProviderOverview[]>(IpcChannels.providersList)))
    assert.equal(field.configured, 'installed')
    assert.deepEqual(field.choices.map((c) => c.label), ['Nenhum modelo selecionado', 'Llama 3.1 (8B)', 'Qwen 3 (8B)'])

    const incompatible = agentModelField(saved({ providerId: null, modelId: 'embed:1b' }), resource(await call<ProviderOverview[]>(IpcChannels.providersList)))
    assert.equal(incompatible.configured, 'incompatible')

    const chosen = field.choices.find((c) => c.ref?.modelId === 'qwen3:8b')!
    const draft = draftFromForm(withModelChoice(form, chosen.key, field), CATALOG)
    assert.ok(draft.ok)
    const updated = await call<AgentRecord>(IpcChannels.agentsUpdate, draft.draft)
    assert.ok(updated.ok)
    assert.deepEqual(updated.data.definition.defaultModel, { providerId: 'ollama', modelId: 'qwen3:8b' })
  })
})

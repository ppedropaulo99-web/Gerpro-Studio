import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { OllamaInferenceProvider } from '../../src/main/engine/ollama/ollama-provider'
import { RunService } from '../../src/main/runs/run-service'
import { SimulatedInferenceProvider, SIMULATED_PROVIDER_ID } from '../../src/main/runs/simulated-provider'
import { createServices } from '../../src/main/services'
import type { AgentDefinition } from '../../src/shared/agents'
import type { Result, StructuredError } from '../../src/shared/errors'
import { DEFAULT_EXECUTION_PROFILE } from '../../src/shared/execution'
import { INFERENCE_ERROR_CODES, type InferenceMetrics, type ModelCapability, type ProviderOverview, type ProviderState } from '../../src/shared/inference'
import { IpcChannels } from '../../src/shared/ipc'
import { RUN_INPUT_MAX, RUN_LIMITS, type RunRecord } from '../../src/shared/runs'
import type { Conversation, ConversationList, ConversationMessage } from '../../src/shared/conversations'
import {
  completedWithWarning,
  defaultModelKey,
  eligibleModels,
  friendlyError,
  friendlyModelName,
  inventoryProblem,
  metricRows,
  modelKey,
  queuePosition,
  runDraftErrors,
  runStatusView,
  sendRequestFrom
} from '../../src/renderer/src/lib/real-runs'
import {
  contextLabel,
  interruptedNotice,
  messageError,
  newerConversation,
  removeSummary,
  saveIndicator,
  saveStateOf,
  threadItems,
  upsertSummary,
  watchConversations,
  type ConversationListState
} from '../../src/renderer/src/lib/conversations'
import { requestModelFor, requestRunDetails, requestRunFor, takeRequestedAgent, takeRequestedModel, takeRequestedRun } from '../../src/renderer/src/lib/run-intent'
import { rememberInput, sentInputOf } from '../../src/renderer/src/lib/sent-inputs'
import { watchRuns, type SessionRunsState } from '../../src/renderer/src/lib/session-runs'
import { chunk, closedUrl, fakeOllama, final, json, stream, tag, wait } from '../support/fake-ollama'
import { agentDraft, tempDir, VirtualScheduler } from '../support/fixtures'

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------

const entry = (providerId: string, modelId: string, o: { location?: 'local' | 'remote'; capabilities?: ModelCapability[]; availability?: 'installed' | 'not-installed' } = {}) => ({
  availability: o.availability ?? ('installed' as const),
  model: {
    ref: { providerId, modelId },
    digest: null,
    location: o.location ?? ('local' as const),
    displayName: modelId,
    family: null,
    parameterSize: null,
    quantization: null,
    format: null,
    sizeBytes: null,
    contextLength: null,
    contextBytesPerToken: null,
    capabilities: o.capabilities ?? (['chat'] as ModelCapability[])
  }
})

const provider = (
  id: string,
  kind: 'external' | 'simulated',
  state: ProviderState,
  models: ReturnType<typeof entry>[] | null,
  displayName = id === 'local' ? 'Motor local' : id
): ProviderOverview => ({
  info: { id, displayName, kind },
  status: { providerId: id, state, version: null, checkedAt: null, message: null },
  models
})

const run = (o: Partial<RunRecord> & { id: string }): RunRecord =>
  ({
    agentId: 'assistente-geral',
    origin: 'real',
    execution: { model: { providerId: 'local', modelId: 'llama3.2:3b' }, profile: DEFAULT_EXECUTION_PROFILE, overridden: { model: true, profile: false } },
    state: 'pending',
    createdAt: '2026-10-26T12:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    progress: { percent: null, step: null },
    messages: [],
    error: null,
    cancelRequested: false,
    revision: 0,
    output: '',
    metrics: null,
    ...o
  }) as RunRecord

const inferenceErr = (code: string, extra: Record<string, string> = {}): StructuredError => ({
  code: 'inference',
  message: `mensagem original ${code}`,
  retryable: false,
  details: { inferenceCode: code, ...extra }
})

// ---------------------------------------------------------------------------
// Inventário e seleção
// ---------------------------------------------------------------------------

describe('Execução real: modelos elegíveis', () => {
  it('só modelos locais, instalados e de conversa de provedores reais prontos; ids exatos e provedor identificado', () => {
    const options = eligibleModels([
      provider(SIMULATED_PROVIDER_ID, 'simulated', 'ready', [entry(SIMULATED_PROVIDER_ID, 'resposta-curta')]),
      provider('local', 'external', 'ready', [
        entry('local', 'llama3.2:3b'),
        entry('local', 'org/modelo:q4_k_m', { capabilities: [] }),
        entry('local', 'qwen3:8b', { capabilities: ['chat', 'reasoning'] }),
        entry('local', 'nomic-embed-text', { capabilities: ['embedding'] }),
        entry('local', 'gpt-oss:120b-cloud', { location: 'remote' }),
        entry('local', 'baixando:1b', { availability: 'not-installed' }),
        entry('outro', 'intruso:1b')
      ]),
      provider('parado', 'external', 'unreachable', null)
    ])
    assert.deepEqual(
      options.map((o) => [o.ref.providerId, o.ref.modelId, o.providerName, o.reasoning]),
      [
        ['local', 'llama3.2:3b', 'Motor local', false],
        ['local', 'org/modelo:q4_k_m', 'Motor local', false],
        ['local', 'qwen3:8b', 'Motor local', true]
      ]
    )
    assert.equal(options[0]!.label, 'Llama 3.2 (3B)', 'nome amigável no seletor')
    assert.equal(options[0]!.ref.modelId, 'llama3.2:3b', 'identificador exato preservado')
  })

  it('pré-seleção: mantém a escolha, usa o modelo do agente ou o único disponível; com vários, o usuário escolhe', () => {
    const one = eligibleModels([provider('local', 'external', 'ready', [entry('local', 'a:1b')])])
    const many = eligibleModels([provider('local', 'external', 'ready', [entry('local', 'a:1b'), entry('local', 'b:1b')])])
    assert.equal(defaultModelKey(one, '', null), one[0]!.key)
    assert.equal(defaultModelKey(many, '', null), '')
    assert.equal(defaultModelKey(many, '', { providerId: null, modelId: 'b:1b' }), many[1]!.key)
    assert.equal(defaultModelKey(many, many[0]!.key, { providerId: null, modelId: 'b:1b' }), many[0]!.key)
    assert.equal(defaultModelKey(many, 'sumiu', null), '', 'escolha que não existe mais é descartada')
    assert.equal(defaultModelKey(many, '', { providerId: 'outro', modelId: 'b:1b' }), '')
  })

  it('"Usar em Conversas" (Modelos) pré-seleciona o modelo pedido, se ainda estiver disponível', () => {
    const many = eligibleModels([provider('local', 'external', 'ready', [entry('local', 'a:1b'), entry('local', 'b:1b')])])
    assert.equal(defaultModelKey(many, '', { providerId: null, modelId: 'a:1b' }, { providerId: 'local', modelId: 'b:1b' }), many[1]!.key)
    assert.equal(defaultModelKey(many, many[0]!.key, null, { providerId: 'local', modelId: 'b:1b' }), many[0]!.key, 'escolha atual vence')
    assert.equal(defaultModelKey(many, '', null, { providerId: 'local', modelId: 'removido:1b' }), '')
  })

  it('nomes amigáveis só formatam o identificador; nome de exibição do provedor tem preferência', () => {
    assert.equal(friendlyModelName('llama3.1:8b'), 'Llama 3.1 (8B)')
    assert.equal(friendlyModelName('qwen3:8b'), 'Qwen 3 (8B)')
    assert.equal(friendlyModelName('mistral:latest'), 'Mistral')
    assert.equal(friendlyModelName('mistral'), 'Mistral')
    assert.equal(friendlyModelName('deepseek-r1:1.5b'), 'Deepseek R1 (1.5B)')
    assert.equal(friendlyModelName('llama3.1:8b-instruct-q4_K_M'), 'Llama 3.1 (8B · instruct-q4_K_M)')
    assert.equal(friendlyModelName('org/modelo:q4_k_m'), 'Modelo (q4_k_m)')
    assert.equal(friendlyModelName('llama3.1:8b', 'Llama 3.1 Instruct'), 'Llama 3.1 Instruct')
    assert.equal(friendlyModelName('llama3.1:8b', 'llama3.1:8b'), 'Llama 3.1 (8B)')
  })

  it('estados vazios e indisponíveis explicados em linguagem simples', () => {
    assert.match(inventoryProblem([provider(SIMULATED_PROVIDER_ID, 'simulated', 'ready', [])])!.text, /Nenhum motor de IA local/)
    assert.match(inventoryProblem([provider('local', 'external', 'unreachable', null)])!.text, /não está respondendo.*Atualizar lista/)
    const empty = inventoryProblem([provider('local', 'external', 'ready', [])])!
    assert.match(empty.text, /não há modelos de conversa instalados/)
    assert.equal(inventoryProblem([provider('local', 'external', 'ready', [entry('local', 'a:1b')])]), null)
  })
})

describe('Execução real: formulário', () => {
  const options = eligibleModels([provider('local', 'external', 'ready', [entry('local', 'llama3.2:3b')])])
  const key = options[0]!.key

  it('valida agente, modelo, mensagem vazia e limite de caracteres', () => {
    assert.deepEqual(Object.keys(runDraftErrors({ agentId: '', modelKey: '', input: '' }, options)).sort(), ['agentId', 'input', 'modelKey'])
    assert.ok(runDraftErrors({ agentId: 'a', modelKey: key, input: '   \n ' }, options).input)
    assert.ok(runDraftErrors({ agentId: 'a', modelKey: key, input: 'x'.repeat(RUN_INPUT_MAX + 1) }, options).input)
    assert.deepEqual(runDraftErrors({ agentId: 'a', modelKey: key, input: 'x'.repeat(RUN_INPUT_MAX) }, options), {})
    assert.match(runDraftErrors({ agentId: 'a', modelKey: modelKey({ providerId: 'local', modelId: 'removido:1b' }), input: 'oi' }, options).modelKey!, /não está mais disponível/)
  })

  it('pedido para conversations:send usa o modelo exato e a conversa ativa (null cria uma nova)', () => {
    assert.deepEqual(sendRequestFrom({ agentId: 'a', modelKey: key, input: 'Olá' }, options, null), {
      conversationId: null,
      agentId: 'a',
      model: { providerId: 'local', modelId: 'llama3.2:3b' },
      input: 'Olá'
    })
    assert.equal(sendRequestFrom({ agentId: 'a', modelKey: key, input: 'Olá' }, options, 'conv-1')!.conversationId, 'conv-1')
    assert.equal(sendRequestFrom({ agentId: 'a', modelKey: 'x', input: 'Olá' }, options, null), null)
  })

  it('"Executar" na tela Agentes pré-seleciona o agente uma única vez', () => {
    requestRunFor('analista')
    assert.equal(takeRequestedAgent(), 'analista')
    assert.equal(takeRequestedAgent(), null)
  })

  it('pedidos de navegação com modelo e com execução valem uma vez, sem misturar', () => {
    const ref = { providerId: 'local', modelId: 'qwen3:8b' }
    requestModelFor(ref)
    requestRunDetails('run-x')
    assert.equal(takeRequestedAgent(), null)
    assert.deepEqual(takeRequestedModel(), ref)
    assert.notEqual(takeRequestedModel(), ref)
    assert.equal(takeRequestedRun(), 'run-x')
    assert.equal(takeRequestedRun(), null)
  })

  it('mensagens enviadas ficam só na memória da janela, com limite', () => {
    for (let i = 0; i < RUN_LIMITS.maxRecords + 5; i++) rememberInput(`run-${i}`, `texto ${i}`)
    assert.equal(sentInputOf('run-0'), undefined, 'as mais antigas saem primeiro')
    assert.equal(sentInputOf(`run-${RUN_LIMITS.maxRecords + 4}`), `texto ${RUN_LIMITS.maxRecords + 4}`)
  })
})

// ---------------------------------------------------------------------------
// Estados, erros e métricas
// ---------------------------------------------------------------------------

describe('Execução real: estados exibidos', () => {
  it('rótulos textuais para fila, geração, conclusão, interrupção e falhas', () => {
    const a = run({ id: 'run-a', state: 'running', createdAt: '2026-10-26T12:00:00.000Z' })
    const b = run({ id: 'run-b', createdAt: '2026-10-26T12:00:01.000Z' })
    const c = run({ id: 'run-c', createdAt: '2026-10-26T12:00:02.000Z' })
    const all = [c, b, a]
    assert.equal(queuePosition(b, all), 1)
    assert.equal(runStatusView(c, all).label, 'Aguardando na fila (2ª)')
    assert.equal(runStatusView({ ...a, progress: { percent: null, step: 'Carregando modelo' } }).label, 'Carregando modelo')
    assert.equal(runStatusView(a).label, 'Gerando resposta')
    assert.equal(runStatusView({ ...a, cancelRequested: true }).label, 'Interrompendo…')
    assert.equal(runStatusView(run({ id: 'run-d', state: 'completed' })).label, 'Concluída')
    assert.equal(runStatusView(run({ id: 'run-e', state: 'cancelled', cancelRequested: true })).label, 'Interrompida')
    assert.equal(runStatusView(run({ id: 'run-f', state: 'failed', error: inferenceErr('timeout') })).label, 'Tempo esgotado')
    assert.equal(runStatusView(run({ id: 'run-g', state: 'failed', error: inferenceErr('provider-error') })).label, 'Falhou')
    for (const view of [runStatusView(a), runStatusView(b, all)]) assert.ok(view.label.length > 0, 'nunca só cor')
  })

  it('limite esgotado sem texto nunca aparece como sucesso', () => {
    const failed = run({ id: 'run-h', state: 'failed', error: inferenceErr('invalid-request', { reason: 'output-limit-before-text' }) })
    const view = runStatusView(failed)
    assert.equal(view.label, 'Sem resposta (limite)')
    assert.notEqual(view.tone, 'success')
    assert.match(friendlyError(failed.error!).title, /limite de geração acabou antes de qualquer texto/)
  })

  it('concluída com texto cortado no limite: "Concluída com aviso" e o aviso preservado', () => {
    const cut = run({
      id: 'run-i',
      state: 'completed',
      output: 'parcial',
      messages: [{ at: '2026-10-26T12:00:00.000Z', level: 'warning', text: 'Geração interrompida no limite de saída do perfil.' }]
    })
    assert.equal(runStatusView(cut).label, 'Concluída com aviso')
    assert.equal(completedWithWarning(cut), 'Geração interrompida no limite de saída do perfil.')
    assert.equal(completedWithWarning(run({ id: 'run-j', state: 'completed' })), null)
  })

  it('todo código de inferência tem explicação simples, sem esconder a mensagem original', () => {
    for (const code of INFERENCE_ERROR_CODES) {
      const { title, detail } = friendlyError(inferenceErr(code))
      assert.ok(title.length > 10, code)
      assert.equal(detail, `mensagem original ${code}`)
    }
    assert.match(friendlyError(inferenceErr('provider-unavailable')).title, /não está respondendo/)
    assert.match(friendlyError(inferenceErr('model-not-found')).title, /removido/)
    assert.match(friendlyError({ code: 'conflict', message: 'Fila cheia.', retryable: true }).title, /Fila cheia/)
    const simulated = friendlyError(inferenceErr('provider-error'), 'simulated')
    assert.match(simulated.title, /Falha simulada/)
    assert.doesNotMatch(simulated.title, /motor local falhou/)
    assert.equal(simulated.detail, 'mensagem original provider-error')
  })

  it('métricas: só as medidas, com rótulo de raciocínio quando o modelo pensa; nada inventado', () => {
    const metrics: InferenceMetrics = {
      source: 'measured',
      measuredAt: '2026-10-26T12:00:00.000Z',
      loadMs: 1500,
      timeToFirstTokenMs: null,
      totalMs: 2500,
      promptTokens: 12,
      outputTokens: 143,
      outputTokensPerSecond: 4.12,
      peakMemoryBytes: null
    }
    const rows = metricRows(metrics, true)
    assert.deepEqual(
      rows.map(([k]) => k),
      ['Tempo total', 'Carregamento do modelo', 'Tokens de entrada', 'Tokens gerados (inclui raciocínio)', 'Velocidade de geração']
    )
    assert.ok(!rows.some(([k]) => /memória|primeiro/i.test(k)))
    assert.deepEqual(metricRows(null), [])
  })
})

// ---------------------------------------------------------------------------
// Assinatura de execuções (streaming no Renderer)
// ---------------------------------------------------------------------------

function fakeRunsApi(initial: RunRecord[] = []) {
  const listeners = new Set<(run: RunRecord) => void>()
  let resolveList!: (r: Result<RunRecord[]>) => void
  return {
    api: {
      list: () => new Promise<Result<RunRecord[]>>((r) => (resolveList = r)),
      onUpdated: (listener: (run: RunRecord) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    emit: (run: RunRecord) => listeners.forEach((l) => l(run)),
    resolve: (result: Result<RunRecord[]> = { ok: true, data: initial }) => resolveList(result),
    get listeners() {
      return listeners.size
    }
  }
}

const settle = () => new Promise((r) => setImmediate(r))

describe('Renderer: assinatura das execuções', () => {
  it('eventos que chegam antes da lista não se perdem; revisões antigas nunca sobrescrevem as novas', async () => {
    const fake = fakeRunsApi([run({ id: 'run-1', revision: 1, output: 'Ol' })])
    const states: SessionRunsState[] = []
    watchRuns(fake.api, (s) => states.push(s))
    fake.emit(run({ id: 'run-1', revision: 3, output: 'Olá mun' }))
    fake.resolve()
    await settle()
    const ready = states.at(-1)
    assert.ok(ready?.status === 'ready')
    assert.equal(ready.data[0]!.output, 'Olá mun', 'evento adiantado vence a lista antiga')

    fake.emit(run({ id: 'run-1', revision: 2, output: 'Olá' }))
    fake.emit(run({ id: 'run-1', revision: 4, output: 'Olá mundo', state: 'completed' }))
    const last = states.at(-1)
    assert.ok(last?.status === 'ready')
    assert.equal(last.data[0]!.output, 'Olá mundo')
    assert.equal(last.data[0]!.state, 'completed')
  })

  it('texto em ordem e sem duplicação: cada atualização traz o texto completo do RunService', async () => {
    const fake = fakeRunsApi()
    const outputs: string[] = []
    watchRuns(fake.api, (s) => s.status === 'ready' && s.data[0] && outputs.push(s.data[0].output))
    fake.resolve()
    await settle()
    ;['A', 'AB', 'ABC'].forEach((output, i) => fake.emit(run({ id: 'run-1', revision: i + 1, output })))
    fake.emit(run({ id: 'run-1', revision: 3, output: 'ABC' }))
    assert.deepEqual(outputs, ['A', 'AB', 'ABC'])
  })

  it('estado terminal é respeitado: nada atrasado reabre a execução', async () => {
    const fake = fakeRunsApi()
    let current: RunRecord | undefined
    watchRuns(fake.api, (s) => s.status === 'ready' && (current = s.data[0]))
    fake.resolve()
    await settle()
    fake.emit(run({ id: 'run-1', revision: 5, state: 'cancelled', output: 'parcial' }))
    fake.emit(run({ id: 'run-1', revision: 4, state: 'running', output: 'parcial e mais' }))
    assert.equal(current?.state, 'cancelled')
    assert.equal(current?.output, 'parcial')
  })

  it('desmontagem: encerra a assinatura e não entrega mais nada (nem a lista atrasada)', async () => {
    const fake = fakeRunsApi([run({ id: 'run-1' })])
    let calls = 0
    const stop = watchRuns(fake.api, () => calls++)
    assert.equal(fake.listeners, 1)
    stop()
    assert.equal(fake.listeners, 0)
    fake.resolve()
    fake.emit(run({ id: 'run-1', revision: 9 }))
    await settle()
    assert.equal(calls, 0)
  })

  it('falha ao listar vira estado de erro', async () => {
    const fake = fakeRunsApi()
    let state: SessionRunsState | undefined
    watchRuns(fake.api, (s) => (state = s))
    fake.resolve({ ok: false, error: { code: 'internal', message: 'x', retryable: true } })
    await settle()
    assert.equal(state?.status, 'error')
  })
})

// ---------------------------------------------------------------------------
// Conversas no Renderer: lista, marcas da conversa e assinatura
// ---------------------------------------------------------------------------

const cmsg = (id: string, role: 'user' | 'assistant', o: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: `msg-${id}`,
  role,
  content: role === 'user' ? `pergunta ${id}` : `resposta ${id}`,
  createdAt: '2026-10-26T12:00:00.000Z',
  state: 'complete',
  runId: role === 'assistant' ? `run-${id}` : null,
  model: role === 'assistant' ? { providerId: 'ollama', modelId: 'llama3.2:3b' } : null,
  error: null,
  context: null,
  ...o
})

const conv = (o: Partial<Conversation> = {}): Conversation => ({
  id: 'conv-1',
  title: 'Primeira',
  createdAt: '2026-10-26T12:00:00.000Z',
  updatedAt: '2026-10-26T12:00:00.000Z',
  model: { providerId: 'ollama', modelId: 'llama3.2:3b' },
  agentId: 'assistente-geral',
  messages: [],
  ...o
})

describe('Conversas no Renderer', () => {
  it('troca de modelo marcada antes da troca que usou o novo modelo; o histórico fica igual', () => {
    const qwen = { providerId: 'ollama', modelId: 'qwen3:8b' }
    const items = threadItems(
      conv({ messages: [cmsg('1', 'user'), cmsg('2', 'assistant'), cmsg('3', 'user'), cmsg('4', 'assistant', { model: qwen }), cmsg('5', 'user'), cmsg('6', 'assistant', { model: qwen })] })
    )
    assert.deepEqual(
      items.map((i) => i.modelSwitch),
      [null, null, 'Qwen 3 (8B)', null, null, null]
    )
    assert.equal(items.length, 6)
  })

  it('início do contexto enviado marcado só quando a última resposta deixou mensagens de fora', () => {
    const full = conv({ messages: [cmsg('1', 'user'), cmsg('2', 'assistant'), cmsg('3', 'user'), cmsg('4', 'assistant', { context: { sent: 2, omitted: 0, firstSentId: 'msg-1' } })] })
    assert.ok(threadItems(full).every((i) => !i.contextStartsHere))
    const cut = conv({
      messages: [
        cmsg('1', 'user'),
        cmsg('2', 'assistant'),
        cmsg('3', 'user'),
        cmsg('4', 'assistant'),
        cmsg('5', 'user'),
        cmsg('6', 'assistant', { context: { sent: 2, omitted: 2, firstSentId: 'msg-3' } })
      ]
    })
    assert.deepEqual(
      threadItems(cut).map((i) => i.contextStartsHere),
      [false, false, true, false, false, false]
    )
  })

  it('rótulo de contexto, erro guardado e versões fora de ordem', () => {
    assert.equal(contextLabel(null), null)
    assert.equal(contextLabel({ sent: 0, omitted: 0, firstSentId: null }), null)
    assert.equal(contextLabel({ sent: 4, omitted: 0, firstSentId: 'msg-1' }), 'Contexto: 4 mensagem(ns) anterior(es)')
    assert.equal(contextLabel({ sent: 6, omitted: 2, firstSentId: 'msg-3' }), 'Contexto: 6 mensagem(ns) anterior(es) · 2 mais antiga(s) fora do limite')
    const failed = cmsg('2', 'assistant', { state: 'failed', error: { code: 'inference', message: 'O motor caiu.', inferenceCode: 'provider-error' } })
    assert.deepEqual(messageError(failed), { code: 'inference', message: 'O motor caiu.', retryable: false, details: { inferenceCode: 'provider-error' } })
    assert.match(friendlyError(messageError(failed)!).title, /motor/i)
    const older = conv({ updatedAt: '2026-10-26T12:00:00.000Z' })
    const newer = conv({ updatedAt: '2026-10-26T12:00:05.000Z', title: 'Nova' })
    assert.equal(newerConversation(newer, older), newer)
    assert.equal(newerConversation(older, newer), newer)
    assert.equal(newerConversation(null, older), older)
  })

  it('lista: a conversa atualizada sobe para o topo; excluir tira da lista', () => {
    let list: ConversationList = { conversations: [], damaged: 0 }
    list = upsertSummary(list, conv({ id: 'conv-a', updatedAt: '2026-10-26T12:00:00.000Z' }))
    list = upsertSummary(list, conv({ id: 'conv-b', updatedAt: '2026-10-26T12:01:00.000Z' }))
    list = upsertSummary(list, conv({ id: 'conv-a', updatedAt: '2026-10-26T12:02:00.000Z', messages: [cmsg('1', 'user'), cmsg('2', 'assistant', { state: 'pending' })] }))
    assert.deepEqual(
      list.conversations.map((c) => [c.id, c.messageCount, c.generating]),
      [
        ['conv-a', 2, true],
        ['conv-b', 0, false]
      ]
    )
    assert.deepEqual(
      removeSummary(list, 'conv-a').conversations.map((c) => c.id),
      ['conv-b']
    )
  })

  it('situação de gravação: aviso do Main tem prioridade, a lista mantém a situação conhecida e o indicador distingue os três estados', () => {
    const failed = { state: 'failed' as const, retrying: false, message: 'Não foi possível gravar a conversa no disco.' }
    let list: ConversationList = { conversations: [], damaged: 0 }
    list = upsertSummary(list, conv({ id: 'conv-a' }))
    assert.deepEqual(list.conversations[0]!.save, { state: 'saved', retrying: false, message: null })
    list = { ...list, conversations: [{ ...list.conversations[0]!, save: failed }] }
    list = upsertSummary(list, conv({ id: 'conv-a', title: 'Outro' }))
    assert.deepEqual(list.conversations[0]!.save, failed, 'uma atualização da conversa não a apresenta como salva')

    assert.deepEqual(saveStateOf('conv-a', {}, list.conversations), failed)
    assert.equal(saveStateOf('conv-a', { 'conv-a': { state: 'saved', retrying: false, message: null } }, list.conversations).state, 'saved')
    assert.equal(saveStateOf('conv-x', {}, []).state, 'saved')

    assert.equal(saveIndicator({ state: 'saved', retrying: false, message: null }).label, 'Salvo')
    assert.equal(saveIndicator({ state: 'saving', retrying: false, message: null }).label, 'Salvando…')
    assert.deepEqual(saveIndicator(failed), { label: 'Falha ao salvar', tone: 'danger', pulse: false })
    assert.equal(saveIndicator({ ...failed, retrying: true }).label, 'Tentando salvar…')
  })

  it('resposta interrompida pelo fechamento: avisa que o texto recebido foi mantido, sem gerar de novo', () => {
    assert.match(interruptedNotice(cmsg('2', 'assistant', { state: 'interrupted', content: 'Era uma vez' })), /texto recebido até então foi mantido/)
    assert.doesNotMatch(interruptedNotice(cmsg('2', 'assistant', { state: 'interrupted', content: '' })), /mantido/)
  })

  it('assinatura: respostas que terminam enquanto a lista carrega não se perdem; desmontar encerra', async () => {
    let listener: ((c: Conversation) => void) | null = null
    let resolveList!: (r: { ok: true; data: ConversationList }) => void
    const states: ConversationListState[] = []
    const stop = watchConversations(
      {
        list: () => new Promise((resolve) => (resolveList = resolve)),
        onUpdated: (l) => ((listener = l), () => (listener = null))
      },
      (s) => states.push(s)
    )
    listener!(conv({ id: 'conv-b', updatedAt: '2026-10-26T12:05:00.000Z' }))
    resolveList({ ok: true, data: { conversations: [], damaged: 1 } })
    await wait(1)
    const last = states.at(-1)!
    assert.equal(last.status, 'ready')
    assert.deepEqual(last.status === 'ready' && last.data.conversations.map((c) => c.id), ['conv-b'])
    assert.equal(last.status === 'ready' && last.data.damaged, 1)
    stop()
    assert.equal(listener, null)
  })
})

// ---------------------------------------------------------------------------
// Papéis das telas e navegação
// ---------------------------------------------------------------------------

const PAGES = join(import.meta.dirname, '../../src/renderer/src/pages')
const page = (file: string) => readFileSync(join(PAGES, file), 'utf8')

const ROUTES_SRC = readFileSync(join(import.meta.dirname, '../../src/renderer/src/app/routes.ts'), 'utf8')

describe('Telas: Início é o dashboard, Conversas envia, Execuções monitora, Gerpro AI reservado', () => {
  it('Início volta a ser o dashboard: saudação, indicadores, execuções recentes e atalhos, sem envio de mensagens', () => {
    const src = page('HomePage.tsx')
    assert.match(src, /useGreeting\(/)
    assert.match(src, /homeStats\(/)
    assert.match(src, /data-tour="home\.stats"/)
    assert.match(src, /data-tour="home\.recent-runs"/)
    assert.match(src, /navigate\('conversations'\)/, 'atalho "Conversar com IA"')
    assert.match(src, /navigate\('agents'\)/)
    assert.match(src, /navigate\('models'\)/)
    assert.doesNotMatch(src, /runs\.start\(|<TextArea|CancelRunButton/, 'o envio fica em Conversas')
  })

  it('Conversas: sessões gravadas com nova conversa, renomear, excluir com confirmação, envio pelo Main e interrupção', () => {
    const src = page('ConversationsPage.tsx')
    assert.match(src, /window\.gerpro\.conversations\.send\(/)
    assert.doesNotMatch(src, /runs\.start\(|startDemo/, 'o envio passa pela conversa; simulação fica em Execuções')
    assert.match(src, /Nova conversa/)
    assert.match(src, /window\.gerpro\.conversations\.rename\(/)
    assert.match(src, /window\.gerpro\.conversations\.remove\(/)
    assert.match(src, /<ConfirmDialog[^]*title="Excluir conversa\?"/)
    assert.match(src, /<CancelRunButton/)
    assert.match(src, /takeRequestedAgent\(\)/)
    assert.match(src, /takeRequestedModel\(\)/)
    assert.match(src, /Modelo alterado para/)
    assert.match(src, /limite de contexto/)
    assert.doesNotMatch(src, /mensagem independente|não recebe as mensagens anteriores/, 'avisos da etapa sem contexto saíram')
  })

  it('Conversas: situação de gravação no cabeçalho e nova tentativa manual quando a gravação falha', () => {
    const src = page('ConversationsPage.tsx')
    assert.match(src, /useSaveStates\(\)/)
    assert.match(src, /saveIndicator\(save\)/)
    assert.match(src, /window\.gerpro\.conversations\.retrySave\(/)
    assert.match(src, /Tentar salvar novamente/)
    assert.match(src, /save\?\.state === 'failed'/)
    assert.match(src, /interruptedNotice\(message\)/)
  })

  it('Execuções não tem formulário de envio real; mantém detalhes, cancelamento e demonstração simulada', () => {
    const src = page('RunsPage.tsx')
    assert.doesNotMatch(src, /runs\.start\(/)
    assert.match(src, /runs\.startDemo\(/)
    assert.match(src, /<CancelRunButton/)
    assert.match(src, /data-tour="runs\.launcher"/)
    assert.match(src, /takeRequestedRun\(\)/, '"Detalhes técnicos" em Conversas abre a execução aqui')
  })

  it('Gerpro AI e Conversas são separados: o Gerpro AI não chama motor, execuções nem provedores', () => {
    const src = page('ChatPage.tsx')
    assert.doesNotMatch(src, /window\.gerpro\./)
    assert.match(src, /Gerpro AI — Seu assistente inteligente/)
    assert.match(src, /Seu assistente integrado para ajudar a configurar, utilizar e gerenciar o Gerpro Studio\./)
    assert.match(src, /Em desenvolvimento/)
    assert.doesNotMatch(src, /ConversationsPage|real-runs/)
  })

  it('rota única para Conversas, na barra lateral logo depois do Início', () => {
    const ids = [...ROUTES_SRC.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1])
    assert.deepEqual(ids, ['home', 'conversations', 'chat', 'agents', 'models', 'runs', 'tools', 'developer', 'settings'])
    assert.match(ROUTES_SRC, /id: 'conversations', label: 'Conversas', icon: MessagesSquare[^\n]*component: ConversationsPage/)
    assert.match(ROUTES_SRC, /id: 'chat', label: 'Gerpro AI', icon: Sparkles[^\n]*component: ChatPage/)
  })

  it('interações levam a Conversas; histórico e resultados, a Execuções', () => {
    assert.match(page('AgentsPage.tsx'), /requestRunFor\(def\.id\)\s*navigate\('conversations'\)/)
    assert.match(page('ModelsPage.tsx'), /requestModelFor\(model\.ref\)\s*navigate\('conversations'\)/)
    assert.match(page('ConversationsPage.tsx'), /requestRunDetails\(runId\)\s*navigate\('runs'\)/)
    assert.match(page('RunsPage.tsx'), /navigate\('conversations'\)[^]*?Nova mensagem/)
    assert.match(page('ChatPage.tsx'), /navigate\('conversations'\)/)
    for (const file of ['AgentsPage.tsx', 'ModelsPage.tsx', 'ChatPage.tsx']) {
      assert.doesNotMatch(page(file), /navigate\('runs'\)|navigate\('home'\)/, `${file}: interação deve abrir Conversas`)
    }
  })
})

// ---------------------------------------------------------------------------
// Fluxo completo: interface → IPC → RunService → Ollama falso
// ---------------------------------------------------------------------------

/** O que o Preload faz, sobre os handlers reais; eventos vêm do RunService. */
function bridge(services: Awaited<ReturnType<typeof createServices>>) {
  const handlers = createDataHandlers(services)
  const call = async <T>(channel: keyof typeof handlers, ...args: unknown[]) => (await invokeHandler(channel, handlers[channel], args)) as Result<T>
  const runsApi = {
    list: () => call<RunRecord[]>(IpcChannels.runsList),
    onUpdated: (listener: (run: RunRecord) => void) => services.runs.onUpdate(listener)
  }
  after(() => {
    services.conversations.dispose()
    services.runs.dispose()
  })
  return { call, runsApi }
}

type Sent = { conversation: Conversation; run: RunRecord }
const sendTo = (modelId: string, input: string, conversationId: string | null = null) => ({
  conversationId,
  agentId: 'assistente-geral',
  model: { providerId: 'ollama', modelId },
  input
})

async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condição não atingida')
    await wait(5)
  }
}

describe('Fluxo de Conversas e da tela Execuções com o Main real', () => {
  it('Conversas: "Usar em Conversas" → duas mensagens na mesma conversa → o /api/chat recebe o histórico → gravada e recuperada após reiniciar', async () => {
    const bodies: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = []
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('llama3.2:3b'), tag('qwen3:8b', { capabilities: ['completion', 'thinking'] })] }),
      'POST /api/chat': (req, res, body) => {
        bodies.push(JSON.parse(body))
        return stream([chunk('Resposta '), chunk(String(bodies.length)), final()], { delayMs: 10 })(req, res, body)
      }
    })
    const dir = await tempDir()
    const services = await createServices(dir, { stepDelayMs: 1, flushIntervalMs: 10, ollamaBaseUrl: fake.url })
    const { call, runsApi } = bridge(services)
    await call(IpcChannels.agentsCreate, agentDraft({ tools: [] }))

    // Tela Modelos: "Usar em Conversas" no qwen3; Conversas abre com ele escolhido.
    requestModelFor({ providerId: 'ollama', modelId: 'qwen3:8b' })
    const options = eligibleModels(((await call<ProviderOverview[]>(IpcChannels.providersList)) as { data: ProviderOverview[] }).data)
    const key = defaultModelKey(options, '', { providerId: null, modelId: 'aurora-8b-instruct' }, takeRequestedModel())
    const chosen = options.find((o) => o.key === key)!
    assert.equal(chosen.label, 'Qwen 3 (8B)')
    assert.equal(chosen.reasoning, true)

    let list: RunRecord[] = []
    const stop = watchRuns(runsApi, (s) => s.status === 'ready' && (list = s.data))
    after(stop)
    const sim = await call<RunRecord>(IpcChannels.runsStartDemo, { agentId: 'assistente-geral', scenario: 'success' })
    assert.ok(sim.ok)

    const first = await call<Sent>(IpcChannels.conversationsSend, sendRequestFrom({ agentId: 'assistente-geral', modelKey: key, input: 'Meu nome é Ana.\nGuarde isso.' }, options, null)!)
    assert.ok(first.ok)
    const id = first.data.conversation.id
    assert.equal(first.data.conversation.title, 'Meu nome é Ana.')
    await until(() => services.conversations.get(id).messages[1]!.state === 'complete')

    // Segunda mensagem na MESMA conversa, com outro modelo.
    const llama = options.find((o) => o.ref.modelId === 'llama3.2:3b')!.key
    const second = await call<Sent>(IpcChannels.conversationsSend, sendRequestFrom({ agentId: 'assistente-geral', modelKey: llama, input: 'Qual é o meu nome?' }, options, id)!)
    assert.ok(second.ok)
    await until(() => services.conversations.get(id).messages[3]?.state === 'complete')

    assert.equal(bodies[1]!.model, 'llama3.2:3b')
    assert.deepEqual(
      bodies[1]!.messages.map((m) => `${m.role}:${m.content}`),
      ['system:Seja objetivo.', 'user:Meu nome é Ana.\nGuarde isso.', 'assistant:Resposta 1', 'user:Qual é o meu nome?'],
      'o adaptador do motor recebe o histórico da conversa'
    )
    const stored = await call<Conversation>(IpcChannels.conversationsGet, id)
    assert.ok(stored.ok)
    assert.deepEqual(
      stored.data.messages.map((m) => [m.role, m.content, m.model?.modelId ?? null]),
      [
        ['user', 'Meu nome é Ana.\nGuarde isso.', null],
        ['assistant', 'Resposta 1', 'qwen3:8b'],
        ['user', 'Qual é o meu nome?', null],
        ['assistant', 'Resposta 2', 'llama3.2:3b']
      ]
    )
    assert.equal(threadItems(stored.data)[2]!.modelSwitch, 'Llama 3.2 (3B)')
    const listed = await call<ConversationList>(IpcChannels.conversationsList)
    assert.ok(listed.ok)
    assert.equal(listed.data.conversations.length, 1, 'duas mensagens, uma conversa')

    // "Detalhes técnicos": Execuções abre a execução da resposta, com o contexto contado (sem conteúdo).
    await until(() => list.some((r) => r.id === second.data.run.id && r.state === 'completed'))
    requestRunDetails(second.data.run.id)
    const history = await call<RunRecord[]>(IpcChannels.runsList)
    assert.ok(history.ok)
    const details = history.data.find((r) => r.id === takeRequestedRun())!
    assert.equal(details.origin, 'real')
    assert.ok(details.messages.some((m) => m.text === 'Contexto: 2 mensagem(ns) anterior(es) da conversa enviada(s).'))
    assert.ok(history.data.some((r) => r.origin === 'simulated'), 'Execuções mostra reais e simuladas')
    assert.ok(metricRows(history.data.find((r) => r.id === first.data.run.id)!.metrics, true).some(([k]) => k === 'Tokens gerados (inclui raciocínio)'))

    // Reiniciar o aplicativo: a conversa volta igual.
    await services.conversations.whenSaved()
    const restarted = await createServices(dir, { stepDelayMs: 1, flushIntervalMs: 10, ollamaBaseUrl: fake.url })
    after(() => {
      restarted.conversations.dispose()
      restarted.runs.dispose()
    })
    assert.deepEqual(restarted.conversations.get(id), stored.data)
  })

  it('inventário → escolha → envio → streaming → conclusão real com métricas, no histórico junto da simulada', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('llama3.2:3b'), tag('nomic-embed-text', { capabilities: ['embedding'] })] }),
      'POST /api/chat': stream([chunk('Olá'), chunk(', '), chunk('mundo'), final()], { delayMs: 20 })
    })
    const services = await createServices(await tempDir(), { stepDelayMs: 1, flushIntervalMs: 10, ollamaBaseUrl: fake.url })
    const { call, runsApi } = bridge(services)
    await call(IpcChannels.agentsCreate, agentDraft({ tools: [] }))

    const listed = await call<ProviderOverview[]>(IpcChannels.providersList)
    assert.ok(listed.ok)
    const options = eligibleModels(listed.data)
    assert.deepEqual(options.map((o) => o.ref.modelId), ['llama3.2:3b'], 'embedding e simulado ficam de fora')
    const key = defaultModelKey(options, '', null)

    const snapshots: RunRecord[] = []
    const stop = watchRuns(runsApi, (s) => s.status === 'ready' && s.data[0] && snapshots.push(s.data[0]))
    after(stop)

    const request = sendRequestFrom({ agentId: 'assistente-geral', modelKey: key, input: 'Diga olá' }, options, null)!
    const started = await call<Sent>(IpcChannels.conversationsSend, request)
    assert.ok(started.ok)
    assert.equal(started.data.run.origin, 'real')
    assert.equal(started.data.conversation.messages[1]!.state, 'pending')
    await until(() => snapshots.at(-1)?.state === 'completed')
    await until(() => services.conversations.get(started.data.conversation.id).messages[1]!.state === 'complete')
    assert.equal(services.conversations.get(started.data.conversation.id).messages[1]!.content, 'Olá, mundo', 'a conversa grava o texto final da execução')

    const outputs = snapshots.map((s) => s.output)
    for (let i = 1; i < outputs.length; i++) assert.ok(outputs[i]!.startsWith(outputs[i - 1]!), 'texto só cresce, na ordem')
    const done = snapshots.at(-1)!
    assert.equal(done.output, 'Olá, mundo')
    assert.equal(runStatusView(done).label, 'Concluída')
    assert.ok(metricRows(done.metrics).length > 0)

    const sim = await call<RunRecord>(IpcChannels.runsStartDemo, { agentId: 'assistente-geral', scenario: 'success' })
    assert.ok(sim.ok)
    await until(() => services.runs.get(sim.data.id)!.state === 'completed')
    const history = await call<RunRecord[]>(IpcChannels.runsList)
    assert.ok(history.ok)
    assert.deepEqual(history.data.map((r) => r.origin).sort(), ['real', 'simulated'])
  })

  it('interromper geração: estado "Interrompida", texto recebido preservado, nada depois e fila liberada', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('llama3.2:3b')] }),
      'POST /api/chat': stream(Array.from({ length: 300 }, (_, i) => chunk(`${i} `)), { delayMs: 5 })
    })
    const services = await createServices(await tempDir(), { stepDelayMs: 1, flushIntervalMs: 10, ollamaBaseUrl: fake.url })
    const { call, runsApi } = bridge(services)
    await call(IpcChannels.agentsCreate, agentDraft({ tools: [] }))
    const options = eligibleModels(((await call<ProviderOverview[]>(IpcChannels.providersList)) as { data: ProviderOverview[] }).data)

    let latest: RunRecord | undefined
    let deliveries = 0
    const stop = watchRuns(runsApi, (s) => {
      if (s.status === 'ready' && s.data[0]) (latest = s.data[0]), deliveries++
    })
    after(stop)
    const sent = await call<Sent>(IpcChannels.conversationsSend, sendRequestFrom({ agentId: 'assistente-geral', modelKey: options[0]!.key, input: 'Conte' }, options, null)!)
    assert.ok(sent.ok)
    const started = { data: sent.data.run }
    await until(() => (latest?.output.length ?? 0) > 0)

    const cancelled = await call<RunRecord>(IpcChannels.runsCancel, started.data.id)
    assert.ok(cancelled.ok)
    const second = await call<RunRecord>(IpcChannels.runsCancel, started.data.id)
    assert.ok(!second.ok && second.error.code === 'invalid-state', 'segundo pedido para a mesma execução é recusado')
    await until(() => latest?.state === 'cancelled')
    const kept = latest!.output
    assert.ok(kept.length > 0)
    assert.equal(runStatusView(latest!).label, 'Interrompida')
    const count = deliveries
    await wait(100)
    assert.equal(deliveries, count, 'nenhuma atualização depois da finalização')
    assert.equal(latest!.output, kept)
    const reply = services.conversations.get(sent.data.conversation.id).messages[1]!
    assert.equal(reply.state, 'cancelled')
    assert.equal(reply.content, kept, 'a conversa guarda o texto recebido até a interrupção')

    const sim = await call<RunRecord>(IpcChannels.runsStartDemo, { agentId: 'assistente-geral', scenario: 'success' })
    assert.ok(sim.ok)
    await until(() => services.runs.get(sim.data.id)!.state === 'completed')
  })

  it('erros ao enviar: motor parado e modelo removido viram mensagens simples; nada vira simulação', async () => {
    const services = await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: await closedUrl() })
    const { call } = bridge(services)
    await call(IpcChannels.agentsCreate, agentDraft({ tools: [] }))
    const listed = await call<ProviderOverview[]>(IpcChannels.providersList)
    assert.ok(listed.ok)
    assert.deepEqual(eligibleModels(listed.data), [])
    assert.match(inventoryProblem(listed.data)!.text, /não está respondendo/)

    const down = await call<Sent>(IpcChannels.conversationsSend, sendTo('llama3.2:3b', 'Olá'))
    assert.ok(!down.ok)
    assert.match(friendlyError(down.error).title, /não está respondendo/)
    assert.equal(services.runs.list().length, 0, 'nenhuma execução (nem simulada) foi criada')
    assert.equal(services.conversations.list().conversations.length, 0, 'recusa não cria conversa')

    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [] }) })
    const other = await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: fake.url })
    const b = bridge(other)
    await b.call(IpcChannels.agentsCreate, agentDraft({ tools: [] }))
    const removed = await b.call<Sent>(IpcChannels.conversationsSend, sendTo('llama3.2:3b', 'Olá'))
    assert.ok(!removed.ok)
    assert.match(friendlyError(removed.error).title, /removido/)
  })

  it('tempo esgotado e limite sem texto aparecem como falhas com rótulo próprio', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('llama3.2:3b'), tag('qwen3:8b', { capabilities: ['completion', 'thinking'] })] }),
      'POST /api/chat': (req, res, body) => {
        const { model } = JSON.parse(body) as { model: string }
        if (model === 'qwen3:8b') return stream([final({ done_reason: 'length', eval_count: 40 })])(req, res, body)
        return stream([chunk('lento')], { end: false })(req, res, body)
      }
    })
    const scheduler = new VirtualScheduler()
    const agent: AgentDefinition = {
      ...agentDraft({ tools: [], defaultProfile: { ...DEFAULT_EXECUTION_PROFILE, timeoutSeconds: 30, maxOutputTokens: 40 } }),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    const service = new RunService({
      providers: [new SimulatedInferenceProvider({ scheduler, stepDelayMs: 10, now: scheduler.now }), new OllamaInferenceProvider({ baseUrl: fake.url })],
      findAgent: (id) => (id === agent.id ? agent : undefined),
      scheduler,
      now: scheduler.now
    })
    after(() => service.dispose())
    const request = (modelId: string) => ({ agentId: agent.id, input: 'Olá', overrides: { model: { providerId: 'ollama', modelId }, profile: null } })

    const slow = await service.start(request('llama3.2:3b'))
    await until(() => service.get(slow.id)!.output === 'lento')
    await scheduler.advance(30_000)
    const timedOut = service.get(slow.id)!
    assert.equal(runStatusView(timedOut).label, 'Tempo esgotado')
    assert.match(friendlyError(timedOut.error!).title, /tempo limite/)
    assert.equal(timedOut.output, 'lento', 'texto recebido preservado')

    const thinking = await service.start(request('qwen3:8b'))
    await until(() => service.get(thinking.id)!.state === 'failed')
    const empty = service.get(thinking.id)!
    assert.equal(runStatusView(empty).label, 'Sem resposta (limite)')
    assert.equal(empty.output, '')
  })
})

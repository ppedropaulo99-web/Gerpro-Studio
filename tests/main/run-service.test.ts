import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AppError } from '../../src/main/errors'
import { RunService, type RunServiceOptions } from '../../src/main/runs/run-service'
import {
  demoRunRequest,
  SIMULATED_PROVIDER_ID,
  SIMULATED_SCRIPTS,
  SIMULATED_TEXT_PREFIX,
  SimulatedInferenceProvider
} from '../../src/main/runs/simulated-provider'
import type { AgentDefinition } from '../../src/shared/agents'
import {
  INFERENCE_ERROR_CODES,
  INFERENCE_ERROR_NATURE,
  inferenceError,
  type InferenceEvent,
  type InferenceProvider,
  type ProviderInfo
} from '../../src/shared/inference'
import type { ExecutionProfileOverride } from '../../src/shared/execution'
import { RUN_LIMITS, type RunRecord } from '../../src/shared/runs'
import { agentDraft, settle, VirtualScheduler } from '../support/fixtures'

const STEP_MS = 100

const definition = (o: Parameters<typeof agentDraft>[0] = {}): AgentDefinition => ({
  ...agentDraft(o),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

function setup(options: Partial<RunServiceOptions> & { provider?: (s: VirtualScheduler) => InferenceProvider } = {}) {
  const scheduler = new VirtualScheduler()
  const agents = new Map([
    ['assistente-geral', definition()],
    ['arquivado', definition({ id: 'arquivado', state: 'archived' })]
  ])
  let n = 0
  const provider = options.provider?.(scheduler) ?? new SimulatedInferenceProvider({ scheduler, stepDelayMs: STEP_MS, now: scheduler.now })
  const service = new RunService({
    providers: [provider],
    findAgent: (id) => agents.get(id),
    scheduler,
    now: scheduler.now,
    newId: () => `run-${++n}`,
    ...options
  })
  const events: RunRecord[] = []
  service.onUpdate((run) => events.push(run))
  const of = (id: string) => events.filter((e) => e.id === id)
  return { scheduler, service, events, of }
}

const request = (modelId: string, profile: ExecutionProfileOverride | null = null, input = 'Olá') => ({
  agentId: 'assistente-geral',
  input,
  overrides: { model: { providerId: SIMULATED_PROVIDER_ID, modelId }, profile }
})

const isCode = (code: string, inferenceCode?: string) => (e: unknown) =>
  e instanceof AppError && e.code === code && (inferenceCode === undefined || e.details?.['inferenceCode'] === inferenceCode)

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** Provedor de teste montado a partir de um gerador. */
function fakeProvider(
  generate: (signal: AbortSignal) => AsyncIterable<unknown>,
  info: Partial<ProviderInfo> = {},
  models = ['modelo-teste']
): InferenceProvider & { calls: number } {
  const provider = {
    calls: 0,
    info: { id: SIMULATED_PROVIDER_ID, displayName: 'Teste', kind: 'simulated' as const, ...info },
    status: async () => ({ providerId: provider.info.id, state: 'ready' as const, version: null, checkedAt: null, message: null }),
    listModels: async () =>
      models.map((modelId) => ({
        availability: 'installed' as const,
        model: {
          ref: { providerId: provider.info.id, modelId },
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
          capabilities: ['chat' as const]
        }
      })),
    generate: (_request: unknown, signal: AbortSignal) => {
      provider.calls++
      return generate(signal) as AsyncIterable<InferenceEvent>
    }
  }
  return provider
}

describe('RunService: ciclo de vida com o provedor simulado', () => {
  it('resposta em fluxo: pending → running → completed, texto completo, marcado como simulado e sem métricas', async () => {
    const { scheduler, service, of } = setup()
    const started = await service.start(request('resposta-em-fluxo'))
    assert.equal(started.state, 'pending')
    assert.equal(started.origin, 'simulated')
    assert.deepEqual(started.execution?.model, { providerId: SIMULATED_PROVIDER_ID, modelId: 'resposta-em-fluxo' })
    assert.equal(started.metrics, null)

    await scheduler.advance(STEP_MS * 10)
    const done = service.get(started.id)!
    assert.equal(done.state, 'completed')
    assert.equal(done.error, null)
    assert.equal(done.metrics, null)
    assert.equal(done.progress.percent, 100)
    const expected = SIMULATED_SCRIPTS['resposta-em-fluxo']!.steps(3).map((s) => (s.kind === 'delta' ? s.text : '')).join('')
    assert.equal(done.output, expected)
    assert.ok(done.output.startsWith(SIMULATED_TEXT_PREFIX))
    assert.ok(done.messages.some((m) => /simulad/i.test(m.text)))

    const events = of(started.id)
    assert.deepEqual([...new Set(events.map((e) => e.state))], ['pending', 'running', 'completed'])
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i]!.output.startsWith(events[i - 1]!.output), 'texto só cresce, na ordem')
      assert.ok(events[i]!.revision > events[i - 1]!.revision, 'revisão sempre aumenta')
    }
  })

  it('resposta curta e saídas determinísticas (mesmo pedido, mesmo texto e mesma sequência)', async () => {
    const outputs: string[][] = []
    for (let i = 0; i < 2; i++) {
      const { scheduler, service, events } = setup()
      await service.start(request('resposta-curta', null, 'Mensagem igual'))
      await service.start(request('resposta-em-fluxo', null, 'Mensagem igual'))
      await scheduler.advance(STEP_MS * 20)
      outputs.push(events.map((e) => `${e.id}:${e.state}:${e.output}`))
    }
    assert.deepEqual(outputs[0], outputs[1])
    assert.ok(outputs[0]!.some((line) => line.includes('Mensagem igual') === false && line.includes('14 caractere')))
  })

  it('fila FIFO com uma única execução ativa; a próxima começa sozinha', async () => {
    const { scheduler, service, events } = setup()
    const ids = []
    for (let i = 0; i < 3; i++) ids.push((await service.start(request('resposta-em-fluxo'))).id)
    assert.deepEqual(
      ids.map((id) => service.get(id)!.state),
      ['running', 'pending', 'pending']
    )

    // Em nenhum momento duas execuções rodam ao mesmo tempo.
    const latest = new Map<string, string>()
    for (const e of events) {
      latest.set(e.id, e.state)
      assert.ok([...latest.values()].filter((s) => s === 'running').length <= 1)
    }
    await scheduler.advance(STEP_MS * 30)
    for (const e of events) {
      latest.set(e.id, e.state)
      assert.ok([...latest.values()].filter((s) => s === 'running').length <= 1)
    }

    const runs = ids.map((id) => service.get(id)!)
    assert.ok(runs.every((r) => r.state === 'completed'))
    assert.ok(runs[0]!.finishedAt! <= runs[1]!.startedAt! && runs[1]!.finishedAt! <= runs[2]!.startedAt!, 'ordem de chegada')
    const startOrder = [...new Set(events.filter((e) => e.state === 'running').map((e) => e.id))]
    assert.deepEqual(startOrder, ids)
  })

  it('limite da fila: no máximo 10 aguardando; o excedente é recusado sem entrar na fila', async () => {
    const { service } = setup()
    const active = await service.start(request('sem-resposta'))
    const pending = []
    for (let i = 0; i < RUN_LIMITS.maxPending; i++) pending.push(await service.start(request('resposta-curta')))
    await assert.rejects(service.start(request('resposta-curta')), (e: unknown) => isCode('conflict')(e) && (e as AppError).retryable)
    assert.equal(service.list().length, 1 + RUN_LIMITS.maxPending)

    // Cancelar uma pendente libera vaga.
    service.cancel(pending[0]!.id)
    await service.start(request('resposta-curta'))
    assert.equal(service.get(active.id)!.state, 'running')
    service.dispose()
  })

  it('cancelamento pendente: sai da fila na hora, nunca começa e não atrasa as demais', async () => {
    const { scheduler, service, of } = setup()
    const a = await service.start(request('resposta-em-fluxo'))
    const b = await service.start(request('resposta-em-fluxo'))
    const c = await service.start(request('resposta-em-fluxo'))

    const cancelled = service.cancel(b.id)
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(cancelled.cancelRequested, true)
    assert.equal(cancelled.startedAt, null)
    assert.equal(service.get(a.id)!.state, 'running', 'a ativa não é afetada')

    await scheduler.advance(STEP_MS * 30)
    assert.equal(service.get(a.id)!.state, 'completed')
    assert.equal(service.get(c.id)!.state, 'completed')
    assert.ok(of(b.id).every((e) => e.state !== 'running'))
    assert.equal(of(b.id).filter((e) => e.state === 'cancelled').length, 1)
  })

  it('cancelamento em andamento: aborta o provedor, guarda o texto parcial e passa para a próxima', async () => {
    let aborted = false
    const { scheduler, service, of } = setup({
      provider: (s) => {
        const real = new SimulatedInferenceProvider({ scheduler: s, stepDelayMs: STEP_MS })
        return {
          info: real.info,
          status: () => real.status(),
          listModels: () => real.listModels(),
          generate: (req, signal) => {
            signal.addEventListener('abort', () => (aborted = true))
            return real.generate(req, signal)
          }
        }
      }
    })
    const a = await service.start(request('resposta-em-fluxo'))
    const b = await service.start(request('resposta-curta'))
    await scheduler.advance(STEP_MS * 2 + 80)
    const partial = service.get(a.id)!.output
    assert.ok(partial.length > 0)

    const result = service.cancel(a.id)
    assert.equal(result.state, 'cancelled')
    assert.equal(result.output, partial)
    assert.equal(result.error, null)
    assert.ok(aborted, 'o sinal de cancelamento chega ao provedor')
    assert.equal(service.get(b.id)!.state, 'running', 'a próxima começa logo após o cancelamento')

    const before = of(a.id).length
    await scheduler.advance(STEP_MS * 20)
    assert.equal(of(a.id).length, before, 'nada é emitido depois do estado terminal')
    assert.equal(service.get(b.id)!.state, 'completed')
  })

  it('cancelar execução encerrada, inexistente ou com ID inválido', async () => {
    const { scheduler, service } = setup()
    const run = await service.start(request('resposta-curta'))
    await scheduler.advance(STEP_MS * 5)
    assert.throws(() => service.cancel(run.id), isCode('invalid-state'))
    assert.throws(() => service.cancel('run-nao-existe'), isCode('not-found'))
    assert.throws(() => service.cancel('../etc'), isCode('validation'))
    assert.throws(() => service.cancel(42), isCode('validation'))
  })
})

describe('RunService: tempo limite e corridas', () => {
  it('o tempo limite só conta a partir do início da execução', async () => {
    const { scheduler, service } = setup()
    const a = await service.start(request('sem-resposta', { timeoutSeconds: 10 }))
    const b = await service.start(request('sem-resposta', { timeoutSeconds: 10 }))

    await scheduler.advance(9_999)
    assert.equal(service.get(a.id)!.state, 'running')
    await scheduler.advance(1)
    const timedOut = service.get(a.id)!
    assert.equal(timedOut.state, 'failed')
    assert.equal(timedOut.error?.code, 'inference')
    assert.equal(timedOut.error?.details?.['inferenceCode'], 'timeout')
    assert.equal(timedOut.error?.retryable, true)

    // `b` esperou 10 s na fila, mas o prazo dela começa agora.
    assert.equal(service.get(b.id)!.state, 'running')
    await scheduler.advance(9_999)
    assert.equal(service.get(b.id)!.state, 'running')
    await scheduler.advance(1)
    assert.equal(service.get(b.id)!.state, 'failed')
    assert.equal(scheduler.pending, 0, 'nenhum temporizador sobra')
  })

  it('tempo limite e conclusão no mesmo instante: finaliza uma única vez', async () => {
    const { scheduler, service, of } = setup({
      provider: (s) =>
        fakeProvider(async function* (signal) {
          yield { type: 'delta', text: 'parcial' }
          await new Promise<void>((resolve) => s.setTimeout(resolve, 10_000))
          if (!signal.aborted) yield { type: 'done', finishReason: 'stop', metrics: null }
        })
    })
    const run = await service.start(request('modelo-teste', { timeoutSeconds: 10 }))
    await scheduler.advance(20_000)
    const terminal = of(run.id).filter((e) => TERMINAL.has(e.state))
    assert.equal(terminal.length, 1)
    assert.equal(terminal[0]!.state, 'failed', 'o prazo foi registrado antes da conclusão')
  })

  it('provedor que ignora o cancelamento não reabre a execução', async () => {
    const { scheduler, service, of } = setup({
      provider: (s) =>
        fakeProvider(async function* () {
          yield { type: 'delta', text: 'a' }
          await new Promise<void>((resolve) => s.setTimeout(resolve, 500))
          yield { type: 'delta', text: 'b' }
          yield { type: 'done', finishReason: 'stop', metrics: null }
        })
    })
    const run = await service.start(request('modelo-teste'))
    await scheduler.advance(100)
    service.cancel(run.id)
    await scheduler.advance(1_000)
    const final = service.get(run.id)!
    assert.equal(final.state, 'cancelled')
    assert.equal(final.output, 'a')
    assert.equal(of(run.id).filter((e) => TERMINAL.has(e.state)).length, 1)
  })

  it('cancelamento pedido dentro do aviso de conclusão é recusado sem alterar a execução', async () => {
    const { scheduler, service } = setup()
    const run = await service.start(request('resposta-curta'))
    let refusal: unknown
    service.onUpdate((r) => {
      if (r.id === run.id && r.state === 'completed') {
        try {
          service.cancel(r.id)
        } catch (error) {
          refusal = error
        }
      }
    })
    await scheduler.advance(STEP_MS * 5)
    assert.ok(isCode('invalid-state')(refusal))
    assert.equal(service.get(run.id)!.state, 'completed')
  })
})

describe('RunService: erros tipados', () => {
  it('cada código de erro do provedor é preservado e classificado', async () => {
    const { scheduler, service } = setup()
    const ids = new Map<string, string>()
    for (const code of INFERENCE_ERROR_CODES) ids.set(code, (await service.start(request(`erro-${code}`))).id)
    await scheduler.advance(STEP_MS * 30)

    for (const code of INFERENCE_ERROR_CODES) {
      const run = service.get(ids.get(code)!)!
      if (code === 'cancelled') {
        assert.equal(run.state, 'cancelled')
        assert.equal(run.error, null)
        continue
      }
      assert.equal(run.state, 'failed', code)
      assert.equal(run.error?.code, 'inference')
      assert.equal(run.error?.details?.['inferenceCode'], code)
      assert.equal(run.error?.retryable, INFERENCE_ERROR_NATURE[code] === 'transient', code)
    }
  })

  it('falha durante a geração mantém o texto parcial', async () => {
    const { scheduler, service } = setup()
    const run = await service.start(demoRunRequest({ agentId: 'assistente-geral', scenario: 'failure' }))
    await scheduler.advance(STEP_MS * 10)
    const failed = service.get(run.id)!
    assert.equal(failed.state, 'failed')
    assert.equal(failed.error?.details?.['inferenceCode'], 'provider-error')
    assert.ok(failed.output.startsWith(SIMULATED_TEXT_PREFIX))
  })

  it('evento inválido, exceção ou fim sem conclusão viram provider-error', async () => {
    const original = console.error
    console.error = () => undefined
    try {
      for (const generate of [
        async function* () {
          yield { type: 'delta', text: 42 }
        },
        async function* () {
          yield { type: 'delta', text: 'x' }
          throw new Error('C:\\caminho\\interno')
        },
        async function* () {
          yield { type: 'delta', text: 'x' }
        }
      ]) {
        const { scheduler, service } = setup({ provider: () => fakeProvider(generate) })
        const run = await service.start(request('modelo-teste'))
        await scheduler.advance(1_000)
        const failed = service.get(run.id)!
        assert.equal(failed.state, 'failed')
        assert.equal(failed.error?.details?.['inferenceCode'], 'provider-error')
        assert.ok(!failed.error?.message.includes('caminho'), 'detalhes internos não vazam')
      }
    } finally {
      console.error = original
    }
  })

  it('sem nova tentativa automática', async () => {
    const provider = fakeProvider(async function* () {
      yield { type: 'error', error: { code: 'provider-unavailable', message: 'parado' } }
    })
    const { scheduler, service } = setup({ provider: () => provider })
    await service.start(request('modelo-teste'))
    await scheduler.advance(60_000)
    assert.equal(provider.calls, 1)
    assert.equal(service.list().length, 1)
    assert.equal(service.list()[0]!.error?.retryable, true, 'pode repetir, mas só se o usuário pedir')
  })
})

describe('RunService: validação, resolução e limites', () => {
  it('recusa pedidos inválidos antes de criar a execução', async () => {
    const { service } = setup()
    for (const bad of [
      null,
      { agentId: 'assistente-geral', input: 'x' },
      { ...request('resposta-curta'), extra: true },
      { ...request('resposta-curta'), input: '   ' },
      { ...request('resposta-curta'), input: 'x'.repeat(RUN_LIMITS.inputChars + 1) },
      { ...request('resposta-curta'), agentId: '../agente' },
      request('resposta-curta', { timeoutSeconds: 1 })
    ]) {
      await assert.rejects(service.start(bad), isCode('validation'))
    }
    assert.equal(service.list().length, 0)
  })

  it('agente inexistente, arquivado ou sem modelo instalado', async () => {
    const { service } = setup()
    await assert.rejects(service.start({ ...request('resposta-curta'), agentId: 'nao-existe' }), isCode('not-found'))
    await assert.rejects(service.start({ ...request('resposta-curta'), agentId: 'arquivado' }), isCode('invalid-state'))
    // Modelo padrão do agente (aurora-8b-instruct) não existe no provedor simulado.
    await assert.rejects(
      service.start({ agentId: 'assistente-geral', input: 'Olá', overrides: null }),
      (e: unknown) => isCode('inference', 'model-not-found')(e) && (e as AppError).details?.['resolution'] === 'model-not-installed'
    )
    await assert.rejects(service.start(request('nao-existe')), isCode('inference', 'model-not-found'))
    assert.equal(service.list().length, 0)
  })

  it('limite de prompt: recusado antes da fila', async () => {
    const { service } = setup({ limits: { promptChars: 20 } })
    await assert.rejects(service.start(request('resposta-curta', null, 'mensagem longa demais')), isCode('inference', 'context-too-long'))
    assert.equal(service.list().length, 0)
  })

  it('contexto do modelo excedido: o provedor recusa com context-too-long', async () => {
    const { scheduler, service } = setup()
    const run = await service.start(request('resposta-curta', { contextLength: 256 }, 'x'.repeat(2_000)))
    await scheduler.advance(STEP_MS * 5)
    const failed = service.get(run.id)!
    assert.equal(failed.state, 'failed')
    assert.equal(failed.error?.details?.['inferenceCode'], 'context-too-long')
  })

  it('limite de saída acumulada: interrompe a geração e conclui com o texto truncado', async () => {
    const { scheduler, service, of } = setup({ limits: { outputChars: 50 } })
    const run = await service.start(request('resposta-em-fluxo'))
    const next = await service.start(request('resposta-curta'))
    await scheduler.advance(STEP_MS * 20)
    const done = service.get(run.id)!
    assert.equal(done.state, 'completed')
    assert.equal(done.error, null)
    assert.equal(done.output.length, 50)
    assert.ok(done.messages.some((m) => m.level === 'warning' && m.text.includes('50 caracteres')))
    assert.ok(of(run.id).every((e) => e.output.length <= 50), 'o texto nunca passa do limite, nem nos eventos')
    assert.equal(service.get(next.id)!.state, 'completed', 'a fila é liberada')
    assert.equal(scheduler.pending, 0)
  })

  it('limite de saída do perfil (maxOutputTokens) termina com aviso', async () => {
    const { scheduler, service } = setup()
    const run = await service.start(request('resposta-em-fluxo', { maxOutputTokens: 5 }))
    await scheduler.advance(STEP_MS * 20)
    const done = service.get(run.id)!
    assert.equal(done.state, 'completed')
    assert.equal(done.output.length, 20)
    assert.ok(done.messages.some((m) => m.level === 'warning' && m.text.includes('limite de saída')))
  })

  it('política de recursos pode recusar a execução (ponto de extensão)', async () => {
    const { service } = setup({
      resourcePolicy: ({ execution }) =>
        execution.model.modelId === 'resposta-em-fluxo' ? inferenceError('insufficient-memory', 'Memória livre insuficiente.') : null
    })
    await assert.rejects(service.start(request('resposta-em-fluxo')), isCode('inference', 'insufficient-memory'))
    assert.ok(await service.start(request('resposta-curta')))
  })

  it('inventário do provedor é validado: modelos inválidos, remotos ou de outro provedor são ignorados', async () => {
    const provider = fakeProvider(async function* () {
      yield { type: 'done', finishReason: 'stop', metrics: null }
    })
    const valid = await provider.listModels(new AbortController().signal)
    provider.listModels = async () => [
      { ...valid[0]!, model: { ...valid[0]!.model, location: 'remote' as const } },
      { ...valid[0]!, model: { ...valid[0]!.model, ref: { providerId: 'outro', modelId: 'modelo-teste' } } },
      { availability: 'installed', model: { nada: true } } as never
    ]
    const { service } = setup({ provider: () => provider })
    await assert.rejects(service.start(request('modelo-teste')), isCode('inference', 'model-not-found'))
  })

  it('histórico em memória respeita o limite de registros (mais antigas encerradas saem primeiro)', async () => {
    const { scheduler, service } = setup({ limits: { maxRecords: 3 } })
    for (let i = 0; i < 5; i++) {
      await service.start(request('resposta-curta'))
      await scheduler.advance(STEP_MS * 3)
    }
    assert.deepEqual(
      service.list().map((r) => r.id),
      ['run-5', 'run-4', 'run-3']
    )
  })
})

describe('RunService: eventos agrupados', () => {
  it('texto em rajada: no máximo uma atualização por intervalo, sem perder texto', async () => {
    const pieces = Array.from({ length: 30 }, (_, i) => `p${i};`)
    const { scheduler, service, of } = setup({
      flushIntervalMs: 75,
      provider: (s) =>
        fakeProvider(async function* (signal) {
          for (const text of pieces) {
            await new Promise<void>((resolve) => s.setTimeout(resolve, 10))
            if (signal.aborted) return
            yield { type: 'delta', text }
          }
          yield { type: 'done', finishReason: 'stop', metrics: null }
        })
    })
    const run = await service.start(request('modelo-teste'))
    await scheduler.advance(1_000)

    const events = of(run.id)
    const textUpdates = events.filter((e) => e.state === 'running' && e.output.length > 0)
    // 30 fragmentos em 300 ms → cerca de 4 lotes, nunca um evento por fragmento.
    assert.ok(textUpdates.length >= 3 && textUpdates.length <= 5, `${textUpdates.length} atualizações`)
    assert.equal(events.at(-1)!.state, 'completed')
    assert.equal(events.at(-1)!.output, pieces.join(''))
    for (let i = 1; i < events.length; i++) assert.ok(events[i]!.output.startsWith(events[i - 1]!.output))
    assert.equal(scheduler.pending, 0, 'temporizador de lote limpo ao terminar')
  })

  it('estado terminal é enviado na hora, sem esperar o lote', async () => {
    const { scheduler, service, of } = setup({
      flushIntervalMs: 100,
      provider: () =>
        fakeProvider(async function* () {
          yield { type: 'delta', text: 'tudo' }
          yield { type: 'done', finishReason: 'stop', metrics: null }
        })
    })
    const run = await service.start(request('modelo-teste'))
    await settle()
    assert.equal(scheduler.time, 0)
    const last = of(run.id).at(-1)!
    assert.equal(last.state, 'completed')
    assert.equal(last.output, 'tudo')
  })
})

describe('RunService: real × simulado', () => {
  it('só o provedor simulado registrado: infraestrutura e simulação funcionam, motor real não', () => {
    const { service } = setup()
    assert.deepEqual(service.capabilities(), { infrastructure: 'functional', simulation: 'available', realEngine: 'unavailable' })
  })

  it('provedor simulado nunca produz métricas, mesmo que envie', async () => {
    const metrics = {
      source: 'measured' as const,
      measuredAt: '2026-10-23T12:00:00.000Z',
      loadMs: 1,
      timeToFirstTokenMs: 1,
      totalMs: 1,
      promptTokens: 1,
      outputTokens: 1,
      outputTokensPerSecond: 1,
      peakMemoryBytes: 1
    }
    const done = { type: 'done', finishReason: 'stop', metrics }
    const simulated = setup({ provider: () => fakeProvider(async function* () { yield done }) })
    const s = await simulated.service.start(request('modelo-teste'))
    await simulated.scheduler.advance(10)
    assert.equal(simulated.service.get(s.id)!.origin, 'simulated')
    assert.equal(simulated.service.get(s.id)!.metrics, null)

    // Um provedor de outro tipo gera execução `real` (aqui, um dublê de teste).
    const external = setup({ provider: () => fakeProvider(async function* () { yield done }, { id: 'externo', kind: 'external' }) })
    assert.equal(external.service.capabilities().realEngine, 'available')
    const r = await external.service.start({ ...request('modelo-teste'), overrides: { model: { providerId: 'externo', modelId: 'modelo-teste' }, profile: null } })
    await external.scheduler.advance(10)
    const real = external.service.get(r.id)!
    assert.equal(real.origin, 'real')
    assert.deepEqual(real.metrics, metrics)
  })

  it('provedores com ID repetido são recusados', () => {
    const p = new SimulatedInferenceProvider()
    assert.throws(() => new RunService({ providers: [p, p], findAgent: () => undefined }))
  })
})

describe('RunService: encerramento', () => {
  it('dispose aborta a execução ativa, limpa temporizadores e não emite mais nada', async () => {
    const { scheduler, service, events } = setup()
    await service.start(request('resposta-em-fluxo'))
    await service.start(request('resposta-em-fluxo'))
    await scheduler.advance(STEP_MS)
    const count = events.length
    service.dispose()
    await scheduler.advance(60_000)
    assert.equal(events.length, count)
    assert.equal(scheduler.pending, 0)
    await assert.rejects(service.start(request('resposta-curta')), isCode('invalid-state'))
  })
})

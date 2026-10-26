import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, describe, it } from 'node:test'
import { parseLoopbackUrl } from '../../src/main/engine/local-http'
import { OLLAMA_PROVIDER_ID, OllamaInferenceProvider, type OllamaProviderOptions } from '../../src/main/engine/ollama/ollama-provider'
import { InferenceProviderError } from '../../src/main/engine/provider-error'
import { AppError } from '../../src/main/errors'
import { createDataHandlers, invokeHandler } from '../../src/main/ipc-handlers'
import { RunService } from '../../src/main/runs/run-service'
import { SIMULATED_PROVIDER_ID, SimulatedInferenceProvider } from '../../src/main/runs/simulated-provider'
import { createServices } from '../../src/main/services'
import type { AgentDefinition, AgentRecord } from '../../src/shared/agents'
import { DEFAULT_EXECUTION_PROFILE, type ExecutionProfile } from '../../src/shared/execution'
import { validateInferenceEvent, type InferenceEvent, type InferenceRequest, type ProviderOverview } from '../../src/shared/inference'
import { IpcChannels } from '../../src/shared/ipc'
import { agentDraft, tempDir, VirtualScheduler } from '../support/fixtures'

// ---------------------------------------------------------------------------
// Servidor HTTP que imita o Ollama (nenhum Ollama real é usado)
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>

interface FakeOllama {
  url: string
  /** Rotas `MÉTODO /caminho`; rota ausente responde 404. */
  routes: Map<string, Handler>
  /** Corpos JSON recebidos em `/api/chat`. */
  chats: unknown[]
  /** Quantas conexões de `/api/chat` foram fechadas pelo cliente antes do fim. */
  aborted: number
  close(): Promise<void>
}

async function fakeOllama(routes: Record<string, Handler> = {}): Promise<FakeOllama> {
  const fake: FakeOllama = {
    url: '',
    routes: new Map(Object.entries({ 'GET /api/version': json({ version: '0.40.10' }), 'GET /api/tags': json({ models: [] }), ...routes })),
    chats: [],
    aborted: 0,
    close: async () => undefined
  }
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => {
      const key = `${req.method} ${req.url}`
      if (key === 'POST /api/chat') {
        fake.chats.push(JSON.parse(body))
        res.on('close', () => {
          if (!res.writableFinished) fake.aborted++
        })
      }
      const handler = fake.routes.get(key)
      if (!handler) return void res.writeHead(404).end()
      void handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  after(() => fake.close())
  return fake
}

const json =
  (body: unknown, status = 200): Handler =>
  (_req, res) =>
    void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Envia partes do corpo com pausa entre elas; `end: false` deixa a conexão aberta. */
const stream =
  (parts: Array<string | Buffer>, options: { delayMs?: number; end?: boolean; status?: number } = {}): Handler =>
  async (_req, res) => {
    res.writeHead(options.status ?? 200, { 'content-type': 'application/x-ndjson' })
    for (const part of parts) {
      if (res.destroyed) return
      res.write(part)
      await wait(options.delayMs ?? 5)
    }
    if (options.end !== false) res.end()
  }

const line = (value: unknown) => `${JSON.stringify(value)}\n`
const chunk = (content: string) => line({ model: 'llama3.2:3b', created_at: '2026-10-26T12:00:00Z', message: { role: 'assistant', content }, done: false })
const final = (extra: Record<string, unknown> = {}) =>
  line({
    model: 'llama3.2:3b',
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    total_duration: 2_500_000_000,
    load_duration: 1_000_000_000,
    prompt_eval_count: 12,
    eval_count: 20,
    eval_duration: 1_000_000_000,
    ...extra
  })

/** Porta sem nada escutando: conexão recusada. */
async function closedUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

const tag = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  model: name,
  modified_at: '2026-06-02T12:41:34.1374155-03:00',
  size: 2_019_393_189,
  digest: 'a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72',
  details: { parent_model: '', format: 'gguf', family: 'llama', families: ['llama'], parameter_size: '3.2B', quantization_level: 'Q4_K_M', context_length: 131072 },
  capabilities: ['completion', 'tools'],
  ...extra
})

const provider = (url: string, options: OllamaProviderOptions = {}) => new OllamaInferenceProvider({ baseUrl: url, ...options })

const chatRequest = (modelId = 'llama3.2:3b', profile: Partial<ExecutionProfile> = {}): InferenceRequest => ({
  model: { providerId: OLLAMA_PROVIDER_ID, modelId },
  messages: [
    { role: 'system', content: 'Seja objetivo.' },
    { role: 'user', content: 'Olá' }
  ],
  profile: { ...DEFAULT_EXECUTION_PROFILE, ...profile }
})

async function collect(events: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const out: InferenceEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

const errorCode = (events: InferenceEvent[]) => {
  const last = events.at(-1)
  return last?.type === 'error' ? last.error.code : undefined
}

const neverAborted = () => new AbortController().signal

// ---------------------------------------------------------------------------
// Endereço
// ---------------------------------------------------------------------------

describe('Ollama: endereço do serviço', () => {
  it('aceita só loopback por http, sem caminho nem credenciais', () => {
    assert.equal(parseLoopbackUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434')
    assert.equal(parseLoopbackUrl('http://localhost:11434/'), 'http://localhost:11434')
    assert.equal(parseLoopbackUrl('http://[::1]:11434'), 'http://[::1]:11434')
    for (const bad of [
      'http://192.168.0.10:11434',
      'http://ollama.exemplo.com:11434',
      'https://127.0.0.1:11434',
      'http://usuario:senha@127.0.0.1:11434',
      'http://127.0.0.1:11434/api',
      'http://127.0.0.1:11434?x=1',
      'file:///c:/ollama',
      'não é url'
    ]) {
      assert.throws(() => parseLoopbackUrl(bad), Error, bad)
      assert.throws(() => new OllamaInferenceProvider({ baseUrl: bad }), Error, bad)
    }
  })

  it('identifica-se como provedor externo e real', () => {
    assert.deepEqual(new OllamaInferenceProvider().info, { id: 'ollama', displayName: 'Ollama', kind: 'external' })
  })
})

// ---------------------------------------------------------------------------
// Disponibilidade
// ---------------------------------------------------------------------------

describe('Ollama: disponibilidade', () => {
  it('serviço disponível: ready com a versão informada', async () => {
    const fake = await fakeOllama()
    const status = await provider(fake.url).status(neverAborted())
    assert.equal(status.state, 'ready')
    assert.equal(status.version, '0.40.10')
    assert.equal(status.providerId, 'ollama')
    assert.ok(status.checkedAt)
  })

  it('serviço indisponível: unreachable, sem lançar', async () => {
    const status = await provider(await closedUrl()).status(neverAborted())
    assert.equal(status.state, 'unreachable')
    assert.equal(status.version, null)
  })

  it('serviço que não responde a tempo: unreachable', async () => {
    const fake = await fakeOllama({ 'GET /api/version': () => undefined })
    const status = await provider(fake.url, { statusTimeoutMs: 100 }).status(neverAborted())
    assert.equal(status.state, 'unreachable')
  })

  it('resposta que não é do Ollama ou HTTP de erro: error', async () => {
    for (const handler of [json({ nome: 'outro' }), json({ version: '<script>' }), json({ error: 'x' }, 500), stream(['não é json'])]) {
      const fake = await fakeOllama({ 'GET /api/version': handler })
      assert.equal((await provider(fake.url).status(neverAborted())).state, 'error')
    }
  })

  it('redirecionamento é recusado (não segue para outro host)', async () => {
    const fake = await fakeOllama({
      'GET /api/version': (_req, res) => void res.writeHead(302, { location: 'http://example.com/api/version' }).end()
    })
    assert.equal((await provider(fake.url).status(neverAborted())).state, 'unreachable')
  })

  it('recupera depois de uma falha: o mesmo provedor volta a ready', async () => {
    let up = false
    const fake = await fakeOllama({
      'GET /api/version': (req, res, body) => (up ? json({ version: '0.40.10' })(req, res, body) : void res.writeHead(503).end())
    })
    const p = provider(fake.url)
    assert.equal((await p.status(neverAborted())).state, 'error')
    up = true
    assert.equal((await p.status(neverAborted())).state, 'ready')
  })
})

// ---------------------------------------------------------------------------
// Inventário
// ---------------------------------------------------------------------------

describe('Ollama: inventário de modelos', () => {
  it('lista vazia: respondeu, sem modelos', async () => {
    const fake = await fakeOllama()
    assert.deepEqual(await provider(fake.url).listModels(neverAborted()), [])
  })

  it('modelos instalados: só metadados informados, ids preservados, nada estimado', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({
        models: [
          tag('llama3.2:3b'),
          tag('org/modelo:q4_k_m', { details: {}, capabilities: ['completion', 'vision', 'thinking', 'desconhecida'], size: undefined, digest: undefined })
        ]
      })
    })
    const entries = await provider(fake.url).listModels(neverAborted())
    assert.equal(entries.length, 2)
    const [first, second] = entries
    assert.deepEqual(first, {
      availability: 'installed',
      model: {
        ref: { providerId: 'ollama', modelId: 'llama3.2:3b' },
        digest: 'a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72',
        location: 'local',
        displayName: 'llama3.2:3b',
        family: 'llama',
        parameterSize: '3.2B',
        quantization: 'Q4_K_M',
        format: 'gguf',
        sizeBytes: 2_019_393_189,
        contextLength: 131072,
        contextBytesPerToken: null,
        capabilities: ['chat', 'tools']
      }
    })
    assert.equal(second!.model.ref.modelId, 'org/modelo:q4_k_m')
    assert.deepEqual(second!.model.capabilities, ['chat', 'vision', 'reasoning'])
    for (const field of ['digest', 'family', 'parameterSize', 'quantization', 'format', 'sizeBytes', 'contextLength'] as const) {
      assert.equal(second!.model[field], null, field)
    }
  })

  it('itens inválidos ou repetidos são descartados; modelos de nuvem ficam marcados como remotos', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({
        models: [
          'texto',
          { name: '' },
          { name: ' com-espaco' },
          { name: 'controle\u0007' },
          { name: 'x'.repeat(201) },
          tag('valido:1b', { size: -5, details: { context_length: 'muito', family: 'a'.repeat(500) } }),
          tag('valido:1b'),
          tag('gpt-oss:120b-cloud', { remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' })
        ]
      })
    })
    const entries = await provider(fake.url).listModels(neverAborted())
    assert.deepEqual(
      entries.map((e) => [e.model.ref.modelId, e.model.location]),
      [
        ['valido:1b', 'local'],
        ['gpt-oss:120b-cloud', 'remote']
      ]
    )
    assert.equal(entries[0]!.model.sizeBytes, null)
    assert.equal(entries[0]!.model.contextLength, null)
    assert.equal(entries[0]!.model.family, null)
  })

  it('serviço indisponível: erro provider-unavailable (não é lista vazia)', async () => {
    await assert.rejects(provider(await closedUrl()).listModels(neverAborted()), (e: unknown) => e instanceof InferenceProviderError && e.error.code === 'provider-unavailable')
  })

  it('resposta inválida, HTTP de erro ou grande demais: provider-error', async () => {
    for (const handler of [json({ modelos: [] }), json({ models: 'x' }), stream(['{"models": [']), json({ error: 'falhou' }, 500), json({ models: [tag('a:1b')] })]) {
      const fake = await fakeOllama({ 'GET /api/tags': handler })
      await assert.rejects(provider(fake.url, { limits: { tagsBytes: 100 } }).listModels(neverAborted()), (e: unknown) => e instanceof InferenceProviderError && e.error.code === 'provider-error')
    }
  })
})

// ---------------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------------

describe('Ollama: geração com streaming', () => {
  it('streaming válido: loading → deltas na ordem → done com métricas reais', async () => {
    let t = 0
    const fake = await fakeOllama({ 'POST /api/chat': stream([chunk('Olá'), chunk(', '), chunk('mundo'), chunk(''), final()]) })
    const events = await collect(provider(fake.url, { clock: () => (t += 100), now: () => new Date('2026-10-26T12:00:00.000Z') }).generate(chatRequest(), neverAborted()))
    assert.deepEqual(events.slice(0, -1), [{ type: 'loading' }, { type: 'delta', text: 'Olá' }, { type: 'delta', text: ', ' }, { type: 'delta', text: 'mundo' }])
    assert.deepEqual(events.at(-1), {
      type: 'done',
      finishReason: 'stop',
      metrics: {
        source: 'measured',
        measuredAt: '2026-10-26T12:00:00.000Z',
        loadMs: 1000,
        timeToFirstTokenMs: 100,
        totalMs: 2500,
        promptTokens: 12,
        outputTokens: 20,
        outputTokensPerSecond: 20,
        peakMemoryBytes: null
      }
    })
    for (const e of events) assert.ok(validateInferenceEvent(e).ok)
  })

  it('pedido: modelo, mensagens, streaming e só as opções definidas no perfil', async () => {
    const fake = await fakeOllama({ 'POST /api/chat': stream([final()]) })
    await collect(provider(fake.url).generate(chatRequest(), neverAborted()))
    await collect(
      provider(fake.url).generate(chatRequest('llama3.2:3b', { maxOutputTokens: 64, contextLength: 4096, seed: 7, cpuThreads: 4, gpuMode: 'cpu-only', temperature: 0 }), neverAborted())
    )
    assert.deepEqual(fake.chats[0], {
      model: 'llama3.2:3b',
      messages: [
        { role: 'system', content: 'Seja objetivo.' },
        { role: 'user', content: 'Olá' }
      ],
      stream: true,
      options: { temperature: 0.7, top_p: 0.95 }
    })
    assert.deepEqual((fake.chats[1] as { options: unknown }).options, { temperature: 0, top_p: 0.95, num_predict: 64, num_ctx: 4096, seed: 7, num_thread: 4, num_gpu: 0 })
  })

  it('streaming fragmentado: eventos partidos no meio e UTF-8 dividido entre pacotes', async () => {
    const body = Buffer.from(chunk('ação ') + chunk('é ótima') + final({ done_reason: 'length' }), 'utf8')
    const parts: Buffer[] = []
    for (let i = 0; i < body.length; i += 3) parts.push(body.subarray(i, i + 3))
    const fake = await fakeOllama({ 'POST /api/chat': stream(parts, { delayMs: 0 }) })
    const events = await collect(provider(fake.url).generate(chatRequest(), neverAborted()))
    assert.equal(events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join(''), 'ação é ótima')
    const done = events.at(-1)
    assert.ok(done?.type === 'done' && done.finishReason === 'length')
  })

  it('texto grande num evento é dividido no limite de cada delta', async () => {
    const fake = await fakeOllama({ 'POST /api/chat': stream([chunk('a'.repeat(70_000)), final()]) })
    const events = await collect(provider(fake.url).generate(chatRequest(), neverAborted()))
    const deltas = events.flatMap((e) => (e.type === 'delta' ? [e.text.length] : []))
    assert.deepEqual(deltas, [65_536, 70_000 - 65_536])
  })

  it('sem estatísticas no fim: métricas null (nada fabricado)', async () => {
    const fake = await fakeOllama({ 'POST /api/chat': stream([line({ done: true })]) })
    const events = await collect(provider(fake.url).generate(chatRequest(), neverAborted()))
    assert.deepEqual(events.at(-1), { type: 'done', finishReason: 'stop', metrics: null })
  })

  it('estatísticas inválidas são ignoradas campo a campo', async () => {
    const fake = await fakeOllama({ 'POST /api/chat': stream([chunk('x'), final({ load_duration: -1, eval_count: 1.5, total_duration: 'muito' })]) })
    const done = (await collect(provider(fake.url).generate(chatRequest(), neverAborted()))).at(-1)
    assert.ok(done?.type === 'done' && done.metrics)
    assert.equal(done.metrics.loadMs, null)
    assert.equal(done.metrics.outputTokens, null)
    assert.equal(done.metrics.outputTokensPerSecond, null)
    assert.equal(done.metrics.totalMs, null)
    assert.equal(done.metrics.promptTokens, 12)
  })

  it('modelo inexistente: model-not-found', async () => {
    const fake = await fakeOllama({ 'POST /api/chat': json({ error: "model 'nao-existe:1b' not found" }, 404) })
    const events = await collect(provider(fake.url).generate(chatRequest('nao-existe:1b'), neverAborted()))
    assert.equal(errorCode(events), 'model-not-found')
  })

  it('erros HTTP do Ollama viram códigos de inferência', async () => {
    const cases: Array<[Handler, string]> = [
      [json({ error: 'model requires more system memory (9.1 GiB) than is available (4.0 GiB)' }, 500), 'insufficient-memory'],
      [json({ error: 'input length exceeds the context length' }, 400), 'context-too-long'],
      [json({ error: 'unknown model architecture: xyz' }, 500), 'model-unsupported'],
      [json({ error: 'invalid options' }, 400), 'invalid-request'],
      [json({ error: 'falha' }, 500), 'provider-error'],
      [stream(['<html>erro</html>'], { status: 502 }), 'provider-error']
    ]
    for (const [handler, code] of cases) {
      const fake = await fakeOllama({ 'POST /api/chat': handler })
      assert.equal(errorCode(await collect(provider(fake.url).generate(chatRequest(), neverAborted()))), code)
    }
  })

  it('mensagem de erro do provedor é saneada e limitada', async () => {
    const fake = await fakeOllama({ 'POST /api/chat': json({ error: `linha1\nlinha2\u0000${'x'.repeat(5000)}` }, 500) })
    const last = (await collect(provider(fake.url).generate(chatRequest(), neverAborted()))).at(-1)
    assert.ok(last?.type === 'error')
    assert.doesNotMatch(last.error.message, /[\x00-\x1f]/)
    assert.ok(last.error.message.length < 500)
  })

  it('evento malformado: provider-error e a geração para', async () => {
    for (const bad of ['{não é json}\n', line([1, 2]), line({ done: 'sim' }), line({ message: 'texto', done: false }), line({ message: { content: 5 }, done: false }), line({ error: 42 })]) {
      const fake = await fakeOllama({ 'POST /api/chat': stream([chunk('antes '), bad, chunk('depois'), final()]) })
      const events = await collect(provider(fake.url).generate(chatRequest(), neverAborted()))
      assert.equal(errorCode(events), 'provider-error', bad)
      assert.ok(!events.some((e) => e.type === 'delta' && e.text === 'depois'))
    }
  })

  it('erro no meio do streaming: código classificado', async () => {
    const fake = await fakeOllama({ 'POST /api/chat': stream([chunk('a'), line({ error: 'CUDA error: out of memory' })]) })
    assert.equal(errorCode(await collect(provider(fake.url).generate(chatRequest(), neverAborted()))), 'insufficient-memory')
  })

  it('conexão encerrada antes do fim: provider-error', async () => {
    const fake = await fakeOllama({ 'POST /api/chat': stream([chunk('metade')]) })
    assert.equal(errorCode(await collect(provider(fake.url).generate(chatRequest(), neverAborted()))), 'provider-error')
  })

  it('conexão derrubada no meio: erro, sem travar', async () => {
    const fake = await fakeOllama({
      'POST /api/chat': async (_req, res) => {
        res.writeHead(200)
        res.write(chunk('a'))
        await wait(10)
        res.destroy()
      }
    })
    const events = await collect(provider(fake.url).generate(chatRequest(), neverAborted()))
    assert.ok(['provider-error', 'provider-unavailable'].includes(errorCode(events)!))
  })

  it('serviço indisponível: provider-unavailable', async () => {
    assert.equal(errorCode(await collect(provider(await closedUrl()).generate(chatRequest(), neverAborted()))), 'provider-unavailable')
  })

  it('limites de resposta: linha e corpo grandes demais viram provider-error', async () => {
    const longLine = await fakeOllama({ 'POST /api/chat': stream([chunk('x'.repeat(2_000))], { end: false }) })
    assert.equal(errorCode(await collect(provider(longLine.url, { limits: { lineBytes: 1_000 } }).generate(chatRequest(), neverAborted()))), 'provider-error')
    const longBody = await fakeOllama({ 'POST /api/chat': stream(Array.from({ length: 50 }, () => chunk('y'.repeat(100))), { end: false }) })
    assert.equal(errorCode(await collect(provider(longBody.url, { limits: { streamBytes: 2_000 } }).generate(chatRequest(), neverAborted()))), 'provider-error')
    await wait(50)
    assert.equal(longBody.aborted, 1, 'a conexão é liberada')
  })

  it('cancelamento: para de emitir e fecha a conexão', async () => {
    const fake = await fakeOllama({ 'POST /api/chat': stream(Array.from({ length: 200 }, (_, i) => chunk(`${i} `)), { delayMs: 10 }) })
    const controller = new AbortController()
    const events: InferenceEvent[] = []
    for await (const event of provider(fake.url).generate(chatRequest(), controller.signal)) {
      events.push(event)
      if (events.filter((e) => e.type === 'delta').length === 3) controller.abort()
    }
    assert.equal(events.filter((e) => e.type === 'delta').length, 3)
    assert.ok(!events.some((e) => e.type === 'done' || e.type === 'error'))
    await wait(50)
    assert.equal(fake.aborted, 1)
  })

  it('pedido inválido não chega ao serviço', async () => {
    const fake = await fakeOllama()
    assert.equal(errorCode(await collect(provider(fake.url).generate({ ...chatRequest(), model: { providerId: 'outro', modelId: 'x' } }, neverAborted()))), 'model-not-found')
    assert.equal(errorCode(await collect(provider(fake.url).generate(chatRequest(' espaço'), neverAborted()))), 'invalid-request')
    assert.equal(fake.chats.length, 0)
  })
})

// ---------------------------------------------------------------------------
// RunService com o adaptador real
// ---------------------------------------------------------------------------

const definition = (profile: Partial<ExecutionProfile> = {}): AgentDefinition => ({
  ...agentDraft({ defaultModel: { providerId: null, modelId: 'llama3.2:3b' }, defaultProfile: { ...DEFAULT_EXECUTION_PROFILE, ...profile } }),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

function setupRuns(url: string, options: { profile?: Partial<ExecutionProfile>; outputChars?: number } = {}) {
  const scheduler = new VirtualScheduler()
  let n = 0
  const agent = definition(options.profile)
  const service = new RunService({
    providers: [new SimulatedInferenceProvider({ scheduler, stepDelayMs: 10, now: scheduler.now }), provider(url)],
    findAgent: (id) => (id === agent.id ? agent : undefined),
    scheduler,
    now: scheduler.now,
    newId: () => `run-${++n}`,
    limits: options.outputChars ? { outputChars: options.outputChars } : {}
  })
  after(() => service.dispose())
  return { scheduler, service }
}

/** Espera (em tempo real) a execução chegar a um estado terminal. */
async function settled(service: RunService, id: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = service.get(id)!
    if (['completed', 'failed', 'cancelled'].includes(run.state)) return run
    if (Date.now() > deadline) throw new Error(`execução ${id} não terminou (${run.state})`)
    await wait(5)
  }
}

const runRequest = (modelId: string | null = null, providerId: string | null = null) => ({
  agentId: 'assistente-geral',
  input: 'Olá',
  overrides: modelId ? { model: { providerId, modelId }, profile: null } : null
})

const isInference = (code: string) => (e: unknown) => e instanceof AppError && e.code === 'inference' && e.details?.['inferenceCode'] === code

describe('RunService + Ollama', () => {
  it('execução real: texto completo, origem real, modelo resolvido no Ollama e métricas medidas', async () => {
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.2:3b')] }), 'POST /api/chat': stream([chunk('Olá'), chunk(' mundo'), final()]) })
    const { service } = setupRuns(fake.url)
    const started = await service.start(runRequest())
    assert.equal(started.origin, 'real')
    assert.deepEqual(started.execution?.model, { providerId: 'ollama', modelId: 'llama3.2:3b' })
    const run = await settled(service, started.id)
    assert.equal(run.state, 'completed')
    assert.equal(run.output, 'Olá mundo')
    assert.equal(run.metrics?.source, 'measured')
    assert.equal(run.metrics?.outputTokens, 20)
    assert.ok(!run.messages.some((m) => /simulad/i.test(m.text)))
  })

  it('real × simulado: a origem decorre do provedor efetivamente usado', async () => {
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.2:3b')] }), 'POST /api/chat': stream([chunk('real'), final()]) })
    const { scheduler, service } = setupRuns(fake.url)
    const simulated = await service.start(runRequest('resposta-curta', SIMULATED_PROVIDER_ID))
    await scheduler.advance(100)
    const sim = await settled(service, simulated.id)
    assert.equal(sim.origin, 'simulated')
    assert.equal(sim.metrics, null)

    const real = await settled(service, (await service.start(runRequest('llama3.2:3b', 'ollama'))).id)
    assert.equal(real.origin, 'real')
    assert.notEqual(real.metrics, null)
    assert.equal(fake.chats.length, 1, 'só a execução real chega ao Ollama')
  })

  it('capabilities: motor real só disponível depois que o Ollama respondeu; simulação não conta', async () => {
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.2:3b')] }) })
    const { service } = setupRuns(fake.url)
    assert.deepEqual(service.capabilities(), { infrastructure: 'functional', simulation: 'available', realEngine: 'unavailable' })
    await service.refreshProviders()
    assert.equal(service.capabilities().realEngine, 'available')
    assert.equal(service.canRunReal({ providerId: null, modelId: 'llama3.2:3b' }), true)
    assert.equal(service.canRunReal({ providerId: null, modelId: 'outro:1b' }), false)
    assert.equal(service.canRunReal({ providerId: SIMULATED_PROVIDER_ID, modelId: 'resposta-curta' }), false)

    const overview = await service.providers()
    const ollama = overview.find((p) => p.info.id === 'ollama')!
    assert.equal(ollama.status.state, 'ready')
    assert.deepEqual(ollama.models?.map((m) => m.model.ref.modelId), ['llama3.2:3b'])
  })

  it('Ollama desligado: app segue funcionando, motor indisponível e erro provider-unavailable (não "não instalado")', async () => {
    const { scheduler, service } = setupRuns(await closedUrl())
    await service.refreshProviders()
    assert.equal(service.capabilities().realEngine, 'unavailable')
    const overview = await service.providers()
    const ollama = overview.find((p) => p.info.id === 'ollama')!
    assert.equal(ollama.status.state, 'unreachable')
    assert.equal(ollama.models, null)

    await assert.rejects(service.start(runRequest()), isInference('provider-unavailable'))
    await assert.rejects(service.start(runRequest('llama3.2:3b', 'ollama')), isInference('provider-unavailable'))
    // A simulação continua.
    const sim = await service.start(runRequest('resposta-curta', SIMULATED_PROVIDER_ID))
    await scheduler.advance(100)
    assert.equal((await settled(service, sim.id)).state, 'completed')
  })

  it('serviço sem modelos e modelo não instalado: model-not-found', async () => {
    const fake = await fakeOllama()
    const { service } = setupRuns(fake.url)
    await assert.rejects(service.start(runRequest()), isInference('model-not-found'))
    await assert.rejects(service.start(runRequest('outro:1b', 'ollama')), isInference('model-not-found'))
  })

  it('modelo de nuvem listado pelo Ollama não pode ser executado como local', async () => {
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.2:3b', { remote_host: 'https://ollama.com:443' })] }) })
    const { service } = setupRuns(fake.url)
    await assert.rejects(service.start(runRequest()), isInference('model-not-found'))
    assert.equal(fake.chats.length, 0)
  })

  it('cancelamento: execução cancelada na hora, conexão fechada e fila liberada', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('llama3.2:3b')] }),
      'POST /api/chat': stream(Array.from({ length: 500 }, () => chunk('.')), { delayMs: 10 })
    })
    const { service } = setupRuns(fake.url)
    const first = await service.start(runRequest())
    const second = await service.start(runRequest())
    assert.equal(service.get(second.id)!.state, 'pending')
    while (!service.get(first.id)!.output) await wait(5)
    assert.equal(service.cancel(first.id).state, 'cancelled')
    await wait(50)
    assert.ok(fake.aborted >= 1)
    assert.equal(service.get(first.id)!.state, 'cancelled', 'finalização única')
    // A próxima execução começa.
    while (service.get(second.id)!.state === 'pending') await wait(5)
    service.cancel(second.id)
  })

  it('tempo limite: falha com timeout, aborta a conexão e libera a fila', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('llama3.2:3b')] }),
      'POST /api/chat': stream([chunk('lento')], { end: false })
    })
    const { scheduler, service } = setupRuns(fake.url, { profile: { timeoutSeconds: 30 } })
    const run = await service.start(runRequest())
    while (!service.get(run.id)!.output) await wait(5)
    await scheduler.advance(30_000)
    const failed = service.get(run.id)!
    assert.equal(failed.state, 'failed')
    assert.equal(failed.error?.details?.['inferenceCode'], 'timeout')
    assert.equal(failed.output, 'lento')
    await wait(50)
    assert.equal(fake.aborted, 1)

    const next = await service.start(runRequest('resposta-curta', SIMULATED_PROVIDER_ID))
    await scheduler.advance(100)
    assert.equal((await settled(service, next.id)).state, 'completed')
  })

  it('limite de saída do RunService interrompe o streaming do Ollama', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('llama3.2:3b')] }),
      'POST /api/chat': stream(Array.from({ length: 200 }, () => chunk('0123456789')), { delayMs: 2 })
    })
    const { service } = setupRuns(fake.url, { outputChars: 25 })
    const run = await settled(service, (await service.start(runRequest())).id)
    assert.equal(run.state, 'completed')
    assert.equal(run.output.length, 25)
    await wait(50)
    assert.equal(fake.aborted, 1)
  })

  it('erro do Ollama durante a execução vira falha estruturada', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('llama3.2:3b')] }),
      'POST /api/chat': json({ error: 'model requires more system memory (9 GiB) than is available (4 GiB)' }, 500)
    })
    const { service } = setupRuns(fake.url)
    const run = await settled(service, (await service.start(runRequest())).id)
    assert.equal(run.state, 'failed')
    assert.equal(run.origin, 'real')
    assert.equal(run.error?.code, 'inference')
    assert.equal(run.error?.details?.['inferenceCode'], 'insufficient-memory')
    assert.equal(run.error?.retryable, true)
  })

  it('recuperação: Ollama volta a responder e a próxima verificação o reconhece', async () => {
    let up = false
    const fake = await fakeOllama({
      'GET /api/version': (req, res, body) => (up ? json({ version: '0.40.10' })(req, res, body) : void res.writeHead(503).end()),
      'GET /api/tags': json({ models: [tag('llama3.2:3b')] })
    })
    const { service } = setupRuns(fake.url)
    await service.refreshProviders()
    assert.equal(service.capabilities().realEngine, 'unavailable')
    up = true
    await service.refreshProviders()
    assert.equal(service.capabilities().realEngine, 'available')
  })
})

// ---------------------------------------------------------------------------
// Montagem dos serviços e IPC
// ---------------------------------------------------------------------------

describe('Serviços: adaptador Ollama registrado', () => {
  it('providers:list reflete o estado real; agente só fica disponível com o modelo instalado', async () => {
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.2:3b')] }) })
    const services = await createServices(await tempDir(), { stepDelayMs: 1, ollamaBaseUrl: fake.url })
    try {
      const handlers = createDataHandlers(services)
      const listed = await invokeHandler('x', handlers[IpcChannels.providersList], [])
      assert.ok(listed.ok)
      const overview = listed.data as ProviderOverview[]
      assert.deepEqual(overview.map((p) => [p.info.id, p.info.kind, p.status.state]), [
        ['simulado', 'simulated', 'ready'],
        ['ollama', 'external', 'ready']
      ])
      assert.equal(services.runs.capabilities().realEngine, 'available')

      const create = handlers[IpcChannels.agentsCreate]
      await invokeHandler('x', create, [agentDraft({ id: 'com-modelo', tools: [], defaultModel: { providerId: null, modelId: 'llama3.2:3b' } })])
      await invokeHandler('x', create, [agentDraft({ id: 'sem-modelo', tools: [], defaultModel: { providerId: null, modelId: 'nao-instalado:1b' } })])
      const agents = await invokeHandler('x', handlers[IpcChannels.agentsList], [])
      assert.ok(agents.ok)
      const byId = new Map((agents.data as AgentRecord[]).map((a) => [a.definition.id, a.availability]))
      assert.equal(byId.get('com-modelo')?.status, 'available')
      assert.ok(byId.get('sem-modelo')?.issues.some((i) => i.code === 'engine-unavailable'))
    } finally {
      services.runs.dispose()
    }
  })

  it('sem endereço do Ollama, o adaptador não é registrado (testes não dependem de um Ollama instalado)', async () => {
    const services = await createServices(await tempDir(), { stepDelayMs: 1 })
    try {
      assert.deepEqual((await services.runs.providers()).map((p) => p.info.id), ['simulado'])
    } finally {
      services.runs.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Homologação: lacunas de cancelamento, eventos incompletos e respostas vazias
// ---------------------------------------------------------------------------

describe('Homologação: cancelamento, eventos incompletos e respostas vazias', () => {
  it('cancelamento durante a conexão (antes da resposta): nada é emitido depois e a conexão é fechada', async () => {
    let received = 0
    const fake = await fakeOllama({ 'POST /api/chat': () => void received++ })
    const controller = new AbortController()
    const events: InferenceEvent[] = []
    const consuming = (async () => {
      for await (const event of provider(fake.url).generate(chatRequest(), controller.signal)) events.push(event)
    })()
    while (received === 0) await wait(5)
    controller.abort()
    await consuming
    assert.deepEqual(events, [{ type: 'loading' }])
    await wait(50)
    assert.equal(fake.aborted, 1)
  })

  it('evento incompleto no fim do corpo: provider-error, nunca texto parcial aceito como resposta', async () => {
    const fake = await fakeOllama({ 'POST /api/chat': stream([chunk('início '), '{"message":{"content":"meta'], { end: true }) })
    const events = await collect(provider(fake.url).generate(chatRequest(), neverAborted()))
    assert.equal(errorCode(events), 'provider-error')
    assert.ok(!events.some((e) => e.type === 'done'))
  })

  it('RunService: cancelamento durante a conexão finaliza uma vez e não emite mais nada', async () => {
    let received = 0
    const fake = await fakeOllama({ 'GET /api/tags': json({ models: [tag('llama3.2:3b')] }), 'POST /api/chat': () => void received++ })
    const { service } = setupRuns(fake.url)
    const updates: string[] = []
    service.onUpdate((run) => updates.push(`${run.id}:${run.state}`))
    const run = await service.start(runRequest())
    while (received === 0) await wait(5)
    service.cancel(run.id)
    const after = updates.length
    await wait(100)
    assert.equal(updates.length, after, 'nenhum evento depois da finalização')
    assert.equal(updates.filter((u) => u === `${run.id}:cancelled`).length, 1)
    assert.equal(fake.aborted, 1)
  })

  it('RunService: streaming continua no servidor após o cancelamento, mas nenhum fragmento chega ao registro', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('llama3.2:3b')] }),
      'POST /api/chat': stream(Array.from({ length: 300 }, () => chunk('x')), { delayMs: 2 })
    })
    const { service } = setupRuns(fake.url)
    const updates: number[] = []
    service.onUpdate((run) => updates.push(run.revision))
    const run = await service.start(runRequest())
    while (!service.get(run.id)!.output) await wait(2)
    const cancelled = service.cancel(run.id)
    const count = updates.length
    await wait(100)
    assert.equal(updates.length, count)
    assert.equal(service.get(run.id)!.output, cancelled.output)
    assert.equal(service.get(run.id)!.revision, cancelled.revision)
  })

  it('RunService: limite de tokens atingido sem texto não é conclusão bem-sucedida', async () => {
    // Modelo com raciocínio: o Ollama manda o raciocínio em `message.thinking`, fora da resposta.
    const thinking = (t: string) => line({ message: { role: 'assistant', content: '', thinking: t }, done: false })
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('qwen3:8b', { capabilities: ['completion', 'thinking'] })] }),
      'POST /api/chat': stream([thinking('Vou pensar '), thinking('mais um pouco'), final({ done_reason: 'length', eval_count: 40 })])
    })
    const { service } = setupRuns(fake.url, { profile: { maxOutputTokens: 40 } })
    const run = await settled(service, (await service.start(runRequest('qwen3:8b', 'ollama'))).id)
    assert.equal(run.state, 'failed')
    assert.equal(run.output, '', 'o raciocínio não vira resposta')
    assert.equal(run.error?.details?.['inferenceCode'], 'invalid-request')
    assert.match(run.error!.message, /40 tokens/)
    assert.equal(run.metrics?.outputTokens, 40, 'métricas reais preservadas')
  })

  it('RunService: limite atingido com texto conclui com aviso e o texto parcial', async () => {
    const fake = await fakeOllama({
      'GET /api/tags': json({ models: [tag('llama3.2:3b')] }),
      'POST /api/chat': stream([chunk('resposta cortada'), final({ done_reason: 'length' })])
    })
    const { service } = setupRuns(fake.url, { profile: { maxOutputTokens: 4 } })
    const run = await settled(service, (await service.start(runRequest())).id)
    assert.equal(run.state, 'completed')
    assert.equal(run.output, 'resposta cortada')
    assert.ok(run.messages.some((m) => m.level === 'warning' && /limite de saída/.test(m.text)))
  })
})

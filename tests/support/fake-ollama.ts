import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after } from 'node:test'

// ---------------------------------------------------------------------------
// Servidor HTTP que imita o Ollama (nenhum Ollama real é usado)
// ---------------------------------------------------------------------------

export type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>

export interface FakeOllama {
  url: string
  /** Rotas `MÉTODO /caminho`; rota ausente responde 404. */
  routes: Map<string, Handler>
  /** Corpos JSON recebidos em `/api/chat`. */
  chats: unknown[]
  /** Quantas conexões de `/api/chat` foram fechadas pelo cliente antes do fim. */
  aborted: number
  close(): Promise<void>
}

export async function fakeOllama(routes: Record<string, Handler> = {}): Promise<FakeOllama> {
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

export const json =
  (body: unknown, status = 200): Handler =>
  (_req, res) =>
    void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Envia partes do corpo com pausa entre elas; `end: false` deixa a conexão aberta. */
export const stream =
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

export const line = (value: unknown) => `${JSON.stringify(value)}\n`
export const chunk = (content: string) => line({ model: 'llama3.2:3b', created_at: '2026-10-26T12:00:00Z', message: { role: 'assistant', content }, done: false })
export const final = (extra: Record<string, unknown> = {}) =>
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
export async function closedUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

export const tag = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  model: name,
  modified_at: '2026-06-02T12:41:34.1374155-03:00',
  size: 2_019_393_189,
  digest: 'a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72',
  details: { parent_model: '', format: 'gguf', family: 'llama', families: ['llama'], parameter_size: '3.2B', quantization_level: 'Q4_K_M', context_length: 131072 },
  capabilities: ['completion', 'tools'],
  ...extra
})

/**
 * HTTP para provedores que rodam NESTE computador.
 *
 * Só aceita endereços de loopback (`127.0.0.1`, `localhost`, `[::1]`) por
 * `http:`; redirecionamentos são recusados, para que uma resposta não leve a
 * requisição para outro host. Corpos são lidos com limite de bytes, inteiros
 * ou linha a linha (NDJSON). Nada aqui conhece um provedor específico.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Valida o endereço de um serviço local e devolve sua origem
 * (ex.: `http://127.0.0.1:11434`). Lança erro para qualquer outra coisa.
 */
export function parseLoopbackUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`Endereço inválido: ${input}`)
  }
  if (url.protocol !== 'http:') throw new Error('Só o protocolo http é aceito para serviços locais.')
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error(`Só endereços deste computador são aceitos (recebido: ${url.hostname}).`)
  if (url.username || url.password) throw new Error('O endereço não pode conter usuário ou senha.')
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('Informe só protocolo, host e porta.')
  }
  return url.origin
}

/**
 * - `unreachable`: conexão recusada ou rede local indisponível;
 * - `timeout`: o prazo da própria requisição esgotou;
 * - `aborted`: quem chamou cancelou;
 * - `too-large`: o corpo passou do limite;
 * - `invalid-body`: corpo ilegível (texto ou JSON inválido).
 */
export type LocalHttpErrorKind = 'unreachable' | 'timeout' | 'aborted' | 'too-large' | 'invalid-body'

export class LocalHttpError extends Error {
  readonly kind: LocalHttpErrorKind

  constructor(kind: LocalHttpErrorKind, message: string) {
    super(message)
    this.name = 'LocalHttpError'
    this.kind = kind
  }
}

export interface LocalRequest {
  method: 'GET' | 'POST'
  /** Serializado como JSON. */
  body?: unknown
  signal: AbortSignal
  /** Prazo da requisição inteira (inclui a leitura do corpo). */
  timeoutMs?: number
}

/**
 * Faz a requisição e devolve a resposta sem ler o corpo. O sinal devolvido
 * deve ser repassado às leituras, para que cancelamento e prazo valham
 * também durante o streaming.
 */
export async function localFetch(origin: string, path: string, request: LocalRequest): Promise<{ response: Response; signal: AbortSignal }> {
  const timeout = request.timeoutMs === undefined ? null : AbortSignal.timeout(request.timeoutMs)
  const signal = timeout ? AbortSignal.any([request.signal, timeout]) : request.signal
  try {
    const response = await fetch(new URL(path, origin), {
      method: request.method,
      headers: request.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: 'error',
      signal
    })
    return { response, signal }
  } catch (error) {
    throw toLocalHttpError(error, request.signal, timeout)
  }
}

/** Lê o corpo inteiro como texto, até `maxBytes`. */
export async function readText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  let text = ''
  for await (const chunk of decodeChunks(response, signal)) {
    text += chunk
    if (text.length > maxBytes) throw new LocalHttpError('too-large', `Resposta maior que ${maxBytes} bytes.`)
  }
  return text
}

export async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const text = await readText(response, maxBytes, signal)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new LocalHttpError('invalid-body', 'Resposta não é JSON válido.')
  }
}

/**
 * Entrega o corpo linha a linha (NDJSON), na ordem de chegada, sem as linhas
 * vazias. Cada linha tem no máximo `maxLineBytes`; o corpo, `maxTotalBytes`.
 */
export async function* readLines(
  response: Response,
  limits: { maxLineBytes: number; maxTotalBytes: number },
  signal: AbortSignal
): AsyncGenerator<string> {
  let pending = ''
  let total = 0
  for await (const chunk of decodeChunks(response, signal)) {
    total += chunk.length
    if (total > limits.maxTotalBytes) throw new LocalHttpError('too-large', `Resposta maior que ${limits.maxTotalBytes} bytes.`)
    pending += chunk
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      if (line.length > limits.maxLineBytes) throw new LocalHttpError('too-large', `Linha maior que ${limits.maxLineBytes} bytes.`)
      if (line) yield line
    }
    if (pending.length > limits.maxLineBytes) throw new LocalHttpError('too-large', `Linha maior que ${limits.maxLineBytes} bytes.`)
  }
  const last = pending.trim()
  if (last) yield last
}

/**
 * Decodifica o corpo em UTF-8 por partes. O tamanho é contado em unidades de
 * texto decodificado, um limite tão restritivo quanto bytes para a proteção
 * desejada (memória). Sempre libera a conexão ao terminar ou falhar.
 */
async function* decodeChunks(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for (;;) {
      const result = await reader.read().catch((error: unknown) => {
        throw toLocalHttpError(error, signal, null)
      })
      if (result.done) break
      yield decodeOrThrow(decoder, result.value, true)
    }
    const tail = decodeOrThrow(decoder, undefined, false)
    if (tail) yield tail
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

function decodeOrThrow(decoder: TextDecoder, bytes: Uint8Array | undefined, stream: boolean): string {
  try {
    return decoder.decode(bytes, { stream })
  } catch {
    throw new LocalHttpError('invalid-body', 'Resposta não é texto UTF-8 válido.')
  }
}

function toLocalHttpError(error: unknown, callerSignal: AbortSignal, timeout: AbortSignal | null): LocalHttpError {
  if (error instanceof LocalHttpError) return error
  // O sinal combinado carrega o motivo do prazo (`TimeoutError`) quando é ele que dispara.
  const fired = callerSignal.aborted ? callerSignal : timeout?.aborted ? timeout : null
  if (fired) {
    return isTimeout(fired.reason)
      ? new LocalHttpError('timeout', 'O serviço local não respondeu a tempo.')
      : new LocalHttpError('aborted', 'Requisição cancelada.')
  }
  return new LocalHttpError('unreachable', 'Não foi possível conectar ao serviço local.')
}

const isTimeout = (reason: unknown) => reason instanceof DOMException && reason.name === 'TimeoutError'

import type { HelperRunResult } from '../bundled-helper'
import {
  DESCRIPTION_REJECT,
  DESCRIPTION_STRIP,
  DXCORE_EXIT_CODES,
  DXCORE_LIMITS,
  DXCORE_PROTOCOL,
  DXCORE_PROTOCOL_VERSION,
  DXCORE_WIRE_ADAPTER_KEYS,
  DXCORE_WIRE_RESPONSE_KEYS,
  LUID_PATTERN,
  UINT64_DECIMAL_PATTERN,
  UINT64_MAX,
  type DxcoreAdapter,
  type DxcoreParseResult,
  type DxcoreResponseError,
  type DxcoreSourceStatus
} from '../dxcore-contract'

/**
 * Parser estrito da resposta do auxiliar DXCore (protocolo 1, D54).
 *
 * Qualquer violação recusa a resposta INTEIRA, com um único motivo; nada é
 * aproveitado parcialmente. Inteiros de 64 bits só passam por `BigInt` depois
 * de conferido o formato decimal, e nunca por `Number`/`parseInt`. A
 * descrição é sanitizada aqui e só serve para exibição.
 *
 * Nada é gravado nem registrado: o resultado fica em memória, e os erros são
 * só códigos.
 */

class Rejected extends Error {
  readonly reason: DxcoreResponseError
  constructor(reason: DxcoreResponseError) {
    super(reason)
    this.reason = reason
  }
}
const reject = (reason: DxcoreResponseError): never => {
  throw new Rejected(reason)
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

/** Inteiro de 64 bits sem sinal em decimal → `bigint`; `null` se fora do formato ou acima de 2^64−1. */
export function parseUint64(text: string): bigint | null {
  if (!UINT64_DECIMAL_PATTERN.test(text)) return null
  const value = BigInt(text)
  return value <= UINT64_MAX ? value : null
}

/** Descrição comercial para exibição: sem controles e invisíveis; `null` se vazia ou se parecer caminho ou identificador. */
export function sanitizeDescription(raw: string): string | null {
  const text = raw
    .replace(DESCRIPTION_STRIP, ' ')
    .replace(/\p{Cs}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '' || DESCRIPTION_REJECT.some((re) => re.test(text))) return null
  return text
}

/** Número do protocolo na forma canônica: inteiro decimal sem sinal, fração, expoente ou zero à esquerda. */
const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/

/**
 * Leitura do texto que o `JSON.parse` não oferece: chave repetida no mesmo
 * objeto (o `JSON.parse` fica com a última) e número fora da forma canônica
 * (`-0`, `1.0`, `4.318e3`, `4318.0000000000000001` viram inteiros válidos
 * depois do `JSON.parse`, alguns arredondados). Roda só sobre JSON já
 * validado pelo `JSON.parse`, então basta separar textos de estrutura; é
 * iterativa (sem recursão), então a profundidade não esgota a pilha.
 */
function scanText(json: string): { duplicateKey: boolean; nonCanonicalNumber: boolean } {
  const frames: Array<Set<string> | null> = []
  let nonCanonicalNumber = false
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i
      while (j < json.length && /[-+.eE0-9]/.test(json[j]!)) j++
      if (!CANONICAL_INTEGER.test(json.slice(i, j))) nonCanonicalNumber = true
      i = j - 1
    } else if (c === '{') frames.push(new Set())
    else if (c === '[') frames.push(null)
    else if (c === '}' || c === ']') frames.pop()
    else if (c === '"') {
      let j = i + 1
      while (json[j] !== '"') j += json[j] === '\\' ? 2 : 1
      const text = json.slice(i, j + 1)
      i = j
      let k = j + 1
      while (/\s/.test(json[k] ?? '')) k++
      const frame = frames[frames.length - 1]
      if (json[k] === ':' && frame) {
        const key = JSON.parse(text) as string
        if (frame.has(key)) return { duplicateKey: true, nonCanonicalNumber }
        frame.add(key)
      }
    }
  }
  return { duplicateKey: false, nonCanonicalNumber }
}

function checkKeys(o: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(o)
  if (keys.some((k) => !expected.includes(k))) reject('unknown-field')
  if (expected.some((k) => !Object.prototype.hasOwnProperty.call(o, k))) reject('missing-field')
}

const nullable = <T>(v: unknown, read: (v: unknown) => T): T | null => (v === null ? null : read(v))

const readBoolean = (v: unknown): boolean => (typeof v === 'boolean' ? v : reject('invalid-type'))

const readHardwareId = (v: unknown): number => {
  if (typeof v !== 'number') return reject('invalid-type')
  return Number.isInteger(v) && v >= 0 && v <= DXCORE_LIMITS.maxHardwareId ? v : reject('invalid-hardware-id')
}

const readLuid = (v: unknown): string => {
  if (typeof v !== 'string') return reject('invalid-type')
  return LUID_PATTERN.test(v) ? v : reject('invalid-luid')
}

const readMemory = (v: unknown): bigint => {
  // Número JSON é recusado mesmo pequeno: o protocolo exige texto decimal.
  if (typeof v !== 'string') return reject('invalid-type')
  return parseUint64(v) ?? reject('invalid-uint64')
}

/** Descrição validada e sanitizada; acima do limite, a resposta é recusada. */
const readDescription = (v: unknown): string | null => {
  if (typeof v !== 'string') return reject('invalid-type')
  if (v.length > DXCORE_LIMITS.maxDescriptionLength) return reject('invalid-description')
  return sanitizeDescription(v)
}

function readAdapter(raw: unknown): DxcoreAdapter {
  if (!isPlainObject(raw)) return reject('invalid-type')
  checkKeys(raw, DXCORE_WIRE_ADAPTER_KEYS)
  return {
    luid: nullable(raw['luid'], readLuid),
    vendorId: nullable(raw['vendorId'], readHardwareId),
    deviceId: nullable(raw['deviceId'], readHardwareId),
    description: raw['description'] === null ? null : readDescription(raw['description']),
    isHardware: nullable(raw['isHardware'], readBoolean),
    isIntegrated: nullable(raw['isIntegrated'], readBoolean),
    dedicatedAdapterMemory: nullable(raw['dedicatedAdapterMemory'], readMemory),
    dedicatedSystemMemory: nullable(raw['dedicatedSystemMemory'], readMemory),
    sharedSystemMemory: nullable(raw['sharedSystemMemory'], readMemory)
  }
}

/** Resposta do auxiliar (saída padrão com código 0) → adaptadores validados, ou o motivo da recusa. */
export function parseDxcoreResponse(stdout: string): DxcoreParseResult {
  try {
    if (Buffer.byteLength(stdout, 'utf8') > DXCORE_LIMITS.maxOutputBytes) reject('output-too-large')
    if (/[^\x00-\x7f]/.test(stdout)) reject('non-ascii')
    // Uma única quebra de linha final é permitida.
    const body = stdout.replace(/\r?\n$/, '')
    if (body.trim() === '') reject('empty-output')
    // Só o objeto: espaços antes, depois ou outra quebra de linha recusam.
    if (body !== body.trim()) reject('not-json')
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch {
      return reject('not-json')
    }
    if (!isPlainObject(value)) reject('not-object')
    const top = value as Record<string, unknown>
    const text = scanText(body)
    if (text.duplicateKey) reject('duplicate-field')
    // Protocolo e versão antes do conjunto de chaves: uma versão futura com
    // campos novos é `unsupported-version`, não `unknown-field`.
    if (!Object.prototype.hasOwnProperty.call(top, 'protocol') || !Object.prototype.hasOwnProperty.call(top, 'version')) reject('missing-field')
    if (typeof top['protocol'] !== 'string') reject('invalid-type')
    if (top['protocol'] !== DXCORE_PROTOCOL) reject('protocol-mismatch')
    if (typeof top['version'] !== 'number') reject('invalid-type')
    if (top['version'] !== DXCORE_PROTOCOL_VERSION) reject('unsupported-version')
    checkKeys(top, DXCORE_WIRE_RESPONSE_KEYS)
    const list = top['adapters']
    if (!Array.isArray(list)) return reject('invalid-type')
    if (list.length > DXCORE_LIMITS.maxAdapters) reject('too-many-adapters')
    const adapters = list.map(readAdapter)
    // Por último, para não mudar o motivo das demais recusas: um número que
    // só passou por ter sido normalizado pelo `JSON.parse` recusa a resposta.
    if (text.nonCanonicalNumber) reject('invalid-type')
    return { ok: true, adapters }
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, reason: error.reason }
    // Não deveria acontecer; nenhuma mensagem é guardada.
    return { ok: false, reason: 'invalid-type' }
  }
}

/** Situação da fonte DXCore numa coleta: `ok` com os adaptadores, ou só o motivo. */
export type DxcoreSource =
  | { status: 'ok'; adapters: DxcoreAdapter[] }
  | { status: Exclude<DxcoreSourceStatus, 'ok' | 'invalid-output'> }
  | { status: 'invalid-output'; parseError: DxcoreResponseError }

const EXIT_STATUS: ReadonlyMap<number, DxcoreSourceStatus> = new Map([
  [DXCORE_EXIT_CODES.dxcoreUnavailable, 'dxcore-unavailable'],
  [DXCORE_EXIT_CODES.factoryFailed, 'factory-failed'],
  [DXCORE_EXIT_CODES.enumerationFailed, 'enumeration-failed'],
  [DXCORE_EXIT_CODES.outputFailed, 'output-failed'],
  [DXCORE_EXIT_CODES.usage, 'usage']
])

/** Resultado do executor do auxiliar (D56) → situação da fonte. Nunca guarda a saída. */
export function interpretHelperResult(result: HelperRunResult): DxcoreSource {
  switch (result.kind) {
    case 'rejected':
      // Identidade ou integridade do executável recusada (o motivo fica só no executor).
      return { status: 'helper-rejected' }
    case 'success': {
      const parsed = parseDxcoreResponse(result.stdout)
      return parsed.ok ? { status: 'ok', adapters: parsed.adapters } : { status: 'invalid-output', parseError: parsed.reason }
    }
    case 'timeout':
      return { status: 'timeout' }
    case 'cancelled':
      return { status: 'cancelled' }
    case 'unavailable':
      return { status: 'helper-unavailable' }
    case 'failed':
      if (result.reason === 'output-limit') return { status: 'output-limit' }
      if (result.reason === 'exit-code') {
        const status = result.exitCode === null ? undefined : EXIT_STATUS.get(result.exitCode)
        return { status: (status as Exclude<DxcoreSourceStatus, 'ok' | 'invalid-output'> | undefined) ?? 'crashed' }
      }
      // Fora do catálogo ou sem conseguir iniciar o processo.
      return { status: 'helper-unavailable' }
  }
}

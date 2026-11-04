import type { GpuInfo, GpuQuality, GpuVendor } from '@shared/hardware'
import type { CommandResult } from '../command-runner'
import { GPU_COMMAND_IDS, type GpuCommandId } from '../commands'
import { BYTES_PER_GB, detected, estimated, toGb, unavailable, type FieldQuality, type Measured } from './common'

/**
 * Sondagem de GPUs e VRAM no Windows.
 *
 * - Adaptadores: `app.getGPUInfo('basic')` do Electron, injetado pelo Main
 *   (esta sondagem não importa o Electron). Fabricante pelo identificador PCI
 *   (`vendorId`), nome por `deviceString` quando informado.
 * - VRAM: `HardwareInformation.qwMemorySize` (REG_QWORD, 64 bits) na classe de
 *   adaptadores de vídeo do Registro, lida por duas consultas fixas do
 *   catálogo do CommandRunner. Não usa `Win32_VideoController.AdapterRAM`
 *   (32 bits, satura em 4 GB) nem `nvidia-smi`.
 * - Associação adaptador ↔ VRAM só por evidência: o par fabricante/dispositivo
 *   PCI do adaptador igual ao `MatchingDeviceId` da MESMA subchave que contém
 *   a memória. Nunca pela posição nas listas. Na dúvida, VRAM indisponível.
 * - Classificação dedicada/compartilhada: nenhuma das fontes a comprova (o
 *   fabricante não basta: há Intel dedicada e AMD integrada; a memória do
 *   Registro de uma integrada pode ser só a reserva do firmware). Fica `null`.
 *
 * Os identificadores PCI e as subchaves do Registro só são usados na
 * associação, em memória: não aparecem no resultado. Nada é gravado nem
 * registrado em log, e a sondagem nunca lança exceção.
 */

export interface GpuApi {
  /** `app.getGPUInfo` do Electron (Main), chamado só com `'basic'`. */
  getGPUInfo?: (infoType: 'basic') => Promise<unknown>
  /** `CommandRunner.run` com o catálogo de produção. */
  runCommand?: (commandId: GpuCommandId, signal?: AbortSignal) => Promise<CommandResult>
}

export interface GpuProbeOptions {
  signal?: AbortSignal
  /** Prazo de `getGPUInfo`; as consultas ao Registro têm o prazo do catálogo. */
  timeoutMs?: number
}

export interface GpuProbeEntry {
  vendor: Measured<GpuVendor>
  model: Measured<string>
  vramGb: Measured<number>
  sharedMemory: Measured<boolean>
}

/** Situação da leitura do Registro, sem dados do sistema. */
export type RegistryStatus = 'not-queried' | 'ok' | 'unavailable' | 'timeout' | 'cancelled' | 'failed' | 'invalid-output'

export interface GpuProbeResult {
  /** `[]` estimado: o sistema só informou o renderizador por software. */
  gpus: Measured<GpuProbeEntry[]>
  registry: RegistryStatus
  /** Adaptadores informados e deixados de fora (renderizador por software ou nada identificável). */
  ignored: number
}

export const GPU_PROBE_TIMEOUT_MS = 5_000
/** Limite de GPUs do contrato. */
const MAX_DEVICES = 16
const MAX_MODEL_LENGTH = 200
/** Faixa plausível de memória dedicada: abaixo é ruído; acima, valor inválido. */
export const VRAM_LIMITS = { minBytes: 16 * 1024 ** 2, maxBytes: 1_024 * BYTES_PER_GB } as const

/** Fabricantes pelo identificador PCI. Desconhecidos ficam `other`. */
const PCI_VENDORS: Readonly<Record<number, GpuVendor>> = {
  0x10de: 'nvidia',
  0x1002: 'amd',
  0x1022: 'amd',
  0x8086: 'intel',
  0x106b: 'apple'
}

/** Fabricante genérico pelo identificador PCI (desconhecido: `other`). */
export const pciVendorOf = (vendorId: number): GpuVendor => PCI_VENDORS[vendorId] ?? 'other'

/** Microsoft Basic Render Driver: renderização por software, não é uma GPU. */
export const SOFTWARE_RENDERER = { vendorId: 0x1414, deviceId: 0x008c } as const

const clean = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text === '' ? null : text.slice(0, MAX_MODEL_LENGTH).trim()
}

const pciId = (raw: unknown): number | null => (typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= 0xffff ? raw : null)
const hex4 = (n: number) => n.toString(16).padStart(4, '0')

/** Adaptador lido do Electron; `pciKey` só existe em memória, para a associação. */
interface Candidate extends Omit<GpuProbeEntry, 'vramGb' | 'sharedMemory'> {
  pciKey: string | null
}

type Parsed = { ok: true; candidates: Candidate[]; ignored: number; softwareOnly: boolean } | { ok: false; reason: string }

/** Lê o retorno de `getGPUInfo('basic')`, que o Electron não tipa. */
export function parseGpuInfo(raw: unknown): Parsed {
  const devices = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['gpuDevice'] : undefined
  if (!Array.isArray(devices)) return { ok: false, reason: 'invalid-value' }
  if (devices.length === 0) return { ok: false, reason: 'no-devices' }
  if (devices.length > MAX_DEVICES) return { ok: false, reason: 'too-many-devices' }

  const candidates: Candidate[] = []
  let software = 0
  let unidentified = 0
  for (const device of devices) {
    const d = typeof device === 'object' && device !== null ? (device as Record<string, unknown>) : {}
    const vendorId = pciId(d['vendorId'])
    const deviceId = pciId(d['deviceId'])
    if (vendorId === SOFTWARE_RENDERER.vendorId && deviceId === SOFTWARE_RENDERER.deviceId) {
      software++
      continue
    }
    const name = clean(d['deviceString'])
    if (vendorId === null && name === null) {
      unidentified++
      continue
    }
    candidates.push({
      vendor: vendorId === null ? unavailable('not-reported') : detected(pciVendorOf(vendorId)),
      model: name === null ? unavailable('not-reported') : detected(name),
      pciKey: vendorId !== null && deviceId !== null ? `${hex4(vendorId)}:${hex4(deviceId)}` : null
    })
  }
  return { ok: true, candidates, ignored: software + unidentified, softwareOnly: software > 0 && unidentified === 0 }
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/** Subchave de um adaptador (`...\{classe}\0000`); subchaves mais profundas não contam. */
const ADAPTER_SUBKEY = /^HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\\{4d36e968-e325-11ce-bfc1-08002be10318\}\\(\d{4})$/i
const PCI_MATCHING_ID = /^pci\\ven_([0-9a-f]{4})&dev_([0-9a-f]{4})(?:&|$)/i
const QWORD = /^0x[0-9a-f]{1,16}$/i

export interface RegistryValue {
  type: string
  data: string
}

/**
 * Valores `name` por subchave de adaptador na saída de `reg query /s /v`.
 * Só linhas no formato esperado contam; o resto (como a linha final de
 * contagem, que muda com o idioma) é ignorado. `null` se nada reconhecível.
 */
export function parseRegistryOutput(stdout: string, name: string): Map<string, RegistryValue[]> | null {
  const values = new Map<string, RegistryValue[]>()
  let current: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      current = ADAPTER_SUBKEY.exec(line.trimEnd())?.[1] ?? null
      continue
    }
    if (current === null || !/^\s/.test(line)) continue
    const [valueName, type, data = ''] = line.trim().split(/\s{4,}/)
    if (valueName?.toLowerCase() !== name.toLowerCase() || !type?.startsWith('REG_')) continue
    values.set(current, [...(values.get(current) ?? []), { type, data }])
  }
  return values.size ? values : null
}

/** Subchave → par PCI. `null` se a saída for incoerente (a associação não seria confiável). */
export function deviceKeysFrom(values: Map<string, RegistryValue[]>): Map<string, string> | null {
  const keys = new Map<string, string>()
  for (const [subkey, entries] of values) {
    if (entries.length !== 1) return null
    const id = entries[0]!.data.trim()
    if (!/^pci\\/i.test(id)) continue // Dispositivo fora do barramento PCI (ex.: `root\...`): não associável.
    const match = PCI_MATCHING_ID.exec(id)
    if (!match) return null
    keys.set(subkey, `${match[1]!.toLowerCase()}:${match[2]!.toLowerCase()}`)
  }
  return keys
}

/** Memória dedicada de uma subchave, em bytes, validando tipo, formato e faixa. */
export function vramBytesFrom(entries: RegistryValue[] | undefined): { ok: true; bytes: bigint } | { ok: false; reason: 'not-reported' | 'invalid-value' | 'invalid-type' } {
  if (!entries) return { ok: false, reason: 'not-reported' }
  if (entries.length !== 1) return { ok: false, reason: 'invalid-value' }
  const { type, data } = entries[0]!
  if (type !== 'REG_QWORD') return { ok: false, reason: 'invalid-type' }
  const text = data.trim()
  if (!QWORD.test(text)) return { ok: false, reason: 'invalid-value' }
  const bytes = BigInt(text)
  if (bytes < BigInt(VRAM_LIMITS.minBytes) || bytes > BigInt(VRAM_LIMITS.maxBytes)) return { ok: false, reason: 'invalid-value' }
  return { ok: true, bytes }
}

/** Memória dedicada de uma subchave, em GB. Os bytes cabem exatos em `number` (até 1 TiB). */
export function vramFrom(entries: RegistryValue[] | undefined): Measured<number> {
  const r = vramBytesFrom(entries)
  return r.ok ? detected(toGb(Number(r.bytes))) : unavailable(r.reason)
}

const STATUS: Record<Exclude<CommandResult['kind'], 'success'>, RegistryStatus> = {
  unavailable: 'unavailable',
  timeout: 'timeout',
  cancelled: 'cancelled',
  failed: 'failed'
}

/**
 * Interrupção pelo sinal: `timeout` quando ele veio de um prazo
 * (`AbortSignal.timeout`, inclusive combinado com `AbortSignal.any`),
 * `cancelled` nos demais casos.
 */
const abortKind = (signal: AbortSignal | undefined): 'timeout' | 'cancelled' =>
  (signal?.reason as { name?: unknown } | undefined)?.name === 'TimeoutError' ? 'timeout' : 'cancelled'

type RegistryRead = { ok: true; values: Map<string, RegistryValue[]> } | { ok: false; status: RegistryStatus }

async function readRegistry(api: GpuApi, id: GpuCommandId, name: string, signal?: AbortSignal): Promise<RegistryRead> {
  if (signal?.aborted) return { ok: false, status: abortKind(signal) }
  if (typeof api.runCommand !== 'function') return { ok: false, status: 'unavailable' }
  let result: CommandResult
  try {
    result = await api.runCommand(id, signal)
  } catch {
    return { ok: false, status: 'failed' }
  }
  if (result.kind === 'cancelled') return { ok: false, status: abortKind(signal) }
  if (result.kind !== 'success') return { ok: false, status: STATUS[result.kind] ?? 'failed' }
  const values = parseRegistryOutput(result.stdout, name)
  return values ? { ok: true, values } : { ok: false, status: 'invalid-output' }
}

// ---------------------------------------------------------------------------
// Sondagem
// ---------------------------------------------------------------------------

async function readGpuInfo(api: GpuApi, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  if (typeof api.getGPUInfo !== 'function') return { ok: false, reason: 'api-unavailable' }
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    const stop = new Promise<'timeout' | 'cancelled'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
      onAbort = () => resolve(abortKind(signal))
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    // A rejeição é tratada aqui mesmo se chegar depois do prazo (sem rejeição solta).
    const call = api.getGPUInfo('basic').then(
      (value) => ({ value }),
      () => 'api-error' as const
    )
    const outcome = await Promise.race([call, stop])
    return typeof outcome === 'string' ? { ok: false, reason: outcome } : { ok: true, value: outcome.value }
  } catch {
    return { ok: false, reason: 'api-error' }
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

export async function probeGpus(api: GpuApi, options: GpuProbeOptions = {}): Promise<GpuProbeResult> {
  const { signal } = options
  const fail = (reason: string, ignored = 0): GpuProbeResult => ({ gpus: unavailable(reason), registry: 'not-queried', ignored })
  if (signal?.aborted) return fail(abortKind(signal))

  const info = await readGpuInfo(api, options.timeoutMs ?? GPU_PROBE_TIMEOUT_MS, signal)
  if (!info.ok) return fail(info.reason)
  const parsed = parseGpuInfo(info.value)
  if (!parsed.ok) return fail(parsed.reason)
  const { candidates, ignored } = parsed
  if (candidates.length === 0) {
    // Só o renderizador por software: nenhuma GPU utilizável pelo sistema (estimado:
    // uma placa sem driver não aparece). Sem nada identificável: desconhecido.
    return parsed.softwareOnly ? { gpus: estimated([]), registry: 'not-queried', ignored } : fail('no-identifiable-device', ignored)
  }

  const vram = await associateVram(api, candidates, signal)
  const gpus = candidates.map(
    (c, i): GpuProbeEntry => ({ vendor: c.vendor, model: c.model, vramGb: vram.values[i]!, sharedMemory: unavailable('no-evidence') })
  )
  return { gpus: detected(gpus), registry: vram.registry, ignored }
}

/**
 * VRAM de cada candidato, na mesma ordem. Atribuída só quando o par PCI
 * aparece em exatamente um adaptador do Electron E em exatamente uma subchave
 * do Registro. GPUs idênticas ficam sem VRAM: valores iguais não provam qual
 * registro é de qual placa.
 */
async function associateVram(api: GpuApi, candidates: Candidate[], signal?: AbortSignal): Promise<{ values: Measured<number>[]; registry: RegistryStatus }> {
  const keyed = candidates.filter((c) => c.pciKey !== null)
  if (keyed.length === 0) return { values: candidates.map(() => unavailable('no-device-id')), registry: 'not-queried' }

  const ids = await readRegistry(api, GPU_COMMAND_IDS.deviceIds, 'MatchingDeviceId', signal)
  const deviceKeys = ids.ok ? deviceKeysFrom(ids.values) : null
  if (!ids.ok || !deviceKeys) {
    const registry = ids.ok ? 'invalid-output' : ids.status
    return { values: candidates.map((c) => unavailable(c.pciKey ? `registry-${registry}` : 'no-device-id')), registry }
  }
  // Sem nenhuma subchave com o valor, `reg query` termina com código de erro:
  // não dá para distinguir de outra falha, então fica `registry-failed`.
  const sizes = await readRegistry(api, GPU_COMMAND_IDS.memorySizes, 'HardwareInformation.qwMemorySize', signal)
  const registry: RegistryStatus = sizes.ok ? 'ok' : sizes.status

  const adapters = new Map<string, number>()
  for (const c of keyed) adapters.set(c.pciKey!, (adapters.get(c.pciKey!) ?? 0) + 1)
  const subkeysOf = (key: string) => [...deviceKeys].filter(([, k]) => k === key).map(([subkey]) => subkey)

  const values = candidates.map((c): Measured<number> => {
    if (c.pciKey === null) return unavailable('no-device-id')
    if (adapters.get(c.pciKey)! > 1) return unavailable('ambiguous-identical-adapters')
    const subkeys = subkeysOf(c.pciKey)
    if (subkeys.length === 0) return unavailable('no-registry-match')
    if (subkeys.length > 1) return unavailable('ambiguous-registry-match')
    if (!sizes.ok) return unavailable(`registry-${sizes.status}`)
    return vramFrom(sizes.values.get(subkeys[0]!))
  })
  return { values, registry }
}

type GpuField = 'gpus'

/** Lista `gpus` do contrato e a qualidade de cada GPU, na mesma ordem. */
export function gpusToProfile(r: GpuProbeResult): { gpus: GpuInfo[] | null; quality: FieldQuality<GpuField>; gpuQuality: GpuQuality[] | null } {
  if (r.gpus.value === null) return { gpus: null, quality: { gpus: 'unavailable' }, gpuQuality: null }
  return {
    gpus: r.gpus.value.map((g) => ({ vendor: g.vendor.value ?? 'unknown', model: g.model.value, vramGb: g.vramGb.value, sharedMemory: g.sharedMemory.value })),
    quality: { gpus: r.gpus.quality },
    gpuQuality: r.gpus.value.map((g) => ({ vendor: g.vendor.quality, model: g.model.quality, vramGb: g.vramGb.quality, sharedMemory: g.sharedMemory.quality }))
  }
}

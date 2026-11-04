import type { DxcoreAdapter, DxcoreListRejection, DxcoreResponseError, DxcoreSourceStatus, GpuListSource, LuidText, VramDecision } from '../dxcore-contract'
import { LUID_ZERO } from '../dxcore-contract'
import { detected, unavailable } from '../probes/common'
import { pciVendorOf, SOFTWARE_RENDERER, vramBytesFrom, type GpuProbeEntry, type GpuProbeResult, type RegistryStatus, type RegistryValue } from '../probes/gpu'
import type { DxcoreSource } from './parser'
import { classificationToProfile, classifyMemory, resolveVram, vramToProfile, type RegistryVram } from './rules'

/**
 * Seleção da fonte da lista de GPUs (D54, revisão 6C.1.2), uma vez por coleta.
 *
 * - DXCore válido e coerente: a lista é a do DXCore, e cada GPU leva só
 *   atributos do próprio registro de adaptador (o Registro só confirma a VRAM).
 * - Qualquer outro caso: o resultado do Electron + Registro de hoje, intacto.
 *
 * As listas nunca se misturam: nenhum atributo passa de uma para a outra, e
 * nada é associado por posição, nome ou fabricante. Pares fabricante/
 * dispositivo e LUIDs só existem aqui, em memória, e não saem no resultado.
 */

/** Par fabricante/dispositivo no formato do Registro e da sondagem do Electron (`10de:2504`). */
export const pairKey = (vendorId: number, deviceId: number): string => `${vendorId.toString(16).padStart(4, '0')}:${deviceId.toString(16).padStart(4, '0')}`

export type DxcoreListCheck = { ok: true; hardware: DxcoreAdapter[]; ignored: number } | { ok: false; reason: DxcoreListRejection }

/**
 * Lista do DXCore aceitável? Falhas aqui recusam a lista inteira; atributos
 * ausentes de uma GPU (`isIntegrated`, memória, descrição) não recusam: só
 * deixam aquele atributo indisponível.
 */
export function validateDxcoreList(source: DxcoreSource): DxcoreListCheck {
  if (source.status !== 'ok') return { ok: false, reason: 'source-unavailable' }
  const { adapters } = source
  // Hardware desconhecido pode ser um adaptador virtual ou um real: sem como decidir, a lista não serve.
  if (adapters.some((a) => a.isHardware === null)) return { ok: false, reason: 'hardware-flag-unknown' }
  const hardware = adapters.filter((a) => a.isHardware === true)
  if (hardware.length === 0) return { ok: false, reason: 'no-hardware-adapters' }
  if (hardware.some((a) => a.vendorId === null || a.deviceId === null || a.vendorId === 0)) return { ok: false, reason: 'hardware-id-unknown' }
  if (hardware.some((a) => a.luid === null || a.luid === LUID_ZERO)) return { ok: false, reason: 'luid-invalid' }
  // Repetição em qualquer adaptador (inclusive software) indica resposta incoerente.
  const luids = adapters.map((a) => a.luid).filter((l): l is LuidText => l !== null && l !== LUID_ZERO)
  if (new Set(luids).size !== luids.length) return { ok: false, reason: 'luid-duplicate' }
  return { ok: true, hardware, ignored: adapters.length - hardware.length }
}

const pciId = (raw: unknown): number | null => (typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= 0xffff ? raw : null)

/**
 * Composição da lista do Electron (`getGPUInfo('basic')`): um par por
 * adaptador, sem o renderizador por software (identificado com segurança pelo
 * par exato). `null` se algum adaptador não tiver par: a composição fica
 * desconhecida e não pode confirmar a do DXCore.
 */
export function electronPairsFrom(raw: unknown): string[] | null {
  const devices = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['gpuDevice'] : undefined
  if (!Array.isArray(devices)) return null
  const pairs: string[] = []
  for (const device of devices) {
    const d = typeof device === 'object' && device !== null ? (device as Record<string, unknown>) : {}
    const vendorId = pciId(d['vendorId'])
    const deviceId = pciId(d['deviceId'])
    if (vendorId === SOFTWARE_RENDERER.vendorId && deviceId === SOFTWARE_RENDERER.deviceId) continue
    if (vendorId === null || deviceId === null) return null
    pairs.push(pairKey(vendorId, deviceId))
  }
  return pairs
}

const countPairs = (pairs: string[]) => {
  const counts = new Map<string, number>()
  for (const p of pairs) counts.set(p, (counts.get(p) ?? 0) + 1)
  return counts
}

/** Mesmo multiconjunto de pares (a multiplicidade conta: A, A, B ≠ A, B). */
export function sameComposition(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const ca = countPairs(a)
  const cb = countPairs(b)
  return ca.size === cb.size && [...ca].every(([k, n]) => cb.get(k) === n)
}

/** Registro já lido pela sondagem atual (mesmas consultas do catálogo). */
export interface RegistrySnapshot {
  status: RegistryStatus
  /** Subchave → par (`deviceKeysFrom`); `null` se indisponível ou incoerente. */
  deviceKeys: Map<string, string> | null
  /** Subchave → valores de `qwMemorySize` (`parseRegistryOutput`); `null` se indisponível. */
  sizes: Map<string, RegistryValue[]> | null
}

/**
 * Memória do Registro para um par da lista do DXCore. Inequívoca só se o par
 * aparece uma vez entre os adaptadores de hardware do DXCore E numa única
 * subchave. GPUs idênticas nunca são associadas ao Registro.
 */
export function registryFor(pair: string, dxcoreCount: number, registry: RegistrySnapshot): RegistryVram {
  if (dxcoreCount !== 1) return { kind: 'none', reason: 'ambiguous' }
  if (!registry.deviceKeys) return { kind: 'none', reason: 'registry-unavailable' }
  const subkeys = [...registry.deviceKeys].filter(([, key]) => key === pair).map(([subkey]) => subkey)
  if (subkeys.length === 0) return { kind: 'none', reason: 'no-match' }
  if (subkeys.length > 1) return { kind: 'none', reason: 'ambiguous' }
  // Nenhuma subchave com o valor faz o `reg query` terminar com erro: aí não há
  // como distinguir de outra falha, e fica `registry-unavailable`.
  if (!registry.sizes) return { kind: 'none', reason: 'registry-unavailable' }
  const value = vramBytesFrom(registry.sizes.get(subkeys[0]!))
  if (value.ok) return { kind: 'match', bytes: value.bytes }
  // Ausente na subchave associada ≠ presente e inválido (tipo, formato, repetição ou faixa).
  return { kind: 'none', reason: value.reason === 'not-reported' ? 'not-reported' : 'invalid-value' }
}

export interface GpuSourceInput {
  dxcore: DxcoreSource
  /** Resultado atual (Electron + Registro) e o retorno bruto de `getGPUInfo` (só para a composição). */
  electron: { result: GpuProbeResult; raw: unknown }
  registry: RegistrySnapshot
}

/** Diagnóstico sanitizado de uma GPU da lista do DXCore: só motivos e fontes. */
export interface DxcoreGpuTrace {
  /** Fonte da VRAM, ou o motivo de ficar indisponível. */
  vram: Extract<VramDecision, { source: unknown }>['source'] | Extract<VramDecision, { reason: unknown }>['reason']
  /** Correspondência com o Registro (`match`) ou o motivo de não haver. */
  registry: 'match' | Extract<RegistryVram, { kind: 'none' }>['reason']
}

export interface GpuSelection {
  source: GpuListSource
  result: GpuProbeResult
  dxcoreStatus: DxcoreSourceStatus
  parseError: DxcoreResponseError | null
  /** Por que a lista do DXCore não foi usada (`null` quando foi). */
  rejection: DxcoreListRejection | null
  /** Uma entrada por GPU da lista do DXCore, na mesma ordem; vazio no Electron. */
  traces: DxcoreGpuTrace[]
}

/** Escolhe a fonte da lista e monta o resultado. Nunca mistura listas nem inventa GPUs. */
export function selectGpuList(input: GpuSourceInput): GpuSelection {
  const dxcoreStatus = input.dxcore.status
  const parseError = input.dxcore.status === 'invalid-output' ? input.dxcore.parseError : null
  const fallback = (rejection: DxcoreListRejection): GpuSelection => ({
    source: 'electron',
    result: input.electron.result,
    dxcoreStatus,
    parseError,
    rejection,
    traces: []
  })

  const list = validateDxcoreList(input.dxcore)
  if (!list.ok) return fallback(list.reason)

  const pairs = list.hardware.map((a) => pairKey(a.vendorId!, a.deviceId!))
  // Electron com lista: a composição precisa coincidir. Electron sem lista: o DXCore vale sozinho.
  if (input.electron.result.gpus.value !== null) {
    const electronPairs = electronPairsFrom(input.electron.raw)
    if (electronPairs === null || !sameComposition(pairs, electronPairs)) return fallback('lists-disagree')
  }

  const counts = countPairs(pairs)
  const traces: DxcoreGpuTrace[] = []
  const gpus = list.hardware.map((a, i): GpuProbeEntry => {
    const classification = classifyMemory(a)
    const registry = registryFor(pairs[i]!, counts.get(pairs[i]!)!, input.registry)
    const vram = resolveVram(a, classification, registry)
    traces.push({ vram: vram.vramBytes === null ? vram.reason : vram.source, registry: registry.kind === 'match' ? 'match' : registry.reason })
    return {
      vendor: detected(pciVendorOf(a.vendorId!)),
      model: a.description === null ? unavailable('not-reported') : detected(a.description),
      vramGb: vramToProfile(vram),
      sharedMemory: classificationToProfile(classification)
    }
  })
  return {
    source: 'dxcore',
    result: { gpus: detected(gpus), registry: input.registry.status, ignored: list.ignored },
    dxcoreStatus,
    parseError: null,
    rejection: null,
    traces
  }
}

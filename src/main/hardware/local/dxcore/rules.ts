import { VRAM_AGREEMENT, type DxcoreAdapter, type MemoryClassification, type VramDecision } from '../dxcore-contract'
import { BYTES_PER_GB, detected, toGb, unavailable, type Measured } from '../probes/common'
import { VRAM_LIMITS } from '../probes/gpu'

/**
 * Regras de classificação de memória e de VRAM para uma GPU da lista do
 * DXCore (D54). Todo cálculo de capacidade é em `bigint`; a conversão para GB
 * só acontece em `vramToProfile`, depois de validada a faixa. Nenhuma regra
 * usa fabricante, nome, posição ou tamanho para decidir a classificação.
 */

const VRAM_MIN = BigInt(VRAM_LIMITS.minBytes)
const VRAM_MAX = BigInt(VRAM_LIMITS.maxBytes)

/** Faixa aceita como memória dedicada (16 MiB a 1 TiB), conferida em bytes. */
export const vramWithinLimits = (bytes: bigint): boolean => bytes >= VRAM_MIN && bytes <= VRAM_MAX

/**
 * Registro e DXCore concordam: diferença de até `VRAM_AGREEMENT.relativePercent`
 * do maior valor, ou até `VRAM_AGREEMENT.minBytes` (tolerância provisória).
 */
export function vramAgrees(a: bigint, b: bigint): boolean {
  if (a < 0n || b < 0n) return false
  const larger = a > b ? a : b
  const diff = a > b ? a - b : b - a
  return diff <= VRAM_AGREEMENT.minBytes || diff * 100n <= larger * VRAM_AGREEMENT.relativePercent
}

/**
 * `sharedMemory` de um adaptador de hardware do DXCore. `IsIntegrated`
 * decide, mas o lado que conta VRAM (`false`) exige memória dedicada válida.
 */
export function classifyMemory(a: DxcoreAdapter): MemoryClassification {
  if (a.isHardware !== true) return { sharedMemory: null, reason: 'not-hardware' }
  if (a.isIntegrated === true) return { sharedMemory: true, evidence: 'dxcore-integrated' }
  if (a.isIntegrated === null) return { sharedMemory: null, reason: 'integrated-unknown' }
  if (a.dedicatedAdapterMemory === null) return { sharedMemory: null, reason: 'dedicated-memory-unknown' }
  if (!vramWithinLimits(a.dedicatedAdapterMemory)) return { sharedMemory: null, reason: 'dedicated-memory-conflict' }
  return { sharedMemory: false, evidence: 'dxcore-discrete-with-dedicated-memory' }
}

/**
 * Memória do Registro para uma GPU da lista do DXCore. Só `match` quando a
 * correspondência é inequívoca. `not-reported`: a subchave associada não tem
 * o valor (comum em integradas); `invalid-value`: o valor existe, mas com tipo,
 * formato, repetição ou faixa inválidos.
 */
export type RegistryVram =
  | { kind: 'match'; bytes: bigint }
  | { kind: 'none'; reason: 'registry-unavailable' | 'no-match' | 'ambiguous' | 'not-reported' | 'invalid-value' }

/**
 * VRAM de uma GPU da lista do DXCore (política aprovada):
 * - não classificada `false`: indisponível (`not-dedicated`), inclusive integradas;
 * - Registro inequívoco e concordante: valor do Registro;
 * - Registro inequívoco e divergente: indisponível (`sources-diverge`);
 * - Registro sem correspondência inequívoca ou indisponível: memória dedicada do próprio adaptador.
 * `SharedSystemMemory` e `DedicatedSystemMemory` nunca entram.
 */
export function resolveVram(a: DxcoreAdapter, classification: MemoryClassification, registry: RegistryVram): VramDecision {
  if (classification.sharedMemory !== false) return { vramBytes: null, reason: 'not-dedicated' }
  const own = a.dedicatedAdapterMemory
  if (own === null || !vramWithinLimits(own)) return { vramBytes: null, reason: 'out-of-range' }
  if (registry.kind === 'match') {
    if (!vramWithinLimits(registry.bytes)) return { vramBytes: null, reason: 'out-of-range' }
    return vramAgrees(registry.bytes, own) ? { vramBytes: registry.bytes, source: 'registry-confirmed' } : { vramBytes: null, reason: 'sources-diverge' }
  }
  return { vramBytes: own, source: 'dxcore' }
}

/** Limite de apresentação: bytes validados → GB do perfil (exatos em `number` até 1 TiB). */
export function vramToProfile(decision: VramDecision): Measured<number> {
  if (decision.vramBytes === null) return unavailable(decision.reason)
  if (!vramWithinLimits(decision.vramBytes)) return unavailable('out-of-range')
  const gb = toGb(Number(decision.vramBytes))
  // Defesa: a faixa já garante um valor finito e positivo.
  return Number.isFinite(gb) && gb > 0 && gb <= VRAM_LIMITS.maxBytes / BYTES_PER_GB ? detected(gb) : unavailable('out-of-range')
}

/** Classificação → atributo `sharedMemory` com qualidade e motivo. */
export function classificationToProfile(c: MemoryClassification): Measured<boolean> {
  return c.sharedMemory === null ? unavailable(c.reason) : detected(c.sharedMemory)
}

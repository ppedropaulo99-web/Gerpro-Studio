import { freemem, platform, totalmem } from 'node:os'
import type { MemoryInfo } from '@shared/hardware'
import { attempt, detected, estimated, isNonNegativeNumber, MAX_GB, toGb, unavailable, type FieldQuality, type Measured } from './common'

/**
 * Sondagem da memória RAM com as APIs do Node (`os`), em GB (2³⁰ bytes).
 *
 * - Total: `os.totalmem()` (detectado).
 * - Disponível: `os.freemem()`. No Windows é a memória física disponível e no
 *   Linux o `MemAvailable` (detectada). No macOS conta só páginas livres, sem o
 *   cache que o sistema libera quando precisa (estimada). Em outros sistemas,
 *   o significado não é conhecido (estimada).
 * - Disponível acima do total é incoerente: a disponível fica `unavailable` e
 *   o total é mantido.
 */

export interface MemoryApi {
  totalmem?: () => number
  freemem?: () => number
  platform?: () => string
}

export const nodeMemoryApi: MemoryApi = { totalmem, freemem, platform }

export interface MemoryProbeResult {
  totalGb: Measured<number>
  availableGb: Measured<number>
}

/** Menor total aceito pelo contrato. */
const MIN_TOTAL_GB = 0.1

export function probeMemory(api: MemoryApi = nodeMemoryApi): MemoryProbeResult {
  const total = attempt(api.totalmem)
  let totalGb: Measured<number>
  if (!total.ok) totalGb = unavailable(total.reason)
  else if (!isNonNegativeNumber(total.value) || toGb(total.value) < MIN_TOTAL_GB || toGb(total.value) > MAX_GB) totalGb = unavailable('invalid-value')
  else totalGb = detected(toGb(total.value))

  const free = attempt(api.freemem)
  let availableGb: Measured<number>
  if (!free.ok) availableGb = unavailable(free.reason)
  else if (!isNonNegativeNumber(free.value) || toGb(free.value) > MAX_GB) availableGb = unavailable('invalid-value')
  else if (total.ok && totalGb.value !== null && free.value > total.value) availableGb = unavailable('inconsistent')
  else {
    const os = attempt(api.platform)
    const exact = os.ok && (os.value === 'win32' || os.value === 'linux')
    availableGb = exact ? detected(toGb(free.value)) : estimated(toGb(free.value))
  }

  return { totalGb, availableGb }
}

type MemoryField = 'memory.totalGb' | 'memory.availableGb'

/** Seção `memory` do contrato; cada atributo independente, `null` só sem nenhum. */
export function memoryToProfile(r: MemoryProbeResult): { memory: MemoryInfo | null; quality: FieldQuality<MemoryField> } {
  const memory: MemoryInfo = { totalGb: r.totalGb.value, availableGb: r.availableGb.value }
  return {
    memory: memory.totalGb === null && memory.availableGb === null ? null : memory,
    quality: { 'memory.totalGb': r.totalGb.quality, 'memory.availableGb': r.availableGb.quality }
  }
}

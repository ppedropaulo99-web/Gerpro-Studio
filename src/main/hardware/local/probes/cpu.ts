import { arch, availableParallelism, cpus, machine } from 'node:os'
import type { CpuArchitecture, CpuInfo } from '@shared/hardware'
import { attempt, detected, estimated, probeArchitecture, unavailable, type FieldQuality, type Measured } from './common'

/**
 * Sondagem da CPU com as APIs do Node (`os`).
 *
 * - Modelo e núcleos lógicos: `os.cpus()` (detectados).
 * - Núcleos lógicos sem `os.cpus()`: `availableParallelism()`, que conta só os
 *   processadores disponíveis a este processo (estimado).
 * - Arquitetura: `os.machine()` (detectada) ou `os.arch()` (estimada).
 * - Núcleos físicos: o Node não informa. Sempre `unavailable`; nunca deduzidos
 *   dos lógicos (com SMT, a proporção varia por modelo).
 */

export interface CpuApi {
  cpus?: () => ReadonlyArray<{ model?: unknown }>
  machine?: () => string
  arch?: () => string
  availableParallelism?: () => number
}

export const nodeCpuApi: CpuApi = { cpus, machine, arch, availableParallelism }

export interface CpuProbeResult {
  model: Measured<string>
  architecture: Measured<CpuArchitecture>
  physicalCores: Measured<number>
  logicalCores: Measured<number>
}

const MAX_MODEL_LENGTH = 200
const MAX_LOGICAL_CORES = 8192

const validCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_LOGICAL_CORES

/** Texto do modelo sem espaços repetidos nem caracteres de controle; `null` se vazio ou genérico. */
export function normalizeCpuModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Caracteres de controle viram espaço antes de juntar os espaços.
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (text === '' || /^(unknown|desconhecido|0)$/i.test(text)) return null
  return text.slice(0, MAX_MODEL_LENGTH).trim()
}

export function probeCpu(api: CpuApi = nodeCpuApi): CpuProbeResult {
  const list = attempt(api.cpus)
  const entries = list.ok && Array.isArray(list.value) ? list.value : []

  let model: Measured<string>
  if (!list.ok) model = unavailable(list.reason)
  else if (entries.length === 0) model = unavailable('no-data')
  else {
    const first = entries.map((e) => normalizeCpuModel(e?.model)).find((m) => m !== null) ?? null
    model = first ? detected(first) : unavailable('invalid-value')
  }

  let logicalCores: Measured<number>
  if (validCount(entries.length)) logicalCores = detected(entries.length)
  else {
    const parallel = attempt(api.availableParallelism)
    logicalCores = parallel.ok && validCount(parallel.value) ? estimated(parallel.value) : unavailable(list.ok ? 'no-data' : list.reason)
  }

  return {
    model,
    architecture: probeArchitecture(api),
    physicalCores: unavailable('requires-system-query'),
    logicalCores
  }
}

type CpuField = 'cpu.model' | 'cpu.architecture' | 'cpu.physicalCores' | 'cpu.logicalCores'

/**
 * Seção `cpu` do contrato. Cada atributo é mantido ou fica `null` por conta
 * própria; só sem nenhum atributo conhecido a seção inteira é `null`.
 */
export function cpuToProfile(r: CpuProbeResult): { cpu: CpuInfo | null; quality: FieldQuality<CpuField> } {
  const { model, architecture, logicalCores } = r
  // Núcleos físicos acima dos lógicos seriam incoerentes: tratados como desconhecidos.
  const physicalCores =
    r.physicalCores.value !== null && logicalCores.value !== null && r.physicalCores.value > logicalCores.value
      ? unavailable<number>('inconsistent')
      : r.physicalCores
  const cpu: CpuInfo = { model: model.value, architecture: architecture.value, physicalCores: physicalCores.value, logicalCores: logicalCores.value }
  return {
    cpu: Object.values(cpu).every((v) => v === null) ? null : cpu,
    quality: {
      'cpu.model': model.quality,
      'cpu.architecture': architecture.quality,
      'cpu.physicalCores': physicalCores.quality,
      'cpu.logicalCores': logicalCores.quality
    }
  }
}

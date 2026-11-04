import type { CpuArchitecture, DataQuality, ProfileField } from '@shared/hardware'

/**
 * Peças comuns das sondagens de hardware.
 *
 * Cada sondagem devolve os atributos separadamente, cada um com sua
 * qualidade: uma falha num atributo não descarta os outros. A montagem no
 * formato do contrato (`HardwareProfile`) fica nas funções `*ToProfile`.
 *
 * Sondagens não gravam nada, não registram nada em log, não iniciam
 * processos e não lançam exceção: toda falha vira `unavailable` com um motivo.
 */

/** Qualidades possíveis de uma medição real (nunca `simulated`). */
export type MeasuredQuality = Extract<DataQuality, 'detected' | 'estimated'>

export type Measured<T> =
  | { value: T; quality: MeasuredQuality }
  /** `reason`: código curto, sem dados do sistema (ex.: `api-unavailable`). */
  | { value: null; quality: 'unavailable'; reason: string }

export const detected = <T>(value: T): Measured<T> => ({ value, quality: 'detected' })
export const estimated = <T>(value: T): Measured<T> => ({ value, quality: 'estimated' })
export const unavailable = <T>(reason: string): Measured<T> => ({ value: null, quality: 'unavailable', reason })

/** Qualidade dos atributos de uma seção do perfil. */
export type FieldQuality<K extends ProfileField> = Record<K, DataQuality>

/** GB = 2³⁰ bytes, a unidade do perfil de hardware (igual a `ESTIMATE_RULES.bytesPerGb`). */
export const BYTES_PER_GB = 1024 ** 3

/** Limite de GB aceito pelo contrato. */
export const MAX_GB = 1_048_576

/** Bytes → GB com duas casas. */
export const toGb = (bytes: number): number => Math.round((bytes / BYTES_PER_GB) * 100) / 100

export const isNonNegativeNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * Chama uma API do sistema. API ausente ou que lança exceção vira falha,
 * sem propagar a exceção nem guardar a mensagem (que pode ter dados do sistema).
 */
export function attempt<T>(read: (() => T) | undefined): { ok: true; value: T } | { ok: false; reason: 'api-unavailable' | 'api-error' } {
  if (typeof read !== 'function') return { ok: false, reason: 'api-unavailable' }
  try {
    return { ok: true, value: read() }
  } catch {
    return { ok: false, reason: 'api-error' }
  }
}

/** Arquitetura informada pelo sistema → valores do contrato. `null` se não for um texto. */
export function normalizeArchitecture(raw: unknown): CpuArchitecture | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  switch (raw.trim().toLowerCase()) {
    case 'x64':
    case 'x86_64':
    case 'amd64':
      return 'x64'
    case 'arm64':
    case 'aarch64':
    case 'armv8l':
      return 'arm64'
    case 'ia32':
    case 'x86':
    case 'i386':
    case 'i686':
      return 'x86'
    default:
      return 'other'
  }
}

/**
 * Arquitetura da máquina. `machine()` vem do sistema operacional: detectada.
 * `arch()` informa só a compilação do processo, que pode diferir da máquina:
 * estimada. Limitação: com o app x64 emulado no Windows ARM64, o sistema pode
 * responder com a arquitetura emulada; confirmar exigiria uma consulta nativa.
 */
export function probeArchitecture(api: { machine?: () => string; arch?: () => string }): Measured<CpuArchitecture> {
  const fromMachine = attempt(api.machine)
  const machine = fromMachine.ok ? normalizeArchitecture(fromMachine.value) : null
  if (machine) return detected(machine)
  const fromArch = attempt(api.arch)
  const arch = fromArch.ok ? normalizeArchitecture(fromArch.value) : null
  if (arch) return estimated(arch)
  return unavailable(fromMachine.ok || fromArch.ok ? 'invalid-value' : fromMachine.reason)
}

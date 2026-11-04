import { statfs } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { StorageInfo } from '@shared/hardware'
import { detected, isNonNegativeNumber, MAX_GB, toGb, unavailable, type FieldQuality, type Measured } from './common'

/**
 * Sondagem de espaço em disco com `fs.promises.statfs()`, em GB (2³⁰ bytes).
 *
 * Consulta UM caminho, recebido do próprio Main (`StorageTarget`): nunca do
 * Renderer. Não descobre caminhos, não percorre pastas, não lê nem grava
 * arquivos e não examina outros volumes. Uma única chamada a `statfs`.
 *
 * - Total: `blocks × bsize`.
 * - Livre: `bavail × bsize`, o espaço que um usuário comum pode usar (sem a
 *   reserva do sistema de arquivos).
 *
 * Alvos previstos: `app-data` (pasta de dados do app) e `models` (pasta de
 * modelos do provedor local, como o Ollama). Descobrir a pasta de modelos é
 * trabalho de uma etapa futura; aqui o caminho só é recebido.
 */

export const STORAGE_TARGET_KINDS = ['app-data', 'models'] as const
export type StorageTargetKind = (typeof STORAGE_TARGET_KINDS)[number]

export interface StorageTarget {
  kind: StorageTargetKind
  /** Caminho absoluto, definido pelo Main. */
  path: string
}

/** Subconjunto do resultado de `statfs` usado aqui. */
export interface StatFsLike {
  bsize: number
  blocks: number
  bavail: number
}

export interface StorageApi {
  statfs?: (path: string) => Promise<StatFsLike>
  /** Plataforma do caminho; padrão `process.platform`. */
  platform?: NodeJS.Platform
}

export const nodeStorageApi: StorageApi = { statfs: (path) => statfs(path) }

export interface StorageProbeResult {
  /** O que foi consultado; `null` quando o alvo foi recusado antes da consulta. */
  target: { kind: StorageTargetKind; path: string; volume: string } | null
  totalGb: Measured<number>
  freeGb: Measured<number>
}

export const STORAGE_PROBE_TIMEOUT_MS = 5_000
const MAX_PATH_LENGTH = 1_024
const MIN_TOTAL_GB = 0.1

const ERRORS: Record<string, string> = {
  ENOENT: 'path-not-found',
  ENOTDIR: 'path-not-found',
  EACCES: 'permission-denied',
  EPERM: 'permission-denied'
}

/**
 * Valida o alvo: tipo conhecido e caminho absoluto, sem caracteres de
 * controle, sem rede (`\\servidor\...`) e sem caminhos de dispositivo
 * (`\\?\`, `\\.\`), que poderiam travar ou apontar para outro recurso.
 */
export function validateStorageTarget(target: unknown, platform: NodeJS.Platform): { kind: StorageTargetKind; path: string; volume: string } | null {
  if (typeof target !== 'object' || target === null) return null
  const { kind, path } = target as Record<string, unknown>
  if (!STORAGE_TARGET_KINDS.includes(kind as StorageTargetKind)) return null
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH || /[\u0000-\u001f]/.test(path)) return null
  const p = platform === 'win32' ? win32 : posix
  if (platform === 'win32' && (path.startsWith('\\\\') || path.startsWith('//'))) return null
  if (!p.isAbsolute(path)) return null
  // No Windows, `C:pasta` não é absoluto de verdade (relativo à unidade).
  if (platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(path)) return null
  const normalized = p.normalize(path)
  return { kind: kind as StorageTargetKind, path: normalized, volume: p.parse(normalized).root }
}

export async function probeStorage(
  target: StorageTarget,
  api: StorageApi = nodeStorageApi,
  options: { timeoutMs?: number } = {}
): Promise<StorageProbeResult> {
  const valid = validateStorageTarget(target, api.platform ?? process.platform)
  if (!valid) return { target: null, totalGb: unavailable('invalid-target'), freeGb: unavailable('invalid-target') }
  const fail = (reason: string): StorageProbeResult => ({ target: valid, totalGb: unavailable(reason), freeGb: unavailable(reason) })
  if (typeof api.statfs !== 'function') return fail('api-unavailable')

  let timer: NodeJS.Timeout | undefined
  let stats: unknown
  try {
    // Um volume de rede ou travado pode demorar indefinidamente; o resultado
    // chega como indisponível (a chamada ao sistema não tem como ser cancelada).
    const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? STORAGE_PROBE_TIMEOUT_MS)))
    const outcome = await Promise.race([api.statfs(valid.path), timeout])
    if (outcome === 'timeout') return fail('timeout')
    stats = outcome
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return fail((code && ERRORS[code]) || 'query-failed')
  } finally {
    clearTimeout(timer)
  }

  const s = (stats ?? {}) as Partial<Record<keyof StatFsLike, unknown>>
  const { bsize, blocks, bavail } = s
  if (!isNonNegativeNumber(bsize) || bsize === 0 || !isNonNegativeNumber(blocks) || !isNonNegativeNumber(bavail)) return fail('invalid-value')
  if (bavail > blocks) return fail('inconsistent')
  const totalGb = toGb(blocks * bsize)
  const freeGb = toGb(bavail * bsize)
  if (!Number.isFinite(totalGb) || totalGb < MIN_TOTAL_GB || totalGb > MAX_GB) return fail('invalid-value')
  return { target: valid, totalGb: detected(totalGb), freeGb: detected(freeGb) }
}

type StorageField = 'storage.freeGb' | 'storage.totalGb'

/** Seção `storage` do contrato; cada atributo independente, `null` só sem nenhum. */
export function storageToProfile(r: StorageProbeResult): { storage: StorageInfo | null; quality: FieldQuality<StorageField> } {
  const storage: StorageInfo = { freeGb: r.freeGb.value, totalGb: r.totalGb.value }
  return {
    storage: storage.freeGb === null && storage.totalGb === null ? null : storage,
    quality: { 'storage.freeGb': r.freeGb.quality, 'storage.totalGb': r.totalGb.quality }
  }
}

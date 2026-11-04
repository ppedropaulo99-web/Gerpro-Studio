import { arch, machine, platform, release, version } from 'node:os'
import type { CpuArchitecture, OsInfo, OsPlatform } from '@shared/hardware'
import { attempt, detected, probeArchitecture, unavailable, type FieldQuality, type Measured } from './common'

/**
 * Sondagem do sistema operacional com as APIs do Node (`os`).
 *
 * - Plataforma: `os.platform()`; sistemas fora de Windows, macOS e Linux
 *   ficam como `other` (detectado: é o que o sistema informa).
 * - Versão no Windows: pelo número de build de `os.release()` (`10.0.<build>`).
 *   Build ≥ 22000 é Windows 11; abaixo, Windows 10. O nome comercial de
 *   `os.version()` não é usado para isso (no Windows 11 ele ainda diz
 *   "Windows 10"); serve só para reconhecer o Windows Server, cujos builds
 *   coincidem com os das versões de desktop.
 * - Versão no macOS e no Linux: a versão do kernel (`os.release()`), assim
 *   identificada no texto.
 * - Arquitetura: `os.machine()` (detectada) ou `os.arch()` (estimada).
 */

export interface OsApi {
  platform?: () => string
  release?: () => string
  version?: () => string
  machine?: () => string
  arch?: () => string
}

export const nodeOsApi: OsApi = { platform, release, version, machine, arch }

export interface OsProbeResult {
  platform: Measured<OsPlatform>
  version: Measured<string>
  architecture: Measured<CpuArchitecture>
}

/** Primeiro build do Windows 11. */
export const WINDOWS_11_FIRST_BUILD = 22000
const MAX_VERSION_LENGTH = 100

const PLATFORMS: Record<string, OsPlatform> = { win32: 'windows', darwin: 'macos', linux: 'linux' }

const clean = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text === '' ? null : text
}

/** Versão do Windows a partir de `os.release()`; `server` vem do nome do produto. */
export function windowsVersion(release: string, server: boolean): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(release)
  if (!match) return release
  const [, major, minor, build] = match
  if (major !== '10' || minor !== '0') return `NT ${release}`
  const b = Number(build)
  if (server) return `Server (build ${b})`
  return `${b >= WINDOWS_11_FIRST_BUILD ? '11' : '10'} (build ${b})`
}

export function probeOs(api: OsApi = nodeOsApi): OsProbeResult {
  const p = attempt(api.platform)
  const raw = p.ok ? clean(p.value) : null
  const os: Measured<OsPlatform> = raw ? detected(PLATFORMS[raw] ?? 'other') : unavailable(p.ok ? 'invalid-value' : p.reason)

  const r = attempt(api.release)
  const rel = r.ok ? clean(r.value) : null
  let versionText: Measured<string>
  if (!rel) versionText = unavailable(r.ok ? 'invalid-value' : r.reason)
  else if (os.value === 'windows') {
    const name = attempt(api.version)
    const server = name.ok && typeof name.value === 'string' && /\bserver\b/i.test(name.value)
    versionText = detected(windowsVersion(rel, server))
  } else if (os.value === 'macos') versionText = detected(`kernel Darwin ${rel}`)
  else if (os.value === 'linux') versionText = detected(`kernel ${rel}`)
  else versionText = detected(raw ? `${raw} ${rel}` : rel)

  if (versionText.value !== null && versionText.value.length > MAX_VERSION_LENGTH) {
    versionText = detected(versionText.value.slice(0, MAX_VERSION_LENGTH).trim())
  }

  return { platform: os, version: versionText, architecture: probeArchitecture(api) }
}

type OsField = 'os.platform' | 'os.version' | 'os.architecture'

/** Seção `os` do contrato; cada atributo independente, `null` só sem nenhum. */
export function osToProfile(r: OsProbeResult): { os: OsInfo | null; quality: FieldQuality<OsField> } {
  const os: OsInfo = { platform: r.platform.value, version: r.version.value, architecture: r.architecture.value }
  return {
    os: Object.values(os).every((v) => v === null) ? null : os,
    quality: { 'os.platform': r.platform.quality, 'os.version': r.version.quality, 'os.architecture': r.architecture.quality }
  }
}

/**
 * Verificações de sistema do supervisor dos testes de contenção (6C.6C.2A):
 * censo de processos com identidade e política para sobreviventes. Só texto e
 * decisões puras; quem inicia o PowerShell e o `whoami.exe` é o supervisor,
 * sem shell, pela pasta do sistema e com argumentos fixos.
 *
 * Nada aqui encerra processo. A identidade completa (PID, instante de criação
 * e caminho do executável) só serve para registrar e classificar
 * sobreviventes; o encerramento deles é manual (6C.6C.2B).
 */

import { CENSUS_IMAGES } from './plan'

/** Trava exclusiva na pasta temporária do sistema: uma bateria por vez. */
export const BATTERY_LOCK_NAME = 'gerpro-host-containment.lock'
/** Prefixo da pasta exclusiva da bateria (na pasta temporária do sistema). */
export const BATTERY_SCRATCH_PREFIX = 'gerpro-6c6c-'

/**
 * Script fixo do PowerShell: processos com as imagens de teste, uma linha
 * `pid|ppid|criação (FILETIME UTC)|caminho`. Nenhum outro processo é listado.
 */
export function censusScript(images: readonly string[] = CENSUS_IMAGES): string {
  for (const image of images) if (!/^[a-z0-9-]+\.exe$/.test(image)) throw new Error('nome de imagem inesperado')
  const filter = images.map((image) => `Name='${image}'`).join(' OR ')
  return [
    "$ErrorActionPreference = 'Stop'",
    `Get-CimInstance -ClassName Win32_Process -Filter "${filter}" | ForEach-Object {`,
    '  $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }',
    "  '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $created, $_.ExecutablePath",
    '}',
    "'end'"
  ].join('\n')
}

/** Argumentos do PowerShell (sem perfil, sem interação, script codificado: nada passa por citação). */
export function censusArgs(images: readonly string[] = CENSUS_IMAGES): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(censusScript(images), 'utf16le').toString('base64')]
}

export interface ProcessIdentity {
  pid: number
  ppid: number
  /** FILETIME UTC (100 ns desde 1601), em texto decimal; "0" se desconhecido. */
  created: string
  /** Caminho do executável; `null` se o sistema não o informou (ex.: outro usuário). */
  path: string | null
}

/**
 * Lê a saída do censo. `null` se a saída não terminar com a marca `end`
 * (o script falhou) ou tiver linha fora do formato: censo desconhecido.
 */
export function parseCensus(output: string): ProcessIdentity[] | null {
  const rows = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  if (rows.at(-1) !== 'end') return null
  const out: ProcessIdentity[] = []
  for (const row of rows.slice(0, -1)) {
    const m = /^(\d{1,10})\|(\d{1,10})\|(\d{1,20})\|(.*)$/.exec(row)
    if (!m) return null
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), created: m[3]!, path: m[4] === '' ? null : m[4]! })
  }
  return out
}

const normalize = (path: string) => path.replaceAll('/', '\\').toLowerCase()
export const filetimeAtLeast = (a: string, b: string) => (a.length !== b.length ? a.length > b.length : a >= b)

export interface SurvivorPlan {
  /** Identidade aponta para um arquivo desta bateria, criado depois do início dela. */
  owned: ProcessIdentity[]
  /** Qualquer outro: nunca tocado pelo supervisor. */
  foreign: ProcessIdentity[]
}

/**
 * Classifica sobreviventes. `ownedPaths`: caminhos completos dos executáveis
 * que a bateria copiou; `batteryStart`: FILETIME UTC do início da bateria.
 */
export function classifySurvivors(census: readonly ProcessIdentity[], ownedPaths: readonly string[], batteryStart: string): SurvivorPlan {
  const owned = new Set(ownedPaths.map(normalize))
  const plan: SurvivorPlan = { owned: [], foreign: [] }
  for (const p of census) {
    const ours = p.path !== null && owned.has(normalize(p.path)) && p.created !== '0' && filetimeAtLeast(p.created, batteryStart)
    ;(ours ? plan.owned : plan.foreign).push(p)
  }
  return plan
}

/** FILETIME UTC de um instante em milissegundos desde 1970 (texto decimal). */
export function filetimeFromMs(ms: number): string {
  return ((BigInt(Math.floor(ms)) + 11_644_473_600_000n) * 10_000n).toString()
}

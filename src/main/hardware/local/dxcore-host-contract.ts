import { DXCORE_EXIT_CODES, DXCORE_HELPER_ARGS } from './dxcore-contract'

/**
 * Contrato do launcher nativo `gerpro-helper-host.exe` (Etapa 6C.6B.2, D61;
 * `docs/10-ativacao-dxcore.md`, seções 11.6, 12.1 e 14).
 *
 * **Não conectado.** Nenhum módulo do app importa este arquivo: o
 * `BundledHelperRunner` continua chamando o auxiliar diretamente, e continua
 * bloqueado (`DXCORE_HELPER_SHA256` nulo). A integração é uma etapa própria.
 *
 * O launcher cria o auxiliar suspenso dentro de um Job Object, confere a
 * contenção e a integridade e só então o retoma. Dois hashes independentes:
 * o do launcher, conferido pelo Node; o do auxiliar, conferido pelo launcher
 * (e também pelo Node, para rejeitar cedo).
 */

/** Identidade fixa (igual a `protocol.h` do launcher). */
export const DXCORE_HOST = Object.freeze({
  id: 'gpu.dxcore-host',
  fileName: 'gerpro-helper-host.exe',
  helperFileName: 'gerpro-dxcore-helper.exe',
  directory: 'helpers'
})

/** Argumentos fixos antes do hash do auxiliar. */
export const DXCORE_HOST_ARGS_PREFIX = ['--protocol', '1', '--helper-sha256'] as const

const SHA256 = /^[0-9a-f]{64}$/

/**
 * Argumentos completos do launcher. O hash vem SEMPRE da constante do app;
 * qualquer outro formato é erro de programação (lança).
 */
export function dxcoreHostArgs(helperSha256: string): readonly string[] {
  if (typeof helperSha256 !== 'string' || !SHA256.test(helperSha256)) throw new Error('Hash do auxiliar em formato inválido.')
  return Object.freeze([...DXCORE_HOST_ARGS_PREFIX, helperSha256])
}

/**
 * Códigos de saída do launcher (iguais a `exit_codes.h`). 20–26: o auxiliar
 * não executou nenhuma instrução.
 */
export const DXCORE_HOST_EXIT_CODES = Object.freeze({
  hostArguments: 20,
  hostEnvironment: 21,
  hostJob: 22,
  hostFile: 23,
  hostIntegrity: 24,
  hostCreate: 25,
  hostVerify: 26,
  hostTimeout: 27,
  hostContainment: 28,
  hostUnconfirmed: 29
})

export type DxcoreHostExit = keyof typeof DXCORE_HOST_EXIT_CODES

/** Códigos que só o launcher produz e em que o auxiliar nunca foi retomado. */
export const DXCORE_HOST_PRE_RESUME_EXITS: readonly DxcoreHostExit[] = Object.freeze([
  'hostArguments',
  'hostEnvironment',
  'hostJob',
  'hostFile',
  'hostIntegrity',
  'hostCreate',
  'hostVerify'
])

/** Prazos internos do launcher (iguais a `main.cpp`); abaixo do prazo de 3 s do executor. */
export const DXCORE_HOST_TIMEOUTS = Object.freeze({ helperWaitMs: 2_000, terminateConfirmMs: 500 })

/**
 * Classificação de um código de saída do launcher: código do auxiliar
 * (repassado), código próprio do launcher, ou desconhecido.
 */
export function classifyHostExit(code: number): { kind: 'helper'; code: number } | { kind: 'host'; exit: DxcoreHostExit } | { kind: 'unknown' } {
  if ((Object.values(DXCORE_EXIT_CODES) as number[]).includes(code)) return { kind: 'helper', code }
  const entry = (Object.entries(DXCORE_HOST_EXIT_CODES) as Array<[DxcoreHostExit, number]>).find(([, value]) => value === code)
  return entry ? { kind: 'host', exit: entry[0] } : { kind: 'unknown' }
}

/**
 * SHA-256 esperado do LAUNCHER, por arquitetura. `null`: sem build aprovado;
 * a execução fica bloqueada. Só muda numa alteração separada e revisada
 * (`docs/10`, seção 4).
 */
export const DXCORE_HOST_SHA256: Readonly<Record<'x64' | 'arm64', string | null>> = Object.freeze({ x64: null, arm64: null })

/**
 * Limite de memória do job: PENDENTE. Só será definido depois de medir o
 * pico real (teste T-M1 da 6C.6C); nenhum valor arbitrário é usado. Enquanto
 * for `null`, a execução em produção continua bloqueada.
 */
export const DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES: number | null = null

export type DxcoreHostBlocker = 'unsupported-arch' | 'host-hash-missing' | 'helper-hash-missing' | 'memory-limit-pending'

/**
 * Motivos que impedem a execução em produção. Vazio só com os DOIS hashes
 * aprovados e o limite de memória definido. Hoje nunca é vazio.
 */
export function dxcoreHostBlockers(
  arch: string,
  hashes: { host: Readonly<Record<'x64' | 'arm64', string | null>>; helper: Readonly<Record<'x64' | 'arm64', string | null>> },
  memoryLimitBytes: number | null = DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES
): DxcoreHostBlocker[] {
  if (arch !== 'x64' && arch !== 'arm64') return ['unsupported-arch']
  const blockers: DxcoreHostBlocker[] = []
  const host = hashes.host[arch]
  const helper = hashes.helper[arch]
  if (typeof host !== 'string' || !SHA256.test(host)) blockers.push('host-hash-missing')
  if (typeof helper !== 'string' || !SHA256.test(helper)) blockers.push('helper-hash-missing')
  if (memoryLimitBytes === null || !Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes <= 0) blockers.push('memory-limit-pending')
  return blockers
}

/** O auxiliar continua recebendo exatamente os argumentos do contrato dele. */
export const DXCORE_HOST_HELPER_COMMAND_LINE = `${DXCORE_HOST.helperFileName} ${DXCORE_HELPER_ARGS.join(' ')}`

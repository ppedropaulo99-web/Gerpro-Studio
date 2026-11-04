/**
 * Integração do segurador de travas só de teste (`gerpro-lock-holder-test.exe`,
 * 6C.6C.3F) ao supervisor, para T-F1.exit-ok e T-F4.exit-ok (Etapa 6C.6C.3G;
 * docs/11, seção 21). Só dados e funções puras: nada aqui cria processo, abre
 * arquivo ou consulta o sistema.
 *
 * Os dois casos são REPRODUÇÕES sem o launcher: o segurador abre os objetos
 * com as mesmas flags dos passos 5 e 6 do launcher, e o supervisor tenta,
 * UMA vez cada, as operações que essas aberturas deveriam impedir. Uma
 * tentativa bem-sucedida nunca é repetida nem escondida: o caso reprova, as
 * tentativas seguintes não são feitas e só o objeto temporário afetado é
 * restaurado (se a identidade dele conferir).
 */

import { win32 } from 'node:path'
import { APPROVED_ARTIFACTS, LOCK_HOLDER_NAME, SYNTHETIC_HELPER_NAME, type LockHolderCaseId } from './plan'
import { BATTERY_SCRATCH_PREFIX } from './system-checks'

// ── Protocolo do segurador (native/lock-holder-test/README.md) ──────────────

/** Prefixo das duas únicas linhas do segurador. */
export const LOCK_HOLDER_PREFIX = 'gerpro-lock-holder-test v=1 '
/** Prontidão: travas obtidas, até este prazo desde o início do processo. */
export const LOCK_HOLDER_READY_TIMEOUT_MS = 2_000
/** Depois do fechamento da entrada padrão: `released reason=stdin` e código 0 neste prazo. */
export const LOCK_HOLDER_RELEASE_TIMEOUT_MS = 1_000
/** Depois de um encerramento pedido pelo supervisor, o `close` tem de chegar neste prazo. */
export const LOCK_HOLDER_KILL_CLOSE_MS = 2_000
/** Prazo próprio do segurador (`kHoldDeadlineMs`), fixo, desde o início. */
export const LOCK_HOLDER_SELF_DEADLINE_MS = 10_000
/** Teto da pasta do caso aceito pelo segurador (`kMaxCaseDirChars`). */
export const LOCK_HOLDER_MAX_CASE_DIR = 300
/** Códigos de saída do segurador (exit_codes.h). */
export const LOCK_HOLDER_EXIT: Readonly<Record<number, string>> = Object.freeze({
  0: 'liberação pedida pelo supervisor',
  40: 'argumentos fora do formato fixo',
  41: 'ambiente recusado',
  42: 'caminho recusado',
  43: 'abertura recusada',
  44: 'sinal de prontidão não escrito',
  45: 'prazo próprio vencido',
  46: 'falha ao acompanhar a entrada padrão'
})

/**
 * Erro esperado em todas as tentativas: o libuv traduz
 * `ERROR_SHARING_VIOLATION` (32) para `EBUSY`. Recusa por outro motivo
 * (`EPERM`, `EACCES`, `ENOENT`…) é registrada, mas não confirma a hipótese.
 */
export const LOCK_HOLDER_EXPECTED_CODE = 'EBUSY'

export type LockHolderMode = 'file' | 'directory'

// ── Layout da pasta do caso ─────────────────────────────────────────────────

/** Caminhos relativos à pasta do caso. Nomes fixos, iguais aos do segurador e do launcher. */
export const CASE_REL = Object.freeze({
  top: 'host-test',
  arch: 'host-test\\win32-x64',
  file: `host-test\\win32-x64\\${SYNTHETIC_HELPER_NAME}`,
  /** Nomes de destino das renomeações (só existem se a hipótese falhar). */
  topRenamed: 'host-test-renamed',
  archRenamed: 'host-test\\win32-x64-renamed',
  fileRenamed: 'host-test\\win32-x64\\gerpro-synthetic-helper.renamed',
  /**
   * Cópia do segurador, FORA de `host-test`: a pasta atual do processo filho
   * (um identificador aberto sem `FILE_SHARE_DELETE`) e a imagem dele nunca
   * ficam dentro das pastas testadas no T-F4.
   */
  holderDir: 'lock-holder',
  holder: `lock-holder\\${LOCK_HOLDER_NAME}`
})

export const caseLayout = (caseDir: string) => ({
  caseDir,
  top: win32.join(caseDir, CASE_REL.top),
  arch: win32.join(caseDir, CASE_REL.arch),
  file: win32.join(caseDir, CASE_REL.file),
  topRenamed: win32.join(caseDir, CASE_REL.topRenamed),
  archRenamed: win32.join(caseDir, CASE_REL.archRenamed),
  fileRenamed: win32.join(caseDir, CASE_REL.fileRenamed),
  holderDir: win32.join(caseDir, CASE_REL.holderDir),
  holder: win32.join(caseDir, CASE_REL.holder)
})
export type CaseLayout = ReturnType<typeof caseLayout>

// ── Casos e tentativas ──────────────────────────────────────────────────────

export type AttemptId = 'open-rw' | 'rename-file' | 'delete-file' | 'rename-top' | 'rename-arch'

export interface AttemptSpec {
  readonly id: AttemptId
  readonly kind: 'open-rw' | 'rename' | 'unlink'
  /** Objeto da tentativa. */
  readonly target: 'file' | 'top' | 'arch'
  readonly label: string
}

export const ATTEMPTS: Readonly<Record<AttemptId, AttemptSpec>> = Object.freeze({
  'open-rw': Object.freeze({ id: 'open-rw', kind: 'open-rw', target: 'file', label: 'abertura para leitura e escrita' }),
  'rename-file': Object.freeze({ id: 'rename-file', kind: 'rename', target: 'file', label: 'renomeação do arquivo' }),
  'delete-file': Object.freeze({ id: 'delete-file', kind: 'unlink', target: 'file', label: 'exclusão do arquivo' }),
  'rename-top': Object.freeze({ id: 'rename-top', kind: 'rename', target: 'top', label: 'renomeação de host-test' }),
  'rename-arch': Object.freeze({ id: 'rename-arch', kind: 'rename', target: 'arch', label: 'renomeação de win32-x64' })
} satisfies Record<AttemptId, AttemptSpec>)

export interface LockHolderCase {
  readonly id: LockHolderCaseId
  readonly test: 'T-F1' | 'T-F4'
  readonly mode: LockHolderMode
  /** Alvo sintético copiado para a pasta do caso (nunca executado). */
  readonly scenario: 'exit-ok'
  /** Tentativas, nesta ordem, uma vez cada. */
  readonly attempts: readonly AttemptId[]
  readonly hypothesis: string
  readonly description: string
}

export const LOCK_HOLDER_CASES: Readonly<Record<LockHolderCaseId, LockHolderCase>> = Object.freeze({
  'T-F1.exit-ok': Object.freeze({
    id: 'T-F1.exit-ok',
    test: 'T-F1',
    mode: 'file',
    scenario: 'exit-ok',
    attempts: Object.freeze(['open-rw', 'rename-file', 'delete-file'] as const),
    hypothesis: 'H-F1',
    description: 'arquivo aberto como no passo 6 do launcher (GENERIC_READ, só FILE_SHARE_READ): abertura para escrita, renomeação e exclusão recusadas'
  }),
  'T-F4.exit-ok': Object.freeze({
    id: 'T-F4.exit-ok',
    test: 'T-F4',
    mode: 'directory',
    scenario: 'exit-ok',
    attempts: Object.freeze(['rename-top', 'rename-arch'] as const),
    hypothesis: 'H-F4',
    description: 'pastas abertas como no passo 5 do launcher (sem FILE_SHARE_DELETE): renomeação de host-test e de win32-x64 recusadas'
  })
} satisfies Record<LockHolderCaseId, LockHolderCase>)

/** Pasta do caso dentro da pasta exclusiva (um caso por execução: sempre `01-`). */
export const lockHolderCaseDir = (scratch: string, c: LockHolderCase) => win32.join(scratch, `01-${c.id}`)

/** Argumentos fixos do segurador. Nada vem da linha de comando do supervisor. */
export const lockHolderArgs = (c: LockHolderCase, caseDir: string): string[] => [`--mode=${c.mode}`, `--case-dir=${caseDir}`]

/** Origem e destino de uma renomeação. */
export function renamePair(layout: CaseLayout, target: AttemptSpec['target']): { from: string; to: string } {
  switch (target) {
    case 'file':
      return { from: layout.file, to: layout.fileRenamed }
    case 'top':
      return { from: layout.top, to: layout.topRenamed }
    case 'arch':
      return { from: layout.arch, to: layout.archRenamed }
  }
}

// ── Linhas do segurador ─────────────────────────────────────────────────────

const READY_LINE = /^gerpro-lock-holder-test v=1 ready mode=(file|mapping|directory) volume=([0-9a-f]{8}) index=([0-9a-f]{16})(?:,([0-9a-f]{16}))?$/
const RELEASED_LINE = /^gerpro-lock-holder-test v=1 released reason=(stdin|deadline|wait-failure)$/

export interface ReadySignal {
  mode: 'file' | 'mapping' | 'directory'
  /** Número de série do volume, 8 dígitos hexadecimais. */
  volume: string
  /** Índices, 16 dígitos hexadecimais: arquivo (file) ou host-test e win32-x64 (directory). */
  indexes: string[]
}

export function parseReadyLine(line: string): ReadySignal | null {
  const m = READY_LINE.exec(line)
  if (m === null) return null
  return { mode: m[1] as ReadySignal['mode'], volume: m[2]!, indexes: m[4] === undefined ? [m[3]!] : [m[3]!, m[4]] }
}

export type ReleaseReason = 'stdin' | 'deadline' | 'wait-failure'
export const parseReleasedLine = (line: string): ReleaseReason | null => (RELEASED_LINE.exec(line)?.[1] as ReleaseReason | undefined) ?? null

/** Linhas completas da saída padrão (sem a última, se não terminou em quebra). */
export const completeLines = (stdout: string) => stdout.split(/\r?\n/).slice(0, -1).filter((l) => l !== '')

// ── Identidade ──────────────────────────────────────────────────────────────

/** `fs.lstatSync(caminho, { bigint: true })`: sem perda de precisão no índice (64 bits). */
export interface FsIdentity {
  dev: bigint
  ino: bigint
  nlink: bigint
  kind: 'file' | 'directory' | 'link' | 'other'
}

const hex = (value: string) => BigInt(`0x${value}`)
/** O segurador escreve o número de série de 32 bits; o Node expõe o mesmo valor em `dev`. Só os 32 bits baixos são comparados. */
const sameVolume = (id: FsIdentity, volume: string) => (id.dev & 0xffff_ffffn) === hex(volume)

/**
 * Confere que o objeto que o segurador abriu é o objeto da pasta do caso:
 * mesmo volume e mesmo índice, tipo certo, sem link, arquivo com um só nome.
 * Devolve a lista de problemas (vazia = conferido).
 */
export function checkIdentity(c: LockHolderCase, ready: ReadySignal, stats: { file?: FsIdentity | null; top?: FsIdentity | null; arch?: FsIdentity | null }): string[] {
  const issues: string[] = []
  if (ready.mode !== c.mode) issues.push(`modo ${ready.mode} na prontidão (esperado ${c.mode})`)
  const expected: Array<[string, FsIdentity | null | undefined, 'file' | 'directory', string | undefined]> =
    c.mode === 'file'
      ? [[SYNTHETIC_HELPER_NAME, stats.file, 'file', ready.indexes[0]]]
      : [
          ['host-test', stats.top, 'directory', ready.indexes[0]],
          ['win32-x64', stats.arch, 'directory', ready.indexes[1]]
        ]
  if (ready.indexes.length !== expected.length) issues.push(`${ready.indexes.length} índice(s) na prontidão (esperado ${expected.length})`)
  for (const [name, id, kind, index] of expected) {
    if (id === null || id === undefined) issues.push(`${name}: identidade não lida`)
    else if (id.kind !== kind) issues.push(`${name}: tipo ${id.kind} (esperado ${kind === 'file' ? 'arquivo' : 'pasta'})`)
    else if (!sameVolume(id, ready.volume)) issues.push(`${name}: volume diferente do anunciado pelo segurador`)
    else if (index === undefined || id.ino !== hex(index)) issues.push(`${name}: índice diferente do anunciado pelo segurador`)
    else if (kind === 'file' && id.nlink !== 1n) issues.push(`${name}: ${id.nlink} nomes (hard link)`)
  }
  return issues
}

/** Identidade igual (volume e índice completos), para restaurar só o objeto que foi movido. */
export const sameIdentity = (a: FsIdentity | null, b: FsIdentity | null) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino && a.kind === b.kind

// ── Guardas de caminho (usadas pela entrada antes de cada operação) ─────────

const SCRATCH_NAME = new RegExp(`^${BATTERY_SCRATCH_PREFIX}[A-Za-z0-9]{1,16}$`)
const CASE_NAME = /^01-(T-F1|T-F4)\.exit-ok$/

/**
 * Divide um caminho da forma `<tmpRoot>\gerpro-6c6c-<sufixo>\01-T-F<1|4>.exit-ok\<relativo>`.
 * `null` para qualquer outra forma (fora da pasta temporária, outro prefixo,
 * outro caso, `/`, `..`, componente vazio).
 */
export function splitCasePath(tmpRoot: string, path: string): { caseId: LockHolderCaseId; caseDir: string; rel: string } | null {
  if (typeof path !== 'string' || path.includes('/') || path.includes('\0')) return null
  const base = `${tmpRoot}\\`
  if (!/^[A-Za-z]:\\/.test(tmpRoot) || !path.toLowerCase().startsWith(base.toLowerCase())) return null
  const parts = path.slice(base.length).split('\\')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  if (parts.length < 3 || !SCRATCH_NAME.test(parts[0]!)) return null
  const m = CASE_NAME.exec(parts[1]!)
  if (m === null) return null
  return { caseId: `${m[1]}.exit-ok` as LockHolderCaseId, caseDir: path.slice(0, base.length + parts[0]!.length + 1 + parts[1]!.length), rel: parts.slice(2).join('\\') }
}

/** Renomeações permitidas, por caso: só os objetos testados e os nomes de destino fixos. */
const RENAME_PAIRS: Readonly<Record<LockHolderCaseId, ReadonlyArray<readonly [string, string]>>> = Object.freeze({
  'T-F1.exit-ok': [[CASE_REL.file, CASE_REL.fileRenamed]],
  'T-F4.exit-ok': [
    [CASE_REL.top, CASE_REL.topRenamed],
    [CASE_REL.arch, CASE_REL.archRenamed]
  ]
})

/** Uma renomeação de teste (ou a restauração dela, no sentido inverso), dentro da MESMA pasta do caso. */
export function renameAllowed(tmpRoot: string, from: string, to: string): boolean {
  const a = splitCasePath(tmpRoot, from)
  const b = splitCasePath(tmpRoot, to)
  if (a === null || b === null || a.caseDir !== b.caseDir) return false
  return RENAME_PAIRS[a.caseId].some(([x, y]) => (a.rel === x && b.rel === y) || (a.rel === y && b.rel === x))
}

/** Exclusão: só a cópia do alvo, só no T-F1. */
export function unlinkAllowed(tmpRoot: string, path: string): boolean {
  const p = splitCasePath(tmpRoot, path)
  return p !== null && p.caseId === 'T-F1.exit-ok' && p.rel === CASE_REL.file
}

/** Leitura de identidade: só os objetos do caso (originais e renomeados). */
export function identityAllowed(tmpRoot: string, path: string): boolean {
  const p = splitCasePath(tmpRoot, path)
  return p !== null && ([CASE_REL.file, CASE_REL.top, CASE_REL.arch, CASE_REL.fileRenamed, CASE_REL.topRenamed, CASE_REL.archRenamed] as readonly string[]).includes(p.rel)
}

/** O único executável que o supervisor inicia neste modo: a cópia conferida do segurador, na pasta do caso. */
export function holderImageAllowed(tmpRoot: string, path: string): boolean {
  const p = splitCasePath(tmpRoot, path)
  return p !== null && p.rel === CASE_REL.holder
}

/**
 * Pasta temporária aceitável para o segurador, que a resolve sozinho por
 * `GetTempPathW` e recusa (42) qualquer forma fora da dele. Conferido antes,
 * para não iniciar nada que já se sabe que vai recusar.
 */
export function lockHolderBaseIssues(tmpRoot: string): string[] {
  const issues: string[] = []
  if (!/^[A-Za-z]:\\./.test(tmpRoot)) return ['pasta temporária fora de uma unidade local ou na raiz']
  const rest = tmpRoot.slice(3)
  if (/[\x00-\x1f/:*?"<>|~]/.test(rest)) issues.push('pasta temporária com caractere que o segurador recusa (inclusive "~" de nome curto)')
  if (rest.split('\\').some((p) => p === '' || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' '))) issues.push('pasta temporária com componente vazio, "." ou "..", ou terminado em ponto ou espaço')
  // <tmpRoot>\gerpro-6c6c-XXXXXX\01-T-F1.exit-ok (mkdtemp acrescenta 6 caracteres).
  const longest = `${tmpRoot}\\${BATTERY_SCRATCH_PREFIX}XXXXXX\\01-T-F1.exit-ok`.length
  if (longest > LOCK_HOLDER_MAX_CASE_DIR) issues.push(`caminho da pasta do caso com ${longest} caracteres (limite do segurador: ${LOCK_HOLDER_MAX_CASE_DIR})`)
  return issues
}

/**
 * Ambiente do segurador: só o necessário. `TMP` e `TEMP` iguais à pasta
 * temporária JÁ RESOLVIDA pelo supervisor, porque o segurador usa
 * `GetTempPathW` (TMP antes de TEMP) e o Node usa TEMP antes de TMP; sem as
 * duas, o Windows cairia na pasta do sistema e o segurador recusaria (42).
 */
export const lockHolderEnv = (tmpRoot: string, systemRoot: string) => ({ SystemRoot: systemRoot, windir: systemRoot, TMP: tmpRoot, TEMP: tmpRoot })

// ── Observação e avaliação ──────────────────────────────────────────────────

export interface FsAttempt {
  /** A operação funcionou (não deveria). */
  succeeded: boolean
  /** Código do libuv, ex.: `EBUSY`; `null` se funcionou. */
  code: string | null
  errno: number | null
}

export interface Restoration {
  /** Identidade do objeto no destino igual à do original. */
  identityMatched: boolean
  /** Resultado da renomeação de volta; `null` = não tentada. */
  result: FsAttempt | null
}

export interface AttemptRecord {
  id: AttemptId
  /** Ms desde o início do segurador. */
  ms: number
  result: FsAttempt
  /** Só depois de uma renomeação que funcionou. */
  restoration: Restoration | null
}

export interface LockHolderObservation {
  caseId: LockHolderCaseId
  spawnError: string | null
  pid: number | null
  /** Ms em que a prontidão chegou; `null` = não chegou no prazo. */
  readyMs: number | null
  ready: ReadySignal | null
  /** Primeira linha do segurador, se não for prontidão válida (só para o relatório). */
  unexpectedFirstLine: boolean
  /** Problemas na conferência de identidade antes das tentativas; `null` = não conferida. */
  identityIssues: string[] | null
  /** Idem, depois das tentativas (objetos ainda nos caminhos originais). */
  identityAfterIssues: string[] | null
  attempts: AttemptRecord[]
  /** Motivo de as tentativas pararem antes do fim; `null` = todas feitas (ou nenhuma prevista ainda). */
  attemptsStopped: string | null
  /** O segurador seguia ativo (sem `exit`) antes e depois de todas as tentativas. */
  holderAliveThroughAttempts: boolean | null
  releaseRequestedMs: number | null
  killRequestedMs: number | null
  killAccepted: boolean | null
  exitCode: number | null
  exitSignal: string | null
  exitMs: number | null
  closeMs: number | null
  stdout: string
  stderrBytes: number
  /** SHA-256 da cópia do exit-ok: antes, depois das tentativas e depois da liberação. */
  hashBefore: string | null
  hashAfterAttempts: string | null
  hashAfterRelease: string | null
  censusAfter: number | null
}

export interface LockHolderResult {
  verdict: { pass: true; notes: string[] } | { pass: false; reasons: string[] }
  evidence: string[]
}

const describeAttempt = (r: FsAttempt) => (r.succeeded ? 'FUNCIONOU' : `recusada (${r.code ?? '?'}, errno ${r.errno ?? '?'})`)

/**
 * Avalia um caso do segurador. Aprovado só se:
 * - prontidão válida, do modo certo, em até 2 s; identidade conferida antes e depois;
 * - todas as tentativas do caso, na ordem, uma vez cada, com o segurador ativo,
 *   todas recusadas com `EBUSY`;
 * - liberação pedida só pelo fechamento da entrada, `released reason=stdin` e
 *   código 0 em até 1 s, sem encerramento pelo supervisor;
 * - saída padrão só com as duas linhas, saída de erro vazia;
 * - cópia do exit-ok com o SHA-256 aprovado antes, depois e no fim;
 * - censo logo depois = 0.
 */
export function evaluateLockHolder(o: LockHolderObservation): LockHolderResult {
  const c = LOCK_HOLDER_CASES[o.caseId]
  const reasons: string[] = []
  const evidence: string[] = []
  if (o.spawnError !== null) reasons.push(`segurador não iniciou (${o.spawnError})`)

  // 1. Prontidão.
  if (o.readyMs === null) reasons.push(`o segurador não sinalizou prontidão em ${LOCK_HOLDER_READY_TIMEOUT_MS} ms`)
  else if (o.ready === null) reasons.push('primeira linha do segurador não é uma prontidão válida')
  else if (o.readyMs > LOCK_HOLDER_READY_TIMEOUT_MS) reasons.push(`prontidão em ${o.readyMs} ms (limite ${LOCK_HOLDER_READY_TIMEOUT_MS} ms)`)
  else evidence.push(`travas obtidas: prontidão mode=${o.ready.mode} volume=${o.ready.volume} index=${o.ready.indexes.join(',')} em ${o.readyMs} ms`)

  // 2. Identidade.
  if (o.ready !== null) {
    if (o.identityIssues === null) reasons.push('identidade dos objetos não conferida')
    else if (o.identityIssues.length > 0) reasons.push(`identidade: ${o.identityIssues.join('; ')}`)
    else evidence.push(`identidade conferida: volume e índice (lstat bigint) iguais aos do segurador, tipo certo, sem link${c.mode === 'file' ? ', um só nome' : ''}`)
  }

  // 3. Tentativas.
  const ids = o.attempts.map((a) => a.id)
  if (new Set(ids).size !== ids.length) reasons.push('tentativa repetida')
  if (ids.some((id, i) => id !== c.attempts[i])) reasons.push('tentativas fora da ordem do caso')
  for (const a of o.attempts) {
    const label = ATTEMPTS[a.id].label
    evidence.push(`tentativa ${label} em ${a.ms} ms: ${describeAttempt(a.result)}`)
    if (a.result.succeeded) reasons.push(`${c.hypothesis} REFUTADA: ${label} funcionou com a trava segurada`)
    else if (a.result.code !== LOCK_HOLDER_EXPECTED_CODE) reasons.push(`${label} recusada com ${a.result.code ?? '?'} (errno ${a.result.errno ?? '?'}): não é violação de compartilhamento; não confirma ${c.hypothesis}`)
    if (a.restoration !== null) {
      const r = a.restoration
      evidence.push(
        !r.identityMatched
          ? `restauração NÃO feita: o objeto no destino não tem a identidade do original`
          : r.result === null
            ? 'restauração não tentada'
            : `restauração (renomeação de volta): ${r.result.succeeded ? 'feita' : `falhou (${r.result.code ?? '?'})`}; o resultado da tentativa continua registrado`
      )
    }
  }
  if (o.attemptsStopped !== null) reasons.push(`tentativas interrompidas: ${o.attemptsStopped}`)
  else if (o.ready !== null && o.identityIssues !== null && o.identityIssues.length === 0 && o.attempts.length !== c.attempts.length) reasons.push(`${o.attempts.length} de ${c.attempts.length} tentativas feitas`)
  if (o.attempts.length > 0 && o.holderAliveThroughAttempts !== true) reasons.push('o segurador não estava ativo durante todas as tentativas')
  if (o.attempts.length > 0 && o.identityAfterIssues !== null && o.identityAfterIssues.length > 0) reasons.push(`depois das tentativas: ${o.identityAfterIssues.join('; ')}`)
  if (o.attempts.length > 0 && o.identityAfterIssues === null) reasons.push('identidade depois das tentativas não conferida')

  // 4. Liberação.
  const lines = completeLines(o.stdout)
  const released = lines.length >= 2 ? parseReleasedLine(lines[1]!) : null
  if (o.killRequestedMs !== null) reasons.push(`o supervisor encerrou o segurador pelo identificador (PID ${o.pid ?? '-'}) em ${o.killRequestedMs} ms: ${o.killAccepted ? 'aceito' : 'NÃO aceito'}`)
  if (o.releaseRequestedMs === null) {
    if (o.ready !== null) reasons.push('liberação não pedida')
  } else {
    evidence.push(`liberação PEDIDA em ${o.releaseRequestedMs} ms (entrada padrão fechada; nenhum byte escrito)`)
    if (o.exitMs !== null && o.exitMs < o.releaseRequestedMs) reasons.push(`o segurador saiu antes do pedido de liberação (código ${o.exitCode ?? '-'})`)
    if (released !== 'stdin') reasons.push(`sinal de liberação ${released === null ? 'ausente ou ilegível' : `reason=${released}`} (esperado reason=stdin)`)
    if (o.exitCode !== 0 || o.exitSignal !== null) reasons.push(`fim do segurador: código ${o.exitCode ?? '-'}${o.exitCode !== null && LOCK_HOLDER_EXIT[o.exitCode] ? ` (${LOCK_HOLDER_EXIT[o.exitCode]})` : ''}, sinal ${o.exitSignal ?? '-'} (esperado código 0)`)
    if (o.closeMs === null) reasons.push('close do segurador não chegou')
    else if (o.closeMs - o.releaseRequestedMs > LOCK_HOLDER_RELEASE_TIMEOUT_MS) reasons.push(`close ${o.closeMs - o.releaseRequestedMs} ms depois do pedido (limite ${LOCK_HOLDER_RELEASE_TIMEOUT_MS} ms)`)
    else if (released === 'stdin' && o.exitCode === 0) evidence.push(`travas soltas: released reason=stdin, código 0, close ${o.closeMs - o.releaseRequestedMs} ms depois do pedido`)
  }
  if (o.ready !== null && (lines.length !== 2 || o.stdout.split(/\r?\n/).filter((l) => l !== '').length !== 2)) reasons.push(`saída padrão com ${lines.length} linha(s) completa(s) (esperadas 2: prontidão e liberação)`)
  if (o.stderrBytes > 0) reasons.push('saída de erro não vazia')

  // 5. Conteúdo da cópia.
  const approved = APPROVED_ARTIFACTS.scenarios[c.scenario].sha256
  const hashes = [
    ['antes das tentativas', o.hashBefore],
    ['depois das tentativas', o.hashAfterAttempts],
    ['depois da liberação', o.hashAfterRelease]
  ] as const
  const wrong = hashes.filter(([, h]) => h !== approved)
  if (wrong.length > 0) reasons.push(`conteúdo da cópia do exit-ok não conferido ou diferente do aprovado (${wrong.map(([l]) => l).join(', ')})`)
  else evidence.push(`cópia do exit-ok idêntica à aprovada (SHA-256 ${approved.slice(0, 12)}…) antes, depois das tentativas e depois da liberação`)

  // 6. Censo.
  if (o.censusAfter === null) reasons.push('censo logo depois indisponível')
  else if (o.censusAfter > 0) reasons.push(`censo logo depois: ${o.censusAfter} processo(s) de teste`)
  else evidence.push('censo logo depois da liberação: 0 processos de teste')

  return { verdict: reasons.length > 0 ? { pass: false, reasons } : { pass: true, notes: [] }, evidence }
}

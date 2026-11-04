import {
  consentCovers,
  CURRENT_GRANT_SCOPE,
  deriveAnalysisStatus,
  migrateHardwareV1,
  migrateHardwareV2,
  migrateHardwareV3,
  NO_CONSENT,
  SCOPE_REQUIRED,
  STALE_AFTER_DAYS,
  validateAnalysisRecord,
  validateAnalysisRequest,
  validateHardwareConsent,
  validateHardwareProfile,
  validateLocalConsentChange,
  type AnalysisMode,
  type AnalysisOutcome,
  type AnalysisRecord,
  type DemoScenario,
  type HardwareAdvisorState,
  type HardwareConsent,
  type HardwareDetector,
  type LocalAnalysisDecision,
  type LocalAnalysisScope
} from '@shared/hardware'
import { formatIssues, isRecord, type ValidationIssue } from '@shared/validation'
import { AppError, unwrap } from '../errors'
import { abortReasonOf, DetectionAbortedError, type DetectionAbortReason } from './detection-errors'
import { VersionedStore, type ParseOutcome, type StoreStatus } from '../storage/versioned-store'

/**
 * Gerpro Hardware Advisor (Main).
 *
 * Guarda o consentimento e o resultado da última análise em `hardware.json`.
 * Toda análise exige consentimento local vigente. Os detectores são
 * injetados: trocar o demonstrativo/indisponível por um detector real não
 * exige mudar este serviço, o IPC nem a interface.
 */

/**
 * v1: perfil sem qualidade por atributo.
 * v2: `provenance.quality` (detectado/estimado/indisponível/simulado) e
 *     `cpu.physicalCores` anulável. Migração em `migrateHardwareV1`.
 * v3: todo atributo de `cpu`, `memory`, `storage` e `os` anulável (perfis
 *     parcialmente detectados). Todo arquivo v2 válido já é v3 válido; a
 *     versão muda para que um app v2 não recuse um perfil parcial como
 *     inválido e o substitua pelos padrões. Migração em `migrateHardwareV2`.
 * v4: `gpus[].model` e `gpus[].sharedMemory` anuláveis (GPU sem nome ou com
 *     classificação de memória não comprovada). Todo arquivo v3 válido já é
 *     v4 válido; a versão muda pelo mesmo motivo. Migração em `migrateHardwareV3`.
 */
export const HARDWARE_FORMAT_VERSION = 4
const DETECT_TIMEOUT_MS = 15_000
/** Faixa aceita para `detectTimeoutMs` (valores menores servem só a testes). */
export const DETECT_TIMEOUT_LIMITS = { min: 1, max: 60_000 } as const

/**
 * Análise interrompida (cancelamento ou prazo global). Nada é gravado: o
 * último perfil e o consentimento ficam como estavam. Sem código novo em
 * `ErrorCode`: o motivo vai em `details.aborted`.
 */
function abortedAnalysis(reason: DetectionAbortReason): AppError {
  const message =
    reason === 'timeout'
      ? 'A análise de hardware excedeu o tempo limite. Nada foi alterado; a análise anterior foi mantida.'
      : 'A análise de hardware foi cancelada. Nada foi alterado; a análise anterior foi mantida.'
  return new AppError('invalid-state', message, { retryable: true, details: { aborted: reason } })
}

/**
 * Espera `promise`, mas desiste quando o sinal dispara: um detector que
 * ignora o sinal não prende a análise. Uma rejeição tardia é absorvida.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DetectionAbortedError(abortReasonOf(signal)))
    if (signal.aborted) {
      promise.catch(() => undefined)
      return onAbort()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => (signal.removeEventListener('abort', onAbort), resolve(value)),
      (error: unknown) => (signal.removeEventListener('abort', onAbort), reject(error))
    )
  })
}

/** Mesma decisão de análise local (status, data e escopo): nenhuma revogação ou nova autorização no meio. */
const sameDecision = (a: LocalAnalysisDecision, b: LocalAnalysisDecision) => a.status === b.status && a.decidedAt === b.decidedAt && a.scope === b.scope

interface HardwareFile {
  consent: HardwareConsent
  lastAnalysis: AnalysisRecord | null
}

export function parseHardwareFile(data: unknown): ParseOutcome<HardwareFile> {
  if (!isRecord(data)) return { value: undefined, issues: [{ path: '$', message: 'deve ser um objeto' }] }
  const issues: ValidationIssue[] = []
  if (Object.keys(data).some((k) => k !== 'consent' && k !== 'lastAnalysis')) issues.push({ path: '$', message: 'campos não permitidos' })

  const consent = validateHardwareConsent(data['consent'])
  if (!consent.ok) {
    // Sem consentimento legível, o padrão seguro é "não autorizado" e nenhum dado.
    issues.push(...consent.issues.map((i) => ({ ...i, path: i.path.replace(/^\$/, '$.consent') })))
    return { value: { consent: structuredClone(NO_CONSENT), lastAnalysis: null }, issues }
  }

  let lastAnalysis: AnalysisRecord | null = null
  if (data['lastAnalysis'] !== null) {
    const record = validateAnalysisRecord(data['lastAnalysis'])
    if (record.ok) lastAnalysis = record.value
    else issues.push(...record.issues.map((i) => ({ ...i, path: i.path.replace(/^\$/, '$.lastAnalysis') })))
  }
  return { value: { consent: consent.value, lastAnalysis }, issues }
}

export interface HardwareAdvisorDeps {
  filePath: string
  /** Detector real. Nesta etapa, um que sempre se declara indisponível. */
  localDetector: HardwareDetector
  /** Fábrica do detector demonstrativo por cenário. */
  demoDetector: (scenario: DemoScenario) => HardwareDetector
  /**
   * Escopo gravado ao autorizar. Padrão: `CURRENT_GRANT_SCOPE` ('demo-only').
   * Só mude para 'device-detection' junto com uma tela de consentimento que
   * diga claramente que o hardware real será lido.
   */
  grantScope?: LocalAnalysisScope
  now?: () => Date
  /** Escrita do arquivo. Substituível só para simular falhas em testes. */
  writer?: (filePath: string, contents: string) => Promise<void>
  /** Prazo global de `detect()`, em ms (inteiro). Padrão 15 s; outro valor só em testes. */
  detectTimeoutMs?: number
}

export class HardwareAdvisorService {
  private readonly store: VersionedStore<HardwareFile>
  private readonly deps: HardwareAdvisorDeps
  private running: Promise<HardwareAdvisorState> | null = null

  constructor(deps: HardwareAdvisorDeps) {
    const timeout = deps.detectTimeoutMs
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < DETECT_TIMEOUT_LIMITS.min || timeout > DETECT_TIMEOUT_LIMITS.max)) {
      throw new RangeError(`detectTimeoutMs deve ser um inteiro entre ${DETECT_TIMEOUT_LIMITS.min} e ${DETECT_TIMEOUT_LIMITS.max}.`)
    }
    this.deps = deps
    this.store = new VersionedStore({
      filePath: deps.filePath,
      format: 'gerpro.hardware',
      version: HARDWARE_FORMAT_VERSION,
      defaults: () => ({ consent: structuredClone(NO_CONSENT), lastAnalysis: null }),
      parse: parseHardwareFile,
      migrations: { 1: migrateHardwareV1, 2: migrateHardwareV2, 3: migrateHardwareV3 },
      // A migração pode descartar uma análise real da v1; o original fica copiado.
      backupBeforeMigration: true,
      now: deps.now,
      writer: deps.writer
    })
  }

  async init(): Promise<StoreStatus> {
    await this.store.load()
    const status = this.store.status
    if (status.state === 'migrated') {
      // Grava já no formato novo: sem isso, cada abertura repetiria a migração
      // e a cópia do original. Se falhar, o arquivo v1 continua intacto.
      await this.store.update((file) => file).catch((error: unknown) => console.warn('[storage] hardware: migração não gravada', error))
    }
    return status
  }

  async getState(): Promise<HardwareAdvisorState> {
    const { consent, lastAnalysis } = await this.store.load()
    const authorized = consent.localAnalysis.status === 'granted'
    const local = await this.deps.localDetector.availability()
    return {
      consent: structuredClone(consent),
      status: deriveAnalysisStatus(consent, lastAnalysis, this.now()),
      // Sem autorização vigente, dados antigos não são exibidos, apenas sinalizados.
      analysis: authorized && lastAnalysis ? structuredClone(lastAnalysis) : null,
      hasStoredData: lastAnalysis !== null,
      detectors: { real: local, demo: { available: true, reason: null } },
      staleAfterDays: STALE_AFTER_DAYS
    }
  }

  /** Concede ou revoga a análise LOCAL. Não afeta `serverSharing`. */
  async setLocalConsent(input: unknown): Promise<HardwareAdvisorState> {
    const change = unwrap(validateLocalConsentChange(input))
    const at = this.now().toISOString()
    await this.store.update((file) => {
      const previous = file.consent.localAnalysis.status
      const status = change.granted ? 'granted' : previous === 'granted' || previous === 'revoked' ? 'revoked' : 'denied'
      return {
        consent: {
          ...file.consent,
          localAnalysis: { status, decidedAt: at, scope: change.granted ? (this.deps.grantScope ?? CURRENT_GRANT_SCOPE) : null }
        },
        lastAnalysis: change.deleteData ? null : file.lastAnalysis
      }
    })
    return this.getState()
  }

  /** Apaga os dados de hardware gravados. O consentimento é mantido. */
  async deleteData(): Promise<HardwareAdvisorState> {
    await this.store.update((file) => ({ ...file, lastAnalysis: null }))
    return this.getState()
  }

  /** Executa uma análise. Chamadas simultâneas compartilham a mesma execução. */
  analyze(input: unknown): Promise<HardwareAdvisorState> {
    const request = unwrap(validateAnalysisRequest(input))
    this.running ??= this.runAnalysis(request.mode, request.scenario ?? 'workstation').finally(() => {
      this.running = null
    })
    return this.running
  }

  private async runAnalysis(mode: AnalysisMode, scenario: DemoScenario): Promise<HardwareAdvisorState> {
    const { consent } = await this.store.load()
    if (consent.localAnalysis.status !== 'granted') {
      throw new AppError('invalid-state', 'A análise de hardware não está autorizada.')
    }

    const detector = mode === 'real' ? this.deps.localDetector : this.deps.demoDetector(scenario)
    const attemptedAt = this.now().toISOString()
    let record: AnalysisRecord
    // Consultar a disponibilidade não lê o hardware; só `detect` lê.
    const availability = await detector.availability()

    // Uma autorização demonstrativa nunca vale para leitura real do computador.
    // Sem leitura (detector indisponível), basta a autorização vigente.
    const required = availability.available ? SCOPE_REQUIRED[mode] : SCOPE_REQUIRED.demo
    if (!consentCovers(consent, required)) {
      throw new AppError(
        'invalid-state',
        'A autorização atual cobre apenas a demonstração. Para ler o hardware deste computador é preciso uma nova autorização.'
      )
    }

    if (!availability.available) {
      record = { mode, attemptedAt, outcome: { kind: 'unavailable', reason: availability.reason ?? 'Detector indisponível.' } }
    } else {
      // Interrompida (cancelamento ou prazo): lança sem gravar nada.
      record = { mode, attemptedAt, outcome: await this.runDetector(detector, mode) }
    }

    await this.store.update((file) => {
      // O consentimento pode ter mudado durante a análise: revogado, ou revogado e
      // concedido de novo. Nos dois casos o resultado é de outra autorização e é descartado.
      if (!consentCovers(file.consent, required)) {
        throw new AppError('invalid-state', 'A autorização foi revogada durante a análise; o resultado foi descartado.')
      }
      if (!sameDecision(file.consent.localAnalysis, consent.localAnalysis)) {
        throw new AppError('invalid-state', 'A autorização mudou durante a análise; o resultado foi descartado.')
      }
      return { ...file, lastAnalysis: record }
    })
    return this.getState()
  }

  /**
   * Executa o detector com o prazo global e devolve o resultado a registrar.
   * - Concluído ou falha comum: resultado a gravar (perfil ou `error`).
   * - Interrompido (`DetectionAbortedError`, sinal disparado, resultado que
   *   chegou depois do prazo): lança `abortedAnalysis`, sem validar nem gravar.
   */
  private async runDetector(detector: HardwareDetector, mode: AnalysisMode): Promise<AnalysisOutcome> {
    const signal = AbortSignal.timeout(this.deps.detectTimeoutMs ?? DETECT_TIMEOUT_MS)
    let raw: unknown
    try {
      raw = await untilAborted(detector.detect(signal), signal)
    } catch (error) {
      if (error instanceof DetectionAbortedError) throw abortedAnalysis(error.reason)
      // Falha surgida depois da interrupção é consequência dela, não falha própria do detector.
      if (signal.aborted) throw abortedAnalysis(abortReasonOf(signal))
      const message = error instanceof Error && error.message ? error.message : 'Falha desconhecida do detector.'
      return { kind: 'error', message: message.slice(0, 500) }
    }
    // Resultado entregue depois do prazo: descartado sem validar nem publicar.
    if (signal.aborted) throw abortedAnalysis(abortReasonOf(signal))

    const profile = validateHardwareProfile(raw)
    if (!profile.ok) return { kind: 'error', message: `Perfil inválido do detector: ${formatIssues(profile.issues)}`.slice(0, 500) }
    if (mode === 'demo' && profile.value.provenance.source !== 'demo') {
      return { kind: 'error', message: 'O detector demonstrativo produziu dados não marcados como demonstração.' }
    }
    return { kind: 'completed', profile: profile.value }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }
}

import {
  consentCovers,
  CURRENT_GRANT_SCOPE,
  deriveAnalysisStatus,
  NO_CONSENT,
  SCOPE_REQUIRED,
  STALE_AFTER_DAYS,
  validateAnalysisRecord,
  validateAnalysisRequest,
  validateHardwareConsent,
  validateHardwareProfile,
  validateLocalConsentChange,
  type AnalysisMode,
  type AnalysisRecord,
  type DemoScenario,
  type HardwareAdvisorState,
  type HardwareConsent,
  type HardwareDetector,
  type LocalAnalysisScope
} from '@shared/hardware'
import { formatIssues, isRecord, type ValidationIssue } from '@shared/validation'
import { AppError, unwrap } from '../errors'
import { VersionedStore, type ParseOutcome, type StoreStatus } from '../storage/versioned-store'

/**
 * Gerpro Hardware Advisor (Main).
 *
 * Guarda o consentimento e o resultado da última análise em `hardware.json`.
 * Toda análise exige consentimento local vigente. Os detectores são
 * injetados: trocar o demonstrativo/indisponível por um detector real não
 * exige mudar este serviço, o IPC nem a interface.
 */

export const HARDWARE_FORMAT_VERSION = 1
const DETECT_TIMEOUT_MS = 15_000

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
}

export class HardwareAdvisorService {
  private readonly store: VersionedStore<HardwareFile>
  private readonly deps: HardwareAdvisorDeps
  private running: Promise<HardwareAdvisorState> | null = null

  constructor(deps: HardwareAdvisorDeps) {
    this.deps = deps
    this.store = new VersionedStore({
      filePath: deps.filePath,
      format: 'gerpro.hardware',
      version: HARDWARE_FORMAT_VERSION,
      defaults: () => ({ consent: structuredClone(NO_CONSENT), lastAnalysis: null }),
      parse: parseHardwareFile,
      now: deps.now
    })
  }

  async init(): Promise<StoreStatus> {
    await this.store.load()
    return this.store.status
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
      try {
        const raw = await detector.detect(AbortSignal.timeout(DETECT_TIMEOUT_MS))
        const profile = validateHardwareProfile(raw)
        if (!profile.ok) {
          record = { mode, attemptedAt, outcome: { kind: 'error', message: `Perfil inválido do detector: ${formatIssues(profile.issues)}`.slice(0, 500) } }
        } else if (mode === 'demo' && profile.value.provenance.source !== 'demo') {
          record = { mode, attemptedAt, outcome: { kind: 'error', message: 'O detector demonstrativo produziu dados não marcados como demonstração.' } }
        } else {
          record = { mode, attemptedAt, outcome: { kind: 'completed', profile: profile.value } }
        }
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : 'Falha desconhecida do detector.'
        record = { mode, attemptedAt, outcome: { kind: 'error', message: message.slice(0, 500) } }
      }
    }

    await this.store.update((file) => {
      // O consentimento pode ter sido revogado durante a análise: nesse caso, nada é gravado.
      if (!consentCovers(file.consent, required)) {
        throw new AppError('invalid-state', 'A autorização foi revogada durante a análise; o resultado foi descartado.')
      }
      return { ...file, lastAnalysis: record }
    })
    return this.getState()
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }
}

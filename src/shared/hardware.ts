/**
 * Contratos do Gerpro Hardware Advisor.
 *
 * O Advisor avalia os recursos do computador para recomendar agentes e
 * modelos. Nesta etapa NÃO há leitura real de hardware: o único detector
 * funcional é o demonstrativo, cujos perfis são fictícios e marcados com
 * `provenance.source === 'demo'`. Um detector real deve implementar
 * `HardwareDetector` e ser registrado no Main (ver src/main/hardware/README.md).
 *
 * Convenção de campos: `null` = desconhecido (não foi possível identificar);
 * lista vazia = verificado e inexistente (ex.: nenhuma GPU dedicada).
 */

import { Checker, type ValidationResult } from './validation'

// ---------------------------------------------------------------------------
// Perfil de hardware
// ---------------------------------------------------------------------------

export type CpuArchitecture = 'x64' | 'arm64' | 'x86' | 'other'

export interface CpuInfo {
  model: string
  architecture: CpuArchitecture
  physicalCores: number
  logicalCores: number
}

export interface MemoryInfo {
  totalGb: number
  /** Livre no momento da coleta; muda com o uso do computador. */
  availableGb: number
}

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other' | 'unknown'

export interface GpuInfo {
  vendor: GpuVendor
  model: string
  /** `null` quando o fabricante/driver não informa a memória de vídeo. */
  vramGb: number | null
  /** Memória compartilhada com a CPU (integradas, Apple Silicon). */
  sharedMemory: boolean
}

export interface StorageInfo {
  /** Volume onde os modelos seriam guardados. */
  freeGb: number
  totalGb: number
}

export type OsPlatform = 'windows' | 'macos' | 'linux' | 'other'

export interface OsInfo {
  platform: OsPlatform
  version: string
  architecture: CpuArchitecture
}

/** Capacidades de aceleração relevantes para inferência local. */
export const ACCELERATIONS = ['avx2', 'avx512', 'neon', 'cuda', 'rocm', 'metal', 'vulkan', 'directml'] as const
export type Acceleration = (typeof ACCELERATIONS)[number]

/** De onde vieram os dados e quanto confiar neles. */
export type HardwareSource = 'demo' | 'local-detector'
export type DataConfidence = 'high' | 'medium' | 'low'

export interface HardwareProvenance {
  source: HardwareSource
  /** Identificador do detector que produziu o perfil. */
  detectorId: string
  collectedAt: string
  confidence: DataConfidence
}

export interface HardwareProfile {
  cpu: CpuInfo | null
  memory: MemoryInfo | null
  /** `null` = não identificável; `[]` = nenhuma GPU. */
  gpus: GpuInfo[] | null
  storage: StorageInfo | null
  os: OsInfo | null
  /** `null` = não identificável; `[]` = nenhuma conhecida. */
  acceleration: Acceleration[] | null
  provenance: HardwareProvenance
}

// ---------------------------------------------------------------------------
// Consentimento
// ---------------------------------------------------------------------------

/**
 * Cada finalidade tem consentimento próprio. Autorizar a análise LOCAL não
 * autoriza enviar nada a servidores; `serverSharing` é independente e nesta
 * etapa não pode ser concedido.
 */
export type ConsentStatus = 'not-asked' | 'granted' | 'denied' | 'revoked'

export interface ConsentDecision {
  status: ConsentStatus
  decidedAt: string | null
}

/**
 * O que exatamente o usuário autorizou na análise local.
 * - `demo-only`: concedido enquanto o app só tinha o detector demonstrativo
 *   e dizia que nada do computador seria lido. NÃO cobre leitura real.
 * - `device-detection`: leitura real do hardware deste computador.
 *
 * Uma autorização nunca é ampliada automaticamente: quando a detecção real
 * existir, quem autorizou `demo-only` precisa autorizar de novo.
 */
export const LOCAL_ANALYSIS_SCOPES = ['demo-only', 'device-detection'] as const
export type LocalAnalysisScope = (typeof LOCAL_ANALYSIS_SCOPES)[number]

/** Escopo concedido por esta versão do app ao autorizar. */
export const CURRENT_GRANT_SCOPE: LocalAnalysisScope = 'demo-only'

export interface LocalAnalysisDecision extends ConsentDecision {
  /** Preenchido só quando `status === 'granted'`. */
  scope: LocalAnalysisScope | null
}

export interface HardwareConsent {
  localAnalysis: LocalAnalysisDecision
  serverSharing: ConsentDecision
}

export const NO_CONSENT: HardwareConsent = {
  localAnalysis: { status: 'not-asked', decidedAt: null, scope: null },
  serverSharing: { status: 'not-asked', decidedAt: null }
}

/** Escopo exigido por cada modo de análise. */
export const SCOPE_REQUIRED: Record<'real' | 'demo', LocalAnalysisScope> = {
  demo: 'demo-only',
  real: 'device-detection'
}

/** A autorização vigente cobre o escopo pedido? `device-detection` cobre também a demonstração. */
export function consentCovers(consent: HardwareConsent, required: LocalAnalysisScope): boolean {
  const { status, scope } = consent.localAnalysis
  if (status !== 'granted' || scope === null) return false
  return scope === 'device-detection' || required === 'demo-only'
}

/** Informações que a análise local consultaria, mostradas antes de autorizar. */
export const HARDWARE_DATA_POINTS: ReadonlyArray<{ id: keyof Omit<HardwareProfile, 'provenance'>; label: string; detail: string }> = [
  { id: 'cpu', label: 'Processador', detail: 'Modelo, arquitetura e quantidade de núcleos.' },
  { id: 'memory', label: 'Memória RAM', detail: 'Total instalado e quantidade disponível no momento.' },
  { id: 'gpus', label: 'Placa de vídeo', detail: 'Fabricante, modelo e memória de vídeo, quando identificáveis.' },
  { id: 'storage', label: 'Armazenamento', detail: 'Espaço livre e total na unidade dos modelos.' },
  { id: 'os', label: 'Sistema operacional', detail: 'Sistema, versão e arquitetura.' },
  { id: 'acceleration', label: 'Aceleração', detail: 'Instruções e APIs de aceleração disponíveis (ex.: AVX2, CUDA, Metal).' }
]

// ---------------------------------------------------------------------------
// Análise
// ---------------------------------------------------------------------------

export type AnalysisMode = 'real' | 'demo'

/** Cenários do detector demonstrativo (todos fictícios). */
export const DEMO_SCENARIOS = ['workstation', 'modest', 'partial', 'stale', 'error'] as const
export type DemoScenario = (typeof DEMO_SCENARIOS)[number]

export interface AnalysisRequest {
  mode: AnalysisMode
  /** Só para `mode: 'demo'`. */
  scenario?: DemoScenario
}

export type AnalysisOutcome =
  | { kind: 'completed'; profile: HardwareProfile }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; message: string }

export interface AnalysisRecord {
  mode: AnalysisMode
  attemptedAt: string
  outcome: AnalysisOutcome
}

/**
 * Estado exibido na interface:
 * - `not-authorized`: análise local não autorizada.
 * - `awaiting-analysis`: autorizada, nenhuma análise feita.
 * - `unavailable`: a última tentativa não pôde ser feita (detector ausente).
 * - `completed`: perfil disponível e recente.
 * - `stale`: perfil disponível, mas antigo.
 * - `error`: a última tentativa falhou.
 */
export type HardwareAnalysisStatus = 'not-authorized' | 'awaiting-analysis' | 'unavailable' | 'completed' | 'stale' | 'error'

export const STALE_AFTER_DAYS = 30

export interface DetectorAvailability {
  available: boolean
  reason: string | null
}

/** Estado completo entregue ao Renderer. */
export interface HardwareAdvisorState {
  consent: HardwareConsent
  status: HardwareAnalysisStatus
  /** Só preenchido quando a análise local está autorizada. */
  analysis: AnalysisRecord | null
  /** Há dados de hardware gravados (mesmo sem autorização vigente). */
  hasStoredData: boolean
  detectors: Record<AnalysisMode, DetectorAvailability>
  staleAfterDays: number
}

export function deriveAnalysisStatus(
  consent: HardwareConsent,
  analysis: AnalysisRecord | null,
  now: Date,
  staleAfterDays = STALE_AFTER_DAYS
): HardwareAnalysisStatus {
  if (consent.localAnalysis.status !== 'granted') return 'not-authorized'
  if (!analysis) return 'awaiting-analysis'
  switch (analysis.outcome.kind) {
    case 'unavailable':
      return 'unavailable'
    case 'error':
      return 'error'
    case 'completed': {
      const age = now.getTime() - Date.parse(analysis.outcome.profile.provenance.collectedAt)
      return age > staleAfterDays * 86_400_000 ? 'stale' : 'completed'
    }
  }
}

/** Perfil utilizável para recomendações (concluído ou desatualizado). */
export function usableProfile(state: Pick<HardwareAdvisorState, 'status' | 'analysis'>): HardwareProfile | null {
  if ((state.status === 'completed' || state.status === 'stale') && state.analysis?.outcome.kind === 'completed') {
    return state.analysis.outcome.profile
  }
  return null
}

// ---------------------------------------------------------------------------
// Ponto de extensão: detectores
// ---------------------------------------------------------------------------

/**
 * Implementado por quem coleta o perfil. O Main valida o resultado com
 * `validateHardwareProfile` antes de guardá-lo; detectores não precisam
 * (nem devem) gravar nada por conta própria.
 */
export interface HardwareDetector {
  readonly id: string
  readonly source: HardwareSource
  availability(): Promise<DetectorAvailability>
  detect(signal: AbortSignal): Promise<HardwareProfile>
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

const ARCHS = ['x64', 'arm64', 'x86', 'other'] as const
const VENDORS = ['nvidia', 'amd', 'intel', 'apple', 'other', 'unknown'] as const
const PLATFORMS = ['windows', 'macos', 'linux', 'other'] as const
const GB = { min: 0, max: 1_048_576 }

function readSection<T>(c: Checker, value: unknown, path: string, read: (o: Record<string, unknown>) => T | undefined, keys: readonly string[]) {
  return c.nullable(value, path, (v, p) => {
    const o = c.record(v, p, keys)
    return o ? read(o) : undefined
  })
}

/** Valida um perfil vindo de um detector ou do disco. */
export function validateHardwareProfile(input: unknown): ValidationResult<HardwareProfile> {
  const c = new Checker()
  const o = c.record(input, '$', ['cpu', 'memory', 'gpus', 'storage', 'os', 'acceleration', 'provenance'])
  if (!o) return c.result<HardwareProfile>(undefined)

  const cpu = readSection(
    c,
    o['cpu'],
    '$.cpu',
    (x) => {
      const model = c.string(x['model'], '$.cpu.model', { min: 1, max: 200 })
      const architecture = c.oneOf(x['architecture'], '$.cpu.architecture', ARCHS)
      const physicalCores = c.number(x['physicalCores'], '$.cpu.physicalCores', { integer: true, min: 1, max: 4096 })
      const logicalCores = c.number(x['logicalCores'], '$.cpu.logicalCores', { integer: true, min: 1, max: 8192 })
      if (physicalCores !== undefined && logicalCores !== undefined && logicalCores < physicalCores) {
        c.fail('$.cpu.logicalCores', 'não pode ser menor que os núcleos físicos')
      }
      return model && architecture && physicalCores && logicalCores ? { model, architecture, physicalCores, logicalCores } : undefined
    },
    ['model', 'architecture', 'physicalCores', 'logicalCores']
  )

  const memory = readSection(
    c,
    o['memory'],
    '$.memory',
    (x) => {
      const totalGb = c.number(x['totalGb'], '$.memory.totalGb', { ...GB, min: 0.1 })
      const availableGb = c.number(x['availableGb'], '$.memory.availableGb', GB)
      if (totalGb !== undefined && availableGb !== undefined && availableGb > totalGb) {
        c.fail('$.memory.availableGb', 'não pode exceder o total')
      }
      return totalGb !== undefined && availableGb !== undefined ? { totalGb, availableGb } : undefined
    },
    ['totalGb', 'availableGb']
  )

  const gpus = c.nullable(o['gpus'], '$.gpus', (v, p) =>
    c.array(
      v,
      p,
      (g, gp) => {
        const x = c.record(g, gp, ['vendor', 'model', 'vramGb', 'sharedMemory'])
        if (!x) return undefined
        const vendor = c.oneOf(x['vendor'], `${gp}.vendor`, VENDORS)
        const model = c.string(x['model'], `${gp}.model`, { min: 1, max: 200 })
        const vramGb = c.nullable(x['vramGb'], `${gp}.vramGb`, (n, np) => c.number(n, np, GB))
        const sharedMemory = c.boolean(x['sharedMemory'], `${gp}.sharedMemory`)
        return vendor && model && vramGb !== undefined && sharedMemory !== undefined ? { vendor, model, vramGb, sharedMemory } : undefined
      },
      { max: 16 }
    )
  )

  const storage = readSection(
    c,
    o['storage'],
    '$.storage',
    (x) => {
      const freeGb = c.number(x['freeGb'], '$.storage.freeGb', GB)
      const totalGb = c.number(x['totalGb'], '$.storage.totalGb', { ...GB, min: 0.1 })
      if (freeGb !== undefined && totalGb !== undefined && freeGb > totalGb) c.fail('$.storage.freeGb', 'não pode exceder o total')
      return freeGb !== undefined && totalGb !== undefined ? { freeGb, totalGb } : undefined
    },
    ['freeGb', 'totalGb']
  )

  const os = readSection(
    c,
    o['os'],
    '$.os',
    (x) => {
      const platform = c.oneOf(x['platform'], '$.os.platform', PLATFORMS)
      const version = c.string(x['version'], '$.os.version', { min: 1, max: 100 })
      const architecture = c.oneOf(x['architecture'], '$.os.architecture', ARCHS)
      return platform && version && architecture ? { platform, version, architecture } : undefined
    },
    ['platform', 'version', 'architecture']
  )

  const acceleration = c.nullable(o['acceleration'], '$.acceleration', (v, p) =>
    c.array(v, p, (a, ap) => c.oneOf(a, ap, ACCELERATIONS), { unique: true })
  )

  const pv = c.record(o['provenance'], '$.provenance', ['source', 'detectorId', 'collectedAt', 'confidence'])
  const provenance = pv && {
    source: c.oneOf(pv['source'], '$.provenance.source', ['demo', 'local-detector'] as const),
    detectorId: c.string(pv['detectorId'], '$.provenance.detectorId', { min: 1, max: 100 }),
    collectedAt: c.isoDate(pv['collectedAt'], '$.provenance.collectedAt'),
    confidence: c.oneOf(pv['confidence'], '$.provenance.confidence', ['high', 'medium', 'low'] as const)
  }

  if (!c.ok) return c.result<HardwareProfile>(undefined)
  return c.result({ cpu, memory, gpus, storage, os, acceleration, provenance } as HardwareProfile)
}

function readConsentDecision(c: Checker, value: unknown, path: string, extraKeys: readonly string[] = []): ConsentDecision | undefined {
  const o = c.record(value, path, ['status', 'decidedAt', ...extraKeys])
  if (!o) return undefined
  const status = c.oneOf(o['status'], `${path}.status`, ['not-asked', 'granted', 'denied', 'revoked'] as const)
  const decidedAt = c.nullable(o['decidedAt'], `${path}.decidedAt`, (v, p) => c.isoDate(v, p))
  if (status && status !== 'not-asked' && decidedAt === null) c.fail(`${path}.decidedAt`, 'obrigatório após uma decisão')
  return status && decidedAt !== undefined ? { status, decidedAt } : undefined
}

export function validateHardwareConsent(input: unknown): ValidationResult<HardwareConsent> {
  const c = new Checker()
  const o = c.record(input, '$', ['localAnalysis', 'serverSharing'])
  const localDecision = o && readConsentDecision(c, o['localAnalysis'], '$.localAnalysis', ['scope'])
  let localAnalysis: LocalAnalysisDecision | undefined
  if (localDecision) {
    const raw = (o['localAnalysis'] as Record<string, unknown>)['scope']
    const scope = c.nullable(raw, '$.localAnalysis.scope', (v, p) => c.oneOf(v, p, LOCAL_ANALYSIS_SCOPES))
    // Escopo obrigatório para autorizações e proibido nas demais: nada é presumido.
    if (localDecision.status === 'granted' && scope === null) c.fail('$.localAnalysis.scope', 'obrigatório quando autorizado')
    if (localDecision.status !== 'granted' && scope) c.fail('$.localAnalysis.scope', 'só existe quando autorizado')
    if (scope !== undefined) localAnalysis = { ...localDecision, scope }
  }
  const serverSharing = o && readConsentDecision(c, o['serverSharing'], '$.serverSharing')
  if (serverSharing?.status === 'granted') c.fail('$.serverSharing.status', 'envio ao servidor não pode ser autorizado nesta versão')
  return c.result(c.ok && localAnalysis && serverSharing ? { localAnalysis, serverSharing } : undefined)
}

export function validateAnalysisRecord(input: unknown): ValidationResult<AnalysisRecord> {
  const c = new Checker()
  const o = c.record(input, '$', ['mode', 'attemptedAt', 'outcome'])
  if (!o) return c.result<AnalysisRecord>(undefined)
  const mode = c.oneOf(o['mode'], '$.mode', ['real', 'demo'] as const)
  const attemptedAt = c.isoDate(o['attemptedAt'], '$.attemptedAt')
  const out = c.record(o['outcome'], '$.outcome')
  let outcome: AnalysisOutcome | undefined
  if (out) {
    const kind = c.oneOf(out['kind'], '$.outcome.kind', ['completed', 'unavailable', 'error'] as const)
    if (kind === 'completed') {
      c.record(out, '$.outcome', ['kind', 'profile'])
      const profile = validateHardwareProfile(out['profile'])
      if (profile.ok) outcome = { kind, profile: profile.value }
      else profile.issues.forEach((i) => c.fail(i.path.replace(/^\$/, '$.outcome.profile'), i.message))
    } else if (kind === 'unavailable') {
      c.record(out, '$.outcome', ['kind', 'reason'])
      const reason = c.string(out['reason'], '$.outcome.reason', { min: 1, max: 500 })
      if (reason) outcome = { kind, reason }
    } else if (kind === 'error') {
      c.record(out, '$.outcome', ['kind', 'message'])
      const message = c.string(out['message'], '$.outcome.message', { min: 1, max: 500 })
      if (message) outcome = { kind, message }
    }
  }
  if (outcome?.kind === 'completed' && mode === 'demo' && outcome.profile.provenance.source !== 'demo') {
    c.fail('$.outcome.profile.provenance.source', 'análise demonstrativa deve produzir perfil demonstrativo')
  }
  return c.result(c.ok && mode && attemptedAt && outcome ? { mode, attemptedAt, outcome } : undefined)
}

export function validateAnalysisRequest(input: unknown): ValidationResult<AnalysisRequest> {
  const c = new Checker()
  const o = c.record(input, '$', ['mode', 'scenario'])
  if (!o) return c.result<AnalysisRequest>(undefined)
  const mode = c.oneOf(o['mode'], '$.mode', ['real', 'demo'] as const)
  let scenario: DemoScenario | undefined
  if (mode === 'demo') scenario = c.oneOf(o['scenario'] ?? 'workstation', '$.scenario', DEMO_SCENARIOS)
  else if (mode === 'real' && 'scenario' in o) c.fail('$.scenario', 'só se aplica ao modo demonstrativo')
  return c.result(mode ? (scenario ? { mode, scenario } : { mode }) : undefined)
}

export interface LocalConsentChange {
  granted: boolean
  /** Ao revogar, apagar também os dados de hardware gravados. */
  deleteData?: boolean
}

export function validateLocalConsentChange(input: unknown): ValidationResult<LocalConsentChange> {
  const c = new Checker()
  const o = c.record(input, '$', ['granted', 'deleteData'])
  if (!o) return c.result<LocalConsentChange>(undefined)
  const granted = c.boolean(o['granted'], '$.granted')
  const deleteData = 'deleteData' in o ? c.boolean(o['deleteData'], '$.deleteData') : false
  if (granted && deleteData) c.fail('$.deleteData', 'só se aplica ao revogar')
  return c.result(granted !== undefined && deleteData !== undefined ? { granted, deleteData } : undefined)
}


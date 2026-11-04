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
 *
 * A origem de cada atributo fica em `provenance.quality` (detectado, estimado,
 * indisponível ou simulado), coerente com os valores: um atributo `null` é
 * sempre "indisponível", e nenhum valor presente é dado como indisponível.
 */

import { Checker, isRecord, type ValidationResult } from './validation'

// ---------------------------------------------------------------------------
// Perfil de hardware
// ---------------------------------------------------------------------------

export type CpuArchitecture = 'x64' | 'arm64' | 'x86' | 'other'

/*
 * Atributos `null` = não identificados; os demais da seção continuam valendo.
 * Uma seção sem nenhum atributo conhecido é `null` (forma única para "nada").
 */

export interface CpuInfo {
  model: string | null
  architecture: CpuArchitecture | null
  /** `null` quando não identificável (ex.: só a contagem lógica está disponível). */
  physicalCores: number | null
  logicalCores: number | null
}

export interface MemoryInfo {
  totalGb: number | null
  /** Livre no momento da coleta; muda com o uso do computador. */
  availableGb: number | null
}

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other' | 'unknown'

/*
 * Cada atributo da GPU é independente: uma GPU parcialmente identificada
 * continua no perfil. Uma GPU sem nenhum atributo conhecido é recusada.
 */
export interface GpuInfo {
  /** `'unknown'` quando o fabricante não foi identificado. */
  vendor: GpuVendor
  /** `null` quando o nome do adaptador não foi informado. */
  model: string | null
  /**
   * Memória dedicada do adaptador, como informada pelo driver; `null` quando
   * não informada ou sem associação comprovada com o adaptador. Numa GPU
   * integrada pode ser só a reserva do firmware: só vale como VRAM para
   * inferência quando `sharedMemory === false`.
   */
  vramGb: number | null
  /**
   * `true`: usa a memória do sistema (integradas, Apple Silicon).
   * `false`: memória própria (dedicada). `null`: classificação não comprovada;
   * não deve ser tratada como dedicada nem como compartilhada.
   */
  sharedMemory: boolean | null
}

export interface StorageInfo {
  /** Volume onde os modelos seriam guardados. */
  freeGb: number | null
  totalGb: number | null
}

export type OsPlatform = 'windows' | 'macos' | 'linux' | 'other'

export interface OsInfo {
  platform: OsPlatform | null
  version: string | null
  architecture: CpuArchitecture | null
}

/** Capacidades de aceleração relevantes para inferência local. */
export const ACCELERATIONS = ['avx2', 'avx512', 'neon', 'cuda', 'rocm', 'metal', 'vulkan', 'directml'] as const
export type Acceleration = (typeof ACCELERATIONS)[number]

/** De onde vieram os dados e quanto confiar neles. */
export type HardwareSource = 'demo' | 'local-detector'
export type DataConfidence = 'high' | 'medium' | 'low'

/**
 * Origem de cada atributo do perfil:
 * - `detected`: lido do sistema.
 * - `estimated`: deduzido (heurística ou fonte indireta), não lido diretamente.
 * - `unavailable`: não foi possível obter; o valor é `null` (ou `vendor: 'unknown'`).
 * - `simulated`: dado fictício do detector demonstrativo.
 */
export const DATA_QUALITIES = ['detected', 'estimated', 'unavailable', 'simulated'] as const
export type DataQuality = (typeof DATA_QUALITIES)[number]

/** Atributos do perfil com qualidade própria. `gpus` e `acceleration` qualificam a lista. */
export const PROFILE_FIELDS = [
  'cpu.model',
  'cpu.architecture',
  'cpu.physicalCores',
  'cpu.logicalCores',
  'memory.totalGb',
  'memory.availableGb',
  'gpus',
  'storage.freeGb',
  'storage.totalGb',
  'os.platform',
  'os.version',
  'os.architecture',
  'acceleration'
] as const
export type ProfileField = (typeof PROFILE_FIELDS)[number]

/** Atributos de cada GPU com qualidade própria. */
export const GPU_FIELDS = ['vendor', 'model', 'vramGb', 'sharedMemory'] as const
export type GpuField = (typeof GPU_FIELDS)[number]
export type GpuQuality = Record<GpuField, DataQuality>

export interface HardwareQuality {
  fields: Record<ProfileField, DataQuality>
  /** Uma entrada por GPU, na mesma ordem de `profile.gpus`; `null` quando `gpus` é `null`. */
  gpus: GpuQuality[] | null
}

export interface HardwareProvenance {
  source: HardwareSource
  /** Identificador do detector que produziu o perfil. */
  detectorId: string
  collectedAt: string
  /** Confiabilidade geral do perfil; o detalhe por atributo está em `quality`. */
  confidence: DataConfidence
  quality: HardwareQuality
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

/** Perfil sem a proveniência: o que um detector mede. */
export type HardwareProfileData = Omit<HardwareProfile, 'provenance'>

/** Valor de um atributo; `undefined` quando a seção não tem o formato esperado. */
function fieldValue(profile: unknown, field: ProfileField): unknown {
  if (!isRecord(profile)) return undefined
  const [section, key] = field.split('.') as [string, string | undefined]
  const value = profile[section]
  if (key === undefined || value === null) return value
  return isRecord(value) ? value[key] : undefined
}

function gpuFieldKnown(gpu: Record<string, unknown>, field: GpuField): boolean {
  const value = gpu[field]
  return value !== null && value !== undefined && !(field === 'vendor' && value === 'unknown')
}

/**
 * Qualidade uniforme: `known` para todo atributo presente e `unavailable`
 * para os ausentes. Tolera dados ainda não validados (usada na migração).
 */
export function uniformQuality(profile: unknown, known: Exclude<DataQuality, 'unavailable'>): HardwareQuality {
  const of = (present: boolean): DataQuality => (present ? known : 'unavailable')
  const fields = Object.fromEntries(
    PROFILE_FIELDS.map((f) => {
      const value = fieldValue(profile, f)
      return [f, of(value !== null && value !== undefined)]
    })
  ) as Record<ProfileField, DataQuality>
  const gpus = fieldValue(profile, 'gpus')
  return {
    fields,
    gpus: Array.isArray(gpus)
      ? gpus.map((g) => Object.fromEntries(GPU_FIELDS.map((f) => [f, of(isRecord(g) && gpuFieldKnown(g, f))])) as GpuQuality)
      : null
  }
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

/**
 * Seção com atributos anuláveis: todos os campos são obrigatórios (`null`
 * explícito para o desconhecido), e uma seção sem nenhum atributo conhecido
 * deve ser `null`.
 */
function readSection<T extends object>(c: Checker, value: unknown, path: string, read: (o: Record<string, unknown>) => T | undefined, keys: readonly string[]) {
  return c.nullable(value, path, (v, p) => {
    const o = c.record(v, p, keys)
    const section = o ? read(o) : undefined
    if (section && Object.values(section).every((x) => x === null)) return c.fail(p, 'sem atributos conhecidos: a seção deve ser null')
    return section
  })
}

const orNull = <T>(c: Checker, value: unknown, path: string, read: (v: unknown, p: string) => T | undefined) => c.nullable(value, path, read)

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
      const model = orNull(c, x['model'], '$.cpu.model', (v, p) => c.string(v, p, { min: 1, max: 200 }))
      const architecture = orNull(c, x['architecture'], '$.cpu.architecture', (v, p) => c.oneOf(v, p, ARCHS))
      const physicalCores = orNull(c, x['physicalCores'], '$.cpu.physicalCores', (v, p) => c.number(v, p, { integer: true, min: 1, max: 4096 }))
      const logicalCores = orNull(c, x['logicalCores'], '$.cpu.logicalCores', (v, p) => c.number(v, p, { integer: true, min: 1, max: 8192 }))
      if (typeof physicalCores === 'number' && typeof logicalCores === 'number' && logicalCores < physicalCores) {
        c.fail('$.cpu.logicalCores', 'não pode ser menor que os núcleos físicos')
      }
      return model !== undefined && architecture !== undefined && physicalCores !== undefined && logicalCores !== undefined
        ? { model, architecture, physicalCores, logicalCores }
        : undefined
    },
    ['model', 'architecture', 'physicalCores', 'logicalCores']
  )

  const memory = readSection(
    c,
    o['memory'],
    '$.memory',
    (x) => {
      const totalGb = orNull(c, x['totalGb'], '$.memory.totalGb', (v, p) => c.number(v, p, { ...GB, min: 0.1 }))
      const availableGb = orNull(c, x['availableGb'], '$.memory.availableGb', (v, p) => c.number(v, p, GB))
      if (typeof totalGb === 'number' && typeof availableGb === 'number' && availableGb > totalGb) {
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
        const model = orNull(c, x['model'], `${gp}.model`, (m, mp) => c.string(m, mp, { min: 1, max: 200 }))
        const vramGb = orNull(c, x['vramGb'], `${gp}.vramGb`, (n, np) => c.number(n, np, GB))
        const sharedMemory = orNull(c, x['sharedMemory'], `${gp}.sharedMemory`, (b, bp) => c.boolean(b, bp))
        if (vendor === undefined || model === undefined || vramGb === undefined || sharedMemory === undefined) return undefined
        if (vendor === 'unknown' && model === null && vramGb === null && sharedMemory === null) {
          return c.fail(gp, 'sem atributos conhecidos: a GPU não deve constar da lista')
        }
        return { vendor, model, vramGb, sharedMemory }
      },
      { max: 16 }
    )
  )

  const storage = readSection(
    c,
    o['storage'],
    '$.storage',
    (x) => {
      const freeGb = orNull(c, x['freeGb'], '$.storage.freeGb', (v, p) => c.number(v, p, GB))
      const totalGb = orNull(c, x['totalGb'], '$.storage.totalGb', (v, p) => c.number(v, p, { ...GB, min: 0.1 }))
      if (typeof freeGb === 'number' && typeof totalGb === 'number' && freeGb > totalGb) c.fail('$.storage.freeGb', 'não pode exceder o total')
      return freeGb !== undefined && totalGb !== undefined ? { freeGb, totalGb } : undefined
    },
    ['freeGb', 'totalGb']
  )

  const os = readSection(
    c,
    o['os'],
    '$.os',
    (x) => {
      const platform = orNull(c, x['platform'], '$.os.platform', (v, p) => c.oneOf(v, p, PLATFORMS))
      const version = orNull(c, x['version'], '$.os.version', (v, p) => c.string(v, p, { min: 1, max: 100 }))
      const architecture = orNull(c, x['architecture'], '$.os.architecture', (v, p) => c.oneOf(v, p, ARCHS))
      return platform !== undefined && version !== undefined && architecture !== undefined ? { platform, version, architecture } : undefined
    },
    ['platform', 'version', 'architecture']
  )

  const acceleration = c.nullable(o['acceleration'], '$.acceleration', (v, p) =>
    c.array(v, p, (a, ap) => c.oneOf(a, ap, ACCELERATIONS), { unique: true })
  )

  const pv = c.record(o['provenance'], '$.provenance', ['source', 'detectorId', 'collectedAt', 'confidence', 'quality'])
  const provenance = pv && {
    source: c.oneOf(pv['source'], '$.provenance.source', ['demo', 'local-detector'] as const),
    detectorId: c.string(pv['detectorId'], '$.provenance.detectorId', { min: 1, max: 100 }),
    collectedAt: c.isoDate(pv['collectedAt'], '$.provenance.collectedAt'),
    confidence: c.oneOf(pv['confidence'], '$.provenance.confidence', ['high', 'medium', 'low'] as const),
    quality: readQuality(c, pv['quality'], '$.provenance.quality')
  }

  if (!c.ok) return c.result<HardwareProfile>(undefined)
  const profile = { cpu, memory, gpus, storage, os, acceleration, provenance } as HardwareProfile
  checkQualityCoherence(c, profile)
  return c.result(c.ok ? profile : undefined)
}

function readQuality(c: Checker, value: unknown, path: string): HardwareQuality | undefined {
  const o = c.record(value, path, ['fields', 'gpus'])
  if (!o) return undefined
  const f = c.record(o['fields'], `${path}.fields`, PROFILE_FIELDS)
  const fields = f && Object.fromEntries(PROFILE_FIELDS.map((k) => [k, c.oneOf(f[k], `${path}.fields.${k}`, DATA_QUALITIES)]))
  const gpus = c.nullable(o['gpus'], `${path}.gpus`, (v, p) =>
    c.array(
      v,
      p,
      (g, gp) => {
        const x = c.record(g, gp, GPU_FIELDS)
        return x ? (Object.fromEntries(GPU_FIELDS.map((k) => [k, c.oneOf(x[k], `${gp}.${k}`, DATA_QUALITIES)])) as GpuQuality) : undefined
      },
      { max: 16 }
    )
  )
  return fields && gpus !== undefined ? { fields: fields as Record<ProfileField, DataQuality>, gpus } : undefined
}

/**
 * A qualidade precisa corresponder aos valores e à origem:
 * - valor ausente ⇔ `unavailable` (nada ausente é dado como detectado);
 * - perfil demonstrativo só tem atributos `simulated` ou `unavailable`;
 * - perfil de detector real nunca tem atributos `simulated`.
 */
function checkQualityCoherence(c: Checker, profile: HardwareProfile): void {
  const { source, quality } = profile.provenance
  const base = '$.provenance.quality'
  const check = (path: string, q: DataQuality, present: boolean) => {
    if (present && q === 'unavailable') c.fail(path, 'valor presente não pode ser indisponível')
    if (!present && q !== 'unavailable') c.fail(path, 'valor ausente deve ser indisponível')
    if (source === 'demo' && (q === 'detected' || q === 'estimated')) c.fail(path, 'perfil demonstrativo só tem dados simulados')
    if (source === 'local-detector' && q === 'simulated') c.fail(path, 'perfil real não pode ter dados simulados')
  }
  for (const field of PROFILE_FIELDS) {
    const value = fieldValue(profile, field)
    check(`${base}.fields.${field}`, quality.fields[field], value !== null && value !== undefined)
  }
  if ((profile.gpus === null) !== (quality.gpus === null) || (profile.gpus && profile.gpus.length !== quality.gpus?.length)) {
    c.fail(`${base}.gpus`, 'deve ter uma entrada por GPU do perfil')
    return
  }
  profile.gpus?.forEach((gpu, i) => {
    for (const field of GPU_FIELDS) {
      check(`${base}.gpus[${i}].${field}`, quality.gpus![i]![field], gpuFieldKnown(gpu as unknown as Record<string, unknown>, field))
    }
  })
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


// ---------------------------------------------------------------------------
// Migração do arquivo de hardware
// ---------------------------------------------------------------------------

/**
 * `hardware.json` v1 → v2: acrescenta `provenance.quality` ao perfil gravado.
 *
 * - Consentimento: copiado sem alteração. Um escopo `demo-only` continua
 *   `demo-only`; nada é ampliado.
 * - Perfil demonstrativo: atributos presentes viram `simulated`, ausentes `unavailable`.
 * - Perfil de detector real: a v1 não registrava como cada atributo foi obtido,
 *   então não há como qualificá-lo sem presumir. A análise é descartada (o
 *   consentimento fica) e o original fica na cópia feita antes da migração.
 *   Nenhuma versão distribuída tinha detector real.
 * - Dados fora do formato: devolvidos como vieram, para a validação recusá-los
 *   e o armazenamento seguir o caminho seguro de sempre. Nunca lança exceção.
 */
export function migrateHardwareV1(data: unknown): unknown {
  if (!isRecord(data) || !isRecord(data['lastAnalysis'])) return data
  const record = data['lastAnalysis']
  const outcome = record['outcome']
  if (!isRecord(outcome) || outcome['kind'] !== 'completed' || !isRecord(outcome['profile'])) return data
  const profile = outcome['profile']
  const provenance = profile['provenance']
  if (!isRecord(provenance)) return data
  if (provenance['source'] === 'local-detector') return { ...data, lastAnalysis: null }
  if (provenance['source'] !== 'demo') return data
  return {
    ...data,
    lastAnalysis: {
      ...record,
      outcome: { ...outcome, profile: { ...profile, provenance: { ...provenance, quality: uniformQuality(profile, 'simulated') } } }
    }
  }
}

/**
 * `hardware.json` v2 → v3: o formato v3 só amplia o v2 (atributos de seção
 * passam a aceitar `null`), então os dados passam sem alteração: o
 * consentimento, a origem (`demo` × `local-detector`) e a qualidade ficam
 * como estavam. A validação do v3 decide se o conteúdo é aceito.
 */
export function migrateHardwareV2(data: unknown): unknown {
  return data
}

/**
 * `hardware.json` v3 → v4: o formato v4 só amplia o v3 (`gpus[].model` e
 * `gpus[].sharedMemory` passam a aceitar `null`), então os dados passam sem
 * alteração, como na migração anterior. Todo dado v3 válido é v4 válido.
 */
export function migrateHardwareV3(data: unknown): unknown {
  return data
}

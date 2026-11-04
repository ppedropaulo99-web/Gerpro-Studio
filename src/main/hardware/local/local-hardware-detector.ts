import {
  GPU_FIELDS,
  PROFILE_FIELDS,
  validateHardwareProfile,
  type DataConfidence,
  type DataQuality,
  type DetectorAvailability,
  type GpuField,
  type HardwareDetector,
  type HardwareProfile,
  type HardwareProfileData,
  type ProfileField
} from '@shared/hardware'
import { abortReasonOf, DetectionAbortedError } from '../detection-errors'
import { createDxcoreHelperRunner, type HelperProcessState, type HelperRunResult } from './bundled-helper'
import { CommandRunner } from './command-runner'
import { HARDWARE_COMMANDS } from './commands'
import type { DxcoreListRejection, DxcoreResponseError, DxcoreSourceStatus, GpuListSource } from './dxcore-contract'
import { captureGpuSources } from './dxcore/capture'
import { interpretHelperResult, type DxcoreSource } from './dxcore/parser'
import { selectGpuList, type DxcoreGpuTrace } from './dxcore/selection'
import type { Measured } from './probes/common'
import { cpuToProfile, nodeCpuApi, probeCpu, type CpuApi, type CpuProbeResult } from './probes/cpu'
import { gpusToProfile, probeGpus, type GpuApi, type GpuProbeResult, type RegistryStatus } from './probes/gpu'
import { memoryToProfile, nodeMemoryApi, probeMemory, type MemoryApi, type MemoryProbeResult } from './probes/memory'
import { nodeOsApi, osToProfile, probeOs, type OsApi, type OsProbeResult } from './probes/os'
import { nodeStorageApi, probeStorage, storageToProfile, type StorageApi, type StorageProbeResult, type StorageTarget } from './probes/storage'

/**
 * Detector real de hardware: compõe as sondagens de CPU, memória, sistema,
 * armazenamento e GPU num `HardwareProfile` do contrato v4.
 *
 * - Só lê quando `detect()`/`collect()` é chamado; construir não consulta nada.
 * - Cada sondagem é independente: a falha (ou exceção) de uma vira atributos
 *   `unavailable` só dela. Nada desconhecido vira zero nem é inventado.
 * - Cancelamento ou prazo global (o `AbortSignal` recebido) interrompem a
 *   coleta inteira: nenhuma sondagem nova começa e nenhum perfil é devolvido;
 *   `detect()` rejeita com `DetectionAbortedError`.
 * - Armazenamento: um único caminho definido pelo Main (`storageTarget`);
 *   o caminho não entra no perfil, só a raiz do volume no diagnóstico.
 * - Não grava, não registra em log e não usa a rede. O executor de comandos é
 *   o `CommandRunner` com o catálogo autorizado.
 * - GPU com o auxiliar DXCore (dependência opcional `dxcore`, D54/D56): o
 *   auxiliar roda uma vez por coleta, em paralelo com a sondagem atual, e
 *   `selectGpuList` escolhe a fonte da lista UMA vez. Sem a dependência, ou
 *   com qualquer falha do auxiliar, a GPU sai exatamente como a sondagem
 *   atual (Electron + Registro).
 *
 * Nesta etapa NÃO está conectado ao `HardwareAdvisorService`.
 */

export const LOCAL_DETECTOR_ID = 'local-hardware'

/**
 * Prazos internos da coleta. O serviço dá 15 s para `detect()` inteiro
 * (`AbortSignal.timeout`); somados, os prazos nominais da GPU passariam disso:
 * 4 s de `getGPUInfo` + 2 × (5 s de consulta + até 2 s esperando o processo
 * encerrar) = 18 s. Por isso a GPU tem um orçamento total próprio: ao fim
 * dele, a sondagem para (o executor encerra o processo em andamento) e o
 * perfil sai com o que já se sabia, em vez de a coleta inteira estourar o
 * prazo global e não produzir nada.
 *
 * Pior caso com estes valores: GPU 11 s + até 2 s de encerramento do
 * processo = 13 s; disco em paralelo (5 s). O prazo global continua valendo
 * como teto, e um estouro dele rejeita a coleta (`DetectionAbortedError`).
 */
export const DETECTION_BUDGET = {
  /** Prazo de `statfs` (a chamada não é cancelável; a coleta só para de esperar). */
  storageMs: 5_000,
  /** Prazo da leitura de `getGPUInfo`. */
  gpuInfoMs: 4_000,
  /** Orçamento total da GPU: `getGPUInfo` mais as consultas ao Registro (5 s cada, pelo catálogo). */
  gpuTotalMs: 11_000
} as const

export type DetectionBudget = { [K in keyof typeof DETECTION_BUDGET]: number }

/** Fonte DXCore: o executor do auxiliar empacotado (`BundledHelperRunner`) ou um simulado nos testes. */
export interface DxcoreHelper {
  /** Uma execução; nunca deveria lançar exceção (se lançar, vale o fallback). */
  run(signal?: AbortSignal): Promise<HelperRunResult>
}

export interface LocalHardwareDetectorDeps {
  /** Pasta interna confiável (ex.: dados do app), definida pelo Main. `null`: armazenamento não medido. */
  storageTarget: StorageTarget | null
  /** `getGPUInfo` do Electron e `run` do executor; ver `createLocalHardwareDetector`. */
  gpu: GpuApi
  cpu?: CpuApi
  memory?: MemoryApi
  os?: OsApi
  storage?: StorageApi
  platform?: NodeJS.Platform
  now?: () => Date
  /** Prazos internos; padrão `DETECTION_BUDGET`. Substituível nos testes. */
  budget?: Partial<DetectionBudget>
  /** Auxiliar DXCore. Ausente: a GPU sai só pelo Electron + Registro, como antes. */
  dxcore?: DxcoreHelper
}

/**
 * Fonte da lista de GPUs de uma coleta, sem dados do sistema: só situações,
 * motivos e rastreios enumerados (nada de LUID, identificador PCI, nome,
 * caminho ou saída do auxiliar). Fica no diagnóstico interno; não vai ao IPC.
 */
export interface GpuSourceDiagnostics {
  source: GpuListSource
  /** `not-queried` sem a dependência DXCore (ou se a etapa de GPU falhou antes). */
  dxcoreStatus: DxcoreSourceStatus
  parseError: DxcoreResponseError | null
  /** Por que a lista do DXCore não foi usada; `null` se foi, ou se nem foi consultada. */
  rejection: DxcoreListRejection | null
  traces: DxcoreGpuTrace[]
  /** Por que o auxiliar foi interrompido; `null` se não foi (ou não rodou). */
  helperStop: HelperStopReason | null
  /**
   * Situação do processo do auxiliar, só pelo que o supervisor observou.
   * `exit-unconfirmed`/`kill-failed`: o processo pode continuar rodando (sem
   * Job Object não há como garantir); `unknown`: o executor não informou.
   */
  helperProcess: HelperProcessState | 'not-queried'
}

/**
 * Interrupção do auxiliar numa coleta que terminou:
 * - `helper-timeout`: prazo próprio do auxiliar (3 s);
 * - `gpu-budget`: fim do orçamento da etapa de GPU (a coleta segue);
 * - `cancelled`: cancelado sem causa conhecida pelo detector.
 * Cancelamento do usuário e prazo global não aparecem aqui: a coleta rejeita
 * com `DetectionAbortedError` (`cancelled` ou `timeout`) e nada é devolvido.
 */
export type HelperStopReason = 'helper-timeout' | 'gpu-budget' | 'cancelled'

const dxcoreNotQueried = (): GpuSourceDiagnostics => ({
  source: 'electron',
  dxcoreStatus: 'not-queried',
  parseError: null,
  rejection: null,
  traces: [],
  helperStop: null,
  helperProcess: 'not-queried'
})

/** Resultado da etapa de GPU: o que vai ao perfil e de qual fonte veio. */
interface GpuStage {
  result: GpuProbeResult
  source: GpuSourceDiagnostics
}

interface DxcoreRead {
  source: DxcoreSource
  kind: HelperRunResult['kind'] | null
  process: HelperProcessState
}

/** Resultado do auxiliar → fonte DXCore (validada pelo parser). Exceção inesperada: auxiliar indisponível. */
async function readDxcore(helper: DxcoreHelper, signal: AbortSignal): Promise<DxcoreRead> {
  try {
    const result = await helper.run(signal)
    return { source: interpretHelperResult(result), kind: result.kind, process: result.process ?? 'unknown' }
  } catch {
    return { source: { status: 'helper-unavailable' }, kind: null, process: 'unknown' }
  }
}

/** Motivo da interrupção, pelos sinais: o global (usuário ou prazo do serviço) e o da etapa de GPU. */
function helperStopOf(kind: DxcoreRead['kind'], signal: AbortSignal | undefined, gpuSignal: AbortSignal): HelperStopReason | null {
  if (kind === 'timeout') return 'helper-timeout'
  if (kind !== 'cancelled') return null
  // Com o sinal global interrompido a coleta rejeita; aqui só sobra o orçamento da GPU.
  return !signal?.aborted && gpuSignal.aborted ? 'gpu-budget' : 'cancelled'
}

/**
 * Etapa de GPU. Sem o auxiliar: `probeGpus` exatamente como antes. Com ele:
 * o auxiliar e a sondagem atual em paralelo, com o mesmo sinal (o executor
 * encerra o processo no cancelamento ou no fim do orçamento), e uma única
 * seleção. Nada é associado por nome, posição ou heurística: só pelas regras
 * de `selectGpuList`.
 */
async function probeGpuStage(
  gpu: GpuApi,
  dxcore: DxcoreHelper | undefined,
  gpuSignal: AbortSignal,
  globalSignal: AbortSignal | undefined,
  gpuInfoMs: number
): Promise<GpuStage> {
  if (!dxcore) return { result: await probeGpus(gpu, { signal: gpuSignal, timeoutMs: gpuInfoMs }), source: dxcoreNotQueried() }
  const capture = captureGpuSources(gpu)
  const [read, current] = await Promise.all([readDxcore(dxcore, gpuSignal), probeGpus(capture.api, { signal: gpuSignal, timeoutMs: gpuInfoMs })])
  const selection = selectGpuList({ dxcore: read.source, electron: { result: current, raw: capture.electronRaw() }, registry: capture.registry(current.registry) })
  return {
    result: selection.result,
    source: {
      source: selection.source,
      dxcoreStatus: selection.dxcoreStatus,
      parseError: selection.parseError,
      rejection: selection.rejection,
      traces: selection.traces,
      helperStop: helperStopOf(read.kind, globalSignal, gpuSignal),
      helperProcess: read.process
    }
  }
}

/** Diagnóstico da coleta, sem caminhos, identificadores ou saídas do sistema. */
export interface LocalDetectionDiagnostics {
  /** Raiz do volume medido (ex.: `C:\`); `null` se nenhum foi medido. */
  storageVolume: string | null
  storageKind: StorageTarget['kind'] | null
  /** Motivo de cada atributo indisponível (códigos curtos). */
  reasons: Partial<Record<ProfileField, string>>
  gpuReasons: Array<Partial<Record<GpuField, string>>>
  gpuRegistry: RegistryStatus
  ignoredGpus: number
  /** Fonte da lista de GPUs e situação do auxiliar DXCore. */
  gpuSource: GpuSourceDiagnostics
}

export interface LocalDetectionResult {
  profile: HardwareProfile
  diagnostics: LocalDetectionDiagnostics
}

const abortReason = (signal: AbortSignal): DetectionAbortedError => new DetectionAbortedError(abortReasonOf(signal))

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

/** Espera `promise`, mas desiste no cancelamento (a operação subjacente pode seguir até o próprio prazo). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => (signal.removeEventListener('abort', onAbort), resolve(v)),
      (e: unknown) => (signal.removeEventListener('abort', onAbort), reject(e))
    )
  })
}

/** Executa uma sondagem; exceção inesperada vira o resultado de falha dela, sem afetar as outras. */
function guard<T>(run: () => T, failure: () => T): T {
  try {
    return run()
  } catch {
    return failure()
  }
}

async function guardAsync<T>(run: () => Promise<T>, failure: () => T): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof DetectionAbortedError) throw error
    return failure()
  }
}

const failed = <T>(): Measured<T> => ({ value: null, quality: 'unavailable', reason: 'probe-error' })
const cpuFailure = (): CpuProbeResult => ({ model: failed(), architecture: failed(), physicalCores: failed(), logicalCores: failed() })
const memoryFailure = (): MemoryProbeResult => ({ totalGb: failed(), availableGb: failed() })
const osFailure = (): OsProbeResult => ({ platform: failed(), version: failed(), architecture: failed() })
const storageFailure = (reason = 'probe-error'): StorageProbeResult => ({
  target: null,
  totalGb: { value: null, quality: 'unavailable', reason },
  freeGb: { value: null, quality: 'unavailable', reason }
})
/** Falha inesperada da etapa de GPU. Com o auxiliar configurado, ele pode ter rodado: processo `unknown`, nunca presumido. */
const gpuFailure = (withHelper: boolean): GpuStage => ({
  result: { gpus: failed(), registry: 'not-queried', ignored: 0 },
  source: withHelper ? { ...dxcoreNotQueried(), helperProcess: 'unknown' } : dxcoreNotQueried()
})

/** Atributos sem os quais a recomendação fica indeterminada ou muito limitada. */
const CORE_FIELDS: readonly ProfileField[] = ['cpu.logicalCores', 'memory.totalGb', 'memory.availableGb', 'gpus', 'storage.freeGb', 'os.platform']

/**
 * Confiança geral, derivada só da qualidade:
 * - `high`: todo atributo (e todo atributo de GPU) detectado diretamente;
 * - `medium`: os atributos essenciais conhecidos (detectados ou estimados);
 * - `low`: algum atributo essencial desconhecido.
 * Um perfil parcial nunca sai como `high`.
 */
export function deriveConfidence(fields: Record<ProfileField, DataQuality>, gpus: Array<Record<GpuField, DataQuality>> | null): DataConfidence {
  const all = [...Object.values(fields), ...(gpus ?? []).flatMap((g) => Object.values(g))]
  if (all.every((q) => q === 'detected')) return 'high'
  return CORE_FIELDS.every((f) => fields[f] === 'detected' || fields[f] === 'estimated') ? 'medium' : 'low'
}

const reasonsOf = <K extends string>(entries: Array<[K, Measured<unknown>]>): Partial<Record<K, string>> =>
  Object.fromEntries(entries.filter(([, m]) => m.quality === 'unavailable').map(([k, m]) => [k, (m as { reason: string }).reason])) as Partial<Record<K, string>>

export class LocalHardwareDetector implements HardwareDetector {
  readonly id = LOCAL_DETECTOR_ID
  readonly source = 'local-detector' as const
  private readonly deps: LocalHardwareDetectorDeps

  /** Não consulta nada: só guarda as dependências. */
  constructor(deps: LocalHardwareDetectorDeps) {
    this.deps = deps
  }

  /** Só no Windows nesta versão (VRAM pelo Registro). Não consulta o hardware. */
  async availability(): Promise<DetectorAvailability> {
    return (this.deps.platform ?? process.platform) === 'win32'
      ? { available: true, reason: null }
      : { available: false, reason: 'A detecção real de hardware está disponível só no Windows nesta versão.' }
  }

  async detect(signal: AbortSignal): Promise<HardwareProfile> {
    return (await this.collect(signal)).profile
  }

  /** Coleta com diagnóstico. Rejeita com `DetectionAbortedError` se cancelada ou fora do prazo. */
  async collect(signal?: AbortSignal): Promise<LocalDetectionResult> {
    const d = this.deps
    const budget: DetectionBudget = { ...DETECTION_BUDGET, ...d.budget }
    throwIfAborted(signal)

    // Sondagens síncronas (APIs do Node), uma de cada vez, conferindo o cancelamento entre elas.
    const cpu = guard(() => probeCpu(d.cpu ?? nodeCpuApi), cpuFailure)
    throwIfAborted(signal)
    const memory = guard(() => probeMemory(d.memory ?? nodeMemoryApi), memoryFailure)
    throwIfAborted(signal)
    const os = guard(() => probeOs(d.os ?? nodeOsApi), osFailure)
    throwIfAborted(signal)

    // Armazenamento e GPU esperam por E/S e processos: em paralelo, cada um com o próprio prazo.
    const [storage, gpuStage] = await Promise.all([
      d.storageTarget === null
        ? Promise.resolve(storageFailure('no-target'))
        : guardAsync(
            () => untilAborted(probeStorage(d.storageTarget!, d.storage ?? nodeStorageApi, { timeoutMs: budget.storageMs }), signal),
            storageFailure
          ),
      guardAsync(() => {
        // O orçamento da GPU vence sozinho (atributos de GPU indisponíveis por `timeout`);
        // o sinal global continua interrompendo a coleta inteira.
        const gpuSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(budget.gpuTotalMs)]) : AbortSignal.timeout(budget.gpuTotalMs)
        // O auxiliar DXCore (se houver) usa o mesmo sinal: cancelamento global encerra o processo
        // e rejeita a coleta; o fim do orçamento ou uma falha dele só levam ao fallback.
        return untilAborted(probeGpuStage(d.gpu, d.dxcore, gpuSignal, signal, budget.gpuInfoMs), signal)
      }, () => gpuFailure(d.dxcore !== undefined))
    ])
    // Resultado de uma coleta cancelada não é devolvido, nem em parte.
    throwIfAborted(signal)
    const gpu = gpuStage.result

    const c = cpuToProfile(cpu)
    const m = memoryToProfile(memory)
    const o = osToProfile(os)
    const s = storageToProfile(storage)
    const g = gpusToProfile(gpu)

    const data: HardwareProfileData = { cpu: c.cpu, memory: m.memory, gpus: g.gpus, storage: s.storage, os: o.os, acceleration: null }
    // Aceleração não é sondada nesta versão.
    const fields = { ...c.quality, ...m.quality, ...o.quality, ...s.quality, ...g.quality, acceleration: 'unavailable' } as Record<ProfileField, DataQuality>
    const profile: HardwareProfile = {
      ...data,
      provenance: {
        source: 'local-detector',
        detectorId: LOCAL_DETECTOR_ID,
        collectedAt: (d.now?.() ?? new Date()).toISOString(),
        confidence: deriveConfidence(fields, g.gpuQuality),
        quality: { fields: Object.fromEntries(PROFILE_FIELDS.map((f) => [f, fields[f]])) as Record<ProfileField, DataQuality>, gpus: g.gpuQuality }
      }
    }

    const valid = validateHardwareProfile(profile)
    if (!valid.ok) throw new Error('A detecção local produziu um perfil fora do contrato.')

    const diagnostics: LocalDetectionDiagnostics = {
      storageVolume: storage.target?.volume ?? null,
      storageKind: storage.target?.kind ?? null,
      reasons: {
        ...reasonsOf<ProfileField>([
          ['cpu.model', cpu.model],
          ['cpu.architecture', cpu.architecture],
          ['cpu.physicalCores', cpu.physicalCores],
          ['cpu.logicalCores', cpu.logicalCores],
          ['memory.totalGb', memory.totalGb],
          ['memory.availableGb', memory.availableGb],
          ['gpus', gpu.gpus],
          ['storage.freeGb', storage.freeGb],
          ['storage.totalGb', storage.totalGb],
          ['os.platform', os.platform],
          ['os.version', os.version],
          ['os.architecture', os.architecture]
        ]),
        acceleration: 'not-probed'
      },
      gpuReasons: (gpu.gpus.value ?? []).map((x) => reasonsOf<GpuField>(GPU_FIELDS.map((f) => [f, x[f]]))),
      gpuRegistry: gpu.registry,
      ignoredGpus: gpu.ignored,
      gpuSource: gpuStage.source
    }
    return { profile: valid.value, diagnostics }
  }
}

/**
 * Montagem de produção, para uso futuro pelo Main: `getGPUInfo` do Electron e
 * o `CommandRunner` com o catálogo autorizado. Não executa nada ao montar.
 *
 * `helperResourcesRoot`: raiz de `resolveHelperResourcesRoot` (Main). Com ela,
 * o detector recebe UM executor do auxiliar, com o hash embutido no código
 * (`DXCORE_HELPER_SHA256`; enquanto for `null`, o auxiliar é sempre recusado
 * e vale o fallback). Não há como passar outro hash, caminho ou executável
 * por aqui. `null`/ausente: sem auxiliar.
 */
export function createLocalHardwareDetector(o: {
  storageTarget: StorageTarget | null
  getGPUInfo: (infoType: 'basic') => Promise<unknown>
  helperResourcesRoot?: string | null
}): LocalHardwareDetector {
  const runner = new CommandRunner({ commands: HARDWARE_COMMANDS })
  return new LocalHardwareDetector({
    storageTarget: o.storageTarget,
    gpu: { getGPUInfo: o.getGPUInfo, runCommand: (id, signal) => runner.run(id, signal) },
    ...(typeof o.helperResourcesRoot === 'string' ? { dxcore: createDxcoreHelperRunner(o.helperResourcesRoot) } : {})
  })
}

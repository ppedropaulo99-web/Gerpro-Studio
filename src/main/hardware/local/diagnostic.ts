import { PROFILE_FIELDS, type DataQuality, type HardwareProfile, type ProfileField } from '@shared/hardware'
import { DetectionAbortedError } from '../detection-errors'
import { CommandRunner, type CommandResult } from './command-runner'
import { GPU_COMMAND_IDS, HARDWARE_COMMANDS, type GpuCommandId } from './commands'
import { LocalHardwareDetector, type DetectionBudget, type LocalDetectionDiagnostics } from './local-hardware-detector'
import { nodeCpuApi, type CpuApi } from './probes/cpu'
import { parseRegistryOutput, pciVendorOf } from './probes/gpu'
import { nodeMemoryApi, type MemoryApi } from './probes/memory'
import { nodeOsApi, type OsApi } from './probes/os'
import { nodeStorageApi, type StorageApi, type StorageTarget } from './probes/storage'

/**
 * Diagnóstico MANUAL da detecção local, para validar as sondagens num
 * Windows real (Etapa 6B.2). Não faz parte do app: nada o importa, e ele só
 * roda pelo script `scripts/diagnostics/hardware-diagnostic.mjs`, com
 * confirmação explícita.
 *
 * Reaproveita o `LocalHardwareDetector`, as sondagens e o `CommandRunner` com
 * o catálogo autorizado; só acrescenta medição de tempo e um resumo
 * sanitizado do que as fontes devolveram. Não grava nada, não usa a rede, não
 * altera consentimento nem `hardware.json`.
 *
 * O relatório omite: caminhos (só a raiz do volume), identificadores de
 * dispositivo PCI (só o fabricante e se o identificador existe), subchaves e
 * saídas brutas do Registro (só contagens e tipos), versões de driver e
 * qualquer outro campo do `getGPUInfo` além dos nomes dos campos.
 */

export interface DiagnosticDeps {
  getGPUInfo: (infoType: 'basic') => Promise<unknown>
  /** Pasta interna confiável definida pelo script (ex.: pasta de dados de aplicativos do usuário). */
  storageTarget: StorageTarget
  /** Executor; padrão: `CommandRunner` com o catálogo autorizado. */
  runCommand?: (id: GpuCommandId, signal?: AbortSignal) => Promise<CommandResult>
  cpu?: CpuApi
  memory?: MemoryApi
  os?: OsApi
  storage?: StorageApi
  platform?: NodeJS.Platform
  /** Relógio em ms (padrão `performance.now`). */
  clock?: () => number
}

export interface DiagnosticOptions {
  /** Prazo global da coleta principal, como o do serviço. */
  timeoutMs?: number
  /** Interrupção pelo usuário (Ctrl+C no script). */
  signal?: AbortSignal
  /** Verificações de interrupção com consultas reais (cancelamento e orçamento da GPU). */
  interruptionChecks?: { cancelAfterMs: number; gpuBudgetMs: number } | null
}

export interface TimedCall {
  name: string
  ms: number
}

export interface GpuDeviceShape {
  index: number
  /** Nomes dos campos devolvidos (sem valores). */
  fields: string[]
  /** Fabricante pelo identificador PCI, em hexadecimal (ex.: `0x10DE`). */
  vendorIdHex: string | null
  deviceIdPresent: boolean
  /** Nome do adaptador, como informado (é o modelo, não identifica o aparelho). */
  deviceString: string | null
  active: boolean | null
  softwareRenderer: boolean
}

export interface GpuInfoShape {
  topLevelKeys: string[]
  auxAttributeKeys: string[]
  devices: GpuDeviceShape[] | null
}

export interface RegistryCallSummary {
  commandId: string
  kind: CommandResult['kind']
  reason: string | null
  exitCode: number | null
  processExited: boolean
  ms: number
  /** Só em sucesso. Contagens, nunca o conteúdo. */
  stdoutBytes: number | null
  keyHeaders: number | null
  adapterSubkeysWithValue: number | null
  valueTypes: Record<string, number> | null
  /** `MatchingDeviceId` fora do barramento PCI (ex.: `root\...`). */
  nonPciIds: number | null
}

export interface AttributeLine {
  field: ProfileField
  value: unknown
  quality: DataQuality
  reason: string | null
}

export interface InterruptionCheck {
  kind: 'cancel' | 'gpu-budget'
  /** `rejected:cancelled`, `rejected:timeout`, `completed` ou `rejected:other`. */
  outcome: string
  elapsedMs: number
  /** Consultas iniciadas e como terminaram, depois de aguardadas. */
  commands: Array<{ commandId: string; kind: CommandResult['kind']; processExited: boolean; settledAfterMs: number }>
  gpuRegistry: string | null
}

export interface HardwareDiagnosticReport {
  outcome: 'completed' | 'cancelled' | 'timeout' | 'error'
  error: string | null
  totalMs: number
  confidence: HardwareProfile['provenance']['confidence'] | null
  attributes: AttributeLine[]
  gpus: Array<{
    index: number
    vendor: string
    model: string | null
    vramGb: number | null
    sharedMemory: boolean | null
    quality: Record<string, DataQuality>
    reasons: Record<string, string>
  }>
  storage: { volume: string | null; kind: string | null }
  gpuInfo: GpuInfoShape | null
  registry: RegistryCallSummary[]
  gpuRegistryStatus: string | null
  ignoredGpus: number | null
  timings: TimedCall[]
  consistency: Array<{ check: string; ok: boolean | null; note: string }>
  interruptions: InterruptionCheck[]
}

const VALUE_NAMES: Record<GpuCommandId, string> = {
  [GPU_COMMAND_IDS.deviceIds]: 'MatchingDeviceId',
  [GPU_COMMAND_IDS.memorySizes]: 'HardwareInformation.qwMemorySize'
}

const hex = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 0xffff ? `0x${n.toString(16).toUpperCase().padStart(4, '0')}` : null)
const cleanText = (raw: unknown) => (typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null : null)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Forma do retorno de `getGPUInfo('basic')`: nomes de campos e o mínimo para o diagnóstico. */
export function describeGpuInfo(raw: unknown): GpuInfoShape {
  const top = isObject(raw) ? raw : {}
  const aux = isObject(top['auxAttributes']) ? top['auxAttributes'] : {}
  const list = top['gpuDevice']
  return {
    topLevelKeys: Object.keys(top).sort(),
    auxAttributeKeys: Object.keys(aux).sort(),
    devices: Array.isArray(list)
      ? list.slice(0, 32).map((d, index) => {
          const o = isObject(d) ? d : {}
          return {
            index,
            fields: Object.keys(o).sort(),
            vendorIdHex: hex(o['vendorId']),
            deviceIdPresent: hex(o['deviceId']) !== null,
            deviceString: cleanText(o['deviceString']),
            active: typeof o['active'] === 'boolean' ? o['active'] : null,
            softwareRenderer: o['vendorId'] === 0x1414 && o['deviceId'] === 0x008c
          }
        })
      : null
  }
}

/** Resumo de uma consulta ao Registro: só contagens e tipos. */
export function summarizeRegistry(result: CommandResult, ms: number): RegistryCallSummary {
  const base: RegistryCallSummary = {
    commandId: result.commandId,
    kind: result.kind,
    reason: 'reason' in result ? result.reason : null,
    exitCode: 'exitCode' in result ? result.exitCode : null,
    processExited: result.processExited,
    ms: Math.round(ms),
    stdoutBytes: null,
    keyHeaders: null,
    adapterSubkeysWithValue: null,
    valueTypes: null,
    nonPciIds: null
  }
  if (result.kind !== 'success') return base
  const name = VALUE_NAMES[result.commandId as GpuCommandId] ?? ''
  const values = parseRegistryOutput(result.stdout, name)
  const types: Record<string, number> = {}
  let nonPci = 0
  for (const entries of values?.values() ?? []) {
    for (const e of entries) {
      types[e.type] = (types[e.type] ?? 0) + 1
      if (name === 'MatchingDeviceId' && !/^pci\\/i.test(e.data.trim())) nonPci++
    }
  }
  return {
    ...base,
    stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
    keyHeaders: result.stdout.split(/\r?\n/).filter((l) => l.startsWith('HKEY_')).length,
    adapterSubkeysWithValue: values?.size ?? 0,
    valueTypes: types,
    nonPciIds: name === 'MatchingDeviceId' ? nonPci : null
  }
}

/** Dependências do detector com medição de tempo; registra as consultas e a forma do `getGPUInfo`. */
function instrument(deps: DiagnosticDeps) {
  const clock = deps.clock ?? (() => performance.now())
  const timings: TimedCall[] = []
  const registry: RegistryCallSummary[] = []
  const pending: Array<Promise<unknown>> = []
  const commands: InterruptionCheck['commands'] = []
  let gpuInfo: GpuInfoShape | null = null
  let abortedAt: number | null = null

  const timedSync = <A extends unknown[], R>(name: string, fn: ((...a: A) => R) | undefined) =>
    fn &&
    ((...a: A): R => {
      const t = clock()
      try {
        return fn(...a)
      } finally {
        timings.push({ name, ms: clock() - t })
      }
    })

  const real = deps.runCommand ? null : new CommandRunner({ commands: HARDWARE_COMMANDS })
  const runner = deps.runCommand ?? ((id: GpuCommandId, signal?: AbortSignal) => real!.run(id, signal))
  const cpu = deps.cpu ?? nodeCpuApi
  const memory = deps.memory ?? nodeMemoryApi
  const os = deps.os ?? nodeOsApi
  const storage = deps.storage ?? nodeStorageApi

  const api = {
    cpu: { cpus: timedSync('os.cpus', cpu.cpus), machine: timedSync('os.machine', cpu.machine), arch: timedSync('os.arch', cpu.arch), availableParallelism: timedSync('os.availableParallelism', cpu.availableParallelism) } as CpuApi,
    memory: { totalmem: timedSync('os.totalmem', memory.totalmem), freemem: timedSync('os.freemem', memory.freemem), platform: memory.platform } as MemoryApi,
    os: { platform: os.platform, release: timedSync('os.release', os.release), version: timedSync('os.version', os.version), machine: os.machine, arch: os.arch } as OsApi,
    storage: {
      platform: storage.platform,
      statfs:
        storage.statfs &&
        (async (path: string) => {
          const t = clock()
          try {
            return await storage.statfs!(path)
          } finally {
            timings.push({ name: 'fs.statfs', ms: clock() - t })
          }
        })
    } as StorageApi,
    gpu: {
      getGPUInfo: async (type: 'basic') => {
        const t = clock()
        try {
          const raw = await deps.getGPUInfo(type)
          gpuInfo = describeGpuInfo(raw)
          return raw
        } finally {
          timings.push({ name: "app.getGPUInfo('basic')", ms: clock() - t })
        }
      },
      runCommand: (id: GpuCommandId, signal?: AbortSignal) => {
        const t = clock()
        const run = runner(id, signal).then((result) => {
          const ms = clock() - t
          timings.push({ name: `reg ${id}`, ms })
          registry.push(summarizeRegistry(result, ms))
          commands.push({ commandId: id, kind: result.kind, processExited: result.processExited, settledAfterMs: abortedAt === null ? 0 : Math.round(clock() - abortedAt) })
          return result
        })
        pending.push(run.catch(() => undefined))
        return run
      }
    }
  }
  return {
    api,
    clock,
    timings,
    registry,
    commands,
    pending,
    gpuInfo: () => gpuInfo,
    markAborted: () => (abortedAt = clock())
  }
}

function detectorFor(deps: DiagnosticDeps, i: ReturnType<typeof instrument>, budget?: Partial<DetectionBudget>) {
  return new LocalHardwareDetector({
    storageTarget: deps.storageTarget,
    platform: deps.platform,
    cpu: i.api.cpu,
    memory: i.api.memory,
    os: i.api.os,
    storage: i.api.storage,
    gpu: i.api.gpu,
    budget
  })
}

const outcomeOf = (error: unknown) =>
  error instanceof DetectionAbortedError ? (error.reason === 'timeout' ? 'timeout' : 'cancelled') : ('error' as const)

function consistency(profile: HardwareProfile): HardwareDiagnosticReport['consistency'] {
  const both = <T>(a: T | null | undefined, b: T | null | undefined) => a !== null && a !== undefined && b !== null && b !== undefined
  const cpuArch = profile.cpu?.architecture
  const osArch = profile.os?.architecture
  const mem = profile.memory
  const disk = profile.storage
  return [
    {
      check: 'arquitetura da CPU = arquitetura do sistema',
      ok: both(cpuArch, osArch) ? cpuArch === osArch : null,
      note: 'Ambas vêm de os.machine(); diferença indicaria leitura inconsistente.'
    },
    {
      check: 'RAM disponível ≤ RAM total',
      ok: both(mem?.availableGb, mem?.totalGb) ? mem!.availableGb! <= mem!.totalGb! : null,
      note: 'Garantido pela sondagem; confirmado aqui.'
    },
    {
      check: 'espaço livre ≤ capacidade total',
      ok: both(disk?.freeGb, disk?.totalGb) ? disk!.freeGb! <= disk!.totalGb! : null,
      note: 'Garantido pela sondagem; confirmado aqui.'
    },
    {
      check: 'núcleos físicos não presumidos',
      ok: profile.cpu ? profile.cpu.physicalCores === null : null,
      note: 'O Node não informa núcleos físicos; devem ficar indisponíveis.'
    },
    {
      check: 'classificação de memória das GPUs não presumida',
      ok: profile.gpus ? profile.gpus.every((g) => g.sharedMemory === null) : null,
      note: 'Nenhuma fonte autorizada comprova dedicada × compartilhada.'
    }
  ]
}

/** Executa o diagnóstico. Nunca grava nada; devolve só o relatório sanitizado. */
export async function runHardwareDiagnostic(deps: DiagnosticDeps, options: DiagnosticOptions = {}): Promise<HardwareDiagnosticReport> {
  const main = instrument(deps)
  const started = main.clock()
  const report: HardwareDiagnosticReport = {
    outcome: 'completed',
    error: null,
    totalMs: 0,
    confidence: null,
    attributes: [],
    gpus: [],
    storage: { volume: null, kind: null },
    gpuInfo: null,
    registry: main.registry,
    gpuRegistryStatus: null,
    ignoredGpus: null,
    timings: main.timings,
    consistency: [],
    interruptions: []
  }

  let collected: { profile: HardwareProfile; diagnostics: LocalDetectionDiagnostics } | null = null
  try {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 15_000)
    collected = await detectorFor(deps, main).collect(options.signal ? AbortSignal.any([options.signal, deadline]) : deadline)
  } catch (error) {
    report.outcome = outcomeOf(error)
    report.error = error instanceof Error ? error.name : 'desconhecido'
  }
  await Promise.all(main.pending)
  report.totalMs = Math.round(main.clock() - started)
  report.gpuInfo = main.gpuInfo()

  if (collected) {
    const { profile, diagnostics } = collected
    const { fields } = profile.provenance.quality
    report.confidence = profile.provenance.confidence
    report.attributes = PROFILE_FIELDS.map((field) => {
      const [section, key] = field.split('.') as [keyof HardwareProfile, string | undefined]
      const s = profile[section] as unknown
      const value = key === undefined ? s : s === null ? null : (s as Record<string, unknown>)[key]
      return { field, value: field === 'gpus' ? (Array.isArray(value) ? `${value.length} GPU(s)` : null) : value, quality: fields[field], reason: diagnostics.reasons[field] ?? null }
    })
    report.gpus = (profile.gpus ?? []).map((g, index) => ({
      index,
      vendor: g.vendor,
      model: g.model,
      vramGb: g.vramGb,
      sharedMemory: g.sharedMemory,
      quality: { ...profile.provenance.quality.gpus![index]! },
      reasons: Object.fromEntries(Object.entries(diagnostics.gpuReasons[index] ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>
    }))
    report.storage = { volume: diagnostics.storageVolume, kind: diagnostics.storageKind }
    report.gpuRegistryStatus = diagnostics.gpuRegistry
    report.ignoredGpus = diagnostics.ignoredGpus
    report.consistency = consistency(profile)
  }

  if (options.interruptionChecks && !options.signal?.aborted) {
    const { cancelAfterMs, gpuBudgetMs } = options.interruptionChecks
    // 1. Cancelamento pelo sinal global depois de `cancelAfterMs`.
    {
      const i = instrument(deps)
      const controller = new AbortController()
      const t = i.clock()
      const timer = setTimeout(() => (i.markAborted(), controller.abort()), cancelAfterMs)
      let outcome = 'completed'
      try {
        await detectorFor(deps, i).collect(controller.signal)
      } catch (error) {
        outcome = `rejected:${error instanceof DetectionAbortedError ? error.reason : 'other'}`
      } finally {
        clearTimeout(timer)
      }
      const elapsedMs = Math.round(i.clock() - t)
      await Promise.all(i.pending)
      report.interruptions.push({ kind: 'cancel', outcome, elapsedMs, commands: i.commands, gpuRegistry: null })
    }
    // 2. Orçamento da GPU curto: a consulta em andamento é interrompida pelo executor.
    {
      const i = instrument(deps)
      const t = i.clock()
      let outcome = 'completed'
      let gpuRegistry: string | null = null
      try {
        const r = await detectorFor(deps, i, { gpuTotalMs: gpuBudgetMs }).collect(AbortSignal.timeout(options.timeoutMs ?? 15_000))
        gpuRegistry = r.diagnostics.gpuRegistry
      } catch (error) {
        outcome = `rejected:${error instanceof DetectionAbortedError ? error.reason : 'other'}`
      }
      const elapsedMs = Math.round(i.clock() - t)
      await Promise.all(i.pending)
      report.interruptions.push({ kind: 'gpu-budget', outcome, elapsedMs, commands: i.commands, gpuRegistry })
    }
  }
  return report
}

/** Texto legível do relatório (o script imprime; nada é gravado). */
export function formatDiagnosticReport(r: HardwareDiagnosticReport): string {
  const lines: string[] = []
  const v = (x: unknown) => (x === null || x === undefined ? '—' : typeof x === 'string' ? x : JSON.stringify(x))
  lines.push(`Resultado: ${r.outcome}${r.error ? ` (${r.error})` : ''} · ${r.totalMs} ms · confiança ${v(r.confidence)}`)
  lines.push('', 'Atributos (valor · qualidade · motivo):')
  for (const a of r.attributes) lines.push(`  ${a.field.padEnd(20)} ${v(a.value).padEnd(36)} ${a.quality.padEnd(11)} ${v(a.reason)}`)
  lines.push('', `Armazenamento: volume ${v(r.storage.volume)} (${v(r.storage.kind)})`)
  lines.push('', `GPUs (${r.gpus.length}; ignoradas: ${v(r.ignoredGpus)}; Registro: ${v(r.gpuRegistryStatus)}):`)
  for (const g of r.gpus) {
    lines.push(`  #${g.index} ${g.vendor} · ${v(g.model)} · VRAM ${v(g.vramGb)} GB · compartilhada ${v(g.sharedMemory)}`)
    lines.push(`      qualidade ${JSON.stringify(g.quality)} · motivos ${JSON.stringify(g.reasons)}`)
  }
  if (r.gpuInfo) {
    lines.push('', `getGPUInfo('basic'): campos ${r.gpuInfo.topLevelKeys.join(', ') || '—'}; auxAttributes: ${r.gpuInfo.auxAttributeKeys.length} campo(s)`)
    for (const d of r.gpuInfo.devices ?? []) {
      lines.push(`  dispositivo ${d.index}: fabricante ${v(d.vendorIdHex)} · deviceId ${d.deviceIdPresent ? 'presente' : 'ausente'} · nome ${v(d.deviceString)} · ativo ${v(d.active)}${d.softwareRenderer ? ' · renderizador por software' : ''}`)
      lines.push(`      campos: ${d.fields.join(', ')}`)
    }
  }
  lines.push('', 'Registro (só contagens):')
  for (const c of r.registry) {
    lines.push(
      `  ${c.commandId}: ${c.kind}${c.reason ? `/${c.reason}` : ''}${c.exitCode !== null ? ` código ${c.exitCode}` : ''} · ${c.ms} ms · processo encerrado ${c.processExited}` +
        (c.kind === 'success' ? ` · ${c.stdoutBytes} bytes · ${c.keyHeaders} chaves · ${c.adapterSubkeysWithValue} adaptadores com o valor · tipos ${JSON.stringify(c.valueTypes)}${c.nonPciIds !== null ? ` · fora do PCI ${c.nonPciIds}` : ''}` : '')
    )
  }
  lines.push('', 'Tempos (ms):')
  for (const t of r.timings) lines.push(`  ${t.name.padEnd(34)} ${t.ms.toFixed(1)}`)
  lines.push('', 'Coerência:')
  for (const c of r.consistency) lines.push(`  [${c.ok === null ? '?' : c.ok ? 'ok' : 'FALHA'}] ${c.check}: ${c.note}`)
  for (const i of r.interruptions) {
    lines.push('', `Interrupção (${i.kind}): ${i.outcome} em ${i.elapsedMs} ms${i.gpuRegistry ? ` · Registro ${i.gpuRegistry}` : ''}`)
    for (const c of i.commands) lines.push(`  ${c.commandId}: ${c.kind} · processo encerrado ${c.processExited} · terminou ${c.settledAfterMs} ms após a interrupção`)
  }
  return lines.join('\n')
}

// ── Forma do `luid` (Etapa 6C.1.1) ──────────────────────────────────────────
//
// Modo isolado: uma única chamada a `getGPUInfo('basic')`, sem Registro,
// sem outras sondagens e sem processos. Só a ESTRUTURA do campo `luid`
// aparece; o valor nunca sai desta função.

/** Tipo de um valor como o JavaScript o vê, separando `null` e listas. */
export type ValueKind = 'undefined' | 'null' | 'boolean' | 'number' | 'bigint' | 'string' | 'array' | 'object' | 'other'

/** Classificação do formato de um texto, sem o conteúdo. */
export type TextFormat = 'empty' | 'decimal' | 'hexadecimal' | 'hex-pair' | 'other'

export interface ValueShape {
  kind: ValueKind
  /** Só para números: se é inteiro seguro (`Number.isSafeInteger`). */
  safeInteger?: boolean
  /** Só para textos: comprimento e formato. */
  length?: number
  format?: TextFormat
}

export interface LuidShape extends ValueShape {
  present: boolean
  /** Só para objetos: nomes das propriedades e a forma de cada uma (um nível). */
  properties?: Array<{ name: string } & ValueShape>
}

export interface AdapterLuidShape {
  index: number
  /** Fabricante genérico; `null` sem `vendorId` utilizável. */
  vendor: string | null
  luid: LuidShape
}

export interface LuidShapeReport {
  outcome: 'completed' | 'timeout' | 'cancelled' | 'error' | 'invalid-value'
  error: string | null
  ms: number
  adapters: AdapterLuidShape[]
}

const MAX_LUID_ADAPTERS = 32
const MAX_LUID_PROPERTIES = 16

const kindOf = (v: unknown): ValueKind => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  return t === 'undefined' || t === 'boolean' || t === 'number' || t === 'bigint' || t === 'string' || t === 'object' ? t : 'other'
}

const formatOf = (text: string): TextFormat => {
  if (text === '') return 'empty'
  if (/^-?[0-9]+$/.test(text)) return 'decimal'
  if (/^(0x)?[0-9a-f]+$/i.test(text)) return 'hexadecimal'
  if (/^(0x)?[0-9a-f]+[:,\-_ ](0x)?[0-9a-f]+$/i.test(text)) return 'hex-pair'
  return 'other'
}

function shapeOf(v: unknown): ValueShape {
  const kind = kindOf(v)
  if (kind === 'number') return { kind, safeInteger: Number.isSafeInteger(v) }
  if (kind === 'string') return { kind, length: (v as string).length, format: formatOf(v as string) }
  return { kind }
}

const vendorLabel = (raw: unknown): string | null => {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || raw > 0xffff_ffff) return null
  return raw === 0x1414 ? 'microsoft' : pciVendorOf(raw)
}

/** Forma do `luid` de cada adaptador. Nenhum valor é copiado para o resultado. */
export function describeLuidShapes(raw: unknown): AdapterLuidShape[] | null {
  const list = isObject(raw) ? raw['gpuDevice'] : undefined
  if (!Array.isArray(list)) return null
  return list.slice(0, MAX_LUID_ADAPTERS).map((d, index) => {
    const o = isObject(d) ? d : {}
    const present = Object.prototype.hasOwnProperty.call(o, 'luid')
    const value = o['luid']
    const luid: LuidShape = { present, ...shapeOf(value) }
    if (luid.kind === 'object') {
      luid.properties = Object.keys(value as object)
        .sort()
        .slice(0, MAX_LUID_PROPERTIES)
        .map((name) => ({ name: cleanText(name)?.slice(0, 40) ?? '?', ...shapeOf((value as Record<string, unknown>)[name]) }))
    }
    return { index, vendor: vendorLabel(o['vendorId']), luid }
  })
}

/**
 * Executa o modo isolado: `getGPUInfo('basic')` uma vez, com prazo e
 * cancelamento. Recebe só essa função; não tem acesso a nenhuma outra fonte.
 */
export async function runLuidShapeCheck(
  getGPUInfo: (infoType: 'basic') => Promise<unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal; clock?: () => number } = {}
): Promise<LuidShapeReport> {
  const clock = options.clock ?? (() => performance.now())
  const started = clock()
  const done = (outcome: LuidShapeReport['outcome'], adapters: AdapterLuidShape[] = [], error: string | null = null): LuidShapeReport => ({
    outcome,
    error,
    ms: Math.round(clock() - started),
    adapters
  })
  if (options.signal?.aborted) return done('cancelled')
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const interrupted = new Promise<'timeout' | 'cancelled'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? 4_000)
      onAbort = () => resolve('cancelled')
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
    const raw = await Promise.race([getGPUInfo('basic').then((value) => ({ value })), interrupted])
    if (raw === 'timeout' || raw === 'cancelled') return done(raw)
    const adapters = describeLuidShapes(raw.value)
    return adapters === null ? done('invalid-value') : done('completed', adapters)
  } catch (error) {
    return done('error', [], error instanceof Error ? error.name : 'desconhecido')
  } finally {
    clearTimeout(timer)
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
  }
}

const shapeText = (s: ValueShape) =>
  [s.kind, s.safeInteger === undefined ? null : `inteiro seguro: ${s.safeInteger ? 'sim' : 'não'}`, s.length === undefined ? null : `comprimento ${s.length}`, s.format ? `formato ${s.format}` : null]
    .filter((p) => p !== null)
    .join(' · ')

export function formatLuidShapeReport(r: LuidShapeReport): string {
  const lines = [`Forma do luid em getGPUInfo('basic'): ${r.outcome}${r.error ? ` (${r.error})` : ''} · ${r.ms} ms · ${r.adapters.length} adaptador(es)`]
  for (const a of r.adapters) {
    lines.push(`  adaptador ${a.index} (${a.vendor ?? 'fabricante não informado'}): luid ${a.luid.present ? 'presente' : 'ausente'} · ${shapeText(a.luid)}`)
    for (const p of a.luid.properties ?? []) lines.push(`      .${p.name}: ${shapeText(p)}`)
  }
  lines.push('', 'Nenhum valor de luid, identificador de dispositivo, versão de driver ou auxAttributes foi exibido.')
  return lines.join('\n')
}

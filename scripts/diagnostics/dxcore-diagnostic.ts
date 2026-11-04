import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { BundledHelperRunner, DXCORE_HELPER, DXCORE_HELPER_SHA256, isTrustedRoot, type HelperRunResult } from '../../src/main/hardware/local/bundled-helper'
import { CommandRunner, type CommandResult } from '../../src/main/hardware/local/command-runner'
import { HARDWARE_COMMANDS, type GpuCommandId } from '../../src/main/hardware/local/commands'
import { LUID_ZERO, type DxcoreAdapter, type DxcoreSourceStatus } from '../../src/main/hardware/local/dxcore-contract'
import { captureGpuSources } from '../../src/main/hardware/local/dxcore/capture'
import { interpretHelperResult, type DxcoreSource } from '../../src/main/hardware/local/dxcore/parser'
import { vramAgrees, type RegistryVram } from '../../src/main/hardware/local/dxcore/rules'
import { electronPairsFrom, pairKey, registryFor, sameComposition, selectGpuList, validateDxcoreList, type DxcoreGpuTrace } from '../../src/main/hardware/local/dxcore/selection'
import { pciVendorOf, probeGpus, SOFTWARE_RENDERER } from '../../src/main/hardware/local/probes/gpu'
import { checkHelperBinary } from '../native/pe-inspect'

/**
 * Diagnóstico MANUAL do auxiliar DXCore (Etapa 6C.4A). Não faz parte do app:
 * só roda pelo supervisor (D55) com `--confirm-dxcore-helper-read`.
 *
 * - Executa o auxiliar UMA vez, pelo executor de produção (`BundledHelperRunner`)
 *   com todas as verificações dele (arquivo comum, sem link ou junção, tamanho,
 *   SHA-256 antes e depois, prazo de 3 s, limites de 64 KiB/4 KiB, sem shell,
 *   ambiente mínimo). O único ponto diferente da produção é o hash esperado:
 *   o do build aprovado, fixo AQUI, passado pela injeção `expectedSha256` do
 *   executor. `DXCORE_HELPER_SHA256` do app continua `null` (conferido).
 * - Antes, confere as pré-condições; qualquer falha impede a execução.
 * - Depois, lê a detecção atual só da GPU (`getGPUInfo('basic')` e as duas
 *   consultas fixas do Registro) para comparar. CPU, memória, armazenamento e
 *   sistema não são consultados.
 *
 * O relatório não contém saída bruta, nomes de GPU, identificadores PCI de
 * dispositivo, LUIDs, caminhos nem nome de usuário: só fabricante, presença,
 * contagens, coerência e memórias em GiB.
 */

/** Build aprovado na Etapa 6C.3B.2B. Só deste diagnóstico; o app não o usa. */
export const APPROVED_DXCORE_BUILD = Object.freeze({
  sha256: 'd2e3aabcbec2a462af1c237b7f8c4d35d0b0b698f18a67748a2efc899d84b13b',
  size: 115_712,
  msvc: '14.44.35207',
  windowsSdk: '10.0.26100.0'
})

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const sameText = (a: string, b: string) => a.replace(/\\+$/, '').toLowerCase() === b.replace(/\\+$/, '').toLowerCase()

// ── Pré-condições ───────────────────────────────────────────────────────────

export type PreconditionId =
  | 'platform'
  | 'production-hash-null'
  | 'resources-root'
  | 'helper-file'
  | 'helper-size'
  | 'helper-sha256'
  | 'build-manifest'
  | 'build-copy'
  | 'pe-policy'

export interface Precondition {
  id: PreconditionId
  ok: boolean
  /** Só códigos, nunca caminhos nem conteúdo. */
  detail: string | null
}

export interface PreconditionFs {
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<Buffer>
}

export interface PreconditionInput {
  /** Raiz do projeto (caminho real). */
  projectRoot: string
  fs: PreconditionFs
  platform: NodeJS.Platform
  arch: string
  /** Textos que não podem aparecer no binário (pasta do projeto e do usuário). */
  forbiddenText: string[]
  /** Hash de produção; padrão: o do app. */
  productionHashes?: Readonly<Record<'x64' | 'arm64', string | null>>
}

export const resourcesRootOf = (projectRoot: string) => win32.join(projectRoot, 'resources')
export const helperPathOf = (projectRoot: string) => win32.join(resourcesRootOf(projectRoot), DXCORE_HELPER.directory, 'win32-x64', DXCORE_HELPER.fileName)
const buildDirOf = (projectRoot: string) => win32.join(projectRoot, 'native', 'dxcore-helper', 'build', 'x64')

const code = (error: unknown) => {
  const c = (error as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : 'error'
}

/** Confere tudo antes de executar. Não executa nada. */
export async function checkDxcorePreconditions(input: PreconditionInput): Promise<Precondition[]> {
  const results: Precondition[] = []
  const add = (id: PreconditionId, ok: boolean, detail: string | null = null) => results.push({ id, ok, detail })
  const production = input.productionHashes ?? DXCORE_HELPER_SHA256

  add('platform', input.platform === 'win32' && input.arch === 'x64', input.platform === 'win32' && input.arch === 'x64' ? null : 'not-win32-x64')
  add('production-hash-null', production.x64 === null && production.arm64 === null)

  const root = resourcesRootOf(input.projectRoot)
  let rootOk = isTrustedRoot(root)
  try {
    rootOk = rootOk && sameText(await input.fs.realpath(root), root)
    add('resources-root', rootOk, rootOk ? null : 'untrusted-or-redirected')
  } catch (error) {
    add('resources-root', false, code(error))
  }

  const path = helperPathOf(input.projectRoot)
  let bytes: Buffer | null = null
  try {
    const stat = await input.fs.lstat(path)
    const real = await input.fs.realpath(path)
    const plain = stat.isFile() && !stat.isSymbolicLink() && sameText(real, path)
    add('helper-file', plain, plain ? null : 'link-junction-or-not-file')
    if (plain) bytes = await input.fs.readFile(path)
  } catch (error) {
    add('helper-file', false, code(error))
  }

  const digest = bytes ? sha256(bytes) : null
  add('helper-size', bytes?.length === APPROVED_DXCORE_BUILD.size, bytes ? null : 'not-read')
  add('helper-sha256', digest === APPROVED_DXCORE_BUILD.sha256, bytes ? (digest === APPROVED_DXCORE_BUILD.sha256 ? null : 'mismatch') : 'not-read')

  // Arquivo igual ao que o build registrou e à cópia da pasta de build: não mudou depois de compilado.
  const buildDir = buildDirOf(input.projectRoot)
  try {
    const manifest = JSON.parse((await input.fs.readFile(win32.join(buildDir, 'build-manifest.json'))).toString('utf8')) as {
      binary?: { size?: unknown; sha256?: unknown }
      toolchain?: { msvc?: unknown; windowsSdk?: unknown }
      reproducibility?: { identical?: unknown } | null
    }
    const ok =
      manifest.binary?.sha256 === APPROVED_DXCORE_BUILD.sha256 &&
      manifest.binary?.size === APPROVED_DXCORE_BUILD.size &&
      manifest.toolchain?.msvc === APPROVED_DXCORE_BUILD.msvc &&
      manifest.toolchain?.windowsSdk === APPROVED_DXCORE_BUILD.windowsSdk &&
      manifest.reproducibility?.identical === true
    add('build-manifest', ok, ok ? null : 'differs')
  } catch (error) {
    add('build-manifest', false, code(error))
  }
  try {
    const copy = sha256(await input.fs.readFile(win32.join(buildDir, DXCORE_HELPER.fileName)))
    add('build-copy', copy === APPROVED_DXCORE_BUILD.sha256, copy === APPROVED_DXCORE_BUILD.sha256 ? null : 'differs')
  } catch (error) {
    add('build-copy', false, code(error))
  }

  if (bytes) {
    const { issues } = checkHelperBinary(bytes, input.forbiddenText)
    add('pe-policy', issues.length === 0, issues.length === 0 ? null : issues.join(','))
  } else {
    add('pe-policy', false, 'not-read')
  }
  return results
}

export const preconditionsMet = (list: Precondition[]) => list.length > 0 && list.every((p) => p.ok)

// ── Execução única ──────────────────────────────────────────────────────────

export interface HelperRun {
  result: HelperRunResult
  /** Tempo total medido aqui (verificação, execução e nova verificação). */
  elapsedMs: number
}

/**
 * A única execução do auxiliar neste diagnóstico: um executor novo, uma
 * chamada a `run`, sem nova tentativa em nenhum caso.
 */
export async function runApprovedHelperOnce(projectRoot: string, signal: AbortSignal | undefined, clock: () => number = () => performance.now()): Promise<HelperRun> {
  const runner = new BundledHelperRunner({
    resourcesRoot: resourcesRootOf(projectRoot),
    expectedSha256: Object.freeze({ x64: APPROVED_DXCORE_BUILD.sha256, arm64: null })
  })
  const started = clock()
  const result = await runner.run(signal)
  return { result, elapsedMs: Math.round(clock() - started) }
}

// ── Resumo sanitizado ───────────────────────────────────────────────────────

const GIB = 1024n ** 3n
/** Bytes → GiB com duas casas (texto). */
export function gib(bytes: bigint | null): string | null {
  if (bytes === null) return null
  const hundredths = (bytes * 100n + GIB / 2n) / GIB
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`
}

/** Só para dizer se a descrição cita um fabricante; o texto nunca é impresso. */
const VENDOR_WORDS = /\b(nvidia|geforce|amd|radeon|intel|microsoft|qualcomm|adreno)\b/i

export interface DxcoreAdapterSummary {
  index: number
  isHardware: boolean | null
  isIntegrated: boolean | null
  /** Fabricante pelo identificador PCI (nunca o identificador do dispositivo). */
  vendor: string | null
  softwareRenderer: boolean
  hardwareId: 'present' | 'absent'
  luid: 'present' | 'zero' | 'absent'
  description: { present: boolean; length: number | null; asciiOnly: boolean | null; mentionsVendor: boolean | null }
  dedicatedAdapterMemoryGib: string | null
  dedicatedSystemMemoryGib: string | null
  sharedSystemMemoryGib: string | null
}

export interface DxcoreRunSummary {
  kind: HelperRunResult['kind']
  /** Motivo da recusa do executor, se houver. */
  rejection: string | null
  failure: string | null
  exitCode: number | null
  processExited: boolean
  elapsedMs: number
  helperDurationMs: number | null
  stdoutBytes: number | null
  status: DxcoreSourceStatus
  parseError: string | null
  adapters: DxcoreAdapterSummary[]
  luidsDistinct: boolean | null
  /** Código 12 pode ser lista alterada (`IsStale`), entre outras falhas de enumeração. */
  stale: 'not-signalled' | 'possible' | 'unknown'
}

function summarizeAdapter(a: DxcoreAdapter, index: number): DxcoreAdapterSummary {
  return {
    index,
    isHardware: a.isHardware,
    isIntegrated: a.isIntegrated,
    vendor: a.vendorId === null ? null : pciVendorOf(a.vendorId),
    softwareRenderer: a.vendorId === SOFTWARE_RENDERER.vendorId && a.deviceId === SOFTWARE_RENDERER.deviceId,
    hardwareId: a.vendorId !== null && a.deviceId !== null ? 'present' : 'absent',
    luid: a.luid === null ? 'absent' : a.luid === LUID_ZERO ? 'zero' : 'present',
    description:
      a.description === null
        ? { present: false, length: null, asciiOnly: null, mentionsVendor: null }
        : { present: true, length: a.description.length, asciiOnly: /^[\x20-\x7e]*$/.test(a.description), mentionsVendor: VENDOR_WORDS.test(a.description) },
    dedicatedAdapterMemoryGib: gib(a.dedicatedAdapterMemory),
    dedicatedSystemMemoryGib: gib(a.dedicatedSystemMemory),
    sharedSystemMemoryGib: gib(a.sharedSystemMemory)
  }
}

export function summarizeRun(run: HelperRun): { summary: DxcoreRunSummary; source: DxcoreSource } {
  const { result } = run
  const source = interpretHelperResult(result)
  const adapters = source.status === 'ok' ? source.adapters : []
  const luids = adapters.map((a) => a.luid).filter((l): l is string => l !== null && l !== LUID_ZERO)
  const exitCode = result.kind === 'failed' ? result.exitCode : result.kind === 'success' ? 0 : null
  return {
    source,
    summary: {
      kind: result.kind,
      rejection: result.kind === 'rejected' ? result.reason : null,
      failure: result.kind === 'failed' ? result.reason : result.kind === 'unavailable' ? result.reason : null,
      exitCode,
      processExited: result.processExited,
      elapsedMs: run.elapsedMs,
      helperDurationMs: result.kind === 'success' || result.kind === 'timeout' ? result.durationMs : null,
      stdoutBytes: result.kind === 'success' ? Buffer.byteLength(result.stdout, 'utf8') : null,
      status: source.status,
      parseError: source.status === 'invalid-output' ? source.parseError : null,
      adapters: adapters.map(summarizeAdapter),
      luidsDistinct: source.status === 'ok' ? new Set(luids).size === luids.length : null,
      stale: exitCode === 0 ? 'not-signalled' : exitCode === 12 ? 'possible' : 'unknown'
    }
  }
}

// ── Comparação com Electron + Registro (só GPU) ─────────────────────────────

export interface ComparisonDeps {
  getGPUInfo: (infoType: 'basic') => Promise<unknown>
  /** Padrão: `CommandRunner` com o catálogo autorizado. */
  runCommand?: (id: GpuCommandId, signal?: AbortSignal) => Promise<CommandResult>
}

export interface ElectronGpuSummary {
  vendor: string | null
  modelPresent: boolean
  vramGib: number | null
  vramQuality: string
  vramReason: string | null
}

export interface DxcoreGpuComparison {
  /** Índice na resposta do DXCore. */
  index: number
  vendor: string
  /** O par fabricante/dispositivo também aparece na lista do Electron. */
  inElectron: boolean
  registry: 'match' | Extract<RegistryVram, { kind: 'none' }>['reason']
  registryGib: string | null
  dedicatedGib: string | null
  /** Concordância pela tolerância provisória (`VRAM_AGREEMENT`). */
  agrees: boolean | null
}

export interface ComparisonSummary {
  electronStatus: 'ok' | string
  electronGpus: ElectronGpuSummary[]
  electronIgnored: number
  registry: string
  composition: 'same' | 'different' | 'electron-unknown' | 'dxcore-not-usable'
  dxcoreList: 'usable' | string
  perGpu: DxcoreGpuComparison[]
  selection: { source: string; rejection: string | null; traces: DxcoreGpuTrace[]; gpus: Array<{ vendor: string | null; modelPresent: boolean; vramGb: number | null; vramQuality: string; sharedMemory: boolean | null; sharedQuality: string }> }
}

export async function compareWithElectron(source: DxcoreSource, deps: ComparisonDeps, signal?: AbortSignal): Promise<ComparisonSummary> {
  const runner = new CommandRunner({ commands: HARDWARE_COMMANDS })
  const run = deps.runCommand ?? ((id: GpuCommandId, s?: AbortSignal) => runner.run(id, s))
  // A mesma captura do detector: cada consulta no máximo uma vez, respostas só em memória.
  const capture = captureGpuSources({ getGPUInfo: deps.getGPUInfo, runCommand: run })
  const probe = await probeGpus(capture.api, { signal })
  const raw = capture.electronRaw()
  const registry = capture.registry(probe.registry)
  const selection = selectGpuList({ dxcore: source, electron: { result: probe, raw }, registry })

  const list = validateDxcoreList(source)
  const electronPairs = electronPairsFrom(raw)
  const pairs = list.ok ? list.hardware.map((a) => pairKey(a.vendorId!, a.deviceId!)) : []
  const counts = new Map<string, number>()
  for (const p of pairs) counts.set(p, (counts.get(p) ?? 0) + 1)
  const all = source.status === 'ok' ? source.adapters : []

  const perGpu: DxcoreGpuComparison[] = list.ok
    ? list.hardware.map((a, i) => {
        const reg = registryFor(pairs[i]!, counts.get(pairs[i]!)!, registry)
        return {
          index: all.indexOf(a),
          vendor: pciVendorOf(a.vendorId!),
          inElectron: electronPairs?.includes(pairs[i]!) ?? false,
          registry: reg.kind === 'match' ? 'match' : reg.reason,
          registryGib: reg.kind === 'match' ? gib(reg.bytes) : null,
          dedicatedGib: gib(a.dedicatedAdapterMemory),
          agrees: reg.kind === 'match' && a.dedicatedAdapterMemory !== null ? vramAgrees(reg.bytes, a.dedicatedAdapterMemory) : null
        }
      })
    : []

  const entries = probe.gpus.value ?? []
  return {
    electronStatus: probe.gpus.value === null ? (probe.gpus.quality === 'unavailable' ? probe.gpus.reason : 'unavailable') : 'ok',
    electronGpus: entries.map((g) => ({
      vendor: g.vendor.value,
      modelPresent: g.model.value !== null,
      vramGib: g.vramGb.value,
      vramQuality: g.vramGb.quality,
      vramReason: g.vramGb.quality === 'unavailable' ? g.vramGb.reason : null
    })),
    electronIgnored: probe.ignored,
    registry: probe.registry,
    composition: !list.ok ? 'dxcore-not-usable' : electronPairs === null ? 'electron-unknown' : sameComposition(pairs, electronPairs) ? 'same' : 'different',
    dxcoreList: list.ok ? 'usable' : list.reason,
    perGpu,
    selection: {
      source: selection.source,
      rejection: selection.rejection,
      traces: selection.traces,
      gpus: (selection.result.gpus.value ?? []).map((g) => ({
        vendor: g.vendor.value,
        modelPresent: g.model.value !== null,
        vramGb: g.vramGb.value,
        vramQuality: g.vramGb.quality === 'unavailable' ? `unavailable (${g.vramGb.reason})` : g.vramGb.quality,
        sharedMemory: g.sharedMemory.value,
        sharedQuality: g.sharedMemory.quality === 'unavailable' ? `unavailable (${g.sharedMemory.reason})` : g.sharedMemory.quality
      }))
    }
  }
}

// ── Texto do relatório ──────────────────────────────────────────────────────

const yesNo = (v: boolean | null) => (v === null ? 'null' : v ? 'sim' : 'não')

export function formatPreconditions(list: Precondition[]): string {
  const lines = ['Pré-condições:']
  for (const p of list) lines.push(`  ${p.ok ? 'ok   ' : 'FALHA'} ${p.id}${p.detail ? ` (${p.detail})` : ''}`)
  lines.push(preconditionsMet(list) ? 'Todas atendidas.' : 'Alguma falhou: o auxiliar NÃO foi executado.')
  return lines.join('\n')
}

export function formatDxcoreReport(s: DxcoreRunSummary, c: ComparisonSummary | null): string {
  const lines = [
    'Execução do auxiliar (uma vez):',
    `  resultado: ${s.kind}${s.rejection ? ` (${s.rejection})` : ''}${s.failure ? ` (${s.failure})` : ''}; código de saída: ${s.exitCode ?? 'n/d'}`,
    `  processo encerrado: ${yesNo(s.processExited)}; tempo total: ${s.elapsedMs} ms; processo: ${s.helperDurationMs ?? 'n/d'} ms`,
    `  saída padrão: ${s.stdoutBytes ?? 'n/d'} bytes (não impressa); situação: ${s.status}${s.parseError ? ` (${s.parseError})` : ''}`,
    `  adaptadores: ${s.adapters.length}; LUIDs distintos: ${yesNo(s.luidsDistinct)}; IsStale: ${s.stale}`
  ]
  for (const a of s.adapters) {
    const d = a.description
    lines.push(
      `  [${a.index}] fabricante ${a.vendor ?? 'null'}${a.softwareRenderer ? ' (renderizador por software)' : ''}; isHardware ${yesNo(a.isHardware)}; isIntegrated ${yesNo(a.isIntegrated)}; id PCI ${a.hardwareId}; LUID ${a.luid}`,
      `      descrição: ${d.present ? `presente, ${d.length} unidades, ASCII ${yesNo(d.asciiOnly)}, cita fabricante ${yesNo(d.mentionsVendor)}` : 'null'}`,
      `      DedicatedAdapterMemory ${a.dedicatedAdapterMemoryGib ?? 'null'} GiB; DedicatedSystemMemory ${a.dedicatedSystemMemoryGib ?? 'null'} GiB; SharedSystemMemory ${a.sharedSystemMemoryGib ?? 'null'} GiB`
    )
  }
  if (c) {
    lines.push('', 'Detecção atual (Electron + Registro, só GPU):')
    lines.push(`  getGPUInfo: ${c.electronStatus}; GPUs: ${c.electronGpus.length}; ignoradas: ${c.electronIgnored}; Registro: ${c.registry}`)
    c.electronGpus.forEach((g, i) =>
      lines.push(`  [${i}] fabricante ${g.vendor ?? 'null'}; modelo presente ${yesNo(g.modelPresent)}; VRAM ${g.vramGib ?? 'null'} GB (${g.vramQuality}${g.vramReason ? `, ${g.vramReason}` : ''})`)
    )
    lines.push('', 'Comparação:')
    lines.push(`  lista do DXCore: ${c.dxcoreList}; composição igual à do Electron: ${c.composition}`)
    for (const g of c.perGpu) {
      lines.push(`  DXCore [${g.index}] ${g.vendor}: no Electron ${yesNo(g.inElectron)}; Registro ${g.registry}${g.registryGib ? ` ${g.registryGib} GiB` : ''}; dedicada ${g.dedicatedGib ?? 'null'} GiB; concordam ${yesNo(g.agrees)}`)
    }
    lines.push(`  seleção (simulada, sem alterar o perfil): fonte ${c.selection.source}${c.selection.rejection ? ` (${c.selection.rejection})` : ''}`)
    c.selection.gpus.forEach((g, i) => {
      const t = c.selection.traces[i]
      lines.push(
        `  [${i}] fabricante ${g.vendor ?? 'null'}; modelo presente ${yesNo(g.modelPresent)}; VRAM ${g.vramGb ?? 'null'} GB (${g.vramQuality}); sharedMemory ${yesNo(g.sharedMemory)} (${g.sharedQuality})${t ? `; VRAM ${t.vram}, Registro ${t.registry}` : ''}`
      )
    })
  }
  return lines.join('\n')
}

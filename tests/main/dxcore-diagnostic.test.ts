import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { describe, it } from 'node:test'
import type { HelperRunResult } from '../../src/main/hardware/local/bundled-helper'
import type { CommandResult } from '../../src/main/hardware/local/command-runner'
import { GPU_COMMAND_IDS, type GpuCommandId } from '../../src/main/hardware/local/commands'
import { DXCORE_WIRE_ADAPTER_KEYS } from '../../src/main/hardware/local/dxcore-contract'
import {
  APPROVED_DXCORE_BUILD,
  checkDxcorePreconditions,
  compareWithElectron,
  formatDxcoreReport,
  formatPreconditions,
  gib,
  helperPathOf,
  preconditionsMet,
  summarizeRun,
  type PreconditionFs
} from '../../scripts/diagnostics/dxcore-diagnostic'
import { countHelperProcesses, integrityLevelFrom, isUnelevated, TASKLIST_ARGS, WHOAMI_ARGS } from '../../scripts/diagnostics/dxcore-supervisor-checks'

// Diagnóstico do auxiliar DXCore (Etapa 6C.4A): só dados SIMULADOS. Nenhum
// processo é iniciado; o auxiliar nunca é executado por estes testes.

const ROOT = join(import.meta.dirname, '../..')
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8')

// ── Respostas simuladas ─────────────────────────────────────────────────────

const LUID_A = '00000000:0001A2B3'
const LUID_B = '00000000:0001C4D5'
const LUID_C = '00000000:0001E6F7'
const MiB = 1024n ** 2n
const GiB = 1024n ** 3n

interface WireAdapter {
  luid: string | null
  vendorId: number | null
  deviceId: number | null
  description: string | null
  isHardware: boolean | null
  isIntegrated: boolean | null
  dedicatedAdapterMemory: string | null
  dedicatedSystemMemory: string | null
  sharedSystemMemory: string | null
}

/** Resposta no formato do protocolo v1 (chaves na ordem do contrato). */
const response = (adapters: WireAdapter[]) =>
  `{"protocol":"gerpro.dxcore-adapters","version":1,"adapters":[${adapters
    .map((a) => `{${DXCORE_WIRE_ADAPTER_KEYS.map((k) => `"${k}":${JSON.stringify(a[k])}`).join(',')}}`)
    .join(',')}]}\n`

const NVIDIA: WireAdapter = {
  luid: LUID_A,
  vendorId: 0x10de,
  deviceId: 0x25a0,
  description: 'NVIDIA GeForce RTX 3050 Laptop GPU',
  isHardware: true,
  isIntegrated: false,
  dedicatedAdapterMemory: String(4n * GiB - 300n * MiB),
  dedicatedSystemMemory: '0',
  sharedSystemMemory: String(8n * GiB)
}
const INTEL: WireAdapter = {
  luid: LUID_B,
  vendorId: 0x8086,
  deviceId: 0x46a6,
  description: 'Intel(R) Iris(R) Xe Graphics',
  isHardware: true,
  isIntegrated: true,
  dedicatedAdapterMemory: String(128n * MiB),
  dedicatedSystemMemory: '0',
  sharedSystemMemory: String(8n * GiB)
}
const BASIC_RENDER: WireAdapter = {
  luid: LUID_C,
  vendorId: 0x1414,
  deviceId: 0x008c,
  description: 'Microsoft Basic Render Driver',
  isHardware: false,
  isIntegrated: null,
  dedicatedAdapterMemory: '0',
  dedicatedSystemMemory: '0',
  sharedSystemMemory: String(8n * GiB)
}

const success = (stdout: string): HelperRunResult => ({ kind: 'success', stdout, durationMs: 41, commandId: 'gpu.dxcore-adapters', processExited: true })

const KEY = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
const regOutput = (name: string, type: string, entries: Array<[string, string]>) =>
  `\r\n${entries.map(([subkey, data]) => `${KEY}\\${subkey}\r\n    ${name}    ${type}    ${data}\r\n`).join('\r\n')}\r\nFim da pesquisa.\r\n`
const hex = (n: bigint) => `0x${n.toString(16)}`

const REGISTRY: Record<GpuCommandId, string> = {
  [GPU_COMMAND_IDS.deviceIds]: regOutput('MatchingDeviceId', 'REG_SZ', [
    ['0000', 'pci\\ven_8086&dev_46a6'],
    ['0001', 'pci\\ven_10de&dev_25a0']
  ]),
  [GPU_COMMAND_IDS.memorySizes]: regOutput('HardwareInformation.qwMemorySize', 'REG_QWORD', [
    ['0000', hex(128n * MiB)],
    ['0001', hex(4n * GiB)]
  ])
}

const electronInfo = (devices: Array<[number, number, string]>) => ({
  gpuDevice: devices.map(([vendorId, deviceId, deviceString]) => ({ active: true, vendorId, deviceId, deviceString, driverVendor: 'x', driverVersion: '1' }))
})

function fakeDeps(devices: Array<[number, number, string]>) {
  const calls: string[] = []
  return {
    calls,
    deps: {
      getGPUInfo: async (type: 'basic') => {
        calls.push(`getGPUInfo:${type}`)
        return electronInfo(devices)
      },
      runCommand: async (id: GpuCommandId): Promise<CommandResult> => {
        calls.push(id)
        return { kind: 'success', stdout: REGISTRY[id], durationMs: 2, commandId: id, processExited: true }
      }
    }
  }
}

/** Nada que identifique o dispositivo pode sair no relatório. */
function assertSanitized(text: string) {
  for (const secret of [LUID_A, LUID_B, LUID_C, '0001A2B3', '25a0', '25A0', '46a6', '46A6', '10de', '8086', 'RTX', 'GeForce', 'Iris', 'Basic Render', 'ven_', 'HKEY_']) {
    assert.ok(!text.includes(secret), `relatório contém ${secret}`)
  }
}

// ── Testes ──────────────────────────────────────────────────────────────────

describe('diagnóstico DXCore: verificações do supervisor', () => {
  it('nível de integridade pelo SID do rótulo obrigatório; elevado ou desconhecido recusa', () => {
    const line = (sid: string) => `"Rótulo Obrigatório\\Nível Obrigatório","Rótulo","${sid}",""`
    assert.equal(integrityLevelFrom(`"Todos","Grupo bem conhecido","S-1-1-0","x"\r\n${line('S-1-16-8192')}\r\n`), 'medium')
    assert.equal(integrityLevelFrom(line('S-1-16-12288')), 'high')
    assert.equal(integrityLevelFrom(line('S-1-16-16384')), 'system')
    assert.equal(integrityLevelFrom('"Todos","Grupo","S-1-1-0","x"'), 'unknown')
    assert.equal(integrityLevelFrom(`${line('S-1-16-8192')}\r\n${line('S-1-16-12288')}`), 'unknown')
    // Prefixo parecido não conta (S-1-16-81920 não é S-1-16-8192).
    assert.equal(integrityLevelFrom(line('S-1-16-81920')), 'unknown')
    assert.ok(isUnelevated('medium') && isUnelevated('low'))
    for (const level of ['high', 'system', 'unknown'] as const) assert.ok(!isUnelevated(level))
  })

  it('processos do auxiliar: só linhas CSV com o nome exato na primeira coluna', () => {
    assert.equal(countHelperProcesses('INFORMAÇÕES: Nenhuma tarefa em execução corresponde aos critérios.\r\n'), 0)
    assert.equal(countHelperProcesses('"gerpro-dxcore-helper.exe","1234","Console","1","3.000 K"\r\n'), 1)
    assert.equal(countHelperProcesses('"gerpro-dxcore-helper.exe.bak","1","x"\r\n"outro.exe","2","x"'), 0)
    assert.deepEqual([...WHOAMI_ARGS], ['/groups', '/fo', 'csv', '/nh'])
    assert.deepEqual([...TASKLIST_ARGS], ['/fi', 'IMAGENAME eq gerpro-dxcore-helper.exe', '/fo', 'csv', '/nh'])
  })
})

describe('diagnóstico DXCore: pré-condições (sem executar nada)', () => {
  const PROJECT = 'C:\\Proj'
  const HELPER = helperPathOf(PROJECT)
  const BUILD = win32.join(PROJECT, 'native', 'dxcore-helper', 'build', 'x64')
  const manifest = (over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        binary: { size: APPROVED_DXCORE_BUILD.size, sha256: APPROVED_DXCORE_BUILD.sha256 },
        toolchain: { msvc: APPROVED_DXCORE_BUILD.msvc, windowsSdk: APPROVED_DXCORE_BUILD.windowsSdk },
        reproducibility: { builds: 2, identical: true },
        ...over
      })
    )

  function fakeFs(files: Record<string, { bytes: Buffer; link?: boolean; real?: string }>): PreconditionFs {
    const missing = () => Object.assign(new Error('x'), { code: 'ENOENT' })
    return {
      lstat: async (p) => {
        const f = files[p]
        if (!f) throw missing()
        return { isFile: () => !f.link, isSymbolicLink: () => f.link === true, size: f.bytes.length }
      },
      realpath: async (p) => {
        if (p === win32.join(PROJECT, 'resources')) return p
        const f = files[p]
        if (!f) throw missing()
        return f.real ?? p
      },
      readFile: async (p) => {
        const f = files[p]
        if (!f) throw missing()
        return f.bytes
      }
    }
  }
  const input = (fs: PreconditionFs, over: Record<string, unknown> = {}) => ({ projectRoot: PROJECT, fs, platform: 'win32' as const, arch: 'x64', forbiddenText: [PROJECT], ...over })
  const byId = (list: Awaited<ReturnType<typeof checkDxcorePreconditions>>) => Object.fromEntries(list.map((p) => [p.id, p]))

  it('auxiliar ausente: nada lido, todas as verificações do arquivo falham', async () => {
    const list = await checkDxcorePreconditions(input(fakeFs({})))
    const r = byId(list)
    assert.equal(r['helper-file']!.detail, 'ENOENT')
    for (const id of ['helper-size', 'helper-sha256', 'pe-policy', 'build-manifest', 'build-copy']) assert.equal(r[id]!.ok, false, id)
    assert.ok(!preconditionsMet(list))
    assert.match(formatPreconditions(list), /NÃO foi executado/)
  })

  it('link, junção no caminho, bytes diferentes e manifesto diferente recusam', async () => {
    const other = Buffer.alloc(2048, 1)
    assert.equal(byId(await checkDxcorePreconditions(input(fakeFs({ [HELPER]: { bytes: other, link: true } }))))['helper-file']!.ok, false)
    const redirected = byId(await checkDxcorePreconditions(input(fakeFs({ [HELPER]: { bytes: other, real: 'D:\\outro\\gerpro-dxcore-helper.exe' } }))))
    assert.equal(redirected['helper-file']!.detail, 'link-junction-or-not-file')
    const r = byId(
      await checkDxcorePreconditions(
        input(fakeFs({ [HELPER]: { bytes: other }, [win32.join(BUILD, 'build-manifest.json')]: { bytes: manifest({ reproducibility: { identical: false } }) }, [win32.join(BUILD, 'gerpro-dxcore-helper.exe')]: { bytes: other } }))
      )
    )
    assert.equal(r['helper-file']!.ok, true)
    assert.equal(r['helper-sha256']!.detail, 'mismatch')
    assert.equal(r['helper-size']!.ok, false)
    assert.equal(r['build-manifest']!.detail, 'differs')
    assert.equal(r['build-copy']!.detail, 'differs')
    assert.equal(r['pe-policy']!.ok, false)
  })

  it('hash de produção preenchido, outra plataforma ou arquitetura recusam', async () => {
    const r = byId(await checkDxcorePreconditions(input(fakeFs({}), { productionHashes: { x64: APPROVED_DXCORE_BUILD.sha256, arm64: null }, platform: 'linux', arch: 'arm64' })))
    assert.equal(r['production-hash-null']!.ok, false)
    assert.equal(r['platform']!.detail, 'not-win32-x64')
  })

  it('o hash de produção do app continua null', async () => {
    const r = byId(await checkDxcorePreconditions(input(fakeFs({}))))
    assert.equal(r['production-hash-null']!.ok, true)
  })

  const realRoot = realpathSync.native(ROOT).replace(/[\\/]+$/, '')
  const built = existsSync(helperPathOf(realRoot)) && existsSync(join(realRoot, 'native', 'dxcore-helper', 'build', 'x64', 'build-manifest.json'))
  it('binário local do build aprovado (só leitura, se existir): todas as pré-condições atendidas', { skip: !built && 'binário não compilado nesta máquina' }, async () => {
    const list = await checkDxcorePreconditions({
      projectRoot: realRoot,
      fs: { lstat: (p) => lstat(p), realpath: (p) => realpath(p), readFile: (p) => readFile(p) },
      platform: process.platform,
      arch: process.arch,
      forbiddenText: [realRoot]
    })
    assert.deepEqual(list.filter((p) => !p.ok), [])
  })
})

describe('diagnóstico DXCore: resumo sanitizado', () => {
  it('resposta válida: contagem, flags, memórias em GiB, LUIDs distintos; nada identificável no texto', () => {
    const { summary, source } = summarizeRun({ result: success(response([NVIDIA, INTEL, BASIC_RENDER])), elapsedMs: 55 })
    assert.equal(source.status, 'ok')
    assert.equal(summary.exitCode, 0)
    assert.equal(summary.stale, 'not-signalled')
    assert.equal(summary.luidsDistinct, true)
    assert.equal(summary.adapters.length, 3)
    assert.deepEqual(
      summary.adapters.map((a) => [a.vendor, a.isHardware, a.isIntegrated, a.softwareRenderer, a.luid, a.hardwareId]),
      [
        ['nvidia', true, false, false, 'present', 'present'],
        ['intel', true, true, false, 'present', 'present'],
        ['other', false, null, true, 'present', 'present']
      ]
    )
    assert.equal(summary.adapters[0]!.dedicatedAdapterMemoryGib, '3.71')
    assert.equal(summary.adapters[1]!.dedicatedAdapterMemoryGib, '0.13')
    assert.equal(summary.adapters[0]!.sharedSystemMemoryGib, '8.00')
    assert.deepEqual(summary.adapters[0]!.description, { present: true, length: NVIDIA.description!.length, asciiOnly: true, mentionsVendor: true })
    assertSanitized(formatDxcoreReport(summary, null))
  })

  it('LUID repetido aparece como não distinto; descrição null vira ausente', () => {
    const { summary } = summarizeRun({ result: success(response([NVIDIA, { ...INTEL, luid: LUID_A, description: null }])), elapsedMs: 1 })
    assert.equal(summary.luidsDistinct, false)
    assert.equal(summary.adapters[1]!.description.present, false)
  })

  it('código 12: IsStale possível; recusa do executor e resposta inválida só com códigos', () => {
    const stale = summarizeRun({ result: { kind: 'failed', reason: 'exit-code', exitCode: 12, commandId: 'x', processExited: true }, elapsedMs: 1 })
    assert.equal(stale.summary.status, 'enumeration-failed')
    assert.equal(stale.summary.stale, 'possible')
    const rejected = summarizeRun({ result: { kind: 'rejected', reason: 'integrity-mismatch', commandId: 'x', processExited: true }, elapsedMs: 1 })
    assert.equal(rejected.summary.status, 'helper-rejected')
    assert.equal(rejected.summary.rejection, 'integrity-mismatch')
    const invalid = summarizeRun({ result: success('{"x":1}\n'), elapsedMs: 1 })
    assert.equal(invalid.summary.status, 'invalid-output')
    assert.equal(invalid.summary.adapters.length, 0)
    const timeout = summarizeRun({ result: { kind: 'timeout', durationMs: 3000, commandId: 'x', processExited: false }, elapsedMs: 3001 })
    assert.equal(timeout.summary.processExited, false)
    assert.match(formatDxcoreReport(timeout.summary, null), /processo encerrado: não/)
  })

  it('GiB com arredondamento e null', () => {
    assert.equal(gib(0n), '0.00')
    assert.equal(gib(GiB), '1.00')
    assert.equal(gib(GiB + GiB / 100n), '1.01')
    assert.equal(gib(GiB + GiB / 1000n), '1.00')
    assert.equal(gib(null), null)
  })
})

describe('diagnóstico DXCore: comparação com Electron + Registro (simulada)', () => {
  it('mesma composição: lista do DXCore usável, VRAM confirmada pelo Registro, integrada compartilhada', async () => {
    const { source } = summarizeRun({ result: success(response([NVIDIA, INTEL, BASIC_RENDER])), elapsedMs: 1 })
    const { deps, calls } = fakeDeps([
      [0x8086, 0x46a6, 'Intel(R) Iris(R) Xe Graphics'],
      [0x10de, 0x25a0, 'NVIDIA GeForce RTX 3050 Laptop GPU']
    ])
    const c = await compareWithElectron(source, deps)
    // Cada consulta do Registro no máximo uma vez; nenhuma outra sondagem.
    assert.deepEqual(calls, ['getGPUInfo:basic', GPU_COMMAND_IDS.deviceIds, GPU_COMMAND_IDS.memorySizes])
    assert.equal(c.composition, 'same')
    assert.equal(c.dxcoreList, 'usable')
    assert.equal(c.selection.source, 'dxcore')
    const nvidia = c.perGpu.find((g) => g.vendor === 'nvidia')!
    assert.deepEqual([nvidia.index, nvidia.inElectron, nvidia.registry, nvidia.registryGib, nvidia.agrees], [0, true, 'match', '4.00', false])
    const intel = c.perGpu.find((g) => g.vendor === 'intel')!
    assert.deepEqual([intel.registry, intel.agrees], ['match', true])
    const selected = c.selection.gpus
    // Divergência acima da tolerância: VRAM indisponível, nunca um dos dois valores.
    assert.equal(selected.find((g) => g.vendor === 'nvidia')!.vramGb, null)
    assert.ok(c.selection.traces.some((t) => t.vram === 'sources-diverge'))
    assert.equal(selected.find((g) => g.vendor === 'intel')!.sharedMemory, true)
    assert.equal(selected.find((g) => g.vendor === 'nvidia')!.sharedMemory, false)
    assertSanitized(formatDxcoreReport(summarizeRun({ result: success(response([NVIDIA, INTEL, BASIC_RENDER])), elapsedMs: 1 }).summary, c))
  })

  it('composição diferente: fica a lista do Electron (lists-disagree)', async () => {
    const { source } = summarizeRun({ result: success(response([NVIDIA, INTEL])), elapsedMs: 1 })
    const c = await compareWithElectron(source, fakeDeps([[0x10de, 0x25a0, 'NVIDIA']]).deps)
    assert.equal(c.composition, 'different')
    assert.equal(c.selection.source, 'electron')
    assert.equal(c.selection.rejection, 'lists-disagree')
  })

  it('DXCore indisponível: só a detecção atual', async () => {
    const { source } = summarizeRun({ result: { kind: 'failed', reason: 'exit-code', exitCode: 10, commandId: 'x', processExited: true }, elapsedMs: 1 })
    const c = await compareWithElectron(source, fakeDeps([[0x10de, 0x25a0, 'NVIDIA']]).deps)
    assert.equal(c.composition, 'dxcore-not-usable')
    assert.equal(c.selection.source, 'electron')
    assert.equal(c.electronGpus.length, 1)
  })
})

describe('diagnóstico DXCore: isolamento (revisão estática)', () => {
  const module = () => read('scripts', 'diagnostics', 'dxcore-diagnostic.ts')
  const electron = () => read('scripts', 'diagnostics', 'hardware-diagnostic.mjs')
  const supervisor = () => read('scripts', 'diagnostics', 'run-hardware-diagnostic.mjs')

  it('uma única chamada ao executor, sem nova tentativa; hash aprovado só no diagnóstico', () => {
    const src = module()
    assert.equal([...src.matchAll(/\.run\(signal\)/g)].length, 1)
    assert.equal([...src.matchAll(/new BundledHelperRunner\(/g)].length, 1)
    assert.doesNotMatch(src, /retry|setInterval|setTimeout/i)
    assert.match(src, /expectedSha256: Object\.freeze\(\{ x64: APPROVED_DXCORE_BUILD\.sha256, arm64: null \}\)/)
    assert.match(read('src', 'main', 'hardware', 'local', 'bundled-helper.ts'), /DXCORE_HELPER_SHA256: Readonly<Record<'x64' \| 'arm64', string \| null>> = Object\.freeze\(\{ x64: null, arm64: null \}\)/)
    // O app não importa o diagnóstico.
    const app = ['src/main/index.ts', 'src/main/hardware/local/local-hardware-detector.ts', 'src/main/hardware/hardware-advisor-service.ts'].filter((f) => existsSync(join(ROOT, f)))
    for (const f of app) assert.doesNotMatch(read(f), /dxcore-diagnostic|APPROVED_DXCORE_BUILD/, f)
  })

  it('o módulo não imprime nada; a saída do auxiliar e do Registro nunca vai para o texto', () => {
    const src = module()
    assert.doesNotMatch(src, /console\.|process\.stdout|process\.stderr|writeFile/)
    // Nenhuma formatação usa a saída bruta, a descrição, o LUID ou o identificador do dispositivo.
    const format = src.slice(src.indexOf('export function formatDxcoreReport('))
    // (`a.luid` e `a.description` ali são o resumo: só situação, nunca o valor.)
    assert.doesNotMatch(format, /\.stdout\b|deviceId|vendorId|DxcoreAdapter\b/)
  })

  it('Electron: só com a confirmação DXCore, e o hash e a execução só depois das pré-condições', () => {
    const src = electron()
    assert.match(src, /const CONFIRM_DXCORE = '--confirm-dxcore-helper-read'/)
    const fn = src.slice(src.indexOf('async function runDxcoreDiagnostic('))
    const pre = fn.indexOf('checkDxcorePreconditions(')
    const gate = fn.indexOf('if (!d.preconditionsMet(pre)) return 4')
    const run = fn.indexOf('runApprovedHelperOnce(')
    assert.ok(pre > 0 && gate > pre && run > gate)
    assert.equal([...fn.matchAll(/runApprovedHelperOnce\(/g)].length, 1)
  })

  it('supervisor: sem elevação e sem outro processo do auxiliar antes de iniciar; trava exclusiva; conferência depois', () => {
    const src = supervisor()
    assert.match(src, /const CONFIRM_DXCORE = '--confirm-dxcore-helper-read'/)
    const branch = src.slice(src.indexOf('if (dxcore) {'))
    const gate = branch.indexOf('if (!isUnelevated(level) || running !== 0) {')
    const lock = branch.indexOf("openSync(lockPath, 'wx')")
    const supervise = branch.indexOf('superviseDiagnostic(')
    assert.ok(gate > 0 && lock > gate && supervise > lock)
    assert.match(branch.slice(gate, lock), /process\.exit\(4\)/)
    assert.ok(branch.indexOf('const remaining = helperProcesses()') > supervise)
    // Ferramentas do sistema: só whoami e tasklist, sem shell, argumentos fixos, saída não impressa.
    const tool = src.slice(src.indexOf('function systemTool('), src.indexOf('const helperProcesses'))
    assert.match(tool, /shell: false/)
    assert.match(tool, /stdio: \['ignore', 'pipe', 'ignore'\]/)
    assert.deepEqual([...src.matchAll(/systemTool\('([^']+)'/g)].map((m) => m[1]).sort(), ['tasklist.exe', 'whoami.exe'])
    assert.doesNotMatch(src, /write\([^)]*(whoami|out)\b\)/)
  })
})

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { CommandResult } from '../../src/main/hardware/local/command-runner'
import { GPU_COMMAND_IDS, type GpuCommandId } from '../../src/main/hardware/local/commands'
import {
  describeGpuInfo,
  describeLuidShapes,
  formatDiagnosticReport,
  formatLuidShapeReport,
  runHardwareDiagnostic,
  runLuidShapeCheck,
  summarizeRegistry,
  type DiagnosticDeps
} from '../../src/main/hardware/local/diagnostic'

// Diagnóstico manual com dependências SIMULADAS: nenhuma consulta real.

const GiB = 1024 ** 3
const KEY = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
const APP_DATA = 'C:\\Users\\fulano\\AppData\\Roaming'
const reg = (name: string, type: string, entries: Array<[string, string]>) => entries.map(([k, v]) => `${KEY}\\${k}\r\n    ${name}    ${type}    ${v}\r\n`).join('\r\n')
const ok = (commandId: string, stdout: string): CommandResult => ({ kind: 'success', stdout, durationMs: 1, commandId, processExited: true })

const NVIDIA = { vendorId: 0x10de, deviceId: 0x2504, deviceString: 'NVIDIA GeForce RTX 3060', driverVersion: '31.0.15.1234', luid: { high: 0, low: 12345 }, active: true }
const REGISTRY: Record<GpuCommandId, string> = {
  [GPU_COMMAND_IDS.deviceIds]: reg('MatchingDeviceId', 'REG_SZ', [
    ['0000', 'pci\\ven_10de&dev_2504&subsys_397d1462'],
    ['0001', 'root\\basicdisplay']
  ]),
  [GPU_COMMAND_IDS.memorySizes]: reg('HardwareInformation.qwMemorySize', 'REG_QWORD', [['0000', '0x300000000']])
}

function deps(o: Partial<DiagnosticDeps> = {}): DiagnosticDeps {
  return {
    getGPUInfo: async () => ({ auxAttributes: { machineModelName: 'Notebook do fulano' }, gpuDevice: [NVIDIA] }),
    storageTarget: { kind: 'app-data', path: APP_DATA },
    runCommand: async (id) => ok(id, REGISTRY[id]),
    cpu: { cpus: () => Array.from({ length: 12 }, () => ({ model: 'CPU Sintética' })), machine: () => 'x86_64' },
    memory: { totalmem: () => 32 * GiB, freemem: () => 16 * GiB, platform: () => 'win32' },
    os: { platform: () => 'win32', release: () => '10.0.26200', version: () => 'Windows 11 Pro', machine: () => 'x86_64' },
    storage: { statfs: async () => ({ bsize: 4096, blocks: (500 * GiB) / 4096, bavail: (200 * GiB) / 4096 }), platform: 'win32' },
    platform: 'win32',
    ...o
  }
}

describe('diagnóstico manual (dependências simuladas)', () => {
  it('relatório completo: atributos, GPU, Registro, tempos e coerência', async () => {
    const r = await runHardwareDiagnostic(deps())
    assert.equal(r.outcome, 'completed')
    assert.equal(r.confidence, 'medium')
    assert.deepEqual(
      r.attributes.filter((a) => a.quality === 'unavailable').map((a) => [a.field, a.reason]),
      [
        ['cpu.physicalCores', 'requires-system-query'],
        ['acceleration', 'not-probed']
      ]
    )
    assert.deepEqual(r.gpus.map((g) => [g.vendor, g.model, g.vramGb, g.sharedMemory]), [['nvidia', 'NVIDIA GeForce RTX 3060', 12, null]])
    assert.deepEqual(r.storage, { volume: 'C:\\', kind: 'app-data' })
    assert.deepEqual(
      r.registry.map((c) => [c.commandId, c.kind, c.adapterSubkeysWithValue, c.nonPciIds]),
      [
        [GPU_COMMAND_IDS.deviceIds, 'success', 2, 1],
        [GPU_COMMAND_IDS.memorySizes, 'success', 1, null]
      ]
    )
    for (const name of ['os.cpus', 'os.totalmem', 'fs.statfs', "app.getGPUInfo('basic')", `reg ${GPU_COMMAND_IDS.deviceIds}`]) {
      assert.ok(r.timings.some((t) => t.name === name), name)
    }
    assert.ok(r.consistency.every((c) => c.ok === true), JSON.stringify(r.consistency))
    assert.equal(r.gpuInfo?.devices?.[0]?.vendorIdHex, '0x10DE')
    assert.deepEqual(r.gpuInfo?.devices?.[0]?.fields, ['active', 'deviceId', 'deviceString', 'driverVersion', 'luid', 'vendorId'])
  })

  it('relatório e texto não carregam caminhos, identificadores de dispositivo nem valores de campos omitidos', async () => {
    const r = await runHardwareDiagnostic(deps(), { interruptionChecks: { cancelAfterMs: 1, gpuBudgetMs: 1 } })
    const text = JSON.stringify(r) + formatDiagnosticReport(r)
    for (const forbidden of ['fulano', 'Users', 'AppData', '2504', 'dev_', 'ven_', 'subsys', '397d1462', 'HKEY_LOCAL', '31.0.15', '12345', 'Notebook', 'basicdisplay', '0x300000000']) {
      assert.ok(!text.includes(forbidden), forbidden)
    }
  })

  it('forma do getGPUInfo: nomes dos campos e o mínimo necessário', () => {
    const shape = describeGpuInfo({ gpuDevice: [{ vendorId: 0x1414, deviceId: 0x8c }, { vendorId: 0, deviceString: '' }, 'x'], auxAttributes: { a: 1 }, extra: true })
    assert.deepEqual(shape.topLevelKeys, ['auxAttributes', 'extra', 'gpuDevice'])
    assert.deepEqual(shape.auxAttributeKeys, ['a'])
    assert.deepEqual(
      shape.devices!.map((d) => [d.vendorIdHex, d.deviceIdPresent, d.deviceString, d.softwareRenderer]),
      [
        ['0x1414', true, null, true],
        [null, false, null, false],
        [null, false, null, false]
      ]
    )
    assert.equal(describeGpuInfo(null).devices, null)
  })

  it('falha do Registro: só tipo, motivo e código', () => {
    const s = summarizeRegistry({ kind: 'failed', reason: 'exit-code', exitCode: 1, commandId: GPU_COMMAND_IDS.memorySizes, processExited: true }, 42.4)
    assert.deepEqual(s, {
      commandId: GPU_COMMAND_IDS.memorySizes,
      kind: 'failed',
      reason: 'exit-code',
      exitCode: 1,
      processExited: true,
      ms: 42,
      stdoutBytes: null,
      keyHeaders: null,
      adapterSubkeysWithValue: null,
      valueTypes: null,
      nonPciIds: null
    })
  })

  it('verificações de interrupção: cancelamento rejeita; orçamento curto da GPU interrompe a consulta', async () => {
    const slow = (id: GpuCommandId, signal?: AbortSignal) =>
      new Promise<CommandResult>((resolve) => {
        const t = setTimeout(() => resolve(ok(id, REGISTRY[id])), 200)
        signal?.addEventListener('abort', () => (clearTimeout(t), resolve({ kind: 'cancelled', commandId: id, processExited: true })), { once: true })
      })
    const r = await runHardwareDiagnostic(deps({ runCommand: slow }), { interruptionChecks: { cancelAfterMs: 20, gpuBudgetMs: 20 } })
    const [cancel, budget] = r.interruptions
    assert.equal(cancel!.kind, 'cancel')
    assert.equal(cancel!.outcome, 'rejected:cancelled')
    assert.ok(cancel!.commands.every((c) => c.kind === 'cancelled' && c.processExited))
    assert.equal(budget!.kind, 'gpu-budget')
    assert.equal(budget!.outcome, 'completed')
    assert.equal(budget!.gpuRegistry, 'timeout')
  })

  it('interrupção pelo usuário: coleta cancelada e sem verificações extras', async () => {
    const r = await runHardwareDiagnostic(deps(), { signal: AbortSignal.abort(), interruptionChecks: { cancelAfterMs: 1, gpuBudgetMs: 1 } })
    assert.equal(r.outcome, 'cancelled')
    assert.deepEqual(r.attributes, [])
    assert.deepEqual(r.interruptions, [])
  })
})

describe('diagnóstico manual: isolamento', () => {
  const ROOT = join(import.meta.dirname, '../..')
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
  const SCRIPT = 'scripts/diagnostics/hardware-diagnostic.mjs'
  /** Código do script sem comentários (o cabeçalho cita o que o script NÃO faz). */
  const code = () =>
    read(SCRIPT)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('nada no app importa o diagnóstico (Main, Preload, Renderer, shared)', () => {
    const users = [...walk('src/main'), ...walk('src/preload'), ...walk('src/renderer'), ...walk('src/shared')]
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(join('local', 'diagnostic.ts')))
      .filter((f) => /local\/diagnostic|runHardwareDiagnostic/.test(read(f)))
    assert.deepEqual(users, [])
    assert.ok(!/diagnostic/.test(read('package.json')), 'nenhum script npm executa o diagnóstico')
  })

  it('o script Electron só roda com a pasta do supervisor e só consulta com confirmação explícita', () => {
    const src = code()
    // A pasta é conferida antes de tudo; sem ela, sai sem iniciar nada.
    const accept = src.indexOf('const scratch = acceptScratch(')
    const refuse = src.indexOf('if (scratch === null) {')
    // Exatamente uma confirmação (coleta completa, forma do luid ou auxiliar DXCore).
    assert.match(src, /const confirmations = \[CONFIRM, CONFIRM_LUID, CONFIRM_DXCORE\]\.filter\(\(c\) => args\.includes\(c\)\)\.length/)
    const confirm = src.indexOf('} else if (confirmations !== 1 && !args.includes(CHECK_ONLY)) {')
    const run = src.indexOf('} else {', confirm)
    assert.ok(accept > 0 && refuse > accept && confirm > refuse && run > confirm)
    assert.match(src.slice(refuse, confirm), /app\.exit\(3\)/)
    assert.match(src.slice(confirm, run), /app\.exit\(2\)/)
    // setPath, getGPUInfo e a coleta só no último ramo; setPath antes de qualquer outra coisa nele.
    const setPath = src.indexOf("app.setPath('userData', scratch)")
    assert.ok(setPath > run)
    for (const call of ['app.getGPUInfo(type)', 'runHardwareDiagnostic(', 'runLuidShapeCheck(', 'runDxcoreDiagnostic(', 'whenReady']) {
      assert.ok(src.indexOf(call) > setPath, call)
    }
    // O diagnóstico DXCore só é chamado dentro do whenReady (a definição da função fica no fim do arquivo).
    const dxcoreCalls = [...src.matchAll(/(?<!function )runDxcoreDiagnostic\(/g)].map((m) => m.index)
    assert.equal(dxcoreCalls.length, 1)
    assert.ok(dxcoreCalls[0]! > src.indexOf('whenReady') && dxcoreCalls[0]! < src.indexOf('async function runDxcoreDiagnostic('))
    // Toda chamada do carregamento do código (fora a definição da função) vem depois.
    const loads = [...src.matchAll(/(?<!function )loadDiagnostic\(\)/g)].map((m) => m.index)
    assert.ok(loads.length >= 2 && loads.every((i) => i > setPath))
    assert.match(src, /const CONFIRM = '--confirm-real-hardware-read'/)
    assert.match(src, /const CONFIRM_LUID = '--confirm-luid-shape-read'/)
  })

  it('o script Electron não cria nem apaga pastas; a limpeza é só do supervisor, sem varredura por prefixo', () => {
    const src = code()
    assert.doesNotMatch(src, /mkdtemp|rmSync|rmdir|unlink|readdirSync|sweep/)
    const supervisor = read('scripts/diagnostics/run-hardware-diagnostic.mjs')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.match(supervisor, /superviseDiagnostic\(/)
    assert.match(supervisor, /shell: false/)
    assert.doesNotMatch(supervisor, /readdirSync\(tmpdir|rmSync|startsWith\(|sweep/)
    // Plano e confirmações conflitantes são resolvidos sem iniciar o Electron.
    const spawnAt = supervisor.indexOf('superviseDiagnostic(')
    assert.ok(supervisor.indexOf('process.stdout.write(`${PLAN}\\n`)') < spawnAt)
    assert.ok(supervisor.indexOf('process.exitCode = 2') < spawnAt)
    const lifecycle = read('scripts/diagnostics/scratch-lifecycle.ts')
    assert.doesNotMatch(lifecycle, /readdirSync|rmSync|recursive: true|from 'electron'/)
  })

  it('modo luid: só getGPUInfo, e encerra antes da coleta completa', () => {
    const src = code()
    const start = src.indexOf('if (luidOnly) {')
    const end = src.indexOf('return', start)
    assert.ok(start > 0 && end > start && end < src.indexOf('runHardwareDiagnostic('))
    const block = src.slice(start, end)
    assert.match(block, /runLuidShapeCheck\(\(type\) => app\.getGPUInfo\(type\)/)
    assert.doesNotMatch(block, /runHardwareDiagnostic|runCommand|CommandRunner|\breg\b|statfs|storageTarget|interruption/i)
  })

  it('o script não abre dados do app, não grava arquivos além da pasta temporária e não usa a rede', () => {
    const src = code()
    assert.ok(!/hardware\.json|hardware-advisor-service|createServices|BrowserWindow|loadURL|net\.|fetch\(|https?:|writeFile|appendFile|console\./.test(src))
    assert.ok(!/setLocalConsent|grantScope/.test(src))
  })
})

describe('diagnóstico manual: forma do luid (dependências simuladas)', () => {
  const info = (devices: unknown[]) => ({ auxAttributes: { machineModelName: 'Notebook do fulano' }, gpuDevice: devices })
  const device = (luid: unknown, extra: Record<string, unknown> = {}) => ({
    vendorId: 0x10de,
    deviceId: 0x2504,
    subSysId: 0x397d1462,
    deviceString: 'NVIDIA GeForce RTX 3060',
    driverVersion: '31.0.15.1234',
    luid,
    ...extra
  })

  it('objeto: nomes e tipos das propriedades, inteiros seguros, sem valores', () => {
    const shapes = describeLuidShapes(info([device({ high: 7, low: 987654321 }), device({ high: 2 ** 60, low: '0ABC' })]))
    assert.deepEqual(shapes, [
      {
        index: 0,
        vendor: 'nvidia',
        luid: {
          present: true,
          kind: 'object',
          properties: [
            { name: 'high', kind: 'number', safeInteger: true },
            { name: 'low', kind: 'number', safeInteger: true }
          ]
        }
      },
      {
        index: 1,
        vendor: 'nvidia',
        luid: {
          present: true,
          kind: 'object',
          properties: [
            { name: 'high', kind: 'number', safeInteger: false },
            { name: 'low', kind: 'string', length: 4, format: 'hexadecimal' }
          ]
        }
      }
    ])
  })

  it('texto: só comprimento e formato; número: inteiro seguro; ausente e nulo distintos', () => {
    const shapes = describeLuidShapes(
      info([
        device('00000000:0000ABCD'),
        device('123456789'),
        device('luid-x'),
        device(''),
        device(2 ** 40),
        device(2 ** 64),
        device(null),
        { vendorId: 0x8086, deviceId: 0x9a49 },
        device(12n, { vendorId: 0x1414 }),
        device([1, 2], { vendorId: 0x5143 }),
        'x'
      ])
    )!
    assert.deepEqual(
      shapes.map((s) => [s.vendor, s.luid]),
      [
        ['nvidia', { present: true, kind: 'string', length: 17, format: 'hex-pair' }],
        ['nvidia', { present: true, kind: 'string', length: 9, format: 'decimal' }],
        ['nvidia', { present: true, kind: 'string', length: 6, format: 'other' }],
        ['nvidia', { present: true, kind: 'string', length: 0, format: 'empty' }],
        ['nvidia', { present: true, kind: 'number', safeInteger: true }],
        ['nvidia', { present: true, kind: 'number', safeInteger: false }],
        ['nvidia', { present: true, kind: 'null' }],
        ['intel', { present: false, kind: 'undefined' }],
        ['microsoft', { present: true, kind: 'bigint' }],
        ['other', { present: true, kind: 'array' }],
        [null, { present: false, kind: 'undefined' }]
      ]
    )
    assert.equal(describeLuidShapes({ gpuDevice: 'x' }), null)
    assert.equal(describeLuidShapes(null), null)
  })

  it('o relatório não carrega valores do luid, identificadores, driver nem auxAttributes', async () => {
    const r = await runLuidShapeCheck(async () => info([device({ high: 31415, low: 271828 }), device('00000000:0000ABCD')]))
    const text = JSON.stringify(r) + formatLuidShapeReport(r)
    for (const forbidden of ['31415', '271828', 'ABCD', '2504', '9476', '397d1462', '31.0.15', 'RTX', 'GeForce', 'Notebook', 'fulano', 'machineModelName']) {
      assert.ok(!text.includes(forbidden), forbidden)
    }
    assert.match(formatLuidShapeReport(r), /adaptador 0 \(nvidia\): luid presente · object/)
    assert.match(formatLuidShapeReport(r), /\.high: number · inteiro seguro: sim/)
  })

  it('uma única chamada, só com basic, e nenhuma outra fonte', async () => {
    const calls: unknown[] = []
    const r = await runLuidShapeCheck(async (type) => (calls.push(type), info([device({ high: 0, low: 1 })])))
    assert.equal(r.outcome, 'completed')
    assert.deepEqual(calls, ['basic'])
    // A assinatura só aceita getGPUInfo: não há como passar Registro, executor ou outras sondagens.
    assert.equal(runLuidShapeCheck.length, 1)
  })

  it('prazo, cancelamento, erro e resposta inválida: sem dados e sem nova tentativa', async () => {
    let calls = 0
    const never = () => (calls++, new Promise<unknown>(() => undefined))
    assert.equal((await runLuidShapeCheck(never, { timeoutMs: 10 })).outcome, 'timeout')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    assert.equal((await runLuidShapeCheck(never, { signal: controller.signal, timeoutMs: 5_000 })).outcome, 'cancelled')
    assert.equal((await runLuidShapeCheck(never, { signal: AbortSignal.abort() })).outcome, 'cancelled')
    assert.equal(calls, 2)
    const failed = await runLuidShapeCheck(async () => {
      throw new Error('C:\\Users\\fulano\\segredo')
    })
    assert.deepEqual([failed.outcome, failed.error, failed.adapters], ['error', 'Error', []])
    assert.equal((await runLuidShapeCheck(async () => ({ gpuDevice: null }))).outcome, 'invalid-value')
  })
})

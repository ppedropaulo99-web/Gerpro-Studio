import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  DESCRIPTION_REJECT,
  DESCRIPTION_STRIP,
  DXCORE_EXIT_CODES,
  DXCORE_HELPER_ARGS,
  DXCORE_LIMITS,
  DXCORE_PROTOCOL,
  DXCORE_PROTOCOL_VERSION,
  DXCORE_WIRE_ADAPTER_KEYS,
  DXCORE_WIRE_RESPONSE_KEYS,
  LUID_PATTERN,
  LUID_ZERO,
  UINT64_DECIMAL_PATTERN,
  UINT64_MAX,
  VRAM_AGREEMENT,
  type DxcoreWireAdapter,
  type DxcoreWireResponse
} from '../../src/main/hardware/local/dxcore-contract'
import { VRAM_LIMITS } from '../../src/main/hardware/local/probes/gpu'

// Contrato do auxiliar DXCore (D54): só especificação, sem executável nem consulta.

/** Adaptador com o maior tamanho possível em cada campo. */
const WORST_ADAPTER: DxcoreWireAdapter = {
  luid: 'FFFFFFFF:FFFFFFFF',
  vendorId: DXCORE_LIMITS.maxHardwareId,
  deviceId: DXCORE_LIMITS.maxHardwareId,
  // Caracteres fora do ASCII viram escapes \uXXXX (6 bytes cada): o maior tamanho possível.
  description: '\u4e2d'.repeat(DXCORE_LIMITS.maxDescriptionLength),
  isHardware: false,
  isIntegrated: false,
  dedicatedAdapterMemory: UINT64_MAX.toString(),
  dedicatedSystemMemory: UINT64_MAX.toString(),
  sharedSystemMemory: UINT64_MAX.toString()
}

describe('contrato do auxiliar DXCore', () => {
  it('a maior resposta válida cabe no limite de saída, mesmo com indentação', () => {
    const worst: DxcoreWireResponse = {
      protocol: DXCORE_PROTOCOL,
      version: DXCORE_PROTOCOL_VERSION,
      adapters: Array.from({ length: DXCORE_LIMITS.maxAdapters }, () => WORST_ADAPTER)
    }
    const ascii = JSON.stringify(worst, null, 2).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    assert.ok(/^[\x00-\x7f]*$/.test(ascii))
    const bytes = Buffer.byteLength(`${ascii}\r\n`)
    assert.ok(bytes <= DXCORE_LIMITS.maxOutputBytes, `${bytes} bytes`)
  })

  it('as chaves declaradas são exatamente as dos tipos', () => {
    assert.deepEqual(Object.keys(WORST_ADAPTER), [...DXCORE_WIRE_ADAPTER_KEYS])
    assert.equal(new Set(DXCORE_WIRE_ADAPTER_KEYS).size, DXCORE_WIRE_ADAPTER_KEYS.length)
    assert.deepEqual([...DXCORE_WIRE_RESPONSE_KEYS], ['protocol', 'version', 'adapters'])
  })

  it('inteiros de 64 bits: formato decimal exato, sem número JSON', () => {
    assert.equal(UINT64_MAX.toString().length, DXCORE_LIMITS.maxUint64Digits)
    for (const ok of ['0', '4294967296', '18446744073709551615']) assert.match(ok, UINT64_DECIMAL_PATTERN)
    for (const bad of ['', '-1', '01', '1.0', '1e9', ' 1', '0x10', '123456789012345678901']) assert.doesNotMatch(bad, UINT64_DECIMAL_PATTERN)
    // O padrão aceita 20 dígitos; o teto é conferido com UINT64_MAX (99999999999999999999 > UINT64_MAX).
    assert.ok(BigInt('99999999999999999999') > UINT64_MAX)
    // Valores acima de 2^53 perderiam precisão como número JSON.
    assert.ok(UINT64_MAX > BigInt(Number.MAX_SAFE_INTEGER))
  })

  it('LUID: formato canônico; o nulo existe e é tratado como inválido pelas regras', () => {
    for (const ok of ['00000000:0000ABCD', 'FFFFFFFF:FFFFFFFF']) assert.match(ok, LUID_PATTERN)
    for (const bad of ['0000abcd', '0:ABCD', '00000000-0000ABCD', '00000000:0000abcd', ' 00000000:0000ABCD']) assert.doesNotMatch(bad, LUID_PATTERN)
    assert.match(LUID_ZERO, LUID_PATTERN)
  })

  it('identificadores de hardware cabem em números JSON exatos (32 bits, inclusive Qualcomm)', () => {
    assert.ok(Number.isSafeInteger(DXCORE_LIMITS.maxHardwareId))
    assert.ok(0x4d4f4351 <= DXCORE_LIMITS.maxHardwareId)
  })

  it('limites coerentes com o executor e com a VRAM existente', () => {
    // Abaixo dos limites do Registro (5 s, 64 KB) e dentro do orçamento da GPU.
    assert.ok(DXCORE_LIMITS.timeoutMs <= 5_000)
    assert.ok(DXCORE_LIMITS.maxOutputBytes <= 65_536)
    assert.deepEqual([...DXCORE_HELPER_ARGS], ['--protocol', String(DXCORE_PROTOCOL_VERSION)])
    // A VRAM aceita cabe em número exato; a tolerância de concordância é menor que a menor VRAM aceita × 5.
    assert.ok(VRAM_LIMITS.maxBytes <= Number.MAX_SAFE_INTEGER)
    assert.ok(VRAM_AGREEMENT.minBytes > 0n && VRAM_AGREEMENT.relativePercent > 0n && VRAM_AGREEMENT.relativePercent < 100n)
  })

  it('descrição: nomes comerciais passam; caminhos, identificadores e GUIDs viram null', () => {
    const clean = (raw: string) => {
      const text = raw.replace(DESCRIPTION_STRIP, ' ').replace(/\s+/g, ' ').trim()
      return text === '' || DESCRIPTION_REJECT.some((re) => re.test(text)) ? null : text
    }
    for (const ok of ['NVIDIA GeForce RTX 3050 Laptop GPU', 'Intel(R) UHD Graphics', 'AMD Radeon(TM) RX 7900 XTX', 'Qualcomm(R) Adreno(TM) X1-85 GPU', 'Radeon RX 5500/5500M']) {
      assert.equal(clean(ok), ok)
    }
    assert.equal(clean('  NVIDIA\u202e GeForce\u0000\u200b  '), 'NVIDIA GeForce')
    for (const bad of [
      'C:\\Windows\\System32\\DriverStore\\nv.inf',
      'C:/Users/fulano/x',
      '/usr/lib/x',
      'PCI\\VEN_10DE&DEV_25A2',
      'GPU ven_10de dev_25a2',
      'subsys_397d1462',
      'GPU {4d36e968-e325-11ce-bfc1-08002be10318}',
      'GPU 0123456789abcdef',
      ' \u0000 '
    ]) {
      assert.equal(clean(bad), null, bad)
    }
  })

  it('códigos de saída distintos; só `ok` é zero', () => {
    const codes = Object.values(DXCORE_EXIT_CODES)
    assert.equal(new Set(codes).size, codes.length)
    assert.deepEqual(
      Object.entries(DXCORE_EXIT_CODES).filter(([, c]) => c === 0),
      [['ok', 0]]
    )
    assert.ok(codes.every((c) => Number.isInteger(c) && c >= 0 && c <= 255))
  })
})

describe('contrato do auxiliar DXCore: isolamento', () => {
  const ROOT = join(import.meta.dirname, '../..')
  const CONTRACT = join('src', 'main', 'hardware', 'local', 'dxcore-contract.ts')
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))

  it('só tipos e constantes: sem importações, processos, arquivos ou rede', () => {
    const code = read(CONTRACT)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(code, /\bimport\b|\brequire\(|child_process|spawn|node:fs|fetch\(|from 'electron'/)
    assert.doesNotMatch(code, /\bfunction\b|=>/)
  })

  it('o contrato e os módulos DXCore só são usados pelo detector local (6C.5B); catálogo, diagnóstico e serviço não', () => {
    const LOCAL = join('src', 'main', 'hardware', 'local')
    const DXCORE_DIR = join(LOCAL, 'dxcore')
    const HELPER = join(LOCAL, 'bundled-helper.ts')
    const DETECTOR = join(LOCAL, 'local-hardware-detector.ts')
    const ROOT_RESOLVER = join(LOCAL, 'helper-root.ts')
    // Contrato do launcher (6C.6B.2): isolado, só importa o contrato do auxiliar e não é
    // importado por ninguém (conferido em helper-host-sources.test.ts).
    const HOST_CONTRACT = join(LOCAL, 'dxcore-host-contract.ts')
    assert.deepEqual([...read(HOST_CONTRACT).matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1]), ['./dxcore-contract'])
    const app = [...walk('src/main'), ...walk('src/preload'), ...walk('src/renderer'), ...walk('src/shared')].filter((f) => /\.(ts|tsx)$/.test(f) && f !== HOST_CONTRACT)
    // Fora do contrato, do executor e da pasta DXCore, só o detector local fala de DXCore.
    const users = app.filter((f) => f !== CONTRACT && f !== HELPER && !f.startsWith(DXCORE_DIR)).filter((f) => /dxcore/i.test(read(f)))
    assert.deepEqual(users, [DETECTOR])
    // Quem cita o executor: o parser (só o tipo), o detector (só a montagem de produção, com o
    // hash embutido) e a resolução da raiz (só a validação de caminho). Ninguém mais.
    const helperUsers = app.filter((f) => f !== HELPER).filter((f) => /bundled-helper|BundledHelperRunner|createDxcoreHelperRunner/.test(read(f)))
    assert.deepEqual(helperUsers.sort(), [join(DXCORE_DIR, 'parser.ts'), ROOT_RESOLVER, DETECTOR].sort())
    assert.match(read(join(DXCORE_DIR, 'parser.ts')), /^import type \{ HelperRunResult \} from '\.\.\/bundled-helper'$/m)
    assert.match(read(DETECTOR), /^import \{ createDxcoreHelperRunner, type HelperProcessState, type HelperRunResult \} from '\.\/bundled-helper'$/m)
    assert.match(read(ROOT_RESOLVER), /^import \{ isTrustedRoot \} from '\.\/bundled-helper'$/m)
    // O detector não tem como trocar o hash, o executável ou o caminho: nada de executor
    // montado à mão, hash injetado, nem leitura do hash de produção.
    // (Confere o código sem comentários: a documentação pode citar esses nomes.)
    const codeOf = (path: string) =>
      read(path)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
    const detectorCode = codeOf(DETECTOR)
    assert.doesNotMatch(detectorCode, /BundledHelperRunner|expectedSha256|DXCORE_HELPER_SHA256|APPROVED_DXCORE_BUILD/)
    assert.equal([...detectorCode.matchAll(/createDxcoreHelperRunner\(/g)].length, 1)
    // A resolução da raiz não usa ambiente, argumentos nem Electron (o Main passa os valores).
    const resolverCode = codeOf(ROOT_RESOLVER)
    assert.doesNotMatch(resolverCode, /process\.|from 'electron'|ipc|import\(|require\(/i)
    // Ninguém no app chama a resolução da raiz nem o detector ainda (ativação é etapa futura).
    assert.deepEqual(app.filter((f) => f !== ROOT_RESOLVER && /resolveHelperResourcesRoot|helper-root/.test(codeOf(f))), [])
    assert.match(read('src/main/services/index.ts'), /localDetector: new UnimplementedLocalDetector\(\)/)
    // O diagnóstico do app (`diagnostic.ts`) e o catálogo continuam sem DXCore.
    for (const f of [join(LOCAL, 'diagnostic.ts'), join(LOCAL, 'commands.ts')]) assert.doesNotMatch(read(f), /dxcore|bundled-helper/i, f)
    assert.deepEqual(walk('src/main/hardware/local/dxcore').sort(), ['capture.ts', 'parser.ts', 'rules.ts', 'selection.ts'].map((f) => join(DXCORE_DIR, f)))
  })
})

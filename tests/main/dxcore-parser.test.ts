import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HelperRejection, HelperRunResult } from '../../src/main/hardware/local/bundled-helper'
import type { CommandResult } from '../../src/main/hardware/local/command-runner'
import { DXCORE_LIMITS, type DxcoreWireAdapter } from '../../src/main/hardware/local/dxcore-contract'
import { interpretHelperResult, parseDxcoreResponse, parseUint64, sanitizeDescription } from '../../src/main/hardware/local/dxcore/parser'

// Parser do protocolo DXCore 1 com respostas simuladas: nenhum auxiliar é executado.

const GiB = 1024n ** 3n
const adapter = (o: Partial<Record<keyof DxcoreWireAdapter, unknown>> = {}): Record<string, unknown> => ({
  luid: '00000000:0000ABCD',
  vendorId: 0x10de,
  deviceId: 0x25a2,
  description: 'NVIDIA GeForce RTX 3050 Laptop GPU',
  isHardware: true,
  isIntegrated: false,
  dedicatedAdapterMemory: String(4n * GiB),
  dedicatedSystemMemory: '0',
  sharedSystemMemory: String(8n * GiB),
  ...o
})
const response = (adapters: unknown[] = [adapter()], o: Record<string, unknown> = {}) =>
  JSON.stringify({ protocol: 'gerpro.dxcore-adapters', version: 1, adapters, ...o })
const reason = (stdout: string) => {
  const r = parseDxcoreResponse(stdout)
  return r.ok ? 'ok' : r.reason
}

describe('parser DXCore: resposta válida', () => {
  it('converte memórias para bigint, mantém nulls e sanitiza a descrição', () => {
    const r = parseDxcoreResponse(
      response([
        adapter(),
        adapter({
          luid: '00000000:0000BEEF',
          vendorId: 0x8086,
          deviceId: 0x9a49,
          description: 'Intel(R) UHD\u0007 Graphics',
          isIntegrated: true,
          dedicatedAdapterMemory: '134217728',
          sharedSystemMemory: null
        }),
        adapter({ luid: null, vendorId: null, deviceId: null, description: null, isHardware: false, isIntegrated: null, dedicatedAdapterMemory: null, dedicatedSystemMemory: null, sharedSystemMemory: null })
      ]) + '\r\n'
    )
    assert.ok(r.ok)
    assert.deepEqual(r.adapters, [
      {
        luid: '00000000:0000ABCD',
        vendorId: 0x10de,
        deviceId: 0x25a2,
        description: 'NVIDIA GeForce RTX 3050 Laptop GPU',
        isHardware: true,
        isIntegrated: false,
        dedicatedAdapterMemory: 4n * GiB,
        dedicatedSystemMemory: 0n,
        sharedSystemMemory: 8n * GiB
      },
      {
        luid: '00000000:0000BEEF',
        vendorId: 0x8086,
        deviceId: 0x9a49,
        description: 'Intel(R) UHD Graphics',
        isHardware: true,
        isIntegrated: true,
        dedicatedAdapterMemory: 134217728n,
        dedicatedSystemMemory: 0n,
        sharedSystemMemory: null
      },
      {
        luid: null,
        vendorId: null,
        deviceId: null,
        description: null,
        isHardware: false,
        isIntegrated: null,
        dedicatedAdapterMemory: null,
        dedicatedSystemMemory: null,
        sharedSystemMemory: null
      }
    ])
  })

  it('lista vazia, 16 adaptadores, identificador de 32 bits e escapes fora do ASCII', () => {
    assert.equal(reason(response([])), 'ok')
    assert.equal(reason(response(Array.from({ length: 16 }, () => adapter()))), 'ok')
    const r = parseDxcoreResponse(response([adapter({ vendorId: 0x4d4f4351, deviceId: 0xffffffff, description: 'Qualcomm(R) Adreno(TM) GPU \u00e9' })]).replace('é', '\\u00e9'))
    assert.ok(r.ok)
    assert.equal(r.adapters[0]!.vendorId, 0x4d4f4351)
    assert.equal(r.adapters[0]!.deviceId, 0xffffffff)
    assert.equal(r.adapters[0]!.description, 'Qualcomm(R) Adreno(TM) GPU é')
  })
})

describe('parser DXCore: recusa da resposta inteira', () => {
  it('formato do texto: vazio, grande demais, não ASCII, espaços extras, JSON inválido, não objeto', () => {
    assert.equal(reason(''), 'empty-output')
    assert.equal(reason('\n'), 'empty-output')
    assert.equal(reason(' '.repeat(DXCORE_LIMITS.maxOutputBytes + 1)), 'output-too-large')
    assert.equal(reason(response().padEnd(DXCORE_LIMITS.maxOutputBytes + 1, ' ')), 'output-too-large')
    assert.equal(reason(`\ufeff${response()}`), 'non-ascii')
    assert.equal(reason(response([adapter({ description: 'GeForce é' })])), 'non-ascii')
    assert.equal(reason(`${response()}\n\n`), 'not-json')
    assert.equal(reason(` ${response()}`), 'not-json')
    assert.equal(reason('{"protocol":'), 'not-json')
    assert.equal(reason(`${response()}${response()}`), 'not-json')
    for (const v of ['[]', 'null', '1', '"x"']) assert.equal(reason(v), 'not-object', v)
  })

  it('protocolo e versão: conferidos antes do conjunto de chaves', () => {
    assert.equal(reason(response(undefined, { protocol: 'outro' })), 'protocol-mismatch')
    assert.equal(reason(response(undefined, { protocol: 1 })), 'invalid-type')
    assert.equal(reason(response(undefined, { version: 2, extra: true })), 'unsupported-version')
    assert.equal(reason(response(undefined, { version: '1' })), 'invalid-type')
    assert.equal(reason(response(undefined, { version: 1.5 })), 'unsupported-version')
    assert.equal(reason(JSON.stringify({ protocol: 'gerpro.dxcore-adapters', adapters: [] })), 'missing-field')
  })

  it('campos desconhecidos, ausentes ou repetidos (na raiz e no adaptador)', () => {
    assert.equal(reason(response(undefined, { extra: 1 })), 'unknown-field')
    assert.equal(reason(JSON.stringify({ protocol: 'gerpro.dxcore-adapters', version: 1 })), 'missing-field')
    assert.equal(reason(response([{ ...adapter(), driverVersion: '31.0' }])), 'unknown-field')
    assert.equal(reason(response([adapter()]).replace('"isHardware":true', '"__proto__":{},"isHardware":true')), 'unknown-field')
    const { description: _, ...withoutDescription } = adapter()
    assert.equal(reason(response([withoutDescription])), 'missing-field')
    assert.equal(reason(response().replace('"version":1', '"version":1,"version":1')), 'duplicate-field')
    assert.equal(reason(response().replace('"isHardware":true', '"isHardware":false,"isHardware":true')), 'duplicate-field')
    // Texto que parece chave dentro de uma string não é chave.
    assert.equal(reason(response([adapter({ description: 'GPU \\",\\"isHardware\\": x' })])), 'ok')
  })

  it('tipos exatos', () => {
    const cases: Array<[Partial<Record<keyof DxcoreWireAdapter, unknown>>, string]> = [
      [{ luid: 12345 }, 'invalid-type'],
      [{ vendorId: '4318' }, 'invalid-type'],
      [{ isHardware: 'true' }, 'invalid-type'],
      [{ isIntegrated: 0 }, 'invalid-type'],
      [{ description: 42 }, 'invalid-type'],
      // Memória como número JSON é recusada mesmo quando pequena.
      [{ dedicatedAdapterMemory: 4294967296 }, 'invalid-type'],
      [{ sharedSystemMemory: 0 }, 'invalid-type']
    ]
    for (const [o, expected] of cases) assert.equal(reason(response([adapter(o)])), expected, JSON.stringify(o))
    assert.equal(reason(response([null])), 'invalid-type')
    assert.equal(reason(response([[adapter()]])), 'invalid-type')
    assert.equal(reason(response(undefined, { adapters: {} })), 'invalid-type')
  })

  it('limites: adaptadores, identificadores, LUID e descrição', () => {
    assert.equal(reason(response(Array.from({ length: 17 }, () => adapter()))), 'too-many-adapters')
    for (const id of [-1, 1.5, 0x1_0000_0000]) assert.equal(reason(response([adapter({ deviceId: id })])), 'invalid-hardware-id', String(id))
    for (const luid of ['0000abcd', '00000000:0000abcd', '00000000-0000ABCD', '0:ABCD', '00000000:0000ABCDE']) {
      assert.equal(reason(response([adapter({ luid })])), 'invalid-luid', luid)
    }
    assert.equal(reason(response([adapter({ description: 'x'.repeat(DXCORE_LIMITS.maxDescriptionLength) })])), 'ok')
    assert.equal(reason(response([adapter({ description: 'x'.repeat(DXCORE_LIMITS.maxDescriptionLength + 1) })])), 'invalid-description')
  })

  it('inteiros de 64 bits: só decimal exato até 2^64−1', () => {
    for (const ok of ['0', '1', '9007199254740993', '18446744073709551615']) assert.equal(reason(response([adapter({ dedicatedAdapterMemory: ok })])), 'ok', ok)
    for (const bad of ['', '01', '-1', '+1', '1e3', '1.0', '0x10', ' 1', '18446744073709551616', '99999999999999999999', '123456789012345678901']) {
      assert.equal(reason(response([adapter({ dedicatedAdapterMemory: bad })])), 'invalid-uint64', bad)
    }
    // Precisão: acima de 2^53, o valor sai exato (número JavaScript arredondaria).
    assert.equal(parseUint64('9007199254740993'), 9007199254740993n)
    assert.equal(parseUint64('18446744073709551615'), 2n ** 64n - 1n)
    assert.equal(parseUint64('18446744073709551616'), null)
  })

  it('nada é aproveitado parcialmente: um adaptador inválido recusa todos', () => {
    const r = parseDxcoreResponse(response([adapter(), adapter({ luid: '00000000:0000BEEF' }), adapter({ dedicatedAdapterMemory: '-5' })]))
    assert.deepEqual(r, { ok: false, reason: 'invalid-uint64' })
  })
})

describe('parser DXCore: descrição comercial', () => {
  it('sanitização: controles, invisíveis, direção de texto e substitutos isolados', () => {
    assert.equal(sanitizeDescription('  NVIDIA\u202e GeForce\u0000\u200b  RTX\ufeff '), 'NVIDIA GeForce RTX')
    assert.equal(sanitizeDescription('GPU \ud800 X'), 'GPU X')
    assert.equal(sanitizeDescription('\u0000\u200b \u00a0'), null)
    // Escapes no JSON bruto (não na string JavaScript): substituto isolado e controle.
    const r = parseDxcoreResponse(response([adapter({ description: 'GPU @@ X' })]).replace('@@', '\\ud800\\u0007'))
    assert.ok(r.ok)
    assert.equal(r.adapters[0]!.description, 'GPU X')
  })

  it('malformada (caminho, identificador, GUID, hexadecimal longo): vira null sem recusar a resposta', () => {
    for (const bad of [
      'C:\\Windows\\System32\\DriverStore\\nv.inf',
      'C:/Users/fulano/gpu',
      '/opt/gpu',
      'PCI\\VEN_10DE&DEV_25A2',
      'GPU ven_10de dev_25a2',
      'GPU subsys_397d1462',
      'GPU {4d36e968-e325-11ce-bfc1-08002be10318}',
      'GPU 0123456789abcdef'
    ]) {
      const r = parseDxcoreResponse(response([adapter({ description: bad })]))
      assert.ok(r.ok, bad)
      assert.equal(r.adapters[0]!.description, null, bad)
    }
    assert.equal(sanitizeDescription('AMD Radeon(TM) RX 5500/5500M'), 'AMD Radeon(TM) RX 5500/5500M')
  })
})

describe('resultado do executor → situação da fonte', () => {
  const base = { commandId: 'gpu.dxcore-adapters', processExited: true }
  const failed = (reason: 'exit-code' | 'output-limit' | 'unknown-command' | 'spawn-error', exitCode: number | null): CommandResult => ({ ...base, kind: 'failed', reason, exitCode })

  it('sucesso válido ou inválido; a saída nunca é guardada', () => {
    const ok = interpretHelperResult({ ...base, kind: 'success', stdout: response(), durationMs: 1 })
    assert.equal(ok.status, 'ok')
    const bad = interpretHelperResult({ ...base, kind: 'success', stdout: '{"segredo":"C:\\\\Users\\\\fulano"}', durationMs: 1 })
    assert.deepEqual(bad, { status: 'invalid-output', parseError: 'missing-field' })
    assert.ok(!JSON.stringify(bad).includes('fulano'))
  })

  it('códigos de saída definidos, falha do processo e indisponibilidade', () => {
    const cases: Array<[HelperRunResult, string]> = [
      [failed('exit-code', 10), 'dxcore-unavailable'],
      [failed('exit-code', 11), 'factory-failed'],
      [failed('exit-code', 12), 'enumeration-failed'],
      [failed('exit-code', 13), 'output-failed'],
      [failed('exit-code', 64), 'usage'],
      [failed('exit-code', 1), 'crashed'],
      [failed('exit-code', 3221225477), 'crashed'],
      [failed('exit-code', null), 'crashed'],
      [failed('output-limit', null), 'output-limit'],
      [failed('unknown-command', null), 'helper-unavailable'],
      [failed('spawn-error', null), 'helper-unavailable'],
      [{ ...base, kind: 'unavailable', reason: 'not-found' }, 'helper-unavailable'],
      [{ ...base, kind: 'timeout', durationMs: 3000 }, 'timeout'],
      [{ ...base, kind: 'cancelled' }, 'cancelled']
    ]
    for (const [result, status] of cases) assert.deepEqual(interpretHelperResult(result), { status }, JSON.stringify(result))
  })

  it('executável recusado pelo executor (identidade ou integridade): só o código, sem o motivo nem o caminho', () => {
    const reasons: HelperRejection[] = ['unsupported-arch', 'location-invalid', 'not-regular-file', 'symlink', 'redirected', 'size-invalid', 'integrity-unknown', 'integrity-mismatch', 'integrity-changed', 'io-error']
    for (const reason of reasons) {
      const result: HelperRunResult = { ...base, kind: 'rejected', reason }
      assert.deepEqual(interpretHelperResult(result), { status: 'helper-rejected' }, reason)
    }
  })
})

describe('parser DXCore: entradas adversariais', () => {
  const SECRET = 'fulano'
  /** Recusa controlada: só `{ ok: false, reason }`, sem nada da entrada. */
  const rejected = (stdout: string, expected: string, label = expected) => {
    const r = parseDxcoreResponse(stdout)
    assert.deepEqual(r, { ok: false, reason: expected }, label)
    assert.ok(!JSON.stringify(r).includes(SECRET), label)
  }
  const accepted = (stdout: string, label: string) => {
    const r = parseDxcoreResponse(stdout)
    assert.ok(r.ok, `${label}: ${r.ok ? '' : r.reason}`)
    return r.adapters
  }
  /** Troca um trecho do texto JSON (a troca tem de existir). */
  const patch = (json: string, from: string, to: string) => {
    assert.ok(json.includes(from), from)
    return json.replace(from, () => to)
  }
  const withSecret = () => adapter({ description: `C:\\Users\\${SECRET}\\gpu` })

  it('chaves repetidas aninhadas, inclusive dentro de campo desconhecido e de valor com tipo errado', () => {
    rejected(patch(response(undefined, { x: 1 }), '"x":1', '"x":{"a":{"k":1,"k":2}}'), 'duplicate-field')
    rejected(patch(response([adapter({ description: null })]), '"description":null', '"description":{"a":1,"a":2}'), 'duplicate-field')
    rejected(patch(response([withSecret(), adapter()]), '"isHardware":true', '"isHardware":true,"isHardware":true'), 'duplicate-field')
    // A mesma chave em níveis ou objetos diferentes não é repetição.
    rejected(response(undefined, { x: { protocol: 1, version: 1 } }), 'unknown-field')
    assert.equal(accepted(response([adapter(), adapter()]), 'irmãos').length, 2)
  })

  it('chave escrita com escape é a mesma chave', () => {
    const escaped = String.raw`"\u006cuid"`
    assert.equal(accepted(patch(response(), '"luid"', escaped), 'escape único')[0]!.luid, '00000000:0000ABCD')
    rejected(patch(response(), '"luid"', `${escaped}:null,"luid"`), 'duplicate-field')
    rejected(patch(response(), '"version":1', String.raw`"version":1,"\u0076ersion":1`), 'duplicate-field')
  })

  it('texto com cara de JSON dentro de strings não muda a estrutura', () => {
    for (const description of ['{"protocol":"x","version":2}', '"],"adapters":[{', '"luid":"00000000:0000BEEF"', '}}]}{[', ':"isHardware":false,']) {
      const adapters = accepted(response([adapter({ description })]), description)
      assert.equal(adapters.length, 1, description)
      assert.equal(adapters[0]!.isHardware, true, description)
      assert.equal(adapters[0]!.luid, '00000000:0000ABCD', description)
    }
  })

  it('barras invertidas e escapes: aspas escapadas, barra no fim da string, escape inválido', () => {
    for (const description of ['GPU \\" x', 'GPU \\\\', 'GPU\\', '\\"', 'A/B \\/ C']) {
      const adapters = accepted(response([adapter({ description, isHardware: false })]), description)
      assert.equal(adapters.length, 1, description)
      assert.equal(adapters[0]!.isHardware, false, description)
    }
    assert.equal(accepted(patch(response(), '"NVIDIA GeForce RTX 3050 Laptop GPU"', String.raw`"A\/B"`), 'barra escapada')[0]!.description, 'A/B')
    rejected(patch(response([withSecret()]), '"luid":"', String.raw`"luid":"\x41`), 'not-json', 'escape inválido')
    rejected(patch(response([withSecret()]), '"00000000:0000ABCD"', String.raw`"\u12"`), 'not-json', 'escape unicode incompleto')
  })

  it('unicode escapado: controles e invisíveis removidos da descrição; equivalentes ASCII aceitos; fora do formato recusado', () => {
    const description = String.raw`"\u0000\u0007GPU\u200b X\u202e\ud800\u2028"`
    const d = accepted(patch(response(), '"NVIDIA GeForce RTX 3050 Laptop GPU"', description), 'descrição')[0]!.description
    assert.equal(d, 'GPU X')
    // Escape de caractere ASCII decodifica para o mesmo texto: mesmo valor.
    assert.equal(accepted(patch(response(), '"00000000:0000ABCD"', String.raw`"\u0030\u0030000000:0000ABCD"`), 'luid')[0]!.luid, '00000000:0000ABCD')
    rejected(patch(response(), '"00000000:0000ABCD"', String.raw`"00000000:0000ABC\u0000"`), 'invalid-luid')
    rejected(patch(response(), '"00000000:0000ABCD"', String.raw`"00000000:0000ABC\uff24"`), 'invalid-luid')
    rejected(patch(response(), '"dedicatedSystemMemory":"0"', String.raw`"dedicatedSystemMemory":"\uff10"`), 'invalid-uint64')
    rejected(patch(response(), '"protocol":"gerpro.dxcore-adapters"', String.raw`"protocol":"gerpro.dxcore-adapters\u0000"`), 'protocol-mismatch')
  })

  it('JSON truncado em qualquer ponto: sempre recusado', () => {
    const full = response([withSecret(), adapter({ luid: '00000000:0000BEEF' })])
    for (let n = 0; n < full.length; n++) {
      const r = parseDxcoreResponse(full.slice(0, n))
      assert.ok(!r.ok, String(n))
      assert.ok(r.reason === 'not-json' || r.reason === 'empty-output', `${n}: ${r.reason}`)
      assert.ok(!JSON.stringify(r).includes(SECRET))
    }
  })

  it('profundidade excessiva dentro do limite de tamanho: recusa controlada, sem esgotar a pilha', () => {
    const arrays = (n: number) => '['.repeat(n) + ']'.repeat(n)
    const objects = (n: number) => '{"a":'.repeat(n) + '1' + '}'.repeat(n)
    const deepest = arrays(32_000)
    assert.ok(Buffer.byteLength(response(undefined, { x: 1 }).replace('1', deepest)) <= DXCORE_LIMITS.maxOutputBytes)
    assert.doesNotThrow(() => parseDxcoreResponse(patch(response(), '"version":1', `"version":1,"x":${deepest}`)))
    rejected(patch(response(), '"version":1', `"version":1,"x":${deepest}`), 'unknown-field')
    rejected(patch(response([withSecret()]), '"adapters":[', `"adapters":[${arrays(30_000)},`), 'invalid-type')
    rejected(patch(response([withSecret()]), '"luid":"00000000:0000ABCD"', `"luid":${arrays(30_000)}`), 'invalid-type')
    rejected(patch(response(), '"version":1', `"version":1,"x":${objects(10_000)}`), 'unknown-field')
    rejected(patch(response(), '"version":1', `"version":1,"x":${arrays(40_000)}`), 'output-too-large')
  })

  it('campos extras: na raiz, no adaptador e chaves especiais do JavaScript, sem poluir protótipos', () => {
    rejected(response([withSecret()], { extra: 1 }), 'unknown-field')
    rejected(response([{ ...withSecret(), extra: null }]), 'unknown-field')
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
      rejected(patch(response(), '"version":1', `"version":1,"${key}":{"polluted":true}`), 'unknown-field', key)
      rejected(patch(response(), '"isHardware":true', `"isHardware":true,"${key}":{"polluted":true}`), 'unknown-field', key)
    }
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined)
  })

  it('números extremos ou fora da forma canônica: recusados (o JSON.parse os normalizaria ou arredondaria)', () => {
    const vendor = (text: string) => patch(response([withSecret()]), '"vendorId":4318', `"vendorId":${text}`)
    for (const text of ['1e308', '1e400', '-1e400', '99999999999999999999999', '4294967296', '-1']) rejected(vendor(text), 'invalid-hardware-id', text)
    // Valor inteiro válido depois do JSON.parse, mas escrito fora da forma do protocolo.
    for (const text of ['-0', '4318.0', '4.318e3', '4318E0', '4318.0000000000000001', '43180e-1']) rejected(vendor(text), 'invalid-type', text)
    for (const text of ['1.0', '1e0', '10e-1']) rejected(patch(response(), '"version":1', `"version":${text}`), 'invalid-type', text)
    assert.equal(accepted(vendor('0'), '0')[0]!.vendorId, 0)
    assert.equal(accepted(vendor('4294967295'), 'máximo')[0]!.vendorId, 0xffff_ffff)
  })

  it('saída perto do limite: 64 KiB exatos aceitos (com ou sem quebra final), um byte a mais recusado', () => {
    const base = response([withSecret()])
    // Espaço entre tokens é JSON válido; só nas pontas é recusado.
    const padded = (total: number) => base.replace('{', '{' + ' '.repeat(total - base.length))
    assert.equal(Buffer.byteLength(padded(DXCORE_LIMITS.maxOutputBytes)), 65_536)
    accepted(padded(DXCORE_LIMITS.maxOutputBytes), '65536')
    accepted(padded(DXCORE_LIMITS.maxOutputBytes - 1) + '\n', '65535 + \\n')
    rejected(padded(DXCORE_LIMITS.maxOutputBytes + 1), 'output-too-large')
    rejected(padded(DXCORE_LIMITS.maxOutputBytes) + '\n', 'output-too-large', '65536 + \\n')
    // Tamanho em bytes, não em caracteres.
    rejected('é'.repeat(32_769), 'output-too-large', 'multibyte')
  })

  it('resposta válida seguida de conteúdo extra: recusada inteira', () => {
    const valid = response([withSecret()])
    for (const extra of ['\n{}', '\n' + valid, valid, ' ', '\t', '\u0000', 'x', '\n\n', '\r\n\r\n', '\n ', ']', '}', ',']) {
      const r = parseDxcoreResponse(valid + extra)
      assert.ok(!r.ok, JSON.stringify(extra))
      assert.deepEqual(Object.keys(r).sort(), ['ok', 'reason'])
      assert.ok(!JSON.stringify(r).includes(SECRET))
    }
    accepted(valid + '\r\n', 'CRLF final')
  })
})

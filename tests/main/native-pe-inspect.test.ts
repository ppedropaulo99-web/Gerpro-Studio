import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  checkHelperBinary,
  checkHostBinary,
  checkSyntheticBinary,
  checkVariantIdentity,
  LAUNCHER_IDENTITY,
  HELPER_FORBIDDEN_FUNCTIONS,
  HELPER_SIZE,
  HOST_ALLOWED_FUNCTIONS,
  HOST_FORBIDDEN_FUNCTIONS,
  HOST_REQUIRED_FUNCTIONS,
  inspectPe,
  parseSupportedOs,
  SUPPORTED_OS_WINDOWS_10,
  SYNTHETIC_ALLOWED_FUNCTIONS,
  SYNTHETIC_FORBIDDEN_FUNCTIONS,
  type HelperBinaryIssue
} from '../../scripts/native/pe-inspect'

// Conferência do binário do auxiliar com executáveis PE SINTÉTICOS montados
// aqui, byte a byte: nenhum executável real é lido nem executado.

interface PeOptions {
  machine?: number
  magic?: number
  subsystem?: number
  characteristics?: number
  dllCharacteristics?: number
  imports?: string[]
  /** Funções importadas de cada DLL de `imports` (mesma ordem); `#n` = ordinal. */
  importFunctions?: string[][]
  cetFlags?: number | null
  dependentLoadFlags?: number
  guardFlags?: number
  /** Texto do recurso RT_MANIFEST; `null`: sem recurso. */
  manifest?: string | null
  embedded?: Buffer
  size?: number
}

/** Manifesto como o link.exe grava com `/MANIFESTUAC:level='asInvoker' uiAccess='false'`. */
const AS_INVOKER_MANIFEST =
  "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\r\n<assembly xmlns='urn:schemas-microsoft-com:asm.v1' manifestVersion='1.0'>\r\n  <trustInfo xmlns=\"urn:schemas-microsoft-com:asm.v3\">\r\n    <security>\r\n      <requestedPrivileges>\r\n        <requestedExecutionLevel level='asInvoker' uiAccess='false' />\r\n      </requestedPrivileges>\r\n    </security>\r\n  </trustInfo>\r\n</assembly>\r\n"

const CONFORMING = { highEntropyVa: 0x20, dynamicBase: 0x40, nxCompat: 0x100, guardCf: 0x4000, terminalServerAware: 0x8000 }
const GOOD_DLL_CHARACTERISTICS = Object.values(CONFORMING).reduce((a, b) => a | b, 0)

/**
 * PE32+ mínimo: cabeçalhos, uma seção (RVA 0x1000 ↔ arquivo 0x400) com
 * importações, diretório de depuração (características estendidas) e
 * configuração de carga.
 */
function syntheticPe(o: PeOptions = {}): Buffer {
  const size = Math.max(o.size ?? 0x2000, 0x2000)
  const b = Buffer.alloc(size)
  const pe = 0x80
  const optional = pe + 24
  const optionalSize = 112 + 16 * 8
  const sectionRaw = 0x400
  const rva = (r: number) => sectionRaw + (r - 0x1000)

  b.write('MZ', 0, 'latin1')
  b.writeUInt32LE(pe, 0x3c)
  b.write('PE\0\0', pe, 'latin1')
  b.writeUInt16LE(o.machine ?? 0x8664, pe + 4)
  b.writeUInt16LE(1, pe + 6)
  b.writeUInt16LE(optionalSize, pe + 20)
  b.writeUInt16LE(o.characteristics ?? 0x0022, pe + 22)
  b.writeUInt16LE(o.magic ?? 0x20b, optional)
  b.writeUInt16LE(o.subsystem ?? 3, optional + 68)
  b.writeUInt16LE(o.dllCharacteristics ?? GOOD_DLL_CHARACTERISTICS, optional + 70)
  b.writeUInt32LE(16, optional + 108)
  const dir = (index: number, r: number, s: number) => {
    b.writeUInt32LE(r, optional + 112 + index * 8)
    b.writeUInt32LE(s, optional + 116 + index * 8)
  }

  const section = optional + optionalSize
  b.write('.data', section, 'latin1')
  b.writeUInt32LE(0x1000, section + 8)
  b.writeUInt32LE(0x1000, section + 12)
  b.writeUInt32LE(0x1000, section + 16)
  b.writeUInt32LE(sectionRaw, section + 20)

  // Importações: descritores em 0x1000, nomes a partir de 0x1100. Funções
  // nomeadas (opcionais): tabelas de 64 bits a partir de 0x1A00 (depois do
  // manifesto, em 0x1700), um bloco de
  // 0x100 por DLL (até 3 DLLs com até 31 funções), e entradas hint/nome a partir de 0x1D00.
  const imports = o.imports ?? ['KERNEL32.dll']
  let hintName = 0x1d00
  imports.forEach((name, i) => {
    const nameRva = 0x1100 + i * 0x20
    const functions = o.importFunctions?.[i]
    const thunk = functions ? 0x1a00 + i * 0x100 : 0x1080
    b.writeUInt32LE(thunk, rva(0x1000) + i * 20)
    b.writeUInt32LE(nameRva, rva(0x1000) + i * 20 + 12)
    b.writeUInt32LE(thunk, rva(0x1000) + i * 20 + 16)
    b.write(`${name}\0`, rva(nameRva), 'latin1')
    functions?.forEach((fn, j) => {
      if (fn.startsWith('#')) {
        b.writeUInt32LE(Number(fn.slice(1)), rva(thunk) + j * 8)
        b.writeUInt32LE(0x8000_0000, rva(thunk) + j * 8 + 4)
        return
      }
      b.writeUInt32LE(hintName, rva(thunk) + j * 8)
      b.write(`\0\0${fn}\0`, rva(hintName), 'latin1')
      hintName += fn.length + 3 + ((fn.length + 3) % 2)
    })
  })
  if (imports.length > 0) dir(1, 0x1000, (imports.length + 1) * 20)

  // Depuração: uma entrada de características estendidas apontando para 0x1300.
  if (o.cetFlags !== null) {
    const entry = rva(0x1200)
    b.writeUInt32LE(20, entry + 12)
    b.writeUInt32LE(4, entry + 16)
    b.writeUInt32LE(0x1300, entry + 20)
    b.writeUInt32LE(rva(0x1300), entry + 24)
    b.writeUInt32LE(o.cetFlags ?? 0x01, rva(0x1300))
    dir(6, 0x1200, 28)
  }

  // Configuração de carga (IMAGE_LOAD_CONFIG_DIRECTORY64) em 0x1400.
  const config = rva(0x1400)
  b.writeUInt32LE(0x140, config)
  b.writeUInt16LE(o.dependentLoadFlags ?? 0x800, config + 0x4e)
  b.writeUInt32LE(o.guardFlags ?? 0x10500, config + 0x90)
  dir(10, 0x1400, 0x140)

  // Recursos em 0x1600: tipo 24 → nome 1 → idioma 0x409 → dados em 0x1700.
  const manifest = o.manifest === undefined ? AS_INVOKER_MANIFEST : o.manifest
  if (manifest !== null) {
    const root = rva(0x1600)
    const directoryWithOne = (at: number, id: number, target: number) => {
      b.writeUInt16LE(1, at + 14)
      b.writeUInt32LE(id, at + 16)
      b.writeUInt32LE(target, at + 20)
    }
    directoryWithOne(root, 24, 0x8000_0000 + 0x18)
    directoryWithOne(root + 0x18, 1, 0x8000_0000 + 0x30)
    directoryWithOne(root + 0x30, 0x409, 0x48)
    const text = Buffer.from(manifest, 'utf8')
    b.writeUInt32LE(0x1700, root + 0x48)
    b.writeUInt32LE(text.length, root + 0x4c)
    text.copy(b, rva(0x1700))
    dir(2, 0x1600, 0x100)
  }

  if (o.embedded) o.embedded.copy(b, size - o.embedded.length - 16)
  return b
}

const issues = (o: PeOptions = {}, forbidden: string[] = []) => checkHelperBinary(syntheticPe(o), forbidden).issues

describe('inspeção de PE: binário conforme', () => {
  it('x64, console, proteções, CET, carga só da System32 e só KERNEL32: nenhuma pendência', () => {
    const { issues: found, report } = checkHelperBinary(syntheticPe(), ['C:\\Gerpro Studio'])
    assert.deepEqual(found, [])
    assert.deepEqual(report?.imports, ['KERNEL32.dll'])
    assert.equal(report?.cetCompat, true)
    assert.equal(report?.dependentLoadFlags, 0x800)
    assert.equal(report?.machine, 0x8664)
    assert.deepEqual(report?.manifest, { executionLevel: 'asInvoker', uiAccess: 'false' })
  })

  it('manifesto com aspas duplas e prefixo de namespace também é lido', () => {
    const manifest = '<assembly><v3:trustInfo><v3:requestedExecutionLevel level="asInvoker" uiAccess="false"/></v3:trustInfo></assembly>'
    assert.deepEqual(checkHelperBinary(syntheticPe({ manifest })).issues, [])
  })
})

describe('inspeção de PE: cada desvio é apontado', () => {
  const cases: Array<[string, PeOptions, HelperBinaryIssue[]]> = [
    ['ARM64', { machine: 0xaa64 }, ['not-x64']],
    ['x86', { machine: 0x14c }, ['not-x64']],
    ['janela em vez de console', { subsystem: 2 }, ['not-console']],
    ['DLL', { characteristics: 0x2022 }, ['is-dll']],
    ['não executável', { characteristics: 0x0020 }, ['not-executable']],
    ['sem ASLR', { dllCharacteristics: GOOD_DLL_CHARACTERISTICS & ~CONFORMING.dynamicBase }, ['no-dynamic-base']],
    ['sem ASLR de 64 bits', { dllCharacteristics: GOOD_DLL_CHARACTERISTICS & ~CONFORMING.highEntropyVa }, ['no-high-entropy-va']],
    ['sem DEP', { dllCharacteristics: GOOD_DLL_CHARACTERISTICS & ~CONFORMING.nxCompat }, ['no-nx-compat']],
    ['sem CFG', { dllCharacteristics: GOOD_DLL_CHARACTERISTICS & ~CONFORMING.guardCf }, ['no-guard-cf']],
    ['CFG não instrumentado', { guardFlags: 0x10000 }, ['guard-cf-not-instrumented']],
    ['sem CET', { cetFlags: 0 }, ['no-cet-compat']],
    ['sem entrada de CET', { cetFlags: null }, ['no-cet-compat']],
    ['busca de DLL padrão', { dependentLoadFlags: 0 }, ['dependent-load-flags']],
    ['busca de DLL com outras pastas', { dependentLoadFlags: 0x800 | 0x200 }, ['dependent-load-flags']],
    ['importa dxcore.dll', { imports: ['KERNEL32.dll', 'dxcore.dll'] }, ['unexpected-import']],
    ['importa CRT dinâmico', { imports: ['KERNEL32.dll', 'VCRUNTIME140.dll'] }, ['unexpected-import']],
    ['sem KERNEL32', { imports: ['USER32.dll'] }, ['unexpected-import', 'missing-kernel32']],
    ['sem manifesto', { manifest: null }, ['manifest-missing']],
    ['pede administrador', { manifest: AS_INVOKER_MANIFEST.replace("level='asInvoker'", "level='requireAdministrator'") }, ['manifest-not-as-invoker']],
    ['nível mais alto disponível', { manifest: AS_INVOKER_MANIFEST.replace("level='asInvoker'", 'level="highestAvailable"') }, ['manifest-not-as-invoker']],
    ['uiAccess verdadeiro', { manifest: AS_INVOKER_MANIFEST.replace("uiAccess='false'", "uiAccess='true'") }, ['manifest-not-as-invoker']],
    ['manifesto sem nível de execução', { manifest: "<assembly xmlns='urn:schemas-microsoft-com:asm.v1' manifestVersion='1.0'/>" }, ['manifest-not-as-invoker']],
    [
      'PE32 (32 bits)',
      { magic: 0x10b },
      ['not-pe32-plus', 'not-console', 'no-dynamic-base', 'no-high-entropy-va', 'no-nx-compat', 'no-guard-cf', 'guard-cf-not-instrumented', 'no-cet-compat', 'dependent-load-flags', 'missing-kernel32', 'manifest-missing']
    ]
  ]
  for (const [label, options, expected] of cases) {
    it(label, () => assert.deepEqual(issues(options), expected))
  }

  it('maiúsculas no nome da DLL não importam', () => {
    assert.deepEqual(issues({ imports: ['kernel32.DLL'] }), [])
  })

  it('caminho da pasta do projeto ou do usuário embutido, em ASCII ou UTF-16', () => {
    const path = 'C:\\Users\\fulano\\Gerpro'
    assert.deepEqual(issues({ embedded: Buffer.from(path, 'latin1') }, [path]), ['embedded-path'])
    assert.deepEqual(issues({ embedded: Buffer.from(path.toUpperCase(), 'utf16le') }, [path]), ['embedded-path'])
    assert.deepEqual(issues({ embedded: Buffer.from('outro texto', 'latin1') }, [path]), [])
  })

  it('tamanho fora da faixa do executor', () => {
    assert.deepEqual(issues({ size: HELPER_SIZE.max + 1 }), ['size-out-of-range'])
    assert.deepEqual(checkHelperBinary(syntheticPe().subarray(0, HELPER_SIZE.min - 1)).issues[0], 'size-out-of-range')
  })
})

describe('inspeção de PE: entradas inválidas nunca lançam exceção', () => {
  it('não PE, truncado, RVA fora das seções', () => {
    assert.deepEqual(inspectPe(Buffer.from('not a pe file at all, just text....................................')), { ok: false, reason: 'not-pe' })
    assert.deepEqual(inspectPe(Buffer.alloc(0)), { ok: false, reason: 'not-pe' })
    const good = syntheticPe()
    for (const cut of [0x40, 0x84, 0x100, 0x200, 0x420, 0x500]) {
      const r = inspectPe(good.subarray(0, cut))
      assert.equal(r.ok, false, String(cut))
    }
    const badRva = syntheticPe()
    badRva.writeUInt32LE(0x9000, 0x400 + 12)
    assert.deepEqual(inspectPe(badRva), { ok: false, reason: 'malformed' })
    const hugeLfanew = syntheticPe()
    hugeLfanew.writeUInt32LE(0xffff_fff0, 0x3c)
    assert.deepEqual(inspectPe(hugeLfanew), { ok: false, reason: 'not-pe' })
  })

  it('bytes alterados ao acaso (semente fixa): sempre um resultado, nunca exceção', () => {
    let seed = 0x5eed
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }
    const base = syntheticPe()
    for (let round = 0; round < 500; round++) {
      const b = Buffer.from(base)
      for (let k = 0; k < 8; k++) b[random() % 0x1500] = random() & 0xff
      assert.doesNotThrow(() => checkHelperBinary(b))
    }
  })
})

describe('inspeção de PE: funções importadas', () => {
  it('lê os nomes (e ordinais) por DLL, a partir da tabela de nomes', () => {
    const report = inspectPe(syntheticPe({ imports: ['KERNEL32.dll', 'bcrypt.dll'], importFunctions: [['GetStdHandle', 'WriteFile'], ['BCryptHashData', '#7']] }))
    assert.equal(report.ok, true)
    assert.deepEqual(report.ok && report.report.importFunctions, { 'kernel32.dll': ['GetStdHandle', 'WriteFile'], 'bcrypt.dll': ['BCryptHashData', '#7'] })
  })

  it('auxiliar: importar criação de processo, de job ou acesso a outro processo é recusado', () => {
    for (const fn of HELPER_FORBIDDEN_FUNCTIONS) {
      assert.deepEqual(issues({ importFunctions: [['GetStdHandle', fn]] }), ['forbidden-function'], fn)
    }
    assert.deepEqual(issues({ importFunctions: [['GetStdHandle', 'TerminateProcess', 'WriteFile']] }), [])
  })

  it('supportedOS do manifesto', () => {
    assert.deepEqual(parseSupportedOs(`<compatibility><application><supportedOS Id="{${SUPPORTED_OS_WINDOWS_10.toUpperCase()}}"/></application></compatibility>`), [SUPPORTED_OS_WINDOWS_10])
    assert.deepEqual(parseSupportedOs("<ms:supportedOS Id='{35138b9a-5d96-4fbd-8e2d-a2440225f93a}'/>"), ['35138b9a-5d96-4fbd-8e2d-a2440225f93a'])
    assert.deepEqual(parseSupportedOs('<assembly/>'), [])
  })
})

describe('inspeção de PE: política do launcher (gerpro-helper-host.exe)', () => {
  const HOST_MANIFEST = AS_INVOKER_MANIFEST.replace(
    '</assembly>',
    `<compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{${SUPPORTED_OS_WINDOWS_10}}"/></application></compatibility></assembly>`
  )
  const required = HOST_REQUIRED_FUNCTIONS
  const host = (o: PeOptions = {}) =>
    syntheticPe({
      imports: ['KERNEL32.dll', 'bcrypt.dll'],
      importFunctions: [[...required['kernel32.dll']], [...required['bcrypt.dll']]],
      manifest: HOST_MANIFEST,
      ...o
    })
  const hostIssues = (o: PeOptions = {}) => checkHostBinary(host(o)).issues

  it('binário conforme: nenhuma pendência', () => {
    assert.deepEqual(hostIssues(), [])
  })

  it('obrigatórias e permitidas são coerentes: toda obrigatória está na lista explícita, nenhuma proibida está nela', () => {
    for (const [dll, names] of Object.entries(HOST_REQUIRED_FUNCTIONS)) {
      for (const name of names) assert.ok((HOST_ALLOWED_FUNCTIONS as Record<string, readonly string[]>)[dll]?.includes(name), `${dll}!${name}`)
    }
    const allowed = Object.values(HOST_ALLOWED_FUNCTIONS).flat()
    for (const name of HOST_FORBIDDEN_FUNCTIONS) assert.ok(!allowed.includes(name), name)
  })

  it('função fora da lista explícita é recusada e nomeada', () => {
    const r = checkHostBinary(host({ importFunctions: [[...required['kernel32.dll'], 'GetTickCount'], [...required['bcrypt.dll']]] }))
    assert.deepEqual(r.issues, ['unexpected-function'])
    assert.deepEqual(r.unexpectedFunctions, ['kernel32.dll!GetTickCount'])
  })

  it('caminhos alternativos de criação ou associação são proibidos', () => {
    for (const fn of HOST_FORBIDDEN_FUNCTIONS) {
      const found = hostIssues({ importFunctions: [[...required['kernel32.dll'], fn], [...required['bcrypt.dll']]] })
      assert.ok(found.includes('forbidden-function'), fn)
    }
  })

  it('função obrigatória ausente (ex.: sem IsProcessInJob) é recusada', () => {
    const without = required['kernel32.dll'].filter((name) => name !== 'IsProcessInJob')
    assert.deepEqual(hostIssues({ importFunctions: [without, [...required['bcrypt.dll']]] }), ['missing-function'])
  })

  it('DLL fora de kernel32/bcrypt é recusada', () => {
    const found = hostIssues({ imports: ['KERNEL32.dll', 'bcrypt.dll', 'ADVAPI32.dll'], importFunctions: [[...required['kernel32.dll']], [...required['bcrypt.dll']], ['OpenProcessToken']] })
    assert.ok(found.includes('unexpected-import'))
  })

  it('manifesto sem supportedOS do Windows 10 é recusado', () => {
    assert.deepEqual(hostIssues({ manifest: AS_INVOKER_MANIFEST }), ['supported-os-missing'])
  })

  it('as políticas comuns continuam valendo (ex.: sem CET)', () => {
    assert.deepEqual(hostIssues({ cetFlags: 0 }), ['no-cet-compat'])
  })
})

describe('inspeção de PE: identidade das variantes e alvo sintético (6C.6C.1)', () => {
  const wide = (...texts: string[]) => Buffer.from(texts.join('\0'), 'utf16le')
  const SUPPORTED_MANIFEST = AS_INVOKER_MANIFEST.replace(
    '</assembly>',
    `<compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{${SUPPORTED_OS_WINDOWS_10}}"/></application></compatibility></assembly>`
  )
  const synthetic = (o: PeOptions = {}) =>
    syntheticPe({
      importFunctions: [['GetStdHandle', 'WriteFile', 'CreateProcessW']],
      manifest: SUPPORTED_MANIFEST,
      embedded: wide('gerpro-synthetic-helper.exe', 'host-test'),
      ...o
    })

  it('cada variante só aceita os próprios nomes', () => {
    const production = wide('gerpro-helper-host.exe', 'gerpro-dxcore-helper.exe')
    const test = wide('gerpro-helper-host-test.exe', 'gerpro-synthetic-helper.exe', 'host-test')
    assert.deepEqual(checkVariantIdentity(production, 'production'), [])
    assert.deepEqual(checkVariantIdentity(test, 'test'), [])
    assert.deepEqual(checkVariantIdentity(production, 'test'), ['wrong-variant-identity'])
    assert.deepEqual(checkVariantIdentity(test, 'production'), ['wrong-variant-identity'])
    // Produção que também conhecesse o alvo sintético (ou o contrário) é recusada.
    assert.deepEqual(checkVariantIdentity(Buffer.concat([production, wide('gerpro-synthetic-helper.exe')]), 'production'), ['wrong-variant-identity'])
    assert.deepEqual(checkVariantIdentity(Buffer.concat([test, wide('gerpro-dxcore-helper.exe')]), 'test'), ['wrong-variant-identity'])
    // Deslocamento ímpar e maiúsculas não escondem o nome.
    assert.deepEqual(checkVariantIdentity(Buffer.concat([Buffer.from([0]), test, wide('GERPRO-DXCORE-HELPER.EXE')]), 'test'), ['wrong-variant-identity'])
    assert.deepEqual(checkVariantIdentity(Buffer.alloc(64), 'synthetic'), ['wrong-variant-identity'])
  })

  it('as listas de nomes das variantes não se sobrepõem', () => {
    for (const variant of Object.values(LAUNCHER_IDENTITY)) {
      for (const name of variant.required) assert.ok(!(variant.forbidden as readonly string[]).includes(name), name)
    }
    assert.ok((LAUNCHER_IDENTITY.production.forbidden as readonly string[]).includes('gerpro-synthetic-helper.exe'))
    assert.ok((LAUNCHER_IDENTITY.test.forbidden as readonly string[]).includes('gerpro-dxcore-helper.exe'))
    assert.ok((LAUNCHER_IDENTITY.synthetic.forbidden as readonly string[]).includes('gerpro-dxcore-helper.exe'))
  })

  it('alvo sintético conforme: nenhuma pendência', () => {
    assert.deepEqual(checkSyntheticBinary(synthetic()).issues, [])
  })

  it('alvo sintético: só KERNEL32, lista explícita e proibições', () => {
    assert.ok(checkSyntheticBinary(synthetic({ imports: ['KERNEL32.dll', 'WS2_32.dll'], importFunctions: [['GetStdHandle'], ['connect']] })).issues.includes('unexpected-import'))
    const r = checkSyntheticBinary(synthetic({ importFunctions: [['GetStdHandle', 'GetTickCount']] }))
    assert.deepEqual(r.issues, ['unexpected-function'])
    assert.deepEqual(r.unexpectedFunctions, ['kernel32.dll!GetTickCount'])
    for (const fn of SYNTHETIC_FORBIDDEN_FUNCTIONS) {
      assert.ok(checkSyntheticBinary(synthetic({ importFunctions: [['GetStdHandle', fn]] })).issues.includes('forbidden-function'), fn)
    }
    const allowed = SYNTHETIC_ALLOWED_FUNCTIONS['kernel32.dll']
    for (const fn of SYNTHETIC_FORBIDDEN_FUNCTIONS) assert.ok(!allowed.includes(fn), fn)
  })

  it('alvo sintético: identidade, manifesto e políticas comuns', () => {
    assert.deepEqual(checkSyntheticBinary(synthetic({ embedded: wide('gerpro-dxcore-helper.exe', 'host-test') })).issues, ['wrong-variant-identity'])
    assert.deepEqual(checkSyntheticBinary(synthetic({ manifest: AS_INVOKER_MANIFEST })).issues, ['supported-os-missing'])
    assert.ok(checkSyntheticBinary(synthetic({ manifest: AS_INVOKER_MANIFEST.replace('asInvoker', 'requireAdministrator') })).issues.includes('manifest-not-as-invoker'))
    assert.deepEqual(checkSyntheticBinary(synthetic({ cetFlags: 0 })).issues, ['no-cet-compat'])
  })
})

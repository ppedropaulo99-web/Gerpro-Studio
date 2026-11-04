import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DXCORE_HELPER_SHA256 } from '../../src/main/hardware/local/bundled-helper'
import { DXCORE_HOST, DXCORE_HOST_EXIT_CODES, DXCORE_HOST_HELPER_COMMAND_LINE, DXCORE_HOST_SHA256 } from '../../src/main/hardware/local/dxcore-host-contract'
import { SCENARIOS, SYNTHETIC_HELPER_NAME, TEST_HELPERS_DIRECTORY, TEST_LAUNCHER_NAME } from '../../scripts/native/host-test-scenarios'
import { nonDiagnostic } from '../support/launcher-views'

// Revisão estática dos artefatos SÓ DE TESTE (Etapa 6C.6C.1): variante de
// testes do launcher e alvo sintético. Nada é compilado nem executado aqui.
// Confere: (1) a variante muda só a identidade e o conjunto de resumos
// aceitos, nunca a sequência de contenção; (2) o alvo sintético não toca
// hardware, rede, registro nem arquivos; (3) nada disso chega ao app, aos
// recursos ou ao build de produção.

const ROOT = join(import.meta.dirname, '../..')
const HOST = join(ROOT, 'native', 'helper-host')
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const count = (text: string, pattern: RegExp) => [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length
const walk = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []

/** Blocos de pré-processador da variante: [condição, corpo] para cada `#if`/`#else` que cita GERPRO_HOST_TEST_BUILD. */
function variantBlocks(text: string): { production: string[]; test: string[] } {
  const production: string[] = []
  const test: string[] = []
  const re = /#if (!?)defined\(GERPRO_HOST_TEST_BUILD\)\n([\s\S]*?)(?:#else\n([\s\S]*?))?#endif/g
  for (const m of text.matchAll(re)) {
    const negated = m[1] === '!'
    const first = m[2] ?? ''
    const second = m[3] ?? ''
    if (negated) {
      production.push(first)
      if (second) test.push(second)
    } else {
      test.push(first)
      if (second) production.push(second)
    }
  }
  return { production, test }
}

/** Fonte com a variante de PRODUÇÃO resolvida (blocos de teste removidos). */
const productionView = (text: string) =>
  text.replace(/#if (!?)defined\(GERPRO_HOST_TEST_BUILD\)\n([\s\S]*?)(?:#else\n([\s\S]*?))?#endif\n/g, (_all, neg: string, first: string, second?: string) =>
    neg === '!' ? first : (second ?? '')
  )
/** Fonte com a variante de TESTES resolvida. */
const testView = (text: string) =>
  text.replace(/#if (!?)defined\(GERPRO_HOST_TEST_BUILD\)\n([\s\S]*?)(?:#else\n([\s\S]*?))?#endif\n/g, (_all, neg: string, first: string, second?: string) =>
    neg === '!' ? (second ?? '') : first
  )

describe('variante de testes do launcher: só identidade e resumos fixados', () => {
  // Sem a variante diagnóstica (6C.6C.2C), que tem testes próprios.
  const mainCpp = nonDiagnostic(read(HOST, 'src', 'main.cpp'))
  const protocolH = read(HOST, 'src', 'protocol.h')

  it('a variante só existe em protocol.h e main.cpp, em blocos fechados', () => {
    for (const file of ['protocol.cpp', 'integrity.cpp', 'integrity.h', 'exit_codes.h']) assert.doesNotMatch(read(HOST, 'src', file), /GERPRO_HOST_TEST_BUILD/, file)
    assert.equal(count(code(protocolH), /GERPRO_HOST_TEST_BUILD/), 1)
    assert.equal(count(code(mainCpp), /GERPRO_HOST_TEST_BUILD/), 3)
  })

  it('protocol.h: produção no ramo padrão, testes só no ramo da variante', () => {
    const blocks = variantBlocks(code(protocolH))
    assert.equal(blocks.production.length, 1)
    assert.equal(blocks.test.length, 1)
    const literal = (block: string, name: string) => block.match(new RegExp(`${name}\\[\\] = L"([^"]*)"`))?.[1]
    const [prod] = blocks.production
    const [test] = blocks.test
    assert.equal(literal(prod!, 'kHostFileName'), DXCORE_HOST.fileName)
    assert.equal(literal(prod!, 'kHelperFileName'), DXCORE_HOST.helperFileName)
    assert.equal(literal(prod!, 'kHelpersDirectory'), DXCORE_HOST.directory)
    assert.equal(literal(test!, 'kHostFileName'), TEST_LAUNCHER_NAME)
    assert.equal(literal(test!, 'kHelperFileName'), SYNTHETIC_HELPER_NAME)
    assert.equal(literal(test!, 'kHelpersDirectory'), TEST_HELPERS_DIRECTORY)
    // O ramo de testes declara só os três nomes: nada de argumentos, caminhos ou opções.
    assert.equal(count(test!, /constexpr/), 3)
  })

  it('main.cpp: o ramo de testes muda só a linha de comando, inclui os resumos e os exige', () => {
    const blocks = variantBlocks(code(mainCpp))
    assert.equal(blocks.production.length, 1)
    assert.equal(blocks.test.length, 3)
    assert.equal(blocks.production[0]!.match(/kHelperCommandLine\[\] = L"([^"]*)"/)?.[1], DXCORE_HOST_HELPER_COMMAND_LINE)
    assert.equal(blocks.test[0]!.trim(), '#include "synthetic_digests.h"\n#if !defined(GERPRO_SYNTHETIC_DIGESTS)\n#error "variante de testes sem os resumos fixados dos auxiliares sintéticos"')
    assert.equal(blocks.test[1]!.match(/kHelperCommandLine\[\] = L"([^"]*)"/)?.[1], `${SYNTHETIC_HELPER_NAME} --protocol 1`)
    assert.equal(blocks.test[2]!.trim(), 'if (!DigestInSet(expected, kSyntheticHelperDigests, kSyntheticHelperDigestCount)) return kExitHostIntegrity;')
  })

  it('a sequência de contenção é a mesma nas duas variantes (fora dos blocos)', () => {
    const prod = code(productionView(mainCpp))
    const test = code(testView(mainCpp))
    for (const view of [prod, test]) {
      assert.equal(count(view, /::CreateProcessW\(/), 1)
      assert.equal(count(view, /::ResumeThread\(/), 1)
      assert.match(view, /PROC_THREAD_ATTRIBUTE_JOB_LIST/)
      assert.match(view, /CREATE_SUSPENDED \| EXTENDED_STARTUPINFO_PRESENT/)
      assert.match(view, /PROCESS_CREATION_CHILD_PROCESS_RESTRICTED/)
      assert.doesNotMatch(view, /AssignProcessToJobObject|BREAKAWAY/)
    }
    // Retirando a única linha extra da variante, as duas sequências são idênticas.
    const strip = (text: string) => text.replace(/^.*kHelperCommandLine\[\].*$/m, '').replace(/^.*DigestInSet.*$/m, '').replace(/^#.*$/gm, '').replace(/\s+/g, ' ')
    assert.equal(strip(test), strip(prod))
  })

  it('o resumo fixado é exigido depois do hash prévio e antes do job', () => {
    const test = code(testView(mainCpp))
    const at = (needle: string) => test.indexOf(needle)
    assert.ok(at('DigestEquals(digest, expected)') < at('DigestInSet(expected'))
    assert.ok(at('DigestInSet(expected') < at('CreateContainmentJob(job)'))
  })

  it('nenhum header de resumos dentro dos fontes (só no build da variante)', () => {
    assert.ok(!existsSync(join(HOST, 'src', 'synthetic_digests.h')))
    assert.ok(walk(join(HOST, 'src')).every((f) => !/synthetic_digests/.test(f)))
  })
})

describe('build: produção e testes separados', () => {
  const production = code(read(ROOT, 'scripts', 'native', 'build-helper-host.mjs'))
  const testScript = code(read(ROOT, 'scripts', 'native', 'build-host-test-artifacts.mjs'))

  it('o build de produção nunca define a variante nem conhece o alvo sintético', () => {
    assert.doesNotMatch(production, /GERPRO_HOST_TEST_BUILD|GERPRO_SYNTHETIC|synthetic|host-test|test-artifacts/)
    assert.match(production, /checkVariantIdentity\(hostBytes, 'production'\)/)
  })

  it('o build de testes define a variante, confere identidade e grava só em build/test', () => {
    assert.match(testScript, /'\/DGERPRO_HOST_TEST_BUILD'/)
    assert.match(testScript, /checkVariantIdentity\(launcherBytes, 'test'\)/)
    assert.match(testScript, /checkSyntheticBinary\(bytes, forbidden\)/)
    assert.match(testScript, /const TEST_BUILD_DIR = join\(BUILD_DIR, 'test'\)/)
    assert.match(testScript, /if \(!path\.startsWith\(TEST_BUILD_DIR \+ sep\)\) fail/)
    assert.match(testScript, /if \(!dir\.startsWith\(TEST_BUILD_DIR \+ sep\)/)
    // Únicas gravações: o header gerado e o manifesto, ambos dentro da pasta de build de testes.
    assert.equal(count(testScript, /writeFileSync\(/), 2)
    assert.match(testScript, /writeFileSync\(join\(generated, 'synthetic_digests\.h'\)/)
    assert.match(testScript, /writeFileSync\(join\(first\.dir, 'test-manifest\.json'\)/)
    // `resources` só aparece na lista de binários de produção comparados (leitura).
    assert.equal(count(testScript, /'resources'/), 2)
    assert.match(testScript, /unique\.has\(sha256\(readFileSync\(production\)\)\)\) fail/)
  })

  it('nenhum dos scripts executa o que compila', () => {
    for (const text of [production, testScript]) assert.doesNotMatch(text, /child_process|spawnSync|execFile|execSync|\bexec\(|spawn\(/)
  })

  it('a pasta de build continua fora do git', () => {
    assert.match(read(ROOT, '.gitignore'), /^\/native\/helper-host\/build\/$/m)
  })
})

describe('alvo sintético: sem hardware, rede, registro nem arquivos', () => {
  const source = read(HOST, 'test-artifacts', 'synthetic_helper.cpp')
  const body = code(source)

  it('nenhuma API de arquivo, registro, rede, dispositivo, ambiente ou outro processo', () => {
    for (const forbidden of [
      /CreateFile|DeleteFile|MoveFile|CopyFile|ReplaceFile|CreateDirectory|RemoveDirectory|SetFileInformation|CreateFileMapping|FindFirstFile/,
      /\bReg[A-Z]\w*\(|winreg/,
      /winsock|WSA\w*\(|socket\(|WinHttp|Internet\w*\(|urlmon/i,
      /DeviceIoControl|SetupDi|dxcore|dxgi|d3d1|DXCore|IDXGI|cfgmgr|wbem|Wmi/,
      /GetEnvironmentVariable|ExpandEnvironmentStrings|GetEnvironmentStrings/,
      /OpenProcess|CreateRemoteThread|WriteProcessMemory|VirtualAllocEx|OpenThread/,
      /CreateJobObject|AssignProcessToJobObject|SetInformationJobObject|OpenJobObject/,
      /LoadLibrary|GetProcAddress|ShellExecute|WinExec|system\(/,
      /requireAdministrator|highestAvailable/,
      /printf|std::cout|fwrite|fopen|OutputDebugString/
    ]) {
      assert.doesNotMatch(body, forbidden, String(forbidden))
    }
    assert.match(body, /#include <windows\.h>/)
    assert.equal(count(body, /#include/), 4)
  })

  it('única saída: uma linha na saída padrão herdada', () => {
    assert.equal(count(body, /::WriteFile\(/), 1)
    assert.equal(count(body, /::GetStdHandle\(/), 1)
    assert.match(body, /::GetStdHandle\(STD_OUTPUT_HANDLE\)/)
  })

  it('recusa rodar fora do layout de testes ou com outros argumentos, antes de qualquer cenário', () => {
    const entry = body.slice(body.indexOf('int wmain('))
    assert.match(entry, /argc != 3/)
    assert.match(entry, /Equals\(argv\[1\], L"--protocol"\)/)
    assert.match(entry, /Equals\(argv\[2\], L"1"\)/)
    assert.ok(entry.indexOf('InTestLayout()') < entry.indexOf('RunScenario()'))
    assert.match(body, /kOwnName\[\] = L"gerpro-synthetic-helper\.exe"/)
    assert.match(body, /kTestDirectory\[\] = L"host-test"/)
    assert.doesNotMatch(body, /gerpro-dxcore-helper|gerpro-helper-host\.exe|L"helpers"/)
  })

  it('descendentes só suspensos e sempre encerrados; prazo próprio de 30 s', () => {
    assert.equal(count(body, /::CreateProcessW\(/), 1)
    assert.match(body, /CREATE_SUSPENDED \| CREATE_NO_WINDOW \| extraFlags/)
    assert.doesNotMatch(body, /ResumeThread/)
    const create = body.slice(body.indexOf('::CreateProcessW('))
    assert.ok(create.indexOf('::TerminateProcess(child.hProcess') > 0)
    assert.match(body, /kSelfDeadlineMs = 30000;/)
    assert.equal(count(body, /::Sleep\(/), 1)
    assert.match(body, /::Sleep\(kSelfDeadlineMs\)/)
    assert.match(body, /kMemoryBytes = 64u \* 1024u \* 1024u;/)
    assert.match(body, /::VirtualFree\(block, 0, MEM_RELEASE\)/)
  })

  it('cenários do fonte = cenários do roteiro', () => {
    const defined = [...body.matchAll(/#define GERPRO_SCENARIO_([A-Z_]+) (\d+)/g)].map((m) => ({ id: m[1]!.toLowerCase().replaceAll('_', '-'), number: Number(m[2]) }))
    assert.deepEqual(defined, SCENARIOS.map(({ id, number }) => ({ id, number })))
    assert.match(body, /GERPRO_SYNTHETIC_SCENARIO > 7/)
  })

  it('códigos esperados coerentes com o contrato do launcher', () => {
    const passthrough = [0, 10, 11, 12, 13, 64]
    for (const s of SCENARIOS) {
      if (s.id === 'hang') assert.equal(s.expectedHostExit, DXCORE_HOST_EXIT_CODES.hostTimeout)
      else assert.equal(s.expectedHostExit, passthrough.includes(s.helperExit) ? s.helperExit : DXCORE_HOST_EXIT_CODES.hostContainment, s.id)
    }
  })
})

describe('artefatos de teste fora do app e da distribuição', () => {
  const testNames = /gerpro-helper-host-test|gerpro-synthetic-helper|synthetic_helper|host-test-scenarios|build-host-test-artifacts|test-artifacts/

  it('nenhum código do app, configuração de build ou manifesto do pacote os cita', () => {
    const files = [
      ...walk(join(ROOT, 'src')).filter((f) => /\.(ts|tsx|js|mjs|json|html|css)$/.test(f)),
      join(ROOT, 'package.json'),
      join(ROOT, 'electron.vite.config.ts')
    ]
    for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), testNames, file)
  })

  it('nenhum artefato de teste em resources/', () => {
    for (const file of walk(join(ROOT, 'resources'))) assert.doesNotMatch(file, /gerpro-helper-host-test|gerpro-synthetic-helper|host-test/, file)
  })

  it('hashes de produção continuam nulos', () => {
    assert.deepEqual(DXCORE_HOST_SHA256, { x64: null, arm64: null })
    assert.deepEqual(DXCORE_HELPER_SHA256, { x64: null, arm64: null })
  })
})

#!/usr/bin/env node
/**
 * Build dos artefatos SÓ DE TESTE do launcher (Etapa 6C.6C.1; docs/11):
 *
 * - `gerpro-synthetic-helper.exe`, um por cenário (`host-test-scenarios.ts`),
 *   de `native/helper-host/test-artifacts/synthetic_helper.cpp`;
 * - `gerpro-helper-host-test.exe`: os MESMOS fontes do launcher, com
 *   `/DGERPRO_HOST_TEST_BUILD` e os resumos dos alvos sintéticos fixados num
 *   header gerado (`synthetic_digests.h`);
 * - `protocol_tests_test_variant.exe`: testes da lógica pura nessa variante.
 *
 *   node scripts/native/build-host-test-artifacts.mjs --check-toolchain [--accept-sdk=<versão>]
 *   node scripts/native/build-host-test-artifacts.mjs --confirm-native-build [--reproducibility-check] [--accept-sdk=<versão>]
 *
 * O script:
 * - grava SÓ em `native/helper-host/build/test/` (fora do git, fora de
 *   `resources/`, fora de qualquer empacotamento);
 * - NÃO executa nada do que compila (o único processo criado é o cl.exe);
 * - recusa (e apaga) binários fora da política: alvo só com KERNEL32 e lista
 *   explícita; launcher de testes com a mesma lista do de produção; identidade
 *   de cada variante (`checkVariantIdentity`);
 * - recusa resumos sintéticos repetidos ou iguais a qualquer auxiliar DXCore
 *   ou launcher de produção compilado nesta máquina;
 * - não altera `DXCORE_HOST_SHA256` nem `DXCORE_HELPER_SHA256`.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS, SYNTHETIC_HELPER_NAME, TEST_HELPERS_DIRECTORY, TEST_LAUNCHER_NAME } from './host-test-scenarios.ts'
import { ACCEPT_SDK, assertPlainDir as assertPlainDirWith, BASE_LINK_FLAGS, COMPILE_FLAGS, failer, forbiddenTexts, isFile, readToolchain, runCompiler, sha256 } from './msvc-toolchain.mjs'
import { checkHostBinary, checkSyntheticBinary, checkVariantIdentity } from './pe-inspect.ts'

const CONFIRM = '--confirm-native-build'
const CHECK_TOOLCHAIN = '--check-toolchain'
const REPRO = '--reproducibility-check'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOST_DIR = join(ROOT, 'native', 'helper-host')
const BUILD_DIR = join(HOST_DIR, 'build')
const TEST_BUILD_DIR = join(BUILD_DIR, 'test')
const TESTS_NAME = 'protocol_tests_test_variant.exe'

const TEST_DEFINE = '/DGERPRO_HOST_TEST_BUILD'
const HOST_SOURCES = ['src\\main.cpp', 'src\\protocol.cpp', 'src\\integrity.cpp']
const TEST_SOURCES = ['tests\\protocol_tests.cpp', 'src\\protocol.cpp']
const SYNTHETIC_SOURCE = 'test-artifacts\\synthetic_helper.cpp'
const MANIFEST = 'src\\host.manifest'

const HOST_LINK_FLAGS = [...BASE_LINK_FLAGS, `/MANIFESTINPUT:${MANIFEST}`, 'kernel32.lib', 'bcrypt.lib']
const SYNTHETIC_LINK_FLAGS = [...BASE_LINK_FLAGS, `/MANIFESTINPUT:${MANIFEST}`, 'kernel32.lib']
const TEST_LINK_FLAGS = [...BASE_LINK_FLAGS, 'kernel32.lib']

/** Binários de produção conhecidos nesta máquina: nenhum resumo sintético pode coincidir. */
const PRODUCTION_BINARIES = [
  join(ROOT, 'resources', 'helpers', 'win32-x64', 'gerpro-dxcore-helper.exe'),
  join(ROOT, 'resources', 'helpers', 'win32-x64', 'gerpro-helper-host.exe'),
  join(ROOT, 'native', 'helper-host', 'build', 'x64', 'gerpro-helper-host.exe')
]

const fail = failer('build-host-test-artifacts')
const assertPlainDir = (dir) => assertPlainDirWith(dir, fail)

function readArgs(argv) {
  const args = argv.slice(2)
  const known = args.every((a) => a === CONFIRM || a === REPRO || a === CHECK_TOOLCHAIN || a.startsWith(ACCEPT_SDK))
  if (!known) fail(`argumento desconhecido. Uso: ${CHECK_TOOLCHAIN} | ${CONFIRM} [${REPRO}] [${ACCEPT_SDK}<versão>]`, 2)
  const accept = args.find((a) => a.startsWith(ACCEPT_SDK))?.slice(ACCEPT_SDK.length) ?? null
  if (args.includes(CHECK_TOOLCHAIN)) {
    if (args.includes(CONFIRM) || args.includes(REPRO)) fail(`${CHECK_TOOLCHAIN} não compila: use-o sozinho.`, 2)
    return { checkOnly: true, reproducibility: false, acceptSdk: accept }
  }
  if (!args.includes(CONFIRM)) fail(`nada foi feito: o build nativo exige ${CONFIRM}.`, 2)
  return { checkOnly: false, reproducibility: args.includes(REPRO), acceptSdk: accept }
}

/** Só remove pastas próprias dentro de native/helper-host/build/test, sem seguir links. */
function freshBuildDir(name) {
  const dir = join(TEST_BUILD_DIR, name)
  if (!dir.startsWith(TEST_BUILD_DIR + sep) || !['x64', 'x64-repro'].includes(name)) fail('pasta de build fora do lugar.')
  for (const parent of [HOST_DIR, BUILD_DIR, TEST_BUILD_DIR, dir]) assertPlainDir(parent)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  assertPlainDir(dir)
  return dir
}

/** Pasta dentro da pasta de build (relativa a HOST_DIR para /I, absoluta para o resto). */
function subdir(dir, ...parts) {
  const path = join(dir, ...parts)
  if (!path.startsWith(TEST_BUILD_DIR + sep)) fail('pasta fora da área de testes.')
  mkdirSync(path, { recursive: true })
  return path
}

function compile(toolchain, defines, sources, objDir, linkFlags, output) {
  runCompiler(toolchain, [...COMPILE_FLAGS, ...defines, `/Fo${objDir}\\`, ...sources, '/link', ...linkFlags, `/OUT:${output}`], HOST_DIR, fail)
}

/** Header gerado com os resumos fixados (só a variante de testes o inclui). */
function digestsHeader(digests) {
  const rows = digests.map(({ id, sha256: hex }) => {
    const bytes = hex.match(/../g).map((b) => `0x${b}`).join(', ')
    return `    {${bytes}},  // ${id}`
  })
  return [
    '// GERADO por scripts/native/build-host-test-artifacts.mjs. Não editar.',
    '// Resumos SHA-256 dos alvos sintéticos aceitos pela variante de testes.',
    '#pragma once',
    '#define GERPRO_SYNTHETIC_DIGESTS 1',
    `constexpr std::size_t kSyntheticHelperDigestCount = ${digests.length};`,
    'constexpr std::uint8_t kSyntheticHelperDigests[kSyntheticHelperDigestCount][32] = {',
    ...rows,
    '};',
    ''
  ].join('\n')
}

function rejectBinary(file, issues, unexpected) {
  rmSync(file, { force: true })
  if (unexpected.length > 0) console.error(`importações fora da lista: ${unexpected.join(', ')}`)
  fail(`${relative(ROOT, file)} não atende à política e foi apagado: ${issues.join(', ')}`)
}

function buildOnce(toolchain, name, forbidden) {
  const dir = freshBuildDir(name)
  const scenarios = []
  for (const scenario of SCENARIOS) {
    const out = join(subdir(dir, 'scenarios', scenario.id), SYNTHETIC_HELPER_NAME)
    compile(toolchain, [`/DGERPRO_SYNTHETIC_SCENARIO=${scenario.number}`], [SYNTHETIC_SOURCE], subdir(dir, 'obj', scenario.id), SYNTHETIC_LINK_FLAGS, out)
    const bytes = readFileSync(out)
    const { issues, unexpectedFunctions, report } = checkSyntheticBinary(bytes, forbidden)
    if (issues.length > 0) rejectBinary(out, issues, unexpectedFunctions)
    scenarios.push({ id: scenario.id, number: scenario.number, size: bytes.length, sha256: sha256(bytes), importFunctions: report.importFunctions })
  }

  const unique = new Set(scenarios.map((s) => s.sha256))
  if (unique.size !== scenarios.length) fail('dois cenários produziram o mesmo binário.')
  for (const production of PRODUCTION_BINARIES) {
    if (isFile(production) && unique.has(sha256(readFileSync(production)))) fail('um alvo sintético é idêntico a um binário de produção; recusado.')
  }

  const generated = subdir(dir, 'generated')
  writeFileSync(join(generated, 'synthetic_digests.h'), digestsHeader(scenarios))
  const include = `/I${relative(HOST_DIR, generated)}`
  if (include.includes(':') || include.includes('..')) fail('caminho do header gerado inesperado.')

  const launcher = join(dir, TEST_LAUNCHER_NAME)
  compile(toolchain, [TEST_DEFINE, include], HOST_SOURCES, subdir(dir, 'obj', 'launcher'), HOST_LINK_FLAGS, launcher)
  const launcherBytes = readFileSync(launcher)
  const host = checkHostBinary(launcherBytes, forbidden)
  const issues = [...host.issues, ...checkVariantIdentity(launcherBytes, 'test')]
  if (issues.length > 0) rejectBinary(launcher, issues, host.unexpectedFunctions)

  const tests = join(dir, TESTS_NAME)
  compile(toolchain, [TEST_DEFINE], TEST_SOURCES, subdir(dir, 'obj', 'tests'), TEST_LINK_FLAGS, tests)
  return { dir, scenarios, launcher, launcherBytes, launcherReport: host.report, tests }
}

function main() {
  const { checkOnly, reproducibility, acceptSdk } = readArgs(process.argv)
  const toolchain = readToolchain(acceptSdk, ['jobapi2.h', 'processthreadsapi.h'], fail)
  if (checkOnly) {
    console.log(`MSVC ${toolchain.vcToolsVersion}, Windows SDK ${toolchain.sdkVersion}: ferramentas e headers encontrados.`)
    console.log('Nada foi compilado.')
    return
  }
  const forbidden = forbiddenTexts(ROOT)
  const first = buildOnce(toolchain, 'x64', forbidden)

  let repro = null
  if (reproducibility) {
    const second = buildOnce(toolchain, 'x64-repro', forbidden)
    const same = (a, b) => sha256(readFileSync(a)) === sha256(readFileSync(b))
    repro = {
      builds: 2,
      scenariosIdentical: first.scenarios.every((s, i) => s.sha256 === second.scenarios[i].sha256),
      launcherIdentical: same(first.launcher, second.launcher),
      testsIdentical: same(first.tests, second.tests)
    }
    if (!repro.scenariosIdentical || !repro.launcherIdentical || !repro.testsIdentical) fail('dois builds limpos produziram binários diferentes: não reproduzível.')
  }

  const sources = [...HOST_SOURCES, 'src\\exit_codes.h', 'src\\protocol.h', 'src\\integrity.h', MANIFEST, SYNTHETIC_SOURCE, 'tests\\protocol_tests.cpp'].map((file) => ({
    file: file.replaceAll('\\', '/'),
    sha256: sha256(readFileSync(join(HOST_DIR, file)))
  }))
  const r = first.launcherReport
  const manifest = {
    purpose: 'artefatos SÓ DE TESTE (6C.6C.1); nunca distribuídos; nunca usados pelo app',
    layout: `<pasta temporária controlada>\\${TEST_HELPERS_DIRECTORY}\\win32-x64\\{${TEST_LAUNCHER_NAME}, ${SYNTHETIC_HELPER_NAME}}`,
    launcher: {
      file: TEST_LAUNCHER_NAME,
      variant: 'GERPRO_HOST_TEST_BUILD',
      protocol: '--protocol 1 --helper-sha256 <hex> (igual à produção)',
      size: first.launcherBytes.length,
      sha256: sha256(first.launcherBytes),
      pe: r && {
        dllCharacteristics: `0x${r.dllCharacteristics.toString(16)}`,
        guardFlags: r.guardFlags === null ? null : `0x${r.guardFlags.toString(16)}`,
        cetCompat: r.cetCompat,
        dependentLoadFlags: r.dependentLoadFlags === null ? null : `0x${r.dependentLoadFlags.toString(16)}`,
        executionLevel: r.manifest?.executionLevel ?? null,
        imports: r.imports
      }
    },
    syntheticHelpers: first.scenarios.map(({ id, number, size, sha256: hash, importFunctions }) => ({ id, number, file: SYNTHETIC_HELPER_NAME, size, sha256: hash, importFunctions })),
    tests: { file: TESTS_NAME, sha256: sha256(readFileSync(first.tests)) },
    toolchain: { msvc: toolchain.vcToolsVersion, windowsSdk: toolchain.sdkVersion, sdkOutsideReference: toolchain.sdkAccepted },
    compileFlags: COMPILE_FLAGS,
    sources,
    reproducibility: repro,
    productionHashes: 'inalterados (DXCORE_HOST_SHA256 e DXCORE_HELPER_SHA256 continuam null)',
    executed: false
  }
  writeFileSync(join(first.dir, 'test-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`variante de testes: ${relative(ROOT, first.launcher)}  SHA-256 ${manifest.launcher.sha256}`)
  for (const s of manifest.syntheticHelpers) console.log(`alvo sintético ${s.id}: SHA-256 ${s.sha256}`)
  console.log(`testes da lógica pura (variante; não executados por este script): ${relative(ROOT, first.tests)}`)
  console.log('Nada foi executado. Nada foi gravado fora de native/helper-host/build/test.')
}

main()

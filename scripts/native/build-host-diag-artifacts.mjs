#!/usr/bin/env node
/**
 * Build da variante DIAGNÓSTICA do launcher de testes (Etapa 6C.6C.2C;
 * docs/11-testes-contencao.md, seção 11):
 *
 * - `diag/detached/gerpro-helper-host-test.exe`: os MESMOS fontes do launcher
 *   com `/DGERPRO_HOST_TEST_BUILD /DGERPRO_HOST_DIAG_BUILD` e
 *   `test-artifacts/host_diag.cpp`; mesma criação do alvo que a produção
 *   (`DETACHED_PROCESS`, desde a 6C.6C.2E). A variante `nowindow` da
 *   6C.6C.2C (`CREATE_NO_WINDOW`) não existe mais nos fontes;
 * - aceita UM único resumo: o do alvo sintético `exit-ok` aprovado
 *   (conferido no arquivo do build de testes antes de gerar o header);
 * - controles: os fontes alterados são compilados de novo SEM a variante
 *   diagnóstica (produção e testes comuns) e os binários têm de sair
 *   idênticos aos já aprovados (mesmo SHA-256). Os controles não são
 *   copiados para lugar nenhum.
 *
 *   node scripts/native/build-host-diag-artifacts.mjs --confirm-native-build [--reproducibility-check] [--accept-sdk=<versão>]
 *
 * Grava SÓ em `native/helper-host/build/test/diag/` e `diag-repro/`. Não
 * executa nada do que compila. Não toca em `resources/`, nos hashes de
 * produção nem no build de testes aprovado.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPROVED_ARTIFACTS } from '../diagnostics/host-containment/plan.ts'
import { SYNTHETIC_HELPER_NAME, TEST_LAUNCHER_NAME } from './host-test-scenarios.ts'
import { ACCEPT_SDK, assertPlainDir as assertPlainDirWith, BASE_LINK_FLAGS, COMPILE_FLAGS, failer, forbiddenTexts, isFile, readToolchain, runCompiler, sha256 } from './msvc-toolchain.mjs'
import { checkDiagMarker, checkHostBinary, checkVariantIdentity, DIAG_HOST_ALLOWED_FUNCTIONS } from './pe-inspect.ts'

const CONFIRM = '--confirm-native-build'
const REPRO = '--reproducibility-check'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOST_DIR = join(ROOT, 'native', 'helper-host')
const BUILD_DIR = join(HOST_DIR, 'build')
const TEST_BUILD_DIR = join(BUILD_DIR, 'test')
const APPROVED_TEST_DIR = join(TEST_BUILD_DIR, 'x64')
const PRODUCTION_BUILT = join(BUILD_DIR, 'x64', 'gerpro-helper-host.exe')
const PRODUCTION_MANIFEST = join(BUILD_DIR, 'x64', 'build-manifest.json')

const HOST_SOURCES = ['src\\main.cpp', 'src\\protocol.cpp', 'src\\integrity.cpp']
const DIAG_SOURCES = [...HOST_SOURCES, 'test-artifacts\\host_diag.cpp']
const MANIFEST = 'src\\host.manifest'
const HOST_LINK_FLAGS = [...BASE_LINK_FLAGS, `/MANIFESTINPUT:${MANIFEST}`, 'kernel32.lib', 'bcrypt.lib']

const TEST_DEFINE = '/DGERPRO_HOST_TEST_BUILD'
const DIAG_DEFINE = '/DGERPRO_HOST_DIAG_BUILD'
/** Único alvo aceito pelas variantes diagnósticas. */
const DIAG_SCENARIO = 'exit-ok'

const DIAG_VARIANTS = Object.freeze([
  Object.freeze({ id: 'detached', defines: [TEST_DEFINE, DIAG_DEFINE], creation: 'DETACHED_PROCESS (igual à produção desde a 6C.6C.2E)', authorizedToRun: false })
])

const fail = failer('build-host-diag-artifacts')
const assertPlainDir = (dir) => assertPlainDirWith(dir, fail)

function readArgs(argv) {
  const args = argv.slice(2)
  if (!args.every((a) => a === CONFIRM || a === REPRO || a.startsWith(ACCEPT_SDK))) fail(`argumento desconhecido. Uso: ${CONFIRM} [${REPRO}] [${ACCEPT_SDK}<versão>]`, 2)
  if (!args.includes(CONFIRM)) fail(`nada foi feito: o build nativo exige ${CONFIRM}.`, 2)
  return { reproducibility: args.includes(REPRO), acceptSdk: args.find((a) => a.startsWith(ACCEPT_SDK))?.slice(ACCEPT_SDK.length) ?? null }
}

/** Só pastas próprias (diag, diag-repro) dentro de build/test, sem seguir links. */
function freshBuildDir(name) {
  const dir = join(TEST_BUILD_DIR, name)
  if (!dir.startsWith(TEST_BUILD_DIR + sep) || !['diag', 'diag-repro'].includes(name)) fail('pasta de build fora do lugar.')
  for (const parent of [HOST_DIR, BUILD_DIR, TEST_BUILD_DIR]) assertPlainDir(parent)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  assertPlainDir(dir)
  return dir
}

function subdir(dir, ...parts) {
  const path = join(dir, ...parts)
  if (!path.startsWith(TEST_BUILD_DIR + sep)) fail('pasta fora da área de testes.')
  mkdirSync(path, { recursive: true })
  return path
}

function includeFlag(dir) {
  const flag = `/I${relative(HOST_DIR, dir)}`
  if (flag.includes(':') || flag.includes('..')) fail('caminho de include inesperado.')
  return flag
}

function compile(toolchain, defines, sources, objDir, output) {
  runCompiler(toolchain, [...COMPILE_FLAGS, ...defines, `/Fo${objDir}\\`, ...sources, '/link', ...HOST_LINK_FLAGS, `/OUT:${output}`], HOST_DIR, fail)
}

/** Header com UM resumo: o do alvo exit-ok aprovado. */
function singleDigestHeader(hex) {
  const bytes = hex.match(/../g).map((b) => `0x${b}`).join(', ')
  return [
    '// GERADO por scripts/native/build-host-diag-artifacts.mjs. Não editar.',
    `// Variante diagnóstica: aceita só o alvo sintético ${DIAG_SCENARIO}.`,
    '#pragma once',
    '#define GERPRO_SYNTHETIC_DIGESTS 1',
    'constexpr std::size_t kSyntheticHelperDigestCount = 1;',
    'constexpr std::uint8_t kSyntheticHelperDigests[kSyntheticHelperDigestCount][32] = {',
    `    {${bytes}},  // ${DIAG_SCENARIO}`,
    '};',
    ''
  ].join('\n')
}

function rejectBinary(file, issues, unexpected) {
  rmSync(file, { force: true })
  if (unexpected.length > 0) console.error(`importações fora da lista: ${unexpected.join(', ')}`)
  fail(`${relative(ROOT, file)} não atende à política e foi apagado: ${issues.join(', ')}`)
}

/** Pré-condições: alvo exit-ok, launcher de testes e launcher de produção iguais aos aprovados. */
function approvedInputs() {
  const exitOk = join(APPROVED_TEST_DIR, 'scenarios', DIAG_SCENARIO, SYNTHETIC_HELPER_NAME)
  const approved = APPROVED_ARTIFACTS.scenarios[DIAG_SCENARIO]
  if (!isFile(exitOk)) fail('alvo exit-ok aprovado ausente.')
  const bytes = readFileSync(exitOk)
  if (bytes.length !== approved.size || sha256(bytes) !== approved.sha256) fail('alvo exit-ok diferente do aprovado.')
  const testLauncher = join(APPROVED_TEST_DIR, TEST_LAUNCHER_NAME)
  if (!isFile(testLauncher) || sha256(readFileSync(testLauncher)) !== APPROVED_ARTIFACTS.launcher.sha256) fail('launcher de testes aprovado ausente ou diferente.')
  const productionHash = JSON.parse(readFileSync(PRODUCTION_MANIFEST, 'utf8'))?.binary?.sha256
  if (typeof productionHash !== 'string' || !/^[0-9a-f]{64}$/.test(productionHash)) fail('manifesto do launcher de produção ilegível.')
  if (!isFile(PRODUCTION_BUILT) || sha256(readFileSync(PRODUCTION_BUILT)) !== productionHash) fail('launcher de produção compilado diferente do próprio manifesto.')
  const testHeader = join(APPROVED_TEST_DIR, 'generated', 'synthetic_digests.h')
  if (!isFile(testHeader)) fail('header dos resumos da variante de testes ausente.')
  return { exitOkHash: approved.sha256, productionHash, testHeaderDir: dirname(testHeader) }
}

function buildOnce(toolchain, name, inputs, forbidden) {
  const dir = freshBuildDir(name)
  const generated = subdir(dir, 'generated')
  writeFileSync(join(generated, 'synthetic_digests.h'), singleDigestHeader(inputs.exitOkHash))
  const diagInclude = [includeFlag(generated), includeFlag(join(HOST_DIR, 'test-artifacts'))]

  const variants = []
  for (const v of DIAG_VARIANTS) {
    const out = join(subdir(dir, v.id), TEST_LAUNCHER_NAME)
    compile(toolchain, [...v.defines, ...diagInclude], DIAG_SOURCES, subdir(dir, 'obj', v.id), out)
    const bytes = readFileSync(out)
    const host = checkHostBinary(bytes, forbidden, DIAG_HOST_ALLOWED_FUNCTIONS)
    const issues = [...host.issues, ...checkVariantIdentity(bytes, 'test'), ...checkDiagMarker(bytes, v.id)]
    if (issues.length > 0) rejectBinary(out, issues, host.unexpectedFunctions)
    variants.push({ id: v.id, creation: v.creation, authorizedToRun: v.authorizedToRun, file: out, size: bytes.length, sha256: sha256(bytes), imports: host.report?.imports ?? null })
  }

  // Controles: os mesmos fontes SEM a variante diagnóstica têm de dar os binários aprovados.
  const productionControl = join(subdir(dir, 'control', 'production'), 'gerpro-helper-host.exe')
  compile(toolchain, [], HOST_SOURCES, subdir(dir, 'obj', 'control-production'), productionControl)
  const testControl = join(subdir(dir, 'control', 'test'), TEST_LAUNCHER_NAME)
  compile(toolchain, [TEST_DEFINE, includeFlag(inputs.testHeaderDir)], HOST_SOURCES, subdir(dir, 'obj', 'control-test'), testControl)
  const control = {
    productionIdentical: sha256(readFileSync(productionControl)) === inputs.productionHash,
    testIdentical: sha256(readFileSync(testControl)) === APPROVED_ARTIFACTS.launcher.sha256,
    productionWithoutDiagMarker: checkDiagMarker(readFileSync(productionControl), 'absent').length === 0,
    testWithoutDiagMarker: checkDiagMarker(readFileSync(testControl), 'absent').length === 0
  }
  // Os controles só servem para a comparação: apagados em seguida.
  rmSync(join(dir, 'control'), { recursive: true, force: true })
  if (!control.productionIdentical) fail('controle: os fontes sem a variante diagnóstica NÃO reproduzem o launcher de produção aprovado.')
  if (!control.testIdentical) fail('controle: os fontes sem a variante diagnóstica NÃO reproduzem o launcher de testes aprovado.')
  if (!control.productionWithoutDiagMarker || !control.testWithoutDiagMarker) fail('controle: marca diagnóstica fora da variante diagnóstica.')
  return { dir, variants, control }
}

function main() {
  const { reproducibility, acceptSdk } = readArgs(process.argv)
  const toolchain = readToolchain(acceptSdk, ['jobapi2.h', 'processthreadsapi.h', 'ioapiset.h'], fail)
  const inputs = approvedInputs()
  const forbidden = forbiddenTexts(ROOT)
  const first = buildOnce(toolchain, 'diag', inputs, forbidden)

  let repro = null
  if (reproducibility) {
    const second = buildOnce(toolchain, 'diag-repro', inputs, forbidden)
    repro = { builds: 2, identical: first.variants.every((v, i) => v.sha256 === second.variants[i].sha256) }
    if (!repro.identical) fail('dois builds limpos produziram variantes diagnósticas diferentes: não reproduzível.')
  }

  const sources = [...DIAG_SOURCES, 'src\\exit_codes.h', 'src\\protocol.h', 'src\\integrity.h', 'test-artifacts\\host_diag.h', MANIFEST].map((file) => ({
    file: file.replaceAll('\\', '/'),
    sha256: sha256(readFileSync(join(HOST_DIR, file)))
  }))
  const manifest = {
    purpose: 'variante DIAGNÓSTICA só de teste (6C.6C.2C); nunca distribuída; nunca usada pelo app',
    acceptedTarget: { scenario: DIAG_SCENARIO, sha256: inputs.exitOkHash, digests: 1 },
    variants: first.variants.map(({ id, creation, authorizedToRun, size, sha256: hash, imports }) => ({ id, file: `${id}/${TEST_LAUNCHER_NAME}`, creation, authorizedToRun, size, sha256: hash, imports })),
    control: { ...first.control, productionSha256: inputs.productionHash, testSha256: APPROVED_ARTIFACTS.launcher.sha256 },
    toolchain: { msvc: toolchain.vcToolsVersion, windowsSdk: toolchain.sdkVersion, sdkOutsideReference: toolchain.sdkAccepted },
    compileFlags: COMPILE_FLAGS,
    sources,
    reproducibility: repro,
    productionHashes: 'inalterados (DXCORE_HOST_SHA256 e DXCORE_HELPER_SHA256 continuam null)',
    executed: false
  }
  writeFileSync(join(first.dir, 'diag-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  for (const v of manifest.variants) console.log(`variante diagnóstica ${v.id} (${v.creation}): ${v.size} bytes, SHA-256 ${v.sha256}`)
  console.log(`controle: produção ${first.control.productionIdentical ? 'idêntica' : 'DIFERENTE'}, testes ${first.control.testIdentical ? 'idêntica' : 'DIFERENTE'}`)
  console.log('Nada foi executado. Nada foi gravado fora de native/helper-host/build/test/diag*.')
}

main()

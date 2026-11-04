#!/usr/bin/env node
/**
 * Build do launcher nativo `gerpro-helper-host.exe` (x64) com MSVC v143 e
 * Windows SDK. Etapa 6C.6B.2 (D61; docs/10-ativacao-dxcore.md, seções 9–16).
 *
 *   node scripts/native/build-helper-host.mjs --check-toolchain [--accept-sdk=<versão>]
 *   node scripts/native/build-helper-host.mjs --confirm-native-build [--reproducibility-check] [--accept-sdk=<versão>]
 *
 * Rodar no ambiente x64 do MSVC v143 (`vcvarsall.bat x64 -vcvars_ver=14.44`).
 * O script:
 *
 * - usa o mesmo ambiente restrito e as mesmas opções do auxiliar
 *   (`msvc-toolchain.mjs`), mais `bcrypt.lib` e o manifesto `supportedOS`;
 * - compila o launcher e o binário de testes da lógica pura, mas NÃO executa
 *   nenhum dos dois;
 * - confere o binário (`checkHostBinary`): políticas comuns, lista EXPLÍCITA
 *   de importações, funções obrigatórias e proibidas, manifesto; apaga o
 *   launcher gerado se algo falhar;
 * - grava um manifesto sanitizado (sem caminhos, usuário, máquina ou data);
 * - NÃO altera `DXCORE_HOST_SHA256` nem `DXCORE_HELPER_SHA256`;
 * - NUNCA define `GERPRO_HOST_TEST_BUILD`: a variante de testes tem script
 *   próprio (`build-host-test-artifacts.mjs`) e saída fora de `resources/`.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCEPT_SDK, assertPlainDir as assertPlainDirWith, BASE_LINK_FLAGS, COMPILE_FLAGS, failer, forbiddenTexts, readToolchain, runCompiler, sha256 } from './msvc-toolchain.mjs'
import { checkHostBinary, checkVariantIdentity } from './pe-inspect.ts'

const CONFIRM = '--confirm-native-build'
const CHECK_TOOLCHAIN = '--check-toolchain'
const REPRO = '--reproducibility-check'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOST_DIR = join(ROOT, 'native', 'helper-host')
const BUILD_DIR = join(HOST_DIR, 'build')
const OUTPUT_DIR = join(ROOT, 'resources', 'helpers', 'win32-x64')
const HOST_NAME = 'gerpro-helper-host.exe'
const TESTS_NAME = 'protocol_tests.exe'

/** Fontes, relativos a HOST_DIR (caminhos relativos não entram no binário). */
const HOST_SOURCES = ['src\\main.cpp', 'src\\protocol.cpp', 'src\\integrity.cpp']
const TEST_SOURCES = ['tests\\protocol_tests.cpp', 'src\\protocol.cpp']
const HEADERS = ['src\\exit_codes.h', 'src\\protocol.h', 'src\\integrity.h']
const MANIFEST = 'src\\host.manifest'

const HOST_LINK_FLAGS = [...BASE_LINK_FLAGS, `/MANIFESTINPUT:${MANIFEST}`, 'kernel32.lib', 'bcrypt.lib']
const TEST_LINK_FLAGS = [...BASE_LINK_FLAGS, 'kernel32.lib']

const fail = failer('build-helper-host')
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

/** Só remove pastas próprias dentro de native/helper-host/build, sem seguir links. */
function freshBuildDir(name) {
  const dir = join(BUILD_DIR, name)
  if (!dir.startsWith(BUILD_DIR + sep) || !['x64', 'x64-repro'].includes(name)) fail('pasta de build fora do lugar.')
  assertPlainDir(HOST_DIR)
  assertPlainDir(BUILD_DIR)
  assertPlainDir(dir)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'obj'), { recursive: true })
  assertPlainDir(dir)
  return dir
}

function compile(toolchain, sources, objDir, linkFlags, output) {
  runCompiler(toolchain, [...COMPILE_FLAGS, `/Fo${objDir}\\`, ...sources, '/link', ...linkFlags, `/OUT:${output}`], HOST_DIR, fail)
}

function buildOnce(toolchain, name) {
  const dir = freshBuildDir(name)
  const host = join(dir, HOST_NAME)
  const tests = join(dir, TESTS_NAME)
  compile(toolchain, HOST_SOURCES, join(dir, 'obj'), HOST_LINK_FLAGS, host)
  compile(toolchain, TEST_SOURCES, join(dir, 'obj'), TEST_LINK_FLAGS, tests)
  return { host, tests }
}

function main() {
  const { checkOnly, reproducibility, acceptSdk } = readArgs(process.argv)
  const toolchain = readToolchain(acceptSdk, ['jobapi2.h', 'processthreadsapi.h'], fail)
  if (checkOnly) {
    console.log(`MSVC ${toolchain.vcToolsVersion}, Windows SDK ${toolchain.sdkVersion}: cl.exe, link.exe, jobapi2.h e processthreadsapi.h encontrados.`)
    console.log('Nada foi compilado.')
    return
  }

  const first = buildOnce(toolchain, 'x64')
  const hostBytes = readFileSync(first.host)
  const { issues, report, unexpectedFunctions } = checkHostBinary(hostBytes, forbiddenTexts(ROOT))
  // Variante de PRODUÇÃO: nunca os nomes da variante de testes (6C.6C.1).
  issues.push(...checkVariantIdentity(hostBytes, 'production'))
  if (issues.length > 0) {
    rmSync(first.host, { force: true })
    // Nomes de funções importadas não são dados sensíveis: ajudam a revisar a lista explícita.
    if (unexpectedFunctions.length > 0) console.error(`importações fora da lista: ${unexpectedFunctions.join(', ')}`)
    fail(`o binário não atende à política e foi apagado: ${issues.join(', ')}`)
  }

  let repro = null
  if (reproducibility) {
    const second = buildOnce(toolchain, 'x64-repro')
    const hostA = sha256(hostBytes)
    const hostB = sha256(readFileSync(second.host))
    const testsA = sha256(readFileSync(first.tests))
    const testsB = sha256(readFileSync(second.tests))
    repro = { builds: 2, identical: hostA === hostB, testsIdentical: testsA === testsB }
    if (!repro.identical || !repro.testsIdentical) fail('dois builds limpos produziram binários diferentes: não reproduzível.')
  }

  mkdirSync(OUTPUT_DIR, { recursive: true })
  assertPlainDir(OUTPUT_DIR)
  const output = join(OUTPUT_DIR, HOST_NAME)
  if (existsSync(output) && !lstatSync(output).isFile()) fail('destino do launcher não é um arquivo comum; recusado.')
  writeFileSync(output, hostBytes)

  const sources = [...HOST_SOURCES, ...HEADERS, MANIFEST, 'tests\\protocol_tests.cpp'].map((file) => ({
    file: file.replaceAll('\\', '/'),
    sha256: sha256(readFileSync(join(HOST_DIR, file)))
  }))
  const manifest = {
    host: HOST_NAME,
    helper: 'gerpro-dxcore-helper.exe',
    protocol: 'gerpro.helper-host',
    exitCodes: '20-29 (docs/10, 11.6)',
    target: 'win32-x64',
    toolchain: { msvc: toolchain.vcToolsVersion, windowsSdk: toolchain.sdkVersion, sdkOutsideReference: toolchain.sdkAccepted },
    compileFlags: COMPILE_FLAGS,
    linkFlags: HOST_LINK_FLAGS,
    sources,
    binary: { size: hostBytes.length, sha256: sha256(hostBytes) },
    tests: { file: TESTS_NAME, sha256: sha256(readFileSync(first.tests)) },
    pe: report && {
      machine: `0x${report.machine.toString(16)}`,
      subsystem: report.subsystem,
      dllCharacteristics: `0x${report.dllCharacteristics.toString(16)}`,
      guardFlags: report.guardFlags === null ? null : `0x${report.guardFlags.toString(16)}`,
      cetCompat: report.cetCompat,
      dependentLoadFlags: report.dependentLoadFlags === null ? null : `0x${report.dependentLoadFlags.toString(16)}`,
      executionLevel: report.manifest?.executionLevel ?? null,
      uiAccess: report.manifest?.uiAccess ?? null,
      supportedOs: report.supportedOs,
      imports: report.imports,
      importFunctions: report.importFunctions
    },
    jobLimits: { killOnJobClose: true, activeProcessLimit: 1, dieOnUnhandledException: true, memory: 'pendente (T-M1)' },
    reproducibility: repro,
    signature: 'não assinado',
    appHash: 'não aplicado (DXCORE_HOST_SHA256 e DXCORE_HELPER_SHA256 continuam null)',
    executed: false
  }
  writeFileSync(join(BUILD_DIR, 'x64', 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`launcher: ${relative(ROOT, output)}`)
  console.log(`testes da lógica pura (não executados por este script): ${relative(ROOT, first.tests)}`)
  console.log(`SHA-256: ${manifest.binary.sha256}`)
  console.log('O hash NÃO foi aplicado ao app. Nada foi executado.')
}

main()

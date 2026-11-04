#!/usr/bin/env node
/**
 * Build do auxiliar DXCore (`gerpro-dxcore-helper.exe`, x64) com MSVC e
 * Windows SDK. Preparado na Etapa 6C.3B.1; só deve ser executado com
 * autorização (6C.3B.2).
 *
 *   node scripts/native/build-dxcore-helper.mjs --check-toolchain [--accept-sdk=<versão>]
 *   node scripts/native/build-dxcore-helper.mjs --confirm-native-build [--reproducibility-check] [--accept-sdk=<versão>]
 *
 * Rodar no ambiente x64 do MSVC v143 ("x64 Native Tools Command Prompt for
 * VS 2022", ou `vcvarsall.bat x64 -vcvars_ver=14.44` no Build Tools 2026); o
 * ambiente do MSVC e do SDK vem das variáveis desse prompt. O script:
 *
 * - exige MSVC v143 (14.30 a 14.4x; com o Build Tools 2026, abrir o ambiente
 *   com `vcvarsall.bat x64 -vcvars_ver=14.44`), Windows SDK (10.0.26100.x, salvo `--accept-sdk` explícito) e
 *   os headers oficiais `dxcore.h`/`dxcore_interface.h`; não instala nada;
 * - `--check-toolchain`: só confere o ambiente (versões, cl.exe, link.exe,
 *   headers do DXCore) e sai, sem compilar nem criar nada;
 * - chama só o `cl.exe` do MSVC, por caminho absoluto, sem shell; o processo
 *   recebe um ambiente restrito (PATH só com MSVC, SDK e System32), então o
 *   `link.exe` nunca vem do MSYS2 ou de outra pasta do usuário;
 * - recusa pastas do MSVC/SDK com junção ou link, e só apaga ou grava em
 *   pastas próprias que não sejam links;
 * - compila o auxiliar e o binário de testes do serializador, mas NÃO executa
 *   nenhum dos dois;
 * - confere arquitetura e propriedades do binário (`pe-inspect.ts`) e apaga o
 *   auxiliar gerado se alguma falhar;
 * - grava um manifesto sanitizado (sem caminhos, usuário, máquina ou data);
 * - NÃO altera `DXCORE_HELPER_SHA256`: aplicar o hash é uma mudança de código
 *   separada, revisada.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACCEPT_SDK,
  assertPlainDir as assertPlainDirWith,
  BASE_LINK_FLAGS,
  COMPILE_FLAGS,
  failer,
  forbiddenTexts,
  readToolchain as readToolchainWith,
  runCompiler as runCompilerWith,
  sha256
} from './msvc-toolchain.mjs'
import { checkHelperBinary } from './pe-inspect.ts'

const CONFIRM = '--confirm-native-build'
const CHECK_TOOLCHAIN = '--check-toolchain'
const REPRO = '--reproducibility-check'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HELPER_DIR = join(ROOT, 'native', 'dxcore-helper')
const BUILD_DIR = join(HELPER_DIR, 'build')
const OUTPUT_DIR = join(ROOT, 'resources', 'helpers', 'win32-x64')
const HELPER_NAME = 'gerpro-dxcore-helper.exe'
const TESTS_NAME = 'serializer_tests.exe'

/** Fontes, relativos a HELPER_DIR (caminhos relativos não entram no binário). */
const HELPER_SOURCES = ['src\\main.cpp', 'src\\dxcore_loader.cpp', 'src\\adapters.cpp', 'src\\description.cpp', 'src\\json_writer.cpp']
const TEST_SOURCES = ['tests\\serializer_tests.cpp', 'src\\description.cpp', 'src\\json_writer.cpp']
const HEADERS = ['src\\adapters.h', 'src\\description.h', 'src\\dxcore_loader.h', 'src\\json_writer.h']

/** Mesmas opções de sempre (agora em msvc-toolchain.mjs); a ordem e o conteúdo não mudaram. */
const LINK_FLAGS = [...BASE_LINK_FLAGS, 'kernel32.lib']

const fail = failer('build-dxcore-helper')

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

/** Ambiente do MSVC e do SDK, com os headers oficiais do DXCore. */
const readToolchain = (acceptSdk) => readToolchainWith(acceptSdk, ['dxcore.h', 'dxcore_interface.h'], fail)
const assertPlainDir = (dir) => assertPlainDirWith(dir, fail)
const runCompiler = (toolchain, args) => runCompilerWith(toolchain, args, HELPER_DIR, fail)

/** Só remove pastas próprias dentro de native/dxcore-helper/build, sem seguir links. */
function freshBuildDir(name) {
  const dir = join(BUILD_DIR, name)
  if (!dir.startsWith(BUILD_DIR + sep) || !['x64', 'x64-repro'].includes(name)) fail('pasta de build fora do lugar.')
  assertPlainDir(HELPER_DIR)
  assertPlainDir(BUILD_DIR)
  assertPlainDir(dir)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'obj'), { recursive: true })
  assertPlainDir(dir)
  return dir
}

function compile(toolchain, sources, objDir, output) {
  runCompiler(toolchain, [...COMPILE_FLAGS, `/Fo${objDir}\\`, ...sources, '/link', ...LINK_FLAGS, `/OUT:${output}`])
}

function buildOnce(toolchain, name) {
  const dir = freshBuildDir(name)
  const helper = join(dir, HELPER_NAME)
  const tests = join(dir, TESTS_NAME)
  compile(toolchain, HELPER_SOURCES, join(dir, 'obj'), helper)
  compile(toolchain, TEST_SOURCES, join(dir, 'obj'), tests)
  return { helper, tests }
}

function main() {
  const { checkOnly, reproducibility, acceptSdk } = readArgs(process.argv)
  const toolchain = readToolchain(acceptSdk)
  if (checkOnly) {
    // Só confere o ambiente: nada é compilado, criado ou apagado.
    console.log(`MSVC ${toolchain.vcToolsVersion}, Windows SDK ${toolchain.sdkVersion}: cl.exe, link.exe, dxcore.h e dxcore_interface.h encontrados.`)
    console.log('Nada foi compilado.')
    return
  }

  const first = buildOnce(toolchain, 'x64')
  const helperBytes = readFileSync(first.helper)
  const { issues, report } = checkHelperBinary(helperBytes, forbiddenTexts(ROOT))
  if (issues.length > 0) {
    rmSync(first.helper, { force: true })
    fail(`o binário não atende à política e foi apagado: ${issues.join(', ')}`)
  }

  let repro = null
  if (reproducibility) {
    const second = buildOnce(toolchain, 'x64-repro')
    const a = sha256(helperBytes)
    const b = sha256(readFileSync(second.helper))
    repro = { builds: 2, identical: a === b }
    if (!repro.identical) fail('dois builds limpos produziram binários diferentes: não reproduzível.')
  }

  mkdirSync(OUTPUT_DIR, { recursive: true })
  assertPlainDir(OUTPUT_DIR)
  const output = join(OUTPUT_DIR, HELPER_NAME)
  if (existsSync(output) && !lstatSync(output).isFile()) fail('destino do auxiliar não é um arquivo comum; recusado.')
  writeFileSync(output, helperBytes)

  const sources = [...HELPER_SOURCES, ...HEADERS, 'tests\\serializer_tests.cpp'].map((file) => ({
    file: file.replaceAll('\\', '/'),
    sha256: sha256(readFileSync(join(HELPER_DIR, file)))
  }))
  const manifest = {
    helper: HELPER_NAME,
    protocol: 'gerpro.dxcore-adapters',
    protocolVersion: 1,
    target: 'win32-x64',
    toolchain: { msvc: toolchain.vcToolsVersion, windowsSdk: toolchain.sdkVersion, sdkOutsideReference: toolchain.sdkAccepted },
    compileFlags: COMPILE_FLAGS,
    linkFlags: LINK_FLAGS,
    sources,
    binary: { size: helperBytes.length, sha256: sha256(helperBytes) },
    pe: report && {
      machine: `0x${report.machine.toString(16)}`,
      subsystem: report.subsystem,
      dllCharacteristics: `0x${report.dllCharacteristics.toString(16)}`,
      cetCompat: report.cetCompat,
      dependentLoadFlags: report.dependentLoadFlags === null ? null : `0x${report.dependentLoadFlags.toString(16)}`,
      executionLevel: report.manifest?.executionLevel ?? null,
      uiAccess: report.manifest?.uiAccess ?? null,
      imports: report.imports
    },
    reproducibility: repro,
    signature: 'não assinado',
    appHash: 'não aplicado (DXCORE_HELPER_SHA256 continua como está)',
    testsExecuted: false
  }
  writeFileSync(join(BUILD_DIR, 'x64', 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`auxiliar: ${relative(ROOT, output)}`)
  console.log(`testes do serializador (não executados): ${relative(ROOT, first.tests)}`)
  console.log(`SHA-256: ${manifest.binary.sha256}`)
  console.log('O hash NÃO foi aplicado ao app. Nada foi executado.')
}

main()

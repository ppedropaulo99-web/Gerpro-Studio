#!/usr/bin/env node
/**
 * Build do `gerpro-lock-holder-test.exe`, artefato SÓ DE TESTE (Etapa
 * 6C.6C.3F; docs/11, seção 20), de `native/lock-holder-test/src/main.cpp`.
 *
 *   node scripts/native/build-lock-holder-test.mjs --check-toolchain [--accept-sdk=<versão>]
 *   node scripts/native/build-lock-holder-test.mjs --confirm-native-build [--reproducibility-check] [--accept-sdk=<versão>]
 *
 * O script:
 * - grava SÓ em `native/lock-holder-test/build/` (fora do git, fora de
 *   `resources/`, fora de qualquer empacotamento);
 * - NÃO executa o que compila (o único processo criado é o cl.exe);
 * - recusa (e apaga) o binário fora da política (`checkLockHolderBinary`: só
 *   KERNEL32, lista explícita, proibições, mitigações, manifesto asInvoker,
 *   identidade, nenhum caminho do projeto ou do usuário embutido);
 * - recusa resumo igual ao de qualquer launcher, alvo sintético ou auxiliar
 *   já compilado nesta máquina;
 * - não altera nenhum outro artefato nem `DXCORE_HOST_SHA256` e
 *   `DXCORE_HELPER_SHA256`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCEPT_SDK, assertPlainDir as assertPlainDirWith, BASE_LINK_FLAGS, COMPILE_FLAGS, failer, forbiddenTexts, isFile, readToolchain, runCompiler, sha256 } from './msvc-toolchain.mjs'
import { checkLockHolderBinary } from './pe-inspect.ts'

const CONFIRM = '--confirm-native-build'
const CHECK_TOOLCHAIN = '--check-toolchain'
const REPRO = '--reproducibility-check'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOLDER_DIR = join(ROOT, 'native', 'lock-holder-test')
const BUILD_DIR = join(HOLDER_DIR, 'build')
const LOCK_HOLDER_NAME = 'gerpro-lock-holder-test.exe'

const SOURCES = ['src\\main.cpp']
const HEADERS = ['src\\exit_codes.h']
const MANIFEST = 'src\\lock_holder.manifest'
const LINK_FLAGS = [...BASE_LINK_FLAGS, `/MANIFESTINPUT:${MANIFEST}`, 'kernel32.lib']

/** Pastas com binários nativos já compilados: nenhum pode ter o mesmo resumo do segurador. */
const OTHER_BINARY_DIRS = [join(ROOT, 'resources', 'helpers'), join(ROOT, 'native', 'helper-host', 'build'), join(ROOT, 'native', 'dxcore-helper', 'build')]

const fail = failer('build-lock-holder-test')
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

/** Só remove as pastas próprias dentro de native/lock-holder-test/build, sem seguir links. */
function freshBuildDir(name) {
  const dir = join(BUILD_DIR, name)
  if (!dir.startsWith(BUILD_DIR + sep) || !['x64', 'x64-repro'].includes(name)) fail('pasta de build fora do lugar.')
  for (const parent of [HOLDER_DIR, BUILD_DIR, dir]) assertPlainDir(parent)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'obj'), { recursive: true })
  assertPlainDir(dir)
  return dir
}

/** Resumos de todos os .exe já compilados nas outras pastas nativas (sem seguir links). */
function otherBinaryDigests() {
  const digests = new Set()
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe') && isFile(path)) digests.add(sha256(readFileSync(path)))
    }
  }
  for (const dir of OTHER_BINARY_DIRS) walk(dir, 0)
  return digests
}

function buildOnce(toolchain, name, forbidden) {
  const dir = freshBuildDir(name)
  const out = join(dir, LOCK_HOLDER_NAME)
  runCompiler(toolchain, [...COMPILE_FLAGS, `/Fo${join(dir, 'obj')}\\`, ...SOURCES, '/link', ...LINK_FLAGS, `/OUT:${out}`], HOLDER_DIR, fail)
  const bytes = readFileSync(out)
  const { issues, unexpectedFunctions, report } = checkLockHolderBinary(bytes, forbidden)
  if (issues.length > 0) {
    rmSync(out, { force: true })
    if (unexpectedFunctions.length > 0) console.error(`importações fora da lista: ${unexpectedFunctions.join(', ')}`)
    fail(`${relative(ROOT, out)} não atende à política e foi apagado: ${issues.join(', ')}`)
  }
  return { dir, out, bytes, report }
}

function main() {
  const { checkOnly, reproducibility, acceptSdk } = readArgs(process.argv)
  const toolchain = readToolchain(acceptSdk, ['fileapi.h', 'memoryapi.h', 'namedpipeapi.h'], fail)
  if (checkOnly) {
    console.log(`MSVC ${toolchain.vcToolsVersion}, Windows SDK ${toolchain.sdkVersion}: ferramentas e headers encontrados.`)
    console.log('Nada foi compilado.')
    return
  }
  const forbidden = forbiddenTexts(ROOT)
  const first = buildOnce(toolchain, 'x64', forbidden)
  const digest = sha256(first.bytes)
  if (otherBinaryDigests().has(digest)) {
    rmSync(first.out, { force: true })
    fail('o segurador é idêntico a outro binário nativo desta máquina; recusado.')
  }

  let repro = null
  if (reproducibility) {
    const second = buildOnce(toolchain, 'x64-repro', forbidden)
    repro = { builds: 2, identical: Buffer.compare(first.bytes, second.bytes) === 0, secondSha256: sha256(second.bytes) }
    if (!repro.identical) fail('dois builds limpos produziram binários diferentes: não reproduzível.')
  }

  const sources = [...SOURCES, ...HEADERS, MANIFEST].map((file) => ({ file: file.replaceAll('\\', '/'), sha256: sha256(readFileSync(join(HOLDER_DIR, file))) }))
  const r = first.report
  const manifest = {
    purpose: 'artefato SÓ DE TESTE (6C.6C.3F): segura as travas do launcher para T-F1, T-F2 e T-F4; nunca distribuído; nunca usado pelo app',
    file: LOCK_HOLDER_NAME,
    protocol: '--mode=<file|mapping|directory> --case-dir=<pasta temporária>\\gerpro-6c6c-<sufixo>\\<NN>-T-F<1|2|4>.<id>',
    size: first.bytes.length,
    sha256: digest,
    pe: r && {
      dllCharacteristics: `0x${r.dllCharacteristics.toString(16)}`,
      guardFlags: r.guardFlags === null ? null : `0x${r.guardFlags.toString(16)}`,
      cetCompat: r.cetCompat,
      dependentLoadFlags: r.dependentLoadFlags === null ? null : `0x${r.dependentLoadFlags.toString(16)}`,
      executionLevel: r.manifest?.executionLevel ?? null,
      uiAccess: r.manifest?.uiAccess ?? null,
      supportedOs: r.supportedOs,
      imports: r.imports,
      importFunctions: r.importFunctions
    },
    toolchain: { msvc: toolchain.vcToolsVersion, windowsSdk: toolchain.sdkVersion, sdkOutsideReference: toolchain.sdkAccepted },
    compileFlags: COMPILE_FLAGS,
    linkFlags: LINK_FLAGS,
    sources,
    reproducibility: repro,
    productionHashes: 'inalterados (DXCORE_HOST_SHA256 e DXCORE_HELPER_SHA256 continuam null)',
    executed: false
  }
  writeFileSync(join(first.dir, 'lock-holder-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`segurador de travas: ${relative(ROOT, first.out)}  ${first.bytes.length} bytes  SHA-256 ${digest}`)
  if (repro) console.log(`reprodutibilidade: 2 builds limpos, idênticos byte a byte: ${repro.identical}`)
  console.log('Nada foi executado. Nada foi gravado fora de native/lock-holder-test/build.')
}

main()

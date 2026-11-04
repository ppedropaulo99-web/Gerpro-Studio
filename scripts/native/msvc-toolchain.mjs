/**
 * Ambiente MSVC v143 + Windows SDK compartilhado pelos builds nativos
 * (`build-dxcore-helper.mjs` e `build-helper-host.mjs`). Extraído sem mudança
 * de comportamento do script do auxiliar (6C.3B.1) na Etapa 6C.6B.2.
 *
 * Nada aqui instala, compila ou executa: só lê variáveis do prompt do Visual
 * Studio, confere pastas e monta o ambiente restrito do compilador.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export const EXPECTED_SDK_PREFIX = '10.0.26100.'
/** Conjunto de ferramentas MSVC v143 (14.30 a 14.4x). O Build Tools 2026 traz outros (14.5x) como padrão. */
export const MSVC_V143 = /^14\.(3\d|4\d)\.\d+$/
export const ACCEPT_SDK = '--accept-sdk='

/** Opções de compilação comuns aos binários nativos (as do auxiliar desde a 6C.3B.2B). */
export const COMPILE_FLAGS = Object.freeze([
  '/nologo',
  '/std:c++17',
  '/permissive-',
  '/W4',
  '/WX',
  '/O2',
  '/GS',
  '/sdl',
  '/guard:cf',
  '/MT',
  '/EHs-c-',
  '/GR-',
  '/utf-8',
  '/Brepro',
  '/DUNICODE',
  '/D_UNICODE',
  '/DWIN32_LEAN_AND_MEAN',
  '/D_WIN32_WINNT=0x0A00',
  '/DWINVER=0x0A00',
  '/D_HAS_EXCEPTIONS=0'
])

/** Opções de ligação comuns (sem as bibliotecas, que cada binário declara). */
export const BASE_LINK_FLAGS = Object.freeze([
  '/SUBSYSTEM:CONSOLE',
  '/DYNAMICBASE',
  '/HIGHENTROPYVA',
  '/NXCOMPAT',
  '/GUARD:CF',
  '/CETCOMPAT',
  '/DEPENDENTLOADFLAG:0x800',
  '/INCREMENTAL:NO',
  '/OPT:REF',
  '/OPT:ICF',
  '/Brepro',
  '/DEBUG:NONE',
  '/MANIFEST:EMBED',
  "/MANIFESTUAC:level='asInvoker' uiAccess='false'"
])

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Função de falha com o prefixo do script. */
export const failer = (prefix) => (message, code = 1) => {
  console.error(`${prefix}: ${message}`)
  process.exit(code)
}

export const sameDir = (a, b) => a.replace(/\\+$/, '').toLowerCase() === b.replace(/\\+$/, '').toLowerCase()

export const isFile = (file) => existsSync(file) && lstatSync(file).isFile()

/**
 * Pasta de ferramenta vinda do ambiente: caminho local absoluto, sem `..`,
 * existente e sem junção ou link no caminho (o caminho real é o mesmo).
 */
export function trustedToolDir(value, label, fail) {
  if (!/^[A-Za-z]:\\/.test(value) || value.split(/[\\/]/).includes('..')) fail(`${label} não é um caminho local absoluto.`)
  if (!existsSync(value) || !statSync(value).isDirectory()) fail(`${label} não existe.`)
  if (!sameDir(realpathSync.native(value), value)) fail(`${label} passa por junção ou link; recusado.`)
  return value
}

/**
 * Ambiente do MSVC e do SDK, só das variáveis do prompt do Visual Studio.
 * Nada é procurado no PATH. `requiredHeaders`: headers de `um\` que têm de
 * existir no SDK.
 */
export function readToolchain(acceptSdk, requiredHeaders, fail) {
  if (process.platform !== 'win32') fail('só no Windows.')
  const env = process.env
  const required = ['VCToolsInstallDir', 'VCToolsVersion', 'WindowsSdkDir', 'WindowsSDKVersion', 'INCLUDE', 'LIB', 'SystemRoot']
  const missing = required.filter((name) => !env[name])
  if (missing.length > 0) fail(`MSVC/Windows SDK não encontrados (${missing.join(', ')}). Abra o ambiente x64 do MSVC v143 (vcvarsall.bat x64 -vcvars_ver=14.44). Nada é instalado por este script.`)
  if (env.VSCMD_ARG_TGT_ARCH !== 'x64') fail('o prompt não é x64 (VSCMD_ARG_TGT_ARCH).')
  if (env.VSCMD_ARG_HOST_ARCH !== 'x64') fail('o compilador hospedeiro não é x64 (VSCMD_ARG_HOST_ARCH).')
  if (!/^14\.\d+\.\d+$/.test(env.VCToolsVersion)) fail('versão do MSVC em formato inesperado.')
  if (!MSVC_V143.test(env.VCToolsVersion)) fail(`MSVC ${env.VCToolsVersion} não é v143 (14.30 a 14.4x). Abra o ambiente com vcvarsall.bat x64 -vcvars_ver=14.44.`)

  const sdkVersion = env.WindowsSDKVersion.replace(/\\$/, '')
  if (!/^10\.0\.\d+\.\d+$/.test(sdkVersion)) fail('versão do Windows SDK em formato inesperado.')
  if (!sdkVersion.startsWith(EXPECTED_SDK_PREFIX) && sdkVersion !== acceptSdk) {
    fail(`Windows SDK ${sdkVersion}; a referência é ${EXPECTED_SDK_PREFIX}x. Outra versão só com ${ACCEPT_SDK}${sdkVersion}.`)
  }
  const vcDir = trustedToolDir(env.VCToolsInstallDir, 'VCToolsInstallDir', fail)
  // A pasta das ferramentas tem de ser a da versão declarada (MSVC/<VCToolsVersion>).
  if (basename(resolve(vcDir)) !== env.VCToolsVersion) fail('VCToolsInstallDir não corresponde a VCToolsVersion.')
  const sdkDir = trustedToolDir(env.WindowsSdkDir, 'WindowsSdkDir', fail)

  const um = join(sdkDir, 'Include', sdkVersion, 'um')
  for (const header of requiredHeaders) {
    if (!isFile(join(um, header))) fail(`header oficial ${header} ausente do Windows SDK ${sdkVersion}.`)
  }
  // cl.exe e link.exe da mesma pasta do MSVC; o PATH do processo filho só
  // contém pastas do MSVC, do SDK e do sistema (nada do MSYS2 nem do usuário).
  const msvcBin = join(vcDir, 'bin', 'Hostx64', 'x64')
  const cl = join(msvcBin, 'cl.exe')
  for (const tool of ['cl.exe', 'link.exe']) if (!isFile(join(msvcBin, tool))) fail(`${tool} x64 não encontrado em VCToolsInstallDir.`)
  const sdkBin = join(sdkDir, 'bin', sdkVersion, 'x64')
  const systemRoot = env.SystemRoot
  const childEnv = {
    SystemRoot: systemRoot,
    windir: systemRoot,
    PATH: [msvcBin, ...(existsSync(sdkBin) ? [sdkBin] : []), join(systemRoot, 'System32')].join(';'),
    INCLUDE: env.INCLUDE,
    LIB: env.LIB,
    ...(env.LIBPATH ? { LIBPATH: env.LIBPATH } : {}),
    TEMP: env.TEMP ?? '',
    TMP: env.TMP ?? env.TEMP ?? ''
  }
  return { cl, childEnv, vcToolsVersion: env.VCToolsVersion, sdkVersion, sdkAccepted: !sdkVersion.startsWith(EXPECTED_SDK_PREFIX) }
}

/** A pasta (se existir) não é link nem junção, e o caminho real é o esperado. */
export function assertPlainDir(dir, fail) {
  if (!existsSync(dir)) return
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory() || !sameDir(realpathSync.native(dir), dir)) fail('pasta de saída é link, junção ou não é pasta; recusado.')
}

/** Única forma de chamar o compilador: o cl.exe do MSVC, sem shell e com ambiente restrito. */
export function runCompiler(toolchain, args, cwd, fail) {
  const result = spawnSync(toolchain.cl, args, { cwd, shell: false, windowsHide: true, stdio: 'inherit', env: toolchain.childEnv })
  if (result.error || result.status !== 0) fail('a compilação falhou (saída do compilador acima).')
}

/** Textos que não podem aparecer nos binários: pasta do projeto e do usuário. */
export function forbiddenTexts(root) {
  return [root, process.env.USERPROFILE, process.env.USERNAME ? `\\${process.env.USERNAME}\\` : undefined].filter((t) => typeof t === 'string')
}

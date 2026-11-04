/**
 * Leitura estática de um executável PE (só bytes; nada é executado) e
 * conferência das propriedades exigidas do auxiliar DXCore (D56, 6C.3B.1).
 *
 * Usada pelo script de build depois da compilação e testada com binários
 * sintéticos. Qualquer estrutura fora dos limites do arquivo recusa o binário.
 */

export const PE_MACHINE_X64 = 0x8664
export const PE32_PLUS_MAGIC = 0x20b
export const SUBSYSTEM_WINDOWS_CUI = 3

export const FILE_CHARACTERISTICS = { executableImage: 0x0002, dll: 0x2000 } as const

export const DLL_CHARACTERISTICS = {
  highEntropyVa: 0x0020,
  dynamicBase: 0x0040,
  nxCompat: 0x0100,
  guardCf: 0x4000
} as const

/** `IMAGE_DEBUG_TYPE_EX_DLLCHARACTERISTICS` e o bit `CET_COMPAT`. */
export const DEBUG_TYPE_EX_DLLCHARACTERISTICS = 20
export const EX_DLLCHARACTERISTICS_CET_COMPAT = 0x01

/** `LOAD_LIBRARY_SEARCH_SYSTEM32`, gravado por `/DEPENDENTLOADFLAG:0x800`. */
export const LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x800

/**
 * Deslocamentos em `IMAGE_LOAD_CONFIG_DIRECTORY64` (winnt.h): `DependentLoadFlags`
 * (WORD) e `GuardFlags` (DWORD). A conferir com `dumpbin /loadconfig` no
 * primeiro build (6C.3B.2): erro aqui recusa o binário, nunca o aceita.
 */
export const LOAD_CONFIG_OFFSETS = { dependentLoadFlags: 0x4e, guardFlags: 0x90 } as const
export const GUARD_CF_INSTRUMENTED = 0x100

/** Faixa de tamanho aceita pelo executor (`DXCORE_HELPER.minFileBytes/maxFileBytes`). */
export const HELPER_SIZE = { min: 1_024, max: 8 * 1_048_576 } as const

/** Únicas DLLs que o auxiliar pode importar estaticamente (`dxcore.dll` é carregada em tempo de execução). */
export const ALLOWED_IMPORTS = ['kernel32.dll'] as const

const DIRECTORY = { import: 1, resource: 2, debug: 6, loadConfig: 10 } as const
const MAX_IMPORTS = 64
const MAX_IMPORT_FUNCTIONS = 2_048
const MAX_DEBUG_ENTRIES = 32
const MAX_RESOURCE_ENTRIES = 64
const MAX_MANIFEST_BYTES = 65_536
/** `RT_MANIFEST`. */
export const RESOURCE_TYPE_MANIFEST = 24

/** Nível de execução pedido no manifesto embutido (`requestedExecutionLevel`). */
export interface ManifestInfo {
  executionLevel: string | null
  uiAccess: string | null
}

/** Lê `requestedExecutionLevel` do manifesto (texto XML); atributos com aspas simples ou duplas. */
/** Identificadores `supportedOS` do manifesto (minúsculos, sem chaves). */
export function parseSupportedOs(text: string): string[] {
  return [...text.matchAll(/<(?:\w+:)?supportedOS\b[^>]*\bId\s*=\s*(['"])\{?([0-9a-fA-F-]{36})\}?\1/g)].map((m) => m[2]!.toLowerCase())
}

export function parseManifest(text: string): ManifestInfo {
  const element = text.match(/<(?:\w+:)?requestedExecutionLevel\b([^>]*)>/i)?.[1] ?? null
  if (element === null) return { executionLevel: null, uiAccess: null }
  const attribute = (name: string) => element.match(new RegExp(`\\b${name}\\s*=\\s*(['"])([^'"]*)\\1`))?.[2] ?? null
  return { executionLevel: attribute('level'), uiAccess: attribute('uiAccess') }
}

export interface PeReport {
  machine: number
  magic: number
  subsystem: number
  characteristics: number
  dllCharacteristics: number
  /** `null`: sem entrada de características estendidas no diretório de depuração. */
  cetCompat: boolean | null
  /** `null`: sem diretório de configuração de carga, ou menor que o campo. */
  dependentLoadFlags: number | null
  guardFlags: number | null
  imports: string[]
  /**
   * Funções importadas por DLL (nome da DLL em minúsculas). Importação por
   * ordinal aparece como `#<número>`.
   */
  importFunctions: Record<string, string[]>
  /** `null`: sem recurso de manifesto. */
  manifest: ManifestInfo | null
  /** `supportedOS` do manifesto; `null`: sem manifesto. */
  supportedOs: string[] | null
}

export type PeInspection = { ok: true; report: PeReport } | { ok: false; reason: 'not-pe' | 'malformed' }

class Malformed extends Error {}

/** Lê o PE. Nunca lança exceção; estrutura inconsistente é `malformed`. */
export function inspectPe(bytes: Buffer): PeInspection {
  try {
    if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) return { ok: false, reason: 'not-pe' }
    const pe = bytes.readUInt32LE(0x3c)
    if (pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550) return { ok: false, reason: 'not-pe' }
    const u16 = (offset: number) => {
      if (offset < 0 || offset + 2 > bytes.length) throw new Malformed()
      return bytes.readUInt16LE(offset)
    }
    const u32 = (offset: number) => {
      if (offset < 0 || offset + 4 > bytes.length) throw new Malformed()
      return bytes.readUInt32LE(offset)
    }

    const machine = u16(pe + 4)
    const sectionCount = u16(pe + 6)
    const optionalSize = u16(pe + 20)
    const characteristics = u16(pe + 22)
    const optional = pe + 24
    const magic = u16(optional)
    if (magic !== PE32_PLUS_MAGIC) {
      return {
        ok: true,
        report: { machine, magic, subsystem: 0, characteristics, dllCharacteristics: 0, cetCompat: null, dependentLoadFlags: null, guardFlags: null, imports: [], importFunctions: {}, manifest: null, supportedOs: null }
      }
    }
    const subsystem = u16(optional + 68)
    const dllCharacteristics = u16(optional + 70)
    const directoryCount = u32(optional + 108)
    if (optionalSize < 112 + directoryCount * 8) throw new Malformed()
    const directory = (index: number) => (index < directoryCount ? { rva: u32(optional + 112 + index * 8), size: u32(optional + 116 + index * 8) } : { rva: 0, size: 0 })

    const sectionTable = optional + optionalSize
    const sections = Array.from({ length: sectionCount }, (_, i) => {
      const s = sectionTable + i * 40
      return { virtualSize: u32(s + 8), virtualAddress: u32(s + 12), rawSize: u32(s + 16), rawPointer: u32(s + 20) }
    })
    const offsetOf = (rva: number): number => {
      for (const s of sections) {
        const span = Math.max(s.virtualSize, s.rawSize)
        if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
          const offset = s.rawPointer + (rva - s.virtualAddress)
          if (rva - s.virtualAddress >= s.rawSize || offset >= bytes.length) throw new Malformed()
          return offset
        }
      }
      throw new Malformed()
    }
    const asciiz = (offset: number) => {
      let end = offset
      while (end < bytes.length && bytes[end] !== 0 && end - offset < 256) end++
      if (end >= bytes.length || bytes[end] !== 0) throw new Malformed()
      return bytes.toString('latin1', offset, end)
    }

    const imports: string[] = []
    const importFunctions: Record<string, string[]> = {}
    const importDir = directory(DIRECTORY.import)
    if (importDir.rva !== 0) {
      const base = offsetOf(importDir.rva)
      for (let i = 0; ; i++) {
        if (i >= MAX_IMPORTS) throw new Malformed()
        const entry = base + i * 20
        const nameRva = u32(entry + 12)
        if (nameRva === 0 && u32(entry) === 0 && u32(entry + 16) === 0) break
        const dll = asciiz(offsetOf(nameRva))
        imports.push(dll)
        // Tabela de nomes (OriginalFirstThunk) ou, sem ela, a de endereços
        // (FirstThunk, ainda não resolvida no arquivo). Entradas de 64 bits.
        const thunkRva = u32(entry) !== 0 ? u32(entry) : u32(entry + 16)
        const names: string[] = []
        if (thunkRva !== 0) {
          const thunks = offsetOf(thunkRva)
          for (let j = 0; ; j++) {
            if (j >= MAX_IMPORT_FUNCTIONS) throw new Malformed()
            const low = u32(thunks + j * 8)
            const high = u32(thunks + j * 8 + 4)
            if (low === 0 && high === 0) break
            if ((high & 0x8000_0000) !== 0) names.push(`#${low & 0xffff}`)
            else if (high !== 0) throw new Malformed()
            else names.push(asciiz(offsetOf(low & 0x7fff_ffff) + 2))
          }
        }
        importFunctions[dll.toLowerCase()] = [...(importFunctions[dll.toLowerCase()] ?? []), ...names]
      }
    }

    let cetCompat: boolean | null = null
    const debugDir = directory(DIRECTORY.debug)
    if (debugDir.rva !== 0 && debugDir.size > 0) {
      const base = offsetOf(debugDir.rva)
      const count = Math.floor(debugDir.size / 28)
      if (count > MAX_DEBUG_ENTRIES) throw new Malformed()
      for (let i = 0; i < count; i++) {
        const entry = base + i * 28
        if (u32(entry + 12) === DEBUG_TYPE_EX_DLLCHARACTERISTICS && u32(entry + 16) >= 4) {
          cetCompat = (u32(u32(entry + 24)) & EX_DLLCHARACTERISTICS_CET_COMPAT) !== 0
        }
      }
    }

    let dependentLoadFlags: number | null = null
    let guardFlags: number | null = null
    const loadConfig = directory(DIRECTORY.loadConfig)
    if (loadConfig.rva !== 0) {
      const base = offsetOf(loadConfig.rva)
      const declared = u32(base)
      if (declared >= LOAD_CONFIG_OFFSETS.dependentLoadFlags + 2) dependentLoadFlags = u16(base + LOAD_CONFIG_OFFSETS.dependentLoadFlags)
      if (declared >= LOAD_CONFIG_OFFSETS.guardFlags + 4) guardFlags = u32(base + LOAD_CONFIG_OFFSETS.guardFlags)
    }

    // Recursos: tipo RT_MANIFEST → primeiro nome → primeiro idioma → dados.
    // Deslocamentos relativos ao início do diretório de recursos; bit alto = subdiretório.
    let manifest: ManifestInfo | null = null
    let supportedOs: string[] | null = null
    const resourceDir = directory(DIRECTORY.resource)
    if (resourceDir.rva !== 0) {
      const root = offsetOf(resourceDir.rva)
      const entries = (dir: number) => {
        const count = u16(dir + 12) + u16(dir + 14)
        if (count > MAX_RESOURCE_ENTRIES) throw new Malformed()
        return Array.from({ length: count }, (_, i) => ({ id: u32(dir + 16 + i * 8), target: u32(dir + 20 + i * 8) }))
      }
      const HIGH = 0x8000_0000
      const subdirectory = (target: number) => {
        if (target < HIGH) throw new Malformed()
        return root + (target - HIGH)
      }
      const type = entries(root).find((e) => e.id === RESOURCE_TYPE_MANIFEST)
      if (type) {
        const name = entries(subdirectory(type.target))[0]
        if (!name) throw new Malformed()
        const language = entries(subdirectory(name.target))[0]
        if (!language || language.target >= HIGH) throw new Malformed()
        const data = root + language.target
        const size = u32(data + 4)
        if (size === 0 || size > MAX_MANIFEST_BYTES) throw new Malformed()
        const start = offsetOf(u32(data))
        if (start + size > bytes.length) throw new Malformed()
        const text = bytes.toString('utf8', start, start + size)
        manifest = parseManifest(text)
        supportedOs = parseSupportedOs(text)
      }
    }

    return {
      ok: true,
      report: { machine, magic, subsystem, characteristics, dllCharacteristics, cetCompat, dependentLoadFlags, guardFlags, imports, importFunctions, manifest, supportedOs }
    }
  } catch (error) {
    if (error instanceof Malformed || error instanceof RangeError) return { ok: false, reason: 'malformed' }
    return { ok: false, reason: 'malformed' }
  }
}

/** Falhas da política dos binários nativos, só como códigos (sem caminhos nem conteúdo). */
export type HelperBinaryIssue =
  /** Função cuja importação é proibida para o binário (ex.: criação de processo no auxiliar). */
  | 'forbidden-function'
  /** Launcher: função fora da lista explícita de importações permitidas. */
  | 'unexpected-function'
  /** Launcher: função obrigatória da sequência de contenção ausente. */
  | 'missing-function'
  /** Launcher: manifesto sem `supportedOS` do Windows 10/11. */
  | 'supported-os-missing'
  /** Variante errada: nomes de outra variante no binário, ou os próprios ausentes (6C.6C.1). */
  | 'wrong-variant-identity'
  | 'not-pe'
  | 'malformed'
  | 'size-out-of-range'
  | 'not-x64'
  | 'not-pe32-plus'
  | 'not-console'
  | 'not-executable'
  | 'is-dll'
  | 'no-dynamic-base'
  | 'no-high-entropy-va'
  | 'no-nx-compat'
  | 'no-guard-cf'
  | 'guard-cf-not-instrumented'
  | 'no-cet-compat'
  | 'dependent-load-flags'
  | 'unexpected-import'
  | 'missing-kernel32'
  | 'manifest-missing'
  | 'manifest-not-as-invoker'
  | 'embedded-path'

/**
 * APIs que o AUXILIAR nunca pode importar (D57: ele não cria processos nem
 * jobs e não abre outros processos). O CRT estático importa `TerminateProcess`
 * (encerramento em falha), que continua permitido.
 */
export const HELPER_FORBIDDEN_FUNCTIONS = [
  'CreateProcessA',
  'CreateProcessW',
  'CreateProcessAsUserA',
  'CreateProcessAsUserW',
  'CreateProcessWithLogonW',
  'CreateProcessWithTokenW',
  'WinExec',
  'CreateJobObjectA',
  'CreateJobObjectW',
  'AssignProcessToJobObject',
  'OpenProcess',
  'CreateRemoteThread',
  'CreateRemoteThreadEx',
  'WriteProcessMemory'
] as const

const allImportedFunctions = (r: PeReport) => Object.values(r.importFunctions).flat()

/**
 * Confere o binário do auxiliar. `forbiddenText`: textos que não podem
 * aparecer no binário (pasta do projeto, pasta do usuário), procurados em
 * ASCII e em UTF-16LE, sem diferenciar maiúsculas.
 */
export function checkHelperBinary(bytes: Buffer, forbiddenText: readonly string[] = []): { issues: HelperBinaryIssue[]; report: PeReport | null } {
  const result = checkCommon(bytes, forbiddenText, ALLOWED_IMPORTS)
  if (result.report && allImportedFunctions(result.report).some((name) => (HELPER_FORBIDDEN_FUNCTIONS as readonly string[]).includes(name))) {
    result.issues.push('forbidden-function')
  }
  return result
}

/** Políticas comuns aos dois binários (x64, mitigações, manifesto, texto embutido). */
function checkCommon(bytes: Buffer, forbiddenText: readonly string[], allowedDlls: readonly string[]): { issues: HelperBinaryIssue[]; report: PeReport | null } {
  const issues: HelperBinaryIssue[] = []
  if (bytes.length < HELPER_SIZE.min || bytes.length > HELPER_SIZE.max) issues.push('size-out-of-range')
  const inspection = inspectPe(bytes)
  if (!inspection.ok) return { issues: [...issues, inspection.reason], report: null }
  const r = inspection.report
  const has = (flag: number) => (r.dllCharacteristics & flag) === flag
  if (r.machine !== PE_MACHINE_X64) issues.push('not-x64')
  if (r.magic !== PE32_PLUS_MAGIC) issues.push('not-pe32-plus')
  if (r.subsystem !== SUBSYSTEM_WINDOWS_CUI) issues.push('not-console')
  if ((r.characteristics & FILE_CHARACTERISTICS.executableImage) === 0) issues.push('not-executable')
  if ((r.characteristics & FILE_CHARACTERISTICS.dll) !== 0) issues.push('is-dll')
  if (!has(DLL_CHARACTERISTICS.dynamicBase)) issues.push('no-dynamic-base')
  if (!has(DLL_CHARACTERISTICS.highEntropyVa)) issues.push('no-high-entropy-va')
  if (!has(DLL_CHARACTERISTICS.nxCompat)) issues.push('no-nx-compat')
  if (!has(DLL_CHARACTERISTICS.guardCf)) issues.push('no-guard-cf')
  if (r.guardFlags === null || (r.guardFlags & GUARD_CF_INSTRUMENTED) === 0) issues.push('guard-cf-not-instrumented')
  if (r.cetCompat !== true) issues.push('no-cet-compat')
  if (r.dependentLoadFlags !== LOAD_LIBRARY_SEARCH_SYSTEM32) issues.push('dependent-load-flags')
  const imports = r.imports.map((name) => name.toLowerCase())
  if (imports.some((name) => !allowedDlls.includes(name))) issues.push('unexpected-import')
  if (!imports.includes('kernel32.dll')) issues.push('missing-kernel32')
  if (r.manifest === null) issues.push('manifest-missing')
  else if (r.manifest.executionLevel !== 'asInvoker' || r.manifest.uiAccess !== 'false') issues.push('manifest-not-as-invoker')
  const haystack = bytes.toString('latin1').toLowerCase()
  const wide = bytes.toString('utf16le').toLowerCase()
  for (const text of forbiddenText) {
    const needle = text.toLowerCase()
    if (needle.length >= 3 && (haystack.includes(needle) || wide.includes(needle) || bytes.subarray(1).toString('utf16le').toLowerCase().includes(needle))) {
      issues.push('embedded-path')
      break
    }
  }
  return { issues, report: r }
}

/** `supportedOS` do Windows 10 e 11 (mesmo identificador). */
export const SUPPORTED_OS_WINDOWS_10 = '8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a'

/** DLLs que o LAUNCHER pode importar estaticamente (ambas da System32, por `DependentLoadFlags`). */
export const HOST_ALLOWED_IMPORTS = ['kernel32.dll', 'bcrypt.dll'] as const

type HostDll = (typeof HOST_ALLOWED_IMPORTS)[number]

/** Funções da sequência de contenção que o launcher TEM de importar. */
export const HOST_REQUIRED_FUNCTIONS: Readonly<Record<HostDll, readonly string[]>> = {
  'kernel32.dll': [
    'CreateJobObjectW',
    'SetInformationJobObject',
    'QueryInformationJobObject',
    'InitializeProcThreadAttributeList',
    'UpdateProcThreadAttribute',
    'DeleteProcThreadAttributeList',
    'CreateProcessW',
    'IsProcessInJob',
    'ResumeThread',
    'TerminateJobObject',
    'WaitForSingleObject',
    'GetExitCodeProcess',
    'GetFinalPathNameByHandleW',
    'GetFileInformationByHandleEx',
    'QueryFullProcessImageNameW',
    'IsWow64Process2',
    'SetDefaultDllDirectories',
    'SetProcessMitigationPolicy'
  ],
  'bcrypt.dll': ['BCryptCreateHash', 'BCryptHashData', 'BCryptFinishHash', 'BCryptDestroyHash']
}

/**
 * Funções que o launcher nunca pode importar: outros caminhos de criação de
 * processo, associação a job fora da sequência (`AssignProcessToJobObject`),
 * abertura de jobs por nome e acesso a outros processos.
 */
export const HOST_FORBIDDEN_FUNCTIONS = [
  'AssignProcessToJobObject',
  'OpenJobObjectA',
  'OpenJobObjectW',
  'CreateJobObjectA',
  'CreateProcessA',
  'CreateProcessAsUserA',
  'CreateProcessAsUserW',
  'CreateProcessWithLogonW',
  'CreateProcessWithTokenW',
  'WinExec',
  'OpenProcess',
  'CreateRemoteThread',
  'CreateRemoteThreadEx',
  'WriteProcessMemory',
  'LoadLibraryA',
  'LoadLibraryW'
] as const

/**
 * Lista EXPLÍCITA de funções que o launcher pode importar, fixada a partir do
 * primeiro build revisado (6C.6B.2): as do código do launcher e as do CRT
 * estático (`/MT`). Qualquer importação nova recusa o binário e exige revisão.
 */
export const HOST_ALLOWED_FUNCTIONS: Readonly<Record<HostDll, readonly string[]>> = {
  'kernel32.dll': [
    // Código do launcher (main.cpp, protocol.cpp, integrity.cpp).
    'CloseHandle',
    'CompareStringOrdinal',
    'CreateFileW',
    'CreateJobObjectW',
    'CreateProcessW',
    'DeleteProcThreadAttributeList',
    'DuplicateHandle',
    'GetCurrentProcess',
    'GetExitCodeProcess',
    'GetFileInformationByHandleEx',
    'GetFileSizeEx',
    'GetFileType',
    'GetFinalPathNameByHandleW',
    'GetHandleInformation',
    'GetModuleFileNameW',
    'GetStdHandle',
    'GetSystemDirectoryW',
    'GetSystemWindowsDirectoryW',
    'InitializeProcThreadAttributeList',
    'IsProcessInJob',
    'IsWow64Process2',
    'QueryFullProcessImageNameW',
    'QueryInformationJobObject',
    'ReadFile',
    'ResumeThread',
    'SetDefaultDllDirectories',
    'SetErrorMode',
    'SetFilePointerEx',
    'SetInformationJobObject',
    'SetProcessMitigationPolicy',
    'TerminateJobObject',
    'TerminateProcess',
    'UpdateProcThreadAttribute',
    'WaitForSingleObject',
    // CRT estático (/MT): inicialização, tratamento de falhas, locale e heap.
    // O código do launcher não chama nenhuma destas diretamente (teste S3).
    'CompareStringW',
    'DeleteCriticalSection',
    'EncodePointer',
    'EnterCriticalSection',
    'ExitProcess',
    'FindClose',
    'FindFirstFileExW',
    'FindNextFileW',
    'FlsAlloc',
    'FlsFree',
    'FlsGetValue',
    'FlsSetValue',
    'FlushFileBuffers',
    'FreeEnvironmentStringsW',
    'FreeLibrary',
    'GetACP',
    'GetCPInfo',
    'GetCommandLineA',
    'GetCommandLineW',
    'GetConsoleMode',
    'GetConsoleOutputCP',
    'GetCurrentProcessId',
    'GetCurrentThreadId',
    'GetEnvironmentStringsW',
    'GetLastError',
    'GetModuleHandleExW',
    'GetModuleHandleW',
    'GetOEMCP',
    'GetProcAddress',
    'GetProcessHeap',
    'GetStartupInfoW',
    'GetStringTypeW',
    'GetSystemTimeAsFileTime',
    'HeapAlloc',
    'HeapFree',
    'HeapReAlloc',
    'HeapSize',
    'InitializeCriticalSectionAndSpinCount',
    'InitializeCriticalSectionEx',
    'InitializeSListHead',
    'IsDebuggerPresent',
    'IsProcessorFeaturePresent',
    'IsValidCodePage',
    'LCMapStringW',
    'LeaveCriticalSection',
    'LoadLibraryExW',
    'MultiByteToWideChar',
    'QueryPerformanceCounter',
    'RaiseException',
    'RtlCaptureContext',
    'RtlLookupFunctionEntry',
    'RtlPcToFileHeader',
    'RtlUnwindEx',
    'RtlVirtualUnwind',
    'SetEnvironmentVariableW',
    'SetLastError',
    'SetStdHandle',
    'SetUnhandledExceptionFilter',
    'TlsAlloc',
    'TlsFree',
    'TlsGetValue',
    'TlsSetValue',
    'UnhandledExceptionFilter',
    'VirtualProtect',
    'WideCharToMultiByte',
    'WriteConsoleW',
    'WriteFile'
  ],
  'bcrypt.dll': ['BCryptCreateHash', 'BCryptDestroyHash', 'BCryptFinishHash', 'BCryptHashData']
}

/** Confere o binário do launcher: políticas comuns, importações explícitas e manifesto. */
export function checkHostBinary(
  bytes: Buffer,
  forbiddenText: readonly string[] = [],
  allowedFunctions: Readonly<Record<string, readonly string[]>> = HOST_ALLOWED_FUNCTIONS
): { issues: HelperBinaryIssue[]; report: PeReport | null; unexpectedFunctions: string[] } {
  const result = checkCommon(bytes, forbiddenText, HOST_ALLOWED_IMPORTS)
  const unexpectedFunctions: string[] = []
  const r = result.report
  if (r === null) return { ...result, unexpectedFunctions }
  for (const [dll, functions] of Object.entries(r.importFunctions)) {
    const allowed = allowedFunctions[dll] ?? []
    for (const name of functions) if (!allowed.includes(name)) unexpectedFunctions.push(`${dll}!${name}`)
  }
  if (unexpectedFunctions.length > 0) result.issues.push('unexpected-function')
  if (allImportedFunctions(r).some((name) => (HOST_FORBIDDEN_FUNCTIONS as readonly string[]).includes(name))) result.issues.push('forbidden-function')
  for (const [dll, required] of Object.entries(HOST_REQUIRED_FUNCTIONS)) {
    if (required.some((name) => !(r.importFunctions[dll] ?? []).includes(name))) {
      result.issues.push('missing-function')
      break
    }
  }
  if (r.supportedOs === null || !r.supportedOs.includes(SUPPORTED_OS_WINDOWS_10)) result.issues.push('supported-os-missing')
  return { ...result, unexpectedFunctions }
}

/**
 * Variante DIAGNÓSTICA da de testes (6C.6C.2C; `test-artifacts/host_diag.*`):
 * só estas importações a mais, para a porta de conclusão própria do job J.
 * Nada de acesso a outros processos (`OpenProcess` continua proibida).
 */
export const DIAG_EXTRA_FUNCTIONS = ['CreateIoCompletionPort', 'GetQueuedCompletionStatus'] as const

export const DIAG_HOST_ALLOWED_FUNCTIONS: Readonly<Record<HostDll, readonly string[]>> = {
  'kernel32.dll': [...HOST_ALLOWED_FUNCTIONS['kernel32.dll'], ...DIAG_EXTRA_FUNCTIONS],
  'bcrypt.dll': HOST_ALLOWED_FUNCTIONS['bcrypt.dll']
}

/** Prefixo ASCII da linha diagnóstica (só existe na variante diagnóstica). */
export const DIAG_LINE_PREFIX = 'gerpro-host-diag v=1'

export type DiagMarker = 'absent' | 'nowindow' | 'detached'

const containsAscii = (bytes: Buffer, text: string) => bytes.includes(Buffer.from(text, 'latin1'))

/**
 * Marca diagnóstica: ausente no launcher de produção e na variante de testes
 * comum; presente, com a forma de criação certa, nas variantes diagnósticas.
 */
export function checkDiagMarker(bytes: Buffer, expected: DiagMarker): HelperBinaryIssue[] {
  const prefix = containsAscii(bytes, DIAG_LINE_PREFIX)
  const ok =
    expected === 'absent'
      ? !prefix
      : prefix && containsAscii(bytes, expected) && !containsAscii(bytes, expected === 'nowindow' ? 'detached' : 'nowindow')
  return ok ? [] : ['wrong-variant-identity']
}

/**
 * Textos de identidade de cada variante (UTF-16LE no binário). Cada uma tem
 * de conter os próprios nomes e NUNCA os da outra: o launcher de produção não
 * conhece o alvo sintético, e a variante de testes não conhece o auxiliar
 * DXCore (6C.6C.1).
 */
export const LAUNCHER_IDENTITY = {
  production: { required: ['gerpro-helper-host.exe', 'gerpro-dxcore-helper.exe'], forbidden: ['gerpro-synthetic-helper.exe', 'gerpro-helper-host-test.exe', 'host-test'] },
  test: { required: ['gerpro-helper-host-test.exe', 'gerpro-synthetic-helper.exe', 'host-test'], forbidden: ['gerpro-dxcore-helper.exe', 'gerpro-helper-host.exe'] },
  synthetic: { required: ['gerpro-synthetic-helper.exe', 'host-test'], forbidden: ['gerpro-dxcore-helper.exe', 'gerpro-helper-host.exe'] }
} as const

export type LauncherVariant = keyof typeof LAUNCHER_IDENTITY

/** Texto em UTF-16LE (nas duas paridades de deslocamento), sem diferenciar maiúsculas. */
const containsWide = (bytes: Buffer, text: string) => {
  const needle = text.toLowerCase()
  return bytes.toString('utf16le').toLowerCase().includes(needle) || bytes.subarray(1).toString('utf16le').toLowerCase().includes(needle)
}

/** Identidade da variante: nomes próprios presentes, nomes da outra variante ausentes. */
export function checkVariantIdentity(bytes: Buffer, variant: LauncherVariant): HelperBinaryIssue[] {
  const identity = LAUNCHER_IDENTITY[variant]
  const ok = identity.required.every((text) => containsWide(bytes, text)) && identity.forbidden.every((text) => !containsWide(bytes, text))
  return ok ? [] : ['wrong-variant-identity']
}

/**
 * APIs que o ALVO SINTÉTICO nunca pode importar: alteração de arquivos e
 * pastas, acesso a dispositivos e a outros processos, jobs e carga dinâmica de
 * DLL por nome. Rede, registro e interface ficam fora por DLL (só
 * `KERNEL32.dll` é aceita). `CreateFileW` vem do CRT estático e continua
 * permitida na lista, mas o código do alvo não a chama (teste estático).
 */
export const SYNTHETIC_FORBIDDEN_FUNCTIONS = [
  'DeleteFileA',
  'DeleteFileW',
  'MoveFileA',
  'MoveFileW',
  'MoveFileExA',
  'MoveFileExW',
  'CopyFileA',
  'CopyFileW',
  'CopyFileExW',
  'CopyFile2',
  'ReplaceFileW',
  'CreateDirectoryA',
  'CreateDirectoryW',
  'RemoveDirectoryA',
  'RemoveDirectoryW',
  'CreateHardLinkW',
  'CreateSymbolicLinkW',
  'SetFileInformationByHandle',
  'CreateFileMappingW',
  'DeviceIoControl',
  'OpenProcess',
  'CreateRemoteThread',
  'CreateRemoteThreadEx',
  'WriteProcessMemory',
  'VirtualAllocEx',
  'CreateJobObjectA',
  'CreateJobObjectW',
  'OpenJobObjectW',
  'AssignProcessToJobObject',
  'SetInformationJobObject',
  'CreateProcessA',
  'CreateProcessAsUserW',
  'CreateProcessWithLogonW',
  'CreateProcessWithTokenW',
  'WinExec',
  'LoadLibraryA',
  'LoadLibraryW'
] as const

/**
 * Lista EXPLÍCITA de importações do alvo sintético (união dos 7 cenários),
 * fixada a partir do primeiro build revisado (6C.6C.1). Qualquer função nova
 * recusa o binário e exige revisão.
 */
export const SYNTHETIC_ALLOWED_FUNCTIONS: Readonly<Record<'kernel32.dll', readonly string[]>> = {
  'kernel32.dll': [
    // Código do alvo (synthetic_helper.cpp), união dos 7 cenários.
    'CloseHandle',
    'CompareStringOrdinal',
    'CreateProcessW',
    'GetCurrentProcess',
    'GetLastError',
    'GetModuleFileNameW',
    'GetStdHandle',
    'IsProcessInJob',
    'QueryInformationJobObject',
    'SetDefaultDllDirectories',
    'SetErrorMode',
    'Sleep',
    'TerminateProcess',
    'VirtualAlloc',
    'VirtualFree',
    'WaitForSingleObject',
    'WriteFile',
    // CRT estático (/MT): o mesmo conjunto do launcher. O código do alvo não
    // chama nenhuma destas (teste estático); CreateFileW e SetFilePointerEx
    // vêm do CRT e nunca são usadas pelo alvo.
    'CompareStringW',
    'CreateFileW',
    'DeleteCriticalSection',
    'EncodePointer',
    'EnterCriticalSection',
    'ExitProcess',
    'FindClose',
    'FindFirstFileExW',
    'FindNextFileW',
    'FlsAlloc',
    'FlsFree',
    'FlsGetValue',
    'FlsSetValue',
    'FlushFileBuffers',
    'FreeEnvironmentStringsW',
    'FreeLibrary',
    'GetACP',
    'GetCPInfo',
    'GetCommandLineA',
    'GetCommandLineW',
    'GetConsoleMode',
    'GetConsoleOutputCP',
    'GetCurrentProcessId',
    'GetCurrentThreadId',
    'GetEnvironmentStringsW',
    'GetFileType',
    'GetModuleHandleExW',
    'GetModuleHandleW',
    'GetOEMCP',
    'GetProcAddress',
    'GetProcessHeap',
    'GetStartupInfoW',
    'GetStringTypeW',
    'GetSystemTimeAsFileTime',
    'HeapAlloc',
    'HeapFree',
    'HeapReAlloc',
    'HeapSize',
    'InitializeCriticalSectionAndSpinCount',
    'InitializeCriticalSectionEx',
    'InitializeSListHead',
    'IsDebuggerPresent',
    'IsProcessorFeaturePresent',
    'IsValidCodePage',
    'LCMapStringW',
    'LeaveCriticalSection',
    'LoadLibraryExW',
    'MultiByteToWideChar',
    'QueryPerformanceCounter',
    'RaiseException',
    'RtlCaptureContext',
    'RtlLookupFunctionEntry',
    'RtlPcToFileHeader',
    'RtlUnwindEx',
    'RtlVirtualUnwind',
    'SetEnvironmentVariableW',
    'SetFilePointerEx',
    'SetLastError',
    'SetStdHandle',
    'SetUnhandledExceptionFilter',
    'TlsAlloc',
    'TlsFree',
    'TlsGetValue',
    'TlsSetValue',
    'UnhandledExceptionFilter',
    'VirtualProtect',
    'WideCharToMultiByte',
    'WriteConsoleW'
  ]
}

/** Confere um binário do alvo sintético: políticas comuns, só KERNEL32, lista explícita, proibições e identidade. */
export function checkSyntheticBinary(
  bytes: Buffer,
  forbiddenText: readonly string[] = [],
  allowedFunctions: Readonly<Record<string, readonly string[]>> = SYNTHETIC_ALLOWED_FUNCTIONS
): { issues: HelperBinaryIssue[]; report: PeReport | null; unexpectedFunctions: string[] } {
  const result = checkCommon(bytes, forbiddenText, ALLOWED_IMPORTS)
  const unexpectedFunctions: string[] = []
  const r = result.report
  if (r === null) return { ...result, unexpectedFunctions }
  for (const [dll, functions] of Object.entries(r.importFunctions)) {
    const allowed = allowedFunctions[dll] ?? []
    for (const name of functions) if (!allowed.includes(name)) unexpectedFunctions.push(`${dll}!${name}`)
  }
  if (unexpectedFunctions.length > 0) result.issues.push('unexpected-function')
  if (allImportedFunctions(r).some((name) => (SYNTHETIC_FORBIDDEN_FUNCTIONS as readonly string[]).includes(name))) result.issues.push('forbidden-function')
  if (r.supportedOs === null || !r.supportedOs.includes(SUPPORTED_OS_WINDOWS_10)) result.issues.push('supported-os-missing')
  result.issues.push(...checkVariantIdentity(bytes, 'synthetic'))
  return { ...result, unexpectedFunctions }
}

/**
 * `gerpro-lock-holder-test.exe` (SÓ DE TESTE; 6C.6C.3F; docs/11, seção 20).
 * Segura travas com as flags do launcher para T-F1, T-F2 e T-F4 e nunca
 * altera arquivos: nada de apagar, mover, copiar, criar pastas, truncar ou
 * mudar atributos, nada de processos, threads, jobs, dispositivos ou carga de
 * DLL por nome. `CreateFileMappingW` é a única diferença em relação ao alvo
 * sintético: é a seção gravável do modo `mapping`. `WriteFile` (CRT e sinal na
 * saída padrão) e `CreateFileW` continuam permitidas; o teste estático
 * confere que o código só escreve na saída padrão.
 */
export const LOCK_HOLDER_FORBIDDEN_FUNCTIONS = [
  ...SYNTHETIC_FORBIDDEN_FUNCTIONS.filter((name) => name !== 'CreateFileMappingW'),
  'CreateProcessW',
  'CreateThread',
  'CreateFileMappingA',
  'CreateDirectoryExW',
  'SetEndOfFile',
  'SetFileValidData',
  'SetFileAttributesW',
  'SetFileTime',
  'SetFileShortNameW',
  'WriteFileEx',
  'WriteFileGather',
  'FlushViewOfFile',
  'DeleteFileTransactedW',
  'MoveFileWithProgressW',
  'OpenFileMappingW'
] as const

/**
 * Lista EXPLÍCITA de importações do segurador de travas, fixada a partir do
 * primeiro build revisado (6C.6C.3F). Qualquer função nova recusa o binário.
 */
export const LOCK_HOLDER_ALLOWED_FUNCTIONS: Readonly<Record<'kernel32.dll', readonly string[]>> = {
  'kernel32.dll': [
    // Código do segurador (native/lock-holder-test/src/main.cpp).
    'CloseHandle',
    'CompareStringOrdinal',
    'CreateFileMappingW',
    'CreateFileW',
    'GetFileInformationByHandle',
    'GetFileInformationByHandleEx',
    'GetFileSizeEx',
    'GetFileType',
    'GetFinalPathNameByHandleW',
    'GetLastError',
    'GetStdHandle',
    'GetTempPathW',
    'GetTickCount64',
    'MapViewOfFile',
    'PeekNamedPipe',
    'SetDefaultDllDirectories',
    'SetErrorMode',
    'Sleep',
    'UnmapViewOfFile',
    'WriteFile',
    // CRT estático (/MT), conferido no primeiro build: o mesmo conjunto do
    // alvo sintético. O código do segurador não chama nenhuma destas (teste
    // estático); TerminateProcess e GetCurrentProcess são do encerramento em
    // falha do CRT, sobre o próprio processo.
    'CompareStringW',
    'DeleteCriticalSection',
    'EncodePointer',
    'EnterCriticalSection',
    'ExitProcess',
    'FindClose',
    'FindFirstFileExW',
    'FindNextFileW',
    'FlsAlloc',
    'FlsFree',
    'FlsGetValue',
    'FlsSetValue',
    'FlushFileBuffers',
    'FreeEnvironmentStringsW',
    'FreeLibrary',
    'GetACP',
    'GetCPInfo',
    'GetCommandLineA',
    'GetCommandLineW',
    'GetConsoleMode',
    'GetConsoleOutputCP',
    'GetCurrentProcess',
    'GetCurrentProcessId',
    'GetCurrentThreadId',
    'GetEnvironmentStringsW',
    'GetModuleFileNameW',
    'GetModuleHandleExW',
    'GetModuleHandleW',
    'GetOEMCP',
    'GetProcAddress',
    'GetProcessHeap',
    'GetStartupInfoW',
    'GetStringTypeW',
    'GetSystemTimeAsFileTime',
    'HeapAlloc',
    'HeapFree',
    'HeapReAlloc',
    'HeapSize',
    'InitializeCriticalSectionAndSpinCount',
    'InitializeCriticalSectionEx',
    'InitializeSListHead',
    'IsDebuggerPresent',
    'IsProcessorFeaturePresent',
    'IsValidCodePage',
    'LCMapStringW',
    'LeaveCriticalSection',
    'LoadLibraryExW',
    'MultiByteToWideChar',
    'QueryPerformanceCounter',
    'RaiseException',
    'RtlCaptureContext',
    'RtlLookupFunctionEntry',
    'RtlPcToFileHeader',
    'RtlUnwindEx',
    'RtlVirtualUnwind',
    'SetEnvironmentVariableW',
    'SetFilePointerEx',
    'SetLastError',
    'SetStdHandle',
    'SetUnhandledExceptionFilter',
    'TerminateProcess',
    'TlsAlloc',
    'TlsFree',
    'TlsGetValue',
    'TlsSetValue',
    'UnhandledExceptionFilter',
    'VirtualProtect',
    'WideCharToMultiByte',
    'WriteConsoleW'
  ]
}

/** Prefixo ASCII das linhas do segurador (prontidão e liberação). */
export const LOCK_HOLDER_LINE_PREFIX = 'gerpro-lock-holder-test v=1 '

/** Identidade do segurador: nomes fixos do layout presentes; nomes de launcher, auxiliar e diagnóstico ausentes. */
export const LOCK_HOLDER_IDENTITY = {
  requiredWide: ['gerpro-synthetic-helper.exe', 'host-test', 'win32-x64', 'gerpro-6c6c-'],
  forbiddenWide: ['gerpro-dxcore-helper.exe', 'gerpro-helper-host.exe', 'gerpro-helper-host-test.exe'],
  forbiddenAscii: [DIAG_LINE_PREFIX]
} as const

/** Confere o segurador: políticas comuns, só KERNEL32, lista explícita, proibições, manifesto e identidade. */
export function checkLockHolderBinary(
  bytes: Buffer,
  forbiddenText: readonly string[] = [],
  allowedFunctions: Readonly<Record<string, readonly string[]>> = LOCK_HOLDER_ALLOWED_FUNCTIONS
): { issues: HelperBinaryIssue[]; report: PeReport | null; unexpectedFunctions: string[] } {
  const result = checkCommon(bytes, forbiddenText, ALLOWED_IMPORTS)
  const unexpectedFunctions: string[] = []
  const r = result.report
  if (r === null) return { ...result, unexpectedFunctions }
  for (const [dll, functions] of Object.entries(r.importFunctions)) {
    const allowed = allowedFunctions[dll] ?? []
    for (const name of functions) if (!allowed.includes(name)) unexpectedFunctions.push(`${dll}!${name}`)
  }
  if (unexpectedFunctions.length > 0) result.issues.push('unexpected-function')
  if (allImportedFunctions(r).some((name) => (LOCK_HOLDER_FORBIDDEN_FUNCTIONS as readonly string[]).includes(name))) result.issues.push('forbidden-function')
  if (r.supportedOs === null || !r.supportedOs.includes(SUPPORTED_OS_WINDOWS_10)) result.issues.push('supported-os-missing')
  const identityOk =
    containsAscii(bytes, LOCK_HOLDER_LINE_PREFIX) &&
    LOCK_HOLDER_IDENTITY.requiredWide.every((text) => containsWide(bytes, text)) &&
    LOCK_HOLDER_IDENTITY.forbiddenWide.every((text) => !containsWide(bytes, text)) &&
    LOCK_HOLDER_IDENTITY.forbiddenAscii.every((text) => !containsAscii(bytes, text))
  if (!identityOk) result.issues.push('wrong-variant-identity')
  return { ...result, unexpectedFunctions }
}

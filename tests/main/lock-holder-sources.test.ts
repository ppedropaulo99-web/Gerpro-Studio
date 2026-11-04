import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BATTERY_SCRATCH_PREFIX } from '../../scripts/diagnostics/host-containment/system-checks'
import { SYNTHETIC_HELPER_NAME, TEST_HELPERS_DIRECTORY } from '../../scripts/native/host-test-scenarios'
import {
  checkLockHolderBinary,
  LOCK_HOLDER_ALLOWED_FUNCTIONS,
  LOCK_HOLDER_FORBIDDEN_FUNCTIONS,
  LOCK_HOLDER_LINE_PREFIX,
  SYNTHETIC_ALLOWED_FUNCTIONS
} from '../../scripts/native/pe-inspect'

// Revisão estática do gerpro-lock-holder-test.exe (Etapa 6C.6C.3F; docs/11,
// seção 20). Nada aqui compila nem executa o segurador: só lê os fontes, o
// script de build e, se existir, os bytes do binário já compilado.

const ROOT = join(import.meta.dirname, '../..')
const HOLDER = join(ROOT, 'native', 'lock-holder-test')
const LAUNCHER_MAIN = join(ROOT, 'native', 'helper-host', 'src', 'main.cpp')
const BUILD_SCRIPT = join(ROOT, 'scripts', 'native', 'build-lock-holder-test.mjs')
const BINARY = join(HOLDER, 'build', 'x64', 'gerpro-lock-holder-test.exe')
const BINARY_REPRO = join(HOLDER, 'build', 'x64-repro', 'gerpro-lock-holder-test.exe')
const BUILD_MANIFEST = join(HOLDER, 'build', 'x64', 'lock-holder-manifest.json')

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')
/** Código sem comentários (os fontes não têm `//` nem `/*` dentro de strings). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const main = () => code(read(HOLDER, 'src', 'main.cpp'))
const exitCodes = () => code(read(HOLDER, 'src', 'exit_codes.h'))
const squash = (text: string) => text.replace(/\s+/g, ' ')
const count = (text: string, pattern: RegExp) => [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** Corpo de uma função C++ (do nome até a chave que fecha o bloco). */
function body(text: string, signature: string): string {
  const start = text.indexOf(signature)
  assert.ok(start >= 0, `função ${signature} não encontrada`)
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error('bloco sem fim')
}
/** Argumentos da chamada `CreateFileW(...)` dentro de um trecho, normalizados. */
function createFileArgs(text: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf('::CreateFileW(', from)
    if (at < 0) return out
    let depth = 0
    let i = at + '::CreateFileW'.length
    const begin = i + 1
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++
      if (text[i] === ')' && --depth === 0) break
    }
    out.push(squash(text.slice(begin, i)).trim())
    from = i
  }
}
/** Flags (do 2.º argumento em diante) de uma chamada CreateFileW. */
const flagsOf = (args: string) => args.split(',').slice(1).map((s) => s.trim()).join(', ')

const walk = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []

describe('lock holder: área exclusiva de testes (6C.6C.3F)', () => {
  it('fontes só em native/lock-holder-test, separados dos do launcher e do auxiliar', () => {
    assert.deepEqual(readdirSync(join(HOLDER, 'src')).sort(), ['exit_codes.h', 'lock_holder.manifest', 'main.cpp'])
    assert.ok(existsSync(join(HOLDER, 'README.md')))
    for (const dir of [join(ROOT, 'native', 'helper-host', 'src'), join(ROOT, 'native', 'dxcore-helper')]) {
      for (const file of walk(dir).filter((f) => /\.(cpp|h)$/.test(f))) assert.doesNotMatch(read(file), /lock-holder|lockholder/i, file)
    }
  })

  it('nunca distribuído: nada no app, no empacotamento ou em resources; build fora do git', () => {
    for (const file of walk(join(ROOT, 'src'))) assert.doesNotMatch(read(file), /lock-holder|lockholder/i, file)
    for (const file of ['package.json', 'electron.vite.config.ts']) assert.doesNotMatch(read(ROOT, file), /lock-holder/i, file)
    assert.ok(!walk(join(ROOT, 'resources')).some((f) => /lock-holder/i.test(f)))
    assert.match(read(ROOT, '.gitignore'), /^\/native\/lock-holder-test\/build\/$/m)
  })

  it('integração só no supervisor de diagnósticos (6C.6C.3G); nunca na entrada Electron de teste', () => {
    const diag = join(ROOT, 'scripts', 'diagnostics')
    const users = [join(diag, 'run-host-containment.mjs'), ...walk(join(diag, 'host-containment'))].filter((f) => /lock-holder|LOCK_HOLDER/.test(read(f)))
    assert.deepEqual(users.map((f) => f.slice(diag.length + 1).replaceAll('\\', '/')).sort(), ['host-containment/battery.ts', 'host-containment/lock-holder.ts', 'host-containment/plan.ts', 'run-host-containment.mjs'])
    assert.doesNotMatch(read(diag, 'host-containment-electron.mjs'), /lock-holder|LOCK_HOLDER/i)
  })
})

describe('lock holder: mesmas aberturas do launcher', () => {
  const launcher = code(readFileSync(LAUNCHER_MAIN, 'utf8'))

  it('modo file: as flags de LockHelperFile (passo 6)', () => {
    const [expected] = createFileArgs(body(launcher, 'bool LockHelperFile('))
    const [actual] = createFileArgs(body(main(), 'bool LockFile('))
    assert.equal(flagsOf(actual), flagsOf(expected))
    assert.equal(flagsOf(actual), 'GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr')
  })

  it('modo directory: as flags de LockDirectory (passo 5), sem FILE_SHARE_DELETE', () => {
    const [expected] = createFileArgs(body(launcher, 'bool LockDirectory('))
    const [actual] = createFileArgs(body(main(), 'bool LockDirectory('))
    assert.equal(flagsOf(actual), flagsOf(expected))
    assert.doesNotMatch(actual, /FILE_SHARE_DELETE/)
    assert.match(actual, /FILE_LIST_DIRECTORY \| FILE_READ_ATTRIBUTES \| SYNCHRONIZE/)
  })

  it('modo directory trava host-test e depois win32-x64', () => {
    const run = body(main(), 'int Run(')
    const top = run.indexOf('LockDirectory(topPath')
    const arch = run.indexOf('LockDirectory(archPath')
    assert.ok(top > 0 && arch > top)
  })

  it('modo mapping: seção e vista graváveis, arquivo fechado logo depois da seção, nenhum acesso à vista', () => {
    const fn = body(main(), 'bool HoldMapping(')
    assert.equal(count(fn, /::CreateFileMappingW\(/), 1)
    assert.match(squash(fn), /::CreateFileMappingW\(file\.get\(\), nullptr, PAGE_READWRITE, 0, 0, nullptr\)/)
    const mapping = fn.indexOf('::CreateFileMappingW(')
    const close = fn.indexOf('file.reset();')
    const view = fn.indexOf('::MapViewOfFile(')
    assert.ok(mapping > 0 && close > mapping && view > close, 'o arquivo fecha entre a seção e a vista')
    assert.match(squash(fn), /::MapViewOfFile\(held\.mapping\.get\(\), FILE_MAP_WRITE, 0, 0, 0\)/)
    // A vista não expõe o endereço: não há como ler nem escrever nela.
    const viewClass = body(main(), 'class View {')
    assert.doesNotMatch(viewClass, /\bget\(\)|operator\s*(?:\*|->|\[|void)|address_\s*\[|\*address_|return address_;/)
    assert.doesNotMatch(main(), /memcpy|memset|memmove|CopyMemory|FillMemory|ZeroMemory|FlushViewOfFile/)
  })

  it('GENERIC_WRITE só na abertura do modo mapping; nunca cria, trunca ou substitui', () => {
    const text = main()
    assert.equal(count(text, /GENERIC_WRITE/), 1)
    assert.match(body(text, 'bool HoldMapping('), /GENERIC_READ \| GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING/)
    const calls = createFileArgs(text)
    assert.equal(calls.length, 5)
    for (const args of calls) assert.match(args, /OPEN_EXISTING/)
    assert.doesNotMatch(text, /CREATE_ALWAYS|CREATE_NEW|OPEN_ALWAYS|TRUNCATE_EXISTING|DELETE_ON_CLOSE|\bDELETE\b|WRITE_DAC|WRITE_OWNER|FILE_WRITE_ATTRIBUTES/)
  })
})

describe('lock holder: segurança do código', () => {
  const FORBIDDEN_CALLS = [
    'DeleteFile', 'MoveFile', 'CopyFile', 'ReplaceFile', 'CreateDirectory', 'RemoveDirectory', 'CreateHardLink', 'CreateSymbolicLink',
    'SetEndOfFile', 'SetFileValidData', 'SetFileInformationByHandle', 'SetFileAttributes', 'SetFileTime', 'SetFilePointer', 'WriteFileEx',
    'CreateProcess', 'ShellExecute', 'WinExec', 'CreateThread', 'CreateRemoteThread', 'OpenProcess', 'TerminateProcess', 'ExitProcess',
    'DebugActiveProcess', 'CreateJobObject', 'AssignProcessToJobObject', 'OpenThread', 'DeviceIoControl', 'LoadLibrary', 'GetProcAddress',
    'RegOpenKey', 'RegCreateKey', 'RegSetValue', 'OpenSCManager', 'OpenService', 'ControlService', 'SetSecurityInfo', 'SetNamedSecurityInfo',
    'SetFileSecurity', 'SetKernelObjectSecurity', 'AdjustTokenPrivileges', 'OpenProcessToken', 'ImpersonateLoggedOnUser', 'ReadFile',
    'system(', '_wsystem', '_wspawn', '_wexec', 'runas', 'requireAdministrator'
  ]

  it('não chama APIs de alteração, processos, threads, registro, serviços, ACLs ou elevação', () => {
    const text = main()
    for (const name of FORBIDDEN_CALLS) assert.ok(!text.includes(name), name)
    assert.doesNotMatch(read(HOLDER, 'src', 'lock_holder.manifest'), /requestedExecutionLevel|requireAdministrator|highestAvailable/)
  })

  it('só os headers do sistema e o próprio exit_codes.h', () => {
    const includes = [...read(HOLDER, 'src', 'main.cpp').matchAll(/^#include\s+(\S+)/gm)].map((m) => m[1])
    assert.deepEqual(includes, ['<windows.h>', '<cstddef>', '<cstdint>', '"exit_codes.h"'])
  })

  it('WriteFile só em WriteLine, e WriteLine só com a saída padrão', () => {
    const text = main()
    assert.equal(count(text, /::WriteFile\(/), 1)
    assert.match(body(text, 'bool WriteLine('), /::WriteFile\(out,/)
    assert.equal(count(text, /GetStdHandle\(/), 2)
    assert.match(text, /const HANDLE out = ::GetStdHandle\(STD_OUTPUT_HANDLE\);/)
    assert.match(text, /const HANDLE in = ::GetStdHandle\(STD_INPUT_HANDLE\);/)
    for (const call of [...text.matchAll(/\bSend(?:Ready|Released)\((\w+)/g)].map((m) => m[1])) {
      if (call !== 'HANDLE') assert.equal(call, 'out')
    }
  })

  it('a entrada padrão só é consultada (PeekNamedPipe), nunca lida; tem de ser pipe', () => {
    const text = main()
    assert.equal(count(text, /::PeekNamedPipe\(in, nullptr, 0, nullptr, &available, nullptr\)/), 1)
    assert.match(text, /::GetFileType\(in\) != FILE_TYPE_PIPE\) return kExitEnvironment/)
  })

  it('prazo próprio fixo e curto, contado desde o início, sem argumento que o mude', () => {
    const text = main()
    const deadline = /constexpr ULONGLONG kHoldDeadlineMs = (\d+);/.exec(text)
    assert.ok(deadline)
    const ms = Number(deadline[1])
    assert.ok(ms > 0 && ms <= 15000, `prazo ${ms}`)
    assert.match(text, /if \(argc != 3 \|\|/)
    const wait = body(text, 'WaitResult WaitForRelease(')
    assert.match(wait, /::GetTickCount64\(\) - start >= kHoldDeadlineMs\) return WaitResult::kDeadline/)
    assert.match(body(text, 'int Run('), /const ULONGLONG start = ::GetTickCount64\(\);/)
    assert.doesNotMatch(text, /INFINITE/)
  })

  it('libera as travas antes de cada sinal de liberação e de cada saída depois da trava', () => {
    const run = body(main(), 'int Run(')
    const afterLocks = run.slice(run.indexOf('Held held;'))
    // Cada sinal de liberação vem depois de um held.Release() anterior.
    let from = 0
    for (;;) {
      const at = afterLocks.indexOf('SendReleased(', from)
      if (at < 0) break
      assert.ok(afterLocks.lastIndexOf('held.Release();', at) >= 0, 'sinal antes da liberação')
      from = at + 1
    }
    assert.match(afterLocks, /if \(::GetTickCount64\(\) - start >= kHoldDeadlineMs\) \{\s*held\.Release\(\);\s*SendReleased\(out, "deadline"\);/)
    const wait = afterLocks.indexOf('WaitForRelease(in, start)')
    const release = afterLocks.indexOf('held.Release();', wait)
    const firstSignal = afterLocks.indexOf('SendReleased(out, "stdin")')
    assert.ok(wait > 0 && release > wait && firstSignal > release)
    assert.match(afterLocks, /if \(!SendReady\([^)]*\)\) \{\s*held\.Release\(\);\s*return kExitSignal;/)
    // A struct Held solta na ordem: vista, seção, arquivo, pastas (filha antes da mãe).
    assert.match(squash(body(main(), 'void Release(')), /view\.reset\(\); mapping\.reset\(\); file\.reset\(\); archDir\.reset\(\); topDir\.reset\(\);/)
  })
})

describe('lock holder: política de caminhos', () => {
  it('nomes fixos iguais aos do supervisor e do layout de testes', () => {
    const text = main()
    assert.match(text, new RegExp(`kScratchPrefix\\[\\] = L"${BATTERY_SCRATCH_PREFIX}"`))
    assert.match(text, new RegExp(`kTargetFile\\[\\] = L"${SYNTHETIC_HELPER_NAME.replace('.', '\\.')}"`))
    assert.match(text, new RegExp(`kTopDirectory\\[\\] = L"${TEST_HELPERS_DIRECTORY}"`))
    assert.match(text, /kArchDirectory\[\] = L"win32-x64"/)
  })

  it('pasta do caso: forma recusa relativos, \\\\?\\, rede, "/", fluxos, curingas, nomes curtos, "." e ".."', () => {
    const fn = body(main(), 'bool ValidCaseDirShape(')
    assert.match(fn, /!IsDriveLetter\(path\[0\]\) \|\| path\[1\] != L':' \|\| path\[2\] != L'\\\\'/)
    for (const c of ["L'/'", "L':'", "L'*'", "L'?'", `L'"'`, "L'<'", "L'>'", "L'|'", "L'~'", 'c < 0x20']) assert.ok(fn.includes(c), c)
    assert.match(fn, /size == 2 && path\[componentStart \+ 1\] == L'\.'/)
    assert.match(fn, /if \(size == 0\) return false;/)
  })

  it('número do cenário amarrado ao modo (file T-F1, mapping T-F2, directory T-F4)', () => {
    const fn = squash(body(main(), 'wchar_t ScenarioDigit('))
    assert.match(fn, /case Mode::kFile: return L'1';/)
    assert.match(fn, /case Mode::kMapping: return L'2';/)
    assert.match(fn, /case Mode::kDirectory: return L'4';/)
    assert.match(body(main(), 'bool ValidCaseName('), /name\[6\] != ScenarioDigit\(mode\)/)
  })

  it('base autorizada: pasta temporária do sistema resolvida, exatamente dois níveis acima do caso', () => {
    const run = body(main(), 'int Run(')
    assert.match(run, /ResolveTempBase\(tempBase\)/)
    assert.match(run, /BoundedLength\(tempBase, kMaxPathChars\) != baseLength\) return kExitPath/)
    assert.match(run, /CompareStringOrdinal\(g_caseDir, static_cast<int>\(baseLength\), tempBase/)
    assert.match(body(main(), 'bool ResolveTempBase('), /n <= 3/)
  })

  it('cada componente abaixo da base é inspecionado sem seguir links; todo objeto aberto confere caminho final', () => {
    const text = main()
    const inspect = createFileArgs(body(text, 'bool InspectDirectory('))[0]
    assert.match(inspect, /FILE_FLAG_BACKUP_SEMANTICS \| FILE_FLAG_OPEN_REPARSE_POINT/)
    assert.match(inspect, /FILE_READ_ATTRIBUTES \| SYNCHRONIZE/)
    assert.match(body(text, 'bool SameObject('), /PlainObject\(handle, expectDirectory\)[\s\S]*PathsEqual\(resolved, expected\)/)
    assert.match(body(text, 'bool PlainObject('), /FILE_ATTRIBUTE_REPARSE_POINT/)
    for (const fn of ['bool InspectDirectory(', 'bool LockDirectory(', 'bool CheckTargetFile(']) assert.match(body(text, fn), /SameObject\(/, fn)
    assert.match(body(text, 'bool HoldMapping('), /CheckTargetFile\(file\.get\(\)/)
    assert.match(body(text, 'bool LockFile('), /CheckTargetFile\(out\.get\(\)/)
    // Rede, volume e dispositivo recusados no caminho final.
    assert.match(body(text, 'const wchar_t* FinalPath('), /!IsDriveLetter\(g_finalPath\[4\]\)/)
  })

  it('arquivo: disco, tamanho na faixa do launcher e um só nome (sem hard link)', () => {
    const fn = body(main(), 'bool CheckTargetFile(')
    assert.match(fn, /GetFileType\(file\) != FILE_TYPE_DISK/)
    assert.match(fn, /bytes < kMinFileBytes \|\| bytes > kMaxFileBytes/)
    assert.match(fn, /ReadIdentity\(file, true, identity\)/)
    assert.match(body(main(), 'bool ReadIdentity('), /requireSingleName && info\.nNumberOfLinks != 1/)
    assert.match(main(), /kMinFileBytes = 1024;/)
    assert.match(main(), /kMaxFileBytes = 8ull \* 1024ull \* 1024ull;/)
  })
})

describe('lock holder: protocolo e códigos de saída', () => {
  it('códigos 0 e 40–46, distintos, fora da faixa do launcher (20–29)', () => {
    const values = [...exitCodes().matchAll(/constexpr int (kExit\w+) = (\d+);/g)].map((m) => [m[1], Number(m[2])] as const)
    assert.deepEqual(values, [
      ['kExitReleased', 0],
      ['kExitArgs', 40],
      ['kExitEnvironment', 41],
      ['kExitPath', 42],
      ['kExitLock', 43],
      ['kExitSignal', 44],
      ['kExitDeadline', 45],
      ['kExitWait', 46]
    ])
    const readme = read(HOLDER, 'README.md')
    for (const [, value] of values) assert.match(readme, new RegExp(`\\| ${value} \\|`))
  })

  it('linhas de prontidão e liberação com prefixo fixo', () => {
    assert.match(main(), new RegExp(`kLinePrefix\\[\\] = "${LOCK_HOLDER_LINE_PREFIX}"`))
    assert.match(main(), /"ready mode="/)
    assert.match(main(), /"released reason="/)
    for (const reason of ['stdin', 'deadline', 'wait-failure']) assert.match(main(), new RegExp(`SendReleased\\(out, "${reason}"\\)`))
  })
})

describe('lock holder: script de build', () => {
  const script = () => readFileSync(BUILD_SCRIPT, 'utf8')

  it('exige confirmação, grava só em native/lock-holder-test/build e não executa o que compila', () => {
    const text = script()
    assert.match(text, /'--confirm-native-build'/)
    assert.match(text, /'--reproducibility-check'/)
    assert.doesNotMatch(text, /node:child_process|spawn|execFile|exec\(/)
    assert.match(text, /runCompiler\(/)
    assert.match(text, /const BUILD_DIR = join\(HOLDER_DIR, 'build'\)/)
    assert.match(text, /\['x64', 'x64-repro'\]\.includes\(name\)/)
    assert.doesNotMatch(text, /resources['"]?\s*,\s*['"]helpers['"]\s*,\s*['"]win32/)
    assert.match(text, /checkLockHolderBinary\(bytes, forbidden\)/)
    assert.match(text, /executed: false/)
  })

  it('usa as mesmas opções de compilação e ligação dos outros artefatos nativos', () => {
    const text = script()
    assert.match(text, /\.\.\.COMPILE_FLAGS/)
    assert.match(text, /\[\.\.\.BASE_LINK_FLAGS, `\/MANIFESTINPUT:\$\{MANIFEST\}`, 'kernel32\.lib'\]/)
  })
})

describe('lock holder: política do PE', () => {
  const allowed = LOCK_HOLDER_ALLOWED_FUNCTIONS['kernel32.dll']

  it('lista explícita sem nenhuma função proibida; CRT igual ao do alvo sintético', () => {
    for (const name of LOCK_HOLDER_FORBIDDEN_FUNCTIONS) assert.ok(!allowed.includes(name), name)
    for (const name of ['CreateProcessW', 'CreateThread', 'OpenProcess', 'DeleteFileW', 'MoveFileExW', 'SetEndOfFile', 'SetFileInformationByHandle', 'DeviceIoControl', 'LoadLibraryW', 'ReadFile']) {
      assert.ok(!allowed.includes(name), name)
    }
    assert.ok(allowed.includes('CreateFileMappingW') && allowed.includes('MapViewOfFile') && allowed.includes('PeekNamedPipe'))
    assert.equal(new Set(allowed).size, allowed.length)
    // Fora as do próprio código, tudo vem do CRT que o alvo sintético já aceita.
    const own = allowed.slice(0, allowed.indexOf('WriteFile') + 1)
    for (const name of allowed.slice(own.length)) assert.ok(SYNTHETIC_ALLOWED_FUNCTIONS['kernel32.dll'].includes(name), name)
  })

  it('bytes que não são PE são recusados', () => {
    assert.ok(checkLockHolderBinary(Buffer.alloc(4096)).issues.length > 0)
  })

  it('binário compilado (se existir): passa na política, reproduzível e igual ao manifesto do build', { skip: !existsSync(BINARY) }, () => {
    const bytes = readFileSync(BINARY)
    const { issues, unexpectedFunctions, report } = checkLockHolderBinary(bytes, [ROOT])
    assert.deepEqual(issues, [])
    assert.deepEqual(unexpectedFunctions, [])
    assert.deepEqual(report?.imports.map((d) => d.toLowerCase()), ['kernel32.dll'])
    const manifest = JSON.parse(readFileSync(BUILD_MANIFEST, 'utf8'))
    assert.equal(manifest.sha256, sha256(bytes))
    assert.equal(manifest.size, bytes.length)
    assert.equal(manifest.executed, false)
    if (existsSync(BINARY_REPRO)) assert.ok(readFileSync(BINARY_REPRO).equals(bytes))
  })
})

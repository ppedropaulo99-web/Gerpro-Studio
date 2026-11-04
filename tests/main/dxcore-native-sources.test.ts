import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, it } from 'node:test'
import {
  DESCRIPTION_STRIP,
  DXCORE_EXIT_CODES,
  DXCORE_HELPER_ARGS,
  DXCORE_LIMITS,
  DXCORE_PROTOCOL,
  DXCORE_PROTOCOL_VERSION,
  DXCORE_WIRE_ADAPTER_KEYS
} from '../../src/main/hardware/local/dxcore-contract'
import { parseDxcoreResponse } from '../../src/main/hardware/local/dxcore/parser'

// Revisão estática do código-fonte do auxiliar nativo (Etapa 6C.3B.1): nada é
// compilado nem executado. Confere que os fontes C++ seguem o contrato
// TypeScript e as regras de segurança, e que as respostas esperadas pelos
// testes C++ são aceitas pelo parser do app.

const ROOT = join(import.meta.dirname, '../..')
const NATIVE = join(ROOT, 'native', 'dxcore-helper')
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')
/** Código sem comentários (os fontes não têm `//` nem `/*` dentro de strings). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const walk = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []

const SOURCES = ['main.cpp', 'dxcore_loader.cpp', 'dxcore_loader.h', 'adapters.cpp', 'adapters.h', 'description.cpp', 'description.h', 'json_writer.cpp', 'json_writer.h']
const source = (file: string) => read(NATIVE, 'src', file)
const allSourceCode = () => SOURCES.map((f) => [f, code(source(f))] as const)
const TESTS_CPP = () => read(NATIVE, 'tests', 'serializer_tests.cpp')
const goldens = () => [...code(TESTS_CPP()).matchAll(/R"golden\(([\s\S]*?)\)golden"/g)].map((m) => m[1]!)

describe('auxiliar nativo: estrutura', () => {
  it('arquivos previstos, e binários só nas pastas de saída do build (ignoradas pelo git)', () => {
    for (const f of SOURCES) assert.ok(existsSync(join(NATIVE, 'src', f)), f)
    assert.ok(existsSync(join(NATIVE, 'tests', 'serializer_tests.cpp')))
    assert.ok(existsSync(join(NATIVE, 'README.md')))
    const outputDirs = [join(NATIVE, 'build') + sep, join(ROOT, 'native', 'helper-host', 'build') + sep, join(ROOT, 'native', 'lock-holder-test', 'build') + sep, join(ROOT, 'resources', 'helpers') + sep]
    const binaries = [...walk(join(ROOT, 'native')), ...walk(join(ROOT, 'resources')), ...walk(join(ROOT, 'scripts', 'native'))].filter(
      (f) => /\.(exe|dll|obj|lib|pdb|ilk|exp)$/i.test(f) && !outputDirs.some((dir) => f.startsWith(dir))
    )
    assert.deepEqual(binaries, [])
  })

  it('saídas do build ignoradas pelo git', () => {
    const ignore = read(ROOT, '.gitignore')
    for (const line of ['/resources/helpers/', '/native/dxcore-helper/build/', '*.exe', '*.obj', '*.pdb']) assert.match(ignore, new RegExp(`^${line.replace(/[.*/]/g, (c) => `\\${c}`)}$`, 'm'), line)
  })
})

describe('auxiliar nativo: correspondência com o contrato TypeScript', () => {
  it('argumentos, códigos de saída e limites iguais aos do contrato', () => {
    const main = code(source('main.cpp'))
    assert.deepEqual([main.match(/kProtocolFlag\[\] = L"([^"]*)"/)?.[1], main.match(/kProtocolVersion\[\] = L"([^"]*)"/)?.[1]], [...DXCORE_HELPER_ARGS])
    const exits = Object.fromEntries([...main.matchAll(/constexpr int kExit(\w+) = (\d+);/g)].map((m) => [m[1]![0]!.toLowerCase() + m[1]!.slice(1), Number(m[2])]))
    assert.deepEqual(exits, { ...DXCORE_EXIT_CODES })
    assert.equal(Number(code(source('adapters.h')).match(/kMaxAdapters = (\d+);/)?.[1]), DXCORE_LIMITS.maxAdapters)
    assert.equal(Number(code(source('adapters.h')).match(/kMaxDescriptionUnits = (\d+);/)?.[1]), DXCORE_LIMITS.maxDescriptionLength)
    assert.equal(Number(code(source('json_writer.h')).match(/kMaxOutputBytes = (\d+);/)?.[1]), DXCORE_LIMITS.maxOutputBytes)
    assert.equal(Number(code(source('json_writer.h')).match(/kUint64Digits = (\d+);/)?.[1]), DXCORE_LIMITS.maxUint64Digits)
  })

  it('abertura da resposta e ordem das chaves do adaptador', () => {
    const writer = code(source('json_writer.cpp'))
    const start = writer.match(/kResponseStart\[\] = "((?:[^"\\]|\\.)*)";/)?.[1]
    assert.ok(start)
    assert.equal(JSON.parse(`"${start}"`), `{"protocol":"${DXCORE_PROTOCOL}","version":${DXCORE_PROTOCOL_VERSION},"adapters":[`)
    assert.deepEqual([...writer.matchAll(/AppendKey\(out, "(\w+)"/g)].map((m) => m[1]), [...DXCORE_WIRE_ADAPTER_KEYS])
    assert.equal(JSON.parse(`"${writer.match(/kResponseEnd\[\] = "((?:[^"\\]|\\.)*)";/)?.[1]}"`), ']}\n')
  })

  it('conjunto de caracteres removidos da descrição igual a DESCRIPTION_STRIP', () => {
    const body = code(source('description.cpp')).match(/bool IsStrippedUnit\(char16_t unit\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const ranges: Array<[number, number]> = []
    for (const m of body.matchAll(/u <= 0x([0-9A-F]+)u(?! *\))/g)) if (!/>= 0x[0-9A-F]+u && $/.test(body.slice(0, m.index))) ranges.push([0, parseInt(m[1]!, 16)])
    for (const m of body.matchAll(/u >= 0x([0-9A-F]+)u && u <= 0x([0-9A-F]+)u/g)) ranges.push([parseInt(m[1]!, 16), parseInt(m[2]!, 16)])
    for (const m of body.matchAll(/u == 0x([0-9A-F]+)u/g)) ranges.push([parseInt(m[1]!, 16), parseInt(m[1]!, 16)])
    const native = (unit: number) => ranges.some(([a, b]) => unit >= a && unit <= b)
    const contract = new RegExp(DESCRIPTION_STRIP.source)
    const differing: number[] = []
    for (let unit = 0; unit <= 0xffff; unit++) if (native(unit) !== contract.test(String.fromCharCode(unit))) differing.push(unit)
    assert.deepEqual(differing, [])
    assert.ok(ranges.length >= 5)
  })

  it('respostas esperadas pelos testes C++ (goldens) são aceitas pelo parser do app, com os mesmos valores', () => {
    const all = goldens()
    assert.equal(all.length, 5)
    for (const golden of all) {
      assert.ok(/^[\x20-\x7e]+$/.test(golden), 'só ASCII imprimível, sem espaços em branco além do espaço')
      const parsed = parseDxcoreResponse(`${golden}\n`)
      assert.ok(parsed.ok, `${parsed.ok ? '' : parsed.reason}: ${golden.slice(0, 80)}`)
      for (const adapter of (JSON.parse(golden) as { adapters: Array<Record<string, unknown>> }).adapters) {
        assert.deepEqual(Object.keys(adapter), [...DXCORE_WIRE_ADAPTER_KEYS])
      }
    }
    const [minimal, typical, unavailable, limits, escapes] = all.map((g) => parseDxcoreResponse(`${g}\n`)) as Array<Extract<ReturnType<typeof parseDxcoreResponse>, { ok: true }>>
    assert.deepEqual(minimal!.adapters, [])
    assert.deepEqual(typical!.adapters[0], {
      luid: '00000000:0000ABCD',
      vendorId: 4318,
      deviceId: 9637,
      description: 'NVIDIA GeForce RTX 3050 Laptop GPU',
      isHardware: true,
      isIntegrated: false,
      dedicatedAdapterMemory: 4148166656n,
      dedicatedSystemMemory: 0n,
      sharedSystemMemory: 8530190336n
    })
    assert.ok(Object.values(unavailable!.adapters[0]!).every((v) => v === null))
    assert.deepEqual(
      limits!.adapters.map((a) => [a.luid, a.vendorId, a.deviceId, a.isHardware, a.isIntegrated, a.dedicatedAdapterMemory, a.dedicatedSystemMemory, a.sharedSystemMemory]),
      [
        ['FFFFFFFE:00000001', 0xffff_ffff, 0, false, true, 0n, 9007199254740993n, 2n ** 64n - 1n],
        ['00000000:00000000', null, null, true, null, null, null, null],
        ['80000000:FFFFFFFF', null, null, null, null, null, null, null]
      ]
    )
    // Escapes: o texto decodificado é exatamente o que o C++ recebeu.
    const decoded = (JSON.parse(all[4]!) as { adapters: Array<{ description: string }> }).adapters[0]!.description
    assert.equal(decoded, 'A"B\\C' + String.fromCharCode(0xe9, 0x2028, 0xd83d, 0xde00, 0x09) + '/')
    // A barra invertida faz o app descartar a descrição (cara de caminho), sem recusar a resposta.
    assert.equal(escapes!.adapters[0]!.description, null)
  })
})

describe('auxiliar nativo: regras de segurança (revisão estática)', () => {
  it('sem processos, shell, rede, arquivos, Registro, COM ativado, log ou alocação dinâmica', () => {
    const forbidden = [
      /CreateProcess|ShellExecute|WinExec|\bsystem\s*\(|_wsystem|_popen|_wpopen|spawn|exec[lv]/,
      /CreateFile|fopen|_wfopen|std::ofstream|DeleteFile|MoveFile|CopyFile|WriteFileEx/,
      /\bReg[A-Z]\w*\(|HKEY_/,
      /WinHttp|Internet[A-Z]|WSAStartup|\bsocket\s*\(|URLDownload|\bconnect\s*\(/,
      /CoCreateInstance|CoInitialize|CoGetClassObject/,
      /printf|std::cout|std::cerr|OutputDebugString|WriteConsole|STD_ERROR_HANDLE|\bstderr\b|EventWrite|TraceLogging/,
      /\bnew\b|\bdelete\b|malloc|calloc|realloc|HeapAlloc|VirtualAlloc|LocalAlloc|GlobalAlloc|std::vector|std::string/,
      /MicrosoftSignedOnly|ProhibitDynamicCode|ProcessSignaturePolicy|ProcessDynamicCodePolicy/,
      /CreateJobObject|AssignProcessToJobObject/,
      /LoadLibraryW|LoadLibraryA|LoadLibrary\(|LoadPackagedLibrary/,
      /ShellExecute|runas|AdjustTokenPrivileges|ImpersonateLoggedOnUser/,
      /throw\b|\btry\b|\bcatch\b/
    ]
    for (const [file, text] of allSourceCode()) for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${file}: ${pattern}`)
  })

  it('dxcore.dll só da System32, com a busca do processo restrita antes de qualquer carga', () => {
    const loader = code(source('dxcore_loader.cpp'))
    const loads = [...loader.matchAll(/LoadLibraryExW\(([^;]*)\);/g)].map((m) => m[1])
    assert.deepEqual(loads, ['L"dxcore.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32'])
    assert.match(loader, /SetDefaultDllDirectories\(LOAD_LIBRARY_SEARCH_SYSTEM32\)/)
    assert.match(loader, /GetProcAddress\(module, "DXCoreCreateAdapterFactory"\)/)
    for (const policy of ['ProcessImageLoadPolicy', 'ProcessExtensionPointDisablePolicy', 'ProcessStrictHandleCheckPolicy']) assert.match(loader, new RegExp(policy))
    // Ordem em Run(): argumentos, saída, proteções, carga, enumeração, serialização, escrita.
    const main = code(source('main.cpp'))
    const run = main.slice(main.indexOf('int Run('))
    const order = ['ArgumentsAreExact(argc, argv)', 'OutputPipe()', 'HardenLibraryLoading()', 'LoadDxcore(library)', 'EnumerateAdapters(library', 'UnloadDxcore(library)', 'SerializeResponse(', 'WriteAll(output']
    const positions = order.map((s) => run.indexOf(s))
    assert.ok(positions.every((p) => p >= 0), JSON.stringify(positions))
    assert.deepEqual([...positions].sort((a, b) => a - b), positions)
    assert.match(main, /GetStdHandle\(STD_OUTPUT_HANDLE\)/)
    assert.match(main, /GetFileType\(output\) != FILE_TYPE_PIPE/)
  })

  it('<dxcore.h> só no carregador e na enumeração; <initguid.h> só na enumeração; testes sem DXCore', () => {
    const including = (pattern: RegExp) => SOURCES.filter((f) => pattern.test(code(source(f))))
    assert.deepEqual(including(/#include <dxcore\.h>/), ['dxcore_loader.cpp', 'adapters.cpp'])
    assert.deepEqual(including(/#include <initguid\.h>/), ['adapters.cpp'])
    const tests = code(TESTS_CPP())
    assert.doesNotMatch(tests, /dxcore\.h|dxcore_interface|LoadDxcore|EnumerateAdapters|HardenLibraryLoading|LoadLibrary|CreateFile|fopen/)
  })

  it('nenhuma interface do DXCore declarada à mão; HardwareID reduzido a fabricante e dispositivo', () => {
    for (const [file, text] of allSourceCode()) {
      assert.doesNotMatch(text, /(class|struct|interface)\s+IDXCore|DEFINE_GUID|MIDL_INTERFACE|enum class DXCoreAdapterProperty|struct DXCoreHardwareID/, file)
    }
    const adapters = code(source('adapters.cpp'))
    assert.doesNotMatch(adapters, /subSysID|revision/)
    assert.doesNotMatch(adapters, /DriverVersion|KmdModelVersion|HardwareIDParts|IsDetachable|AcgCompatible|QueryState|SetState|CreateDevice|D3D12CreateDevice|D3D11CreateDevice/)
    const properties = [...adapters.matchAll(/DXCoreAdapterProperty::(\w+)/g)].map((m) => m[1])
    assert.deepEqual([...new Set(properties)].sort(), [
      'DedicatedAdapterMemory',
      'DedicatedSystemMemory',
      'DriverDescription',
      'HardwareID',
      'InstanceLuid',
      'IsHardware',
      'IsIntegrated',
      'SharedSystemMemory'
    ])
    assert.match(adapters, /DXCORE_ADAPTER_ATTRIBUTE_D3D11_GRAPHICS/)
  })
})

describe('script de build nativo (revisão estática; não executado)', () => {
  // Desde a 6C.6B.2, o ambiente do MSVC e a chamada do compilador ficam em
  // msvc-toolchain.mjs (compartilhado com o launcher), sem mudança de
  // comportamento: as conferências valem para os dois arquivos juntos.
  const script = () => code(read(ROOT, 'scripts', 'native', 'build-dxcore-helper.mjs')) + '\n' + code(read(ROOT, 'scripts', 'native', 'msvc-toolchain.mjs'))

  it('exige confirmação, MSVC e Windows SDK; não instala nada nem usa rede', () => {
    const s = script()
    assert.match(s, /if \(!args\.includes\(CONFIRM\)\) fail\(/)
    assert.match(s, /const CONFIRM = '--confirm-native-build'/)
    // A confirmação é conferida antes de ler o ambiente e de compilar.
    const body = s.slice(s.indexOf('function main()'))
    assert.ok(body.indexOf('readArgs(process.argv)') >= 0)
    assert.ok(body.indexOf('readArgs(process.argv)') < body.indexOf('readToolchain(acceptSdk)'))
    assert.ok(body.indexOf('readToolchain(acceptSdk)') < body.indexOf("buildOnce(toolchain, 'x64')"))
    for (const name of ['VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion', 'dxcore.h', 'dxcore_interface.h']) assert.ok(s.includes(name), name)
    assert.match(s, /const EXPECTED_SDK_PREFIX = '10\.0\.26100\.'/)
    assert.doesNotMatch(s, /winget|choco|scoop|vs_installer|vs_buildtools|setup\.exe|msiexec|npm (install|i)\b|Invoke-WebRequest|curl|https?:\/\/|fetch\(|node:https?|node:net/i)
  })

  it('exige o MSVC v143 (14.30 a 14.4x), da pasta da própria versão', () => {
    const s = script()
    const source = /const MSVC_V143 = \/(.+)\/\n/.exec(s)?.[1]
    assert.ok(source)
    const v143 = new RegExp(source)
    for (const ok of ['14.30.30705', '14.44.35207', '14.49.1']) assert.ok(v143.test(ok), ok)
    // 14.5x (padrão do Build Tools 2026, sem compiladores nesta máquina), v142 e formatos inválidos.
    for (const bad of ['14.51.36231', '14.29.30133', '14.4.1', '14.44', '14.44.35207x', ' 14.44.35207']) assert.ok(!v143.test(bad), bad)
    const body = s.slice(s.indexOf('function readToolchain('))
    assert.ok(body.indexOf('MSVC_V143.test(env.VCToolsVersion)') >= 0)
    assert.ok(body.indexOf('MSVC_V143.test(env.VCToolsVersion)') < body.indexOf("join(vcDir, 'bin'"))
    assert.match(body, /basename\(resolve\(vcDir\)\) !== env\.VCToolsVersion\) fail\(/)
  })

  it('só o cl.exe é iniciado, por caminho absoluto, sem shell; o auxiliar e os testes nunca são executados', () => {
    const s = script()
    assert.equal([...s.matchAll(/spawnSync\(/g)].length, 1)
    assert.match(s, /spawnSync\(toolchain\.cl, args, \{ cwd, shell: false, windowsHide: true, stdio: 'inherit', env: toolchain\.childEnv \}\)/)
    assert.match(s, /const runCompiler = \(toolchain, args\) => runCompilerWith\(toolchain, args, HELPER_DIR, fail\)/)
    assert.match(s, /const msvcBin = join\(vcDir, 'bin', 'Hostx64', 'x64'\)/)
    assert.match(s, /const cl = join\(msvcBin, 'cl\.exe'\)/)
    assert.match(s, /const vcDir = trustedToolDir\(env\.VCToolsInstallDir, 'VCToolsInstallDir', fail\)/)
    assert.match(s, /const sdkDir = trustedToolDir\(env\.WindowsSdkDir, 'WindowsSdkDir', fail\)/)
    assert.doesNotMatch(s, /shell:\s*true|\bexec\(|execSync|execFile|\bspawn\(|fork\(/)
    assert.doesNotMatch(s, /spawnSync\((helper|tests|output|first)/)
  })

  it('processo do compilador com ambiente restrito: PATH só com MSVC, SDK e System32 (nada do MSYS2 ou do usuário)', () => {
    const s = script()
    const env = s.slice(s.indexOf('const childEnv = {'), s.indexOf('return { cl, childEnv'))
    assert.match(env, /PATH: \[msvcBin, \.\.\.\(existsSync\(sdkBin\) \? \[sdkBin\] : \[\]\), join\(systemRoot, 'System32'\)\]\.join\(';'\)/)
    assert.deepEqual([...env.matchAll(/^\s+(?:\.\.\.\(env\.(\w+) \?|(\w+):)/gm)].map((m) => m[1] ?? m[2]), ['SystemRoot', 'windir', 'PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'TEMP', 'TMP'])
    assert.doesNotMatch(env, /\.\.\.env\b|\.\.\.process\.env|env\.PATH/)
    // As pastas do MSVC e do SDK não podem passar por junção ou link.
    assert.match(s, /realpathSync\.native\(value\)/)
    assert.match(s, /value\.split\(\/\[\\\\\/\]\/\)\.includes\('\.\.'\)/)
    for (const tool of ["'cl.exe', 'link.exe'"]) assert.ok(s.includes(tool))
  })

  it('--check-toolchain só confere o ambiente: sai antes de criar, apagar ou compilar', () => {
    const s = script()
    assert.match(s, /const CHECK_TOOLCHAIN = '--check-toolchain'/)
    const body = s.slice(s.indexOf('function main()'))
    const check = body.indexOf('if (checkOnly) {')
    assert.ok(check > body.indexOf('readToolchain(acceptSdk)'))
    assert.ok(check < body.indexOf("buildOnce(toolchain, 'x64')"))
    assert.match(body.slice(check, body.indexOf('}', body.indexOf('return', check))), /return/)
    assert.match(s, /fail\(`\$\{CHECK_TOOLCHAIN\} não compila: use-o sozinho\.`, 2\)/)
  })

  it('só apaga ou grava em pastas próprias que não sejam links ou junções', () => {
    const s = script()
    assert.equal([...s.matchAll(/rmSync\(/g)].length, 2)
    const fresh = s.slice(s.indexOf('function freshBuildDir(name)'), s.indexOf('function compile('))
    assert.match(fresh, /\['x64', 'x64-repro'\]\.includes\(name\)/)
    const guards = ['assertPlainDir(HELPER_DIR)', 'assertPlainDir(BUILD_DIR)', 'assertPlainDir(dir)', 'rmSync(dir, { recursive: true, force: true })']
    const positions = guards.map((g) => fresh.indexOf(g))
    assert.ok(positions.every((p) => p >= 0))
    assert.deepEqual([...positions].sort((a, b) => a - b), positions)
    assert.match(s, /assertPlainDir\(OUTPUT_DIR\)\n\s+const output = join\(OUTPUT_DIR, HELPER_NAME\)\n\s+if \(existsSync\(output\) && !lstatSync\(output\)\.isFile\(\)\) fail\(/)
  })

  it('não altera o app: grava só o binário (fora do git) e o manifesto sanitizado', () => {
    const s = script()
    assert.equal([...s.matchAll(/writeFileSync\(/g)].length, 2)
    assert.match(s, /writeFileSync\(output, helperBytes\)/)
    assert.match(s, /writeFileSync\(join\(BUILD_DIR, 'x64', 'build-manifest\.json'\), /)
    assert.match(s, /const OUTPUT_DIR = join\(ROOT, 'resources', 'helpers', 'win32-x64'\)/)
    assert.doesNotMatch(s, /'src'|bundled-helper\.ts|dxcore-contract\.ts|package\.json/)
    // O manifesto não leva caminhos absolutos, usuário, máquina nem data.
    const manifest = s.slice(s.indexOf('const manifest = {'), s.indexOf("writeFileSync(join(BUILD_DIR, 'x64', 'build-manifest.json')"))
    assert.doesNotMatch(manifest, /ROOT|HELPER_DIR|USERNAME|USERPROFILE|COMPUTERNAME|hostname|Date|toISOString/)
    assert.match(manifest, /appHash: 'não aplicado/)
    assert.match(manifest, /testsExecuted: false/)
  })

  it('opções de segurança e de reprodutibilidade presentes', () => {
    const s = script()
    for (const flag of ['/guard:cf', '/GS', '/sdl', '/MT', '/EHs-c-', '/Brepro', '/W4', '/WX', '/permissive-', '/std:c++17']) assert.ok(s.includes(`'${flag}'`), flag)
    for (const flag of ['/DYNAMICBASE', '/HIGHENTROPYVA', '/NXCOMPAT', '/GUARD:CF', '/CETCOMPAT', '/DEPENDENTLOADFLAG:0x800', '/DEBUG:NONE', '/MANIFEST:EMBED', 'kernel32.lib']) {
      assert.ok(s.includes(`'${flag}'`), flag)
    }
    assert.match(s, /level='asInvoker' uiAccess='false'/)
    assert.match(s, /rmSync\(first\.helper, \{ force: true \}\)/)
  })
})

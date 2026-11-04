import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { nonDiagnostic } from '../support/launcher-views'
import { DXCORE_HELPER, DXCORE_HELPER_SHA256 } from '../../src/main/hardware/local/bundled-helper'
import { DXCORE_EXIT_CODES, DXCORE_HELPER_ARGS } from '../../src/main/hardware/local/dxcore-contract'
import {
  classifyHostExit,
  DXCORE_HOST,
  DXCORE_HOST_ARGS_PREFIX,
  DXCORE_HOST_EXIT_CODES,
  DXCORE_HOST_HELPER_COMMAND_LINE,
  DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES,
  DXCORE_HOST_PRE_RESUME_EXITS,
  DXCORE_HOST_SHA256,
  DXCORE_HOST_TIMEOUTS,
  dxcoreHostArgs,
  dxcoreHostBlockers
} from '../../src/main/hardware/local/dxcore-host-contract'

// Revisão estática do launcher nativo (Etapa 6C.6B.2): nada é compilado nem
// executado aqui. Confere a sequência de contenção nos fontes C++ (S1–S3), a
// correspondência com o contrato TypeScript (S4) e que nada no app usa o
// launcher (S5: integração não autorizada nesta etapa).

const ROOT = join(import.meta.dirname, '../..')
const HOST = join(ROOT, 'native', 'helper-host')
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')
/** Código sem comentários (os fontes não têm `//` nem `/*` dentro de strings, salvo URLs, que não existem aqui). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const SOURCES = ['main.cpp', 'protocol.cpp', 'protocol.h', 'integrity.cpp', 'integrity.h', 'exit_codes.h']
// main.cpp como os builds de produção e de testes o compilam (blocos diagnósticos resolvidos; 6C.6C.2C).
const src = (file: string) => code(file === 'main.cpp' ? nonDiagnostic(read(HOST, 'src', file)) : read(HOST, 'src', file))
const main = () => src('main.cpp')
const allLauncherCode = () => SOURCES.map((f) => src(f)).join('\n')
const count = (text: string, pattern: RegExp) => [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length

const walk = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []

describe('launcher: estrutura', () => {
  it('fontes, testes, manifesto e README previstos', () => {
    for (const f of [...SOURCES, 'host.manifest']) assert.ok(existsSync(join(HOST, 'src', f)), f)
    assert.ok(existsSync(join(HOST, 'tests', 'protocol_tests.cpp')))
    assert.ok(existsSync(join(HOST, 'README.md')))
  })

  it('saída do build ignorada pelo git; nenhum binário fora das pastas de saída', () => {
    assert.match(read(ROOT, '.gitignore'), /^\/native\/helper-host\/build\/$/m)
    const binaries = walk(HOST).filter((f) => /\.(exe|dll|obj|lib|pdb|ilk|exp)$/i.test(f) && !f.startsWith(join(HOST, 'build')))
    assert.deepEqual(binaries, [])
  })
})

describe('launcher: correspondência com o contrato TypeScript (S4)', () => {
  it('códigos 20–29 iguais', () => {
    const exits = Object.fromEntries(
      [...src('exit_codes.h').matchAll(/constexpr int kExitHost(\w+) = (\d+);/g)].map((m) => [`host${m[1]!}`, Number(m[2])])
    )
    assert.deepEqual(exits, { ...DXCORE_HOST_EXIT_CODES })
    const passthrough = src('exit_codes.h').match(/kHelperContractCodes\[\] = \{([^}]*)\}/)?.[1]?.split(',').map((v) => Number(v.trim()))
    assert.deepEqual(passthrough?.sort((a, b) => a - b), Object.values(DXCORE_EXIT_CODES).sort((a, b) => a - b))
  })

  it('argumentos, nomes, pasta e linha de comando do auxiliar iguais', () => {
    const h = src('protocol.h')
    const literal = (name: string) => h.match(new RegExp(`${name}\\[\\] = L"([^"]*)"`))?.[1]
    assert.deepEqual([literal('kProtocolFlag'), literal('kProtocolVersion'), literal('kHelperHashFlag')], [...DXCORE_HOST_ARGS_PREFIX])
    assert.equal(literal('kHostFileName'), DXCORE_HOST.fileName)
    assert.equal(literal('kHelperFileName'), DXCORE_HOST.helperFileName)
    assert.equal(literal('kHelperFileName'), DXCORE_HELPER.fileName)
    assert.equal(literal('kHelpersDirectory'), DXCORE_HOST.directory)
    assert.equal(main().match(/kHelperCommandLine\[\] = L"([^"]*)"/)?.[1], DXCORE_HOST_HELPER_COMMAND_LINE)
    assert.equal(DXCORE_HOST_HELPER_COMMAND_LINE, `gerpro-dxcore-helper.exe ${DXCORE_HELPER_ARGS.join(' ')}`)
  })

  it('prazos e faixa de tamanho iguais; prazo do launcher abaixo do executor', () => {
    const m = main()
    assert.equal(Number(m.match(/kHelperWaitMs = (\d+);/)?.[1]), DXCORE_HOST_TIMEOUTS.helperWaitMs)
    assert.equal(Number(m.match(/kTerminateConfirmMs = (\d+);/)?.[1]), DXCORE_HOST_TIMEOUTS.terminateConfirmMs)
    assert.ok(DXCORE_HOST_TIMEOUTS.helperWaitMs + DXCORE_HOST_TIMEOUTS.terminateConfirmMs < DXCORE_HELPER.timeoutMs)
    assert.equal(Number(m.match(/kMinHelperBytes = (\d+);/)?.[1]), DXCORE_HELPER.minFileBytes)
    assert.match(m, /kMaxHelperBytes = 8ull \* 1024 \* 1024;/)
    assert.equal(DXCORE_HELPER.maxFileBytes, 8 * 1024 * 1024)
  })
})

describe('launcher: sequência de contenção (S1, S2)', () => {
  it('job sem nome e não herdável; limites só os documentados; nenhuma saída de job', () => {
    const m = main()
    assert.match(m, /::CreateJobObjectW\(nullptr, nullptr\)/)
    assert.match(m, /kJobLimitFlags =\s*JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE \| JOB_OBJECT_LIMIT_ACTIVE_PROCESS \| JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;/)
    assert.match(m, /kActiveProcessLimit = 1;/)
    // Limites relidos e conferidos depois de aplicados.
    assert.match(m, /QueryInformationJobObject\(out\.get\(\), JobObjectExtendedLimitInformation/)
  })

  it('nada de caminho alternativo, saída de job, job por nome, restrição de interface ou limite de memória ainda não medido', () => {
    const all = allLauncherCode()
    for (const forbidden of [
      /BREAKAWAY/,
      /AssignProcessToJobObject/,
      /OpenJobObject/,
      /JobObjectBasicUIRestrictions/,
      /PROC_THREAD_ATTRIBUTE_PARENT_PROCESS/,
      /CreateProcessA\b/,
      /CreateProcessAsUser/,
      /CreateProcessWith/,
      /ShellExecute/,
      /WinExec/,
      /\b_?wsystem\s*\(|\bsystem\s*\(/,
      /_wspawn|_spawn|_wexec|_exec[lv]/,
      /\bLoadLibrary/,
      /\bOpenProcess\b/,
      /JOB_OBJECT_LIMIT_PROCESS_MEMORY|JOB_OBJECT_LIMIT_JOB_MEMORY/,
      /GetEnvironmentVariable|_wgetenv|getenv/
    ]) {
      assert.doesNotMatch(all, forbidden, String(forbidden))
    }
  })

  it('uma única criação de processo: suspensa, com STARTUPINFOEXW, sem console (DETACHED_PROCESS), com herança restrita', () => {
    const m = main()
    assert.equal(count(m, /CreateProcessW\(/), 1)
    const call = m.slice(m.indexOf('::CreateProcessW('), m.indexOf(';', m.indexOf('::CreateProcessW(')))
    for (const flag of ['CREATE_SUSPENDED', 'EXTENDED_STARTUPINFO_PRESENT', 'DETACHED_PROCESS', 'CREATE_UNICODE_ENVIRONMENT', '&startup.StartupInfo', 'g_helperPath', 'g_environment', 'g_systemDir'])
      assert.ok(call.includes(flag), flag)
    // 6C.6C.2E (D67): o auxiliar não ganha console; CREATE_NO_WINDOW e CREATE_NEW_CONSOLE não existem no código.
    assert.match(call, /CREATE_SUSPENDED \| EXTENDED_STARTUPINFO_PRESENT \| DETACHED_PROCESS \| CREATE_UNICODE_ENVIRONMENT,/)
    assert.doesNotMatch(code(read(HOST, 'src', 'main.cpp')), /CREATE_NO_WINDOW|CREATE_NEW_CONSOLE|AllocConsole|AttachConsole/)
    assert.match(m, /startup\.StartupInfo\.cb = sizeof\(startup\);/)
    assert.match(m, /startup\.StartupInfo\.hStdInput = nullptr;/)
    assert.match(m, /startup\.StartupInfo\.hStdError = nullptr;/)
  })

  it('atributos: job na criação, só a saída padrão herdada e política de filhos (defesa adicional)', () => {
    const m = main()
    assert.equal(count(m, /UpdateProcThreadAttribute\(/), 3)
    assert.match(m, /PROC_THREAD_ATTRIBUTE_JOB_LIST, jobList/)
    assert.match(m, /HANDLE jobList\[1\] = \{job\.get\(\)\};/)
    assert.match(m, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inheritList/)
    assert.match(m, /HANDLE inheritList\[1\] = \{inheritableOutput\};/)
    assert.match(m, /PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &childPolicy/)
    assert.match(m, /DWORD childPolicy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;/)
    // O comentário do arquivo não pode vender a política como fronteira de segurança.
    assert.match(read(HOST, 'src', 'main.cpp'), /só defesa adicional, não fronteira de\s*\/\/\s*segurança/)
  })

  it('arquivo do auxiliar travado sem compartilhamento de escrita nem exclusão; pastas sem exclusão', () => {
    const m = main()
    assert.match(m, /CreateFileW\(g_helperPath, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT/)
    assert.match(m, /FILE_LIST_DIRECTORY \| FILE_READ_ATTRIBUTES \| SYNCHRONIZE, FILE_SHARE_READ \| FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,\s*FILE_FLAG_BACKUP_SEMANTICS \| FILE_FLAG_OPEN_REPARSE_POINT/)
  })

  it('única retomada, só depois de job, contabilidade, identidade da imagem e hash definitivo', () => {
    const m = main()
    assert.equal(count(m, /ResumeThread\(/), 1)
    const at = (needle: string) => {
      const i = m.indexOf(needle)
      assert.ok(i >= 0, needle)
      return i
    }
    const resume = at('::ResumeThread(')
    const order = [
      'ParseArguments(argc, argv, expected)',
      'LockDirectory(g_helpersDir',
      'LockHelperFile(helperFile',
      'HashOpenFile(helperFile.get(), helperSize, digest)',
      'CreateContainmentJob(job)',
      '::CreateProcessW(',
      '::IsProcessInJob(process.get(), job.get(), &inJob)',
      'JobAccountingIs(job.get(), 1)',
      'ImageMatches(process.get(), identity)',
      'HashOpenFile(helperFile.get(), helperSize, mapped)',
      'helperFile.Close();'
    ].map(at)
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'ordem da sequência')
    assert.ok(order.every((i) => i < resume))
  })

  it('entre a criação e a retomada, toda falha encerra o job antes de sair', () => {
    const m = main()
    const slice = m.slice(m.indexOf('Handle thread(created.hThread);'), m.indexOf('::ResumeThread('))
    const lines = slice.split('\n').map((l) => l.trim()).filter(Boolean)
    lines.forEach((line, i) => {
      if (/return kExit/.test(line)) assert.match(lines[i - 1] ?? '', /TerminateAndConfirm\(job\.get\(\), process\.get\(\), kExitHost\w+\);/, line)
    })
    assert.ok(lines.some((l) => /return kExitHostVerify;/.test(l)))
    assert.ok(lines.some((l) => /return kExitHostIntegrity;/.test(l)))
  })

  it('fim só confirmado pelo identificador do processo; prazo leva a 27 ou 29', () => {
    const m = main()
    assert.match(m, /TerminateJobObject\(job, code\)/)
    assert.match(m, /WaitForSingleObject\(process, kTerminateConfirmMs\) == WAIT_OBJECT_0/)
    assert.match(m, /TerminateAndConfirm\(job\.get\(\), process\.get\(\), kExitHostTimeout\) \? kExitHostTimeout : kExitHostUnconfirmed/)
    assert.match(m, /return MapHelperExit\(helperExit\);/)
    assert.match(m, /JobAccountingIs\(job\.get\(\), 0\)/)
  })
})

describe('launcher: sem saída própria nem dados sensíveis (S3)', () => {
  it('o launcher não escreve em saída padrão, de erro, console ou depurador', () => {
    const all = allLauncherCode()
    for (const forbidden of [/WriteFile/, /WriteConsole/, /printf/, /\bputs\b/, /fwrite/, /std::cout|std::cerr|std::wcout/, /OutputDebugString/, /stderr|stdout/]) {
      assert.doesNotMatch(all, forbidden, String(forbidden))
    }
  })

  it('testes nativos da lógica pura não criam processos, jobs nem abrem arquivos', () => {
    const tests = code(read(HOST, 'tests', 'protocol_tests.cpp'))
    for (const forbidden of [/CreateProcess/, /CreateJobObject/, /CreateFile/, /ResumeThread/, /TerminateJobObject/, /HashOpenFile/, /integrity\.h/, /main\.cpp/]) {
      assert.doesNotMatch(tests, forbidden, String(forbidden))
    }
  })
})

describe('contrato do launcher (dxcore-host-contract.ts)', () => {
  const hash = 'a'.repeat(64)

  it('argumentos: hash da constante, em formato estrito', () => {
    assert.deepEqual(dxcoreHostArgs(hash), ['--protocol', '1', '--helper-sha256', hash])
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'C:\\x.exe', '', ' '.repeat(64)]) assert.throws(() => dxcoreHostArgs(bad), bad)
    assert.throws(() => dxcoreHostArgs(undefined as unknown as string))
    assert.ok(Object.isFrozen(dxcoreHostArgs(hash)))
  })

  it('classificação dos códigos', () => {
    assert.deepEqual(classifyHostExit(0), { kind: 'helper', code: 0 })
    assert.deepEqual(classifyHostExit(64), { kind: 'helper', code: 64 })
    assert.deepEqual(classifyHostExit(22), { kind: 'host', exit: 'hostJob' })
    assert.deepEqual(classifyHostExit(29), { kind: 'host', exit: 'hostUnconfirmed' })
    assert.deepEqual(classifyHostExit(1), { kind: 'unknown' })
    assert.deepEqual(classifyHostExit(-1073741819), { kind: 'unknown' })
    assert.deepEqual([...DXCORE_HOST_PRE_RESUME_EXITS].map((k) => DXCORE_HOST_EXIT_CODES[k]), [20, 21, 22, 23, 24, 25, 26])
  })

  it('hashes de produção continuam nulos e a execução continua bloqueada', () => {
    assert.deepEqual(DXCORE_HOST_SHA256, { x64: null, arm64: null })
    assert.deepEqual(DXCORE_HELPER_SHA256, { x64: null, arm64: null })
    assert.equal(DXCORE_HOST_JOB_MEMORY_LIMIT_BYTES, null)
    assert.deepEqual(dxcoreHostBlockers('x64', { host: DXCORE_HOST_SHA256, helper: DXCORE_HELPER_SHA256 }), ['host-hash-missing', 'helper-hash-missing', 'memory-limit-pending'])
  })

  it('bloqueios: cada hash é obrigatório e independente; limite de memória obrigatório', () => {
    const both = { x64: hash, arm64: null }
    const none = { x64: null, arm64: null }
    assert.deepEqual(dxcoreHostBlockers('x64', { host: both, helper: none }, 1), ['helper-hash-missing'])
    assert.deepEqual(dxcoreHostBlockers('x64', { host: none, helper: both }, 1), ['host-hash-missing'])
    assert.deepEqual(dxcoreHostBlockers('x64', { host: both, helper: both }, null), ['memory-limit-pending'])
    assert.deepEqual(dxcoreHostBlockers('x64', { host: both, helper: both }, 0), ['memory-limit-pending'])
    assert.deepEqual(dxcoreHostBlockers('x64', { host: both, helper: both }, 64 * 1024 * 1024), [])
    assert.deepEqual(dxcoreHostBlockers('arm64', { host: both, helper: both }, 1), ['host-hash-missing', 'helper-hash-missing'])
    assert.deepEqual(dxcoreHostBlockers('ia32', { host: both, helper: both }, 1), ['unsupported-arch'])
    assert.deepEqual(dxcoreHostBlockers('x64', { host: { x64: 'A'.repeat(64), arm64: null }, helper: both }, 1), ['host-hash-missing'])
  })
})

describe('launcher: não conectado ao app (S5, integração fora desta etapa)', () => {
  it('nenhum módulo do app importa o contrato do launcher ou cita o executável', () => {
    const files = walk(join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('dxcore-host-contract.ts'))
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      assert.doesNotMatch(text, /dxcore-host-contract|gerpro-helper-host/, file)
    }
  })

  it('o executor continua com o auxiliar e os argumentos de sempre', () => {
    assert.equal(DXCORE_HELPER.fileName, 'gerpro-dxcore-helper.exe')
    assert.deepEqual([...DXCORE_HELPER.args], [...DXCORE_HELPER_ARGS])
  })

  it('o script de build não executa o que compila', () => {
    for (const script of ['build-helper-host.mjs', 'msvc-toolchain.mjs']) {
      const text = code(read(ROOT, 'scripts', 'native', script))
      assert.doesNotMatch(text, /execFile|execSync|\bexec\(|spawn\(/, script)
    }
    const toolchain = code(read(ROOT, 'scripts', 'native', 'msvc-toolchain.mjs'))
    assert.equal(count(toolchain, /spawnSync\(/), 1)
    assert.match(toolchain, /spawnSync\(toolchain\.cl, args, \{ cwd, shell: false/)
    assert.doesNotMatch(code(read(ROOT, 'scripts', 'native', 'build-helper-host.mjs')), /spawnSync|child_process/)
  })
})

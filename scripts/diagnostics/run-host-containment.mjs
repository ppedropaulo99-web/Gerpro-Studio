// Supervisor dos testes REAIS de contenção do launcher, Grupo A (Etapa 6C.6C.2A).
// Ponto de entrada em Node; não faz parte do app. Roteiro: docs/11-testes-contencao.md.
//
// Uso (na raiz do projeto):
//   node scripts/diagnostics/run-host-containment.mjs                      → só mostra o plano; nada é iniciado
//   node scripts/diagnostics/run-host-containment.mjs --check-only         → confere pré-condições e artefatos; nada de teste é iniciado
//   node scripts/diagnostics/run-host-containment.mjs --group=A --confirm-host-containment-run [--only=T-E1,T-H1,T-R1,T-R2,T-M1]
//   node scripts/diagnostics/run-host-containment.mjs --diagnose=T-H1.exit-ok --diag-variant=detached --check-only
//       → confere o modo diagnóstico; nada é iniciado
//   node scripts/diagnostics/run-host-containment.mjs --diagnose=T-H1.exit-ok --diag-variant=detached --confirm-host-containment-run
//       → só esse caso, com a variante diagnóstica (6C.6C.2D; a nowindow da 6C.6C.2C não existe mais)
//   node scripts/diagnostics/run-host-containment.mjs --terminate=T-K1.hang --check-only
//       → confere o modo de encerramento; nada é iniciado
//   node scripts/diagnostics/run-host-containment.mjs --terminate=T-K1.hang --confirm-host-containment-run
//       → só esse caso (6C.6C.3A): alvo hang; o supervisor encerra o launcher que iniciou, pelo
//         identificador dele, e confere que o alvo terminou com o job
//   node scripts/diagnostics/run-host-containment.mjs --launcher-timeout=T-T1.hang --check-only
//       → confere o modo de prazo interno; nada é iniciado
//   node scripts/diagnostics/run-host-containment.mjs --launcher-timeout=T-T1.hang --confirm-host-containment-run
//       → só esse caso (6C.6C.3B): alvo hang, sem intervenção; o launcher tem de sair sozinho com 27
//   node scripts/diagnostics/run-host-containment.mjs --repeat=T-K1.hang,T-T1.hang --times=10 --confirm-host-containment-run
//       → lote sequencial (6C.6C.3C): cada caso até 10 vezes, mesmos critérios, para na primeira falha
//   node scripts/diagnostics/run-host-containment.mjs --file-lock=T-F3.hang --confirm-host-containment-run
//       → só esse caso (6C.6C.3E): como o T-T1, com UMA tentativa de abrir o alvo em execução para escrita
//   node scripts/diagnostics/run-host-containment.mjs --file-lock=T-F1.exit-ok --check-only
//   node scripts/diagnostics/run-host-containment.mjs --file-lock=T-F4.exit-ok --check-only
//       → confere o modo do segurador de travas (6C.6C.3G); nada é iniciado
//   node scripts/diagnostics/run-host-containment.mjs --file-lock=T-F1.exit-ok --confirm-host-containment-run
//       → só esse caso: o segurador aprovado segura o arquivo; abertura para escrita, renomeação e exclusão, uma vez cada
//   node scripts/diagnostics/run-host-containment.mjs --file-lock=T-F4.exit-ok --confirm-host-containment-run
//       → só esse caso: o segurador segura as pastas; renomeação de host-test e de win32-x64, uma vez cada
//
// Só os artefatos da 6C.6C.1 (variante de testes e alvos sintéticos) e, só no T-F1/T-F4, o segurador
// de travas da 6C.6C.3F, com os hashes aprovados.
// Nunca o launcher de produção nem o auxiliar DXCore real. O supervisor grava só na pasta
// exclusiva da bateria (pasta temporária do sistema) e na trava. Encerra só, no prazo, o processo
// que ele próprio iniciou, pelo identificador desse processo. Sobreviventes nunca são encerrados
// automaticamente (nem por PID, nem por nome): a bateria para e a inspeção é manual.

import electronPath from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ARTIFACTS = join(ROOT, 'native', 'helper-host', 'build', 'test', 'x64')
// Build do segurador de travas só de teste (6C.6C.3F). Só lido e copiado; a cópia conferida é a que roda.
const LOCK_HOLDER_ARTIFACTS = join(ROOT, 'native', 'lock-holder-test', 'build', 'x64')
const ELECTRON_SCRIPT = fileURLToPath(new URL('./host-containment-electron.mjs', import.meta.url))
const MAX_STDOUT = 4_096

await import('../../tests/support/register.mjs')
const plan = await import('./host-containment/plan.ts')
const checks = await import('./host-containment/system-checks.ts')
const battery = await import('./host-containment/battery.ts')
const holder = await import('./host-containment/lock-holder.ts')
const whoami = await import('./dxcore-supervisor-checks.ts')

const systemRoot = process.env.SystemRoot
const trustedRoot = typeof systemRoot === 'string' && /^[A-Za-z]:\\[^"*?<>|]*$/.test(systemRoot) ? systemRoot : null

/** Ferramenta do sistema por caminho absoluto, sem shell, argumentos fixos, prazo e saída limitada. */
function systemTool(path, args, timeout) {
  if (trustedRoot === null) return null
  const system32 = join(trustedRoot, 'System32')
  const result = spawnSync(path, args, {
    shell: false,
    windowsHide: true,
    cwd: system32,
    env: { SystemRoot: trustedRoot, windir: trustedRoot, PATH: system32 },
    timeout,
    maxBuffer: 1_048_576,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return result.error || result.status !== 0 ? null : result.stdout
}

const tmpRoot = realpathSync.native(tmpdir())
const lockPath = join(tmpRoot, checks.BATTERY_LOCK_NAME)
let lockFd = null

/**
 * Processo iniciado pelo supervisor: saída limitada, tempos de exit/close,
 * encerramento só pelo próprio identificador (`child.kill()` usa o
 * identificador do processo que o Node guardou ao criá-lo; devolve `true`
 * quando o sistema aceita o encerramento). `ready(line)`: instante em que uma
 * linha exatamente igual chegou pela saída padrão.
 */
function supervise(child, started) {
  let stdout = ''
  let stderrBytes = 0
  let exitMs = null
  let exitSignal = null
  const waiters = []
  /** Primeira linha COMPLETA que satisfaz `test`, ou `undefined`. */
  const lineFound = (test) => stdout.split(/\r?\n/).slice(0, -1).find(test)
  const done = new Promise((resolve) => {
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk.toString('latin1').slice(0, MAX_STDOUT - stdout.length)
      const now = Date.now() - started
      for (const w of waiters.splice(0)) {
        const line = lineFound(w.test)
        if (line !== undefined) w.resolve({ ms: now, line })
        else waiters.push(w)
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length
    })
    child.once('exit', (_code, signal) => {
      exitMs = Date.now() - started
      exitSignal = typeof signal === 'string' ? signal : null
    })
    child.once('error', (error) =>
      resolve({ exitCode: null, stdout, stderrBytes, exitMs, closeMs: null, spawnError: typeof error?.code === 'string' ? error.code : 'spawn-error', exitSignal })
    )
    child.once('close', (code) => resolve({ exitCode: code, stdout, stderrBytes, exitMs, closeMs: Date.now() - started, spawnError: null, exitSignal }))
  })
  done.then(() => {
    for (const w of waiters.splice(0)) w.resolve(null)
  })
  const matchLine = (test) => {
    const line = lineFound(test)
    return line !== undefined ? Promise.resolve({ ms: Date.now() - started, line }) : new Promise((resolve) => waiters.push({ test, resolve }))
  }
  const ready = (line) => matchLine((l) => l === line).then((r) => (r === null ? null : r.ms))
  return { pid: child.pid ?? null, done, kill: () => child.kill(), ready, matchLine }
}

const deps = {
  platform: process.platform,
  arch: process.arch,
  tmpRoot,
  artifactsDir: ARTIFACTS,
  fs: {
    mkdtemp: (prefix) => mkdtempSync(prefix),
    lstat: (path) => lstatSync(path),
    readdir: (path) => readdirSync(path),
    unlink: (path) => unlinkSync(path),
    rmdir: (path) => rmdirSync(path),
    realpath: (path) => realpathSync.native(path),
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    writeFile: (path, bytes) => writeFileSync(path, bytes, { flag: 'wx' }),
    readFile: (path) => readFileSync(path),
    symlinkFile: (target, path) => symlinkSync(target, path, 'file')
  },
  electronVersion() {
    try {
      return JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version ?? null
    } catch {
      return null
    }
  },
  integrityLevel() {
    if (trustedRoot === null) return 'unknown'
    const out = systemTool(join(trustedRoot, 'System32', 'whoami.exe'), whoami.WHOAMI_ARGS, 5_000)
    return out === null ? 'unknown' : whoami.integrityLevelFrom(out)
  },
  census() {
    if (trustedRoot === null) return null
    const out = systemTool(join(trustedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), checks.censusArgs(), 30_000)
    return out === null ? null : checks.parseCensus(out)
  },
  acquireLock() {
    try {
      lockFd = openSync(lockPath, 'wx')
      return 'acquired'
    } catch (error) {
      return error?.code === 'EEXIST' ? 'held' : 'error'
    }
  },
  releaseLock() {
    try {
      if (lockFd !== null) closeSync(lockFd)
      unlinkSync(lockPath)
      return true
    } catch {
      return false
    }
  },
  spawnLauncher(executable, args, stdout, cwd) {
    const started = Date.now()
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', stdout === 'pipe' ? 'pipe' : 'ignore', 'pipe'],
      env: { SystemRoot: trustedRoot ?? '', windir: trustedRoot ?? '' }
    })
    return supervise(child, started)
  },
  spawnElectron(scratchPath, caseDir) {
    const started = Date.now()
    const env = { ...process.env, GERPRO_6C6C_SCRATCH: scratchPath, GERPRO_6C6C_CASE: caseDir }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electronPath, [ELECTRON_SCRIPT, plan.CONFIRM_RUN], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    return supervise(child, started)
  },
  electronCensus() {
    if (trustedRoot === null) return null
    const out = systemTool(join(trustedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), checks.censusArgs(['electron.exe']), 30_000)
    return out === null ? null : checks.parseCensus(out)
  },
  electronImagePath: electronPath,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  deadline(ms) {
    let timer
    const reached = new Promise((r) => {
      timer = setTimeout(r, ms)
    })
    return { reached, cancel: () => clearTimeout(timer) }
  },
  log: (line) => process.stdout.write(`${line}\n`),
  // Só no T-F3 (6C.6C.3E). As duas funções só aceitam a cópia do alvo dentro de uma pasta exclusiva da bateria.
  fileFacts(path) {
    assertProbeTarget(path)
    try {
      const st = lstatSync(path)
      // No Windows, o Node tira o bit de escrita do modo quando o arquivo tem FILE_ATTRIBUTE_READONLY.
      return { exists: true, regularFile: st.isFile(), size: st.size, readOnlyAttribute: (st.mode & 0o200) === 0 }
    } catch {
      return { exists: false, regularFile: false, size: null, readOnlyAttribute: null }
    }
  },
  probeWriteOpen(path) {
    assertProbeTarget(path)
    // UMA abertura para escrita (libuv: GENERIC_READ | GENERIC_WRITE, compartilhamento total, OPEN_EXISTING).
    // Nenhum byte é escrito: o identificador, se existir, é fechado na hora.
    let fd = null
    try {
      fd = openSync(path, 'r+')
      return { opened: true, code: null, errno: null }
    } catch (error) {
      return { opened: false, code: typeof error?.code === 'string' ? error.code : 'erro', errno: typeof error?.errno === 'number' ? error.errno : null }
    } finally {
      if (fd !== null) closeSync(fd)
    }
  },
  // Só no T-F1 e no T-F4 (6C.6C.3G). Cada função confere o caminho contra a forma fixa da pasta do caso.
  lockHolderDir: LOCK_HOLDER_ARTIFACTS,
  spawnLockHolder(executable, args, cwd) {
    if (!holder.holderImageAllowed(tmpRoot, executable)) throw new Error('executável fora da cópia conferida do segurador')
    const started = Date.now()
    // Sem shell; entrada em pipe (a liberação é o fechamento dela); ambiente mínimo com TMP = TEMP = pasta temporária resolvida.
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: holder.lockHolderEnv(tmpRoot, trustedRoot ?? '') })
    child.stdin?.on('error', () => {})
    const run = supervise(child, started)
    return {
      ...run,
      // Nenhum byte é escrito: a ponta do supervisor é destruída (CloseHandle), e o segurador vê ERROR_BROKEN_PIPE.
      closeStdin() {
        if (!child.stdin || child.stdin.destroyed) return false
        child.stdin.destroy()
        return true
      }
    }
  },
  statIdentity(path) {
    if (!holder.identityAllowed(tmpRoot, path)) throw new Error('identidade fora da pasta do caso')
    try {
      const st = lstatSync(path, { bigint: true })
      return { dev: st.dev, ino: st.ino, nlink: st.nlink, kind: st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other' }
    } catch {
      return null
    }
  },
  probeRename(from, to) {
    // UMA renomeação (libuv MoveFileExW) entre os nomes fixos da pasta do caso; ou a restauração dela.
    if (!holder.renameAllowed(tmpRoot, from, to)) throw new Error('renomeação fora dos pares fixos da pasta do caso')
    return fsAttempt(() => renameSync(from, to))
  },
  probeUnlink(path) {
    // UMA exclusão, só da cópia do exit-ok no T-F1 (nunca executada).
    if (!holder.unlinkAllowed(tmpRoot, path)) throw new Error('exclusão fora da cópia do alvo no T-F1')
    return fsAttempt(() => unlinkSync(path))
  }
}

/** Resultado de uma operação de arquivo, só com o código (sem mensagem, que tem caminhos). */
function fsAttempt(operation) {
  try {
    operation()
    return { succeeded: true, code: null, errno: null }
  } catch (error) {
    return { succeeded: false, code: typeof error?.code === 'string' ? error.code : 'erro', errno: typeof error?.errno === 'number' ? error.errno : null }
  }
}

/** Alvo do T-F3: só a cópia do alvo sintético, dentro de uma pasta exclusiva da bateria na pasta temporária. */
function assertProbeTarget(path) {
  const scratchPrefix = join(tmpRoot, checks.BATTERY_SCRATCH_PREFIX).toLowerCase()
  const p = String(path)
  if (!p.toLowerCase().startsWith(scratchPrefix) || !p.toLowerCase().endsWith(`\\${plan.SYNTHETIC_HELPER_NAME}`) || p.includes('..')) {
    throw new Error('alvo da tentativa fora da pasta exclusiva da bateria')
  }
}

function printPlan() {
  const out = ['Testes reais de contenção, Grupo A (plano). Nada foi iniciado.', '', 'Pré-condições comuns:']
  for (const p of plan.PRECONDITIONS.common) out.push(`  - ${p}`)
  out.push('', 'Casos (cada um roda UMA vez; qualquer reprovação ou sobrevivente encerra a bateria):')
  for (const c of plan.GROUP_A_CASES) {
    out.push(`  ${c.id}: ${c.description} · alvo ${c.scenario} · esperado ${c.expectedExit} · prazo ${c.deadlineMs} ms${c.alsoCovers ? ` · também ${c.alsoCovers.join(', ')}` : ''}`)
  }
  out.push('', `Executar: node scripts/diagnostics/run-host-containment.mjs --group=A ${plan.CONFIRM_RUN}`)
  process.stdout.write(`${out.join('\n')}\n`)
}

const argv = process.argv.slice(2)
// O filtro diagnóstico é decidido antes e à parte: só aceita exatamente T-H1.exit-ok.
// O filtro de encerramento também: só aceita exatamente T-K1.hang.
// E o de prazo interno (6C.6C.3B): só aceita exatamente T-T1.hang.
// E o de repetição (6C.6C.3C): só T-K1.hang e T-T1.hang, no máximo 10 vezes cada.
// E o de trava pela imagem (6C.6C.3E): só T-F3.hang.
const mode = plan.parseFileLockArgs(argv) ?? plan.parseRepeatArgs(argv) ?? plan.parseLauncherTimeoutArgs(argv) ?? plan.parseTerminationArgs(argv) ?? plan.parseDiagnosisArgs(argv) ?? plan.parseSupervisorArgs(argv)
if (mode.mode === 'usage-error') {
  process.stdout.write(`Uso inválido: ${mode.reason}. Nada foi iniciado.\n`)
  process.exitCode = battery.BATTERY_EXIT.usage
} else if (mode.mode === 'plan') {
  printPlan()
} else if (mode.mode === 'check') {
  const pre = battery.checkPreconditions(deps, plan.GROUP_A_TESTS)
  for (const line of pre.report) process.stdout.write(`pré-condição: ${line}\n`)
  for (const failure of pre.failures) process.stdout.write(`NÃO atendida: ${failure}\n`)
  process.stdout.write(`${pre.failures.length === 0 ? 'Pré-condições atendidas.' : 'Pré-condições NÃO atendidas.'} Nenhum processo de teste foi iniciado.\n`)
  process.exitCode = pre.failures.length === 0 ? 0 : battery.BATTERY_EXIT.precondition
} else if (mode.mode === 'check-diagnose') {
  const pre = battery.checkPreconditions(deps, [plan.DIAGNOSIS_CASE.test], (fs, dir) => battery.validateDiagnosisArtifacts(fs, dir, mode.variant))
  for (const line of pre.report) process.stdout.write(`pré-condição: ${line}\n`)
  for (const failure of pre.failures) process.stdout.write(`NÃO atendida: ${failure}\n`)
  process.stdout.write(`Variante diagnóstica ${mode.variant} (SHA-256 ${plan.APPROVED_DIAG_LAUNCHERS[mode.variant].sha256}).\n`)
  process.stdout.write(`Modo diagnóstico (${plan.DIAGNOSIS_CASE_ID}): ${pre.failures.length === 0 ? 'pré-condições atendidas' : 'pré-condições NÃO atendidas'}. Nenhum processo de teste foi iniciado.\n`)
  process.exitCode = pre.failures.length === 0 ? 0 : battery.BATTERY_EXIT.precondition
} else if (mode.mode === 'check-terminate') {
  const pre = battery.checkPreconditions(deps, [plan.TERMINATION_CASE.test], battery.validateTerminationArtifacts)
  for (const line of pre.report) process.stdout.write(`pré-condição: ${line}\n`)
  for (const failure of pre.failures) process.stdout.write(`NÃO atendida: ${failure}\n`)
  process.stdout.write(`Modo de encerramento (${plan.TERMINATION_CASE_ID}): ${pre.failures.length === 0 ? 'pré-condições atendidas' : 'pré-condições NÃO atendidas'}. Nenhum processo de teste foi iniciado.\n`)
  process.exitCode = pre.failures.length === 0 ? 0 : battery.BATTERY_EXIT.precondition
} else if (mode.mode === 'terminate') {
  process.on('SIGINT', () => {
    process.stdout.write('Interrupção recebida: o caso termina pelos prazos dele.\n')
  })
  const report = await battery.runTermination(deps)
  process.stdout.write(`\n${battery.formatReport(report, `Encerramento ${plan.TERMINATION_CASE_ID} (execução única):`)}\n`)
  process.exitCode = report.exitCode
} else if (mode.mode === 'check-file-lock' && plan.isLockHolderCase(mode.caseId)) {
  // T-F1/T-F4 (6C.6C.3G): só confere; nada é iniciado, nenhuma trava nem pasta é criada.
  const pre = battery.checkLockHolderPreconditions(deps, mode.caseId)
  for (const line of pre.report) process.stdout.write(`pré-condição: ${line}\n`)
  for (const failure of pre.failures) process.stdout.write(`NÃO atendida: ${failure}\n`)
  process.stdout.write(`Modo do segurador de travas (${mode.caseId}): ${pre.failures.length === 0 ? 'pré-condições atendidas' : 'pré-condições NÃO atendidas'}. Nenhum processo de teste foi iniciado.\n`)
  process.exitCode = pre.failures.length === 0 ? 0 : battery.BATTERY_EXIT.precondition
} else if (mode.mode === 'file-lock' && plan.isLockHolderCase(mode.caseId)) {
  process.on('SIGINT', () => {
    process.stdout.write('Interrupção recebida: o caso termina pelos prazos dele.\n')
  })
  const report = await battery.runLockHolderCase(deps, mode.caseId)
  process.stdout.write(`\n${battery.formatReport(report, `Segurador de travas ${mode.caseId} (execução única):`)}\n`)
  process.exitCode = report.exitCode
} else if (mode.mode === 'check-file-lock') {
  const pre = battery.checkPreconditions(deps, [plan.FILE_LOCK_CASE.test], battery.validateTerminationArtifacts)
  for (const line of pre.report) process.stdout.write(`pré-condição: ${line}\n`)
  for (const failure of pre.failures) process.stdout.write(`NÃO atendida: ${failure}\n`)
  process.stdout.write(`Modo de trava pela imagem (${plan.FILE_LOCK_CASE_ID}): ${pre.failures.length === 0 ? 'pré-condições atendidas' : 'pré-condições NÃO atendidas'}. Nenhum processo de teste foi iniciado.\n`)
  process.exitCode = pre.failures.length === 0 ? 0 : battery.BATTERY_EXIT.precondition
} else if (mode.mode === 'file-lock') {
  process.on('SIGINT', () => {
    process.stdout.write('Interrupção recebida: o caso termina pelos prazos dele.\n')
  })
  const report = await battery.runFileLock(deps)
  process.stdout.write(`\n${battery.formatReport(report, `Trava pela imagem ${plan.FILE_LOCK_CASE_ID} (execução única):`)}\n`)
  process.exitCode = report.exitCode
} else if (mode.mode === 'check-repeat') {
  const pre = battery.checkPreconditions(deps, ['T-K1', 'T-T1'], battery.validateTerminationArtifacts)
  for (const line of pre.report) process.stdout.write(`pré-condição: ${line}\n`)
  for (const failure of pre.failures) process.stdout.write(`NÃO atendida: ${failure}\n`)
  process.stdout.write(`Modo de repetição (${mode.plan.cases.join(', ')}; ${mode.plan.times}× cada): ${pre.failures.length === 0 ? 'pré-condições atendidas' : 'pré-condições NÃO atendidas'}. Nenhum processo de teste foi iniciado.\n`)
  process.exitCode = pre.failures.length === 0 ? 0 : battery.BATTERY_EXIT.precondition
} else if (mode.mode === 'repeat') {
  // Ctrl+C: a execução atual termina pelos prazos dela; nenhuma nova começa.
  let stop = false
  process.on('SIGINT', () => {
    stop = true
    process.stdout.write('Interrupção recebida: a execução atual termina pelos prazos dela, depois o lote para.\n')
  })
  const report = await battery.runHangRepeat({ ...deps, stopRequested: () => stop }, mode.plan)
  process.stdout.write(`\n${battery.formatRepeatReport(report)}\n`)
  process.exitCode = report.exitCode
} else if (mode.mode === 'check-launcher-timeout') {
  const pre = battery.checkPreconditions(deps, [plan.LAUNCHER_TIMEOUT_CASE.test], battery.validateTerminationArtifacts)
  for (const line of pre.report) process.stdout.write(`pré-condição: ${line}\n`)
  for (const failure of pre.failures) process.stdout.write(`NÃO atendida: ${failure}\n`)
  process.stdout.write(`Modo de prazo interno (${plan.LAUNCHER_TIMEOUT_CASE_ID}): ${pre.failures.length === 0 ? 'pré-condições atendidas' : 'pré-condições NÃO atendidas'}. Nenhum processo de teste foi iniciado.\n`)
  process.exitCode = pre.failures.length === 0 ? 0 : battery.BATTERY_EXIT.precondition
} else if (mode.mode === 'launcher-timeout') {
  process.on('SIGINT', () => {
    process.stdout.write('Interrupção recebida: o caso termina pelos prazos dele.\n')
  })
  const report = await battery.runLauncherTimeout(deps)
  process.stdout.write(`\n${battery.formatReport(report, `Prazo interno ${plan.LAUNCHER_TIMEOUT_CASE_ID} (execução única):`)}\n`)
  process.exitCode = report.exitCode
} else if (mode.mode === 'diagnose') {
  let stop = false
  process.on('SIGINT', () => {
    stop = true
    process.stdout.write('Interrupção recebida: o caso termina pelo prazo dele.\n')
  })
  const report = await battery.runDiagnosis({ ...deps, stopRequested: () => stop }, mode.variant)
  process.stdout.write(`\n${battery.formatReport(report, `Diagnóstico ${plan.DIAGNOSIS_CASE_ID} (variante diagnóstica ${mode.variant}, execução única):`)}\n`)
  process.exitCode = report.exitCode
} else {
  // Ctrl+C: o supervisor não sai no meio; o prazo de cada caso e o censo seguem valendo.
  let stop = false
  process.on('SIGINT', () => {
    stop = true
    process.stdout.write('Interrupção recebida: o caso atual termina pelo prazo dele, depois a bateria para.\n')
  })
  const report = await battery.runBattery({ ...deps, stopRequested: () => stop }, mode.tests)
  process.stdout.write(`\n${battery.formatReport(report)}\n`)
  process.exitCode = report.exitCode
}

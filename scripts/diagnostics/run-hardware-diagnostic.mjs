// Supervisor do diagnóstico MANUAL de hardware (D55). Ponto de entrada; não faz parte do app.
//
// Uso (na raiz do projeto, num terminal; Node, não Electron):
//   node scripts/diagnostics/run-hardware-diagnostic.mjs                 → só mostra o plano; não inicia o Electron
//   node scripts/diagnostics/run-hardware-diagnostic.mjs --check-only    → só carrega o código; não consulta nada
//   node scripts/diagnostics/run-hardware-diagnostic.mjs --confirm-real-hardware-read [--with-interruption-checks]
//   node scripts/diagnostics/run-hardware-diagnostic.mjs --confirm-luid-shape-read
//   node scripts/diagnostics/run-hardware-diagnostic.mjs --confirm-dxcore-helper-read   → UMA execução do auxiliar DXCore (6C.4A)
//
// No modo DXCore o supervisor, antes de iniciar o Electron, recusa se o processo estiver
// elevado ou se já houver um processo do auxiliar (ou outro diagnóstico DXCore) em
// execução; depois que o Electron encerra, confere que nenhum processo do auxiliar ficou.
//
// Ciclo de vida: o supervisor cria uma pasta temporária exclusiva, inicia o Electron
// (hardware-diagnostic.mjs) com ela, espera o processo encerrar por completo e só então
// remove a pasta que criou. Não toca em pastas de outras execuções. Encerramento forçado
// pelo sistema (ou do próprio supervisor) pode deixar a pasta para trás: o aviso diz isso.

import electronPath from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, lstatSync, mkdtempSync, openSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DXCORE_LOCK_NAME, TASKLIST_ARGS, WHOAMI_ARGS, countHelperProcesses, integrityLevelFrom, isUnelevated } from './dxcore-supervisor-checks.ts'
import { SCRATCH_ENV, formatSupervision, superviseDiagnostic } from './scratch-lifecycle.ts'

const CONFIRM = '--confirm-real-hardware-read'
const CONFIRM_LUID = '--confirm-luid-shape-read'
const CONFIRM_DXCORE = '--confirm-dxcore-helper-read'
const CHECK_ONLY = '--check-only'
const args = process.argv.slice(2)
const confirmations = [CONFIRM, CONFIRM_LUID, CONFIRM_DXCORE].filter((c) => args.includes(c)).length

/**
 * `whoami.exe`/`tasklist.exe` da pasta do sistema, sem shell, argumentos fixos, prazo e
 * limite de saída. A saída só é interpretada aqui (nunca impressa); `null` em qualquer falha.
 */
function systemTool(name, toolArgs) {
  const root = process.env.SystemRoot
  if (typeof root !== 'string' || !/^[A-Za-z]:\\[^"*?<>|]*$/.test(root)) return null
  const system32 = join(root, 'System32')
  const result = spawnSync(join(system32, name), toolArgs, {
    shell: false,
    windowsHide: true,
    cwd: system32,
    env: { SystemRoot: root, windir: root, PATH: system32 },
    timeout: 5_000,
    maxBuffer: 1_048_576,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return result.error || result.status !== 0 ? null : result.stdout
}

const helperProcesses = () => {
  const out = systemTool('tasklist.exe', TASKLIST_ARGS)
  return out === null ? null : countHelperProcesses(out)
}

const PLAN = `Diagnóstico de hardware do Gerpro Studio (manual, somente leitura).

Nada foi consultado e o Electron não foi iniciado.
- ${CONFIRM}: coleta completa (com --with-interruption-checks, também as verificações de interrupção).
- ${CONFIRM_LUID}: só a forma do luid em getGPUInfo('basic'), sem Registro nem outras sondagens.
- ${CONFIRM_DXCORE}: UMA execução do auxiliar DXCore aprovado (sem elevação; pré-condições antes)
  e a comparação com getGPUInfo('basic') e as duas consultas do Registro abaixo; nada de CPU,
  memória, armazenamento ou sistema. Antes: whoami.exe /groups e tasklist.exe (só interpretados).
- ${CHECK_ONLY}: só carrega o código, sem consultas.

Consultas da coleta completa:
- Node os: cpus(), machine(), arch(), totalmem(), freemem(), platform(), release(), version()
- fs.statfs na pasta de dados de aplicativos do usuário (só a raiz do volume aparece)
- Electron app.getGPUInfo('basic')
- reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318} /s /v MatchingDeviceId
- reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318} /s /v HardwareInformation.qwMemorySize
`

if (confirmations > 1) {
  process.stdout.write(`Use só uma confirmação por execução (${CONFIRM}, ${CONFIRM_LUID} ou ${CONFIRM_DXCORE}). Nada foi consultado.\n`)
  process.exitCode = 2
} else if (confirmations === 0 && !args.includes(CHECK_ONLY)) {
  process.stdout.write(`${PLAN}\n`)
} else {
  const dxcore = args.includes(CONFIRM_DXCORE)
  let lockPath = null
  if (dxcore) {
    // Sem elevação, sem outro processo do auxiliar e sem outro diagnóstico DXCore: senão nada é iniciado.
    const whoami = systemTool('whoami.exe', WHOAMI_ARGS)
    const level = whoami === null ? 'unknown' : integrityLevelFrom(whoami)
    const running = helperProcesses()
    process.stdout.write(`Supervisor: nível de integridade ${level}; processos do auxiliar em execução: ${running ?? 'desconhecido'}\n`)
    if (!isUnelevated(level) || running !== 0) {
      process.stdout.write('Pré-condição do supervisor não atendida. O Electron não foi iniciado e o auxiliar não foi executado.\n')
      process.exit(4)
    }
    lockPath = join(realpathSync.native(tmpdir()), DXCORE_LOCK_NAME)
    try {
      closeSync(openSync(lockPath, 'wx'))
    } catch (error) {
      process.stdout.write(`Outro diagnóstico DXCore em andamento, ou trava antiga (${DXCORE_LOCK_NAME} na pasta temporária; ${error?.code ?? 'erro'}). Nada foi iniciado.\n`)
      process.exit(4)
    }
  }
  const fs = {
    mkdtemp: (prefix) => mkdtempSync(prefix),
    lstat: (path) => lstatSync(path),
    readdir: (path) => readdirSync(path),
    unlink: (path) => unlinkSync(path),
    rmdir: (path) => rmdirSync(path),
    realpath: (path) => realpathSync.native(path)
  }
  const electronScript = fileURLToPath(new URL('./hardware-diagnostic.mjs', import.meta.url))

  const result = await superviseDiagnostic({
    fs,
    tmpRoot: realpathSync.native(tmpdir()),
    spawnChild(scratchPath) {
      const child = spawn(electronPath, [electronScript, ...args], {
        stdio: 'inherit',
        shell: false,
        env: { ...process.env, [SCRATCH_ENV]: scratchPath }
      })
      const exited = new Promise((resolve) => {
        child.once('error', (error) => resolve({ code: null, signal: null, spawnError: typeof error?.code === 'string' ? error.code : 'spawn-error' }))
        // 'close': o processo saiu e a saída padrão foi encerrada.
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      return { exited, kill: () => child.kill() }
    },
    onInterrupt(handler) {
      process.on('SIGINT', handler)
      return () => process.off('SIGINT', handler)
    }
  })
  process.stdout.write(`\n${formatSupervision(result)}\n`)
  process.exitCode = result.exitCode
  if (dxcore) {
    // O Electron já encerrou: nenhum processo do auxiliar pode ter ficado.
    const remaining = helperProcesses()
    process.stdout.write(`Supervisor: processos do auxiliar depois do encerramento: ${remaining ?? 'desconhecido'}\n`)
    if (remaining !== 0 && process.exitCode === 0) process.exitCode = 5
    try {
      unlinkSync(lockPath)
    } catch (error) {
      process.stdout.write(`Trava ${DXCORE_LOCK_NAME} não removida (${error?.code ?? 'erro'}); remova manualmente da pasta temporária.\n`)
    }
  }
}

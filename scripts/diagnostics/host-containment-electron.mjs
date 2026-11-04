// Entrada Electron SÓ DE TESTE (Etapa 6C.6C.2A; T-R1 em docs/11-testes-contencao.md).
// Não faz parte do app: não é referenciada pelo build, pelo main, pelo preload nem
// pelo renderer; não abre janela, página, IPC nem rede; não toca a pasta de dados do
// Gerpro Studio nem consentimentos; nunca executa o auxiliar DXCore real.
//
// Não execute diretamente. Quem a inicia é o supervisor
// (scripts/diagnostics/run-host-containment.mjs), depois de todas as pré-condições, com:
//   - o argumento de confirmação;
//   - GERPRO_6C6C_SCRATCH = pasta exclusiva da bateria (conferida: pasta temporária do
//     sistema, prefixo próprio, diretório real);
//   - GERPRO_6C6C_CASE = subpasta do caso, filha direta da pasta exclusiva.
//
// O que faz (uma vez, sem repetição):
//   1. confere o SHA-256 do launcher de testes e do alvo job-probe copiados na subpasta;
//   2. inicia o alvo job-probe DIRETO (child_process do Electron 45: job da libuv);
//   3. inicia o launcher de testes com o mesmo alvo (job J);
//   4. imprime uma linha GERPRO-6C6C-RESULT {json} e sai.
// Cada processo tem prazo próprio; ao estourar, só ele é encerrado (pelo próprio identificador).

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { win32 } from 'node:path'

const CONFIRM_RUN = '--confirm-host-containment-run'
const PROCESS_DEADLINE_MS = 5_000
const MAX_STDOUT = 4_096

const fail = (message, code) => {
  process.stdout.write(`${message} Nada foi executado.\n`)
  app.exit(code)
}

/** Mesmo carregador dos testes e do diagnóstico (remoção de tipos, imports sem extensão). */
async function loadModules() {
  await import('../../tests/support/register.mjs')
  const [plan, checks, scratch, battery] = await Promise.all([
    import('./host-containment/plan.ts'),
    import('./host-containment/system-checks.ts'),
    import('./scratch-lifecycle.ts'),
    import('./host-containment/battery.ts')
  ])
  return { plan, checks, scratch, battery }
}

/** Um processo, sem shell, com saída limitada e prazo; devolve código e a linha do alvo. */
function runOnce(file, args, cwd) {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { SystemRoot: process.env.SystemRoot ?? '', windir: process.env.SystemRoot ?? '' }
    })
    const timer = setTimeout(() => child.kill(), PROCESS_DEADLINE_MS)
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk.toString('latin1').slice(0, MAX_STDOUT - stdout.length)
    })
    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('gerpro-synthetic ')) ?? null
      resolve({ exitCode, line })
    }
    child.once('error', () => finish(null))
    child.once('close', (code) => finish(code))
  })
}

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

async function main() {
  if (!process.argv.includes(CONFIRM_RUN)) return fail('Entrada de teste sem confirmação.', 2)
  const { plan, checks, scratch, battery } = await loadModules()
  const tmpRoot = realpathSync.native(tmpdir())
  const root = scratch.acceptScratch(
    { lstat: (p) => lstatSync(p), realpath: (p) => realpathSync.native(p) },
    process.env.GERPRO_6C6C_SCRATCH,
    tmpRoot,
    process.platform,
    checks.BATTERY_SCRATCH_PREFIX
  )
  if (root === null) return fail('Execute pelo supervisor: pasta exclusiva ausente ou inválida.', 3)
  const caseDir = process.env.GERPRO_6C6C_CASE ?? ''
  let caseOk = false
  try {
    const stat = lstatSync(caseDir)
    caseOk = stat.isDirectory() && !stat.isSymbolicLink() && win32.dirname(realpathSync.native(caseDir)).toLowerCase() === root.toLowerCase()
  } catch {
    caseOk = false
  }
  if (!caseOk) return fail('Subpasta do caso inválida.', 3)

  // Dados do próprio Electron dentro da subpasta do caso; nada na pasta de dados do app.
  const data = win32.join(caseDir, 'electron-data')
  app.setPath('userData', data)
  app.setPath('sessionData', data)
  app.setPath('crashDumps', win32.join(data, 'crash'))

  const arch = win32.join(caseDir, 'host-test', 'win32-x64')
  const launcher = win32.join(arch, plan.TEST_LAUNCHER_NAME)
  const helper = win32.join(arch, plan.SYNTHETIC_HELPER_NAME)
  const probe = plan.APPROVED_ARTIFACTS.scenarios['job-probe']
  try {
    if (sha256File(launcher) !== plan.APPROVED_ARTIFACTS.launcher.sha256 || sha256File(helper) !== probe.sha256) return fail('Cópias diferentes das aprovadas.', 4)
  } catch {
    return fail('Cópias ausentes.', 4)
  }

  const direct = await runOnce(helper, ['--protocol', '1'], arch)
  const viaLauncher = await runOnce(launcher, ['--protocol', '1', '--helper-sha256', probe.sha256], arch)
  const result = { direct, viaLauncher, electronVersion: process.versions.electron ?? null }
  process.stdout.write(`${battery.ELECTRON_RESULT_MARK}${JSON.stringify(result)}\n`)
  app.exit(0)
}

app.disableHardwareAcceleration()
main().catch((error) => fail(`Falha na entrada de teste (${error instanceof Error ? error.name : 'erro'}).`, 1))

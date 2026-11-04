// Parte Electron do diagnóstico MANUAL de hardware (Etapas 6B.2 e 6C.1.1). Não faz parte do app.
//
// Não execute diretamente: o ponto de entrada é o supervisor (D55), que cria a pasta
// temporária, inicia este script com ela e a remove depois que o Electron encerra:
//   node scripts/diagnostics/run-hardware-diagnostic.mjs [--check-only | --confirm-real-hardware-read | --confirm-luid-shape-read | --confirm-dxcore-helper-read]
//
// Isolamento:
// - os dados do próprio Electron (cache, preferências) vão para a pasta do supervisor,
//   conferida antes de tudo; sem ela, nada é iniciado. Este script não cria nem apaga pastas;
// - a pasta de dados do Gerpro Studio e o hardware.json não são abertos;
// - nenhuma janela, nenhuma página, nenhuma rede; o relatório só é impresso no terminal.
// Interromper: Ctrl+C (cancela a coleta e encerra).

import { app } from 'electron'
import { lstatSync, realpathSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCRATCH_ENV, acceptScratch } from './scratch-lifecycle.ts'

const CONFIRM = '--confirm-real-hardware-read'
const INTERRUPTIONS = '--with-interruption-checks'
const CHECK_ONLY = '--check-only'
/** Modo isolado (Etapa 6C.1.1): só `getGPUInfo('basic')`, só a forma do `luid`. Sem Registro nem outras sondagens. */
const CONFIRM_LUID = '--confirm-luid-shape-read'
/** Modo isolado (Etapa 6C.4A): uma execução do auxiliar DXCore aprovado e a comparação só da GPU. */
const CONFIRM_DXCORE = '--confirm-dxcore-helper-read'
const args = process.argv.slice(2)
const confirmations = [CONFIRM, CONFIRM_LUID, CONFIRM_DXCORE].filter((c) => args.includes(c)).length

// Antes de qualquer outra coisa: só a pasta criada pelo supervisor, nunca a pasta de dados real.
const scratch = acceptScratch(
  { lstat: (p) => lstatSync(p), realpath: (p) => realpathSync.native(p) },
  process.env[SCRATCH_ENV],
  realpathSync.native(tmpdir())
)

/** Só nome e código do erro: a mensagem pode conter caminhos com o nome do usuário. */
const describeError = (error) => (error instanceof Error ? `${error.name}${error.code ? ` ${error.code}` : ''}` : 'desconhecido')

/** Carrega o código-fonte TypeScript com o mesmo carregador dos testes, que também proíbe o diagnóstico de importar o Electron. */
async function loadDiagnostic() {
  await import('../../tests/support/register.mjs')
  return import('../../src/main/hardware/local/diagnostic.ts')
}

if (scratch === null) {
  process.stdout.write('Execute pelo supervisor: node scripts/diagnostics/run-hardware-diagnostic.mjs. Nada foi consultado.\n')
  app.exit(3)
} else if (confirmations !== 1 && !args.includes(CHECK_ONLY)) {
  // Nenhuma confirmação, ou as duas: o supervisor já recusa; aqui é a segunda barreira.
  process.stdout.write('Confirmação ausente ou conflitante. Nada foi consultado.\n')
  app.exit(2)
} else {
  app.setPath('userData', scratch)
  app.setPath('sessionData', scratch)
  app.setPath('crashDumps', join(scratch, 'crash'))

  if (args.includes(CHECK_ONLY)) {
    // Sem 'ready', sem getGPUInfo, sem processos: só confere que o código carrega.
    loadDiagnostic()
      .then((m) => process.stdout.write(`Código do diagnóstico carregado: ${typeof m.runHardwareDiagnostic === 'function' ? 'sim' : 'não'}. Nada foi consultado.\n`))
      .catch((error) => process.stdout.write(`Falha ao carregar: ${describeError(error)}\n`))
      .finally(() => app.exit(0))
  } else {
    const luidOnly = args.includes(CONFIRM_LUID)
    const dxcoreOnly = args.includes(CONFIRM_DXCORE)
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
    // Pasta de dados de aplicativos do usuário: o volume onde o app grava. Só `statfs`.
    const appData = app.getPath('appData')

    const controller = new AbortController()
    let exitCode = 0
    process.on('SIGINT', () => {
      controller.abort()
      exitCode = 130
    })

    app.on('window-all-closed', () => undefined)
    app
      .whenReady()
      .then(async () => {
        const { runHardwareDiagnostic, formatDiagnosticReport, runLuidShapeCheck, formatLuidShapeReport } = await loadDiagnostic()
        process.stdout.write(`Ambiente: Electron ${process.versions.electron} · Node ${process.versions.node} · ${process.platform}/${process.arch}\n\n`)
        if (dxcoreOnly) {
          // Só o auxiliar e a GPU (getGPUInfo e as duas consultas do Registro); nenhuma outra sondagem.
          exitCode = await runDxcoreDiagnostic(controller.signal)
          return
        }
        if (luidOnly) {
          // Única fonte: getGPUInfo('basic'). Nenhuma outra sondagem, consulta ou processo.
          const shape = await runLuidShapeCheck((type) => app.getGPUInfo(type), { signal: controller.signal })
          process.stdout.write(`${formatLuidShapeReport(shape)}\n`)
          return
        }
        const report = await runHardwareDiagnostic(
          { getGPUInfo: (type) => app.getGPUInfo(type), storageTarget: { kind: 'app-data', path: appData } },
          { signal: controller.signal, interruptionChecks: args.includes(INTERRUPTIONS) ? { cancelAfterMs: 150, gpuBudgetMs: 200 } : null }
        )
        process.stdout.write(`${formatDiagnosticReport(report)}\n`)
      })
      .catch((error) => {
        exitCode = 1
        process.stdout.write(`Falha no diagnóstico: ${describeError(error)}\n`)
      })
      // A pasta é removida pelo supervisor depois que este processo encerrar por completo.
      .finally(() => app.exit(exitCode))
  }
}

/**
 * Diagnóstico do auxiliar DXCore: pré-condições, UMA execução pelo executor de
 * produção (com o hash do build aprovado) e a comparação só da GPU. Qualquer
 * pré-condição em falha: o auxiliar não é executado (código 4).
 */
async function runDxcoreDiagnostic(signal) {
  await import('../../tests/support/register.mjs')
  const d = await import('./dxcore-diagnostic.ts')
  const projectRoot = realpathSync.native(fileURLToPath(new URL('../..', import.meta.url))).replace(/[\\/]+$/, '')
  const user = process.env.USERNAME
  const forbiddenText = [projectRoot, process.env.USERPROFILE, user ? `\\${user}\\` : undefined].filter((t) => typeof t === 'string')
  const pre = await d.checkDxcorePreconditions({
    projectRoot,
    fs: { lstat: (p) => lstat(p), realpath: (p) => realpath(p), readFile: (p) => readFile(p) },
    platform: process.platform,
    arch: process.arch,
    forbiddenText
  })
  process.stdout.write(`${d.formatPreconditions(pre)}\n\n`)
  if (!d.preconditionsMet(pre)) return 4
  const run = await d.runApprovedHelperOnce(projectRoot, signal)
  const { summary, source } = d.summarizeRun(run)
  const comparison = signal.aborted ? null : await d.compareWithElectron(source, { getGPUInfo: (type) => app.getGPUInfo(type) }, signal)
  process.stdout.write(`${d.formatDxcoreReport(summary, comparison)}\n`)
  return signal.aborted ? 130 : 0
}

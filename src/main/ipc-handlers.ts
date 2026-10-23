import type { Result } from '@shared/errors'
import { IpcChannels } from '@shared/ipc'
import { AppError, toStructuredError } from './errors'
import type { Services } from './services'

/**
 * Handlers dos canais de dados, sem dependência do Electron (testáveis).
 * Cada handler declara quantos argumentos aceita; os valores chegam como
 * `unknown` e são validados pelos serviços.
 */

type Handler = (args: unknown[]) => unknown

interface HandlerSpec {
  arity: number
  run: Handler
}

export type DataChannel = Exclude<(typeof IpcChannels)[keyof typeof IpcChannels], typeof IpcChannels.appGetInfo>

export function createDataHandlers(services: Services): Record<DataChannel, HandlerSpec> {
  const { settings, agents, tools, runs, hardware } = services
  return {
    [IpcChannels.settingsGet]: { arity: 0, run: () => settings.get() },
    [IpcChannels.settingsUpdate]: { arity: 1, run: ([patch]) => settings.update(patch) },
    [IpcChannels.agentsList]: { arity: 0, run: () => agents.list() },
    [IpcChannels.agentsCreate]: { arity: 1, run: ([draft]) => agents.create(draft) },
    [IpcChannels.agentsUpdate]: { arity: 1, run: ([draft]) => agents.update(draft) },
    [IpcChannels.agentsDelete]: { arity: 1, run: async ([id]) => (await agents.remove(id), null) },
    [IpcChannels.toolsList]: { arity: 0, run: () => tools.list(settings.get().tools.enabled) },
    [IpcChannels.runsList]: { arity: 0, run: () => runs.list() },
    [IpcChannels.runsStartDemo]: { arity: 1, run: ([request]) => runs.start(request) },
    [IpcChannels.runsCancel]: { arity: 1, run: ([id]) => runs.cancel(id) },
    [IpcChannels.hardwareGetState]: { arity: 0, run: () => hardware.getState() },
    [IpcChannels.hardwareSetLocalConsent]: { arity: 1, run: ([change]) => hardware.setLocalConsent(change) },
    [IpcChannels.hardwareAnalyze]: { arity: 1, run: ([request]) => hardware.analyze(request) },
    [IpcChannels.hardwareDeleteData]: { arity: 0, run: () => hardware.deleteData() }
  }
}

/** Executa o handler e converte qualquer falha em `StructuredError`. */
export async function invokeHandler(channel: string, spec: HandlerSpec, args: unknown[]): Promise<Result<unknown>> {
  try {
    if (args.length !== spec.arity) {
      throw AppError.validation([{ path: '$', message: `esperado(s) ${spec.arity} argumento(s), recebido(s) ${args.length}` }])
    }
    return { ok: true, data: await spec.run(args) }
  } catch (error) {
    if (!(error instanceof AppError)) console.error(`[ipc] ${channel} falhou:`, error)
    return { ok: false, error: toStructuredError(error) }
  }
}

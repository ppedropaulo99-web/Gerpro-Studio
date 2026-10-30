import type { Result } from '@shared/errors'
import { IpcChannels } from '@shared/ipc'
import { validateDemoRunRequest } from '@shared/runs'
import { AppError, toStructuredError, unwrap } from './errors'
import { PROVIDER_REFRESH_MAX_AGE_MS } from './runs/run-service'
import { demoRunRequest } from './runs/simulated-provider'
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
  const { settings, agents, tools, runs, conversations, hardware } = services
  return {
    [IpcChannels.settingsGet]: { arity: 0, run: () => settings.get() },
    [IpcChannels.settingsUpdate]: { arity: 1, run: ([patch]) => settings.update(patch) },
    // A disponibilidade dos agentes depende do motor real: usa uma verificação recente dos provedores.
    [IpcChannels.agentsList]: { arity: 0, run: async () => (await runs.refreshProviders(PROVIDER_REFRESH_MAX_AGE_MS), agents.list()) },
    [IpcChannels.agentsCreate]: { arity: 1, run: ([draft]) => agents.create(draft) },
    [IpcChannels.agentsUpdate]: { arity: 1, run: ([draft]) => agents.update(draft) },
    [IpcChannels.agentsDelete]: { arity: 1, run: async ([id]) => (await agents.remove(id), null) },
    [IpcChannels.agentsStorageStatus]: { arity: 0, run: async () => agents.storageStatus() },
    [IpcChannels.toolsList]: { arity: 0, run: () => tools.list(settings.get().tools.enabled) },
    [IpcChannels.runsList]: { arity: 0, run: () => runs.list() },
    [IpcChannels.runsStart]: { arity: 1, run: ([request]) => runs.start(request) },
    // Compatibilidade: a demonstração vira um pedido ao provedor simulado, na mesma fila.
    [IpcChannels.runsStartDemo]: { arity: 1, run: ([request]) => runs.start(demoRunRequest(unwrap(validateDemoRunRequest(request)))) },
    [IpcChannels.runsCancel]: { arity: 1, run: ([id]) => runs.cancel(id) },
    [IpcChannels.providersList]: { arity: 0, run: () => runs.providers() },
    [IpcChannels.conversationsList]: { arity: 0, run: () => conversations.list() },
    [IpcChannels.conversationsGet]: { arity: 1, run: ([id]) => conversations.get(id) },
    [IpcChannels.conversationsSend]: { arity: 1, run: ([request]) => conversations.send(request) },
    [IpcChannels.conversationsRename]: { arity: 2, run: ([id, title]) => conversations.rename(id, title) },
    [IpcChannels.conversationsDelete]: { arity: 1, run: async ([id]) => (await conversations.remove(id), null) },
    [IpcChannels.conversationsRetrySave]: { arity: 1, run: ([id]) => conversations.retrySave(id) },
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

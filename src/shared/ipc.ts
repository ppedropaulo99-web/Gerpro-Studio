/**
 * Contrato de IPC compartilhado entre Main, Preload e Renderer.
 *
 * Toda comunicação passa por canais declarados aqui: o Preload só expõe
 * esses canais e o Main só registra handlers para eles. Um canal novo
 * começa neste arquivo.
 */

import type { AgentDraft, AgentRecord } from './agents'
import type { Result } from './errors'
import type { DemoRunRequest, RunRecord } from './runs'
import type { AppSettings, SettingsPatch } from './settings'
import type { ToolCatalogEntry } from './tools'

export const IpcChannels = {
  appGetInfo: 'app:get-info',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  agentsList: 'agents:list',
  agentsSave: 'agents:save',
  agentsDelete: 'agents:delete',
  toolsList: 'tools:list',
  runsList: 'runs:list',
  runsStartDemo: 'runs:start-demo',
  runsCancel: 'runs:cancel'
} as const

/** Canais de evento Main → Renderer. */
export const IpcEvents = {
  runsUpdated: 'runs:updated'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

export interface AppInfo {
  name: string
  version: string
  platform: string
  versions: {
    electron: string
    chrome: string
    node: string
  }
}

/** API exposta ao Renderer via contextBridge como `window.gerpro`. */
export interface GerproApi {
  app: {
    getInfo(): Promise<AppInfo>
  }
  settings: {
    get(): Promise<Result<AppSettings>>
    update(patch: SettingsPatch): Promise<Result<AppSettings>>
  }
  agents: {
    /** Inclui a disponibilidade calculada de cada agente. */
    list(): Promise<Result<AgentRecord[]>>
    save(draft: AgentDraft): Promise<Result<AgentRecord>>
    remove(id: string): Promise<Result<null>>
  }
  tools: {
    list(): Promise<Result<ToolCatalogEntry[]>>
  }
  runs: {
    /** Somente execuções desta sessão. Todas têm `origin: 'simulated'` nesta etapa. */
    list(): Promise<Result<RunRecord[]>>
    /** Inicia uma execução SIMULADA: nenhum modelo ou ferramenta é chamado. */
    startDemo(request: DemoRunRequest): Promise<Result<RunRecord>>
    cancel(id: string): Promise<Result<RunRecord>>
    /** Recebe cada mudança de execução. Devolve a função que cancela a inscrição. */
    onUpdated(listener: (run: RunRecord) => void): () => void
  }
}

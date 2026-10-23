import { join } from 'node:path'
import { DemoRunManager } from '../runs/demo-run-manager'
import { BUILTIN_TOOLS } from '../tools/catalog'
import { ToolRegistry } from '../tools/tool-registry'
import { AgentService } from './agent-service'
import { SettingsService } from './settings-service'

export interface Services {
  settings: SettingsService
  agents: AgentService
  tools: ToolRegistry
  runs: DemoRunManager
}

/**
 * Monta os serviços do Main sobre `dataDir` (em produção, `userData/storage`).
 * Não importa o Electron, para que testes usem um diretório temporário.
 */
export async function createServices(dataDir: string, options: { stepDelayMs?: number } = {}): Promise<Services> {
  const settings = new SettingsService(join(dataDir, 'settings.json'))
  const tools = new ToolRegistry(BUILTIN_TOOLS)
  // Nenhum motor de inferência nesta etapa.
  const agents = new AgentService({ filePath: join(dataDir, 'agents.json'), tools, settings, engineAvailable: () => false })

  for (const [name, status] of [
    ['settings', await settings.init()],
    ['agents', await agents.init()]
  ] as const) {
    if (status.state === 'recovered' || status.state === 'read-only') {
      console.warn(`[storage] ${name}: ${status.state}`, status.issues, status.backupPath ?? '')
    }
  }

  const runs = new DemoRunManager({
    stepDelayMs: options.stepDelayMs,
    canRun: (agentId) => {
      const agent = agents.find(agentId)
      if (!agent) return { ok: false, reason: `Agente "${agentId}" não encontrado.` }
      if (agent.state === 'archived') return { ok: false, reason: 'Agente arquivado não pode ser executado.' }
      return { ok: true }
    }
  })

  return { settings, agents, tools, runs }
}

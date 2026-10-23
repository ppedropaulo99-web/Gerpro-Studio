import { join } from 'node:path'
import { DemoHardwareDetector, UnimplementedLocalDetector } from '../hardware/detectors'
import { HardwareAdvisorService } from '../hardware/hardware-advisor-service'
import { RunService } from '../runs/run-service'
import { SimulatedInferenceProvider } from '../runs/simulated-provider'
import { BUILTIN_TOOLS } from '../tools/catalog'
import { ToolRegistry } from '../tools/tool-registry'
import { AgentService } from './agent-service'
import { SettingsService } from './settings-service'

export interface Services {
  settings: SettingsService
  agents: AgentService
  tools: ToolRegistry
  runs: RunService
  hardware: HardwareAdvisorService
}

/**
 * Monta os serviços do Main sobre `dataDir` (em produção, `userData/storage`).
 * Não importa o Electron, para que testes usem um diretório temporário.
 */
export async function createServices(
  dataDir: string,
  options: { stepDelayMs?: number; flushIntervalMs?: number } = {}
): Promise<Services> {
  const settings = new SettingsService(join(dataDir, 'settings.json'))
  const tools = new ToolRegistry(BUILTIN_TOOLS)
  // Só o provedor simulado está registrado: a infraestrutura de execução
  // funciona, mas não há motor real. `engineAvailable` responde só pelo motor
  // real; a simulação nunca deixa um agente operacional.
  let runs: RunService | undefined
  const agents = new AgentService({
    filePath: join(dataDir, 'agents.json'),
    tools,
    settings,
    engineAvailable: () => runs?.capabilities().realEngine === 'available'
  })
  // Detecção real ainda não implementada: só o detector demonstrativo funciona.
  const hardware = new HardwareAdvisorService({
    filePath: join(dataDir, 'hardware.json'),
    localDetector: new UnimplementedLocalDetector(),
    demoDetector: (scenario) => new DemoHardwareDetector(scenario)
  })

  for (const [name, status] of [
    ['settings', await settings.init()],
    ['agents', await agents.init()],
    ['hardware', await hardware.init()]
  ] as const) {
    if (status.state === 'recovered' || status.state === 'read-only') {
      console.warn(`[storage] ${name}: ${status.state}`, status.issues, status.backupPath ?? '')
    }
  }

  runs = new RunService({
    providers: [new SimulatedInferenceProvider({ stepDelayMs: options.stepDelayMs })],
    findAgent: (id) => agents.find(id),
    flushIntervalMs: options.flushIntervalMs
  })

  return { settings, agents, tools, runs, hardware }
}

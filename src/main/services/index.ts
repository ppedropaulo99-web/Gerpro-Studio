import { join } from 'node:path'
import type { InferenceProvider } from '@shared/inference'
import { OllamaInferenceProvider } from '../engine/ollama/ollama-provider'
import { DemoHardwareDetector, UnimplementedLocalDetector } from '../hardware/detectors'
import { HardwareAdvisorService } from '../hardware/hardware-advisor-service'
import { RunService } from '../runs/run-service'
import { SimulatedInferenceProvider } from '../runs/simulated-provider'
import { BUILTIN_TOOLS } from '../tools/catalog'
import { ToolRegistry } from '../tools/tool-registry'
import { AgentService } from './agent-service'
import { ConversationService } from './conversation-service'
import { SettingsService } from './settings-service'

export interface Services {
  settings: SettingsService
  agents: AgentService
  tools: ToolRegistry
  runs: RunService
  conversations: ConversationService
  hardware: HardwareAdvisorService
}

/**
 * Monta os serviços do Main sobre `dataDir` (em produção, `userData/storage`).
 * Não importa o Electron, para que testes usem um diretório temporário.
 */
export async function createServices(
  dataDir: string,
  options: {
    stepDelayMs?: number
    flushIntervalMs?: number
    /**
     * Endereço (loopback) do Ollama. Sem ele, o adaptador não é registrado:
     * o app de produção passa `OLLAMA_DEFAULT_URL`; testes não dependem de
     * um Ollama instalado.
     */
    ollamaBaseUrl?: string
  } = {}
): Promise<Services> {
  const settings = new SettingsService(join(dataDir, 'settings.json'))
  const tools = new ToolRegistry(BUILTIN_TOOLS)
  // `engineAvailable` responde só pelo motor real (provedor real pronto e com
  // o modelo do agente instalado); a simulação nunca deixa um agente operacional.
  let runs: RunService | undefined
  const agents = new AgentService({
    filePath: join(dataDir, 'agents.json'),
    tools,
    settings,
    engineAvailable: (model) => runs?.canRunReal(model) ?? false
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

  const providers: InferenceProvider[] = [new SimulatedInferenceProvider({ stepDelayMs: options.stepDelayMs })]
  if (options.ollamaBaseUrl !== undefined) providers.push(new OllamaInferenceProvider({ baseUrl: options.ollamaBaseUrl }))
  runs = new RunService({
    providers,
    findAgent: (id) => agents.find(id),
    flushIntervalMs: options.flushIntervalMs
  })
  // Sem esperar: o app abre mesmo com o Ollama desligado ou lento.
  void runs.refreshProviders()

  const conversations = new ConversationService({ dir: join(dataDir, 'conversations'), runs, findAgent: (id) => agents.find(id) })
  const loaded = await conversations.init()
  if (loaded.damaged > 0) console.warn(`[storage] conversations: ${loaded.damaged} arquivo(s) ignorado(s)`)

  return { settings, agents, tools, runs, conversations, hardware }
}

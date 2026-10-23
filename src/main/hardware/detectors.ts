import type { DemoScenario, DetectorAvailability, HardwareDetector, HardwareProfile } from '@shared/hardware'

/**
 * Detectores do Hardware Advisor.
 *
 * - `UnimplementedLocalDetector`: lugar reservado para a detecção real.
 *   Sempre indisponível nesta etapa; nunca lê nada do computador.
 * - `DemoHardwareDetector`: devolve perfis FICTÍCIOS, com nomes de hardware
 *   inventados e `provenance.source = 'demo'`. Não consulta o sistema.
 */

export class UnimplementedLocalDetector implements HardwareDetector {
  readonly id = 'local-unimplemented'
  readonly source = 'local-detector' as const

  async availability(): Promise<DetectorAvailability> {
    return { available: false, reason: 'A detecção real de hardware ainda não foi implementada.' }
  }

  async detect(): Promise<HardwareProfile> {
    throw new Error('Detecção real de hardware não implementada.')
  }
}

const DAY = 86_400_000

type DemoProfile = Omit<HardwareProfile, 'provenance'> & { confidence: HardwareProfile['provenance']['confidence']; ageDays?: number }

/** Perfis fictícios. Nomes propositalmente genéricos para não parecerem hardware real. */
export const DEMO_PROFILES: Record<Exclude<DemoScenario, 'error'>, DemoProfile> = {
  workstation: {
    cpu: { model: 'CPU Demonstrativa X12 (fictícia)', architecture: 'x64', physicalCores: 12, logicalCores: 24 },
    memory: { totalGb: 32, availableGb: 21.5 },
    gpus: [{ vendor: 'other', model: 'GPU Demonstrativa G12 (fictícia)', vramGb: 12, sharedMemory: false }],
    storage: { freeGb: 412, totalGb: 1000 },
    os: { platform: 'windows', version: '11 (demonstração)', architecture: 'x64' },
    acceleration: ['avx2', 'cuda', 'vulkan', 'directml'],
    confidence: 'high'
  },
  modest: {
    cpu: { model: 'CPU Demonstrativa L4 (fictícia)', architecture: 'x64', physicalCores: 2, logicalCores: 4 },
    memory: { totalGb: 8, availableGb: 2.6 },
    gpus: [],
    storage: { freeGb: 9, totalGb: 256 },
    os: { platform: 'windows', version: '10 (demonstração)', architecture: 'x64' },
    acceleration: [],
    confidence: 'high'
  },
  partial: {
    cpu: { model: 'CPU Demonstrativa M8 (fictícia)', architecture: 'x64', physicalCores: 8, logicalCores: 16 },
    memory: { totalGb: 16, availableGb: 9.1 },
    gpus: null,
    storage: null,
    os: { platform: 'windows', version: '11 (demonstração)', architecture: 'x64' },
    acceleration: null,
    confidence: 'low'
  },
  stale: {
    cpu: { model: 'CPU Demonstrativa X12 (fictícia)', architecture: 'x64', physicalCores: 12, logicalCores: 24 },
    memory: { totalGb: 32, availableGb: 18 },
    gpus: [{ vendor: 'other', model: 'GPU Demonstrativa G12 (fictícia)', vramGb: 12, sharedMemory: false }],
    storage: { freeGb: 380, totalGb: 1000 },
    os: { platform: 'windows', version: '11 (demonstração)', architecture: 'x64' },
    acceleration: ['avx2', 'cuda'],
    confidence: 'medium',
    ageDays: 95
  }
}

export class DemoHardwareDetector implements HardwareDetector {
  readonly id: string
  readonly source = 'demo' as const
  private readonly scenario: DemoScenario
  private readonly now: () => Date

  constructor(scenario: DemoScenario, now: () => Date = () => new Date()) {
    this.scenario = scenario
    this.now = now
    this.id = `demo-${scenario}`
  }

  async availability(): Promise<DetectorAvailability> {
    return { available: true, reason: null }
  }

  async detect(signal: AbortSignal): Promise<HardwareProfile> {
    signal.throwIfAborted()
    if (this.scenario === 'error') throw new Error('Falha simulada do detector demonstrativo.')
    const { confidence, ageDays = 0, ...profile } = DEMO_PROFILES[this.scenario]
    return structuredClone({
      ...profile,
      provenance: {
        source: 'demo',
        detectorId: this.id,
        collectedAt: new Date(this.now().getTime() - ageDays * DAY).toISOString(),
        confidence
      }
    })
  }
}

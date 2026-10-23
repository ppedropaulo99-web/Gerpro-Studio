import type { AgentRecord } from '@shared/agents'
import type { HardwareAdvisorState, HardwareProfile } from '@shared/hardware'
import { usableProfile } from '@shared/hardware'
import { gb, type AgentRequirements, type ModelAvailability, type ModelProfile, type RecommendationCandidate, type TaskType } from '@shared/recommendations'
import type { Agent, LibraryModel } from '@renderer/data/types'

/**
 * Adaptadores entre os dados da interface e o Hardware Advisor (`@shared`).
 * Puros: sem React e sem `window`, para que possam ser testados e reaproveitados.
 */

const MODEL_AVAILABILITY: Record<LibraryModel['status'], ModelAvailability> = {
  loaded: 'installed',
  available: 'installed',
  downloading: 'downloading',
  error: 'error'
}

export function modelProfileFrom(model: LibraryModel): ModelProfile {
  return {
    id: model.id,
    name: model.name,
    sizeGb: model.sizeGb,
    contextLength: model.contextLength,
    capabilities: model.capabilities,
    availability: MODEL_AVAILABILITY[model.status]
  }
}

/** Agentes salvos e exemplos, no formato que o motor de recomendações entende. */
export function buildCandidates(
  saved: readonly AgentRecord[],
  examples: readonly Agent[],
  library: readonly LibraryModel[],
  exampleProfiles: Readonly<Record<string, { taskTypes: TaskType[]; requirements?: AgentRequirements }>>
): RecommendationCandidate[] {
  const modelFor = (id: string | null) => {
    const found = id ? library.find((m) => m.id === id) : undefined
    return found ? modelProfileFrom(found) : null
  }

  const fromSaved = saved
    .filter((a) => a.definition.state !== 'archived')
    .map(({ definition: d }): RecommendationCandidate => ({
      agentId: d.id,
      name: d.name,
      origin: 'saved',
      // A definição de agente ainda não declara tarefas nem requisitos (ver pendências).
      taskTypes: null,
      requirements: null,
      modelRef: d.model?.modelId ?? null,
      model: modelFor(d.model?.modelId ?? null),
      tools: d.tools
    }))

  const fromExamples = examples.map((e): RecommendationCandidate => ({
    agentId: e.id,
    name: e.name,
    origin: 'example',
    taskTypes: exampleProfiles[e.id]?.taskTypes ?? null,
    requirements: exampleProfiles[e.id]?.requirements ?? null,
    modelRef: e.modelId,
    model: modelFor(e.modelId),
    tools: e.tools
  }))

  return [...fromSaved, ...fromExamples]
}

/** Perfil para recomendações e o motivo quando não há um. */
export function advisorHardware(state: HardwareAdvisorState | null): { profile: HardwareProfile | null; note: string } {
  if (!state) return { profile: null, note: 'Estado do Hardware Advisor indisponível.' }
  const profile = usableProfile(state)
  if (profile) return { profile, note: '' }
  const note: Record<HardwareAdvisorState['status'], string> = {
    'not-authorized': 'Análise de hardware não autorizada: compatibilidade desconhecida.',
    'awaiting-analysis': 'Nenhuma análise de hardware realizada ainda.',
    unavailable: 'A análise de hardware não pôde ser feita (detector indisponível).',
    error: 'A última análise de hardware falhou.',
    completed: '',
    stale: ''
  }
  return { profile: null, note: note[state.status] }
}

export interface DiagnosticRow {
  label: string
  value: string
  known: boolean
}

/** Linhas do diagnóstico. Campos não identificados aparecem como tal, nunca inventados. */
export function diagnosticRows(p: HardwareProfile): DiagnosticRow[] {
  const unknown = (label: string): DiagnosticRow => ({ label, value: 'Não identificado', known: false })
  const platform = { windows: 'Windows', macos: 'macOS', linux: 'Linux', other: 'Outro' } as const
  return [
    p.cpu
      ? { label: 'Processador', value: `${p.cpu.model} · ${p.cpu.architecture} · ${p.cpu.physicalCores} núcleos / ${p.cpu.logicalCores} threads`, known: true }
      : unknown('Processador'),
    p.memory ? { label: 'Memória RAM', value: `${gb(p.memory.totalGb)} (${gb(p.memory.availableGb)} livres)`, known: true } : unknown('Memória RAM'),
    p.gpus === null
      ? unknown('GPU e VRAM')
      : {
          label: 'GPU e VRAM',
          value: p.gpus.length
            ? p.gpus
                .map((g) => `${g.model} · ${g.sharedMemory ? 'memória compartilhada' : g.vramGb === null ? 'VRAM não informada' : gb(g.vramGb)}`)
                .join('; ')
            : 'Nenhuma GPU dedicada',
          known: true
        },
    p.storage ? { label: 'Armazenamento', value: `${gb(p.storage.freeGb)} livres de ${gb(p.storage.totalGb)}`, known: true } : unknown('Armazenamento'),
    p.os ? { label: 'Sistema operacional', value: `${platform[p.os.platform]} ${p.os.version} · ${p.os.architecture}`, known: true } : unknown('Sistema operacional'),
    p.acceleration === null
      ? unknown('Aceleração')
      : { label: 'Aceleração', value: p.acceleration.length ? p.acceleration.map((a) => a.toUpperCase()).join(', ') : 'Nenhuma conhecida', known: true }
  ]
}

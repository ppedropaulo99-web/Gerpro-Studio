import type { AgentRecord } from '@shared/agents'
import type { HardwareAdvisorState, HardwareProfile } from '@shared/hardware'
import { usableProfile } from '@shared/hardware'
import {
  gb,
  type AgentRequirements,
  type LocalCapability,
  type ModelAvailability,
  type ModelProfile,
  type Recommendation,
  type RecommendationCandidate,
  type ReasonFactor,
  type TaskType
} from '@shared/recommendations'
import type { Agent, LibraryModel } from '@renderer/data/types'

/**
 * Adaptadores entre os dados da interface e o Hardware Advisor (`@shared`).
 * Puros: sem React e sem `window`, para que possam ser testados e reaproveitados.
 */

/** Estado ilustrativo dos exemplos; o motor de recomendações não o trata como real (`source: 'example'`). */
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
    availability: MODEL_AVAILABILITY[model.status],
    // A biblioteca da interface é de exemplo: nada aqui foi detectado neste computador.
    source: 'example'
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
      // Finalidade vazia = não declarada. Requisitos ainda não fazem parte do agente (ver pendências).
      taskTypes: d.taskTypes.length > 0 ? d.taskTypes : null,
      requirements: null,
      modelRef: d.defaultModel?.modelId ?? null,
      model: modelFor(d.defaultModel?.modelId ?? null),
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

/**
 * Conclusão simples do Advisor: o que a estimativa indica e o que fazer.
 * Só apresentação, derivada do resultado já calculado em `@shared`; os detalhes
 * técnicos ficam recolhidos na tela. Fala do perfil analisado, nunca julga o equipamento.
 */
export interface AdvisorConclusion {
  headline: string
  action: string
}

export function capabilityConclusion(estimate: LocalCapability): AdvisorConclusion {
  const upTo = estimate.maxModelSizeGb === null ? '' : ` de até ~${gb(estimate.maxModelSizeGb)}`
  switch (estimate.level) {
    case 'high':
      return {
        headline: 'Estimativa: o perfil analisado deve comportar modelos grandes e médios.',
        action: 'Todos os agentes da biblioteca são opções; os detalhes de cada um aparecem em Agentes.'
      }
    case 'medium':
      return {
        headline: 'Estimativa: o perfil analisado deve comportar modelos pequenos e médios.',
        action: `Prefira agentes com modelos${upTo}.`
      }
    case 'low':
      return {
        headline: 'Estimativa: modelos pequenos são os mais indicados para o perfil analisado.',
        action: `Prefira agentes com modelos leves${upTo && `,${upTo}`}; modelos maiores tendem a responder mais devagar.`
      }
    case 'insufficient':
      return {
        headline: 'Estimativa: os modelos locais teriam pouca folga de memória no perfil analisado.',
        action: 'Prefira os modelos mais leves e feche outros aplicativos antes de usar um agente.'
      }
    case 'unknown':
      return {
        headline: 'Ainda não há dados suficientes para estimar.',
        action: 'Execute uma nova análise para obter uma estimativa.'
      }
  }
}

const LIMITATION_ACTION: Partial<Record<ReasonFactor, string>> = {
  memory: 'Feche outros aplicativos antes de usar, para liberar memória.',
  gpu: 'Espere respostas mais demoradas do que em um perfil com GPU dedicada.',
  cpu: 'Espere respostas mais demoradas.',
  acceleration: 'Espere respostas mais demoradas.',
  storage: 'Libere espaço em disco antes de baixar o modelo.',
  model: 'Revise o modelo escolhido para o agente.',
  tools: 'Revise as ferramentas do agente.'
}

const BLOCKER_ACTION: Partial<Record<ReasonFactor, string>> = {
  memory: 'Prefira um agente com modelo menor.',
  storage: 'Libere espaço em disco ou prefira um agente com modelo menor.'
}

export function recommendationConclusion(rec: Recommendation): AdvisorConclusion {
  const first = (kind: string) => rec.reasons.find((r) => r.kind === kind && r.factor !== 'task')
  switch (rec.fit) {
    case 'recommended-local':
      return { headline: 'Estimativa: compatível com o perfil analisado.', action: 'Nenhum ajuste necessário.' }
    case 'limited': {
      const limitation = first('limitation')
      return {
        headline: 'Estimativa: deve funcionar, com ressalvas.',
        action: (limitation && LIMITATION_ACTION[limitation.factor]) ?? 'Alguns dados do perfil não foram identificados; uma nova análise pode completar a estimativa.'
      }
    }
    case 'needs-resources': {
      const blocker = first('blocker')
      return {
        headline: 'Não recomendado para o perfil analisado (estimativa).',
        action: (blocker && BLOCKER_ACTION[blocker.factor]) ?? 'Prefira um agente com modelo menor.'
      }
    }
    case 'unknown': {
      if (rec.reasons.some((r) => r.factor === 'hardware')) {
        return { headline: 'Compatibilidade não verificada.', action: 'Execute uma análise em Configurações › Hardware e desempenho.' }
      }
      if (rec.reasons.some((r) => r.factor === 'model' && r.kind === 'unknown') || !rec.requirements) {
        return { headline: 'Compatibilidade não verificada.', action: 'Escolha um modelo da biblioteca para que os requisitos possam ser estimados.' }
      }
      return { headline: 'Compatibilidade não verificada.', action: 'Execute uma nova análise para completar os dados do perfil.' }
    }
  }
}

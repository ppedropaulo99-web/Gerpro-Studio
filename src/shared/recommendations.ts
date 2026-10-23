/**
 * Motor de recomendações do Hardware Advisor (puro, sem React nem Node).
 *
 * Combina vários fatores — memória, GPU/VRAM, armazenamento, CPU,
 * aceleração, disponibilidade do modelo, ferramentas e tipo de tarefa — e
 * nunca decide por um critério isolado. A adequação ao hardware (`fit`) é
 * separada da executabilidade (`executableNow`): sem motor de IA, nenhum
 * agente é executável, mesmo que o hardware seja suficiente.
 */

import type { GpuInfo, HardwareProfile } from './hardware'
import type { ModelAvailability, ModelCapability } from './inference'
import type { ToolCatalogEntry } from './tools'

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

export const TASK_TYPES = ['chat', 'code', 'research', 'data', 'documents', 'support'] as const
export type TaskType = (typeof TASK_TYPES)[number]

export const TASK_LABELS: Record<TaskType, string> = {
  chat: 'conversa e produtividade',
  code: 'programação',
  research: 'pesquisa',
  data: 'análise de dados',
  documents: 'leitura de documentos',
  support: 'atendimento'
}

export type { ModelAvailability }

/**
 * De onde vem o modelo:
 * - `example`: biblioteca de exemplo da interface. A disponibilidade é
 *   ilustrativa e nunca vale como instalação real.
 * - `local-provider`: informado por um provedor local de modelos (futuro).
 */
export type ModelSource = 'example' | 'local-provider'

export interface ModelProfile {
  id: string
  name: string
  sizeGb: number
  contextLength: number
  capabilities: ModelCapability[]
  availability: ModelAvailability
  source: ModelSource
}

/** Disponibilidade que vale para as recomendações: modelos de exemplo nunca estão instalados. */
export function effectiveModelAvailability(model: Pick<ModelProfile, 'availability' | 'source'>): ModelAvailability {
  return model.source === 'example' ? 'not-installed' : model.availability
}

/** Recursos de que o agente precisa. Declarados ou estimados a partir do modelo. */
export interface AgentRequirements {
  /** Memória para carregar o modelo. */
  minRamGb: number
  /** Memória com folga para contexto e sistema. */
  recommendedRamGb: number
  /** VRAM para rodar o modelo inteiro na GPU. */
  preferredVramGb: number
  /** Espaço para baixar o modelo. */
  diskGb: number
  minCpuCores: number
  source: 'declared' | 'estimated-from-model'
}

export interface RecommendationCandidate {
  agentId: string
  name: string
  origin: 'saved' | 'example'
  /** `null` = o agente não declara tipos de tarefa. */
  taskTypes: TaskType[] | null
  /** Requisitos declarados; sem eles, são estimados a partir do modelo. */
  requirements: AgentRequirements | null
  /** Referência textual ao modelo (pode não estar na biblioteca). */
  modelRef: string | null
  model: ModelProfile | null
  tools: string[]
}

export interface RecommendationContext {
  hardware: HardwareProfile | null
  /** Por que não há perfil (ex.: análise não autorizada). */
  hardwareNote?: string
  task: TaskType | 'any'
  tools: readonly ToolCatalogEntry[]
  engineAvailable: boolean
}

// ---------------------------------------------------------------------------
// Saídas
// ---------------------------------------------------------------------------

/**
 * Todas são estimativas sobre o perfil analisado, nunca incompatibilidade confirmada.
 * - `recommended-local`: o perfil atende com folga.
 * - `limited`: atende, com ressalvas (CPU apenas, pouca folga de memória, dados incompletos...).
 * - `needs-resources`: pela estimativa, falta memória ou disco para o modelo; não recomendado.
 * - `unknown`: não há dados suficientes para avaliar.
 */
export type RecommendationFit = 'recommended-local' | 'limited' | 'needs-resources' | 'unknown'

export type ReasonKind = 'positive' | 'limitation' | 'blocker' | 'unknown' | 'notice'
export type ReasonFactor = 'hardware' | 'memory' | 'gpu' | 'storage' | 'cpu' | 'acceleration' | 'model' | 'tools' | 'task' | 'engine'

export interface RecommendationReason {
  kind: ReasonKind
  factor: ReasonFactor
  message: string
}

export type TaskMatch = 'match' | 'mismatch' | 'unknown' | 'any'

export interface Recommendation {
  agentId: string
  origin: RecommendationCandidate['origin']
  fit: RecommendationFit
  taskMatch: TaskMatch
  /** Só verdadeiro com motor disponível, modelo instalado e ferramentas implementadas. */
  executableNow: boolean
  requirements: AgentRequirements | null
  reasons: RecommendationReason[]
}

// ---------------------------------------------------------------------------
// Estimativas
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10

/** Gigabytes no formato da interface (pt-BR): `6,4 GB`. */
export const gb = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`

/** Estimativa conservadora: pesos + 20% de sobrecarga + cache de contexto. */
export function estimateRequirementsFromModel(model: Pick<ModelProfile, 'sizeGb' | 'contextLength'>): AgentRequirements {
  const contextGb = Math.min(4, (model.contextLength / 32_768) * 0.5)
  const minRamGb = round1(model.sizeGb * 1.2 + contextGb)
  return {
    minRamGb,
    recommendedRamGb: round1(minRamGb * 1.5 + 2),
    preferredVramGb: minRamGb,
    diskGb: round1(model.sizeGb),
    minCpuCores: model.sizeGb >= 8 ? 6 : 4,
    source: 'estimated-from-model'
  }
}

function dedicatedVram(gpus: readonly GpuInfo[]): number | null {
  const known = gpus.filter((g) => !g.sharedMemory && g.vramGb !== null).map((g) => g.vramGb as number)
  return known.length ? Math.max(...known) : null
}

const hasUnifiedMemory = (gpus: readonly GpuInfo[]) => gpus.some((g) => g.sharedMemory && g.vendor === 'apple')

export type LocalCapabilityLevel = 'high' | 'medium' | 'low' | 'insufficient' | 'unknown'

export interface LocalCapability {
  level: LocalCapabilityLevel
  /** Maior modelo (GB em disco) que caberia, aproximadamente. */
  maxModelSizeGb: number | null
  summary: string
  reasons: RecommendationReason[]
}

/** Compatibilidade estimada do perfil com processamento local, para o diagnóstico. */
export function estimateLocalCapability(profile: HardwareProfile | null): LocalCapability {
  if (!profile) return { level: 'unknown', maxModelSizeGb: null, summary: 'Sem perfil de hardware.', reasons: [] }
  if (!profile.memory) {
    return {
      level: 'unknown',
      maxModelSizeGb: null,
      summary: 'Memória não identificada: não é possível estimar.',
      reasons: [{ kind: 'unknown', factor: 'memory', message: 'Memória RAM não identificada.' }]
    }
  }

  const reasons: RecommendationReason[] = []
  const gpus = profile.gpus
  const vram = gpus ? dedicatedVram(gpus) : null
  const unified = gpus ? hasUnifiedMemory(gpus) : false
  // Reserva parte da RAM para o sistema; memória unificada é aproveitada melhor.
  const ramBudget = profile.memory.totalGb * (unified ? 0.7 : 0.6)
  const budget = Math.max(ramBudget, vram ?? 0)
  const maxModelSizeGb = round1(Math.max(0, budget - 0.5) / 1.2)

  reasons.push({ kind: 'positive', factor: 'memory', message: `${gb(profile.memory.totalGb)} de RAM no total.` })
  if (gpus === null) reasons.push({ kind: 'unknown', factor: 'gpu', message: 'GPU não identificada.' })
  else if (vram) reasons.push({ kind: 'positive', factor: 'gpu', message: `GPU dedicada com ${gb(vram)} de VRAM.` })
  else if (unified) reasons.push({ kind: 'positive', factor: 'gpu', message: 'Memória unificada compartilhada com a GPU.' })
  else reasons.push({ kind: 'limitation', factor: 'gpu', message: 'Nenhuma GPU dedicada identificada: os modelos rodariam na CPU.' })
  if (profile.cpu && profile.cpu.physicalCores < 4) {
    reasons.push({ kind: 'limitation', factor: 'cpu', message: `${profile.cpu.physicalCores} núcleos físicos: modelos maiores tendem a responder mais devagar.` })
  }
  if (profile.acceleration === null) reasons.push({ kind: 'unknown', factor: 'acceleration', message: 'Aceleração não identificada.' })
  else if (profile.acceleration.length === 0) {
    reasons.push({ kind: 'limitation', factor: 'acceleration', message: 'Nenhuma instrução de aceleração identificada.' })
  }
  if (profile.storage === null) reasons.push({ kind: 'unknown', factor: 'storage', message: 'Espaço em disco não identificado.' })
  else if (profile.storage.freeGb < 10) {
    reasons.push({ kind: 'limitation', factor: 'storage', message: `${gb(profile.storage.freeGb)} livres em disco para novos modelos.` })
  }

  const level: LocalCapabilityLevel = budget >= 20 ? 'high' : budget >= 8 ? 'medium' : budget >= 3 ? 'low' : 'insufficient'
  const summary = {
    high: `Estimativa: modelos de até ~${gb(maxModelSizeGb)} devem funcionar, incluindo modelos grandes quantizados.`,
    medium: `Estimativa: modelos pequenos e médios quantizados, de até ~${gb(maxModelSizeGb)}, devem funcionar.`,
    low: `Estimativa: modelos pequenos, de até ~${gb(maxModelSizeGb)}, são os mais indicados.`,
    insufficient: 'Estimativa: os modelos locais da biblioteca teriam pouca folga de memória com os recursos identificados.',
    unknown: ''
  }[level]
  return { level, maxModelSizeGb, summary, reasons }
}

// ---------------------------------------------------------------------------
// Recomendação
// ---------------------------------------------------------------------------

export function recommendAgent(candidate: RecommendationCandidate, ctx: RecommendationContext): Recommendation {
  const reasons: RecommendationReason[] = []
  const add = (kind: ReasonKind, factor: ReasonFactor, message: string) => reasons.push({ kind, factor, message })
  const { model, tools } = candidate

  // Tipo de tarefa: influencia a ordenação e a justificativa, não a adequação ao hardware.
  let taskMatch: TaskMatch = 'any'
  if (ctx.task !== 'any') {
    if (candidate.taskTypes === null) {
      taskMatch = 'unknown'
      add('notice', 'task', 'O agente não declara tipos de tarefa.')
    } else if (candidate.taskTypes.includes(ctx.task)) {
      taskMatch = 'match'
      add('positive', 'task', `Indicado para ${TASK_LABELS[ctx.task]}.`)
    } else {
      taskMatch = 'mismatch'
      add('notice', 'task', `Não é voltado para ${TASK_LABELS[ctx.task]}.`)
    }
  }

  // Modelo
  if (!model) {
    add('unknown', 'model', candidate.modelRef ? `Modelo "${candidate.modelRef}" não está na biblioteca: requisitos desconhecidos.` : 'Nenhum modelo definido.')
  } else {
    const availability = effectiveModelAvailability(model)
    if (model.source === 'example') {
      add('notice', 'model', `${model.name} é um modelo da biblioteca de exemplo: não está instalado neste computador (seria preciso baixar ${gb(model.sizeGb)}).`)
    } else if (availability === 'installed') add('positive', 'model', `${model.name} já está disponível localmente.`)
    else if (availability === 'not-installed') add('notice', 'model', `Será preciso baixar ${model.name} (${gb(model.sizeGb)}).`)
    else if (availability === 'downloading') add('limitation', 'model', `${model.name} ainda está sendo baixado.`)
    else add('limitation', 'model', `${model.name} falhou no último carregamento.`)
    if (tools.length > 0 && !model.capabilities.includes('tools')) {
      add('limitation', 'model', `${model.name} não declara suporte a ferramentas.`)
    }
  }

  // Ferramentas
  const pendingTools: string[] = []
  for (const id of tools) {
    const entry = ctx.tools.find((t) => t.definition.id === id)
    if (!entry) add('limitation', 'tools', `Ferramenta "${id}" não está instalada.`)
    else if (entry.availability === 'disabled') add('limitation', 'tools', `Ferramenta "${entry.definition.name}" está desativada.`)
    else if (entry.availability === 'not-implemented') pendingTools.push(entry.definition.name)
  }
  if (pendingTools.length) add('notice', 'tools', `Ainda sem implementação: ${pendingTools.join(', ')}.`)

  // Hardware
  const requirements = candidate.requirements ?? (model ? estimateRequirementsFromModel(model) : null)
  const hw = ctx.hardware
  let criticalUnknown = false
  if (!hw) {
    criticalUnknown = true
    add('unknown', 'hardware', ctx.hardwareNote ?? 'Sem perfil de hardware para comparar.')
  } else if (!requirements) {
    criticalUnknown = true
  } else {
    if (!hw.memory) {
      criticalUnknown = true
      add('unknown', 'memory', 'Memória RAM não identificada.')
    }

    const vram = hw.gpus ? dedicatedVram(hw.gpus) : null
    const unified = hw.gpus ? hasUnifiedMemory(hw.gpus) : false
    const fitsInVram = vram !== null && vram >= requirements.preferredVramGb

    if (hw.memory) {
      const { totalGb, availableGb } = hw.memory
      if (totalGb < requirements.minRamGb && !fitsInVram) {
        add('blocker', 'memory', `Estimativa: o modelo precisa de cerca de ${gb(requirements.minRamGb)} de memória; o perfil indica ${gb(totalGb)}.`)
      } else if (totalGb < requirements.recommendedRamGb && !fitsInVram) {
        add('limitation', 'memory', `Pouca folga de memória: ${gb(totalGb)} para ~${gb(requirements.recommendedRamGb)} recomendados.`)
      } else {
        add('positive', 'memory', `Memória adequada: ${gb(totalGb)} para ~${gb(requirements.minRamGb)} necessários.`)
      }
      if (availableGb < requirements.minRamGb && totalGb >= requirements.minRamGb && !fitsInVram) {
        add('limitation', 'memory', `${gb(availableGb)} livres no momento da análise; fechar outros aplicativos daria mais folga.`)
      }
    }

    if (hw.gpus === null) add('unknown', 'gpu', 'GPU não identificada: desempenho incerto.')
    else if (fitsInVram) add('positive', 'gpu', `Cabe inteiro na VRAM (${gb(vram)}).`)
    else if (unified) add('positive', 'gpu', 'Memória unificada acelera o modelo na GPU integrada.')
    else if (vram !== null && vram > 0) add('limitation', 'gpu', `Cabe parcialmente na VRAM (${vram} de ~${gb(requirements.preferredVramGb)}): parte roda na CPU.`)
    else if (hw.gpus.some((g) => !g.sharedMemory && g.vramGb === null)) add('unknown', 'gpu', 'VRAM da GPU não informada.')
    else if (requirements.minRamGb >= 3) add('limitation', 'gpu', 'Nenhuma GPU dedicada identificada: o modelo rodaria na CPU, com respostas mais demoradas.')
    else add('positive', 'gpu', 'Modelo leve, adequado à execução na CPU.')

    if (!model || effectiveModelAvailability(model) !== 'installed') {
      if (hw.storage === null) add('unknown', 'storage', 'Espaço em disco não identificado.')
      else if (hw.storage.freeGb < requirements.diskGb + 2) {
        add('blocker', 'storage', `Estimativa: o download do modelo precisa de ~${gb(requirements.diskGb)} livres; o perfil indica ${gb(hw.storage.freeGb)}.`)
      } else add('positive', 'storage', `Espaço em disco adequado (${gb(hw.storage.freeGb)} livres).`)
    }

    if (hw.cpu === null) add('unknown', 'cpu', 'Processador não identificado.')
    else if (hw.cpu.physicalCores < requirements.minCpuCores && !fitsInVram) {
      add('limitation', 'cpu', `${hw.cpu.physicalCores} núcleos físicos; este modelo responde melhor com ${requirements.minCpuCores} ou mais.`)
    }

    if (hw.acceleration === null) add('unknown', 'acceleration', 'Aceleração não identificada.')
    else if (hw.acceleration.length === 0) add('limitation', 'acceleration', 'Nenhuma instrução de aceleração identificada.')
  }

  // Motor
  if (!ctx.engineAvailable) add('notice', 'engine', 'Motor de IA indisponível: o agente ainda não pode ser executado.')

  const has = (kind: ReasonKind) => reasons.some((r) => r.kind === kind && r.factor !== 'task')
  const fit: RecommendationFit = has('blocker')
    ? 'needs-resources'
    : criticalUnknown
      ? 'unknown'
      : has('limitation') || has('unknown')
        ? 'limited'
        : 'recommended-local'

  const executableNow =
    ctx.engineAvailable &&
    (fit === 'recommended-local' || fit === 'limited') &&
    pendingTools.length === 0 &&
    model !== null &&
    effectiveModelAvailability(model) === 'installed'

  return { agentId: candidate.agentId, origin: candidate.origin, fit, taskMatch, executableNow, requirements, reasons }
}

const FIT_ORDER: Record<RecommendationFit, number> = { 'recommended-local': 0, limited: 1, unknown: 2, 'needs-resources': 3 }
const TASK_ORDER: Record<TaskMatch, number> = { match: 0, any: 0, unknown: 1, mismatch: 2 }

/** Recomendações ordenadas: tarefa compatível primeiro, depois adequação ao hardware. */
export function recommendAgents(candidates: readonly RecommendationCandidate[], ctx: RecommendationContext): Recommendation[] {
  return candidates
    .map((c) => ({ name: c.name, rec: recommendAgent(c, ctx) }))
    .sort(
      (a, b) =>
        TASK_ORDER[a.rec.taskMatch] - TASK_ORDER[b.rec.taskMatch] ||
        FIT_ORDER[a.rec.fit] - FIT_ORDER[b.rec.fit] ||
        a.name.localeCompare(b.name, 'pt-BR')
    )
    .map((x) => x.rec)
}

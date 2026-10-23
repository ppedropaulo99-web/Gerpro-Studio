/**
 * Avaliador de compatibilidade (CompatibilityEvaluator) e serviço de
 * recomendação de alternativas (RecommendationService) para modelos locais
 * de chat.
 *
 * Avalia a COMBINAÇÃO modelo + perfil de execução + tarefa + dispositivo,
 * nunca a qualidade do computador. Regras ordenadas, sem pontuação:
 *
 *   1. elegibilidade        → execução local, capacidade de chat, contexto da tarefa
 *   2. disponibilidade      → só o inventário do provedor diz o que está instalado
 *   3. recursos conhecidos  → memória, tamanho do modelo, contexto, CPU/GPU
 *   4. estimativa           → cabe ou não, com o que se sabe
 *   5. testes válidos       → só valem nas mesmas condições (`effectiveState`)
 *   6. adequação à tarefa   → só com avaliação de qualidade fundamentada
 *   7. ajuste de perfil     → conservador, antes de trocar de modelo
 *   8. outros modelos       → instalados primeiro; não instalados à parte
 *   9. ordenação            → chaves explícitas e desempate por identificador
 *
 * Puro e determinístico: não lê relógio, disco, rede nem hardware. O perfil de
 * hardware só entra pelo estado do Hardware Advisor (`usableProfile`), então
 * sem consentimento não há perfil. Nada aqui depende de um provedor específico.
 */

import {
  compatibilityBasis,
  effectiveState,
  stateAfterTest,
  type AlternativeSuggestion,
  type CompatibilityAssessment,
  type CompatibilityBasis,
  type CompatibilityState
} from './compatibility'
import type { ExecutionProfile, ExecutionProfileOverride } from './execution'
import { usableProfile, type GpuInfo, type HardwareAdvisorState, type HardwareProfile } from './hardware'
import { INFERENCE_ERROR_NATURE, sameModel, type ModelAvailability, type ModelRef, type ProviderModelEntry, type ResolvedModelRef } from './inference'
import { gb, TASK_LABELS, type ReasonFactor, type ReasonKind, type TaskType } from './recommendations'

// ---------------------------------------------------------------------------
// Regras de estimativa (versão em COMPATIBILITY_RULES_VERSION)
// ---------------------------------------------------------------------------

/**
 * Premissas conservadoras da estimativa. São regras, não medições: mudar
 * qualquer uma exige subir `COMPATIBILITY_RULES_VERSION`.
 */
export const ESTIMATE_RULES = {
  /** GB = 2³⁰ bytes, a mesma unidade do perfil de hardware. */
  bytesPerGb: 1024 ** 3,
  /** Parte da RAM total deixada para o sistema e outros aplicativos. */
  ramReserveFraction: 0.25,
  /** Parte da VRAM deixada para o driver e a tela. */
  vramReserveFraction: 0.1,
  /** Menor contexto que um ajuste de perfil propõe. */
  minReducedContext: 2048
} as const

// ---------------------------------------------------------------------------
// Entradas e saídas
// ---------------------------------------------------------------------------

/** Avaliação de qualidade de um modelo para uma tarefa, feita por alguém identificável. */
export interface TaskQualityEvidence {
  model: ResolvedModelRef
  /** Digest avaliado; `null` = vale para o modelo com este id. */
  modelDigest: string | null
  task: TaskType
  rating: 'suitable' | 'unsuitable'
  /** Quem avaliou (ex.: suíte de avaliação, curadoria). */
  source: string
  assessedAt: string
}

export type TaskFit = 'suitable' | 'unsuitable' | 'unknown' | 'not-applicable'

export interface EvaluationContext {
  profile: ExecutionProfile
  task: TaskType | 'any'
  /** Contexto mínimo que a tarefa exige, em tokens; `null` = sem exigência. */
  minContextTokens: number | null
  /** Estado do Hardware Advisor; sem consentimento, não há perfil. */
  hardware: Pick<HardwareAdvisorState, 'status' | 'analysis'>
  /** Identificador do dispositivo para validar testes; `null` = desconhecido. */
  deviceKey: string | null
  priorAssessments: readonly CompatibilityAssessment[]
  taskEvidence: readonly TaskQualityEvidence[]
  /** Momento da avaliação (entrada, para o resultado ser reproduzível). */
  now: string
}

export type EvaluationStage = 'eligibility' | 'availability' | 'resources' | 'estimate' | 'evidence' | 'task'

/** Passo auditável: qual regra, o que concluiu e com quais valores. */
export interface EvaluationStep {
  stage: EvaluationStage
  rule: string
  kind: ReasonKind
  factor: ReasonFactor
  message: string
  values: Record<string, number | string | boolean | null>
}

/**
 * Onde o modelo ficaria. `gpu-partial` diz só que parte dos pesos não caberia
 * na VRAM; não indica proporção de camadas nem desempenho.
 */
export type Placement = 'cpu' | 'gpu-full' | 'gpu-partial' | 'shared-memory' | 'unknown-vram' | 'unknown-gpu'

/** Estimativa de memória. Nunca é medição. */
export interface MemoryEstimate {
  source: 'estimate'
  weightsGb: number
  /** `null` quando o contexto ou a memória por token são desconhecidos. */
  contextGb: number | null
  /**
   * Componentes que ficaram fora da conta. Com algum, `requiredGb` e `ramGb`
   * são só um piso: servem para dizer que não cabe, nunca que cabe.
   */
  unknownComponents: Array<'context'>
  requiredGb: number
  placement: Placement
  /** Parte estimada na VRAM dedicada. */
  gpuGb: number
  /** Parte estimada na RAM. */
  ramGb: number
  /** Capacidade: RAM total menos a reserva do sistema. */
  usableRamGb: number
  /** RAM livre no momento da análise; `null` se a análise estiver desatualizada. */
  availableRamGb: number | null
}

/**
 * Disponibilidade ATUAL de RAM, separada da capacidade: um modelo pode caber
 * no dispositivo (compatibilidade potencial) sem caber na memória livre agora.
 */
export type MemoryNow = 'sufficient' | 'insufficient' | 'unknown'

export interface CompatibilityEvaluation {
  model: ResolvedModelRef
  eligibility: 'eligible' | 'ineligible' | 'unknown'
  availability: ModelAvailability
  /** Só a estimativa, antes de considerar testes. */
  estimateState: CompatibilityState
  /** Estado final: estimativa combinada com testes ainda válidos. */
  state: CompatibilityState
  taskFit: TaskFit
  estimate: MemoryEstimate | null
  memoryNow: MemoryNow
  /** Contrato comum (`compatibility.ts`), com ajustes de perfil e liberação de memória em `alternatives`. */
  assessment: CompatibilityAssessment
  steps: EvaluationStep[]
}

// ---------------------------------------------------------------------------
// Avaliação
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100

function dedicatedGpu(gpus: readonly GpuInfo[]): { vramGb: number | null } | null {
  const dedicated = gpus.filter((g) => !g.sharedMemory)
  if (dedicated.length === 0) return null
  const known = dedicated.filter((g) => g.vramGb !== null).map((g) => g.vramGb as number)
  return { vramGb: known.length ? Math.max(...known) : null }
}

interface ResourceResult {
  estimate: MemoryEstimate | null
  /** `true` cabe, `false` não cabe, `null` desconhecido (inclusive estimativa incompleta que cabe). */
  fits: boolean | null
  memoryNow: MemoryNow
  hardwareProfile: HardwareProfile | null
}

function evaluateResources(entry: ProviderModelEntry, ctx: EvaluationContext, steps: EvaluationStep[]): ResourceResult {
  const add = (rule: string, kind: ReasonKind, factor: ReasonFactor, message: string, values: EvaluationStep['values'] = {}) =>
    steps.push({ stage: 'resources', rule, kind, factor, message, values })
  const model = entry.model
  const hw = usableProfile(ctx.hardware)

  if (!hw) {
    const message =
      ctx.hardware.status === 'not-authorized'
        ? 'Análise de hardware não autorizada: recursos não avaliados.'
        : 'Sem perfil de hardware utilizável: recursos não avaliados.'
    add('resources.hardware-profile', 'unknown', 'hardware', message, { status: ctx.hardware.status })
    return { estimate: null, fits: null, memoryNow: 'unknown', hardwareProfile: null }
  }
  if (!hw.memory) {
    add('resources.memory-data', 'unknown', 'memory', 'Memória RAM não identificada no perfil.')
    return { estimate: null, fits: null, memoryNow: 'unknown', hardwareProfile: hw }
  }
  if (model.sizeBytes === null) {
    add('resources.model-size', 'unknown', 'model', 'Tamanho do modelo não informado pelo provedor: memória necessária desconhecida.')
    return { estimate: null, fits: null, memoryNow: 'unknown', hardwareProfile: hw }
  }

  const weightsGb = round2(model.sizeBytes / ESTIMATE_RULES.bytesPerGb)
  add('resources.model-size', 'notice', 'model', `Pesos do modelo: ${gb(weightsGb)}${model.quantization ? ` (quantização ${model.quantization})` : ''}.`, {
    weightsGb,
    quantization: model.quantization
  })

  let contextGb: number | null = null
  const tokens = ctx.profile.contextLength
  if (tokens === null) {
    add('resources.context-memory', 'unknown', 'context', 'Contexto no padrão do provedor: a memória do contexto não entra na estimativa.')
  } else if (model.contextBytesPerToken === null) {
    add('resources.context-memory', 'unknown', 'context', 'Memória por token de contexto não informada: o contexto não entra na estimativa.', {
      contextTokens: tokens
    })
  } else {
    contextGb = round2((tokens * model.contextBytesPerToken) / ESTIMATE_RULES.bytesPerGb)
    add('resources.context-memory', 'notice', 'context', `Contexto de ${tokens} tokens: cerca de ${gb(contextGb)}.`, { contextTokens: tokens, contextGb })
  }

  const unknownComponents: MemoryEstimate['unknownComponents'] = contextGb === null ? ['context'] : []
  const complete = unknownComponents.length === 0
  const requiredGb = round2(weightsGb + (contextGb ?? 0))
  const usableRamGb = round2(hw.memory.totalGb * (1 - ESTIMATE_RULES.ramReserveFraction))
  // A memória livre é um retrato do momento da análise; numa análise desatualizada, não vale mais.
  const availableRamGb = ctx.hardware.status === 'stale' ? null : hw.memory.availableGb

  let placement: Placement
  let gpuGb = 0
  if (ctx.profile.gpuMode === 'cpu-only') placement = 'cpu'
  else if (hw.gpus === null) placement = 'unknown-gpu'
  else {
    const dedicated = dedicatedGpu(hw.gpus)
    if (dedicated && dedicated.vramGb === null) placement = 'unknown-vram'
    else if (dedicated && dedicated.vramGb !== null && dedicated.vramGb > 0) {
      const usableVram = round2(dedicated.vramGb * (1 - ESTIMATE_RULES.vramReserveFraction))
      gpuGb = Math.min(requiredGb, usableVram)
      placement = requiredGb <= usableVram ? 'gpu-full' : 'gpu-partial'
    } else placement = hw.gpus.some((g) => g.sharedMemory) ? 'shared-memory' : 'cpu'
  }
  const ramGb = round2(requiredGb - gpuGb)

  const placementText: Record<Placement, string> = {
    cpu: 'Execução estimada na CPU, com o modelo na RAM.',
    'gpu-full': `Estimativa: o modelo caberia inteiro na VRAM dedicada (${gb(gpuGb)}).`,
    'gpu-partial': `Estimativa: ${gb(gpuGb)} na VRAM e ${gb(ramGb)} na RAM. A divisão de camadas e o desempenho dependem do provedor e não são estimados aqui.`,
    'shared-memory': 'GPU integrada usa a própria RAM: a estimativa considera só a RAM.',
    'unknown-vram': 'GPU dedicada com VRAM não informada: a estimativa considera só a RAM.',
    'unknown-gpu': 'GPU não identificada: a estimativa considera só a RAM.'
  }
  const placementKind: ReasonKind = placement === 'unknown-vram' || placement === 'unknown-gpu' ? 'unknown' : 'notice'
  add('resources.placement', placementKind, 'gpu', placementText[placement], { placement, gpuGb, ramGb })

  // Capacidade. Com componente desconhecido, a conta é um piso: só pode concluir que NÃO cabe.
  let fits: boolean | null
  if (ramGb > usableRamGb) {
    fits = false
    add(
      'resources.ram-fit',
      'blocker',
      'memory',
      complete
        ? `Estimativa: ${gb(ramGb)} na RAM, acima dos ~${gb(usableRamGb)} utilizáveis.`
        : `Só os pesos já ocupariam ${gb(ramGb)} na RAM, acima dos ~${gb(usableRamGb)} utilizáveis, mesmo sem contar o contexto.`,
      { ramGb, usableRamGb, complete }
    )
  } else if (!complete) {
    fits = null
    add(
      'resources.ram-fit',
      'unknown',
      'memory',
      `Só os pesos: ${gb(ramGb)} na RAM, dentro dos ~${gb(usableRamGb)} utilizáveis. Sem a memória do contexto, não é possível dizer se o total cabe.`,
      { ramGb, usableRamGb, complete, unknown: unknownComponents.join(',') }
    )
  } else {
    fits = true
    add('resources.ram-fit', 'positive', 'memory', `Estimativa: ${gb(ramGb)} na RAM, dentro dos ~${gb(usableRamGb)} utilizáveis.`, { ramGb, usableRamGb, complete })
  }

  // Disponibilidade atual, separada da capacidade.
  let memoryNow: MemoryNow
  if (availableRamGb === null) memoryNow = 'unknown'
  else if (ramGb > availableRamGb) memoryNow = 'insufficient'
  else memoryNow = complete ? 'sufficient' : 'unknown'
  if (fits !== false) {
    if (availableRamGb === null) {
      add('resources.available-now', 'unknown', 'memory', 'Análise de hardware desatualizada: a memória livre atual não é conhecida.', { ramGb })
    } else if (memoryNow === 'insufficient') {
      add(
        'resources.available-now',
        'limitation',
        'memory',
        `${gb(availableRamGb)} livres no momento da análise, menos que os ${gb(ramGb)} necessários na RAM: seria preciso liberar memória antes de usar. Isso não indica incompatibilidade.`,
        { ramGb, availableRamGb }
      )
    } else if (memoryNow === 'sufficient') {
      add('resources.available-now', 'positive', 'memory', `${gb(availableRamGb)} livres no momento da análise.`, { ramGb, availableRamGb })
    }
  }

  return {
    estimate: { source: 'estimate', weightsGb, contextGb, unknownComponents, requiredGb, placement, gpuGb, ramGb, usableRamGb, availableRamGb },
    fits,
    memoryNow,
    hardwareProfile: hw
  }
}

function evaluateEligibility(entry: ProviderModelEntry, ctx: EvaluationContext, steps: EvaluationStep[]): CompatibilityEvaluation['eligibility'] {
  const add = (rule: string, kind: ReasonKind, factor: ReasonFactor, message: string, values: EvaluationStep['values'] = {}) =>
    steps.push({ stage: 'eligibility', rule, kind, factor, message, values })
  const model = entry.model
  let result: CompatibilityEvaluation['eligibility'] = 'eligible'

  if (model.location === 'remote') {
    add('eligibility.local-only', 'blocker', 'model', 'Modelo hospedado fora do computador: não é opção de execução local.')
    result = 'ineligible'
  }
  if (!model.capabilities.includes('chat')) {
    add('eligibility.chat', 'blocker', 'model', 'O modelo não declara capacidade de conversa (chat).', { capabilities: model.capabilities.join(',') })
    result = 'ineligible'
  }
  if (ctx.minContextTokens !== null) {
    if (model.contextLength === null) {
      add('eligibility.task-context', 'unknown', 'context', `Contexto máximo do modelo não informado: não é possível confirmar os ${ctx.minContextTokens} tokens da tarefa.`)
      if (result === 'eligible') result = 'unknown'
    } else if (model.contextLength < ctx.minContextTokens) {
      add(
        'eligibility.task-context',
        'blocker',
        'context',
        `O modelo aceita até ${model.contextLength} tokens de contexto; a tarefa precisa de ${ctx.minContextTokens}.`,
        { modelContext: model.contextLength, minContextTokens: ctx.minContextTokens }
      )
      result = 'ineligible'
    } else {
      add('eligibility.task-context', 'positive', 'context', `O modelo aceita até ${model.contextLength} tokens de contexto.`, {
        modelContext: model.contextLength
      })
    }
  }
  return result
}

/** Problemas do perfil em relação ao modelo e à tarefa (contexto). `true` se algum impede o uso como está. */
function evaluateProfileContext(entry: ProviderModelEntry, ctx: EvaluationContext, steps: EvaluationStep[]): boolean {
  const add = (rule: string, kind: ReasonKind, message: string, values: EvaluationStep['values'] = {}) =>
    steps.push({ stage: 'estimate', rule, kind, factor: 'context', message, values })
  const asked = ctx.profile.contextLength
  const max = entry.model.contextLength
  let issue = false
  if (asked !== null && max !== null && asked > max) {
    add('profile.context-within-model', 'blocker', `O perfil pede ${asked} tokens de contexto; o modelo aceita até ${max}.`, { asked, max })
    issue = true
  }
  if (ctx.minContextTokens !== null) {
    if (asked === null) {
      add('profile.context-meets-task', 'unknown', `Contexto no padrão do provedor: pode ser menor que os ${ctx.minContextTokens} tokens da tarefa.`)
    } else if (asked < ctx.minContextTokens) {
      add('profile.context-meets-task', 'blocker', `O perfil limita o contexto a ${asked} tokens; a tarefa precisa de ${ctx.minContextTokens}.`, {
        asked,
        minContextTokens: ctx.minContextTokens
      })
      issue = true
    }
  }
  return issue
}

function evaluateTaskFit(entry: ProviderModelEntry, ctx: EvaluationContext, steps: EvaluationStep[]): TaskFit {
  if (ctx.task === 'any') return 'not-applicable'
  const task = ctx.task
  const evidence = ctx.taskEvidence.filter(
    (e) => e.task === task && sameModel(e.model, entry.model.ref) && (e.modelDigest === null || e.modelDigest === entry.model.digest)
  )
  const ratings = new Set(evidence.map((e) => e.rating))
  const add = (kind: ReasonKind, message: string, values: EvaluationStep['values'] = {}) =>
    steps.push({ stage: 'task', rule: 'task.quality-evidence', kind, factor: 'task', message, values })
  if (ratings.size === 0) {
    add('unknown', `Sem avaliação de qualidade para ${TASK_LABELS[task]}: a adequação à tarefa não é considerada.`)
    return 'unknown'
  }
  if (ratings.size > 1) {
    add('unknown', `Avaliações divergentes para ${TASK_LABELS[task]}: a adequação à tarefa fica desconhecida.`, { evidences: evidence.length })
    return 'unknown'
  }
  const rating = evidence[0]!.rating
  const sources = [...new Set(evidence.map((e) => e.source))].sort().join(', ')
  add(
    rating === 'suitable' ? 'positive' : 'limitation',
    rating === 'suitable' ? `Avaliado como adequado para ${TASK_LABELS[task]} (${sources}).` : `Avaliado como pouco adequado para ${TASK_LABELS[task]} (${sources}).`,
    { sources }
  )
  return rating
}

/** Teste mais recente deste modelo; empate pela ordem de entrada. */
function latestTested(ctx: EvaluationContext, model: ModelRef): CompatibilityAssessment | null {
  let latest: CompatibilityAssessment | null = null
  for (const a of ctx.priorAssessments) {
    if (!a.lastTest || !sameModel(a.basis.model, model)) continue
    if (!latest || a.lastTest.at > latest.lastTest!.at) latest = a
  }
  return latest
}

/** Mesma regra de validade de um resultado de teste em `effectiveState`, aplicada também a falhas. */
function testStillValid(prior: CompatibilityAssessment, basis: CompatibilityBasis): boolean {
  return effectiveState({ ...prior, state: 'tested-compatible' }, basis) === 'tested-compatible'
}

const REASON_KIND_ORDER: readonly EvaluationStage[] = ['eligibility', 'availability', 'resources', 'estimate', 'evidence', 'task']

function evaluate(entry: ProviderModelEntry, ctx: EvaluationContext, withAdjustments: boolean): CompatibilityEvaluation {
  const steps: EvaluationStep[] = []
  const model = entry.model

  // 1. Elegibilidade
  const eligibility = evaluateEligibility(entry, ctx, steps)

  // 2. Disponibilidade (só o inventário confirma instalação)
  steps.push(
    entry.availability === 'installed'
      ? { stage: 'availability', rule: 'availability.inventory', kind: 'positive', factor: 'model', message: 'Instalado, segundo o inventário do provedor.', values: { availability: entry.availability } }
      : {
          stage: 'availability',
          rule: 'availability.inventory',
          kind: 'notice',
          factor: 'model',
          message: `Não instalado (inventário: ${entry.availability}).`,
          values: { availability: entry.availability }
        }
  )

  // 3–4. Recursos e estimativa
  const resources = evaluateResources(entry, ctx, steps)
  const profileIssue = evaluateProfileContext(entry, ctx, steps)
  let estimateState: CompatibilityState
  if (eligibility === 'ineligible') estimateState = 'not-recommended'
  else if (resources.fits === null) estimateState = 'not-verified'
  else if (!resources.fits) {
    const placement = resources.estimate!.placement
    // Sem saber a VRAM, "não cabe na RAM" não basta para desaconselhar.
    estimateState = placement === 'unknown-vram' || placement === 'unknown-gpu' ? 'not-verified' : 'not-recommended'
  } else estimateState = profileIssue ? 'not-recommended' : 'estimated-compatible'

  // 5. Testes válidos nas condições atuais
  const basis = compatibilityBasis(model.ref, model.digest, ctx.profile, ctx.deviceKey)
  let state: CompatibilityState = estimateState
  let lastTest: CompatibilityAssessment['lastTest'] = null
  const prior = eligibility === 'ineligible' ? null : latestTested(ctx, model.ref)
  if (prior) {
    const test = prior.lastTest!
    // Um teste (sucesso ou falha) só vale nas mesmas condições, com digest e dispositivo conhecidos.
    const valid = testStillValid(prior, basis)
    if (!valid) {
      steps.push({
        stage: 'evidence',
        rule: 'evidence.validity',
        kind: 'notice',
        factor: 'evidence',
        message:
          'Há um teste anterior, mas as condições mudaram ou não podem ser confirmadas (modelo, digest, perfil ou dispositivo): ele não é considerado.',
        values: { testedAt: test.at }
      })
    } else {
      lastTest = test
      state = stateAfterTest(estimateState, test)
      if (test.outcome === 'success') {
        steps.push({
          stage: 'evidence',
          rule: 'evidence.validity',
          kind: 'positive',
          factor: 'evidence',
          message: 'Testado com sucesso neste dispositivo, nas mesmas condições.',
          values: { testedAt: test.at }
        })
      } else if (test.errorCode !== null) {
        const nature = INFERENCE_ERROR_NATURE[test.errorCode]
        steps.push({
          stage: 'evidence',
          rule: 'evidence.failure',
          kind: nature === 'permanent' ? 'blocker' : 'limitation',
          factor: 'evidence',
          message:
            nature === 'permanent'
              ? `O provedor recusou este modelo em teste nas mesmas condições (${test.errorCode}).`
              : nature === 'transient'
                ? `Teste anterior falhou (${test.errorCode}), uma falha transitória: não indica incompatibilidade.`
                : `Teste anterior interrompido (${test.errorCode}): não diz nada sobre o modelo.`,
          values: { testedAt: test.at, errorCode: test.errorCode, nature }
        })
      }
    }
  }

  // 6. Adequação à tarefa
  const taskFit = evaluateTaskFit(entry, ctx, steps)

  steps.sort((a, b) => REASON_KIND_ORDER.indexOf(a.stage) - REASON_KIND_ORDER.indexOf(b.stage))

  // 7. Ajustes do próprio modelo: liberar memória e reduzir o perfil
  const alternatives: AlternativeSuggestion[] = []
  const compatible = state === 'tested-compatible' || state === 'estimated-compatible'
  if ((resources.memoryNow === 'insufficient' && resources.fits !== false) || lastTest?.errorCode === 'insufficient-memory') {
    alternatives.push({ kind: 'free-memory', reason: 'Fechar outros aplicativos antes de usar o modelo libera a memória necessária.' })
  }
  if (withAdjustments && eligibility !== 'ineligible') {
    // Incompatível pela estimativa: ajuste que caiba na capacidade. Compatível, mas sem memória livre agora: ajuste que caiba no que está livre.
    const goal = !compatible ? 'capacity' : resources.memoryNow === 'insufficient' ? 'available-now' : null
    const adjustment = goal ? findProfileAdjustment(entry, ctx, resources.estimate, goal) : null
    if (adjustment) alternatives.push({ kind: 'profile-adjustment', profile: adjustment.override, reason: adjustment.reason })
  }

  return {
    model: model.ref,
    eligibility,
    availability: entry.availability,
    estimateState,
    state,
    taskFit,
    estimate: resources.estimate,
    memoryNow: resources.memoryNow,
    assessment: {
      basis,
      state,
      reasons: steps.map(({ kind, factor, message }) => ({ kind, factor, message })),
      hardwareSource: resources.hardwareProfile?.provenance.source ?? null,
      assessedAt: ctx.now,
      lastTest,
      alternatives
    },
    steps
  }
}

/** CompatibilityEvaluator: avalia um modelo do inventário nas condições dadas. */
export function evaluateCompatibility(entry: ProviderModelEntry, ctx: EvaluationContext): CompatibilityEvaluation {
  return evaluate(entry, ctx, true)
}

/**
 * Ajustes conservadores, em ordem: só mexem no contexto, nunca reduzem abaixo
 * do que a tarefa exige, e só são propostos se o perfil ajustado passar a ser
 * compatível pela estimativa completa. Com `goal: 'capacity'`, basta caber
 * na capacidade (o menor ajuste; a memória livre é tratada à parte); com
 * `'available-now'`, o perfil ajustado também precisa caber na memória livre.
 */
function findProfileAdjustment(
  entry: ProviderModelEntry,
  ctx: EvaluationContext,
  estimate: MemoryEstimate | null,
  goal: 'capacity' | 'available-now'
): { override: ExecutionProfileOverride; reason: string } | null {
  const asked = ctx.profile.contextLength
  const max = entry.model.contextLength
  const need = ctx.minContextTokens
  const candidates: Array<{ override: ExecutionProfileOverride; reason: string }> = []

  if (asked !== null && max !== null && asked > max && (need === null || max >= need)) {
    candidates.push({ override: { contextLength: max }, reason: `Reduzir o contexto para ${max} tokens, o máximo que o modelo aceita.` })
  }
  if (need !== null && asked !== null && asked < need && (max === null || need <= max)) {
    candidates.push({ override: { contextLength: need }, reason: `Ampliar o contexto para os ${need} tokens que a tarefa exige.` })
  }
  if (estimate && estimate.contextGb !== null && asked !== null) {
    const floor = Math.max(need ?? 0, ESTIMATE_RULES.minReducedContext)
    for (let tokens = Math.floor(asked / 2); tokens >= floor; tokens = Math.floor(tokens / 2)) {
      candidates.push({
        override: { contextLength: tokens },
        reason: `Reduzir o contexto para ${tokens} tokens diminui a memória estimada do contexto.`
      })
    }
  }

  for (const candidate of candidates) {
    const adjusted = evaluate(entry, { ...ctx, profile: { ...ctx.profile, ...candidate.override } }, false)
    if (adjusted.estimateState !== 'estimated-compatible') continue
    if (goal === 'capacity' || adjusted.memoryNow === 'sufficient') return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// Recomendação de alternativas
// ---------------------------------------------------------------------------

/** Decisões sobre RECURSOS. Nenhuma delas garante a qualidade das respostas do modelo. */
export type RecommendationDecision =
  /** Os recursos comportam o modelo pedido como está. */
  | 'use-target'
  /** O modelo pedido cabe no dispositivo, mas não na memória livre no momento da análise. */
  | 'free-memory'
  /** Os recursos comportam o modelo pedido com um ajuste de perfil. */
  | 'adjust-profile'
  /** Outro modelo instalado cabe nos recursos. */
  | 'use-alternative'
  /** Faltam dados (perfil de hardware, tamanho do modelo...) para decidir. */
  | 'insufficient-data'
  /** Nenhuma opção instalada é indicada pela estimativa. */
  | 'no-suitable-option'

export interface ModelAlternative {
  evaluation: CompatibilityEvaluation
  kind: 'smaller-model' | 'other-model'
  reason: string
}

export interface RecommendationRequest extends EvaluationContext {
  /** Modelo pedido; com `providerId: null`, só é resolvido se um único provedor o oferecer. */
  target: ModelRef
  inventory: readonly ProviderModelEntry[]
}

export interface ModelRecommendation {
  target: CompatibilityEvaluation | null
  targetIssue: 'not-in-inventory' | 'ambiguous-provider' | null
  decision: RecommendationDecision
  profileAdjustment: { override: ExecutionProfileOverride; reason: string; evaluation: CompatibilityEvaluation } | null
  /** Instalados segundo o inventário, ordenados. */
  installedAlternatives: ModelAlternative[]
  /** Não instalados: nunca apresentados como disponíveis. */
  notInstalledAlternatives: ModelAlternative[]
  rationale: string[]
}

const usable = (e: CompatibilityEvaluation) =>
  e.eligibility === 'eligible' && (e.state === 'tested-compatible' || e.state === 'estimated-compatible') && e.taskFit !== 'unsuitable'

const STATE_RANK: Partial<Record<CompatibilityState, number>> = { 'tested-compatible': 0, 'estimated-compatible': 1 }
const MEMORY_NOW_RANK: Record<MemoryNow, number> = { sufficient: 0, unknown: 1, insufficient: 2 }
const TASK_RANK: Record<TaskFit, number> = { suitable: 0, 'not-applicable': 1, unknown: 1, unsuitable: 2 }
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Ordem: testado antes de estimado, memória livre suficiente antes de insuficiente, adequado à tarefa antes de desconhecido, depois provedor e id. */
function compareAlternatives(a: ModelAlternative, b: ModelAlternative): number {
  const x = a.evaluation
  const y = b.evaluation
  return (
    (STATE_RANK[x.state] ?? 9) - (STATE_RANK[y.state] ?? 9) ||
    MEMORY_NOW_RANK[x.memoryNow] - MEMORY_NOW_RANK[y.memoryNow] ||
    TASK_RANK[x.taskFit] - TASK_RANK[y.taskFit] ||
    compareText(x.model.providerId, y.model.providerId) ||
    compareText(x.model.modelId, y.model.modelId)
  )
}

function alternativeReason(e: CompatibilityEvaluation): string {
  const parts = [
    e.state === 'tested-compatible'
      ? 'Testado com sucesso neste dispositivo, nas mesmas condições.'
      : `Estimativa: ${gb(e.estimate!.ramGb)} na RAM, dentro dos ~${gb(e.estimate!.usableRamGb)} utilizáveis.`
  ]
  if (e.memoryNow === 'insufficient') parts.push('Memória livre insuficiente no momento da análise: seria preciso liberar memória.')
  if (e.taskFit === 'suitable') parts.push('Avaliado como adequado para a tarefa.')
  if (e.availability !== 'installed') parts.push('Não instalado: seria preciso baixá-lo.')
  return parts.join(' ')
}

function resolveTarget(request: RecommendationRequest): { entry: ProviderModelEntry | null; issue: ModelRecommendation['targetIssue'] } {
  const matches = request.inventory.filter((e) =>
    request.target.providerId === null ? e.model.ref.modelId === request.target.modelId : sameModel(e.model.ref, request.target)
  )
  if (matches.length === 0) return { entry: null, issue: 'not-in-inventory' }
  if (matches.length > 1) return { entry: null, issue: 'ambiguous-provider' }
  return { entry: matches[0]!, issue: null }
}

/** RecommendationService: decide entre o modelo pedido, um ajuste de perfil ou outro modelo, explicando por quê. */
export function recommendModels(request: RecommendationRequest): ModelRecommendation {
  const { entry, issue } = resolveTarget(request)
  const target = entry ? evaluateCompatibility(entry, request) : null
  const rationale: string[] = []

  if (issue === 'not-in-inventory') rationale.push(`"${request.target.modelId}" não consta no inventário: não está instalado em nenhum provedor conhecido.`)
  if (issue === 'ambiguous-provider') rationale.push(`"${request.target.modelId}" existe em mais de um provedor; é preciso escolher qual usar.`)

  const qualityNote =
    request.task === 'any' || target?.taskFit === 'not-applicable'
      ? 'Compatibilidade de recursos não diz nada sobre a qualidade das respostas.'
      : target?.taskFit === 'suitable'
        ? 'Há avaliação de qualidade favorável para a tarefa; os recursos, por si, não garantem qualidade.'
        : 'Qualidade para a tarefa não avaliada: compatibilidade de recursos não garante qualidade.'
  const potential = target !== null && target.availability === 'installed' && usable(target)

  if (potential && target.memoryNow !== 'insufficient') {
    rationale.push(
      target.state === 'tested-compatible'
        ? 'O modelo pedido foi executado com sucesso em teste nestas condições.'
        : 'Pela estimativa, os recursos do dispositivo comportam o modelo pedido como está.'
    )
    if (target.memoryNow === 'unknown') rationale.push('A memória livre atual não é conhecida: pode ser preciso liberar memória.')
    rationale.push(qualityNote)
    return { target, targetIssue: issue, decision: 'use-target', profileAdjustment: null, installedAlternatives: [], notInstalledAlternatives: [], rationale }
  }

  let profileAdjustment: ModelRecommendation['profileAdjustment'] = null
  if (target && target.availability === 'installed' && target.eligibility === 'eligible' && target.taskFit !== 'unsuitable') {
    const suggestion = target.assessment.alternatives.find((a) => a.kind === 'profile-adjustment')
    if (suggestion && suggestion.kind === 'profile-adjustment') {
      const evaluation = evaluateCompatibility(entry!, { ...request, profile: { ...request.profile, ...suggestion.profile } })
      profileAdjustment = { override: suggestion.profile, reason: suggestion.reason, evaluation }
    }
  }

  const alternatives = request.inventory
    .filter((e) => !target || !sameModel(e.model.ref, target.model))
    .map((e) => evaluateCompatibility(e, request))
    .filter(usable)
    .map((evaluation): ModelAlternative => {
      const smaller = target?.estimate && evaluation.estimate && evaluation.estimate.weightsGb < target.estimate.weightsGb
      return { evaluation, kind: smaller ? 'smaller-model' : 'other-model', reason: alternativeReason(evaluation) }
    })
    .sort(compareAlternatives)
  const installedAlternatives = alternatives.filter((a) => a.evaluation.availability === 'installed')
  const notInstalledAlternatives = alternatives.filter((a) => a.evaluation.availability !== 'installed')

  let decision: RecommendationDecision
  if (potential) {
    // Cabe no dispositivo, mas não na memória livre agora: compatibilidade potencial, não incompatibilidade.
    decision = 'free-memory'
    const e = target.estimate!
    rationale.push(
      `O modelo pedido cabe na capacidade estimada (~${gb(e.usableRamGb)} utilizáveis), mas só havia ${gb(e.availableRamGb!)} livres para os ${gb(e.ramGb)} necessários na RAM: libere memória antes de usar.`
    )
    if (profileAdjustment) rationale.push(`Outra opção, sem liberar memória: ${profileAdjustment.reason}`)
  } else if (profileAdjustment) {
    decision = 'adjust-profile'
    rationale.push(`Um ajuste de perfil basta: ${profileAdjustment.reason}`)
    if (profileAdjustment.evaluation.memoryNow === 'insufficient') rationale.push('Mesmo com o ajuste, seria preciso liberar memória antes de usar.')
  } else if (installedAlternatives.length > 0) {
    decision = 'use-alternative'
    rationale.push(`Outro modelo instalado cabe nos recursos estimados: ${installedAlternatives[0]!.evaluation.model.modelId}.`)
  } else if (!usableProfile(request.hardware) || target?.state === 'not-verified') {
    decision = 'insufficient-data'
    rationale.push('Faltam dados para estimar a compatibilidade; nada é afirmado sem eles.')
  } else {
    decision = 'no-suitable-option'
    rationale.push('Nenhum modelo instalado é indicado pela estimativa nestas condições.')
  }
  if (target && target.availability !== 'installed') rationale.push('O modelo pedido não está instalado, segundo o inventário.')
  if (notInstalledAlternatives.length > 0) rationale.push(`${notInstalledAlternatives.length} modelo(s) não instalado(s) também caberiam nos recursos, se baixados.`)
  if (decision !== 'insufficient-data' && decision !== 'no-suitable-option') rationale.push(qualityNote)

  return { target, targetIssue: issue, decision, profileAdjustment, installedAlternatives, notInstalledAlternatives, rationale }
}

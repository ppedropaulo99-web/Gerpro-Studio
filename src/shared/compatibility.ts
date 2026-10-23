/**
 * Avaliação de compatibilidade entre um modelo e o dispositivo.
 *
 * Distingue o que foi ESTIMADO (a partir do perfil de hardware) do que foi
 * TESTADO (uma geração real). Só um teste confirma algo; uma estimativa nunca
 * vira incompatibilidade confirmada, e falhas transitórias (como falta de
 * memória no momento) também não.
 */

import type { HardwareProfile } from './hardware'
import { INFERENCE_ERROR_NATURE, sameModel, type InferenceErrorCode, type InferenceMetrics, type ModelRef } from './inference'
import type { ExecutionProfile, ExecutionProfileOverride } from './execution'
import type { RecommendationFit, RecommendationReason } from './recommendations'

/**
 * - `tested-compatible`: uma geração real deu certo neste dispositivo.
 * - `estimated-compatible`: a estimativa indica que deve funcionar (com ou sem ressalvas).
 * - `not-recommended`: a estimativa, ou uma falha transitória, desaconselha; não é definitivo.
 * - `confirmed-incompatible`: o provedor recusou o modelo de forma permanente.
 * - `not-verified`: não há dados para avaliar.
 */
export const COMPATIBILITY_STATES = [
  'tested-compatible',
  'estimated-compatible',
  'not-recommended',
  'confirmed-incompatible',
  'not-verified'
] as const
export type CompatibilityState = (typeof COMPATIBILITY_STATES)[number]

/** Estados que vêm de uma execução real, e não de estimativa. */
export function isConfirmedState(state: CompatibilityState): boolean {
  return state === 'tested-compatible' || state === 'confirmed-incompatible'
}

/** Resultado de uma geração de teste real. Sem teste, `lastTest` fica `null`. */
export interface CompatibilityTest {
  at: string
  outcome: 'success' | 'failure'
  errorCode: InferenceErrorCode | null
  metrics: InferenceMetrics | null
}

/** Alternativas sugeridas quando o modelo não é o mais indicado. */
export type AlternativeSuggestion =
  | { kind: 'smaller-model'; model: ModelRef; reason: string }
  | { kind: 'profile-adjustment'; profile: ExecutionProfileOverride; reason: string }
  | { kind: 'free-memory'; reason: string }

/** Versão das regras de estimativa. Sobe quando o cálculo muda; estimativas antigas deixam de valer. */
export const COMPATIBILITY_RULES_VERSION = 1

/** Parâmetros do perfil que mudam o uso de memória ou onde o modelo roda. Os de amostragem não contam. */
export const COMPATIBILITY_PROFILE_FIELDS = ['contextLength', 'gpuMode', 'cpuThreads'] as const
export type CompatibilityProfileKey = Pick<ExecutionProfile, (typeof COMPATIBILITY_PROFILE_FIELDS)[number]>

/** Condições em que a avaliação foi feita. Se qualquer uma mudar, ela deixa de valer. */
export interface CompatibilityBasis {
  model: ModelRef
  /** Digest informado pelo provedor; `null` se desconhecido. */
  modelDigest: string | null
  profile: CompatibilityProfileKey
  /**
   * Identifica o dispositivo e a configuração de hardware; `null` se desconhecido.
   * Será gerado pelo detector real de hardware (ainda inexistente).
   */
  deviceKey: string | null
  rulesVersion: number
}

export function compatibilityBasis(
  model: ModelRef,
  modelDigest: string | null,
  profile: ExecutionProfile,
  deviceKey: string | null
): CompatibilityBasis {
  const key = Object.fromEntries(COMPATIBILITY_PROFILE_FIELDS.map((f) => [f, profile[f]])) as CompatibilityProfileKey
  return { model, modelDigest, profile: key, deviceKey, rulesVersion: COMPATIBILITY_RULES_VERSION }
}

export interface CompatibilityAssessment {
  basis: CompatibilityBasis
  state: CompatibilityState
  /** Motivos da estimativa, no mesmo formato do Hardware Advisor. */
  reasons: RecommendationReason[]
  /** Origem do perfil usado na estimativa; `null` sem perfil. Perfis `demo` nunca produzem estado confirmado. */
  hardwareSource: HardwareProfile['provenance']['source'] | null
  assessedAt: string
  lastTest: CompatibilityTest | null
  alternatives: AlternativeSuggestion[]
}

/**
 * Estado equivalente a uma recomendação do Hardware Advisor. O algoritmo de
 * recomendação não muda: este é só o vocabulário comum.
 */
export function stateFromEstimate(fit: RecommendationFit): CompatibilityState {
  const map: Record<RecommendationFit, CompatibilityState> = {
    'recommended-local': 'estimated-compatible',
    limited: 'estimated-compatible',
    'needs-resources': 'not-recommended',
    unknown: 'not-verified'
  }
  return map[fit]
}

/**
 * Novo estado após um teste real:
 * - sucesso → `tested-compatible`;
 * - recusa permanente do provedor → `confirmed-incompatible`;
 * - falta de memória → no máximo `not-recommended` (nunca confirmado), e um
 *   sucesso anterior continua valendo;
 * - demais falhas (provedor parado, tempo esgotado, cancelamento, pedido
 *   inválido) não dizem nada sobre o modelo: o estado não muda.
 */
export function stateAfterTest(current: CompatibilityState, test: Pick<CompatibilityTest, 'outcome' | 'errorCode'>): CompatibilityState {
  if (test.outcome === 'success') return 'tested-compatible'
  if (test.errorCode === null) return current
  if (INFERENCE_ERROR_NATURE[test.errorCode] === 'permanent') return 'confirmed-incompatible'
  if (test.errorCode === 'insufficient-memory') {
    return current === 'tested-compatible' || current === 'confirmed-incompatible' ? current : 'not-recommended'
  }
  return current
}

/**
 * Estado que ainda vale para as condições atuais; senão, `not-verified`.
 * - Sempre: mesmo modelo, mesmo digest e mesmos parâmetros relevantes do perfil.
 * - Resultado de teste (`tested-compatible`, `confirmed-incompatible`): digest e
 *   dispositivo precisam ser conhecidos e iguais; a versão das regras não importa.
 * - Estimativa: mesmo dispositivo e mesma versão das regras.
 */
export function effectiveState(assessment: CompatibilityAssessment, current: CompatibilityBasis): CompatibilityState {
  const was = assessment.basis
  const sameProfile = COMPATIBILITY_PROFILE_FIELDS.every((f) => was.profile[f] === current.profile[f])
  if (!sameModel(was.model, current.model) || was.modelDigest !== current.modelDigest || !sameProfile || was.deviceKey !== current.deviceKey) {
    return 'not-verified'
  }
  if (isConfirmedState(assessment.state)) {
    return was.modelDigest !== null && was.deviceKey !== null ? assessment.state : 'not-verified'
  }
  return was.rulesVersion === current.rulesVersion ? assessment.state : 'not-verified'
}

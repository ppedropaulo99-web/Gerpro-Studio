import type { ConsentStatus, HardwareAnalysisStatus } from '@shared/hardware'
import type { LocalCapabilityLevel, ModelSource, RecommendationFit } from '@shared/recommendations'
import type { AgentConfigState } from '@shared/agents'
import type { ModelStatus } from '@shared/engine'
import type { RunOrigin, RunState } from '@shared/runs'
import type { Tone } from '@renderer/components/ui/tone'

interface StatusMeta {
  tone: Tone
  label: string
  pulse?: boolean
}

/**
 * Estado funcional do que a tela mostra. Vocabulário único do app:
 * - `real`: implementado e operacional (dados gravados, serviços do Main).
 * - `simulated`: fluxo demonstrativo; a funcionalidade representada não roda.
 * - `planned`: ainda não implementado.
 * - `example`: registro fictício (agente, conversa, modelo, histórico).
 */
export type FeatureState = 'real' | 'simulated' | 'planned' | 'example'

export const featureStatus: Record<FeatureState, StatusMeta & { description: string }> = {
  real: { tone: 'success', label: 'Real', description: 'Funcionalidade implementada e operacional.' },
  simulated: { tone: 'warning', label: 'Simulado', description: 'Demonstração: a funcionalidade representada não é executada.' },
  planned: { tone: 'neutral', label: 'Planejado', description: 'Recurso ainda não implementado.' },
  example: { tone: 'info', label: 'Exemplo', description: 'Registro fictício, mantido para demonstração.' }
}

export const agentConfigState: Record<AgentConfigState, string> = {
  draft: 'Rascunho',
  ready: 'Pronto',
  archived: 'Arquivado'
}

/** Estado de modelos informados por um provedor real. Modelos de exemplo não usam este mapa. */
export const modelStatus: Record<ModelStatus, StatusMeta> = {
  loaded: { tone: 'success', label: 'Carregado' },
  available: { tone: 'neutral', label: 'Disponível' },
  downloading: { tone: 'accent', label: 'Baixando', pulse: true },
  error: { tone: 'danger', label: 'Erro' }
}

/**
 * Estado operacional a exibir para um modelo. Modelos de exemplo não têm estado
 * real (nem "Carregado", nem download): devolve `null` e a tela mostra o selo Exemplo.
 */
export function displayedModelStatus(source: ModelSource, status: ModelStatus): StatusMeta | null {
  return source === 'example' ? null : modelStatus[status]
}

/** Estados do contrato de execuções. Dados de exemplo chegam aqui via `legacyRunState`. */
export const runState: Record<RunState, StatusMeta> = {
  pending: { tone: 'info', label: 'Pendente' },
  running: { tone: 'accent', label: 'Em execução', pulse: true },
  completed: { tone: 'success', label: 'Concluída' },
  failed: { tone: 'danger', label: 'Falhou' },
  cancelled: { tone: 'neutral', label: 'Cancelada' }
}

export const runOrigin: Record<RunOrigin, StatusMeta> = {
  simulated: { tone: 'warning', label: 'Simulada' },
  real: { tone: 'success', label: 'Real' }
}

export const hardwareStatus: Record<HardwareAnalysisStatus, StatusMeta & { description: string }> = {
  'not-authorized': { tone: 'neutral', label: 'Não autorizado', description: 'A análise de hardware está desativada. O Gerpro Studio funciona normalmente sem ela.' },
  'awaiting-analysis': { tone: 'info', label: 'Aguardando análise', description: 'Autorizado. Nenhuma análise foi feita ainda.' },
  unavailable: { tone: 'warning', label: 'Análise indisponível', description: 'O detector não está disponível neste computador ou nesta versão.' },
  completed: { tone: 'success', label: 'Análise concluída', description: 'Perfil de hardware disponível para recomendações.' },
  stale: { tone: 'warning', label: 'Dados desatualizados', description: 'O perfil é antigo e pode não refletir o computador atual.' },
  error: { tone: 'danger', label: 'Erro na análise', description: 'A última análise falhou.' }
}

export const consentStatus: Record<ConsentStatus, string> = {
  'not-asked': 'Ainda não decidido',
  granted: 'Autorizado',
  denied: 'Recusado',
  revoked: 'Autorização desativada'
}

/**
 * Rótulos das recomendações. São estimativas sobre o perfil analisado, nunca
 * incompatibilidade confirmada: por isso nenhum usa o tom de erro (`danger`).
 */
export const recommendationFit: Record<RecommendationFit, StatusMeta> = {
  'recommended-local': { tone: 'success', label: 'Compatível (estimativa)' },
  limited: { tone: 'warning', label: 'Compatível com ressalvas (estimativa)' },
  'needs-resources': { tone: 'warning', label: 'Não recomendado (estimativa)' },
  unknown: { tone: 'neutral', label: 'Não verificado' }
}

/** Capacidade estimada do perfil, descrita pelos modelos que caberiam, sem julgar o equipamento. */
export const localCapability: Record<LocalCapabilityLevel, StatusMeta> = {
  high: { tone: 'success', label: 'Modelos grandes e médios' },
  medium: { tone: 'success', label: 'Modelos pequenos e médios' },
  low: { tone: 'info', label: 'Modelos pequenos' },
  insufficient: { tone: 'warning', label: 'Pouca folga para modelos locais' },
  unknown: { tone: 'neutral', label: 'Não verificado' }
}

import type { ConsentStatus, HardwareAnalysisStatus } from '@shared/hardware'
import type { LocalCapabilityLevel, RecommendationFit } from '@shared/recommendations'
import type { AgentAvailabilityStatus, AgentConfigState } from '@shared/agents'
import type { ModelStatus } from '@shared/engine'
import type { RunOrigin, RunState } from '@shared/runs'
import type { Tone } from '@renderer/components/ui'
import type { AgentStatus } from '@renderer/data/types'

interface StatusMeta {
  tone: Tone
  label: string
  pulse?: boolean
}

/** Status dos agentes de exemplo (dados demonstrativos). */
export const agentStatus: Record<AgentStatus, StatusMeta> = {
  active: { tone: 'success', label: 'Ativo' },
  idle: { tone: 'neutral', label: 'Ocioso' },
  draft: { tone: 'info', label: 'Rascunho' },
  error: { tone: 'danger', label: 'Com erro' }
}

/** Disponibilidade calculada pelo Main para agentes salvos. */
export const agentAvailability: Record<AgentAvailabilityStatus, StatusMeta> = {
  available: { tone: 'success', label: 'Disponível' },
  unavailable: { tone: 'warning', label: 'Indisponível' },
  archived: { tone: 'neutral', label: 'Arquivado' }
}

export const agentConfigState: Record<AgentConfigState, string> = {
  draft: 'Rascunho',
  ready: 'Pronto',
  archived: 'Arquivado'
}

export const modelStatus: Record<ModelStatus, StatusMeta> = {
  loaded: { tone: 'success', label: 'Carregado' },
  available: { tone: 'neutral', label: 'Disponível' },
  downloading: { tone: 'accent', label: 'Baixando', pulse: true },
  error: { tone: 'danger', label: 'Erro' }
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

export const recommendationFit: Record<RecommendationFit, StatusMeta> = {
  'recommended-local': { tone: 'success', label: 'Recomendado para execução local' },
  limited: { tone: 'warning', label: 'Compatível com limitações' },
  'needs-resources': { tone: 'danger', label: 'Requer recursos adicionais' },
  unknown: { tone: 'neutral', label: 'Compatibilidade desconhecida' }
}

export const localCapability: Record<LocalCapabilityLevel, StatusMeta> = {
  high: { tone: 'success', label: 'Alta' },
  medium: { tone: 'success', label: 'Média' },
  low: { tone: 'warning', label: 'Baixa' },
  insufficient: { tone: 'danger', label: 'Insuficiente' },
  unknown: { tone: 'neutral', label: 'Desconhecida' }
}

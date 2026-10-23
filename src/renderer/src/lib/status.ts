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

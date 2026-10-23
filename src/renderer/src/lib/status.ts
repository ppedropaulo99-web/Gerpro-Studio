import type { ModelStatus } from '@shared/engine'
import type { Tone } from '@renderer/components/ui'
import type { AgentStatus, RunStatus } from '@renderer/data/types'

interface StatusMeta {
  tone: Tone
  label: string
  pulse?: boolean
}

export const agentStatus: Record<AgentStatus, StatusMeta> = {
  active: { tone: 'success', label: 'Ativo' },
  idle: { tone: 'neutral', label: 'Ocioso' },
  draft: { tone: 'info', label: 'Rascunho' },
  error: { tone: 'danger', label: 'Com erro' }
}

export const modelStatus: Record<ModelStatus, StatusMeta> = {
  loaded: { tone: 'success', label: 'Carregado' },
  available: { tone: 'neutral', label: 'Disponível' },
  downloading: { tone: 'accent', label: 'Baixando', pulse: true },
  error: { tone: 'danger', label: 'Erro' }
}

export const runStatus: Record<RunStatus, StatusMeta> = {
  running: { tone: 'accent', label: 'Em execução', pulse: true },
  succeeded: { tone: 'success', label: 'Concluída' },
  failed: { tone: 'danger', label: 'Falhou' },
  queued: { tone: 'info', label: 'Na fila' },
  cancelled: { tone: 'neutral', label: 'Cancelada' }
}

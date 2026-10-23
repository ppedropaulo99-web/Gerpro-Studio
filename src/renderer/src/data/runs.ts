import type { Run } from './types'

/** Histórico de execuções simulado (mais recente primeiro). */
export const runs: Run[] = [
  { id: 'run-1048', agentId: 'assistente-geral', modelId: 'aurora-8b-instruct', trigger: 'Manual', status: 'running', startedAt: '2026-10-23T14:32:00', durationSec: null, tokens: 1840 },
  { id: 'run-1047', agentId: 'revisor-codigo', modelId: 'koda-coder-6b', trigger: 'API', status: 'succeeded', startedAt: '2026-10-23T14:05:00', durationSec: 48, tokens: 6210 },
  { id: 'run-1046', agentId: 'pesquisador', modelId: 'sirius-14b-reasoner', trigger: 'Agendado', status: 'succeeded', startedAt: '2026-10-23T12:00:00', durationSec: 312, tokens: 22870 },
  { id: 'run-1045', agentId: 'leitor-documentos', modelId: 'lumen-vision-7b', trigger: 'Manual', status: 'failed', startedAt: '2026-10-23T11:41:00', durationSec: 6, tokens: 0 },
  { id: 'run-1044', agentId: 'analista-dados', modelId: 'sirius-14b-reasoner', trigger: 'Manual', status: 'queued', startedAt: '2026-10-23T11:40:00', durationSec: null, tokens: 0 },
  { id: 'run-1043', agentId: 'assistente-geral', modelId: 'aurora-8b-instruct', trigger: 'API', status: 'succeeded', startedAt: '2026-10-23T10:12:00', durationSec: 9, tokens: 940 },
  { id: 'run-1042', agentId: 'revisor-codigo', modelId: 'koda-coder-6b', trigger: 'API', status: 'cancelled', startedAt: '2026-10-22T18:27:00', durationSec: 21, tokens: 1320 },
  { id: 'run-1041', agentId: 'assistente-geral', modelId: 'aurora-8b-instruct', trigger: 'Manual', status: 'succeeded', startedAt: '2026-10-22T16:03:00', durationSec: 14, tokens: 1505 }
]

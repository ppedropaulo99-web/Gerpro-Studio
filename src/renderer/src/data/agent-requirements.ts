import type { AgentRequirements, TaskType } from '@shared/recommendations'

/**
 * Metadados DEMONSTRATIVOS dos agentes de exemplo para o Hardware Advisor:
 * tipos de tarefa e, em alguns casos, requisitos declarados pelo autor do
 * agente. Sem requisitos declarados, o Advisor estima a partir do modelo.
 */
export const exampleAgentProfiles: Record<string, { taskTypes: TaskType[]; requirements?: AgentRequirements }> = {
  'assistente-geral': { taskTypes: ['chat', 'research'] },
  'revisor-codigo': { taskTypes: ['code'] },
  pesquisador: { taskTypes: ['research', 'documents'] },
  'analista-dados': {
    taskTypes: ['data'],
    // Declarado: planilhas grandes exigem mais memória do que o modelo sozinho.
    requirements: { minRamGb: 16, recommendedRamGb: 28, preferredVramGb: 14, diskGb: 10.2, minCpuCores: 8, source: 'declared' }
  },
  'suporte-cliente': { taskTypes: ['support', 'chat'] },
  'leitor-documentos': { taskTypes: ['documents'] }
}

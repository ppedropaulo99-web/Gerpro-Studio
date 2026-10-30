import { RUN_LIMITS } from '@shared/runs'

/**
 * Mensagens enviadas nesta janela, só para exibição (Conversas e detalhes em
 * Execuções). Ficam em memória do Renderer (o `RunRecord` não guarda a
 * entrada) e somem ao recarregar ou fechar o aplicativo; nunca vão para logs.
 */
const sentInputs = new Map<string, string>()

export function rememberInput(runId: string, input: string): void {
  sentInputs.set(runId, input)
  while (sentInputs.size > RUN_LIMITS.maxRecords) sentInputs.delete(sentInputs.keys().next().value!)
}

export function sentInputOf(runId: string): string | undefined {
  return sentInputs.get(runId)
}

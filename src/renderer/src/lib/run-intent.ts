import type { ResolvedModelRef } from '@shared/inference'

/**
 * Pedidos de navegação com contexto, só em memória e lidos uma vez:
 * - "Executar" (Agentes) e "Usar em Conversas" (Modelos) levam a Conversas
 *   com o agente ou o modelo pré-selecionado;
 * - "Detalhes técnicos" (Conversas) leva a Execuções com a execução aberta.
 */
let requestedAgent: string | null = null
let requestedModel: ResolvedModelRef | null = null
let requestedRun: string | null = null

export function requestRunFor(agentId: string): void {
  requestedAgent = agentId
}

/** Lê e limpa o pedido (vale uma vez). */
export function takeRequestedAgent(): string | null {
  const agentId = requestedAgent
  requestedAgent = null
  return agentId
}

export function requestModelFor(ref: ResolvedModelRef): void {
  requestedModel = { ...ref }
}

export function takeRequestedModel(): ResolvedModelRef | null {
  const ref = requestedModel
  requestedModel = null
  return ref
}

export function requestRunDetails(runId: string): void {
  requestedRun = runId
}

export function takeRequestedRun(): string | null {
  const runId = requestedRun
  requestedRun = null
  return runId
}

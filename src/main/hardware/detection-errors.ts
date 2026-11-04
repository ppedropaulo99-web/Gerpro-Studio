/**
 * Erros da detecção de hardware compartilhados entre detectores e serviço.
 *
 * `DetectionAbortedError`: a coleta inteira foi interrompida, por cancelamento
 * ou pelo prazo global. Diferente da falha de uma sondagem (que só deixa
 * atributos indisponíveis) e de uma falha comum do detector (que vira um
 * registro `error`): uma coleta interrompida não produz resultado nenhum e o
 * serviço não grava nada.
 */

export type DetectionAbortReason = 'cancelled' | 'timeout'

export class DetectionAbortedError extends Error {
  readonly reason: DetectionAbortReason

  constructor(reason: DetectionAbortReason) {
    super(reason === 'timeout' ? 'Tempo limite da análise de hardware esgotado.' : 'Análise de hardware cancelada.')
    this.name = 'AbortError'
    this.reason = reason
  }
}

/** Motivo da interrupção pelo sinal: `timeout` quando ele veio de um prazo (`AbortSignal.timeout`). */
export function abortReasonOf(signal: AbortSignal): DetectionAbortReason {
  return (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError' ? 'timeout' : 'cancelled'
}

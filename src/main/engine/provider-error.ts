import type { InferenceError } from '@shared/inference'

/**
 * Falha de um provedor fora da geração (inventário, verificação), com o
 * código de inferência preservado. O `RunService` usa o código para separar
 * "provedor indisponível" de "modelo não encontrado".
 */
export class InferenceProviderError extends Error {
  readonly error: InferenceError

  constructor(error: InferenceError) {
    super(error.message)
    this.name = 'InferenceProviderError'
    this.error = error
  }
}

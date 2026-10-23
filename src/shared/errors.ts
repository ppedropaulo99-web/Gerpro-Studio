import type { ValidationIssue } from './validation'

/**
 * Erros estruturados: a forma única com que Main, serviços e execuções
 * descrevem falhas ao Renderer. Nunca carregam stack trace nem dados sensíveis.
 */

export type ErrorCode =
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'invalid-state'
  | 'storage'
  | 'storage-read-only'
  | 'secret-storage-unavailable'
  | 'simulated-failure'
  | 'internal'

export interface StructuredError {
  code: ErrorCode
  message: string
  /** Se repetir a mesma operação pode dar certo. */
  retryable: boolean
  /** Presente quando `code === 'validation'`. */
  issues?: ValidationIssue[]
  details?: Record<string, string | number | boolean | null>
}

/** Resultado de operações expostas ao Renderer. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: StructuredError }

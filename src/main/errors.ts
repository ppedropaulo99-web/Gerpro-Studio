import type { ErrorCode, StructuredError } from '@shared/errors'
import { formatIssues, type ValidationIssue, type ValidationResult } from '@shared/validation'

/** Erro de domínio lançado pelos serviços do Main; vira `StructuredError` no IPC. */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly issues: ValidationIssue[] | undefined
  readonly details: StructuredError['details']

  constructor(
    code: ErrorCode,
    message: string,
    extra: { retryable?: boolean; issues?: ValidationIssue[]; details?: StructuredError['details'] } = {}
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.retryable = extra.retryable ?? false
    this.issues = extra.issues
    this.details = extra.details
  }

  static validation(issues: ValidationIssue[]): AppError {
    return new AppError('validation', `Dados inválidos: ${formatIssues(issues)}`, { issues })
  }

  toStructured(): StructuredError {
    const out: StructuredError = { code: this.code, message: this.message, retryable: this.retryable }
    if (this.issues) out.issues = this.issues
    if (this.details) out.details = this.details
    return out
  }
}

/** Devolve o valor validado ou lança `AppError('validation')`. */
export function unwrap<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw AppError.validation(result.issues)
  return result.value
}

export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof AppError) return error.toStructured()
  return { code: 'internal', message: 'Erro interno no processo principal.', retryable: false }
}

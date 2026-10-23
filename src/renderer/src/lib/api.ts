import type { Result, StructuredError } from '@shared/errors'
import type { ValidationIssue } from '@shared/validation'

/**
 * Chama uma função de `window.gerpro` e garante um `Result`: se a ponte
 * falhar (Preload ausente, remetente bloqueado), vira um erro estruturado.
 */
export async function callApi<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn()
  } catch {
    return {
      ok: false,
      error: { code: 'internal', message: 'Não foi possível comunicar com o processo principal.', retryable: true }
    }
  }
}

/**
 * Agrupa os problemas de validação por campo do formulário. `fieldOf` traduz
 * o caminho do contrato (`$.defaultProfile.topP`) para o nome do campo (`topP`);
 * o que não tiver campo cai em `form`.
 */
export function issuesByField<F extends string>(
  issues: readonly ValidationIssue[],
  fieldOf: (path: string) => F | undefined
): Partial<Record<F | 'form', string>> {
  const out: Partial<Record<F | 'form', string>> = {}
  for (const issue of issues) {
    const key = fieldOf(issue.path) ?? 'form'
    out[key] ??= key === 'form' ? `${issue.path}: ${issue.message}` : issue.message
  }
  return out
}

export function errorMessage(error: StructuredError): string {
  return error.code === 'validation' ? 'Alguns campos estão inválidos.' : error.message
}

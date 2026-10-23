/**
 * Validação de dados em tempo de execução, sem dependências externas.
 *
 * Os tipos TypeScript somem na compilação; tudo que atravessa o IPC ou vem
 * do disco é `unknown` até passar por um destes verificadores.
 */

export interface ValidationIssue {
  /** Caminho do campo no formato `$.a.b[0]`. */
  path: string
  message: string
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface StringRules {
  min?: number
  max?: number
  pattern?: RegExp
  patternMessage?: string
}

interface NumberRules {
  min?: number
  max?: number
  integer?: boolean
}

/** Acumula problemas enquanto um valor é lido campo a campo. */
export class Checker {
  readonly issues: ValidationIssue[] = []

  fail(path: string, message: string): undefined {
    this.issues.push({ path, message })
    return undefined
  }

  get ok(): boolean {
    return this.issues.length === 0
  }

  record(value: unknown, path: string, allowedKeys?: readonly string[]): Record<string, unknown> | undefined {
    if (!isRecord(value)) return this.fail(path, 'deve ser um objeto')
    if (allowedKeys) {
      for (const key of Object.keys(value)) {
        if (!allowedKeys.includes(key)) this.fail(`${path}.${key}`, 'campo não permitido')
      }
    }
    return value
  }

  string(value: unknown, path: string, rules: StringRules = {}): string | undefined {
    if (typeof value !== 'string') return this.fail(path, 'deve ser um texto')
    if (value.includes('\0')) return this.fail(path, 'contém caractere nulo')
    if (rules.min !== undefined && value.length < rules.min) return this.fail(path, `deve ter ao menos ${rules.min} caractere(s)`)
    if (rules.max !== undefined && value.length > rules.max) return this.fail(path, `deve ter no máximo ${rules.max} caracteres`)
    if (rules.pattern && !rules.pattern.test(value)) return this.fail(path, rules.patternMessage ?? 'formato inválido')
    return value
  }

  number(value: unknown, path: string, rules: NumberRules = {}): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.fail(path, 'deve ser um número finito')
    if (rules.integer && !Number.isInteger(value)) return this.fail(path, 'deve ser um número inteiro')
    if (rules.min !== undefined && value < rules.min) return this.fail(path, `deve ser ≥ ${rules.min}`)
    if (rules.max !== undefined && value > rules.max) return this.fail(path, `deve ser ≤ ${rules.max}`)
    return value
  }

  boolean(value: unknown, path: string): boolean | undefined {
    if (typeof value !== 'boolean') return this.fail(path, 'deve ser verdadeiro ou falso')
    return value
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | undefined {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      return this.fail(path, `deve ser um de: ${allowed.join(', ')}`)
    }
    return value as T
  }

  array<T>(
    value: unknown,
    path: string,
    item: (value: unknown, path: string) => T | undefined,
    rules: { max?: number; unique?: boolean } = {}
  ): T[] | undefined {
    if (!Array.isArray(value)) return this.fail(path, 'deve ser uma lista')
    if (rules.max !== undefined && value.length > rules.max) return this.fail(path, `deve ter no máximo ${rules.max} itens`)
    const before = this.issues.length
    const out = value.map((v, i) => item(v, `${path}[${i}]`))
    if (this.issues.length > before) return undefined
    if (rules.unique && new Set(out).size !== out.length) return this.fail(path, 'contém itens repetidos')
    return out as T[]
  }

  /** `null` é aceito; qualquer outro valor passa pelo verificador informado. */
  nullable<T>(value: unknown, path: string, read: (value: unknown, path: string) => T | undefined): T | null | undefined {
    return value === null ? null : read(value, path)
  }

  isoDate(value: unknown, path: string): string | undefined {
    const text = this.string(value, path, { max: 40 })
    if (text === undefined) return undefined
    if (Number.isNaN(Date.parse(text))) return this.fail(path, 'deve ser uma data ISO 8601')
    return text
  }

  result<T>(value: T | undefined): ValidationResult<T> {
    if (this.issues.length > 0 || value === undefined) {
      return { ok: false, issues: this.issues.length > 0 ? this.issues : [{ path: '$', message: 'valor inválido' }] }
    }
    return { ok: true, value }
  }
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('; ')
}

/** Identificadores estáveis (agentes, ferramentas, motores): minúsculas, dígitos e hífen. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function readSlug(c: Checker, value: unknown, path: string): string | undefined {
  return c.string(value, path, { pattern: SLUG_PATTERN, patternMessage: 'use letras minúsculas, dígitos e hífen (até 64)' })
}

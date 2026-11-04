/**
 * Visões do fonte do launcher (`native/helper-host/src/main.cpp`) com os
 * blocos da variante DIAGNÓSTICA resolvidos como o pré-processador faria
 * (6C.6C.2C). Os blocos diagnósticos nunca são aninhados (conferido em
 * `diagnosticBlocks`), então uma expressão regular basta.
 */

const DIAG_BLOCK = /#if defined\(GERPRO_HOST_DIAG_(BUILD|DETACHED)\)( && !defined\(GERPRO_HOST_DIAG_BUILD\))?\n([\s\S]*?)(?:#else\n([\s\S]*?))?#endif\n/g

export interface DiagOptions {
  diag: boolean
  detached: boolean
}

/** Blocos diagnósticos: macro, ramo verdadeiro e ramo `#else`. */
export function diagnosticBlocks(text: string): Array<{ macro: 'BUILD' | 'DETACHED'; guard: boolean; first: string; second: string | null }> {
  return [...text.matchAll(DIAG_BLOCK)].map((m) => ({ macro: m[1] as 'BUILD' | 'DETACHED', guard: m[2] !== undefined, first: m[3] ?? '', second: m[4] ?? null }))
}

export function resolveDiagnostic(text: string, options: DiagOptions): string {
  return text.replace(DIAG_BLOCK, (_all, macro: string, guard: string | undefined, first: string, second: string | undefined) => {
    const condition = macro === 'BUILD' ? options.diag : options.detached && (guard === undefined || !options.diag)
    return condition ? first : (second ?? '')
  })
}

/** O que os builds de produção e de testes compilam (sem a variante diagnóstica). */
export const nonDiagnostic = (text: string) => resolveDiagnostic(text, { diag: false, detached: false })

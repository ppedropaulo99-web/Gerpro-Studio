/**
 * Verificações do supervisor (Node, fora do Electron) para o diagnóstico
 * MANUAL do auxiliar DXCore (Etapa 6C.4A). Só interpretação de texto: quem
 * inicia `whoami.exe` e `tasklist.exe` é o supervisor, sem shell, pela pasta
 * do sistema. A saída desses comandos nunca é impressa nem guardada; só os
 * resultados abaixo saem daqui.
 *
 * Sem importações: carregado direto pela remoção nativa de tipos do Node.
 */

/** Nome fixo do executável do auxiliar (o mesmo de `DXCORE_HELPER.fileName`). */
export const HELPER_IMAGE = 'gerpro-dxcore-helper.exe'

/** Trava exclusiva na pasta temporária do sistema: impede dois diagnósticos DXCore ao mesmo tempo. */
export const DXCORE_LOCK_NAME = 'gerpro-dxcore-diagnostic.lock'

/** Argumentos fixos. `/fo csv /nh`: colunas entre aspas, SIDs em vez de nomes traduzidos. */
export const WHOAMI_ARGS = ['/groups', '/fo', 'csv', '/nh'] as const
export const TASKLIST_ARGS = ['/fi', `IMAGENAME eq ${HELPER_IMAGE}`, '/fo', 'csv', '/nh'] as const

export type IntegrityLevel = 'low' | 'medium' | 'high' | 'system' | 'unknown'

/** SIDs de nível de integridade (rótulo obrigatório do token). */
const LEVELS: ReadonlyArray<readonly [string, IntegrityLevel]> = [
  ['S-1-16-4096', 'low'],
  ['S-1-16-8192', 'medium'],
  ['S-1-16-8448', 'medium'],
  ['S-1-16-12288', 'high'],
  ['S-1-16-16384', 'system']
]

/**
 * Nível de integridade do processo, pela saída de `whoami /groups /fo csv /nh`.
 * Elevado = `high` ou `system`. Mais de um rótulo, ou nenhum: `unknown`.
 */
export function integrityLevelFrom(csv: string): IntegrityLevel {
  const found = new Set<IntegrityLevel>()
  for (const line of csv.split(/\r?\n/)) {
    for (const [sid, level] of LEVELS) if (line.includes(`"${sid}"`)) found.add(level)
  }
  return found.size === 1 ? [...found][0]! : 'unknown'
}

/** Execução permitida só sem elevação (nível médio ou baixo). */
export const isUnelevated = (level: IntegrityLevel): boolean => level === 'medium' || level === 'low'

/**
 * Processos do auxiliar em execução, pela saída de `tasklist /fi ... /fo csv /nh`.
 * Só conta linhas cuja primeira coluna é exatamente o nome do auxiliar (a
 * mensagem de "nenhuma tarefa" é traduzida e não é CSV).
 */
export function countHelperProcesses(csv: string): number {
  return csv.split(/\r?\n/).filter((line) => line.toLowerCase().startsWith(`"${HELPER_IMAGE}"`)).length
}

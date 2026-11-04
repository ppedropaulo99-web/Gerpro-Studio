import { win32 } from 'node:path'
import { isTrustedRoot } from './bundled-helper'

/**
 * Raiz de recursos do app, onde fica `helpers\win32-<arch>\` (D56). Função
 * pura: o Main passa os valores do próprio Electron; nada vem do Renderer,
 * do IPC, das configurações, de variáveis de ambiente ou da linha de comando.
 *
 * - Empacotado: `process.resourcesPath` (fora do asar).
 * - Desenvolvimento: `<app.getAppPath()>\resources` (raiz do projeto com
 *   `electron-vite`).
 *
 * `null` se o caminho não passar em `isTrustedRoot` (relativo, de rede, de
 * dispositivo, com `..`, não normalizado): sem raiz, o detector não recebe o
 * auxiliar e a GPU sai pelo Electron + Registro. Links e junções são
 * conferidos depois, pelo executor, a cada execução.
 */
export interface AppPaths {
  /** `app.isPackaged`. */
  isPackaged: boolean
  /** `app.getAppPath()`. */
  appPath: string
  /** `process.resourcesPath`. */
  resourcesPath: string
}

/** Caminho aceito por `isTrustedRoot`, sem barra final; senão `null`. */
function trusted(path: unknown): string | null {
  if (typeof path !== 'string') return null
  const root = path.replace(/\\+$/, '')
  return isTrustedRoot(root) ? root : null
}

export function resolveHelperResourcesRoot(paths: AppPaths): string | null {
  if (paths.isPackaged) return trusted(paths.resourcesPath)
  // A base é conferida ANTES de juntar: `join` resolveria `..` e esconderia um caminho fora da política.
  const base = trusted(paths.appPath)
  return base === null ? null : trusted(win32.join(base, 'resources'))
}

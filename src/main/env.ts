import { app } from 'electron'

/** URL do servidor Vite em desenvolvimento, injetada pelo electron-vite. */
export const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']

export const isDev = !app.isPackaged && Boolean(rendererDevUrl)

/** Verdadeiro apenas para URLs servidas pela própria aplicação. */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') return true
    if (isDev && rendererDevUrl) return parsed.origin === new URL(rendererDevUrl).origin
    return false
  } catch {
    return false
  }
}

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, shell } from 'electron'
import { isAppUrl, isDev, rendererDevUrl } from './env'

const here = fileURLToPath(new URL('.', import.meta.url))

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Gerpro Studio',
    backgroundColor: '#0d0f14',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0f14', symbolColor: '#a3abbd', height: 40 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      devTools: isDev
    }
  })

  win.once('ready-to-show', () => win.show())

  // Nenhuma janela nova dentro do app; links https vão para o navegador do sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // O renderer nunca navega para fora da própria aplicação.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })

  if (isDev && rendererDevUrl) {
    void win.loadURL(rendererDevUrl)
  } else {
    void win.loadFile(join(here, '../renderer/index.html'))
  }

  return win
}

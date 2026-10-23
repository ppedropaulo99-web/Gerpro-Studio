import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, shell } from 'electron'
import { themeArgument, type Theme } from '@shared/settings'
import { isAppUrl, isDev, rendererDevUrl } from './env'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * Cores nativas da janela por tema. Espelham `--bg` e `--text-muted` de
 * `renderer/src/styles/tokens.css`: mantenha os dois em sincronia.
 */
const WINDOW_CHROME: Record<Theme, { background: string; symbols: string }> = {
  dark: { background: '#0d0f14', symbols: '#a3abbd' },
  light: { background: '#f3f7fc', symbols: '#526884' }
}

const TITLE_BAR_HEIGHT = 40

/** Aplica o tema às partes nativas (fundo e botões da barra de título) sem recarregar. */
export function applyWindowTheme(win: BrowserWindow, theme: Theme): void {
  if (win.isDestroyed()) return
  const chrome = WINDOW_CHROME[theme]
  win.setBackgroundColor(chrome.background)
  // Só Windows e Linux têm a sobreposição de controles configurável.
  if (process.platform !== 'darwin') {
    win.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbols, height: TITLE_BAR_HEIGHT })
  }
}

export function createMainWindow(theme: Theme): BrowserWindow {
  const chrome = WINDOW_CHROME[theme]
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Gerpro Studio',
    // O fundo nativo já nasce no tema salvo: é o que aparece antes do primeiro quadro.
    backgroundColor: chrome.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.background, symbolColor: chrome.symbols, height: TITLE_BAR_HEIGHT },
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
      devTools: isDev,
      additionalArguments: [themeArgument(theme)]
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

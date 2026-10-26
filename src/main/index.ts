import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { OLLAMA_DEFAULT_URL } from './engine/ollama/ollama-provider'
import { createServices } from './services'
import { applyWindowTheme, createMainWindow } from './window'
import { applySessionSecurity } from './security'
import { registerIpcHandlers } from './ipc'

// Identidade própria no Windows (agrupamento e fixação na barra de tarefas).
// Precisa ser definida antes de criar janelas e coincidir com o
// `System.AppUserModel.ID` dos atalhos (scripts/windows/install-shortcuts.ps1).
const APP_USER_MODEL_ID = 'br.com.gerpro.studio'
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)

// Um único processo do app: uma segunda instância só foca a janela existente.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  applySessionSecurity()
  // Dados locais ficam em <userData>/storage, lidos e gravados só pelo Main.
  // O Ollama só é consultado neste computador; se estiver desligado, o app funciona sem ele.
  const services = await createServices(join(app.getPath('userData'), 'storage'), { ollamaBaseUrl: OLLAMA_DEFAULT_URL })
  registerIpcHandlers(services)
  app.on('before-quit', () => services.runs.dispose())
  // Tema trocado em Configurações: as partes nativas da janela acompanham na hora.
  services.settings.onChange((settings) => {
    for (const win of BrowserWindow.getAllWindows()) applyWindowTheme(win, settings.appearance.theme)
  })
  const openWindow = () => createMainWindow(services.settings.get().appearance.theme)
  openWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

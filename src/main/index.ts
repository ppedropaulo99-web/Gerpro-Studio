import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { createServices } from './services'
import { createMainWindow } from './window'
import { applySessionSecurity } from './security'
import { registerIpcHandlers } from './ipc'

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
  const services = await createServices(join(app.getPath('userData'), 'storage'))
  registerIpcHandlers(services)
  app.on('before-quit', () => services.runs.dispose())
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

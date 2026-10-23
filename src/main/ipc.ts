import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IpcChannels, IpcEvents, type AppInfo } from '@shared/ipc'
import { isAppUrl } from './env'
import { createDataHandlers, invokeHandler } from './ipc-handlers'
import type { Services } from './services'

/** Rejeita chamadas vindas de qualquer frame que não seja a própria aplicação. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? ''
  if (!isAppUrl(url)) {
    throw new Error(`IPC bloqueado: remetente não confiável (${url || 'desconhecido'})`)
  }
}

export function registerIpcHandlers(services: Services): void {
  ipcMain.handle(IpcChannels.appGetInfo, (event): AppInfo => {
    assertTrustedSender(event)
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      }
    }
  })

  for (const [channel, spec] of Object.entries(createDataHandlers(services))) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertTrustedSender(event)
      return invokeHandler(channel, spec, args)
    })
  }

  // Eventos só vão para janelas que exibem a própria aplicação.
  services.runs.onUpdate((run) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents
      if (!wc.isDestroyed() && isAppUrl(wc.getURL())) wc.send(IpcEvents.runsUpdated, run)
    }
  })
}

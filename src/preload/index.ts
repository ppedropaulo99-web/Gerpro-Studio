import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, IpcEvents, type GerproApi } from '@shared/ipc'
import type { RunRecord } from '@shared/runs'

// O Renderer recebe só funções de alto nível. ipcRenderer em si nunca é exposto.
const api: GerproApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IpcChannels.appGetInfo)
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.settingsGet),
    update: (patch) => ipcRenderer.invoke(IpcChannels.settingsUpdate, patch)
  },
  agents: {
    list: () => ipcRenderer.invoke(IpcChannels.agentsList),
    create: (draft) => ipcRenderer.invoke(IpcChannels.agentsCreate, draft),
    update: (draft) => ipcRenderer.invoke(IpcChannels.agentsUpdate, draft),
    remove: (id) => ipcRenderer.invoke(IpcChannels.agentsDelete, id)
  },
  tools: {
    list: () => ipcRenderer.invoke(IpcChannels.toolsList)
  },
  runs: {
    list: () => ipcRenderer.invoke(IpcChannels.runsList),
    startDemo: (request) => ipcRenderer.invoke(IpcChannels.runsStartDemo, request),
    cancel: (id) => ipcRenderer.invoke(IpcChannels.runsCancel, id),
    onUpdated: (listener) => {
      // O evento do Electron não é repassado: só o dado da execução.
      const handler = (_event: Electron.IpcRendererEvent, run: RunRecord) => listener(run)
      ipcRenderer.on(IpcEvents.runsUpdated, handler)
      return () => {
        ipcRenderer.removeListener(IpcEvents.runsUpdated, handler)
      }
    }
  },
  hardware: {
    getState: () => ipcRenderer.invoke(IpcChannels.hardwareGetState),
    setLocalConsent: (change) => ipcRenderer.invoke(IpcChannels.hardwareSetLocalConsent, change),
    analyze: (request) => ipcRenderer.invoke(IpcChannels.hardwareAnalyze, request),
    deleteData: () => ipcRenderer.invoke(IpcChannels.hardwareDeleteData)
  }
}

contextBridge.exposeInMainWorld('gerpro', api)

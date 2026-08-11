import { contextBridge, ipcRenderer } from 'electron'

export interface ElectronAPI {
  minimizeWindow: () => Promise<void>
  maximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  selectFiles: (options?: { allowDirectories?: boolean }) => Promise<string[]>
  selectSaveLocation: (defaultName: string, format: string) => Promise<string | null>
  selectExtractFolder: () => Promise<string | null>
  compressArchive: (options: any, jobId: string) => Promise<{ success: boolean; result?: any; error?: string }>
  extractArchive: (options: any, jobId: string) => Promise<{ success: boolean; result?: any; error?: string }>
  inspectArchive: (archivePath: string) => Promise<{ success: boolean; result?: any; error?: string }>
  openFolder: (targetPath: string) => Promise<void>
  getDefaultOutputDir: () => Promise<string>
  getItemStat: (itemPaths: string[]) => Promise<{ path: string; name: string; isDirectory: boolean; size: number }[]>
  onProgress: (callback: (data: any) => void) => () => void
}

const api: ElectronAPI = {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  selectFiles: (options) => ipcRenderer.invoke('dialog:selectFiles', options),
  selectSaveLocation: (defaultName, format) => ipcRenderer.invoke('dialog:selectSaveLocation', defaultName, format),
  selectExtractFolder: () => ipcRenderer.invoke('dialog:selectExtractFolder'),
  compressArchive: (options, jobId) => ipcRenderer.invoke('archive:compress', options, jobId),
  extractArchive: (options, jobId) => ipcRenderer.invoke('archive:extract', options, jobId),
  inspectArchive: (archivePath) => ipcRenderer.invoke('archive:inspect', archivePath),
  openFolder: (targetPath) => ipcRenderer.invoke('shell:openFolder', targetPath),
  getDefaultOutputDir: () => ipcRenderer.invoke('system:getDefaultOutputDir'),
  getItemStat: (itemPaths) => ipcRenderer.invoke('system:getItemStat', itemPaths),
  onProgress: (callback) => {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('archive:progress', handler)
    return () => {
      ipcRenderer.removeListener('archive:progress', handler)
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ArchivePreviewResult } from '../services/archivePreview'

export type DesktopPlatform = 'macos' | 'windows'

export interface SelectFilesOptions {
  allowDirectories?: boolean
  extensions?: string[]
  title?: string
  filterName?: string
}

export interface SaveDialogLabels {
  archiveFilter: string
  allFiles: string
}

export interface ElectronAPI {
  platform: DesktopPlatform
  minimizeWindow: () => Promise<void>
  maximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  selectFiles: (options?: SelectFilesOptions) => Promise<string[]>
  selectSaveLocation: (defaultName: string, format: string, labels?: SaveDialogLabels) => Promise<string | null>
  selectExtractFolder: (title?: string) => Promise<string | null>
  compressArchive: (options: any, jobId: string) => Promise<{ success: boolean; result?: any; error?: string; errorCode?: string }>
  extractArchive: (options: any, jobId: string) => Promise<{ success: boolean; result?: any; error?: string; errorCode?: string; code?: string }>
  cancelJob: (jobId: string) => Promise<boolean>
  inspectArchive: (archivePath: string) => Promise<{ success: boolean; result?: any; error?: string; errorCode?: string }>
  previewArchiveEntry: (archivePath: string, entryId: string, requestId: string) => Promise<{ success: boolean; result?: ArchivePreviewResult; error?: string; errorCode?: string }>
  cancelArchivePreview: (requestId: string) => Promise<boolean>
  openFolder: (targetPath: string) => Promise<void>
  getDefaultOutputDir: () => Promise<string>
  getItemStat: (itemPaths: string[]) => Promise<{ path: string; name: string; isDirectory: boolean; size: number }[]>
  getPathForFile: (file: File) => string
  onProgress: (callback: (data: any) => void) => () => void
}

const api: ElectronAPI = {
  platform: process.platform === 'darwin' ? 'macos' : 'windows',
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  selectFiles: (options) => ipcRenderer.invoke('dialog:selectFiles', options),
  selectSaveLocation: (defaultName, format, labels) => ipcRenderer.invoke('dialog:selectSaveLocation', defaultName, format, labels),
  selectExtractFolder: (title) => ipcRenderer.invoke('dialog:selectExtractFolder', title),
  compressArchive: (options, jobId) => ipcRenderer.invoke('archive:compress', options, jobId),
  extractArchive: (options, jobId) => ipcRenderer.invoke('archive:extract', options, jobId),
  cancelJob: (jobId) => ipcRenderer.invoke('archive:cancel', jobId),
  inspectArchive: (archivePath) => ipcRenderer.invoke('archive:inspect', archivePath),
  previewArchiveEntry: (archivePath, entryId, requestId) => ipcRenderer.invoke('archive:preview', archivePath, entryId, requestId),
  cancelArchivePreview: (requestId) => ipcRenderer.invoke('archive:cancelPreview', requestId),
  openFolder: (targetPath) => ipcRenderer.invoke('shell:openFolder', targetPath),
  getDefaultOutputDir: () => ipcRenderer.invoke('system:getDefaultOutputDir'),
  getItemStat: (itemPaths) => ipcRenderer.invoke('system:getItemStat', itemPaths),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (callback) => {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('archive:progress', handler)
    return () => {
      ipcRenderer.removeListener('archive:progress', handler)
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)

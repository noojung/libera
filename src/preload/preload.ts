import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ArchivePreviewRequestOptions, ArchivePreviewResult } from '../services/archivePreview'
import type { CompressionOptions } from '../services/compressor'
import type { ExtractionOptions } from '../services/extractor'
import type { ArchiveInspectionResult } from '../services/archiveInspector'
import type { ResolveExtractionInputsResult } from '../services/archiveInputResolver'

type CompressionResult = Awaited<ReturnType<typeof import('../services/compressor').compressArchive>>
type ExtractionResult = Awaited<ReturnType<typeof import('../services/extractor').extractArchive>>

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
  selectSaveLocation: (defaultName: string, extension: string, labels?: SaveDialogLabels) => Promise<string | null>
  selectExtractFolder: (title?: string) => Promise<string | null>
  compressArchive: (options: CompressionOptions, jobId: string) => Promise<{ success: boolean; result?: CompressionResult; error?: string; errorCode?: string }>
  extractArchive: (options: ExtractionOptions, jobId: string) => Promise<{ success: boolean; result?: ExtractionResult; error?: string; errorCode?: string; code?: string }>
  cancelJob: (jobId: string) => Promise<boolean>
  inspectArchive: (archivePath: string, password?: string) => Promise<{ success: boolean; result?: ArchiveInspectionResult; error?: string; errorCode?: string; code?: string }>
  previewArchiveEntry: (archivePath: string, entryId: string, requestId: string, options?: ArchivePreviewRequestOptions | string) => Promise<{ success: boolean; result?: ArchivePreviewResult; error?: string; errorCode?: string; code?: string }>
  cancelArchivePreview: (requestId: string) => Promise<boolean>
  openFolder: (targetPath: string) => Promise<void>
  openExternalLink: (url: string) => Promise<void>
  getDefaultOutputDir: () => Promise<string>
  getItemStat: (itemPaths: string[]) => Promise<{ path: string; name: string; isDirectory: boolean; size: number }[]>
  resolveExtractionInputs: (itemPaths: string[]) => Promise<ResolveExtractionInputsResult>
  getPathForFile: (file: File) => string
  onProgress: (callback: (data: any) => void) => () => void
}

const api: ElectronAPI = {
  platform: process.platform === 'darwin' ? 'macos' : 'windows',
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  selectFiles: (options) => ipcRenderer.invoke('dialog:selectFiles', options),
  selectSaveLocation: (defaultName, extension, labels) => ipcRenderer.invoke('dialog:selectSaveLocation', defaultName, extension, labels),
  selectExtractFolder: (title) => ipcRenderer.invoke('dialog:selectExtractFolder', title),
  compressArchive: (options, jobId) => ipcRenderer.invoke('archive:compress', options, jobId),
  extractArchive: (options, jobId) => ipcRenderer.invoke('archive:extract', options, jobId),
  cancelJob: (jobId) => ipcRenderer.invoke('archive:cancel', jobId),
  inspectArchive: (archivePath, password) => ipcRenderer.invoke('archive:inspect', archivePath, password),
  previewArchiveEntry: (archivePath, entryId, requestId, options) => ipcRenderer.invoke('archive:preview', archivePath, entryId, requestId, options),
  cancelArchivePreview: (requestId) => ipcRenderer.invoke('archive:cancelPreview', requestId),
  openFolder: (targetPath) => ipcRenderer.invoke('shell:openFolder', targetPath),
  openExternalLink: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getDefaultOutputDir: () => ipcRenderer.invoke('system:getDefaultOutputDir'),
  getItemStat: (itemPaths) => ipcRenderer.invoke('system:getItemStat', itemPaths),
  resolveExtractionInputs: (itemPaths) => ipcRenderer.invoke('archive:resolveExtractionInputs', itemPaths),
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

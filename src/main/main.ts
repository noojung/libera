import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import { promises as fsPromises } from 'fs'
import { compressArchive, CompressionOptions, calculateTotalSize } from '../services/compressor'
import {
  extractArchive,
  ExtractionError,
  ExtractionOptions,
  isWrongZipPasswordError,
  WRONG_ZIP_PASSWORD_ERROR_CODE
} from '../services/extractor'
import { inspectArchive } from '../services/archiveInspector'
import { ArchivePreviewError, previewArchiveEntry } from '../services/archivePreview'

let mainWindow: BrowserWindow | null = null
const activeExtractionControllers = new Map<string, AbortController>()
const activePreviewControllers = new Map<string, AbortController>()

type Operation = 'compression' | 'extraction' | 'inspection' | 'preview'

function classifyError(error: unknown, operation: Operation): string {
  if (error instanceof ArchivePreviewError) {
    const previewErrorCodes: Record<string, string> = {
      ENTRY_NOT_FOUND: 'entryNotFound',
      ENTRY_NOT_PREVIEWABLE: 'entryNotPreviewable',
      ENCRYPTED_PREVIEW_UNSUPPORTED: 'encryptedPreviewUnsupported',
      NOT_TEXT: 'notText',
      UNSUPPORTED_IMAGE: 'unsupportedImage',
      INVALID_IMAGE: 'invalidImage',
      IMAGE_TOO_LARGE: 'imageTooLarge',
      IMAGE_DIMENSIONS_TOO_LARGE: 'imageDimensionsTooLarge',
      PREVIEW_CANCELLED: 'previewCancelled'
    }
    return previewErrorCodes[error.code] || 'genericPreview'
  }
  if (operation === 'preview') return 'genericPreview'
  if (error instanceof ExtractionError) {
    const extractionErrorCodes: Record<string, string> = {
      EXTRACTION_CANCELLED: 'extractionCancelled',
      INSUFFICIENT_DISK_SPACE: 'insufficientDiskSpace',
      DESTINATION_FILE_TOO_LARGE: 'destinationFileTooLarge',
      TOO_MANY_ENTRIES: 'tooManyEntries',
      ARCHIVE_TOO_LARGE: 'archiveTooLarge',
      FILE_TOO_LARGE: 'fileTooLarge',
      DESTINATION_EXISTS: 'destinationExists',
      UNSAFE_ARCHIVE: 'unsafeArchive'
    }
    return extractionErrorCodes[error.code] || 'genericExtraction'
  }
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('Unsafe archive:')) {
    return message.includes('destination already exists') ? 'destinationExists' : 'unsafeArchive'
  }
  if (/unsupported archive format/i.test(message)) return 'unsupportedArchive'
  if (/does not exist/i.test(message)) return 'archiveMissing'
  if (/GZ format supports single files only|No input files specified for GZ/i.test(message)) return 'invalidGzInput'
  if (operation === 'compression') return 'genericCompression'
  if (operation === 'extraction') return 'genericExtraction'
  return 'genericInspection'
}

function createWindow() {
  const isMacOS = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1050,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    ...(isMacOS
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 19 }
        }
      : {
          frame: false
        }),
    backgroundColor: '#FFFFFF',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  // Development vs Production URL loading
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    for (const controller of activeExtractionControllers.values()) controller.abort()
    activeExtractionControllers.clear()
    for (const controller of activePreviewControllers.values()) controller.abort()
    activePreviewControllers.clear()
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// IPC Handlers
ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})

ipcMain.handle('window:close', () => {
  mainWindow?.close()
})

ipcMain.handle('dialog:selectFiles', async (_, options?: { allowDirectories?: boolean; extensions?: string[]; title?: string; filterName?: string }) => {
  if (!mainWindow) return []
  const properties: ('openFile' | 'openDirectory' | 'multiSelections')[] = ['openFile', 'multiSelections']
  if (options?.allowDirectories) {
    properties.push('openDirectory')
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties,
    title: options?.title || 'Select Files or Folders to Compress',
    filters: options?.extensions
      ? [{ name: options.filterName || 'Supported archive files', extensions: options.extensions }]
      : undefined
  })

  if (result.canceled) return []
  return result.filePaths
})

ipcMain.handle('dialog:selectSaveLocation', async (_, defaultName: string, format: string, labels?: { archiveFilter?: string; allFiles?: string }) => {
  if (!mainWindow) return null

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: labels?.archiveFilter || `${format.toUpperCase()} archive`, extensions: [format] },
      { name: labels?.allFiles || 'All files', extensions: ['*'] }
    ]
  })

  if (result.canceled) return null
  return result.filePath
})

ipcMain.handle('dialog:selectExtractFolder', async (_, title?: string) => {
  if (!mainWindow) return null

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: title || 'Select extraction destination folder'
  })

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('archive:compress', async (_, options: CompressionOptions, jobId: string) => {
  try {
    const result = await compressArchive(options, (progress) => {
      mainWindow?.webContents.send('archive:progress', { jobId, ...progress })
    })
    return { success: true, result }
  } catch (err: any) {
    return { success: false, error: err.message || 'Compression failed', errorCode: classifyError(err, 'compression') }
  }
})

ipcMain.handle('archive:extract', async (_, options: ExtractionOptions, jobId: string) => {
  const controller = new AbortController()
  activeExtractionControllers.set(jobId, controller)
  try {
    const result = await extractArchive(options, (progress) => {
      mainWindow?.webContents.send('archive:progress', { jobId, ...progress })
    }, { signal: controller.signal })
    return { success: true, result }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Extraction failed',
      errorCode: classifyError(err, 'extraction'),
      code: err.code === WRONG_ZIP_PASSWORD_ERROR_CODE || isWrongZipPasswordError(err)
        ? WRONG_ZIP_PASSWORD_ERROR_CODE
        : undefined
    }
  } finally {
    if (activeExtractionControllers.get(jobId) === controller) activeExtractionControllers.delete(jobId)
  }
})

ipcMain.handle('archive:cancel', (_, jobId: string) => {
  const controller = activeExtractionControllers.get(jobId)
  if (!controller) return false
  controller.abort()
  return true
})

ipcMain.handle('archive:inspect', async (_, archivePath: string) => {
  try {
    const result = await inspectArchive(archivePath)
    return { success: true, result }
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to inspect archive', errorCode: classifyError(err, 'inspection') }
  }
})

ipcMain.handle('archive:preview', async (_, archivePath: string, entryId: string, requestId: string) => {
  activePreviewControllers.get(requestId)?.abort()
  const controller = new AbortController()
  activePreviewControllers.set(requestId, controller)
  try {
    const result = await previewArchiveEntry(archivePath, entryId, { signal: controller.signal })
    return { success: true, result }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Failed to preview archive entry',
      errorCode: classifyError(err, 'preview')
    }
  } finally {
    if (activePreviewControllers.get(requestId) === controller) activePreviewControllers.delete(requestId)
  }
})

ipcMain.handle('archive:cancelPreview', (_, requestId: string) => {
  const controller = activePreviewControllers.get(requestId)
  if (!controller) return false
  controller.abort()
  return true
})

ipcMain.handle('shell:openFolder', async (_, targetPath: string) => {
  if (!targetPath) return
  try {
    await shell.showItemInFolder(targetPath)
  } catch {
    await shell.openPath(path.dirname(targetPath))
  }
})

ipcMain.handle('system:getDefaultOutputDir', async () => {
  try {
    return app.getPath('downloads') || app.getPath('documents') || app.getPath('userData')
  } catch {
    return app.getPath('userData')
  }
})

ipcMain.handle('system:getItemStat', async (_, itemPaths: string[]) => {
  return Promise.all(itemPaths.map(async p => {
    try {
      const stat = await fsPromises.lstat(p)
      const isDirectory = stat.isDirectory()
      let size = stat.size
      if (isDirectory) {
        size = await calculateTotalSize([p])
      }
      return {
        path: p,
        name: path.basename(p) || p,
        isDirectory,
        size
      }
    } catch {
      return {
        path: p,
        name: path.basename(p) || p,
        isDirectory: false,
        size: 0
      }
    }
  }))
})

import { app, BrowserWindow, crashReporter, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import fs, { promises as fsPromises } from 'fs'
import {
  compressArchive,
  CompressionError,
  CompressionOptions,
  calculateTotalSize,
  type ProgressCallback,
  type ProgressData
} from '../services/compressor'
import {
  extractArchive,
  ExtractionError,
  ExtractionOptions,
  isWrongZipPasswordError,
  WRONG_ZIP_PASSWORD_ERROR_CODE
} from '../services/extractor'
import { inspectArchive } from '../services/archiveInspector'
import { SplitVolumeError } from '../services/zip/volumes'
import {
  ArchivePreviewError,
  previewArchiveEntry,
  type ArchivePreviewRequestOptions
} from '../services/archivePreview'
import { SevenZipError } from '../services/sevenZip/error'
import {
  resolveExtractionInput,
  type ResolveExtractionInputsResult
} from '../services/archiveInputResolver'
import { canonicalArchivePath } from '../services/archiveVolumes'
import { listArchiveInputChildren } from '../services/archiveInputTree'
import appInfo from '../renderer/src/generated/appInfo.json'

let mainWindow: BrowserWindow | null = null
const activeCompressionControllers = new Map<string, AbortController>()
const activeExtractionControllers = new Map<string, AbortController>()
const activePreviewControllers = new Map<string, AbortController>()

type Operation = 'compression' | 'extraction' | 'inspection' | 'preview'

const PROGRESS_INTERVAL_MS = 100

interface ProgressForwarder {
  forward: ProgressCallback
  cancel: () => void
}

function createProgressForwarder(jobId: string): ProgressForwarder {
  let lastSentAt = 0
  let pending: ProgressData | null = null
  let timer: NodeJS.Timeout | null = null

  const send = (data: ProgressData) => {
    pending = null
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    lastSentAt = Date.now()
    if (!mainWindow || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send('archive:progress', { jobId, ...data })
  }

  return {
    forward: (data: ProgressData) => {
      if (data.phase !== 'processing') {
        send(data)
        return
      }

      const waited = Date.now() - lastSentAt
      if (waited >= PROGRESS_INTERVAL_MS) {
        send(data)
        return
      }

      pending = data
      if (!timer) {
        timer = setTimeout(() => {
          timer = null
          if (pending) send(pending)
        }, PROGRESS_INTERVAL_MS - waited)
      }
    },
    cancel: () => {
      pending = null
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}

function logFatal(kind: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`
  try {
    const directory = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(directory, { recursive: true })
    fs.appendFileSync(path.join(directory, 'main.log'), line)
  } catch {
    /* empty */
  }
  process.stderr.write(line)
}

crashReporter.start({ uploadToServer: false })

process.on('uncaughtException', (error) => {
  logFatal('uncaughtException', error)
  dialog.showErrorBox('Libera', error instanceof Error ? error.message : String(error))
  app.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logFatal('unhandledRejection', reason)
})

/**
 * The machine readable half of a password failure. The renderer prompts on
 * this rather than on the translated message, and it reuses the wire code the
 * ZIP extract path already speaks so the retry loop needs no second vocabulary.
 */
function passwordFailureCode(error: unknown): string | undefined {
  if (error instanceof SevenZipError) {
    if (error.code === 'SEVEN_ZIP_PASSWORD_REQUIRED') return 'PASSWORD_REQUIRED'
    if (error.code === 'SEVEN_ZIP_WRONG_PASSWORD') return WRONG_ZIP_PASSWORD_ERROR_CODE
  }
  if (error instanceof ArchivePreviewError) {
    if (error.code === 'PASSWORD_REQUIRED') return 'PASSWORD_REQUIRED'
    if (error.code === 'WRONG_PASSWORD') return WRONG_ZIP_PASSWORD_ERROR_CODE
  }
  if (isWrongZipPasswordError(error)) return WRONG_ZIP_PASSWORD_ERROR_CODE
  return undefined
}

function classifyError(error: unknown, operation: Operation): string {
  if (error instanceof ArchivePreviewError) {
    const previewErrorCodes: Record<string, string> = {
      ENTRY_NOT_FOUND: 'entryNotFound',
      PASSWORD_REQUIRED: 'passwordRequired',
      WRONG_PASSWORD: 'wrongArchivePassword',
      ENTRY_NOT_PREVIEWABLE: 'entryNotPreviewable',
      NOT_TEXT: 'notText',
      UNSUPPORTED_IMAGE: 'unsupportedImage',
      INVALID_IMAGE: 'invalidImage',
      IMAGE_TOO_LARGE: 'imageTooLarge',
      IMAGE_DIMENSIONS_TOO_LARGE: 'imageDimensionsTooLarge',
      PREVIEW_CANCELLED: 'previewCancelled'
    }
    return previewErrorCodes[error.code] || 'genericPreview'
  }
  if (error instanceof SplitVolumeError) {
    const splitVolumeErrorCodes: Record<string, string> = {
      SPLIT_VOLUME_MISSING: 'splitVolumeMissing',
      SPLIT_VOLUME_MISMATCH: 'splitVolumeMismatch',
      SPLIT_VOLUME_UNREADABLE: 'splitVolumeUnreadable'
    }
    return splitVolumeErrorCodes[error.code] || 'genericExtraction'
  }
  if (error instanceof SevenZipError) {
    const sevenZipErrorCodes: Record<string, string> = {
      SEVEN_ZIP_PASSWORD_REQUIRED: 'passwordRequired',
      SEVEN_ZIP_WRONG_PASSWORD: 'wrongArchivePassword',
      SEVEN_ZIP_CANCELLED: operation === 'compression' ? 'compressionCancelled' : 'extractionCancelled'
    }
    const mapped = sevenZipErrorCodes[error.code]
    if (mapped) return mapped
    return operation === 'compression' ? 'genericCompression'
      : operation === 'extraction' ? 'genericExtraction'
      : operation === 'preview' ? 'genericPreview'
      : 'genericInspection'
  }
  if (operation === 'preview') return 'genericPreview'
  if (error instanceof CompressionError) {
    const compressionErrorCodes: Record<string, string> = {
      COMPRESSION_CANCELLED: 'compressionCancelled',
      SPLIT_SIZE_TOO_SMALL: 'splitSizeTooSmall',
      SPLIT_NOT_SUPPORTED_FOR_FORMAT: 'splitNotSupportedForFormat',
      SPLIT_TOO_MANY_VOLUMES: 'splitTooManyVolumes'
    }
    return compressionErrorCodes[error.code] || 'genericCompression'
  }
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

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logFatal('render-process-gone', `${details.reason} (exitCode ${details.exitCode})`)
  })

  mainWindow.on('closed', () => {
    for (const controller of activeCompressionControllers.values()) controller.abort()
    activeCompressionControllers.clear()
    for (const controller of activeExtractionControllers.values()) controller.abort()
    activeExtractionControllers.clear()
    for (const controller of activePreviewControllers.values()) controller.abort()
    activePreviewControllers.clear()
    mainWindow = null
  })
}

app.whenReady().then(() => {
  // The system About panel would otherwise show electron-builder's default
  // copyright line, which names the package author rather than the project.
  // Both this and the in-app about dialog read the same generated metadata.
  app.setAboutPanelOptions({
    applicationName: 'Libera',
    applicationVersion: appInfo.version,
    copyright: `© ${appInfo.copyrightYear} ${appInfo.copyrightHolder}`
  })

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

ipcMain.handle('dialog:selectSaveLocation', async (_, defaultName: string, extension: string, labels?: { archiveFilter?: string; allFiles?: string }) => {
  if (!mainWindow) return null

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: labels?.archiveFilter || `${extension.toUpperCase()} archive`, extensions: [extension] },
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
  const controller = new AbortController()
  activeCompressionControllers.set(jobId, controller)
  const progress = createProgressForwarder(jobId)
  try {
    const result = await compressArchive(options, progress.forward, { signal: controller.signal })
    return { success: true, result }
  } catch (err: any) {
    return { success: false, error: err.message || 'Compression failed', errorCode: classifyError(err, 'compression') }
  } finally {
    progress.cancel()
    if (activeCompressionControllers.get(jobId) === controller) activeCompressionControllers.delete(jobId)
  }
})

ipcMain.handle('archive:extract', async (_, options: ExtractionOptions, jobId: string) => {
  const controller = new AbortController()
  activeExtractionControllers.set(jobId, controller)
  const progress = createProgressForwarder(jobId)
  try {
    const result = await extractArchive(options, progress.forward, { signal: controller.signal })
    return { success: true, result }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Extraction failed',
      errorCode: classifyError(err, 'extraction'),
      code: passwordFailureCode(err)
    }
  } finally {
    progress.cancel()
    if (activeExtractionControllers.get(jobId) === controller) activeExtractionControllers.delete(jobId)
  }
})

ipcMain.handle('archive:resolveExtractionInputs', async (_, itemPaths: string[]): Promise<ResolveExtractionInputsResult> => {
  const groupedPaths = new Map<string, string>()
  for (const itemPath of itemPaths) {
    const canonicalPath = canonicalArchivePath(itemPath)
    const key = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
    if (!groupedPaths.has(key)) groupedPaths.set(key, itemPath)
  }

  const resolved = await Promise.all([...groupedPaths.values()].map(async itemPath => {
    try {
      return { item: await resolveExtractionInput(itemPath) }
    } catch (error) {
      return {
        error: {
          path: itemPath,
          error: error instanceof Error ? error.message : String(error),
          errorCode: classifyError(error, 'extraction')
        }
      }
    }
  }))

  return {
    items: resolved.flatMap(result => result.item ? [result.item] : []),
    errors: resolved.flatMap(result => result.error ? [result.error] : [])
  }
})

ipcMain.handle('archive:cancel', (_, jobId: string) => {
  const controller = activeCompressionControllers.get(jobId) || activeExtractionControllers.get(jobId)
  if (!controller) return false
  controller.abort()
  return true
})

ipcMain.handle('archive:inspect', async (_, archivePath: string, password?: string) => {
  try {
    const result = await inspectArchive(archivePath, { password })
    return { success: true, result }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Failed to inspect archive',
      errorCode: classifyError(err, 'inspection'),
      code: passwordFailureCode(err)
    }
  }
})

ipcMain.handle('archive:preview', async (
  _, archivePath: string, entryId: string, requestId: string,
  requestOptions: ArchivePreviewRequestOptions | string = {}
) => {
  activePreviewControllers.get(requestId)?.abort()
  const controller = new AbortController()
  activePreviewControllers.set(requestId, controller)
  try {
    const options = typeof requestOptions === 'string' ? { password: requestOptions } : requestOptions
    const result = await previewArchiveEntry(archivePath, entryId, { signal: controller.signal, ...options })
    return { success: true, result }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Failed to preview archive entry',
      errorCode: classifyError(err, 'preview'),
      code: passwordFailureCode(err)
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

ipcMain.handle('shell:openExternal', async (_, url: string) => {
  // Every caller today passes a link baked in at build time, but the scheme
  // is still checked so this can never become a way to hand the OS an
  // arbitrary string - file:// or a custom protocol handler, say.
  if (!/^https?:\/\//i.test(url)) return
  await shell.openExternal(url)
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

ipcMain.handle('system:listArchiveInputChildren', async (_, directoryPath: string) => {
  return listArchiveInputChildren(directoryPath)
})

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import { promises as fsPromises } from 'fs'
import { compressArchive, CompressionOptions, calculateTotalSize } from '../services/compressor'
import { extractArchive, ExtractionOptions, isWrongZipPasswordError, WRONG_ZIP_PASSWORD_ERROR_CODE } from '../services/extractor'
import { inspectArchive } from '../services/archiveInspector'

let mainWindow: BrowserWindow | null = null

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

ipcMain.handle('dialog:selectFiles', async (_, options?: { allowDirectories?: boolean; extensions?: string[]; title?: string }) => {
  if (!mainWindow) return []
  const properties: ('openFile' | 'openDirectory' | 'multiSelections')[] = ['openFile', 'multiSelections']
  if (options?.allowDirectories) {
    properties.push('openDirectory')
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties,
    title: options?.title || 'Select Files or Folders to Compress',
    filters: options?.extensions
      ? [{ name: 'Supported Archive Files', extensions: options.extensions }]
      : undefined
  })

  if (result.canceled) return []
  return result.filePaths
})

ipcMain.handle('dialog:selectSaveLocation', async (_, defaultName: string, format: string) => {
  if (!mainWindow) return null

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: `${format.toUpperCase()} Archive`, extensions: [format] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })

  if (result.canceled) return null
  return result.filePath
})

ipcMain.handle('dialog:selectExtractFolder', async () => {
  if (!mainWindow) return null

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Extraction Destination Folder'
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
    return { success: false, error: err.message || 'Compression failed' }
  }
})

ipcMain.handle('archive:extract', async (_, options: ExtractionOptions, jobId: string) => {
  try {
    const result = await extractArchive(options, (progress) => {
      mainWindow?.webContents.send('archive:progress', { jobId, ...progress })
    })
    return { success: true, result }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Extraction failed',
      code: err.code === WRONG_ZIP_PASSWORD_ERROR_CODE || isWrongZipPasswordError(err)
        ? WRONG_ZIP_PASSWORD_ERROR_CODE
        : undefined
    }
  }
})

ipcMain.handle('archive:inspect', async (_, archivePath: string) => {
  try {
    const result = await inspectArchive(archivePath)
    return { success: true, result }
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to inspect archive' }
  }
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

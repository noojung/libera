import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { promises as fsPromises } from 'fs'

// The main process is wiring: it hands work to the services and turns whatever
// comes back into something the renderer can act on. Mocking Electron is what
// lets that wiring be driven here, and mocking the services is what lets each
// failure they can raise be put through it.
const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: never[]) => unknown>()
  const paths: Record<string, string | (() => never)> = {}
  const windows: FakeWindow[] = []

  class FakeWindow {
    readonly listeners = new Map<string, (...args: never[]) => void>()
    maximized = false
    closed = false
    readonly sent: unknown[] = []
    readonly webContents = {
      on: (event: string, listener: (...args: never[]) => void) => { this.listeners.set(`wc:${event}`, listener) },
      send: (channel: string, payload: unknown) => { this.sent.push({ channel, payload }) },
      isDestroyed: () => this.closed
    }

    constructor() { windows.push(this) }
    loadURL(): void {}
    loadFile(): void {}
    on(event: string, listener: (...args: never[]) => void): void { this.listeners.set(event, listener) }
    minimize(): void {}
    maximize(): void { this.maximized = true }
    unmaximize(): void { this.maximized = false }
    isMaximized(): boolean { return this.maximized }
    close(): void { this.closed = true; this.listeners.get('closed')?.() }
  }

  return {
    handlers,
    paths,
    windows,
    FakeWindow,
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      showErrorBox: vi.fn()
    },
    shell: {
      showItemInFolder: vi.fn(),
      openPath: vi.fn(),
      openExternal: vi.fn()
    },
    exits: [] as number[]
  }
})

vi.mock('electron', () => {
  const BrowserWindow = electron.FakeWindow as unknown as {
    new (): unknown
    getAllWindows(): unknown[]
  }
  ;(BrowserWindow as { getAllWindows(): unknown[] }).getAllWindows = () => electron.windows
  return {
    app: {
      whenReady: () => Promise.resolve(),
      on: () => undefined,
      quit: () => undefined,
      exit: (code: number) => { electron.exits.push(code) },
      setAboutPanelOptions: () => undefined,
      getPath: (name: string) => {
        const value = electron.paths[name]
        if (typeof value === 'function') return value()
        if (value === undefined) throw new Error(`unknown path: ${name}`)
        return value
      }
    },
    BrowserWindow,
    crashReporter: { start: () => undefined },
    ipcMain: {
      handle: (channel: string, listener: (event: unknown, ...args: never[]) => unknown) => {
        electron.handlers.set(channel, listener)
      }
    },
    dialog: electron.dialog,
    shell: electron.shell
  }
})

const services = vi.hoisted(() => ({
  compressArchive: vi.fn(),
  extractArchive: vi.fn(),
  inspectArchive: vi.fn(),
  previewArchiveEntry: vi.fn(),
  resolveExtractionInput: vi.fn()
}))

// Only the entry points are replaced; the error classes stay real, since the
// wiring sorts failures by what they are.
vi.mock('../services/compressor', async importActual => ({
  ...(await importActual<typeof import('../services/compressor')>()),
  compressArchive: services.compressArchive
}))
vi.mock('../services/extractor', async importActual => ({
  ...(await importActual<typeof import('../services/extractor')>()),
  extractArchive: services.extractArchive
}))
vi.mock('../services/archiveInspector', async importActual => ({
  ...(await importActual<typeof import('../services/archiveInspector')>()),
  inspectArchive: services.inspectArchive
}))
vi.mock('../services/archivePreview', async importActual => ({
  ...(await importActual<typeof import('../services/archivePreview')>()),
  previewArchiveEntry: services.previewArchiveEntry
}))
vi.mock('../services/archiveInputResolver', async importActual => ({
  ...(await importActual<typeof import('../services/archiveInputResolver')>()),
  resolveExtractionInput: services.resolveExtractionInput
}))

/** Calls a registered handler the way the renderer's invoke would. */
const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return await handler({}, ...(args as never[])) as T
}

let temporaryDir = ''
type ProcessEvent = 'uncaughtException' | 'unhandledRejection'
let ownProcessListeners: { event: ProcessEvent; listener: (...args: never[]) => void }[] = []

beforeAll(async () => {
  temporaryDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'libera-main-'))
  electron.paths.userData = temporaryDir
  electron.paths.downloads = path.join(temporaryDir, 'downloads')

  const before = {
    uncaughtException: process.listeners('uncaughtException'),
    unhandledRejection: process.listeners('unhandledRejection')
  }
  await import('./main')
  // Loading the module installs process-wide crash handlers. Left in place they
  // would swallow anything this file goes on to throw, so they are noted here
  // and taken back off at the end.
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    for (const listener of process.listeners(event)) {
      if (!before[event].includes(listener)) ownProcessListeners.push({ event, listener: listener as never })
    }
  }
  // The window is created once `whenReady` settles.
  await vi.waitFor(() => expect(electron.windows.length).toBe(1))
})

afterAll(async () => {
  for (const { event, listener } of ownProcessListeners) process.off(event, listener as never)
  ownProcessListeners = []
  await fsPromises.rm(temporaryDir, { recursive: true, force: true })
})

afterEach(() => vi.clearAllMocks())

describe('opening things outside the app', () => {
  // The only guard between the renderer and whatever the OS would do with a
  // string it is handed. A custom scheme is a registered handler somewhere.
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'libera://run',
    'HTTPS_not_a_url',
    ''
  ])('refuses to hand %s to the OS', async url => {
    await invoke('shell:openExternal', url)
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it.each(['https://example.com/guide', 'http://example.com', 'HTTPS://EXAMPLE.COM'])(
    'opens %s',
    async url => {
      await invoke('shell:openExternal', url)
      expect(electron.shell.openExternal).toHaveBeenCalledWith(url)
    }
  )

  it('falls back to the containing folder when the item cannot be revealed', async () => {
    electron.shell.showItemInFolder.mockImplementation(() => { throw new Error('no such item') })
    await invoke('shell:openFolder', path.join('archives', 'set.zip'))
    expect(electron.shell.openPath).toHaveBeenCalledWith('archives')
  })

  it('does nothing without a path', async () => {
    await invoke('shell:openFolder', '')
    expect(electron.shell.showItemInFolder).not.toHaveBeenCalled()
    expect(electron.shell.openPath).not.toHaveBeenCalled()
  })
})

describe('reporting what went wrong', () => {
  it('names the reason a compression failed', async () => {
    const { CompressionError } = await import('../services/compressor')
    services.compressArchive.mockRejectedValue(new CompressionError('SPLIT_SIZE_TOO_SMALL', 'too small'))

    expect(await invoke('archive:compress', {}, 'job-1'))
      .toMatchObject({ success: false, error: 'too small', errorCode: 'splitSizeTooSmall' })
  })

  it('names the reason an extraction failed', async () => {
    const { ExtractionError } = await import('../services/extractor')
    services.extractArchive.mockRejectedValue(new ExtractionError('INSUFFICIENT_DISK_SPACE', 'no room'))

    expect(await invoke('archive:extract', {}, 'job-2'))
      .toMatchObject({ success: false, errorCode: 'insufficientDiskSpace' })
  })

  it('separates a cancelled 7z by what was being done to it', async () => {
    const { SevenZipError } = await import('../services/sevenZip/error')
    services.compressArchive.mockRejectedValue(new SevenZipError('SEVEN_ZIP_CANCELLED', 'stopped'))
    services.extractArchive.mockRejectedValue(new SevenZipError('SEVEN_ZIP_CANCELLED', 'stopped'))

    expect(await invoke('archive:compress', {}, 'job-3'))
      .toMatchObject({ errorCode: 'compressionCancelled' })
    expect(await invoke('archive:extract', {}, 'job-4'))
      .toMatchObject({ errorCode: 'extractionCancelled' })
  })

  it('carries a password failure as a code the renderer can prompt on', async () => {
    const { SevenZipError } = await import('../services/sevenZip/error')
    services.extractArchive.mockRejectedValue(
      new SevenZipError('SEVEN_ZIP_WRONG_PASSWORD', 'wrong')
    )

    expect(await invoke('archive:extract', {}, 'job-5'))
      .toMatchObject({ errorCode: 'wrongArchivePassword', code: 'WRONG_ZIP_PASSWORD' })
  })

  it('asks for a password rather than reporting damage', async () => {
    const { ArchivePreviewError } = await import('../services/archivePreview')
    services.previewArchiveEntry.mockRejectedValue(new ArchivePreviewError('PASSWORD_REQUIRED', 'locked'))

    expect(await invoke('archive:preview', 'a.zip', 'id', 'req-1'))
      .toMatchObject({ errorCode: 'passwordRequired', code: 'PASSWORD_REQUIRED' })
  })

  it('reads an unsafe archive out of a plain message', async () => {
    services.extractArchive.mockRejectedValue(new Error('Unsafe archive: entry escapes the destination'))
    expect(await invoke('archive:extract', {}, 'job-6')).toMatchObject({ errorCode: 'unsafeArchive' })

    services.extractArchive.mockRejectedValue(new Error('Unsafe archive: destination already exists'))
    expect(await invoke('archive:extract', {}, 'job-7')).toMatchObject({ errorCode: 'destinationExists' })
  })

  it('falls back to the generic reason for the operation', async () => {
    services.inspectArchive.mockRejectedValue(new Error('something else entirely'))
    expect(await invoke('archive:inspect', 'a.zip')).toMatchObject({ errorCode: 'genericInspection' })
  })

  it('reports success with what the service returned', async () => {
    services.compressArchive.mockResolvedValue({ outputPath: 'out.zip' })
    expect(await invoke('archive:compress', {}, 'job-8'))
      .toEqual({ success: true, result: { outputPath: 'out.zip' } })
  })
})

describe('cancelling work in flight', () => {
  it('aborts the job it was given and forgets it afterwards', async () => {
    let signal: AbortSignal | undefined
    services.compressArchive.mockImplementation((_options, _progress, context) => {
      signal = context.signal
      return new Promise(resolve => setTimeout(() => resolve({ outputPath: 'out.zip' }), 0))
    })

    const running = invoke('archive:compress', {}, 'job-live')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(await invoke('archive:cancel', 'job-live')).toBe(true)
    expect(signal!.aborted).toBe(true)

    await running
    // The job is done, so cancelling it again has nothing to reach.
    expect(await invoke('archive:cancel', 'job-live')).toBe(false)
  })

  it('reports a job it does not know', async () => {
    expect(await invoke('archive:cancel', 'never-started')).toBe(false)
  })

  it('drops the earlier preview when the same request comes again', async () => {
    const signals: AbortSignal[] = []
    services.previewArchiveEntry.mockImplementation((_archive, _entry, options) => {
      signals.push(options.signal)
      return new Promise(resolve => setTimeout(() => resolve({ kind: 'text', text: '' }), 0))
    })

    const first = invoke('archive:preview', 'a.zip', '1', 'same-id')
    await vi.waitFor(() => expect(signals.length).toBe(1))
    const second = invoke('archive:preview', 'a.zip', '2', 'same-id')
    await vi.waitFor(() => expect(signals.length).toBe(2))

    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    await Promise.all([first, second])
  })

  it('takes a bare password as one, the way older callers sent it', async () => {
    services.previewArchiveEntry.mockResolvedValue({ kind: 'text', text: 'hello' })
    await invoke('archive:preview', 'a.zip', '1', 'req-2', 'hunter2')

    expect(services.previewArchiveEntry).toHaveBeenCalledWith(
      'a.zip', '1', expect.objectContaining({ password: 'hunter2' })
    )
  })

  it('reports a preview it does not know', async () => {
    expect(await invoke('archive:cancelPreview', 'never-started')).toBe(false)
  })
})

describe('asking the user for a location', () => {
  it('returns nothing when the file dialog is dismissed', async () => {
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke('dialog:selectFiles')).toEqual([])

    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    expect(await invoke('dialog:selectSaveLocation', 'a.zip', 'zip')).toBeNull()

    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke('dialog:selectExtractFolder')).toBeNull()
  })

  it('offers folders only when the caller allows them', async () => {
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/picked'] })

    await invoke('dialog:selectFiles')
    expect(electron.dialog.showOpenDialog.mock.calls[0][1].properties)
      .toEqual(['openFile', 'multiSelections'])

    await invoke('dialog:selectFiles', { allowDirectories: true })
    expect(electron.dialog.showOpenDialog.mock.calls[1][1].properties)
      .toEqual(['openFile', 'multiSelections', 'openDirectory'])
  })

  it('filters by the extensions the caller named', async () => {
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/picked'] })
    await invoke('dialog:selectFiles', { extensions: ['zip', '7z'], filterName: 'Archives' })

    expect(electron.dialog.showOpenDialog.mock.calls[0][1].filters)
      .toEqual([{ name: 'Archives', extensions: ['zip', '7z'] }])
  })

  it('offers the archive extension and everything else when saving', async () => {
    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/a.7z' })
    expect(await invoke('dialog:selectSaveLocation', 'a.7z', '7z')).toBe('/out/a.7z')

    expect(electron.dialog.showSaveDialog.mock.calls[0][1].filters)
      .toEqual([{ name: '7Z archive', extensions: ['7z'] }, { name: 'All files', extensions: ['*'] }])
  })

  it('returns nothing when a folder dialog closes with no folder', async () => {
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] })
    expect(await invoke('dialog:selectExtractFolder')).toBeNull()
  })
})

describe('answering the renderer about the system', () => {
  it('prefers downloads for the default output folder', async () => {
    expect(await invoke('system:getDefaultOutputDir')).toBe(electron.paths.downloads)
  })

  it("falls back to the app's own folder when there is no downloads folder", async () => {
    electron.paths.downloads = ''
    electron.paths.documents = ''
    try {
      expect(await invoke('system:getDefaultOutputDir')).toBe(temporaryDir)
    } finally {
      electron.paths.downloads = path.join(temporaryDir, 'downloads')
      delete electron.paths.documents
    }
  })

  it('falls back when asking for a folder throws', async () => {
    const downloads = electron.paths.downloads
    electron.paths.downloads = () => { throw new Error('no such path') }
    try {
      expect(await invoke('system:getDefaultOutputDir')).toBe(temporaryDir)
    } finally {
      electron.paths.downloads = downloads
    }
  })

  it('measures a file, and reports a missing one as empty rather than failing', async () => {
    const file = path.join(temporaryDir, 'sized.bin')
    await fsPromises.writeFile(file, Buffer.alloc(1234))
    const missing = path.join(temporaryDir, 'not-here.bin')

    expect(await invoke('system:getItemStat', [file, missing])).toEqual([
      { path: file, name: 'sized.bin', isDirectory: false, size: 1234 },
      { path: missing, name: 'not-here.bin', isDirectory: false, size: 0 }
    ])
  })

  it('measures a folder by everything inside it', async () => {
    const folder = path.join(temporaryDir, 'tree')
    await fsPromises.mkdir(path.join(folder, 'nested'), { recursive: true })
    await fsPromises.writeFile(path.join(folder, 'a.bin'), Buffer.alloc(100))
    await fsPromises.writeFile(path.join(folder, 'nested', 'b.bin'), Buffer.alloc(200))

    const [entry] = await invoke<{ isDirectory: boolean; size: number }[]>('system:getItemStat', [folder])
    expect(entry.isDirectory).toBe(true)
    expect(entry.size).toBe(300)
  })
})

describe('the window controls', () => {
  it('toggles between maximized and not', async () => {
    const window = electron.windows[0]
    expect(window.isMaximized()).toBe(false)

    await invoke('window:maximize')
    expect(window.isMaximized()).toBe(true)

    await invoke('window:maximize')
    expect(window.isMaximized()).toBe(false)
  })
})

/** What main.ts batches progress to, so the wait here follows it. */
const PROGRESS_INTERVAL_MS = 100

describe('reporting progress to the window', () => {
  const progressFor = (jobId: string): { phase: string; percent: number }[] =>
    electron.windows[0].sent
      .filter((item): item is { channel: string; payload: { jobId: string; phase: string; percent: number } } =>
        (item as { channel: string }).channel === 'archive:progress' &&
        (item as { payload: { jobId: string } }).payload.jobId === jobId)
      .map(item => ({ phase: item.payload.phase, percent: item.payload.percent }))

  it('holds back the middle of a burst and sends only where it got to', async () => {
    // Read inside the job but asserted outside it: the handler turns anything
    // thrown in there into a failed result, which would swallow the assertion.
    let duringBurst: number[] = []
    let afterTheInterval: number[] = []
    services.compressArchive.mockImplementation(async (_options, forward) => {
      // Three in a row with no time between them: the first goes at once, and
      // sending the rest as they arrived would flood the window.
      forward({ phase: 'processing', percent: 10, processedBytes: 1, totalBytes: 10 })
      forward({ phase: 'processing', percent: 20, processedBytes: 2, totalBytes: 10 })
      forward({ phase: 'processing', percent: 30, processedBytes: 3, totalBytes: 10 })
      duringBurst = progressFor('burst').map(item => item.percent)
      // Still running, so the held update is still owed.
      await new Promise(resolve => setTimeout(resolve, PROGRESS_INTERVAL_MS * 2))
      afterTheInterval = progressFor('burst').map(item => item.percent)
      return { outputPath: 'out.zip' }
    })

    await invoke('archive:compress', {}, 'burst')

    expect(duringBurst).toEqual([10])
    // 20 was overtaken by 30 while it waited, so it never goes at all.
    expect(afterTheInterval).toEqual([10, 30])
  })

  it('sends a phase change straight through', async () => {
    services.compressArchive.mockImplementation(async (_options, forward) => {
      forward({ phase: 'processing', percent: 50, processedBytes: 5, totalBytes: 10 })
      forward({ phase: 'complete', percent: 100, processedBytes: 10, totalBytes: 10 })
      return { outputPath: 'out.zip' }
    })

    await invoke('archive:compress', {}, 'phases')
    expect(progressFor('phases')).toEqual([
      { phase: 'processing', percent: 50 },
      { phase: 'complete', percent: 100 }
    ])
  })

  it('drops a held update once the job is over', async () => {
    services.extractArchive.mockImplementation(async (_options, forward) => {
      forward({ phase: 'processing', percent: 10, processedBytes: 1, totalBytes: 10 })
      forward({ phase: 'processing', percent: 20, processedBytes: 2, totalBytes: 10 })
      throw new Error('stopped right after')
    })

    await invoke('archive:extract', {}, 'abandoned')
    const seen = progressFor('abandoned').length
    await new Promise(resolve => setTimeout(resolve, 200))
    // Nothing arrives after the failure: the timer was cleared with the job.
    expect(progressFor('abandoned').length).toBe(seen)
  })
})

describe('resolving what was dropped on the window', () => {
  it('asks about a volume set once however many of its volumes arrive', async () => {
    services.resolveExtractionInput.mockImplementation(async (itemPath: string) => ({ path: itemPath }))

    await invoke('archive:resolveExtractionInputs', [
      path.join('d', 'set.z01'),
      path.join('d', 'set.z02'),
      path.join('d', 'set.zip')
    ])

    expect(services.resolveExtractionInput).toHaveBeenCalledTimes(1)
  })

  it('reports the paths it could not resolve beside the ones it could', async () => {
    services.resolveExtractionInput.mockImplementation(async (itemPath: string) => {
      if (itemPath.endsWith('broken.zip')) throw new Error('does not exist')
      return { path: itemPath }
    })

    const result = await invoke<{
      items: { path: string }[]
      errors: { path: string; errorCode: string }[]
    }>('archive:resolveExtractionInputs', ['good.zip', 'broken.zip'])

    expect(result.items).toEqual([{ path: 'good.zip' }])
    expect(result.errors).toEqual([
      { path: 'broken.zip', error: 'does not exist', errorCode: 'archiveMissing' }
    ])
  })
})

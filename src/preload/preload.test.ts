import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { promises as fsPromises } from 'fs'
import type { ElectronAPI } from './preload'

// Preload is the whole vocabulary the renderer has. Every method here is a
// channel name repeated in two files that never import each other, so the one
// thing neither can check alone is whether they still agree.
const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invocations: [] as { channel: string; args: unknown[] }[],
  listeners: new Map<string, Set<(...args: never[]) => void>>(),
  mainChannels: new Set<string>(),
  paths: {} as Record<string, string>,
  pathForFile: vi.fn()
}))

vi.mock('electron', () => {
  class FakeWindow {
    readonly webContents = { on: () => undefined, send: () => undefined, isDestroyed: () => false }
    loadURL(): void {}
    loadFile(): void {}
    on(): void {}
  }
  return {
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => { electron.exposed.set(key, value) }
    },
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => {
        electron.invocations.push({ channel, args })
        return Promise.resolve(`reply from ${channel}`)
      },
      on: (channel: string, listener: (...args: never[]) => void) => {
        const set = electron.listeners.get(channel) ?? new Set()
        set.add(listener)
        electron.listeners.set(channel, set)
      },
      removeListener: (channel: string, listener: (...args: never[]) => void) => {
        electron.listeners.get(channel)?.delete(listener)
      }
    },
    webUtils: { getPathForFile: electron.pathForFile },
    // Enough of the main-process side for main.ts to load and register.
    app: {
      whenReady: () => Promise.resolve(),
      on: () => undefined,
      quit: () => undefined,
      exit: () => undefined,
      setAboutPanelOptions: () => undefined,
      getPath: (name: string) => electron.paths[name] ?? ''
    },
    BrowserWindow: Object.assign(FakeWindow, { getAllWindows: () => [] }),
    crashReporter: { start: () => undefined },
    ipcMain: { handle: (channel: string) => { electron.mainChannels.add(channel) } },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showErrorBox: vi.fn() },
    shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), openExternal: vi.fn() }
  }
})

/**
 * Every method, the arguments it is called with, and the channel and payload it
 * is expected to put on the wire. Written out rather than derived, so a method
 * pointed at the wrong channel reads as a difference here.
 */
const FORWARDS: [keyof ElectronAPI, unknown[], string, unknown[]][] = [
  ['minimizeWindow', [], 'window:minimize', []],
  ['maximizeWindow', [], 'window:maximize', []],
  ['closeWindow', [], 'window:close', []],
  ['selectFiles', [{ allowDirectories: true }], 'dialog:selectFiles', [{ allowDirectories: true }]],
  ['selectSaveLocation', ['a.zip', 'zip', { archiveFilter: 'ZIP', allFiles: 'All' }],
    'dialog:selectSaveLocation', ['a.zip', 'zip', { archiveFilter: 'ZIP', allFiles: 'All' }]],
  ['selectExtractFolder', ['Pick a folder'], 'dialog:selectExtractFolder', ['Pick a folder']],
  ['compressArchive', [{ format: 'zip' }, 'job-1'], 'archive:compress', [{ format: 'zip' }, 'job-1']],
  ['extractArchive', [{ archivePath: 'a.zip' }, 'job-2'], 'archive:extract', [{ archivePath: 'a.zip' }, 'job-2']],
  ['cancelJob', ['job-3'], 'archive:cancel', ['job-3']],
  ['inspectArchive', ['a.zip', 'hunter2'], 'archive:inspect', ['a.zip', 'hunter2']],
  ['previewArchiveEntry', ['a.zip', 'entry-1', 'req-1', { password: 'p' }],
    'archive:preview', ['a.zip', 'entry-1', 'req-1', { password: 'p' }]],
  ['cancelArchivePreview', ['req-1'], 'archive:cancelPreview', ['req-1']],
  ['openFolder', ['/tmp/out'], 'shell:openFolder', ['/tmp/out']],
  ['openExternalLink', ['https://example.com'], 'shell:openExternal', ['https://example.com']],
  ['getDefaultOutputDir', [], 'system:getDefaultOutputDir', []],
  ['canRestoreSymlinks', [], 'system:canRestoreSymlinks', []],
  ['getItemStat', [['/a', '/b']], 'system:getItemStat', [['/a', '/b']]],
  ['listArchiveInputChildren', ['/dir'], 'system:listArchiveInputChildren', ['/dir']],
  ['planSevenZipSolidBlocks', [{ inputPaths: ['/a'] }], 'archive:planSevenZipSolidBlocks', [{ inputPaths: ['/a'] }]],
  ['resolveExtractionInputs', [['/a.zip']], 'archive:resolveExtractionInputs', [['/a.zip']]]
]

let api: ElectronAPI
let temporaryDir = ''
type ProcessEvent = 'uncaughtException' | 'unhandledRejection'
let ownProcessListeners: { event: ProcessEvent; listener: (...args: never[]) => void }[] = []

beforeAll(async () => {
  temporaryDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'libera-preload-'))
  electron.paths.userData = temporaryDir

  await import('./preload')
  api = electron.exposed.get('electronAPI') as ElectronAPI

  // main.ts is loaded only for the channels it registers. It installs
  // process-wide crash handlers on the way in, which are taken back off below
  // so they cannot swallow what the rest of this file throws.
  const before = {
    uncaughtException: process.listeners('uncaughtException'),
    unhandledRejection: process.listeners('unhandledRejection')
  }
  await import('../main/main')
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    for (const listener of process.listeners(event)) {
      if (!before[event].includes(listener)) {
        ownProcessListeners.push({ event, listener: listener as never })
      }
    }
  }
})

afterAll(async () => {
  for (const { event, listener } of ownProcessListeners) process.off(event, listener as never)
  ownProcessListeners = []
  await fsPromises.rm(temporaryDir, { recursive: true, force: true })
})

describe('the vocabulary the renderer is given', () => {
  it('puts the API on the window under one name', () => {
    expect([...electron.exposed.keys()]).toEqual(['electronAPI'])
    expect(api).toBeDefined()
  })

  it.each(FORWARDS)('sends %s down its channel', async (method, args, channel, payload) => {
    electron.invocations.length = 0
    const result = await (api[method] as (...values: unknown[]) => Promise<unknown>)(...args)

    expect(electron.invocations).toEqual([{ channel, args: payload }])
    // Whatever the main process answered is handed straight back.
    expect(result).toBe(`reply from ${channel}`)
  })

  // A channel named in one file and not the other is a feature that silently
  // does nothing, and neither file can see it alone.
  it('names only channels the main process answers', () => {
    const used = new Set(FORWARDS.map(([, , channel]) => channel))
    expect([...used].filter(channel => !electron.mainChannels.has(channel))).toEqual([])
  })

  it('leaves no handler in the main process that nothing can reach', () => {
    const used = new Set(FORWARDS.map(([, , channel]) => channel))
    expect([...electron.mainChannels].filter(channel => !used.has(channel)).sort()).toEqual([])
  })

  it('covers every method the API declares', () => {
    // `platform` is a value, and the last two are not plain forwards.
    const forwarded = new Set(FORWARDS.map(([method]) => method))
    const unaccounted = Object.keys(api)
      .filter(key => !forwarded.has(key as keyof ElectronAPI))
      .sort()
    expect(unaccounted).toEqual(['getPathForFile', 'onProgress', 'platform'])
  })
})

describe('the two methods that are more than a forward', () => {
  it('hands a dropped file to the only API that knows its path', () => {
    electron.pathForFile.mockReturnValue('/Users/someone/dropped.zip')
    const file = { name: 'dropped.zip' } as unknown as File

    expect(api.getPathForFile(file)).toBe('/Users/someone/dropped.zip')
    expect(electron.pathForFile).toHaveBeenCalledWith(file)
  })

  /** Delivers to whoever is registered, which is all Electron would reach. */
  const emitProgress = (payload: unknown): void => {
    for (const listener of [...(electron.listeners.get('archive:progress') ?? [])]) {
      listener({ sender: 'ipc' } as never, payload as never)
    }
  }

  it('passes on the progress payload without the event that carried it', () => {
    const seen: unknown[] = []
    const stop = api.onProgress(data => seen.push(data))

    emitProgress({ jobId: 'job-1', percent: 42 })
    expect(seen).toEqual([{ jobId: 'job-1', percent: 42 }])

    // The renderer unsubscribes on unmount, and nothing reaches it after.
    stop()
    emitProgress({ jobId: 'job-2', percent: 99 })
    expect(seen).toHaveLength(1)
  })

  it('subscribes each caller separately', () => {
    const first: unknown[] = []
    const second: unknown[] = []
    const stopFirst = api.onProgress(data => first.push(data))
    const stopSecond = api.onProgress(data => second.push(data))

    expect(electron.listeners.get('archive:progress')!.size).toBe(2)
    // Stopping one leaves the other listening.
    stopFirst()
    expect(electron.listeners.get('archive:progress')!.size).toBe(1)
    stopSecond()
  })
})

describe('which desktop the renderer is on', () => {
  const withPlatform = async (value: string): Promise<string> => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value, configurable: true })
    try {
      vi.resetModules()
      electron.exposed.delete('electronAPI')
      await import('./preload')
      return (electron.exposed.get('electronAPI') as ElectronAPI).platform
    } finally {
      Object.defineProperty(process, 'platform', original)
      vi.resetModules()
    }
  }

  it('calls darwin macOS', async () => {
    expect(await withPlatform('darwin')).toBe('macos')
  })

  // The app ships for two desktops, so anything that is not macOS is the other.
  it.each(['win32', 'linux'])('calls %s Windows', async value => {
    expect(await withPlatform(value)).toBe('windows')
  })
})

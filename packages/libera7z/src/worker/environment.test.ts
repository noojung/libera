import { isMainThread } from 'worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configure, spawnConfiguredWorker } from './config.js'
import type { WorkerReply } from './protocol.js'

afterEach(() => {
  vi.unstubAllGlobals()
  configure({ useWorkers: false, workerScript: undefined, createWorker: undefined })
})

// The package ships one worker bundle for two hosts, so which one it is running
// under is decided at run time by what the global scope offers. Nothing else
// checks that reading, and getting it wrong costs the whole worker path.
describe('finding the worker in the surrounding host', () => {
  it('spawns nothing while workers are switched off', () => {
    configure({ useWorkers: false, workerScript: 'somewhere', createWorker: () => { throw new Error('unreachable') } })
    expect(spawnConfiguredWorker()).toBeNull()
  })

  it('spawns nothing until a script is configured', () => {
    configure({ useWorkers: true, workerScript: undefined, createWorker: () => { throw new Error('unreachable') } })
    expect(spawnConfiguredWorker()).toBeNull()
  })

  it('spawns nothing when neither a factory nor a browser Worker is there', () => {
    configure({ useWorkers: true, workerScript: 'somewhere', createWorker: undefined })
    expect(spawnConfiguredWorker()).toBeNull()
  })

  // The caller carries on in process when a worker cannot be had, so a factory
  // that throws has to read as no worker rather than as a failed operation.
  it('spawns nothing when the factory throws', () => {
    configure({
      useWorkers: true,
      workerScript: 'somewhere',
      createWorker: () => { throw new Error('no threads here') }
    })
    expect(spawnConfiguredWorker()).toBeNull()
  })

  it('wraps a browser Worker when the page provides one', () => {
    const posted: unknown[] = []
    const listeners = new Map<string, (event: unknown) => void>()
    let terminated = 0
    class FakeWorker {
      constructor(readonly url: string | URL, readonly options?: object) {}
      postMessage(message: unknown): void { posted.push(message) }
      terminate(): void { terminated += 1 }
      addEventListener(type: string, listener: (event: unknown) => void): void {
        listeners.set(type, listener)
      }
    }
    vi.stubGlobal('Worker', FakeWorker)
    configure({ useWorkers: true, workerScript: 'bundle.js', createWorker: undefined })

    const worker = spawnConfiguredWorker()
    expect(worker).not.toBeNull()

    worker!.postMessage({ kind: 'close' })
    expect(posted).toEqual([{ kind: 'close' }])

    // A browser hands the message inside an event; the package's callers want
    // the message itself.
    const received: WorkerReply[] = []
    worker!.addMessageListener(reply => received.push(reply))
    listeners.get('message')!({ data: { kind: 'read-end', streamId: 1 } })
    expect(received).toEqual([{ kind: 'read-end', streamId: 1 }])

    const errors: unknown[] = []
    worker!.addErrorListener(error => errors.push(error))
    listeners.get('error')!('boom')
    expect(errors).toEqual(['boom'])

    worker!.terminate()
    expect(terminated).toBe(1)
  })
})

// Importing the bundle runs its own install, which reaches for `parentPort`.
// Under a pool that runs tests on real worker threads that port belongs to the
// test runner, so this stays out of the way rather than taking it over.
describe.skipIf(!isMainThread)('installing the worker bundle', () => {
  it('declines to install when it is not running inside a worker', async () => {
    const { installSevenZipWorker } = await import('./entry.js')
    expect(await installSevenZipWorker()).toBe(false)
  })

  it('installs against a browser worker scope', async () => {
    const listeners = new Map<string, (event: unknown) => void>()
    vi.stubGlobal('postMessage', () => undefined)
    vi.stubGlobal('addEventListener', (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener)
    })

    const { installSevenZipWorker } = await import('./entry.js')
    expect(await installSevenZipWorker()).toBe(true)
    // Installed means it is listening; a scope with a document is a page, not
    // a worker, and would have been turned down instead.
    expect(listeners.has('message')).toBe(true)
  })
})

import { promises as fsPromises } from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import {
  Libera7zError,
  readableFromGenerator,
  throwIfCancelled,
  type OpenEntryOptions,
  type SevenZipArchiveMetadata,
  type SevenZipEntry,
  type SevenZipEntryEvent,
  type SevenZipReader
} from '../../lib/libera7z'
import { reviveWorkerError, type WorkerFailure } from './workerMessages'

// The whole reader lives in the worker, so the boundary is the archive surface
// rather than the codec: open once, then pull entry events one at a time. The
// worker only advances when a pull arrives, which keeps a fast decoder from
// outrunning a slow consumer writing to disk. Stream 0 is the open request.
export type ReadWorkerRequest =
  | { type: 'open'; archivePath: string; maxEntries?: number; password?: string }
  | { type: 'read'; streamId: number; entryIds: number[] }
  | { type: 'pull'; streamId: number }
  | { type: 'cancel'; streamId: number }
  | { type: 'close' }

export type ReadWorkerMessage =
  | { type: 'opened'; streamId: number; entries: SevenZipEntry[]; metadata: SevenZipArchiveMetadata }
  | { type: 'event'; streamId: number; event: SevenZipEntryEvent }
  | { type: 'read-end'; streamId: number }
  | ({ type: 'failed'; streamId: number } & WorkerFailure)

const OPEN_STREAM_ID = 0

class ReadWorkerSession {
  private readonly pending = new Map<number, { resolve: (message: ReadWorkerMessage) => void; reject: (error: unknown) => void }>()
  private failure: Error | null = null

  constructor(private readonly worker: Worker) {
    worker.on('message', (message: ReadWorkerMessage) => {
      const waiter = this.pending.get(message.streamId)
      if (!waiter) return
      this.pending.delete(message.streamId)
      waiter.resolve(message)
    })
    worker.on('error', error => this.failAll(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => {
      if (this.pending.size > 0) this.failAll(new Error(`7z read worker exited with code ${code}`))
    })
  }

  private failAll(error: Error): void {
    this.failure = error
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }

  post(request: ReadWorkerRequest): void {
    if (!this.failure) this.worker.postMessage(request)
  }

  /** Sends a request and waits for the one reply the worker owes this stream. */
  request(streamId: number, request: ReadWorkerRequest): Promise<ReadWorkerMessage> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.pending.set(streamId, { resolve, reject })
      this.worker.postMessage(request)
    })
  }

  async terminate(): Promise<void> {
    await this.worker.terminate()
  }
}

class WorkerSevenZipArchive implements SevenZipReader {
  private nextStreamId = OPEN_STREAM_ID + 1

  constructor(
    private readonly session: ReadWorkerSession,
    readonly entries: readonly SevenZipEntry[],
    readonly metadata: SevenZipArchiveMetadata
  ) {}

  openEntries(ids: readonly number[], options: OpenEntryOptions = {}): ReadableStream<SevenZipEntryEvent> {
    const streamId = this.nextStreamId++
    const session = this.session
    const signal = options.signal
    const generator = (async function* (): AsyncGenerator<SevenZipEntryEvent> {
      const cancel = (): void => session.post({ type: 'cancel', streamId })
      signal?.addEventListener('abort', cancel, { once: true })
      session.post({ type: 'read', streamId, entryIds: [...ids] })
      if (signal?.aborted) cancel()
      try {
        while (true) {
          // The worker drops a cancelled stream, so its reply may be a clean
          // end. The signal is what the caller sees, exactly as when reading
          // in process.
          throwIfCancelled(signal)
          const message = await session.request(streamId, { type: 'pull', streamId })
          throwIfCancelled(signal)
          if (message.type === 'read-end') return
          if (message.type === 'failed') throw reviveWorkerError(message)
          if (message.type !== 'event') throw new Error(`7z read worker sent an unexpected ${message.type} reply`)
          yield message.event
        }
      } finally {
        signal?.removeEventListener('abort', cancel)
        cancel()
      }
    })()
    return readableFromGenerator(generator)
  }

  openEntry(id: number, options: OpenEntryOptions = {}): ReadableStream<Uint8Array> {
    const events = this.openEntries([id], options)
    const generator = (async function* (): AsyncGenerator<Uint8Array> {
      const reader = events.getReader()
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) return
          if (item.value.type === 'data') yield item.value.bytes
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    })()
    return readableFromGenerator(generator)
  }

  async close(): Promise<void> {
    this.session.post({ type: 'close' })
    await this.session.terminate()
  }
}

// Vitest executes source modules directly and cannot launch the bundled JS
// worker. Electron builds always place the dedicated entry beside main.
async function spawnReadWorker(): Promise<Worker | null> {
  if (!process.versions.electron) return null
  const workerPath = path.resolve(__dirname, '../worker/sevenZipReadWorker.js')
  const exists = await fsPromises.stat(workerPath).then(stat => stat.isFile(), () => false)
  if (!exists) return null
  try {
    return new Worker(workerPath)
  } catch {
    return null
  }
}

/** Returns null when no worker is available, leaving the caller to read inline. */
export async function openLibera7zFileInWorker(
  archivePath: string,
  options: { maxEntries?: number; password?: string; signal?: AbortSignal } = {}
): Promise<SevenZipReader | null> {
  const worker = await spawnReadWorker()
  if (!worker) return null
  const session = new ReadWorkerSession(worker)
  try {
    const cancel = (): void => session.post({ type: 'cancel', streamId: OPEN_STREAM_ID })
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const reply = await session.request(OPEN_STREAM_ID, {
        type: 'open',
        archivePath,
        maxEntries: options.maxEntries,
        password: options.password
      })
      if (options.signal?.aborted) throw new Libera7zError('CANCELLED', '7z operation was cancelled')
      if (reply.type === 'failed') throw reviveWorkerError(reply)
      if (reply.type !== 'opened') throw new Error(`7z read worker sent an unexpected ${reply.type} reply`)
      return new WorkerSevenZipArchive(session, reply.entries, reply.metadata)
    } finally {
      options.signal?.removeEventListener('abort', cancel)
    }
  } catch (error) {
    await session.terminate().catch(() => undefined)
    throw error
  }
}

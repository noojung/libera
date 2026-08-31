import { Libera7zError, throwIfCancelled } from '../errors.js'
import type {
  CreateSevenZipOptions,
  OpenEntryOptions,
  OpenSevenZipOptions,
  SevenZipArchiveMetadata,
  SevenZipEntry,
  SevenZipEntryEvent,
  SevenZipEntryInput,
  SevenZipReader
} from '../format.js'
import { readableFromGenerator, type RandomAccessSource, type SeekableSink } from '../io.js'
import { spawnConfiguredWorker, type WorkerLike } from './config.js'
import {
  ROOT_STREAM_ID,
  reviveFailure,
  serializeFailure,
  type SerializedEntryInput,
  type WorkerIoCall,
  type WorkerReply,
  type WorkerRequest
} from './protocol.js'

/** Owns one worker: routes its replies, and serves the I/O it asks for. */
class WorkerSession {
  private readonly waiting = new Map<number, { resolve: (reply: WorkerReply) => void; reject: (error: unknown) => void }>()
  private readonly entryReaders = new Map<number, ReadableStreamDefaultReader<Uint8Array>>()
  private failure: Error | null = null

  constructor(
    private readonly worker: WorkerLike,
    private readonly io: { source?: RandomAccessSource; sink?: SeekableSink; entries?: readonly SevenZipEntryInput[] }
  ) {
    worker.addMessageListener((reply: WorkerReply) => {
      if (reply.kind === 'io') {
        void this.serve(reply.callId, reply.call)
        return
      }
      if (reply.kind === 'progress') {
        this.onProgress?.(reply.processedBytes, reply.currentFile)
        return
      }
      const waiter = this.waiting.get(reply.streamId)
      if (!waiter) return
      this.waiting.delete(reply.streamId)
      waiter.resolve(reply)
    })
    worker.addErrorListener(error => this.failAll(error instanceof Error ? error : new Error(String(error))))
  }

  onProgress?: CreateSevenZipOptions['onProgress']

  private failAll(error: Error): void {
    this.failure = error
    for (const waiter of this.waiting.values()) waiter.reject(error)
    this.waiting.clear()
  }

  private async serve(callId: number, call: WorkerIoCall): Promise<void> {
    try {
      if (call.target === 'source') {
        const bytes = await this.io.source!.read(call.offset, call.length)
        this.post({ kind: 'io-ok', callId, bytes })
        return
      }
      if (call.target === 'sink') {
        if (call.method === 'write') await this.io.sink!.write(call.bytes)
        else await this.io.sink!.writeAt(call.offset, call.bytes)
        this.post({ kind: 'io-ok', callId })
        return
      }
      if (call.method === 'cancel') {
        await this.entryReaders.get(call.index)?.cancel().catch(() => undefined)
        this.entryReaders.delete(call.index)
        this.post({ kind: 'io-ok', callId, done: true })
        return
      }
      let reader = this.entryReaders.get(call.index)
      if (!reader) {
        reader = this.io.entries![call.index].open!().getReader()
        this.entryReaders.set(call.index, reader)
      }
      const item = await reader.read()
      if (item.done) {
        this.entryReaders.delete(call.index)
        this.post({ kind: 'io-ok', callId, done: true })
      } else {
        this.post({ kind: 'io-ok', callId, bytes: item.value })
      }
    } catch (error) {
      this.post({ kind: 'io-failed', callId, failure: serializeFailure(error) })
    }
  }

  post(request: WorkerRequest): void {
    if (!this.failure) this.worker.postMessage(request)
  }

  /** Sends a request and waits for the single reply owed to that stream. */
  request(streamId: number, request: WorkerRequest): Promise<WorkerReply> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiting.set(streamId, { resolve, reject })
      this.worker.postMessage(request)
    })
  }

  async dispose(): Promise<void> {
    for (const reader of this.entryReaders.values()) await reader.cancel().catch(() => undefined)
    this.entryReaders.clear()
    await this.worker.terminate()
  }
}

class WorkerArchive implements SevenZipReader {
  private nextStreamId = ROOT_STREAM_ID + 1

  constructor(
    private readonly session: WorkerSession,
    readonly entries: readonly SevenZipEntry[],
    readonly metadata: SevenZipArchiveMetadata
  ) {}

  openEntries(ids: readonly number[], options: OpenEntryOptions = {}): ReadableStream<SevenZipEntryEvent> {
    const streamId = this.nextStreamId++
    const session = this.session
    const signal = options.signal
    const generator = (async function* (): AsyncGenerator<SevenZipEntryEvent> {
      const cancel = (): void => session.post({ kind: 'cancel', streamId })
      signal?.addEventListener('abort', cancel, { once: true })
      session.post({ kind: 'read', streamId, entryIds: [...ids] })
      if (signal?.aborted) cancel()
      try {
        while (true) {
          // The worker drops a cancelled stream, so its reply can be a clean
          // end. The signal is what the caller sees, as when reading in process.
          throwIfCancelled(signal)
          const reply = await session.request(streamId, { kind: 'pull', streamId })
          throwIfCancelled(signal)
          if (reply.kind === 'read-end') return
          if (reply.kind === 'failed') throw reviveFailure(reply.failure)
          if (reply.kind !== 'event') throw new Error(`7z worker sent an unexpected ${reply.kind} reply`)
          yield reply.event
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
    this.session.post({ kind: 'close' })
    await this.session.dispose()
  }
}

function watchRootCancellation(session: WorkerSession, signal: AbortSignal | undefined): () => void {
  const cancel = (): void => session.post({ kind: 'cancel', streamId: ROOT_STREAM_ID })
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  return () => signal?.removeEventListener('abort', cancel)
}

/** Null when no worker is configured, leaving the caller to read in process. */
export async function openArchiveInWorker(
  source: RandomAccessSource,
  options: OpenSevenZipOptions
): Promise<SevenZipReader | null> {
  const worker = spawnConfiguredWorker()
  if (!worker) return null
  const session = new WorkerSession(worker, { source })
  const stopWatching = watchRootCancellation(session, options.signal)
  try {
    const reply = await session.request(ROOT_STREAM_ID, {
      kind: 'open',
      sourceSize: source.size,
      options: {
        maxEntries: options.maxEntries,
        maxHeaderBytes: options.maxHeaderBytes,
        maxDictionaryBytes: options.maxDictionaryBytes,
        password: options.password
      }
    })
    if (reply.kind === 'failed') throw reviveFailure(reply.failure)
    if (reply.kind !== 'opened') throw new Error(`7z worker sent an unexpected ${reply.kind} reply`)
    return new WorkerArchive(session, reply.entries, reply.metadata)
  } catch (error) {
    await session.dispose().catch(() => undefined)
    throw error
  } finally {
    stopWatching()
  }
}

/** Null when no worker is configured, leaving the caller to write in process. */
export async function createArchiveInWorker(
  entries: readonly SevenZipEntryInput[],
  sink: SeekableSink,
  options: CreateSevenZipOptions
): Promise<{ size: bigint; headerSize: number } | null> {
  const worker = spawnConfiguredWorker()
  if (!worker) return null
  const session = new WorkerSession(worker, { sink, entries })
  session.onProgress = options.onProgress
  const stopWatching = watchRootCancellation(session, options.signal)
  try {
    const serialized: SerializedEntryInput[] = entries.map(entry => ({
      path: entry.path,
      size: entry.size,
      isDirectory: entry.isDirectory,
      modified: entry.modified,
      mode: entry.mode,
      isSymlink: entry.isSymlink,
      hasContent: entry.open !== undefined
    }))
    const reply = await session.request(ROOT_STREAM_ID, {
      kind: 'create',
      entries: serialized,
      options: {
        method: options.method,
        dictionarySize: options.dictionarySize,
        solid: options.solid,
        lzmaEncoder: options.lzmaEncoder,
        password: options.password,
        encryptHeader: options.encryptHeader
      }
    })
    if (reply.kind === 'failed') throw reviveFailure(reply.failure)
    if (reply.kind !== 'created') throw new Error(`7z worker sent an unexpected ${reply.kind} reply`)
    return { size: reply.size, headerSize: reply.headerSize }
  } finally {
    stopWatching()
    await session.dispose().catch(() => undefined)
  }
}

export { Libera7zError }

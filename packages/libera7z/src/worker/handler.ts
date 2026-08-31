import { Libera7zError } from '../errors'
import { create7zInProcess, open7zInProcess, type SevenZipEntryEvent, type SevenZipEntryInput, type SevenZipReader } from '../format'
import type { RandomAccessSource, SeekableSink } from '../io'
import {
  ROOT_STREAM_ID,
  reviveFailure,
  serializeFailure,
  type SerializedEntryInput,
  type WorkerIoCall,
  type WorkerReply,
  type WorkerRequest
} from './protocol'

/** The port the handler talks over, narrowed so it fits both worker flavours. */
export interface WorkerPort {
  postMessage(message: unknown, transfer?: unknown[]): void
  addMessageListener(listener: (message: WorkerRequest) => void): void
}

interface ReadStream {
  entryIds: number[]
  controller: AbortController
  reader?: ReadableStreamDefaultReader<SevenZipEntryEvent>
}

export function installWorkerHandler(port: WorkerPort): void {
  const post = (reply: WorkerReply): void => port.postMessage(reply)
  const pendingIo = new Map<number, { resolve: (value: { bytes?: Uint8Array; done?: boolean }) => void; reject: (error: unknown) => void }>()
  let nextCallId = 1
  let archive: SevenZipReader | null = null
  const rootController = new AbortController()
  const streams = new Map<number, ReadStream>()

  /** Every proxied call is one round trip, so the caller keeps its ordinary
   * async source and sink and the worker keeps all the decoding. */
  const call = (request: WorkerIoCall): Promise<{ bytes?: Uint8Array; done?: boolean }> => {
    const callId = nextCallId++
    return new Promise((resolve, reject) => {
      pendingIo.set(callId, { resolve, reject })
      post({ kind: 'io', callId, call: request })
    })
  }

  const proxySource = (size: bigint): RandomAccessSource => ({
    size,
    read: async (offset, length) => (await call({ target: 'source', method: 'read', offset, length })).bytes!
  })

  const proxySink = (): SeekableSink => {
    // A sink's position is just the bytes appended so far, so the worker can
    // track it instead of making the getter a round trip.
    let position = 0n
    return {
      get position() {
        return position
      },
      write: async bytes => {
        position += BigInt(bytes.length)
        await call({ target: 'sink', method: 'write', bytes })
      },
      writeAt: async (offset, bytes) => {
        await call({ target: 'sink', method: 'writeAt', offset, bytes })
      },
      close: async () => undefined
    }
  }

  const proxyEntries = (entries: SerializedEntryInput[]): SevenZipEntryInput[] =>
    entries.map((entry, index) => ({
      path: entry.path,
      size: entry.size,
      isDirectory: entry.isDirectory,
      modified: entry.modified,
      mode: entry.mode,
      isSymlink: entry.isSymlink,
      open: entry.hasContent
        ? () => new ReadableStream<Uint8Array>({
          async pull(controller) {
            const item = await call({ target: 'entry', method: 'pull', index })
            if (item.done) controller.close()
            else controller.enqueue(item.bytes!)
          },
          cancel: () => void call({ target: 'entry', method: 'cancel', index })
        })
        : undefined
    }))

  const closeStream = async (streamId: number): Promise<void> => {
    const stream = streams.get(streamId)
    if (!stream) return
    streams.delete(streamId)
    stream.controller.abort()
    await stream.reader?.cancel().catch(() => undefined)
  }

  const handle = async (request: WorkerRequest): Promise<void> => {
    if (request.kind === 'io-ok') {
      const waiter = pendingIo.get(request.callId)
      pendingIo.delete(request.callId)
      waiter?.resolve({ bytes: request.bytes, done: request.done })
      return
    }
    if (request.kind === 'io-failed') {
      const waiter = pendingIo.get(request.callId)
      pendingIo.delete(request.callId)
      waiter?.reject(reviveFailure(request.failure))
      return
    }
    if (request.kind === 'open') {
      try {
        archive = await open7zInProcess(proxySource(request.sourceSize), {
          ...request.options,
          signal: rootController.signal
        })
        post({ kind: 'opened', streamId: ROOT_STREAM_ID, entries: [...archive.entries], metadata: archive.metadata })
      } catch (error) {
        post({ kind: 'failed', streamId: ROOT_STREAM_ID, failure: serializeFailure(error) })
      }
      return
    }
    if (request.kind === 'create') {
      try {
        const summary = await create7zInProcess(proxyEntries(request.entries), proxySink(), {
          ...request.options,
          signal: rootController.signal,
          onProgress: (processedBytes, currentFile) => post({ kind: 'progress', processedBytes, currentFile })
        })
        post({ kind: 'created', streamId: ROOT_STREAM_ID, ...summary })
      } catch (error) {
        post({ kind: 'failed', streamId: ROOT_STREAM_ID, failure: serializeFailure(error) })
      }
      return
    }
    if (request.kind === 'read') {
      streams.set(request.streamId, { entryIds: request.entryIds, controller: new AbortController() })
      return
    }
    if (request.kind === 'cancel') {
      if (request.streamId === ROOT_STREAM_ID) rootController.abort()
      await closeStream(request.streamId)
      return
    }
    if (request.kind === 'close') {
      for (const streamId of [...streams.keys()]) await closeStream(streamId)
      await archive?.close().catch(() => undefined)
      archive = null
      for (const waiter of pendingIo.values()) {
        waiter.reject(new Libera7zError('CANCELLED', '7z operation was cancelled'))
      }
      pendingIo.clear()
      return
    }
    const stream = streams.get(request.streamId)
    if (!stream) {
      post({ kind: 'read-end', streamId: request.streamId })
      return
    }
    try {
      if (!archive) throw new Error('7z worker has no open archive')
      // Opening on the first pull keeps a rejected entry id on the stream that
      // asked for it rather than on whatever message came next.
      stream.reader ??= archive.openEntries(stream.entryIds, { signal: stream.controller.signal }).getReader()
      const item = await stream.reader.read()
      if (item.done) {
        streams.delete(request.streamId)
        post({ kind: 'read-end', streamId: request.streamId })
      } else {
        post({ kind: 'event', streamId: request.streamId, event: item.value })
      }
    } catch (error) {
      await closeStream(request.streamId)
      post({ kind: 'failed', streamId: request.streamId, failure: serializeFailure(error) })
    }
  }

  port.addMessageListener(request => void handle(request))
}

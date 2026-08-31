import { isMainThread, parentPort, type MessagePort } from 'worker_threads'
import type { SevenZipEntryEvent, SevenZipReader } from 'libera7z'
import { openLibera7zFileInline } from './node'
import { serializeWorkerError } from './workerMessages'
import type { ReadWorkerMessage, ReadWorkerRequest } from './readWorkerClient'

interface ReadStream {
  entryIds: number[]
  controller: AbortController
  reader?: ReadableStreamDefaultReader<SevenZipEntryEvent>
}

// Worker entry only: the archive is decoded here end to end, so LZMA2, PPMd,
// BZip2, BCJ2 and AES all stay off the Electron main thread. Requests are
// handled one at a time; the client never has more than one in flight.
function installReadWorker(port: MessagePort): void {
  let archive: SevenZipReader | null = null
  const openController = new AbortController()
  const streams = new Map<number, ReadStream>()
  const post = (message: ReadWorkerMessage): void => port.postMessage(message)

  const closeStream = async (streamId: number): Promise<void> => {
    const stream = streams.get(streamId)
    if (!stream) return
    streams.delete(streamId)
    stream.controller.abort()
    await stream.reader?.cancel().catch(() => undefined)
  }

  const handle = async (request: ReadWorkerRequest): Promise<void> => {
    if (request.type === 'open') {
      try {
        archive = await openLibera7zFileInline(request.archivePath, {
          signal: openController.signal,
          maxEntries: request.maxEntries,
          password: request.password
        })
        post({ type: 'opened', streamId: 0, entries: [...archive.entries], metadata: archive.metadata })
      } catch (error) {
        post({ type: 'failed', streamId: 0, ...serializeWorkerError(error) })
      }
      return
    }
    if (request.type === 'read') {
      streams.set(request.streamId, { entryIds: request.entryIds, controller: new AbortController() })
      return
    }
    if (request.type === 'cancel') {
      if (request.streamId === 0) openController.abort()
      await closeStream(request.streamId)
      return
    }
    if (request.type === 'close') {
      for (const streamId of [...streams.keys()]) await closeStream(streamId)
      await archive?.close().catch(() => undefined)
      archive = null
      return
    }
    const stream = streams.get(request.streamId)
    if (!stream) {
      post({ type: 'read-end', streamId: request.streamId })
      return
    }
    try {
      if (!archive) throw new Error('7z read worker has no open archive')
      // Opening is deferred to the first pull so a rejected entry id is
      // reported on the stream that asked for it.
      stream.reader ??= archive.openEntries(stream.entryIds, { signal: stream.controller.signal }).getReader()
      const item = await stream.reader.read()
      if (item.done) {
        streams.delete(request.streamId)
        post({ type: 'read-end', streamId: request.streamId })
      } else {
        post({ type: 'event', streamId: request.streamId, event: item.value })
      }
    } catch (error) {
      await closeStream(request.streamId)
      post({ type: 'failed', streamId: request.streamId, ...serializeWorkerError(error) })
    }
  }

  port.on('message', (request: ReadWorkerRequest) => void handle(request))
}

if (!isMainThread && parentPort) installReadWorker(parentPort)

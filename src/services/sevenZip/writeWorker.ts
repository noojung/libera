import { isMainThread, parentPort, type MessagePort } from 'worker_threads'
import { Libera7zError } from '../../lib/libera7z'
import { writeLibera7zInline } from './node'
import type { WriteWorkerMessage, WriteWorkerRequest } from './writeWorkerClient'

// Worker entry only: the archive is built here end to end, so the LZMA2 codec,
// the header encoding and the file I/O all stay off the Electron main thread.
function installWriteWorker(port: MessagePort): void {
  const controller = new AbortController()
  const post = (message: WriteWorkerMessage): void => port.postMessage(message)

  port.on('message', (request: WriteWorkerRequest) => {
    if (request.type === 'cancel') {
      controller.abort()
      return
    }
    void writeLibera7zInline({
      ...request.options,
      signal: controller.signal,
      onProgress: (processedBytes, currentFile) => post({ type: 'progress', processedBytes, currentFile })
    }).then(
      result => post({ type: 'done', result }),
      (error: unknown) => post({
        type: 'failed',
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof Libera7zError ? error.code : undefined
      })
    )
  })
}

if (!isMainThread && parentPort) installWriteWorker(parentPort)

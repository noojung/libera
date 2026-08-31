// Importing this module teaches the package how to start a worker under Node,
// which the root entry deliberately does not know how to do. Browsers need
// nothing: the global Worker is used instead.
import { Worker } from 'worker_threads'
import { setDefaultWorkerFactory, type WorkerLike } from './worker/config.js'
import type { WorkerReply } from './worker/protocol.js'

setDefaultWorkerFactory((script): WorkerLike => {
  const worker = new Worker(script)
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer as never),
    terminate: () => worker.terminate(),
    addMessageListener: listener => void worker.on('message', (message: WorkerReply) => listener(message)),
    addErrorListener: listener => void worker.on('error', listener)
  }
})

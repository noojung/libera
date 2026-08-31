// The bundled worker this package ships as `libera7z/dist/worker.js`. It runs
// under both worker flavours: a browser worker talks through the global scope,
// a Node worker through its parent port.
import { installWorkerHandler, type WorkerPort } from './handler'

interface BrowserWorkerScope {
  postMessage(message: unknown, transfer?: unknown[]): void
  addEventListener(type: string, listener: (event: { data: never }) => void): void
}

function browserPort(): WorkerPort | null {
  const scope = globalThis as Partial<BrowserWorkerScope> & { importScripts?: unknown; document?: unknown }
  if (typeof scope.postMessage !== 'function' || typeof scope.addEventListener !== 'function') return null
  if (scope.document !== undefined) return null
  return {
    postMessage: (message, transfer) => (scope as BrowserWorkerScope).postMessage(message, transfer),
    addMessageListener: listener =>
      (scope as BrowserWorkerScope).addEventListener('message', event => listener(event.data))
  }
}

export async function installSevenZipWorker(): Promise<boolean> {
  const port = browserPort()
  if (port) {
    installWorkerHandler(port)
    return true
  }
  // Not a browser worker, so try Node's. The specifier is built at run time so
  // a browser bundler never tries to resolve it.
  const moduleName = ['worker', 'threads'].join('_')
  try {
    const threads = await import(/* @vite-ignore */ moduleName) as {
      isMainThread: boolean
      parentPort: {
        postMessage(message: unknown, transfer?: unknown[]): void
        on(event: 'message', listener: (message: never) => void): void
      } | null
    }
    if (threads.isMainThread || !threads.parentPort) return false
    const parentPort = threads.parentPort
    installWorkerHandler({
      postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
      addMessageListener: listener => parentPort.on('message', listener)
    })
    return true
  } catch {
    return false
  }
}

void installSevenZipWorker()

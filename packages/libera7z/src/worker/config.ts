import type { WorkerReply } from './protocol'

/** The slice of a Worker this package uses, so a Node worker_threads worker and
 * a browser Worker can both stand in without the package importing either. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: unknown[]): void
  terminate(): void | Promise<unknown>
  addMessageListener(listener: (message: WorkerReply) => void): void
  addErrorListener(listener: (error: unknown) => void): void
}

export type WorkerFactory = (script: string | URL) => WorkerLike

export interface Libera7zConfiguration {
  /** Set false to keep every operation on the calling thread. Defaults to true
   * once a worker script is configured. */
  useWorkers?: boolean
  /** Location of this package's worker bundle, `libera7z/dist/worker.js`. */
  workerScript?: string | URL
  /** Creates a worker from `workerScript`. Browsers get a default; Node needs
   * this, which importing `libera7z/node` registers for you. */
  createWorker?: WorkerFactory
}

const state: Libera7zConfiguration = {}

export function configure(options: Libera7zConfiguration): void {
  Object.assign(state, options)
}

/** Registered by `libera7z/node`; a browser falls back to the global Worker. */
export function setDefaultWorkerFactory(factory: WorkerFactory): void {
  state.createWorker ??= factory
}

function browserWorkerFactory(): WorkerFactory | undefined {
  const constructor = (globalThis as { Worker?: new (url: string | URL, options?: object) => unknown }).Worker
  if (!constructor) return undefined
  return script => {
    const worker = new constructor(script, { type: 'module' }) as {
      postMessage: (message: unknown, transfer?: unknown[]) => void
      terminate: () => void
      addEventListener: (type: string, listener: (event: { data: WorkerReply }) => void) => void
    }
    return {
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      terminate: () => worker.terminate(),
      addMessageListener: listener =>
        worker.addEventListener('message', (event: { data: WorkerReply }) => listener(event.data)),
      addErrorListener: listener => worker.addEventListener('error', listener)
    }
  }
}

/** Null when workers are switched off or nothing has been configured. */
export function spawnConfiguredWorker(): WorkerLike | null {
  if (state.useWorkers === false || !state.workerScript) return null
  const factory = state.createWorker ?? browserWorkerFactory()
  if (!factory) return null
  try {
    return factory(state.workerScript)
  } catch {
    return null
  }
}

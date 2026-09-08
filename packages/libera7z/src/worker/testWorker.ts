import { configure, type WorkerLike } from './config.js'
import { installWorkerHandler } from './handler.js'
import type { WorkerReply, WorkerRequest } from './protocol.js'

/**
 * A worker that runs the real handler on the calling thread.
 *
 * Every message still goes through `structuredClone`, which is what a real
 * worker does to it, so anything that cannot survive the crossing - a class
 * instance, a function, a stream - fails here exactly as it would there. The
 * two sides stay decoupled by delivering on a later microtask, so neither ever
 * sees the other's stack.
 */
export interface FakeWorker {
  /** Messages the client sent, in order, as the handler received them. */
  readonly requests: WorkerRequest[]
  /** Replies the handler sent back, in order. */
  readonly replies: WorkerReply[]
  readonly terminations: number
  /** Reports an error to the client the way a worker that crashed would. */
  fail(error: unknown): void
}

/**
 * Points the package at a fake worker and hands it back. Every `create7z` or
 * `open7z` from here on runs through the worker path rather than in process.
 */
export function useFakeWorker(): FakeWorker {
  const requests: WorkerRequest[] = []
  const replies: WorkerReply[] = []
  let terminations = 0
  let alive = true
  let toClient: ((reply: WorkerReply) => void) | null = null
  let onError: ((error: unknown) => void) | null = null
  let toHandler: ((request: WorkerRequest) => void) | null = null

  // A terminated worker delivers nothing, which is what lets the client's
  // dispose stop the traffic rather than merely stop listening to it.
  const deliver = (send: () => void): void => queueMicrotask(() => { if (alive) send() })

  installWorkerHandler({
    postMessage: message => {
      const reply = structuredClone(message) as WorkerReply
      replies.push(reply)
      deliver(() => toClient?.(reply))
    },
    addMessageListener: listener => { toHandler = listener }
  })

  const worker: WorkerLike = {
    postMessage: message => {
      const request = structuredClone(message) as WorkerRequest
      requests.push(request)
      deliver(() => toHandler?.(request))
    },
    terminate: () => { terminations += 1; alive = false },
    addMessageListener: listener => { toClient = listener },
    addErrorListener: listener => { onError = listener }
  }

  configure({ useWorkers: true, workerScript: 'fake://worker', createWorker: () => worker })

  return {
    requests,
    replies,
    get terminations() { return terminations },
    fail: error => onError?.(error)
  }
}

/** Puts the package back on the calling thread. */
export function stopFakeWorker(): void {
  configure({ useWorkers: false, workerScript: undefined, createWorker: undefined })
}

import { Libera7zError, type Libera7zErrorCode } from '../../lib/libera7z'

/** Libera7z codes carry the caller-visible meaning, so they cross the boundary. */
export interface WorkerFailure {
  message: string
  code?: Libera7zErrorCode
}

export function serializeWorkerError(error: unknown): WorkerFailure {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: error instanceof Libera7zError ? error.code : undefined
  }
}

export function reviveWorkerError(failure: WorkerFailure): Error {
  return failure.code ? new Libera7zError(failure.code, failure.message) : new Error(failure.message)
}

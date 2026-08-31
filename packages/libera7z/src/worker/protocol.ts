import { Libera7zError, type Libera7zErrorCode } from '../errors.js'
import type { SevenZipArchiveMetadata, SevenZipEntry, SevenZipEntryEvent, SevenZipMethod } from '../format.js'
import type { LzmaEncoderOptions } from '../lzma.js'

// The worker owns the whole read or write, but a source, a sink and an entry's
// content stream are objects with methods, so they cannot be cloned across the
// boundary. They stay on the calling thread and the worker calls back into them
// through the `io` messages below.

export interface WorkerFailure {
  message: string
  code?: Libera7zErrorCode
}

export function serializeFailure(error: unknown): WorkerFailure {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: error instanceof Libera7zError ? error.code : undefined
  }
}

export function reviveFailure(failure: WorkerFailure): Error {
  return failure.code ? new Libera7zError(failure.code, failure.message) : new Error(failure.message)
}

/** An entry input minus its `open()`, which is proxied by index instead. */
export interface SerializedEntryInput {
  path: string
  size: bigint
  isDirectory?: boolean
  modified?: Date
  mode?: number
  isSymlink?: boolean
  hasContent: boolean
}

export interface SerializedCreateOptions {
  method?: SevenZipMethod
  dictionarySize?: number
  solid?: boolean
  lzmaEncoder?: LzmaEncoderOptions
  password?: string
  encryptHeader?: boolean
}

export interface SerializedOpenOptions {
  maxEntries?: number
  maxHeaderBytes?: number
  maxDictionaryBytes?: number
  password?: string
}

/** What the worker asks the calling thread to do on its behalf. */
export type WorkerIoCall =
  | { target: 'source'; method: 'read'; offset: bigint; length: number }
  | { target: 'sink'; method: 'write'; bytes: Uint8Array }
  | { target: 'sink'; method: 'writeAt'; offset: bigint; bytes: Uint8Array }
  | { target: 'entry'; method: 'pull'; index: number }
  | { target: 'entry'; method: 'cancel'; index: number }

export type WorkerRequest =
  | { kind: 'open'; sourceSize: bigint; options: SerializedOpenOptions }
  | { kind: 'create'; entries: SerializedEntryInput[]; options: SerializedCreateOptions }
  | { kind: 'read'; streamId: number; entryIds: number[] }
  | { kind: 'pull'; streamId: number }
  | { kind: 'cancel'; streamId: number }
  | { kind: 'close' }
  | { kind: 'io-ok'; callId: number; bytes?: Uint8Array; done?: boolean }
  | { kind: 'io-failed'; callId: number; failure: WorkerFailure }

export type WorkerReply =
  | { kind: 'opened'; streamId: number; entries: SevenZipEntry[]; metadata: SevenZipArchiveMetadata }
  | { kind: 'created'; streamId: number; size: bigint; headerSize: number }
  | { kind: 'progress'; processedBytes: bigint; currentFile?: string }
  | { kind: 'event'; streamId: number; event: SevenZipEntryEvent }
  | { kind: 'read-end'; streamId: number }
  | { kind: 'failed'; streamId: number; failure: WorkerFailure }
  | { kind: 'io'; callId: number; call: WorkerIoCall }

/** Reserved for the open/create request that starts a worker's life. */
export const ROOT_STREAM_ID = 0

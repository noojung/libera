import {
  create7zInProcess,
  open7zInProcess,
  type CreateSevenZipOptions,
  type OpenSevenZipOptions,
  type SevenZipEntryInput,
  type SevenZipReader
} from './format.js'
import type { RandomAccessSource, SeekableSink } from './io.js'
import { createArchiveInWorker, openArchiveInWorker } from './worker/client.js'

// The public entry points. They run on a worker once one is configured, and on
// the calling thread otherwise, so callers never change with the setting.

export async function create7z(
  entries: readonly SevenZipEntryInput[],
  sink: SeekableSink,
  options: CreateSevenZipOptions = {}
): Promise<{ size: bigint; headerSize: number }> {
  return await createArchiveInWorker(entries, sink, options) ?? await create7zInProcess(entries, sink, options)
}

export async function open7z(
  source: RandomAccessSource,
  options: OpenSevenZipOptions = {}
): Promise<SevenZipReader> {
  return await openArchiveInWorker(source, options) ?? await open7zInProcess(source, options)
}

import { promises as fsPromises } from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import { Libera7zError, type Libera7zErrorCode } from '../../lib/libera7z'
import type { WriteLibera7zOptions, WriteLibera7zResult } from './node'

// The whole write runs inside the worker, so the protocol is one request, a
// stream of progress notices, and one terminal reply. Cancellation stays
// cooperative: the worker aborts between chunks and still cleans up its
// partial output before reporting back.
export type WriteWorkerRequest =
  | { type: 'write'; options: Omit<WriteLibera7zOptions, 'signal' | 'onProgress'> }
  | { type: 'cancel' }

export type WriteWorkerMessage =
  | { type: 'progress'; processedBytes: bigint; currentFile?: string }
  | { type: 'done'; result: WriteLibera7zResult }
  | { type: 'failed'; message: string; code?: Libera7zErrorCode }

// Vitest executes source modules directly and cannot launch the bundled JS
// worker. Electron builds always place the dedicated entry beside main.
async function spawnWriteWorker(): Promise<Worker | null> {
  if (!process.versions.electron) return null
  const workerPath = path.resolve(__dirname, '../worker/sevenZipWriteWorker.js')
  const exists = await fsPromises.stat(workerPath).then(stat => stat.isFile(), () => false)
  if (!exists) return null
  try {
    return new Worker(workerPath)
  } catch {
    return null
  }
}

/** Returns null when no worker is available, leaving the caller to write inline. */
export async function runLibera7zWriteInWorker(
  options: WriteLibera7zOptions
): Promise<WriteLibera7zResult | null> {
  const worker = await spawnWriteWorker()
  if (!worker) return null
  const { signal, onProgress, ...request } = options
  try {
    return await new Promise<WriteLibera7zResult>((resolve, reject) => {
      const cancel = (): void => worker.postMessage({ type: 'cancel' } satisfies WriteWorkerRequest)
      signal?.addEventListener('abort', cancel, { once: true })
      const settle = (finish: () => void): void => {
        signal?.removeEventListener('abort', cancel)
        finish()
      }
      worker.on('message', (message: WriteWorkerMessage) => {
        if (message.type === 'progress') onProgress?.(message.processedBytes, message.currentFile)
        else if (message.type === 'done') settle(() => resolve(message.result))
        else settle(() => reject(message.code
          ? new Libera7zError(message.code, message.message)
          : new Error(message.message)))
      })
      worker.on('error', error => settle(() => reject(error)))
      worker.on('exit', code => settle(() => reject(new Error(`7z write worker exited with code ${code}`))))
      worker.postMessage({ type: 'write', options: request } satisfies WriteWorkerRequest)
      if (signal?.aborted) cancel()
    })
  } finally {
    await worker.terminate()
  }
}

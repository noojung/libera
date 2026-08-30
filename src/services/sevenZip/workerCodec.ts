import { promises as fsPromises } from 'fs'
import path from 'path'
import { isMainThread, parentPort, Worker, type MessagePort } from 'worker_threads'
import { Libera7zError, type Lzma2DecoderSession } from '../../lib/libera7z'
import { LzmaDecoder, type LzmaEncoderOptions } from '../../lib/libera7z/lzma'
import { decodeLzma2, dictionarySizeFromProperty, encodeLzma2Block } from '../../lib/libera7z/lzma2'

// This module is both the main-thread client and the worker entry point: the
// bundled copy in dist/worker is built from this same file, so the request
// protocol below only has to be described once.
interface CodecRequest {
  id: number
  type: 'encode' | 'decode-all' | 'decoder-init' | 'decoder-reset-dictionary' |
    'decoder-set-properties' | 'decoder-reset-state' | 'decoder-write-uncompressed' | 'decoder-chunk'
  bytes?: ArrayBuffer
  options?: LzmaEncoderOptions
  dictionaryProperty?: number
  property?: number
  outputSize?: number
}

interface WorkerReply {
  id: number
  bytes?: ArrayBuffer
  compressed?: boolean
  error?: string
  ok?: boolean
}

interface PendingRequest {
  resolve: (value: { data: Uint8Array; compressed: boolean }) => void
  reject: (error: unknown) => void
  detachAbort: () => void
}

export class Libera7zWorkerCodec {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private failed: Error | null = null

  private constructor(
    private readonly worker: Worker,
    private readonly options: LzmaEncoderOptions
  ) {
    worker.on('message', (reply: WorkerReply) => {
      const request = this.pending.get(reply.id)
      if (!request) return
      this.pending.delete(reply.id)
      request.detachAbort()
      if (reply.error || !reply.bytes) request.reject(new Error(reply.error ?? '7z codec worker returned no data'))
      else request.resolve({ data: new Uint8Array(reply.bytes), compressed: reply.compressed === true })
    })
    worker.on('error', error => this.rejectAll(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => {
      if (code !== 0 && this.pending.size > 0) this.rejectAll(new Error(`7z codec worker exited with code ${code}`))
    })
  }

  static async create(options: LzmaEncoderOptions): Promise<Libera7zWorkerCodec | null> {
    // Vitest executes source modules directly and cannot launch the bundled JS
    // worker. Electron builds always place the dedicated entry beside main.
    if (!process.versions.electron) return null
    const workerPath = path.resolve(__dirname, '../worker/sevenZipCodecWorker.js')
    const exists = await fsPromises.stat(workerPath).then(stat => stat.isFile(), () => false)
    if (!exists) return null
    try {
      return new Libera7zWorkerCodec(new Worker(workerPath), options)
    } catch {
      return null
    }
  }

  private rejectAll(error: Error): void {
    this.failed = error
    for (const request of this.pending.values()) {
      request.detachAbort()
      request.reject(error)
    }
    this.pending.clear()
  }

  encode = (chunk: Uint8Array, signal?: AbortSignal): Promise<{ data: Uint8Array; compressed: boolean }> => {
    if (this.failed) return Promise.reject(this.failed)
    if (signal?.aborted) return Promise.reject(new Libera7zError('CANCELLED', '7z operation was cancelled'))
    const id = this.nextId++
    const bytes = chunk.slice()
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        void this.worker.terminate()
        reject(new Libera7zError('CANCELLED', '7z operation was cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve,
        reject,
        detachAbort: () => signal?.removeEventListener('abort', onAbort)
      })
      this.worker.postMessage({ id, type: 'encode', bytes: bytes.buffer, options: this.options }, [bytes.buffer])
    })
  }

  async close(): Promise<void> {
    if (this.pending.size > 0) this.rejectAll(new Error('7z codec worker closed with pending work'))
    await this.worker.terminate()
  }
}

interface DecoderPending {
  resolve: (value: Uint8Array | undefined) => void
  reject: (error: unknown) => void
  detachAbort: () => void
}

export class Libera7zWorkerDecoder implements Lzma2DecoderSession {
  private nextId = 1
  private readonly pending = new Map<number, DecoderPending>()
  private failed: Error | null = null

  private constructor(private readonly worker: Worker) {
    worker.on('message', (reply: WorkerReply) => {
      const request = this.pending.get(reply.id)
      if (!request) return
      this.pending.delete(reply.id)
      request.detachAbort()
      if (reply.error) request.reject(new Error(reply.error))
      else request.resolve(reply.bytes ? new Uint8Array(reply.bytes) : undefined)
    })
    worker.on('error', error => this.rejectAll(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => {
      if (code !== 0 && this.pending.size > 0) this.rejectAll(new Error(`7z decoder worker exited with code ${code}`))
    })
  }

  private static async spawn(): Promise<Libera7zWorkerDecoder | null> {
    if (!process.versions.electron) return null
    const workerPath = path.resolve(__dirname, '../worker/sevenZipCodecWorker.js')
    const exists = await fsPromises.stat(workerPath).then(stat => stat.isFile(), () => false)
    if (!exists) return null
    try {
      return new Libera7zWorkerDecoder(new Worker(workerPath))
    } catch {
      return null
    }
  }

  static async create(dictionaryProperty: number, signal?: AbortSignal): Promise<Libera7zWorkerDecoder | null> {
    const decoder = await Libera7zWorkerDecoder.spawn()
    if (!decoder) return null
    try {
      await decoder.call('decoder-init', { dictionaryProperty }, signal)
      return decoder
    } catch (error) {
      await decoder.close().catch(() => undefined)
      throw error
    }
  }

  static async decodeAll(
    input: Uint8Array,
    dictionaryProperty: number,
    expectedSize: number,
    signal?: AbortSignal
  ): Promise<Uint8Array | null> {
    const decoder = await Libera7zWorkerDecoder.spawn()
    if (!decoder) return null
    try {
      return (await decoder.call('decode-all', {
        bytes: input,
        dictionaryProperty,
        outputSize: expectedSize
      }, signal))!
    } finally {
      await decoder.close().catch(() => undefined)
    }
  }

  private rejectAll(error: Error): void {
    this.failed = error
    for (const request of this.pending.values()) {
      request.detachAbort()
      request.reject(error)
    }
    this.pending.clear()
  }

  private call(
    type: string,
    values: { bytes?: Uint8Array; dictionaryProperty?: number; property?: number; outputSize?: number } = {},
    signal?: AbortSignal
  ): Promise<Uint8Array | undefined> {
    if (this.failed) return Promise.reject(this.failed)
    if (signal?.aborted) return Promise.reject(new Libera7zError('CANCELLED', '7z operation was cancelled'))
    const id = this.nextId++
    const bytes = values.bytes?.slice()
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        void this.worker.terminate()
        reject(new Libera7zError('CANCELLED', '7z operation was cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve, reject, detachAbort: () => signal?.removeEventListener('abort', onAbort) })
      const request = {
        id,
        type,
        dictionaryProperty: values.dictionaryProperty,
        property: values.property,
        outputSize: values.outputSize,
        bytes: bytes?.buffer
      }
      if (bytes) this.worker.postMessage(request, [bytes.buffer])
      else this.worker.postMessage(request)
    })
  }

  async resetDictionary(): Promise<void> {
    await this.call('decoder-reset-dictionary')
  }

  async setProperties(value: number): Promise<void> {
    await this.call('decoder-set-properties', { property: value })
  }

  async resetState(): Promise<void> {
    await this.call('decoder-reset-state')
  }

  async writeUncompressed(bytes: Uint8Array): Promise<void> {
    await this.call('decoder-write-uncompressed', { bytes })
  }

  async decodeChunk(bytes: Uint8Array, outputSize: number, signal?: AbortSignal): Promise<Uint8Array> {
    return (await this.call('decoder-chunk', { bytes, outputSize }, signal))!
  }

  async close(): Promise<void> {
    if (this.pending.size > 0) this.rejectAll(new Error('7z decoder worker closed with pending work'))
    await this.worker.terminate()
  }
}

function installCodecWorker(port: MessagePort): void {
  let decoder: LzmaDecoder | null = null

  const requireBytes = (request: CodecRequest): Uint8Array => {
    if (!request.bytes) throw new Error(`7z worker request ${request.type} has no bytes`)
    return new Uint8Array(request.bytes)
  }

  const transferResult = (id: number, data: Uint8Array, compressed?: boolean): void => {
    const transferable = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    port.postMessage({ id, bytes: transferable, compressed }, [transferable])
  }

  port.on('message', (request: CodecRequest) => {
    try {
      if (request.type === 'encode') {
        const result = encodeLzma2Block(requireBytes(request), request.options)
        transferResult(request.id, result.data, result.compressed)
        return
      }
      if (request.type === 'decode-all') {
        transferResult(request.id, decodeLzma2(
          requireBytes(request),
          request.dictionaryProperty!,
          request.outputSize
        ))
        return
      }
      if (request.type === 'decoder-init') {
        decoder = new LzmaDecoder(dictionarySizeFromProperty(request.dictionaryProperty!))
      } else {
        if (!decoder) throw new Error('7z decoder worker was not initialized')
        if (request.type === 'decoder-reset-dictionary') decoder.resetDictionary()
        else if (request.type === 'decoder-set-properties') decoder.setProperties(request.property!)
        else if (request.type === 'decoder-reset-state') decoder.resetState()
        else if (request.type === 'decoder-write-uncompressed') decoder.writeUncompressed(requireBytes(request))
        else if (request.type === 'decoder-chunk') {
          transferResult(request.id, decoder.decodeChunk(requireBytes(request), request.outputSize!))
          return
        }
      }
      port.postMessage({ id: request.id, ok: true })
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

if (!isMainThread && parentPort) installCodecWorker(parentPort)

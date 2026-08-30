import { promises as fsPromises } from 'fs'
import path from 'path'
import { Worker, type MessagePort } from 'worker_threads'
import { Libera7zError, type Lzma2DecoderSession } from '../../lib/libera7z'
import { LzmaDecoder } from '../../lib/libera7z/lzma'
import { decodeLzma2, dictionarySizeFromProperty } from '../../lib/libera7z/lzma2'

// The main-thread client and the worker-side handler live together so the
// request protocol below only has to be described once. The bundled entry that
// installs the handler is codecWorker.ts.
interface CodecRequest {
  id: number
  type: 'decode-all' | 'decoder-init' | 'decoder-reset-dictionary' |
    'decoder-set-properties' | 'decoder-reset-state' | 'decoder-write-uncompressed' | 'decoder-chunk'
  bytes?: ArrayBuffer
  dictionaryProperty?: number
  property?: number
  outputSize?: number
}

interface WorkerReply {
  id: number
  bytes?: ArrayBuffer
  error?: string
  ok?: boolean
}

interface PendingRequest {
  resolve: (reply: WorkerReply) => void
  reject: (error: unknown) => void
  detachAbort: () => void
}

interface CallValues {
  bytes?: Uint8Array
  dictionaryProperty?: number
  property?: number
  outputSize?: number
}

// Shared plumbing for both worker clients below: one request/reply map, one
// abort protocol, one place that knows where the bundled worker lives.
class Libera7zWorkerClient {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private failed: Error | null = null

  private constructor(private readonly worker: Worker, private readonly label: string) {
    worker.on('message', (reply: WorkerReply) => {
      const request = this.pending.get(reply.id)
      if (!request) return
      this.pending.delete(reply.id)
      request.detachAbort()
      if (reply.error) request.reject(new Error(reply.error))
      else request.resolve(reply)
    })
    worker.on('error', error => this.rejectAll(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => {
      if (code !== 0 && this.pending.size > 0) this.rejectAll(new Error(`${label} exited with code ${code}`))
    })
  }

  // Vitest executes source modules directly and cannot launch the bundled JS
  // worker. Electron builds always place the dedicated entry beside main.
  static async spawn(label: string): Promise<Libera7zWorkerClient | null> {
    if (!process.versions.electron) return null
    const workerPath = path.resolve(__dirname, '../worker/sevenZipCodecWorker.js')
    const exists = await fsPromises.stat(workerPath).then(stat => stat.isFile(), () => false)
    if (!exists) return null
    try {
      return new Libera7zWorkerClient(new Worker(workerPath), label)
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

  call(type: CodecRequest['type'], values: CallValues = {}, signal?: AbortSignal): Promise<WorkerReply> {
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
      const request: CodecRequest = {
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

  async close(): Promise<void> {
    if (this.pending.size > 0) this.rejectAll(new Error(`${this.label} closed with pending work`))
    await this.worker.terminate()
  }
}

export class Libera7zWorkerDecoder implements Lzma2DecoderSession {
  private constructor(private readonly client: Libera7zWorkerClient) {}

  static async create(dictionaryProperty: number, signal?: AbortSignal): Promise<Libera7zWorkerDecoder | null> {
    const client = await Libera7zWorkerClient.spawn('7z decoder worker')
    if (!client) return null
    const decoder = new Libera7zWorkerDecoder(client)
    try {
      await client.call('decoder-init', { dictionaryProperty }, signal)
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
    const client = await Libera7zWorkerClient.spawn('7z decoder worker')
    if (!client) return null
    try {
      const reply = await client.call('decode-all', {
        bytes: input,
        dictionaryProperty,
        outputSize: expectedSize
      }, signal)
      return new Uint8Array(reply.bytes!)
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  async resetDictionary(): Promise<void> {
    await this.client.call('decoder-reset-dictionary')
  }

  async setProperties(value: number): Promise<void> {
    await this.client.call('decoder-set-properties', { property: value })
  }

  async resetState(): Promise<void> {
    await this.client.call('decoder-reset-state')
  }

  async writeUncompressed(bytes: Uint8Array): Promise<void> {
    await this.client.call('decoder-write-uncompressed', { bytes })
  }

  async decodeChunk(bytes: Uint8Array, outputSize: number, signal?: AbortSignal): Promise<Uint8Array> {
    const reply = await this.client.call('decoder-chunk', { bytes, outputSize }, signal)
    return new Uint8Array(reply.bytes!)
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

export function installCodecWorker(port: MessagePort): void {
  let decoder: LzmaDecoder | null = null

  const requireBytes = (request: CodecRequest): Uint8Array => {
    if (!request.bytes) throw new Error(`7z worker request ${request.type} has no bytes`)
    return new Uint8Array(request.bytes)
  }

  const transferResult = (id: number, data: Uint8Array): void => {
    const transferable = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    port.postMessage({ id, bytes: transferable }, [transferable])
  }

  port.on('message', (request: CodecRequest) => {
    try {
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

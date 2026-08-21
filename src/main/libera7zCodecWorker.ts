import { parentPort } from 'worker_threads'
import {
  decodeLzma2,
  dictionarySizeFromProperty,
  encodeLzma2Block
} from '../lib/libera7z/lzma2'
import type { LzmaEncoderOptions } from '../lib/libera7z/lzma'
import { LzmaDecoder } from '../lib/libera7z/lzma'

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

if (!parentPort) throw new Error('7z codec worker requires a parent port')

let decoder: LzmaDecoder | null = null

function requireBytes(request: CodecRequest): Uint8Array {
  if (!request.bytes) throw new Error(`7z worker request ${request.type} has no bytes`)
  return new Uint8Array(request.bytes)
}

function transferResult(id: number, data: Uint8Array, compressed?: boolean): void {
  const transferable = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  parentPort!.postMessage({ id, bytes: transferable, compressed }, [transferable])
}

parentPort.on('message', (request: CodecRequest) => {
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
    parentPort!.postMessage({ id: request.id, ok: true })
  } catch (error) {
    parentPort!.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})

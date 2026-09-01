import fs from 'fs'
import { Writable } from 'stream'
import { pipeline } from 'stream/promises'
import zlib from 'zlib'
import type { DeflateStrategy } from './methodOverrides'

export interface AutomaticStoreOptions {
  level: number
  strategy?: DeflateStrategy
  memLevel?: number
  signal?: AbortSignal
}

function zlibStrategy(strategy?: DeflateStrategy): number {
  switch (strategy) {
    case 'filtered': return zlib.constants.Z_FILTERED
    case 'huffman_only': return zlib.constants.Z_HUFFMAN_ONLY
    case 'rle': return zlib.constants.Z_RLE
    case 'fixed': return zlib.constants.Z_FIXED
    default: return zlib.constants.Z_DEFAULT_STRATEGY
  }
}

/**
 * Runs the exact Deflate pass an automatic ZIP entry would use and chooses
 * Store only when that payload is larger than the original. The output is
 * counted and discarded, keeping memory bounded regardless of file size.
 */
export async function shouldStoreAfterDeflate(
  filePath: string,
  size: number,
  options: AutomaticStoreOptions
): Promise<boolean> {
  if (options.level <= 0 || size === 0) return true

  let compressedSize = 0
  const counter = new Writable({
    write(chunk, _encoding, callback) {
      compressedSize += chunk.length
      callback()
    }
  })
  await pipeline(
    fs.createReadStream(filePath),
    zlib.createDeflateRaw({
      level: options.level,
      strategy: zlibStrategy(options.strategy),
      ...(options.memLevel !== undefined ? { memLevel: options.memLevel } : {})
    }),
    counter,
    ...(options.signal ? [{ signal: options.signal }] : [])
  )
  return compressedSize > size
}

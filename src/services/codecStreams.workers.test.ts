import { describe, expect, it } from 'vitest'
import { Readable, Writable } from 'stream'
import { pipeline } from 'stream/promises'
import zlib from 'zlib'
import { createCodecCompressor } from './codecStreams'

/**
 * Node's Zstandard binding loses the whole stream - no output, and no error to
 * say so - when a single write past about 16 MiB reaches an encoder running
 * workers. The encoder splits its input so no caller can reach that, and this
 * is what holds it there.
 */
describe('a Zstandard encoder running workers', () => {
  const compress = async (data: Buffer, workers: number) => {
    const chunks: Buffer[] = []
    await pipeline(
      Readable.from([data]),
      createCodecCompressor('zstd', { level: 6, zstd: { workers } }),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk)
          callback()
        }
      })
    )
    return Buffer.concat(chunks)
  }

  it.each([8, 24, 48])('survives a single %i MiB write', async (megabytes) => {
    const data = Buffer.from('libera '.repeat(Math.floor(megabytes * 1024 * 1024 / 7)))
    const out = await compress(data, 4)

    expect(out.length).toBeGreaterThan(0)
    expect(zlib.zstdDecompressSync(out).equals(data)).toBe(true)
  }, 120_000)

  it('decodes to the same bytes as one running none', async () => {
    const data = Buffer.from('libera '.repeat(4 * 1024 * 1024 / 7))
    const [threaded, single] = await Promise.all([compress(data, 4), compress(data, 0)])

    expect(zlib.zstdDecompressSync(threaded).equals(data)).toBe(true)
    expect(zlib.zstdDecompressSync(single).equals(data)).toBe(true)
  }, 120_000)
})

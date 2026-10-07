import { deflateSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import type { ByteSource } from './bytes'
import { LZFSE_VECTORS } from './codecs.testData'
import { readDecmpfs } from './decmpfs'

// macOS writes LZVN when it compresses a file today, and the hdiutil images
// cover that. These build the older and rarer layouts by hand: zlib, stored
// and LZFSE data, held in the attribute or in the resource fork.

const CHUNK = 64 * 1024

function header(type: number, size: number, data: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = Buffer.alloc(16 + data.length)
  bytes.write('fpmc', 0, 'latin1')
  bytes.writeUInt32LE(type, 4)
  bytes.writeBigUInt64LE(BigInt(size), 8)
  bytes.set(data, 16)
  return bytes
}

function source(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: async (position, length) => bytes.subarray(position, position + length) }
}

async function expand(header: Uint8Array, fork?: Uint8Array): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const part of readDecmpfs(header, fork && source(fork))) parts.push(part)
  return Buffer.concat(parts)
}

/** A resource fork holding chunks behind a bare table of offsets, as LZVN and LZFSE use. */
function offsetTableFork(chunks: Uint8Array[]): Uint8Array {
  const table = Buffer.alloc((chunks.length + 1) * 4)
  let at = table.length
  chunks.forEach((chunk, i) => {
    table.writeUInt32LE(at, i * 4)
    at += chunk.length
  })
  table.writeUInt32LE(at, chunks.length * 4)
  return Buffer.concat([table, ...chunks])
}

/** A classic resource fork whose one resource lists (offset, size) pairs, as zlib uses. */
function resourceFork(chunks: Uint8Array[]): Uint8Array {
  const table = Buffer.alloc(4 + chunks.length * 8)
  table.writeUInt32LE(chunks.length, 0)
  let at = table.length
  chunks.forEach((chunk, i) => {
    table.writeUInt32LE(at, 4 + i * 8)
    table.writeUInt32LE(chunk.length, 8 + i * 8)
    at += chunk.length
  })
  const resource = Buffer.concat([table, ...chunks])
  const head = Buffer.alloc(0x104)
  head.writeUInt32BE(0x100, 0)
  head.writeUInt32BE(0x100 + 4 + resource.length, 4)
  head.writeUInt32BE(resource.length + 4, 8)
  head.writeUInt32BE(resource.length, 0x100)
  return Buffer.concat([head, resource])
}

const text = Buffer.from('filesystem compression keeps the data fork empty. '.repeat(3000))

describe('filesystem compression', () => {
  it('expands zlib data held in the attribute, compressed or stored', async () => {
    const small = text.subarray(0, 5000)
    expect(await expand(header(3, small.length, deflateSync(small)))).toEqual(small)
    expect(await expand(header(3, 5, Buffer.from('\xffhello', 'latin1')))).toEqual(Buffer.from('hello'))
  })

  it('expands zlib chunks held in a classic resource fork', async () => {
    const chunks = [0, 1, 2].map(i => deflateSync(text.subarray(i * CHUNK, Math.min(text.length, (i + 1) * CHUNK))))
    expect(await expand(header(4, text.length), resourceFork(chunks))).toEqual(text)
  })

  it('expands LZFSE in the attribute and in resource fork chunks', async () => {
    const vector = LZFSE_VECTORS.tiny
    const tiny = Buffer.from(vector.packed, 'base64')
    expect((await expand(header(11, vector.size, tiny))).toString()).toBe('hello hello hello lzfse\n')
    // A first chunk that did not compress is stored behind a 0xff marker.
    const stored = Buffer.concat([Buffer.of(0xff), text.subarray(0, CHUNK)])
    const expanded = await expand(header(12, CHUNK + vector.size), offsetTableFork([stored, tiny]))
    expect(expanded).toEqual(Buffer.concat([text.subarray(0, CHUNK), Buffer.from('hello hello hello lzfse\n')]))
  })

  it('reads stored data in the attribute and in the resource fork', async () => {
    expect((await expand(header(9, 5, Buffer.from('plain'))))).toEqual(Buffer.from('plain'))
    const data = text.subarray(0, CHUNK + 10)
    expect(await expand(header(10, data.length), offsetTableFork([data.subarray(0, CHUNK), data.subarray(CHUNK)]))).toEqual(data)
  })

  it('rejects unknown codecs, bad headers and tables that do not match the size', async () => {
    await expect(expand(header(13, 4, Buffer.from('data')))).rejects.toThrow('Unsupported DMG: filesystem compression type 13')
    const bad = header(3, 4)
    bad[0] = 0
    await expect(expand(bad)).rejects.toThrow('malformed compressed file header')
    await expect(expand(header(8, CHUNK * 2), offsetTableFork([Buffer.of(0x06)]))).rejects.toThrow('chunk count does not match')
    await expect(expand(header(8, 10))).rejects.toThrow('has no resource fork')
    await expect(expand(header(3, 100, deflateSync(Buffer.alloc(50))))).rejects.toThrow('zlib data size does not match')
  })
})

import { describe, expect, it } from 'vitest'
import { open7z } from './sevenZip'
import { MemorySource } from './io'
import { decodePpmd7, parsePpmd7Properties } from './ppmd7'
import { ppmdRestartArchiveFixture, ppmdRestartPayload } from './ppmdReferenceFixtures.testData'

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = readable.getReader()
  let length = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    chunks.push(item.value)
    length += item.value.length
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

describe('PPMd7 decoder', () => {
  it('decodes an official order-32, 64 KiB reference stream through allocator restarts', async () => {
    const archive = await open7z(new MemorySource(ppmdRestartArchiveFixture()))
    const entry = archive.entries.find(candidate => candidate.path === 'random.bin')

    expect(entry).toBeDefined()
    await expect(collect(archive.openEntry(entry!.id))).resolves.toEqual(ppmdRestartPayload())
    await archive.close()
  })

  it('parses valid five-byte and seven-byte coder properties', () => {
    expect(parsePpmd7Properties(Uint8Array.of(32, 0, 0, 1, 0)))
      .toEqual({ order: 32, memorySize: 64 * 1024 })
    expect(parsePpmd7Properties(Uint8Array.of(2, 0, 8, 0, 0, 0, 0)))
      .toEqual({ order: 2, memorySize: 2 * 1024 })
  })

  it('rejects malformed, out-of-range and oversized coder properties', () => {
    expect(() => parsePpmd7Properties(Uint8Array.of(32, 0, 0, 1)))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARCHIVE' }))
    expect(() => parsePpmd7Properties(Uint8Array.of(1, 0, 8, 0, 0)))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARCHIVE' }))
    expect(() => parsePpmd7Properties(Uint8Array.of(65, 0, 8, 0, 0)))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARCHIVE' }))
    expect(() => parsePpmd7Properties(Uint8Array.of(2, 0xff, 7, 0, 0)))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARCHIVE' }))
    expect(() => parsePpmd7Properties(Uint8Array.of(2, 1, 0, 0, 0x10)))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_FEATURE' }))
  })

  it('validates output sizes and honours cancellation before decoding', () => {
    const properties = Uint8Array.of(2, 0, 8, 0, 0)
    expect(() => decodePpmd7(Uint8Array.of(0, 0, 0, 0, 0), properties, -1))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARCHIVE' }))

    const controller = new AbortController()
    controller.abort()
    expect(() => decodePpmd7(Uint8Array.of(0, 0, 0, 0, 0), properties, 1, controller.signal))
      .toThrowError(expect.objectContaining({ code: 'CANCELLED' }))
  })
})

import { EventEmitter } from 'events'
import { describe, expect, it } from 'vitest'
import { StreamSplitter } from './sevenZipExtractor'

const HIGH_WATER_MARK = 8 * 1024 * 1024

class FakeSource extends EventEmitter {
  paused = false
  pauseCalls = 0
  resumeCalls = 0

  pause(): this {
    this.paused = true
    this.pauseCalls += 1
    return this
  }

  resume(): this {
    this.paused = false
    this.resumeCalls += 1
    return this
  }

  push(chunk: Buffer): void {
    this.emit('data', chunk)
  }

  finish(): void {
    this.emit('end')
  }
}

function createSplitter(): { source: FakeSource; splitter: StreamSplitter } {
  const source = new FakeSource()
  return { source, splitter: new StreamSplitter(source as unknown as NodeJS.ReadableStream) }
}

describe('StreamSplitter', () => {
  it('pauses the source once the queue reaches the high water mark', async () => {
    const { source, splitter } = createSplitter()
    const megabyte = 1024 * 1024
    for (let index = 0; index < 9; index++) source.push(Buffer.alloc(megabyte, 7))

    expect(source.pauseCalls).toBe(1)
    expect(source.paused).toBe(true)

    source.finish()
    const bytes = await splitter.read(9 * megabyte)

    expect(bytes.length).toBe(9 * megabyte)
    expect(source.resumeCalls).toBe(1)
    expect(source.paused).toBe(false)
  })

  it('keeps the queue bounded while a producer outruns the consumer', async () => {
    const { source, splitter } = createSplitter()
    const total = 64 * 1024 * 1024
    const chunkSize = 256 * 1024
    let produced = 0
    let consumed = 0
    let peak = 0
    let ended = false

    const produceWhileHungry = () => {
      while (!source.paused && produced < total) {
        source.push(Buffer.alloc(chunkSize, 1))
        produced += chunkSize
        peak = Math.max(peak, produced - consumed)
      }
      if (produced >= total && !ended) {
        ended = true
        source.finish()
      }
    }

    produceWhileHungry()
    for await (const chunk of splitter.take(total)) {
      consumed += chunk.length
      produceWhileHungry()
    }

    expect(consumed).toBe(total)
    expect(peak).toBeLessThanOrEqual(HIGH_WATER_MARK + chunkSize)
  })

  it('hands back exactly the declared byte counts, in order', async () => {
    const { source, splitter } = createSplitter()
    const sizes = [11, 1, 4096, 0, 70000, 33]
    const payload = Buffer.concat(sizes.map((size, index) => Buffer.alloc(size, index + 1)))

    for (let offset = 0; offset < payload.length; offset += 7000) {
      source.push(Buffer.from(payload.subarray(offset, offset + 7000)))
    }
    source.finish()

    for (const [index, size] of sizes.entries()) {
      const bytes = await splitter.read(size)
      expect(bytes.length).toBe(size)
      expect(bytes.every(byte => byte === index + 1)).toBe(true)
    }
    await expect(splitter.isExhausted()).resolves.toBe(true)
  })

  it('stops short when the stream ends before the declared size', async () => {
    const { source, splitter } = createSplitter()
    source.push(Buffer.alloc(10, 1))
    source.finish()

    const bytes = await splitter.read(64)

    expect(bytes.length).toBe(10)
    await expect(splitter.isExhausted()).resolves.toBe(true)
  })

  it('reports leftover bytes as not exhausted', async () => {
    const { source, splitter } = createSplitter()
    source.push(Buffer.alloc(20, 1))
    source.finish()

    await splitter.read(8)

    await expect(splitter.isExhausted()).resolves.toBe(false)
  })

  it('surfaces a stream error to the reader', async () => {
    const { source, splitter } = createSplitter()
    source.emit('error', new Error('pipe broke'))

    await expect(splitter.read(4)).rejects.toThrow('pipe broke')
  })
})

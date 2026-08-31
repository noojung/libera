import { describe, expect, it, vi } from 'vitest'
import { MemorySink, MemorySource, readExactly, readableFromGenerator, type RandomAccessSource } from './io.js'

describe('in-memory 7z I/O', () => {
  it('writes, patches and copies sink contents', async () => {
    const sink = new MemorySink()
    await sink.write(Uint8Array.of(1, 2, 3))
    await sink.writeAt(1n, Uint8Array.of(9))

    const firstRead = sink.data()
    firstRead[0] = 8
    expect(sink.position).toBe(3n)
    expect(sink.data()).toEqual(Uint8Array.of(1, 9, 3))
    await expect(sink.writeAt(3n, Uint8Array.of(4))).rejects.toThrow('Patch extends beyond sink')
  })

  it('reads source ranges and rejects reads outside the source', async () => {
    const source = new MemorySource(Uint8Array.of(1, 2, 3))

    await expect(source.read(1n, 2)).resolves.toEqual(Uint8Array.of(2, 3))
    await expect(source.read(2n, 2)).rejects.toThrow('Read extends beyond the archive')
  })

  it('requires random-access sources to return the requested length', async () => {
    const source: RandomAccessSource = {
      size: 2n,
      read: vi.fn(async () => Uint8Array.of(1))
    }

    await expect(readExactly(source, 0n, 2)).rejects.toThrow('Archive ended before the requested bytes')
  })

  it('turns an async generator into a readable stream and closes it on cancellation', async () => {
    let closed = false
    async function* values(): AsyncGenerator<number> {
      try {
        yield 1
        yield 2
      } finally {
        closed = true
      }
    }

    const reader = readableFromGenerator(values()).getReader()
    await expect(reader.read()).resolves.toEqual({ done: false, value: 1 })
    await reader.cancel()
    expect(closed).toBe(true)
  })

  it('honours cancellation before memory I/O', async () => {
    const controller = new AbortController()
    controller.abort()
    const sink = new MemorySink()
    const source = new MemorySource(Uint8Array.of(1))

    await expect(sink.write(Uint8Array.of(1), controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(source.read(0n, 1, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})

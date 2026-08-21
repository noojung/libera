import { uint64ToSafeNumber } from './binary'
import { invalidArchive, throwIfCancelled } from './errors'

export interface RandomAccessSource {
  readonly size: bigint
  read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array>
  close?(): Promise<void>
}

export interface SeekableSink {
  readonly position: bigint
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>
  writeAt(offset: bigint, bytes: Uint8Array, signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

export class MemorySource implements RandomAccessSource {
  readonly size: bigint

  constructor(private readonly bytes: Uint8Array) {
    this.size = BigInt(bytes.length)
  }

  async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfCancelled(signal)
    const start = uint64ToSafeNumber(offset, 'Memory source offset')
    if (start < 0 || length < 0 || start + length > this.bytes.length) {
      throw invalidArchive('Read extends beyond the archive')
    }
    return this.bytes.slice(start, start + length)
  }
}

export class MemorySink implements SeekableSink {
  private bytes = new Uint8Array(0)
  private cursor = 0

  get position(): bigint {
    return BigInt(this.cursor)
  }

  async write(value: Uint8Array, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal)
    const next = new Uint8Array(this.cursor + value.length)
    next.set(this.bytes)
    next.set(value, this.cursor)
    this.bytes = next
    this.cursor += value.length
  }

  async writeAt(offset: bigint, value: Uint8Array, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal)
    const start = uint64ToSafeNumber(offset, 'Memory sink offset')
    if (start < 0 || start + value.length > this.bytes.length) throw new RangeError('Patch extends beyond sink')
    this.bytes.set(value, start)
  }

  async close(): Promise<void> {}

  data(): Uint8Array {
    return this.bytes.slice()
  }
}

export async function readExactly(
  source: RandomAccessSource,
  offset: bigint,
  length: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const bytes = await source.read(offset, length, signal)
  if (bytes.length !== length) throw invalidArchive('Archive ended before the requested bytes were available')
  return bytes
}

export function readableFromGenerator<T>(generator: AsyncGenerator<T>): ReadableStream<T> {
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const item = await generator.next()
        if (item.done) controller.close()
        else controller.enqueue(item.value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await generator.return(undefined)
    }
  })
}

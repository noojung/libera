import { afterEach, describe, expect, it } from 'vitest'
import { Libera7zError } from '../errors.js'
import { create7zInProcess, open7zInProcess, type SevenZipEntryInput } from '../format.js'
import { MemorySink, MemorySource } from '../io.js'
import { create7z, open7z } from '../sevenZip.js'
import { stopFakeWorker, useFakeWorker } from './testWorker.js'

afterEach(() => stopFakeWorker())

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  })
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

function entry(path: string, bytes: Uint8Array): SevenZipEntryInput {
  return { path, size: BigInt(bytes.length), open: () => stream(bytes) }
}

const CONTENTS = {
  'notes.txt': text('worker round trip '.repeat(600)),
  'data.bin': text('0123456789abcdef'.repeat(400))
}

/** An archive built on the calling thread, for the worker to read back. */
async function buildArchive(options: { password?: string } = {}): Promise<Uint8Array> {
  const sink = new MemorySink()
  await create7zInProcess(
    Object.entries(CONTENTS).map(([path, bytes]) => entry(path, bytes)),
    sink,
    { method: 'lzma2', ...options }
  )
  return sink.data()
}

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = readable.getReader()
  while (true) {
    const item = await reader.read()
    if (item.done) break
    chunks.push(item.value)
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

// The packaged app reads and writes every 7z through a worker, while the tests
// around it all take the in-process path, so nothing here was covered by them.
// The handler runs on this thread but every message still crosses
// `structuredClone`, which is the part of the boundary that rejects what a real
// worker would reject.
describe('driving 7z through a worker', () => {
  it('reads an archive the worker never had the source for', async () => {
    const worker = useFakeWorker()
    const bytes = await buildArchive()

    // The source stays here; the worker asks for the ranges it needs.
    const archive = await open7z(new MemorySource(bytes))
    try {
      expect(archive.entries.map(item => item.path)).toEqual(Object.keys(CONTENTS))
      for (const [path, expected] of Object.entries(CONTENTS)) {
        const id = archive.entries.findIndex(item => item.path === path)
        expect(await collect(archive.openEntry(id))).toEqual(expected)
      }
    } finally {
      await archive.close()
    }

    expect(worker.requests.some(request => request.kind === 'open')).toBe(true)
    expect(worker.replies.some(reply => reply.kind === 'io')).toBe(true)
  })

  it('writes an archive the worker never had the sink for', async () => {
    useFakeWorker()
    const sink = new MemorySink()
    const progress: bigint[] = []

    const summary = await create7z(
      Object.entries(CONTENTS).map(([path, bytes]) => entry(path, bytes)),
      sink,
      { method: 'lzma2', onProgress: processed => progress.push(processed) }
    )

    expect(summary.size).toBe(BigInt(sink.data().length))
    // Progress crosses the boundary as it happens, not in one lump at the end.
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1])
      .toBe(Object.values(CONTENTS).reduce((total, bytes) => total + BigInt(bytes.length), 0n))

    stopFakeWorker()
    const archive = await open7z(new MemorySource(sink.data()))
    try {
      for (const [path, expected] of Object.entries(CONTENTS)) {
        const id = archive.entries.findIndex(item => item.path === path)
        expect(await collect(archive.openEntry(id))).toEqual(expected)
      }
    } finally {
      await archive.close()
    }
  })

  it('reads several entries as one solid run', async () => {
    useFakeWorker()
    const bytes = await buildArchive()
    const archive = await open7z(new MemorySource(bytes))
    try {
      const events = archive.openEntries([0, 1])
      const reader = events.getReader()
      const seen: string[] = []
      while (true) {
        const item = await reader.read()
        if (item.done) break
        if (item.value.type === 'entry-start') seen.push(item.value.entry.path)
      }
      expect(seen).toEqual(Object.keys(CONTENTS))
    } finally {
      await archive.close()
    }
  })

  // A failure raised inside the worker cannot be thrown across the boundary,
  // only described and rebuilt, so what the caller catches has to be what the
  // same read raises with no worker in the way.
  it('raises the same failure the calling thread would', async () => {
    // A 7z signature the rest of the header does not back up.
    const corrupt = new Uint8Array(64)
    corrupt.set(Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c))

    const inProcess = await open7zInProcess(new MemorySource(corrupt))
      .then(() => null, (reason: unknown) => reason)

    useFakeWorker()
    const throughWorker = await open7z(new MemorySource(corrupt))
      .then(() => null, (reason: unknown) => reason)

    expect(inProcess).toBeInstanceOf(Libera7zError)
    expect(throughWorker).toBeInstanceOf(Libera7zError)
    expect((throughWorker as Libera7zError).code).toBe((inProcess as Libera7zError).code)
    expect((throughWorker as Error).message).toBe((inProcess as Error).message)
  })

  it('reports a wrong password on the entry that could not be read', async () => {
    useFakeWorker()
    // The header is readable without the password; only the content is not.
    const archive = await open7z(new MemorySource(await buildArchive({ password: 'secret' })), {
      password: 'nope'
    })
    try {
      const error = await collect(archive.openEntry(0)).then(() => null, (reason: unknown) => reason)
      expect(error).toBeInstanceOf(Libera7zError)
      expect(['WRONG_PASSWORD', 'CRC_MISMATCH', 'INVALID_ARCHIVE'])
        .toContain((error as Libera7zError).code)
    } finally {
      await archive.close()
    }
  })

  it('stops the read when the caller aborts, and tells the worker', async () => {
    const worker = useFakeWorker()
    const bytes = await buildArchive()
    const archive = await open7z(new MemorySource(bytes))
    try {
      const controller = new AbortController()
      const reader = archive.openEntry(0, { signal: controller.signal }).getReader()
      controller.abort()

      await expect(reader.read()).rejects.toMatchObject({ code: 'CANCELLED' })
      expect(worker.requests.some(request => request.kind === 'cancel')).toBe(true)
    } finally {
      await archive.close()
    }
  })

  it('terminates the worker when the archive is closed', async () => {
    const worker = useFakeWorker()
    const archive = await open7z(new MemorySource(await buildArchive()))

    expect(worker.terminations).toBe(0)
    await archive.close()

    expect(worker.terminations).toBe(1)
    expect(worker.requests.some(request => request.kind === 'close')).toBe(true)
  })

  it('fails everything still waiting when the worker itself errors', async () => {
    const worker = useFakeWorker()
    const bytes = await buildArchive()
    const archive = await open7z(new MemorySource(bytes))

    const reading = archive.openEntry(0).getReader().read()
    worker.fail(new Error('the worker died'))

    await expect(reading).rejects.toThrow('the worker died')
  })

  it('runs on the calling thread when no worker is configured', async () => {
    stopFakeWorker()
    const sink = new MemorySink()
    await create7z([entry('plain.txt', text('no worker here'))], sink, { method: 'lzma2' })

    const archive = await open7z(new MemorySource(sink.data()))
    try {
      expect(await collect(archive.openEntry(0))).toEqual(text('no worker here'))
    } finally {
      await archive.close()
    }
  })

  it('runs on the calling thread when the worker cannot be spawned', async () => {
    useFakeWorker()
    const { configure } = await import('./config.js')
    configure({ createWorker: () => { throw new Error('no threads here') } })

    // The spawn failing is not the caller's problem: the work still happens.
    const sink = new MemorySink()
    await create7z([entry('plain.txt', text('fallback'))], sink, { method: 'lzma2' })
    expect(sink.data().length).toBeGreaterThan(0)
  })

  it('sends an entry input the boundary can carry', async () => {
    const worker = useFakeWorker()
    const sink = new MemorySink()
    const modified = new Date('2026-02-03T04:05:06.000Z')

    await create7z([
      { path: 'dir', size: 0n, isDirectory: true, modified, mode: 0o755 },
      { ...entry('dir/file.txt', text('inside')), modified, mode: 0o644 }
    ], sink, { method: 'lzma2' })

    const create = worker.requests.find(request => request.kind === 'create')
    expect(create).toBeDefined()
    // `open` cannot be cloned, so it crosses as a flag and is proxied back.
    expect(create && create.kind === 'create' && create.entries.map(item => item.hasContent))
      .toEqual([false, true])
    expect(create && create.kind === 'create' && create.entries[1].modified).toEqual(modified)
  })
})

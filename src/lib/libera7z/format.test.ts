import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { afterEach, describe, expect, it } from 'vitest'
import { Libera7zError } from './errors'
import { create7z, open7z, type Lzma2DecoderSession, type SevenZipEntryInput } from './format'
import { MemorySink, MemorySource } from './io'
import { LzmaDecoder } from './lzma'
import { dictionarySizeFromProperty } from './lzma2'
import { referenceSevenZipFixture } from './referenceFixtures.testData'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  })
}

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = readable.getReader()
  while (true) {
    const item = await reader.read()
    if (item.done) break
    chunks.push(item.value)
  }
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

describe('pure TypeScript 7z container', () => {
  const payload = new TextEncoder().encode('hello from a TypeScript 7z writer\n'.repeat(200))

  function entries(): SevenZipEntryInput[] {
    return [
      { path: 'bundle', size: 0n, isDirectory: true, mode: 0o755 },
      {
        path: 'bundle/안내.txt',
        size: BigInt(payload.length),
        mode: 0o644,
        modified: new Date('2026-08-21T01:02:03.000Z'),
        open: () => stream(payload)
      },
      { path: 'bundle/empty.txt', size: 0n, mode: 0o600, open: () => stream(new Uint8Array(0)) }
    ]
  }

  it.each(['copy', 'lzma2'] as const)('round-trips a %s archive through its own reader', async method => {
    const sink = new MemorySink()
    await create7z(entries(), sink, { method })
    const archive = await open7z(new MemorySource(sink.data()))

    expect(archive.entries.map(entry => entry.path)).toEqual(['bundle', 'bundle/안내.txt', 'bundle/empty.txt'])
    expect(archive.entries[0]).toMatchObject({ isDirectory: true, mode: 0o755 })
    expect(archive.entries[1]).toMatchObject({ isDirectory: false, size: BigInt(payload.length), mode: 0o644 })
    await expect(collect(archive.openEntry(1))).resolves.toEqual(payload)
    await expect(collect(archive.openEntry(2))).resolves.toEqual(new Uint8Array(0))
  })

  it('compresses repetitive content below the Copy representation', async () => {
    const copy = new MemorySink()
    const lzma2 = new MemorySink()
    await create7z(entries(), copy, { method: 'copy' })
    await create7z(entries(), lzma2, { method: 'lzma2' })
    expect(lzma2.data().length).toBeLessThan(copy.data().length)
  })

  it('rejects unsafe paths, header corruption and data corruption', async () => {
    const unsafe = new MemorySink()
    await expect(create7z([{ path: '../escape.txt', size: 0n }], unsafe))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' })

    const sink = new MemorySink()
    await create7z(entries(), sink, { method: 'copy' })
    const brokenHeader = sink.data()
    brokenHeader[brokenHeader.length - 2] ^= 0xff
    await expect(open7z(new MemorySource(brokenHeader))).rejects.toMatchObject({ code: 'CRC_MISMATCH' })

    const brokenData = sink.data()
    brokenData[32] ^= 0xff
    const archive = await open7z(new MemorySource(brokenData))
    await expect(collect(archive.openEntry(1))).rejects.toBeInstanceOf(Libera7zError)
  })

  it('honours entry, dictionary and cancellation limits before decoding', async () => {
    const sink = new MemorySink()
    await create7z(entries(), sink, { method: 'lzma2', dictionarySize: 16 * 1024 * 1024 })
    await expect(open7z(new MemorySource(sink.data()), { maxEntries: 2 }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(open7z(new MemorySource(sink.data()), { maxDictionaryBytes: 1024 * 1024 }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(open7z(new MemorySource(referenceSevenZipFixture('ppmd')), { maxDictionaryBytes: 1024 * 1024 }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })

    const controller = new AbortController()
    controller.abort()
    await expect(open7z(new MemorySource(sink.data()), { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it.skipIf(process.platform !== 'darwin').each(['copy', 'lzma2'] as const)(
    'writes a %s archive extractable by macOS libarchive',
    async method => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-js7z-macos-'))
      temporaryDirectories.push(directory)
      const archivePath = path.join(directory, `${method}.7z`)
      const extractionPath = path.join(directory, 'extracted')
      const sink = new MemorySink()
      await create7z(entries(), sink, { method })
      await fs.writeFile(archivePath, sink.data())
      await fs.mkdir(extractionPath)

      await execFileAsync('/usr/bin/bsdtar', ['-xf', archivePath, '-C', extractionPath])
      await expect(fs.readFile(path.join(extractionPath, 'bundle', '안내.txt'))).resolves.toEqual(Buffer.from(payload))
    },
    60_000
  )

  it('decodes match-coded LZMA2 produced by the reference 7-Zip', async () => {
    const contents = Buffer.from('external lzma2 match stream\n'.repeat(10_000))
    const archive = await open7z(new MemorySource(referenceSevenZipFixture('lzma2')))
    try {
      const entry = archive.entries.find(item => item.path === 'repeated.txt')!
      expect(Buffer.from(await collect(archive.openEntry(entry.id)))).toEqual(contents)
    } finally {
      await archive.close()
    }
  }, 60_000)

  it.each([false, true])('decodes reference LZMA data with header compression=%s', async headerCompression => {
    const contents = Buffer.from('external lzma1 match stream\n'.repeat(10_000))
    const archive = await open7z(new MemorySource(referenceSevenZipFixture(
      headerCompression ? 'lzma1-encoded-header' : 'lzma1-plain-header'
    )))
    try {
      const entry = archive.entries.find(item => item.path === 'repeated.txt')!
      expect(Buffer.from(await collect(archive.openEntry(entry.id)))).toEqual(contents)
    } finally {
      await archive.close()
    }
  }, 60_000)

  it.each(['deflate', 'deflate64', 'bzip2', 'ppmd'] as const)('decodes reference %s data', async method => {
    const contents = Buffer.from(`external ${method} match stream\n`.repeat(10_000))
    const archive = await open7z(new MemorySource(referenceSevenZipFixture(method)))
    try {
      const entry = archive.entries.find(item => item.path === 'repeated.txt')!
      expect(Buffer.from(await collect(archive.openEntry(entry.id)))).toEqual(contents)
    } finally {
      await archive.close()
    }
  }, 60_000)

  it.each([
    ['BCJ', 'filter-bcj', Buffer.from([0xe8, 0x10, 0, 0, 0, 0x90, 0xe9, 0xf0, 0xff, 0xff, 0xff])],
    ['PPC', 'filter-ppc', Buffer.from([0x48, 0, 0, 1, 0x48, 0, 1, 1])],
    ['ARM', 'filter-arm', Buffer.from([0, 0, 0, 0xeb, 4, 0, 0, 0xeb])],
    ['ARMT', 'filter-armt', Buffer.from([0, 0xf0, 0, 0xf8, 1, 0xf0, 2, 0xf8])],
    ['SPARC', 'filter-sparc', Buffer.from([0x40, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff])],
    ['IA64', 'filter-ia64', Buffer.from(Array.from({ length: 64 }, (_, index) => index * 17))],
    ['Delta:4', 'filter-delta-4', Buffer.from(Array.from({ length: 257 }, (_, index) => (index * 29) & 0xff))],
    ['Swap2', 'filter-swap2', Buffer.from(Array.from({ length: 258 }, (_, index) => index & 0xff))],
    ['Swap4', 'filter-swap4', Buffer.from(Array.from({ length: 260 }, (_, index) => index & 0xff))]
  ] as const)('decodes reference %s filtered data', async (_method, fixture, contents) => {
    const archive = await open7z(new MemorySource(referenceSevenZipFixture(fixture)))
    try {
      const entry = archive.entries.find(item => item.path === 'filtered.bin')!
      expect(Buffer.from(await collect(archive.openEntry(entry.id)))).toEqual(contents)
    } finally {
      await archive.close()
    }
  }, 60_000)

  it('decodes a reference BCJ2 multi-stream coder graph', async () => {
    const instruction = Buffer.from([0x90, 0xe8, 0x10, 0, 0, 0, 0x0f, 0x84, 0x20, 0, 0, 0, 0xe9, 0xf0, 0xff, 0xff, 0xff])
    const contents = Buffer.concat(Array.from({ length: 1_000 }, () => instruction))
    const archive = await open7z(new MemorySource(referenceSevenZipFixture('bcj2')))
    try {
      const entry = archive.entries.find(item => item.path === 'program.bin')!
      expect(Buffer.from(await collect(archive.openEntry(entry.id)))).toEqual(contents)
    } finally {
      await archive.close()
    }
  }, 60_000)

  it.each([false, true])('decrypts reference 7zAES data with header encryption=%s', async headerEncryption => {
    const contents = Buffer.from('encrypted external archive\n'.repeat(1_000))
    const bytes = referenceSevenZipFixture(headerEncryption ? 'aes-header' : 'aes-data')

    if (headerEncryption) {
      await expect(open7z(new MemorySource(bytes))).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' })
      await expect(open7z(new MemorySource(bytes), { password: 'wrong' }))
        .rejects.toMatchObject({ code: 'WRONG_PASSWORD' })
    } else {
      const listing = await open7z(new MemorySource(bytes))
      expect(listing.entries.find(entry => entry.path === 'secret.txt')).toMatchObject({ encrypted: true })
      await expect(collect(listing.openEntry(0))).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' })
      await listing.close()
    }

    const archive = await open7z(new MemorySource(bytes), { password: 'hunter2' })
    try {
      const entry = archive.entries.find(item => item.path === 'secret.txt')!
      expect(Buffer.from(await collect(archive.openEntry(entry.id)))).toEqual(contents)
    } finally {
      await archive.close()
    }
  }, 60_000)

  it('streams selected files from one solid LZMA2 folder with one decoder session', async () => {
    const contents = new Map([
      ['a.txt', Buffer.from('alpha '.repeat(400_000))],
      ['b.txt', Buffer.from('bravo '.repeat(20_000))],
      ['c.txt', Buffer.from('charlie '.repeat(20_000))]
    ])

    let decoderSessions = 0
    const archive = await open7z(new MemorySource(referenceSevenZipFixture('solid')), {
      lzma2DecoderFactory: async property => {
        decoderSessions += 1
        const decoder = new LzmaDecoder(dictionarySizeFromProperty(property))
        return {
          resetDictionary: async () => decoder.resetDictionary(),
          setProperties: async value => decoder.setProperties(value),
          resetState: async () => decoder.resetState(),
          writeUncompressed: async bytes => decoder.writeUncompressed(bytes),
          decodeChunk: async (bytes, size, signal) => decoder.decodeChunk(bytes, size, signal),
          close: async () => undefined
        } satisfies Lzma2DecoderSession
      }
    })
    try {
      const files = archive.entries.filter(entry => contents.has(path.basename(entry.path)))
      expect(files).toHaveLength(3)
      const selected = [files[0], files[2]]
      const collected = new Map<number, Uint8Array[]>()
      const reader = archive.openEntries(selected.map(entry => entry.id)).getReader()
      while (true) {
        const item = await reader.read()
        if (item.done) break
        if (item.value.type === 'entry-start') collected.set(item.value.entry.id, [])
        else if (item.value.type === 'data') collected.get(item.value.entryId)!.push(item.value.bytes)
      }

      for (const entry of selected) {
        const actual = Buffer.concat(collected.get(entry.id)!.map(bytes => Buffer.from(bytes)))
        expect(actual).toEqual(contents.get(path.basename(entry.path)))
      }
      expect(decoderSessions).toBe(1)

      const controller = new AbortController()
      const cancelled = archive.openEntries([files[0].id], { signal: controller.signal }).getReader()
      await expect(cancelled.read()).resolves.toMatchObject({ value: { type: 'entry-start' } })
      await expect(cancelled.read()).resolves.toMatchObject({ value: { type: 'data' } })
      controller.abort()
      await expect((async () => {
        while (!(await cancelled.read()).done) {
          // A chunk already queued by ReadableStream may arrive before cancellation is observed.
        }
      })()).rejects.toMatchObject({ code: 'CANCELLED' })
    } finally {
      await archive.close()
    }
  }, 60_000)
})

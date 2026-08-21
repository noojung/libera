import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { ByteReader, ByteWriter } from './binary'
import { create7z, open7z, type Lzma2DecoderSession, type SevenZipEntryInput } from './format'
import { Libera7zError } from './errors'
import { MemorySink, MemorySource } from './io'
import { LzmaDecoder } from './lzma'
import { decodeLzma2, dictionaryPropertyForSize, dictionarySizeFromProperty, encodeLzma2 } from './lzma2'
import { runSevenZip } from '../../services/sevenZip'
import { openLibera7zFile } from '../../services/libera7zNode'

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

describe('7z integer encoding', () => {
  it('round-trips every encoding width', () => {
    const values = [0n, 0x7fn, 0x80n, 0x3fffn, 0x4000n, 0xffffffffn, 0x123456789abcdef0n, 0xffffffffffffffffn]
    const writer = new ByteWriter()
    values.forEach(value => writer.variableUint64(value))
    const reader = new ByteReader(writer.build())
    expect(values.map(() => reader.variableUint64())).toEqual(values)
    expect(reader.remaining).toBe(0)
  })
})

describe('pure JavaScript LZMA2', () => {
  it('round-trips compressible and incompressible chunks', () => {
    const compressible = new TextEncoder().encode('pure-js-seven-zip\n'.repeat(4000))
    const random = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 131 + 17) & 0xff)
    for (const source of [compressible, random]) {
      const encoded = encodeLzma2(source)
      if (source === compressible) expect(encoded.compressedChunks).toBeGreaterThan(0)
      expect(decodeLzma2(encoded.data, dictionaryPropertyForSize(1024 * 1024), source.length)).toEqual(source)
    }
  })
})

describe('pure JavaScript 7z container', () => {
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

    const controller = new AbortController()
    controller.abort()
    await expect(open7z(new MemorySource(sink.data()), { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it.each(['copy', 'lzma2'] as const)('writes a %s archive accepted by the bundled 7-Zip', async method => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-js7z-'))
    temporaryDirectories.push(directory)
    const archivePath = path.join(directory, `${method}.7z`)
    const sink = new MemorySink()
    await create7z(entries(), sink, { method })
    await fs.writeFile(archivePath, sink.data())

    const { stdout } = await runSevenZip(['l', '-slt', '--', archivePath], undefined)
    expect(stdout.normalize('NFC')).toContain(`Path = ${path.join('bundle', '안내.txt')}`)
    await expect(runSevenZip(['t', '--', archivePath], undefined)).resolves.toMatchObject({ exitCode: 0 })
  }, 60_000)

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

  it('decodes match-coded LZMA2 produced by the bundled 7-Zip', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-js7z-external-'))
    temporaryDirectories.push(directory)
    const inputPath = path.join(directory, 'repeated.txt')
    const contents = Buffer.from('external lzma2 match stream\n'.repeat(10_000))
    const archivePath = path.join(directory, 'external.7z')
    await fs.writeFile(inputPath, contents)
    await runSevenZip(['a', '-m0=lzma2', '-ms=off', '-mhc=off', '--', archivePath, inputPath], undefined)

    const archive = await openLibera7zFile(archivePath)
    try {
      const entry = archive.entries.find(item => item.path === 'repeated.txt')!
      expect(Buffer.from(await collect(archive.openEntry(entry.id)))).toEqual(contents)
    } finally {
      await archive.close()
    }
  }, 60_000)

  it('streams selected files from one solid LZMA2 folder with one decoder session', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-js7z-solid-'))
    temporaryDirectories.push(directory)
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    const contents = new Map([
      ['a.txt', Buffer.from('alpha '.repeat(400_000))],
      ['b.txt', Buffer.from('bravo '.repeat(20_000))],
      ['c.txt', Buffer.from('charlie '.repeat(20_000))]
    ])
    await Promise.all([...contents].map(([name, bytes]) => fs.writeFile(path.join(sourceDir, name), bytes)))
    const archivePath = path.join(directory, 'solid.7z')
    await runSevenZip(['a', '-m0=lzma2', '-ms=on', '-mhc=off', '--', archivePath, sourceDir], undefined)
    const { stdout } = await runSevenZip(['l', '-slt', '--', archivePath], undefined)
    expect(stdout).toContain('Solid = +')
    expect(stdout).toContain('Blocks = 1')

    let decoderSessions = 0
    const archive = await openLibera7zFile(archivePath, {
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

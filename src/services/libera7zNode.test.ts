import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { openLibera7zFile, writeLibera7z } from './libera7zNode'
import { runSevenZip } from './sevenZip'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-7znode-'))
  temporaryDirectories.push(directory)
  return directory
}

async function collect(readable: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  const reader = readable.getReader()
  while (true) {
    const item = await reader.read()
    if (item.done) return Buffer.concat(chunks)
    chunks.push(Buffer.from(item.value))
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('Libera7z Node volume I/O', () => {
  it('writes and reads a compressed split archive whose signature spans volumes', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'payload.bin')
    const outputPath = path.join(directory, 'archive.7z')
    const contents = Buffer.from(Array.from({ length: 513 }, (_, index) => (index * 73 + 19) & 0xff))
    await fs.writeFile(inputPath, contents)

    // Smaller than the 32-byte signature header, exercising cross-volume
    // reads and the final StartHeader writeAt patch at the same time.
    const result = await writeLibera7z({
      inputPaths: [inputPath],
      outputPath,
      level: 5,
      splitSize: 17
    })

    expect(result.outputPath).toBe(`${outputPath}.001`)
    expect(result.volumePaths!.length).toBeGreaterThan(2)
    const sizes = await Promise.all(result.volumePaths!.map(volume => fs.stat(volume).then(stat => stat.size)))
    expect(sizes.slice(0, -1).every(size => size === 17)).toBe(true)
    expect(sizes.at(-1)).toBeLessThanOrEqual(17)
    await expect(fs.access(outputPath)).rejects.toThrow()

    const archive = await openLibera7zFile(result.volumePaths!.at(-1)!)
    try {
      const entry = archive.entries.find(item => item.path === 'payload.bin')!
      await expect(collect(archive.openEntry(entry.id))).resolves.toEqual(contents)
    } finally {
      await archive.close()
    }

    await expect(runSevenZip(['t', '--', result.outputPath], undefined)).resolves.toMatchObject({ exitCode: 0 })
  }, 60_000)

  it('removes every partial volume when creation is cancelled', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'large.bin')
    const outputPath = path.join(directory, 'cancelled.7z')
    await fs.writeFile(inputPath, Buffer.alloc(256 * 1024, 7))
    const controller = new AbortController()

    await expect(writeLibera7z({
      inputPaths: [inputPath],
      outputPath,
      level: 0,
      splitSize: 30_000,
      signal: controller.signal,
      onProgress: processedBytes => {
        if (processedBytes > 0n) controller.abort()
      }
    })).rejects.toMatchObject({ code: 'CANCELLED' })

    const names = await fs.readdir(directory)
    expect(names.some(name => name.startsWith('cancelled.7z.'))).toBe(false)
  })
})

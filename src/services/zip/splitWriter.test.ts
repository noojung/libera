import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { SplitDataReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, type Entry } from '@zip.js/zip.js'
import { compressArchive, CompressionError, type ProgressData } from '../compressor'
import { inspectArchive } from '../archiveInspector'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-split-'))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * The app's own readers only take a single archive file, so the volume set is
 * stitched back together here the way a split-aware reader would.
 */
async function readSplitZip(volumePaths: string[], password?: string): Promise<{ entries: Entry[]; close: () => Promise<void> }> {
  const readers = await Promise.all(volumePaths.map(async volume => new Uint8ArrayReader(await fs.readFile(volume))))
  // Not `strictness: 'strict'`: the spanning signature that APPNOTE puts at
  // the start of the first volume reads as prepended data to a strict reader.
  const reader = new ZipReader(new SplitDataReader(readers), {
    checkCrc32: true,
    ...(password ? { password } : {})
  })
  return { entries: await reader.getEntries(), close: () => reader.close() }
}

async function readEntryData(entry: Entry): Promise<Uint8Array> {
  if (!('getData' in entry) || !entry.getData) throw new Error(`${entry.filename} carries no data`)
  return entry.getData(new Uint8ArrayWriter())
}

async function listVolumeNames(directory: string, baseName = 'archive'): Promise<string[]> {
  const names = await fs.readdir(directory)
  return names.filter(name => new RegExp(`^${baseName}\\.(zip|z\\d{2,})$`).test(name)).sort()
}

async function createSource(directory: string, fileCount: number, fileSize: number): Promise<string> {
  const sourceDir = path.join(directory, 'source')
  await fs.mkdir(sourceDir, { recursive: true })
  for (let index = 0; index < fileCount; index += 1) {
    await fs.writeFile(path.join(sourceDir, `file-${index}.bin`), crypto.randomBytes(fileSize))
  }
  return sourceDir
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('split ZIP compression', () => {
  it('writes numbered volumes with the final one named .zip', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createSource(directory, 4, 1024 * 1024)
    const outputPath = path.join(directory, 'archive.zip')

    const result = await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 0,
      splitSize: 1024 * 1024
    })

    expect(result.volumePaths!.length).toBeGreaterThanOrEqual(4)
    expect(result.outputPath).toBe(outputPath)
    expect(result.volumePaths!.at(-1)).toBe(outputPath)

    const expectedNames = result.volumePaths!.map((volume, index) =>
      index === result.volumePaths!.length - 1 ? 'archive.zip' : `archive.z${String(index + 1).padStart(2, '0')}`
    )
    expect(await listVolumeNames(directory)).toEqual([...expectedNames].sort())

    const sizes = await Promise.all(result.volumePaths!.map(async volume => (await fs.stat(volume)).size))
    for (const size of sizes.slice(0, -1)) {
      expect(size).toBeLessThanOrEqual(1024 * 1024)
    }
    expect(result.compressedSize).toBe(sizes.reduce((total, size) => total + size, 0))
  }, 30000)

  it('round-trips every entry through a split-aware reader', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createSource(directory, 3, 1024 * 1024)
    await fs.mkdir(path.join(sourceDir, 'empty'), { recursive: true })
    const outputPath = path.join(directory, 'archive.zip')

    const result = await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 0,
      splitSize: 1024 * 1024
    })

    const { entries, close } = await readSplitZip(result.volumePaths!)
    try {
      const names = entries.map(entry => entry.filename).sort()
      expect(names).toEqual([
        'source',
        'source/empty',
        'source/file-0.bin',
        'source/file-1.bin',
        'source/file-2.bin'
      ].map(name => (name.includes('.') ? name : `${name}/`)).sort())
      expect(names.some(name => name.includes('\\'))).toBe(false)

      const first = entries.find(entry => entry.filename === 'source/file-0.bin')!
      const data = await readEntryData(first)
      expect(Buffer.from(data).equals(await fs.readFile(path.join(sourceDir, 'file-0.bin')))).toBe(true)

      const sourceStat = await fs.stat(path.join(sourceDir, 'file-0.bin'))
      expect(Math.abs(first.lastModDate.getTime() - sourceStat.mtime.getTime())).toBeLessThan(4000)
    } finally {
      await close()
    }
  }, 30000)

  it('marks the volumes as a split set and ends the last one with the central directory', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createSource(directory, 3, 1024 * 1024)
    const outputPath = path.join(directory, 'archive.zip')

    const result = await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 0,
      splitSize: 1024 * 1024
    })

    const firstVolume = await fs.readFile(result.volumePaths![0])
    expect([...firstVolume.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x07, 0x08])

    const lastVolume = await fs.readFile(outputPath)
    const endOfDirectory = lastVolume.subarray(lastVolume.length - 22)
    expect(endOfDirectory.readUInt32LE(0)).toBe(0x06054b50)
    expect(endOfDirectory.readUInt16LE(4)).toBe(result.volumePaths!.length - 1)
    expect(endOfDirectory.readUInt16LE(6)).toBe(result.volumePaths!.length - 1)
  }, 30000)

  it('writes an ordinary archive when everything fits in one volume', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createSource(directory, 1, 1024)
    const outputPath = path.join(directory, 'archive.zip')

    const result = await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      splitSize: 1024 * 1024
    })

    expect(result.volumePaths).toBeUndefined()
    expect(await listVolumeNames(directory)).toEqual(['archive.zip'])
    await expect(inspectArchive(outputPath)).resolves.toMatchObject({ format: 'ZIP', totalFiles: 1 })
  })

  it('removes every volume when the job is cancelled', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createSource(directory, 6, 1024 * 1024)
    const outputPath = path.join(directory, 'archive.zip')
    const controller = new AbortController()

    await expect(
      compressArchive(
        { inputPaths: [sourceDir], outputPath, format: 'zip', level: 0, splitSize: 1024 * 1024 },
        () => controller.abort(),
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: 'CompressionError', code: 'COMPRESSION_CANCELLED' })

    expect(await listVolumeNames(directory)).toEqual([])
  }, 30000)

  it('clears volumes left behind by an earlier run', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createSource(directory, 3, 1024 * 1024)
    const outputPath = path.join(directory, 'archive.zip')
    await fs.writeFile(path.join(directory, 'archive.z01'), 'stale')
    await fs.writeFile(path.join(directory, 'archive.z07'), 'stale')

    const result = await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 0,
      splitSize: 1024 * 1024
    })

    expect(await listVolumeNames(directory)).toEqual([...result.volumePaths!.map(volume => path.basename(volume))].sort())

    const { entries, close } = await readSplitZip(result.volumePaths!)
    try {
      expect(entries.some(entry => entry.filename.includes('archive.z'))).toBe(false)
    } finally {
      await close()
    }
  }, 30000)

  it('keeps its own volumes out of an archive written inside the compressed folder', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createSource(directory, 3, 1024 * 1024)
    const outputPath = path.join(sourceDir, 'archive.zip')

    const result = await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 0,
      splitSize: 1024 * 1024
    })

    expect(result.originalSize).toBe(3 * 1024 * 1024)

    const { entries, close } = await readSplitZip(result.volumePaths!)
    try {
      expect(entries.some(entry => /archive\.(zip|z\d{2,})$/.test(entry.filename))).toBe(false)
    } finally {
      await close()
    }
  }, 30000)

  it('encrypts split volumes with a password', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createSource(directory, 3, 1024 * 1024)
    const outputPath = path.join(directory, 'archive.zip')

    const result = await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 0,
      password: 'secret',
      splitSize: 1024 * 1024
    })

    const { entries, close } = await readSplitZip(result.volumePaths!, 'secret')
    try {
      const entry = entries.find(item => item.filename === 'source/file-0.bin')!
      expect(entry.encrypted).toBe(true)
      const data = await readEntryData(entry)
      expect(Buffer.from(data).equals(await fs.readFile(path.join(sourceDir, 'file-0.bin')))).toBe(true)
    } finally {
      await close()
    }
  }, 30000)

  it('reports monotonic progress and a final complete event', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createSource(directory, 3, 1024 * 1024)
    const outputPath = path.join(directory, 'archive.zip')
    const updates: ProgressData[] = []

    await compressArchive(
      { inputPaths: [sourceDir], outputPath, format: 'zip', level: 0, splitSize: 1024 * 1024 },
      progress => updates.push(progress)
    )

    expect(updates.at(-1)).toMatchObject({ percent: 100, phase: 'complete', totalBytes: 3 * 1024 * 1024 })
    for (let index = 1; index < updates.length; index += 1) {
      expect(updates[index].processedBytes).toBeGreaterThanOrEqual(updates[index - 1].processedBytes)
    }
  }, 30000)

  it('rejects split sizes and formats it cannot support', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'file.txt')
    await fs.writeFile(inputPath, 'data')

    await expect(
      compressArchive({ inputPaths: [inputPath], outputPath: path.join(directory, 'archive.zip'), format: 'zip', splitSize: 1024 })
    ).rejects.toMatchObject({ name: 'CompressionError', code: 'SPLIT_SIZE_TOO_SMALL' })

    await expect(
      compressArchive({ inputPaths: [inputPath], outputPath: path.join(directory, 'archive.tar'), format: 'tar', splitSize: 1024 * 1024 })
    ).rejects.toBeInstanceOf(CompressionError)

    await expect(
      compressArchive({ inputPaths: [inputPath], outputPath: path.join(directory, 'archive.tar'), format: 'tar', splitSize: 1024 * 1024 })
    ).rejects.toMatchObject({ code: 'SPLIT_NOT_SUPPORTED_FOR_FORMAT' })
  })

  it('gives colliding input roots distinct entry names', async () => {
    const directory = await createTemporaryDirectory()
    const firstRoot = path.join(directory, 'first', 'docs')
    const secondRoot = path.join(directory, 'second', 'docs')
    await fs.mkdir(firstRoot, { recursive: true })
    await fs.mkdir(secondRoot, { recursive: true })
    await fs.writeFile(path.join(firstRoot, 'a.bin'), crypto.randomBytes(1024 * 1024))
    await fs.writeFile(path.join(secondRoot, 'b.bin'), crypto.randomBytes(1024 * 1024))
    const outputPath = path.join(directory, 'archive.zip')

    const result = await compressArchive({
      inputPaths: [firstRoot, secondRoot],
      outputPath,
      format: 'zip',
      level: 0,
      splitSize: 1024 * 1024
    })

    const { entries, close } = await readSplitZip(result.volumePaths!)
    try {
      expect(entries.map(entry => entry.filename).sort()).toEqual([
        'docs (2)/',
        'docs (2)/b.bin',
        'docs/',
        'docs/a.bin'
      ])
    } finally {
      await close()
    }
  }, 30000)
})

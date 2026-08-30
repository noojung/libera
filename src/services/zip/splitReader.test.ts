import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { compressArchive } from '../compressor'
import { openZipArchive } from './fileReader'
import { discoverSplitVolumes } from './volumes'
import { extractArchive } from '../extractor'
import { inspectArchive } from '../archiveInspector'
import { previewArchiveEntry } from '../archivePreview'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-split-read-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createSplitSet(fileCount = 4, fileSize = 1024 * 1024): Promise<{
  directory: string
  sourceDir: string
  outputPath: string
  volumePaths: string[]
  compressedSize: number
}> {
  const directory = await createTemporaryDirectory()
  const sourceDir = path.join(directory, 'source')
  await fs.mkdir(sourceDir, { recursive: true })
  for (let index = 0; index < fileCount; index += 1) {
    await fs.writeFile(path.join(sourceDir, `file-${index}.bin`), crypto.randomBytes(fileSize))
  }

  const outputPath = path.join(directory, 'archive.zip')
  const result = await compressArchive({
    inputPaths: [sourceDir],
    outputPath,
    format: 'zip',
    level: 0,
    splitSize: 1024 * 1024
  })

  return {
    directory,
    sourceDir,
    outputPath,
    volumePaths: result.volumePaths!,
    compressedSize: result.compressedSize
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('reading split ZIP archives', () => {
  it('opens a volume set through the final, first or a middle volume alike', async () => {
    const { directory, outputPath, volumePaths, compressedSize } = await createSplitSet()
    expect(volumePaths.length).toBeGreaterThanOrEqual(4)

    const entryPoints = [outputPath, path.join(directory, 'archive.z01'), path.join(directory, 'archive.z02')]
    for (const entryPoint of entryPoints) {
      const archive = await openZipArchive(entryPoint, 1000)
      try {
        expect(archive.isSplit).toBe(true)
        expect(archive.volumePaths).toEqual(volumePaths)
        expect(archive.totalBytes).toBe(compressedSize)
        expect(archive.entries.map(entry => entry.filename)).toContain('source/file-0.bin')
      } finally {
        await archive.close()
      }
    }
  }, 30000)

  it('reads a set that compressed down to a single volume', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir, { recursive: true })
    // Compressible enough that the output fits one volume even though the
    // input exceeds splitSize, so the writer still stamps the spanning marker.
    await fs.writeFile(path.join(sourceDir, 'repeated.txt'), 'a'.repeat(2 * 1024 * 1024))
    const outputPath = path.join(directory, 'archive.zip')

    const result = await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 6,
      splitSize: 1024 * 1024
    })
    expect(result.volumePaths).toHaveLength(1)
    const head = await fs.readFile(outputPath)
    expect([...head.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x07, 0x08])

    const archive = await openZipArchive(outputPath, 1000)
    try {
      expect(archive.entries.map(entry => entry.filename)).toContain('source/repeated.txt')
    } finally {
      await archive.close()
    }
  }, 30000)

  it('orders volumes numerically past ninety-nine', async () => {
    const directory = await createTemporaryDirectory()
    const base = path.join(directory, 'archive')
    for (const suffix of ['z09', 'z10', 'z99', 'z100', 'z101', 'zip']) {
      await fs.writeFile(`${base}.${suffix}`, '')
    }
    for (let disk = 1; disk <= 8; disk += 1) {
      await fs.writeFile(`${base}.z${String(disk).padStart(2, '0')}`, '')
    }
    for (let disk = 11; disk <= 98; disk += 1) {
      await fs.writeFile(`${base}.z${String(disk).padStart(2, '0')}`, '')
    }
    const endOfCentralDirectory = Buffer.alloc(22)
    endOfCentralDirectory.writeUInt32LE(0x06054b50, 0)
    endOfCentralDirectory.writeUInt16LE(101, 4)
    endOfCentralDirectory.writeUInt16LE(101, 6)
    await fs.writeFile(`${base}.zip`, endOfCentralDirectory)

    const volumes = await discoverSplitVolumes(`${base}.zip`)
    const names = volumes.map(volume => path.basename(volume))
    expect(names.slice(97, 101)).toEqual(['archive.z98', 'archive.z99', 'archive.z100', 'archive.z101'])
    expect(names.at(-1)).toBe('archive.zip')
  })

  it('names the volume that is missing', async () => {
    const { directory, outputPath } = await createSplitSet()

    await fs.unlink(path.join(directory, 'archive.z02'))
    await expect(openZipArchive(outputPath, 1000)).rejects.toMatchObject({
      name: 'SplitVolumeError',
      code: 'SPLIT_VOLUME_MISSING',
      volume: 'archive.z02'
    })
  }, 30000)

  it('detects a missing highest numbered volume from the terminal disk number', async () => {
    const { outputPath, volumePaths } = await createSplitSet()
    const missingVolume = volumePaths.at(-2)!

    await fs.unlink(missingVolume)
    await expect(openZipArchive(outputPath, 1000)).rejects.toMatchObject({
      name: 'SplitVolumeError',
      code: 'SPLIT_VOLUME_MISSING',
      volume: path.basename(missingVolume)
    })
  }, 30000)

  it('detects the missing first numbered volume when only the terminal ZIP remains', async () => {
    const { outputPath, volumePaths } = await createSplitSet()
    await Promise.all(volumePaths.slice(0, -1).map(volume => fs.unlink(volume)))

    await expect(openZipArchive(outputPath, 1000)).rejects.toMatchObject({
      name: 'SplitVolumeError',
      code: 'SPLIT_VOLUME_MISSING',
      volume: 'archive.z01'
    })
  }, 30000)

  it('names the final volume when only numbered volumes remain', async () => {
    const { directory, outputPath } = await createSplitSet()

    await fs.unlink(outputPath)
    await expect(openZipArchive(path.join(directory, 'archive.z01'), 1000)).rejects.toMatchObject({
      code: 'SPLIT_VOLUME_MISSING',
      volume: 'archive.zip'
    })
  }, 30000)

  it('rejects a set left with a stale extra volume', async () => {
    const { directory, outputPath, volumePaths } = await createSplitSet()

    await fs.writeFile(path.join(directory, `archive.z${String(volumePaths.length + 3).padStart(2, '0')}`), 'stale')
    await expect(openZipArchive(outputPath, 1000)).rejects.toThrow()
  }, 30000)

  it('keeps ordinary archives at full strictness', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'plain.txt'), 'hello')
    const outputPath = path.join(directory, 'plain.zip')
    await compressArchive({ inputPaths: [sourceDir], outputPath, format: 'zip' })

    const archive = await openZipArchive(outputPath, 1000)
    try {
      expect(archive.isSplit).toBe(false)
      expect(archive.volumePaths).toEqual([outputPath])
    } finally {
      await archive.close()
    }

    const original = await fs.readFile(outputPath)
    await fs.writeFile(outputPath, Buffer.concat([Buffer.alloc(8, 0x7f), original]))
    await expect(openZipArchive(outputPath, 1000)).rejects.toThrow(/ambiguous/i)
  })

  it('ignores an unrelated first-volume file beside an ordinary archive', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'plain.txt'), 'hello')
    const outputPath = path.join(directory, 'plain.zip')
    await compressArchive({ inputPaths: [sourceDir], outputPath, format: 'zip' })
    await fs.writeFile(path.join(directory, 'plain.z01'), 'not a volume')

    const archive = await openZipArchive(outputPath, 1000)
    try {
      expect(archive.isSplit).toBe(false)
      expect(archive.volumePaths).toEqual([outputPath])
    } finally {
      await archive.close()
    }
  })

  it('rejects a volume that is not a regular file', async () => {
    const { directory, outputPath } = await createSplitSet()
    const volume = path.join(directory, 'archive.z02')

    await fs.unlink(volume)
    await fs.mkdir(volume)
    await expect(openZipArchive(outputPath, 1000)).rejects.toMatchObject({ name: 'SplitVolumeError' })
  }, 30000)

  it('extracts a volume set entered through any volume', async () => {
    const { directory, sourceDir, outputPath } = await createSplitSet()
    const expected = await Promise.all(
      [0, 1, 2, 3].map(async index => fs.readFile(path.join(sourceDir, `file-${index}.bin`)))
    )

    for (const [index, entryPoint] of [outputPath, path.join(directory, 'archive.z02')].entries()) {
      const targetDir = path.join(directory, `out-${index}`)
      const result = await extractArchive({ archivePath: entryPoint, targetDir })
      expect(result.extractedCount).toBeGreaterThan(0)

      for (const [fileIndex, contents] of expected.entries()) {
        const extracted = await fs.readFile(path.join(targetDir, 'source', `file-${fileIndex}.bin`))
        expect(extracted.equals(contents)).toBe(true)
      }
    }
  }, 30000)

  it('reports the whole set size when inspecting', async () => {
    const { directory, outputPath, volumePaths, compressedSize } = await createSplitSet()

    const inspection = await inspectArchive(outputPath)
    expect(inspection.format).toBe('ZIP')
    expect(inspection.totalCompressedSize).toBe(compressedSize)
    expect(inspection.volumeCount).toBe(volumePaths.length)
    expect(inspection.volumes?.map(volume => volume.path)).toEqual(volumePaths)
    expect(inspection.volumes?.map(volume => volume.size)).toEqual(
      await Promise.all(volumePaths.map(volumePath => fs.stat(volumePath).then(stat => stat.size)))
    )

    const viaVolume = await inspectArchive(path.join(directory, 'archive.z02'))
    expect(viaVolume.archivePath).toBe(outputPath)
    expect(viaVolume.volumes).toEqual(inspection.volumes)
    expect(viaVolume.entries.map(entry => entry.path)).toEqual(inspection.entries.map(entry => entry.path))
  }, 30000)

  it('previews an entry that starts on a later volume', async () => {
    const { directory, sourceDir, outputPath } = await createSplitSet(4, 300 * 1024)
    await fs.writeFile(path.join(sourceDir, 'late.txt'), 'x'.repeat(4096))
    const setWithText = await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 0,
      splitSize: 1024 * 1024
    })
    expect(setWithText.volumePaths!.length).toBeGreaterThan(1)

    const inspection = await inspectArchive(outputPath)
    const target = inspection.entries.find(entry => entry.path === 'source/late.txt')!
    const preview = await previewArchiveEntry(outputPath, target.id)
    expect(preview).toMatchObject({ kind: 'text', text: 'x'.repeat(4096) })

    // Entry ids are positional, so a second open must produce the same mapping.
    const reopened = await inspectArchive(path.join(directory, 'archive.z01'))
    expect(reopened.entries.map(entry => `${entry.id}:${entry.path}`))
      .toEqual(inspection.entries.map(entry => `${entry.id}:${entry.path}`))
    const viaVolume = await previewArchiveEntry(path.join(directory, 'archive.z01'), target.id)
    expect(viaVolume).toMatchObject({ kind: 'text', text: 'x'.repeat(4096) })
  }, 30000)

  it('handles a password-protected volume set', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir, { recursive: true })
    for (let index = 0; index < 3; index += 1) {
      await fs.writeFile(path.join(sourceDir, `file-${index}.bin`), crypto.randomBytes(1024 * 1024))
    }
    const outputPath = path.join(directory, 'archive.zip')
    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 0,
      password: 'secret',
      splitSize: 1024 * 1024
    })

    const inspection = await inspectArchive(outputPath)
    expect(inspection.passwordProtected).toBe(true)

    const targetDir = path.join(directory, 'out')
    await extractArchive({ archivePath: outputPath, targetDir, password: 'secret' })
    const extracted = await fs.readFile(path.join(targetDir, 'source', 'file-0.bin'))
    expect(extracted.equals(await fs.readFile(path.join(sourceDir, 'file-0.bin')))).toBe(true)

    await expect(
      extractArchive({ archivePath: outputPath, targetDir: path.join(directory, 'out-wrong'), password: 'nope' })
    ).rejects.toMatchObject({ code: 'WRONG_ZIP_PASSWORD' })
  }, 30000)

  it('releases every volume handle once closed', async () => {
    const { directory, outputPath } = await createSplitSet()

    const archive = await openZipArchive(outputPath, 1000)
    await archive.close()

    // On Windows an unclosed handle keeps the file locked, so a successful
    // removal is the cheapest proof that no volume leaked a descriptor.
    await expect(fs.rm(directory, { recursive: true, force: true })).resolves.toBeUndefined()
  }, 30000)
})

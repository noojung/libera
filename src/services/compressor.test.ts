import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import * as tar from 'tar'
import {
  calculateTotalSize,
  compressArchive,
  compressionLevels,
  nearestLevel,
  type ProgressData
} from './compressor'
import { inspectArchive } from './archiveInspector'
import { extractArchive } from './extractor'
import { MIN_SPLIT_SIZE } from './zip/splitWriter'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-compressor-'))
  temporaryDirectories.push(directory)
  return directory
}

async function listTarPaths(archivePath: string): Promise<string[]> {
  const entries: string[] = []
  await tar.t({
    file: archivePath,
    onentry: entry => entries.push(entry.path)
  })
  return entries
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('calculateTotalSize', () => {
  it.skipIf(process.platform === 'win32')('sums files in nested directories without following symbolic links', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const nestedDir = path.join(sourceDir, 'nested')
    const externalFile = path.join(directory, 'external.txt')
    await fs.mkdir(nestedDir, { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'top.txt'), 'top')
    await fs.writeFile(path.join(nestedDir, 'child.txt'), 'child')
    await fs.writeFile(externalFile, 'external')
    await fs.symlink(sourceDir, path.join(sourceDir, 'loop'))
    await fs.symlink(externalFile, path.join(sourceDir, 'linked-external.txt'))

    await expect(calculateTotalSize([sourceDir])).resolves.toBe(Buffer.byteLength('topchild'))
  })

  it('adds independent input paths and ignores missing paths', async () => {
    const directory = await createTemporaryDirectory()
    const firstFile = path.join(directory, 'first.txt')
    const secondFile = path.join(directory, 'second.txt')
    await fs.writeFile(firstFile, 'one')
    await fs.writeFile(secondFile, 'two!')

    await expect(calculateTotalSize([firstFile, secondFile, path.join(directory, 'missing.txt')]))
      .resolves.toBe(Buffer.byteLength('onetwo!'))
  })
})

describe('compression levels', () => {
  it('offers every deflate step and only the six 7-Zip -mx steps', () => {
    expect(compressionLevels('zip')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(compressionLevels('gz')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(compressionLevels('tgz')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(compressionLevels('7z')).toEqual([0, 1, 3, 5, 7, 9])
    expect(compressionLevels('tar')).toEqual([])
  })

  it('moves a level to the closest step the new format has', () => {
    expect(nearestLevel(6, '7z')).toBe(5)
    expect(nearestLevel(2, '7z')).toBe(1)
    expect(nearestLevel(4, '7z')).toBe(3)
    expect(nearestLevel(8, '7z')).toBe(7)
    expect(nearestLevel(5, 'zip')).toBe(5)
  })
})

describe('compressArchive', () => {
  it.each([
    ['zip', 'archive.zip'],
    ['tar', 'archive.tar'],
    ['tgz', 'archive.tgz']
  ] as const)('creates a %s archive that preserves the input hierarchy', async (format, archiveName) => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(path.join(sourceDir, 'docs'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'docs', 'readme.txt'), 'archive content')
    const outputPath = path.join(directory, archiveName)

    const result = await compressArchive({ inputPaths: [sourceDir], outputPath, format })

    expect(result.outputPath).toBe(outputPath)
    expect(result.originalSize).toBe(Buffer.byteLength('archive content'))
    expect((await fs.stat(outputPath)).isFile()).toBe(true)

    if (format === 'zip') {
      const entryPaths = (await inspectArchive(outputPath)).entries.map(entry => entry.path)
      expect(entryPaths).toContain('source/docs/readme.txt')
    } else {
      await expect(listTarPaths(outputPath)).resolves.toContain('source/docs/readme.txt')
    }
  })

  it('creates a GZ archive for a single file and reports completion progress', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'report.txt')
    const outputPath = path.join(directory, 'report.txt.gz')
    const contents = 'compress this file'
    const progress: ProgressData[] = []
    await fs.writeFile(inputPath, contents)

    const result = await compressArchive(
      { inputPaths: [inputPath], outputPath, format: 'gz' },
      update => progress.push(update)
    )

    expect(result.originalSize).toBe(Buffer.byteLength(contents))
    expect(zlib.gunzipSync(await fs.readFile(outputPath)).toString()).toBe(contents)
    expect(progress.at(-1)).toMatchObject({
      processedBytes: Buffer.byteLength(contents),
      totalBytes: Buffer.byteLength(contents),
      percent: 100,
      currentFile: 'report.txt'
    })
  })

  it('creates readable AES-128 and Store ZIP archives with accurate metadata', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'payload.txt')
    const encryptedPath = path.join(directory, 'aes128.zip')
    const storedPath = path.join(directory, 'stored.zip')
    const contents = 'expert ZIP options'
    await fs.writeFile(inputPath, contents)

    await compressArchive({
      inputPaths: [inputPath],
      outputPath: encryptedPath,
      format: 'zip',
      password: 'hunter2',
      encryptionMethod: 'aes128'
    })
    const encrypted = await inspectArchive(encryptedPath)
    expect(encrypted.entries[0]).toMatchObject({ encryptionMethod: 'AES-128', encrypted: true })
    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath: encryptedPath, targetDir: outputDir, password: 'hunter2' })
    await expect(fs.readFile(path.join(outputDir, 'payload.txt'), 'utf8')).resolves.toBe(contents)

    await compressArchive({
      inputPaths: [inputPath],
      outputPath: storedPath,
      format: 'zip',
      zipMethod: 'store'
    })
    const stored = await inspectArchive(storedPath)
    expect(stored.entries[0]).toMatchObject({ codec: 'Store', compressedSize: Buffer.byteLength(contents) })
  })

  it('rejects passwords for formats without encryption and directory input for GZ', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)

    await expect(compressArchive({
      inputPaths: [],
      outputPath: path.join(directory, 'archive.tar'),
      format: 'tar',
      password: 'not-supported'
    })).rejects.toThrow('ZIP and 7Z archives only')
    await expect(compressArchive({
      inputPaths: [],
      outputPath: path.join(directory, 'archive.zip'),
      format: 'zip',
      password: 'hunter2',
      encryptFileNames: true
    })).rejects.toThrow('7Z archives only')
    await expect(compressArchive({
      inputPaths: [sourceDir],
      outputPath: path.join(directory, 'archive.gz'),
      format: 'gz'
    })).rejects.toThrow('single files only')
  })

  it('excludes the archive from its own input when it is written inside the compressed folder', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir, { recursive: true })

    // Incompressible payload, and an output name that sorts after it so the
    // directory walk reaches the archive only once it has grown. That is the
    // real-world shape of this bug: the default save location is the folder
    // being compressed, so the walk streams the half-written archive into
    // itself, the read never hits EOF, and the job stalls forever.
    const payloadSize = 2 * 1024 * 1024
    for (const name of ['a-data.bin', 'b-data.bin', 'c-data.bin']) {
      await fs.writeFile(path.join(sourceDir, name), crypto.randomBytes(payloadSize))
    }
    const outputPath = path.join(sourceDir, 'z-archive.zip')

    const result = await compressArchive({ inputPaths: [sourceDir], outputPath, format: 'zip' })

    const entryPaths = (await inspectArchive(outputPath)).entries.map(entry => entry.path)
    expect(entryPaths).toEqual(
      expect.arrayContaining(['source/a-data.bin', 'source/b-data.bin', 'source/c-data.bin'])
    )
    expect(entryPaths).not.toContain('source/z-archive.zip')
    // Total omits the archive itself, so progress stays a meaningful fraction.
    expect(result.originalSize).toBe(payloadSize * 3)
  }, 30000)

  it('rejects immediately when the signal is already aborted', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'file.txt')
    await fs.writeFile(inputPath, 'data')
    const outputPath = path.join(directory, 'archive.zip')
    const controller = new AbortController()
    controller.abort()

    await expect(
      compressArchive({ inputPaths: [inputPath], outputPath, format: 'zip' }, undefined, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'CompressionError', code: 'COMPRESSION_CANCELLED' })
    await expect(fs.stat(outputPath)).rejects.toThrow()
  })

  it('cancels a ZIP compression mid-stream and removes the partial output', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir, { recursive: true })
    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      await fs.writeFile(path.join(sourceDir, name), crypto.randomBytes(64 * 1024))
    }
    const outputPath = path.join(directory, 'archive.zip')
    const controller = new AbortController()

    const promise = compressArchive(
      { inputPaths: [sourceDir], outputPath, format: 'zip' },
      () => controller.abort(),
      { signal: controller.signal }
    )

    await expect(promise).rejects.toMatchObject({ name: 'CompressionError', code: 'COMPRESSION_CANCELLED' })
    await expect(fs.stat(outputPath)).rejects.toThrow()
  })

  it('cancels a GZ compression mid-stream and removes the partial output', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'report.bin')
    const outputPath = path.join(directory, 'report.bin.gz')
    await fs.writeFile(inputPath, crypto.randomBytes(5 * 1024 * 1024))
    const controller = new AbortController()

    const promise = compressArchive(
      { inputPaths: [inputPath], outputPath, format: 'gz' },
      () => controller.abort(),
      { signal: controller.signal }
    )

    await expect(promise).rejects.toMatchObject({ name: 'CompressionError', code: 'COMPRESSION_CANCELLED' })
    await expect(fs.stat(outputPath)).rejects.toThrow()
  })
})

describe('7z compression', () => {
  it('writes a readable archive and reports its size', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(path.join(sourceDir, 'docs'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'docs', 'guide.txt'), 'guide contents')
    const outputPath = path.join(directory, 'archive.7z')

    const result = await compressArchive({ inputPaths: [sourceDir], outputPath, format: '7z' })

    expect(result.outputPath).toBe(outputPath)
    expect(result.compressedSize).toBeGreaterThan(0)
    const listing = await inspectArchive(outputPath)
    expect(listing.entries.some(entry => entry.path.endsWith('guide.txt'))).toBe(true)
  }, 60_000)

  it('reports progress that finishes at complete', async () => {
    const directory = await createTemporaryDirectory()
    const sourcePath = path.join(directory, 'payload.bin')
    await fs.writeFile(sourcePath, Buffer.alloc(2 * 1024 * 1024, 7))
    const outputPath = path.join(directory, 'progress.7z')

    const updates: ProgressData[] = []
    await compressArchive({ inputPaths: [sourcePath], outputPath, format: '7z' }, data => updates.push(data))

    expect(updates.at(-1)).toMatchObject({ phase: 'complete', percent: 100 })
    expect(updates.every(update => (update.percent ?? 0) <= 100)).toBe(true)
  }, 60_000)

  it('passes expert dictionary and solid-block options to the 7Z writer', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'alpha.txt'), 'alpha '.repeat(2_000))
    await fs.writeFile(path.join(sourceDir, 'bravo.txt'), 'bravo '.repeat(2_000))
    const outputPath = path.join(directory, 'solid.7z')

    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: '7z',
      sevenZipMethod: 'lzma2',
      dictionarySize: 4 * 1024 * 1024,
      matchFinderWordSize: 64,
      searchCycles: 48,
      solidArchive: true
    })

    const inspected = await inspectArchive(outputPath)
    expect(inspected.headerInfo).toMatchObject({ solid: true, formatVersion: '0.4' })
    expect(inspected.entries.filter(entry => !entry.isDirectory)).toEqual(expect.arrayContaining([
      expect.objectContaining({ codec: 'LZMA2 [4 MB]' })
    ]))
  }, 60_000)

  it.each([false, true])('creates an encrypted 7z with hidden names=%s', async encryptFileNames => {
    const directory = await createTemporaryDirectory()
    const sourcePath = path.join(directory, 'secret.txt')
    const contents = 'secret contents\n'.repeat(500)
    await fs.writeFile(sourcePath, contents)
    const outputPath = path.join(directory, 'enc.7z')

    await compressArchive({
      inputPaths: [sourcePath],
      outputPath,
      format: '7z',
      password: 'hunter2',
      encryptFileNames
    })

    if (encryptFileNames) {
      // Listing itself needs the password once the header is encrypted.
      await expect(inspectArchive(outputPath)).rejects.toMatchObject({ code: 'SEVEN_ZIP_PASSWORD_REQUIRED' })
    } else {
      const listing = await inspectArchive(outputPath)
      expect(listing.entries.map(entry => entry.path)).toEqual(['secret.txt'])
      expect(listing.passwordProtected).toBe(true)
    }
    const listing = await inspectArchive(outputPath, { password: 'hunter2' })
    expect(listing.entries.map(entry => entry.path)).toEqual(['secret.txt'])

    const targetDir = path.join(directory, 'out')
    await extractArchive({ archivePath: outputPath, targetDir, password: 'hunter2' })
    await expect(fs.readFile(path.join(targetDir, 'secret.txt'), 'utf8')).resolves.toBe(contents)

    await expect(extractArchive({
      archivePath: outputPath,
      targetDir: path.join(directory, 'bad'),
      password: 'wrong'
    })).rejects.toMatchObject({ code: 'SEVEN_ZIP_WRONG_PASSWORD' })
  }, 120_000)

  it('splits into numbered volumes and returns the first one', async () => {
    const directory = await createTemporaryDirectory()
    const sourcePath = path.join(directory, 'big.bin')
    await fs.writeFile(sourcePath, Buffer.alloc(5 * 1024 * 1024).map(() => Math.floor(Math.random() * 256)))
    const outputPath = path.join(directory, 'set.7z')

    const result = await compressArchive({
      inputPaths: [sourcePath],
      outputPath,
      format: '7z',
      level: 0,
      splitSize: MIN_SPLIT_SIZE
    })

    // The opposite of ZIP, where the terminal volume is the one that opens.
    expect(result.outputPath).toBe(`${outputPath}.001`)
    expect(result.volumePaths?.length).toBeGreaterThan(1)
    expect(result.compressedSize).toBeGreaterThan(MIN_SPLIT_SIZE)
    await expect(inspectArchive(result.outputPath)).resolves.toMatchObject({ format: '7Z' })
  }, 120_000)

  it('clears a previous run so 7-Zip cannot append to it', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'first.txt'), 'first')
    const outputPath = path.join(directory, 'again.7z')
    await compressArchive({ inputPaths: [sourceDir], outputPath, format: '7z' })

    await fs.rm(path.join(sourceDir, 'first.txt'))
    await fs.writeFile(path.join(sourceDir, 'second.txt'), 'second')
    await compressArchive({ inputPaths: [sourceDir], outputPath, format: '7z' })

    const paths = (await inspectArchive(outputPath)).entries.map(entry => path.basename(entry.path))
    expect(paths).toContain('second.txt')
    expect(paths).not.toContain('first.txt')
  }, 60_000)

  it('keeps the archive out of its own input tree', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'a.bin'), Buffer.alloc(512 * 1024, 3))
    // The archive is written inside the folder being compressed, which is what
    // the default save location does.
    const outputPath = path.join(sourceDir, 'self.7z')

    await compressArchive({ inputPaths: [sourceDir], outputPath, format: '7z' })

    const paths = (await inspectArchive(outputPath)).entries.map(entry => path.basename(entry.path))
    expect(paths).not.toContain('self.7z')
  }, 60_000)
})

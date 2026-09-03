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
import { supportsZstd } from './zip/codecs'

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

  it('creates readable AES-128 with a per-file Deflate strategy and Store ZIP archives', async () => {
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
      encryptionMethod: 'aes128',
      zipMethodOverrides: [{
        sourcePath: inputPath,
        scope: 'file',
        method: 'deflate',
        deflateStrategy: 'rle',
        level: 9
      }]
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

describe('storing what compression cannot help', () => {
  /** A directory holding one entry of each kind the per-entry rule sorts. */
  async function createMixedSource(directory: string): Promise<string> {
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'notes.txt'), 'the quick brown fox\n'.repeat(500))
    await fs.writeFile(path.join(sourceDir, 'tiny.txt'), 'hello')
    await fs.writeFile(path.join(sourceDir, 'photo.jpg'), crypto.randomBytes(64 * 1024))
    return sourceDir
  }

  function codecsByName(entries: { path: string; codec?: string }[]): Record<string, string | undefined> {
    return Object.fromEntries(entries.map(entry => [path.basename(entry.path), entry.codec]))
  }

  it('stores the already-compressed and the too-small, and deflates the rest', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createMixedSource(directory)
    const outputPath = path.join(directory, 'mixed.zip')

    await compressArchive({ inputPaths: [sourceDir], outputPath, format: 'zip' })

    const inspected = await inspectArchive(outputPath)
    expect(codecsByName(inspected.entries.filter(entry => !entry.isDirectory))).toEqual({
      'notes.txt': 'Deflate',
      'tiny.txt': 'Store',
      'photo.jpg': 'Store'
    })

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath: outputPath, targetDir: outputDir })
    await expect(fs.readFile(path.join(outputDir, 'source', 'tiny.txt'), 'utf8')).resolves.toBe('hello')
  })

  it('sorts a file named on its own the same way a walked one is', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createMixedSource(directory)
    const outputPath = path.join(directory, 'listed.zip')

    await compressArchive({
      inputPaths: [
        path.join(sourceDir, 'notes.txt'),
        path.join(sourceDir, 'tiny.txt'),
        path.join(sourceDir, 'photo.jpg')
      ],
      outputPath,
      format: 'zip'
    })

    const inspected = await inspectArchive(outputPath)
    expect(codecsByName(inspected.entries)).toEqual({
      'notes.txt': 'Deflate',
      'tiny.txt': 'Store',
      'photo.jpg': 'Store'
    })
  })

  // The zip.js writer, reached here by asking for a method archiver cannot
  // write. A stored entry has to drop the archive's codec, not just its level.
  it('stores them under LZMA too, and keeps the archive readable', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createMixedSource(directory)
    const outputPath = path.join(directory, 'lzma.zip')

    await compressArchive({ inputPaths: [sourceDir], outputPath, format: 'zip', zipMethod: 'lzma' })

    const inspected = await inspectArchive(outputPath)
    expect(codecsByName(inspected.entries.filter(entry => !entry.isDirectory))).toEqual({
      'notes.txt': 'LZMA',
      'tiny.txt': 'Store',
      'photo.jpg': 'Store'
    })

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath: outputPath, targetDir: outputDir })
    await expect(fs.readFile(path.join(outputDir, 'source', 'tiny.txt'), 'utf8')).resolves.toBe('hello')
  })

  // ZipCrypto is written by archiver's encryption plugin, which takes a
  // different path through its stream for a stored entry than a deflated one.
  it('round-trips a stored entry through ZipCrypto', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createMixedSource(directory)
    const outputPath = path.join(directory, 'secret.zip')

    await compressArchive({ inputPaths: [sourceDir], outputPath, format: 'zip', password: 'hunter2' })

    const inspected = await inspectArchive(outputPath, { password: 'hunter2' })
    expect(codecsByName(inspected.entries.filter(entry => !entry.isDirectory))).toEqual({
      'notes.txt': 'Deflate',
      'tiny.txt': 'Store',
      'photo.jpg': 'Store'
    })

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath: outputPath, targetDir: outputDir, password: 'hunter2' })
    await expect(fs.readFile(path.join(outputDir, 'source', 'tiny.txt'), 'utf8')).resolves.toBe('hello')
    expect((await fs.readFile(path.join(outputDir, 'source', 'photo.jpg'))).equals(
      await fs.readFile(path.join(sourceDir, 'photo.jpg'))
    )).toBe(true)
  })

  it('leaves every entry alone when Store or level 0 was asked for', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await createMixedSource(directory)
    const outputPath = path.join(directory, 'stored.zip')

    await compressArchive({ inputPaths: [sourceDir], outputPath, format: 'zip', zipMethod: 'store' })

    const inspected = await inspectArchive(outputPath)
    for (const entry of inspected.entries.filter(entry => !entry.isDirectory)) {
      expect(entry.codec).toBe('Store')
    }
  })
})

describe('per-file ZIP methods', () => {
  it('tunes Automatic per folder and stores only entries whose measured Deflate payload grows', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    const text = Buffer.from('automatic folder tuning '.repeat(3000))
    const noise = crypto.randomBytes(64 * 1024)
    await fs.writeFile(path.join(sourceDir, 'notes.txt'), text)
    await fs.writeFile(path.join(sourceDir, 'noise.bin'), noise)
    const outputPath = path.join(directory, 'automatic-tuned.zip')

    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      zipMethodOverrides: [{
        sourcePath: sourceDir,
        scope: 'tree',
        method: 'auto',
        level: 9,
        deflateStrategy: 'huffman_only'
      }]
    })

    const entries = (await inspectArchive(outputPath)).entries.filter(entry => !entry.isDirectory)
    expect(Object.fromEntries(entries.map(entry => [path.basename(entry.path), entry.codec]))).toEqual({
      'notes.txt': 'Deflate',
      'noise.bin': 'Store'
    })
    expect(entries.find(entry => entry.name === 'notes.txt')?.compressedSize).toBe(zlib.deflateRawSync(text, {
      level: 9,
      strategy: zlib.constants.Z_HUFFMAN_ONLY
    }).length)
  })

  it.runIf(supportsZstd())('writes Store, Deflate, LZMA, and Zstandard entries in one archive', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    const sources = {
      'stored.txt': 'stored bytes',
      'forced.jpg': 'a JPEG name that should still be explicitly deflated '.repeat(100),
      'automatic.png': 'compressible content despite its extension '.repeat(100),
      'lzma.txt': 'lzma content '.repeat(200),
      'zstd.txt': 'zstandard content '.repeat(200)
    }
    await Promise.all(Object.entries(sources).map(([name, contents]) => fs.writeFile(path.join(sourceDir, name), contents)))
    const outputPath = path.join(directory, 'mixed-methods.zip')

    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 6,
      zipMethod: 'deflate',
      zipMethodOverrides: [
        { sourcePath: path.join(sourceDir, 'stored.txt'), scope: 'file', method: 'store' },
        { sourcePath: path.join(sourceDir, 'forced.jpg'), scope: 'file', method: 'deflate' },
        { sourcePath: path.join(sourceDir, 'lzma.txt'), scope: 'file', method: 'lzma' },
        { sourcePath: path.join(sourceDir, 'zstd.txt'), scope: 'file', method: 'zstd' }
      ]
    })

    const inspected = await inspectArchive(outputPath)
    expect(Object.fromEntries(inspected.entries.filter(entry => !entry.isDirectory).map(entry => [path.basename(entry.path), entry.codec]))).toEqual({
      'stored.txt': 'Store',
      'forced.jpg': 'Deflate',
      'automatic.png': 'Deflate',
      'lzma.txt': 'LZMA',
      'zstd.txt': 'Zstd'
    })

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath: outputPath, targetDir: outputDir })
    for (const [name, contents] of Object.entries(sources)) {
      await expect(fs.readFile(path.join(outputDir, 'source', name), 'utf8')).resolves.toBe(contents)
    }
  })

  it('applies a recursive folder method while allowing a file exception', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const nestedDir = path.join(sourceDir, 'nested')
    await fs.mkdir(nestedDir, { recursive: true })
    await fs.writeFile(path.join(nestedDir, 'compressed.txt'), 'compress me '.repeat(200))
    await fs.writeFile(path.join(nestedDir, 'plain.txt'), 'leave me plain')
    const outputPath = path.join(directory, 'folder-rules.zip')

    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      zipMethodOverrides: [
        { sourcePath: sourceDir, scope: 'tree', method: 'lzma' },
        { sourcePath: path.join(nestedDir, 'plain.txt'), scope: 'file', method: 'store' }
      ]
    })

    const inspected = await inspectArchive(outputPath)
    expect(Object.fromEntries(inspected.entries.filter(entry => !entry.isDirectory).map(entry => [path.basename(entry.path), entry.codec]))).toEqual({
      'compressed.txt': 'LZMA',
      'plain.txt': 'Store'
    })
  })

  it('applies each Deflate strategy to the individual entry that selected it', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    const contents = Buffer.from('aaaaabbbbbcccccdddddeeeee-0123456789\n'.repeat(2000))
    const strategies = [
      ['default', zlib.constants.Z_DEFAULT_STRATEGY],
      ['filtered', zlib.constants.Z_FILTERED],
      ['huffman_only', zlib.constants.Z_HUFFMAN_ONLY],
      ['rle', zlib.constants.Z_RLE],
      ['fixed', zlib.constants.Z_FIXED]
    ] as const
    const sourcePaths = Object.fromEntries(strategies.map(([strategy]) => [
      strategy,
      path.join(sourceDir, `${strategy}.txt`)
    ]))
    await Promise.all(Object.values(sourcePaths).map(sourcePath => fs.writeFile(sourcePath, contents)))
    const outputPath = path.join(directory, 'deflate-strategies.zip')

    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 6,
      zipMethodOverrides: strategies.map(([strategy]) => ({
        sourcePath: sourcePaths[strategy],
        scope: 'file',
        method: 'deflate',
        deflateStrategy: strategy
      }))
    })

    const inspected = await inspectArchive(outputPath)
    const compressedSizes = Object.fromEntries(inspected.entries
      .filter(entry => !entry.isDirectory)
      .map(entry => [path.basename(entry.path, '.txt'), entry.compressedSize]))
    expect(compressedSizes).toEqual(Object.fromEntries(strategies.map(([strategy, zlibStrategy]) => [
      strategy,
      zlib.deflateRawSync(contents, { level: 6, strategy: zlibStrategy }).length
    ])))

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath: outputPath, targetDir: outputDir })
    for (const strategy of strategies.map(([name]) => name)) {
      await expect(fs.readFile(path.join(outputDir, 'source', `${strategy}.txt`))).resolves.toEqual(contents)
    }
  })

  it('applies compression strength independently to each ZIP entry', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    const contents = Buffer.from('per-file compression strength 000000111111222222333333\n'.repeat(300))
    const levels = [1, 6, 9]
    const sourcePaths = Object.fromEntries(levels.map(level => [
      level,
      path.join(sourceDir, `level-${level}.txt`)
    ]))
    await Promise.all(Object.values(sourcePaths).map(sourcePath => fs.writeFile(sourcePath, contents)))
    const outputPath = path.join(directory, 'compression-strengths.zip')

    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 3,
      zipMethodOverrides: levels.map(level => ({
        sourcePath: sourcePaths[level],
        scope: 'file',
        method: 'deflate',
        level
      }))
    })

    const inspected = await inspectArchive(outputPath)
    expect(Object.fromEntries(inspected.entries
      .filter(entry => !entry.isDirectory)
      .map(entry => [path.basename(entry.path, '.txt'), entry.compressedSize])))
      .toEqual(Object.fromEntries(levels.map(level => [
        `level-${level}`,
        zlib.deflateRawSync(contents, { level }).length
      ])))

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath: outputPath, targetDir: outputDir })
    for (const level of levels) {
      await expect(fs.readFile(path.join(outputDir, 'source', `level-${level}.txt`))).resolves.toEqual(contents)
    }
  })

  it('applies memory level independently to each ZIP entry', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    const contents = Buffer.from('per-file memory tuning aaaabbbbccccdddd-0123456789\n'.repeat(2000))
    const memoryLevels = [1, 9]
    const sourcePaths = Object.fromEntries(memoryLevels.map(memLevel => [
      memLevel,
      path.join(sourceDir, `memory-${memLevel}.txt`)
    ]))
    await Promise.all(Object.values(sourcePaths).map(sourcePath => fs.writeFile(sourcePath, contents)))
    const outputPath = path.join(directory, 'memory-levels.zip')

    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 6,
      zipMethodOverrides: memoryLevels.map(memLevel => ({
        sourcePath: sourcePaths[memLevel],
        scope: 'file',
        method: 'deflate',
        memLevel
      }))
    })

    const inspected = await inspectArchive(outputPath)
    expect(Object.fromEntries(inspected.entries
      .filter(entry => !entry.isDirectory)
      .map(entry => [path.basename(entry.path, '.txt'), entry.compressedSize])))
      .toEqual(Object.fromEntries(memoryLevels.map(memLevel => [
        `memory-${memLevel}`,
        zlib.deflateRawSync(contents, { level: 6, memLevel }).length
      ])))

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath: outputPath, targetDir: outputDir })
    for (const memLevel of memoryLevels) {
      await expect(fs.readFile(path.join(outputDir, 'source', `memory-${memLevel}.txt`))).resolves.toEqual(contents)
    }
  })

  it('keeps automatic entries stored at level zero while compressing an explicit file at the minimum strength', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    const compressedPath = path.join(sourceDir, 'compressed.txt')
    const storedPath = path.join(sourceDir, 'automatic.txt')
    const contents = Buffer.from('minimum per-file strength '.repeat(2000))
    await Promise.all([fs.writeFile(compressedPath, contents), fs.writeFile(storedPath, contents)])
    const outputPath = path.join(directory, 'store-with-exception.zip')

    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: 'zip',
      level: 0,
      zipMethodOverrides: [{ sourcePath: compressedPath, scope: 'file', method: 'deflate' }]
    })

    const entries = (await inspectArchive(outputPath)).entries.filter(entry => !entry.isDirectory)
    expect(Object.fromEntries(entries.map(entry => [path.basename(entry.path), entry.codec]))).toEqual({
      'compressed.txt': 'Deflate',
      'automatic.txt': 'Store'
    })
    expect(entries.find(entry => entry.name === 'compressed.txt')?.compressedSize)
      .toBe(zlib.deflateRawSync(contents, { level: 1 }).length)
  })

  it('rejects ZIP method rules for another archive format', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'input.txt')
    await fs.writeFile(inputPath, 'content')

    await expect(compressArchive({
      inputPaths: [inputPath],
      outputPath: path.join(directory, 'archive.tar'),
      format: 'tar',
      zipMethodOverrides: [{ sourcePath: inputPath, scope: 'file', method: 'store' }]
    })).rejects.toThrow(/ZIP method overrides/)
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

  it('applies a directory method while allowing a file exception', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const nestedDir = path.join(sourceDir, 'nested')
    await fs.mkdir(nestedDir, { recursive: true })
    const compressedPath = path.join(nestedDir, 'compressed.txt')
    const copiedPath = path.join(nestedDir, 'copied.txt')
    await fs.writeFile(compressedPath, 'compress this entry '.repeat(400))
    await fs.writeFile(copiedPath, 'copy this entry unchanged')
    const outputPath = path.join(directory, 'per-file-methods.7z')

    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: '7z',
      sevenZipMethodOverrides: [
        { sourcePath: sourceDir, scope: 'tree', method: 'copy' },
        { sourcePath: compressedPath, scope: 'file', method: 'lzma2' }
      ]
    })

    const inspected = await inspectArchive(outputPath)
    expect(Object.fromEntries(inspected.entries
      .filter(entry => !entry.isDirectory)
      .map(entry => [path.basename(entry.path), entry.codec?.split(' ')[0]])))
      .toEqual({ 'compressed.txt': 'LZMA2', 'copied.txt': 'Copy' })

    const targetDir = path.join(directory, 'out')
    await extractArchive({ archivePath: outputPath, targetDir })
    await expect(fs.readFile(path.join(targetDir, 'source', 'nested', 'compressed.txt'), 'utf8'))
      .resolves.toBe('compress this entry '.repeat(400))
    await expect(fs.readFile(path.join(targetDir, 'source', 'nested', 'copied.txt'), 'utf8'))
      .resolves.toBe('copy this entry unchanged')
  }, 60_000)

  it('uses Copy for an Automatic entry only when its measured LZMA2 payload grows', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'notes.txt'), 'automatic lzma2 '.repeat(400))
    await fs.writeFile(path.join(sourceDir, 'noise.bin'), crypto.randomBytes(8 * 1024))
    const outputPath = path.join(directory, 'automatic-methods.7z')

    await compressArchive({
      inputPaths: [sourceDir],
      outputPath,
      format: '7z',
      sevenZipMethodOverrides: [{ sourcePath: sourceDir, scope: 'tree', method: 'auto' }]
    })

    const inspected = await inspectArchive(outputPath)
    expect(Object.fromEntries(inspected.entries
      .filter(entry => !entry.isDirectory)
      .map(entry => [path.basename(entry.path), entry.codec?.split(' ')[0]])))
      .toEqual({ 'noise.bin': 'Copy', 'notes.txt': 'LZMA2' })
  }, 60_000)

  it('rejects 7Z method rules for another archive format', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'input.txt')
    await fs.writeFile(inputPath, 'content')

    await expect(compressArchive({
      inputPaths: [inputPath],
      outputPath: path.join(directory, 'archive.zip'),
      format: 'zip',
      sevenZipMethodOverrides: [{ sourcePath: inputPath, scope: 'file', method: 'copy' }]
    })).rejects.toThrow(/7Z codec options/)
  })

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

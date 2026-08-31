import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { compressArchive } from '../compressor'
import { inspectArchive } from '../archiveInspector'
import { extractArchive } from '../extractor'
import { MIN_SPLIT_SIZE } from './splitWriter'
import {
  assertEntryFits,
  LZMA_MAX_ENTRY_SIZE,
  supportsZstd,
  ZIP_LZMA_METHOD,
  ZIP_ZSTD_METHOD
} from './codecs'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-zip-codecs-'))
  temporaryDirectories.push(directory)
  return directory
}

// Repetitive enough that a real codec beats Store, and long enough to run the
// encoders past a single match.
const payload = 'The quick brown fox jumps over the lazy dog. '.repeat(400)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('ZIP codecs', () => {
  it('declares the method numbers the ZIP headers carry', () => {
    expect(ZIP_LZMA_METHOD).toBe(14)
    expect(ZIP_ZSTD_METHOD).toBe(93)
  })

  it('writes an LZMA archive the app reads back', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'payload.txt')
    const archivePath = path.join(directory, 'lzma.zip')
    await fs.writeFile(inputPath, payload)

    await compressArchive({
      inputPaths: [inputPath],
      outputPath: archivePath,
      format: 'zip',
      zipMethod: 'lzma'
    })

    const inspected = await inspectArchive(archivePath)
    expect(inspected.entries[0]).toMatchObject({ codec: 'LZMA' })
    expect(inspected.entries[0].compressedSize).toBeLessThan(Buffer.byteLength(payload))

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath, targetDir: outputDir })
    await expect(fs.readFile(path.join(outputDir, 'payload.txt'), 'utf8')).resolves.toBe(payload)
  })

  it('writes an LZMA archive alongside a password', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'payload.txt')
    const archivePath = path.join(directory, 'lzma-aes.zip')
    await fs.writeFile(inputPath, payload)

    await compressArchive({
      inputPaths: [inputPath],
      outputPath: archivePath,
      format: 'zip',
      zipMethod: 'lzma',
      password: 'hunter2',
      encryptionMethod: 'aes256'
    })

    const inspected = await inspectArchive(archivePath)
    expect(inspected.entries[0]).toMatchObject({ codec: 'LZMA', encrypted: true })

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath, targetDir: outputDir, password: 'hunter2' })
    await expect(fs.readFile(path.join(outputDir, 'payload.txt'), 'utf8')).resolves.toBe(payload)
  })

  it.runIf(supportsZstd())('writes a Zstandard archive the app reads back', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'payload.txt')
    const archivePath = path.join(directory, 'zstd.zip')
    await fs.writeFile(inputPath, payload)

    await compressArchive({
      inputPaths: [inputPath],
      outputPath: archivePath,
      format: 'zip',
      zipMethod: 'zstd'
    })

    const inspected = await inspectArchive(archivePath)
    expect(inspected.entries[0]).toMatchObject({ codec: 'Zstd' })
    expect(inspected.entries[0].compressedSize).toBeLessThan(Buffer.byteLength(payload))

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath, targetDir: outputDir })
    await expect(fs.readFile(path.join(outputDir, 'payload.txt'), 'utf8')).resolves.toBe(payload)
  })

  it('keeps a directory tree intact through a non-Deflate method', async () => {
    const directory = await createTemporaryDirectory()
    const treeRoot = path.join(directory, 'tree')
    await fs.mkdir(path.join(treeRoot, 'nested'), { recursive: true })
    await fs.writeFile(path.join(treeRoot, 'top.txt'), payload)
    await fs.writeFile(path.join(treeRoot, 'nested', 'deep.txt'), 'a smaller file')

    const archivePath = path.join(directory, 'tree.zip')
    await compressArchive({
      inputPaths: [treeRoot],
      outputPath: archivePath,
      format: 'zip',
      zipMethod: 'lzma'
    })

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath, targetDir: outputDir })
    await expect(fs.readFile(path.join(outputDir, 'tree', 'top.txt'), 'utf8')).resolves.toBe(payload)
    await expect(fs.readFile(path.join(outputDir, 'tree', 'nested', 'deep.txt'), 'utf8')).resolves.toBe('a smaller file')
  })

  it('carries a registered codec across a split set', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'big.bin')
    // Incompressible on purpose: LZMA cannot shrink it under the volume size,
    // so the set really does span more than one volume.
    const noise = crypto.randomBytes(3 * MIN_SPLIT_SIZE)
    await fs.writeFile(inputPath, noise)
    const outputPath = path.join(directory, 'set.zip')

    const result = await compressArchive({
      inputPaths: [inputPath],
      outputPath,
      format: 'zip',
      zipMethod: 'lzma',
      level: 1,
      splitSize: MIN_SPLIT_SIZE
    })
    expect(result.volumePaths?.length).toBeGreaterThan(1)

    const outputDir = path.join(directory, 'out')
    await extractArchive({ archivePath: result.outputPath, targetDir: outputDir })
    expect(await fs.readFile(path.join(outputDir, 'big.bin'))).toEqual(noise)
  }, 120_000)

  it('names the limit rather than letting a huge entry fail on allocation', () => {
    expect(() => assertEntryFits(LZMA_MAX_ENTRY_SIZE, 'compression')).not.toThrow()
    expect(() => assertEntryFits(undefined, 'compression')).not.toThrow()
    expect(() => assertEntryFits(LZMA_MAX_ENTRY_SIZE + 1, 'compression'))
      .toThrow(/limited to 1024 MB per file/)
  })

  it('rejects deflate tuning that the chosen method cannot use', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'payload.txt')
    await fs.writeFile(inputPath, payload)

    await expect(compressArchive({
      inputPaths: [inputPath],
      outputPath: path.join(directory, 'bad.zip'),
      format: 'zip',
      zipMethod: 'lzma',
      deflateStrategy: 'rle'
    })).rejects.toThrow(/Deflate method/)
  })
})

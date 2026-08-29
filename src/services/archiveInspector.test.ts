import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import * as tar from 'tar'
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { referenceSevenZipFixture } from '../lib/libera7z/referenceFixtures.testData'
import { compressArchive } from './compressor'
import { inspectArchive } from './archiveInspector'
import { writeLibera7z } from './libera7zNode'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-inspector-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('inspectArchive', () => {
  it('reports ZIP entry metadata and password protection', async () => {
    const directory = await createTemporaryDirectory()
    const sourcePath = path.join(directory, 'secret.txt')
    const archivePath = path.join(directory, 'secret.zip')
    const contents = 'secret contents'
    await fs.writeFile(sourcePath, contents)
    await compressArchive({
      inputPaths: [sourcePath],
      outputPath: archivePath,
      format: 'zip',
      password: 'password'
    })

    const result = await inspectArchive(archivePath)

    expect(result).toMatchObject({
      format: 'ZIP',
      passwordProtected: true,
      totalFiles: 1,
      totalUncompressedSize: Buffer.byteLength(contents)
    })
    expect(result.entries).toContainEqual(expect.objectContaining({
      path: 'secret.txt',
      name: 'secret.txt',
      isDirectory: false,
      size: Buffer.byteLength(contents),
      codec: 'Deflate',
      encryptionMethod: 'ZipCrypto',
      crc32: expect.stringMatching(/^0x[0-9A-F]{8}$/),
      offset: expect.any(Number)
    }))
    expect(result.headerInfo).toMatchObject({
      signature: expect.stringContaining('(ZIP)'),
      formatVersion: expect.any(String),
      encryptionAlgorithm: 'ZipCrypto',
      solid: false,
      centralDirectoryOffset: expect.any(Number),
      centralDirectorySize: expect.any(Number)
    })
  })

  it.each([
    ['library.jar', 'JAR'],
    ['webapp.war', 'WAR']
  ] as const)('reports %s as its own format while reading it as a ZIP', async (archiveName, expectedFormat) => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const zipPath = path.join(directory, 'archive.zip')
    const archivePath = path.join(directory, archiveName)
    await fs.mkdir(path.join(sourceDir, 'META-INF'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'META-INF', 'MANIFEST.MF'), 'Manifest-Version: 1.0\n')
    await compressArchive({ inputPaths: [sourceDir], outputPath: zipPath, format: 'zip' })
    await fs.rename(zipPath, archivePath)

    const result = await inspectArchive(archivePath)

    expect(result.format).toBe(expectedFormat)
    expect(result.passwordProtected).toBe(false)
    expect(result.entries).toContainEqual(expect.objectContaining({
      path: 'source/META-INF/MANIFEST.MF',
      isDirectory: false
    }))
  })

  it.each([
    ['archive.tar', false, 'TAR'],
    ['archive.tgz', true, 'TAR.GZ'],
    ['archive.tar.gz', true, 'TAR.GZ']
  ] as const)('reports %s as %s', async (archiveName, gzip, expectedFormat) => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const archivePath = path.join(directory, archiveName)
    await fs.mkdir(path.join(sourceDir, 'docs'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'docs', 'guide.txt'), 'guide')
    await tar.c({ cwd: sourceDir, file: archivePath, gzip }, ['docs'])

    const result = await inspectArchive(archivePath)

    expect(result.format).toBe(expectedFormat)
    expect(result.totalFiles).toBe(1)
    expect(result.entries).toContainEqual(expect.objectContaining({
      path: 'docs/guide.txt',
      isDirectory: false,
      size: Buffer.byteLength('guide')
    }))
    expect(result.entries).toContainEqual(expect.objectContaining({
      path: 'docs/',
      isDirectory: true
    }))
  })

  it('reports GZ uncompressed size as unknown because ISIZE wraps above 4 GiB', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'notes.txt.gz')
    const contents = 'gzip contents'
    await fs.writeFile(archivePath, zlib.gzipSync(contents))

    const result = await inspectArchive(archivePath)

    expect(result).toMatchObject({
      format: 'GZ',
      totalFiles: 1,
      totalUncompressedSize: null,
      overallRatio: null
    })
    expect(result.entries).toEqual([expect.objectContaining({
      name: 'notes.txt',
      path: 'notes.txt',
      size: null,
      ratio: null
    })])
  })

  it('inspects a ZIP64 archive without loading entry contents', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'zip64.zip')
    const output = new Uint8ArrayWriter()
    const writer = new ZipWriter(output, { zip64: true, useWebWorkers: false })
    await writer.add('docs/readme.txt', new TextReader('zip64 contents'))
    const archive = await writer.close(undefined, { zip64: true })
    await fs.writeFile(archivePath, archive)

    const result = await inspectArchive(archivePath)

    expect(result).toMatchObject({ format: 'ZIP', totalFiles: 1 })
    expect(result.entries).toContainEqual(expect.objectContaining({
      path: 'docs/readme.txt',
      size: Buffer.byteLength('zip64 contents')
    }))
  })

  it('rejects missing files and unsupported extensions', async () => {
    const directory = await createTemporaryDirectory()
    const textPath = path.join(directory, 'not-an-archive.txt')
    await fs.writeFile(textPath, 'plain text')

    await expect(inspectArchive(path.join(directory, 'missing.zip'))).rejects.toThrow('File does not exist')
    await expect(inspectArchive(textPath)).rejects.toThrow('Unsupported archive format')
  })
})

describe('inspectArchive for 7z', () => {
  it('reports entries, sizes and the executable bit', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(path.join(sourceDir, 'docs'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'docs', 'guide.txt'), 'guide')
    await fs.writeFile(path.join(sourceDir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    const archivePath = path.join(directory, 'archive.7z')
    await writeLibera7z({ inputPaths: [sourceDir], outputPath: archivePath, level: 1 })

    const result = await inspectArchive(archivePath)

    expect(result).toMatchObject({ format: '7Z', passwordProtected: false, totalFiles: 2 })
    expect(result.entries.map(entry => path.basename(entry.path))).toEqual(
      expect.arrayContaining(['docs', 'guide.txt', 'run.sh'])
    )
    expect(result.entries.find(entry => entry.path.endsWith('guide.txt'))).toMatchObject({
      isDirectory: false,
      size: 5,
      compressedSize: expect.any(Number),
      ratio: expect.any(Number),
      codec: expect.stringMatching(/^LZMA2 \[/)
    })
    expect(result.headerInfo).toMatchObject({ formatVersion: '0.4', solid: false })
  }, 60_000)

  it('detects codec and solid-block metadata from an external 7Z archive', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'solid.7z')
    await fs.writeFile(archivePath, referenceSevenZipFixture('solid'))

    const result = await inspectArchive(archivePath)
    expect(result.headerInfo).toMatchObject({ solid: true })
    const files = result.entries.filter(entry => !entry.isDirectory)
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ codec: expect.stringMatching(/^LZMA2 \[/) })
    ]))
    expect(files.every(entry => entry.compressedSize === undefined && entry.ratio === null)).toBe(true)
  }, 60_000)

  it('assigns positional ids in listing order, which preview resolves against', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await fs.writeFile(path.join(sourceDir, name), name)
    }
    const archivePath = path.join(directory, 'ordered.7z')
    await writeLibera7z({ inputPaths: [sourceDir], outputPath: archivePath, level: 1 })

    const first = await inspectArchive(archivePath)
    const second = await inspectArchive(archivePath)

    expect(first.entries.map(entry => `${entry.id}:${entry.path}`))
      .toEqual(second.entries.map(entry => `${entry.id}:${entry.path}`))
    expect(first.entries.map(entry => entry.id)).toEqual(
      first.entries.map((_, index) => `entry-${index}`)
    )
  }, 60_000)

  it('flags an archive whose entries are encrypted', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'enc.7z')
    await fs.writeFile(archivePath, referenceSevenZipFixture('aes-data'))

    // Headers are readable without a password here, so the listing succeeds
    // and only the entries are marked encrypted.
    const result = await inspectArchive(archivePath)
    expect(result.passwordProtected).toBe(true)
  }, 60_000)

  it('needs a password before it can list a header-encrypted archive', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'hidden.7z')
    await fs.writeFile(archivePath, referenceSevenZipFixture('aes-header'))

    await expect(inspectArchive(archivePath))
      .rejects.toMatchObject({ code: 'SEVEN_ZIP_PASSWORD_REQUIRED' })

    const result = await inspectArchive(archivePath, { password: 'hunter2' })
    expect(result.totalFiles).toBe(1)
  }, 60_000)

  it('reports a split set opened from any volume as one archive', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'big.bin'), Buffer.alloc(200_000).map(() => Math.floor(Math.random() * 256)))
    await writeLibera7z({
      inputPaths: [sourceDir],
      outputPath: path.join(directory, 'set.7z'),
      level: 0,
      splitSize: 30_000
    })

    const result = await inspectArchive(path.join(directory, 'set.7z.003'))

    expect(result.format).toBe('7Z')
    expect(result.volumeCount).toBeGreaterThan(1)
    expect(result.volumes).toHaveLength(result.volumeCount!)
    expect(result.volumes?.map(volume => volume.name)).toEqual(
      Array.from(
        { length: result.volumeCount! },
        (_, index) => `set.7z.${String(index + 1).padStart(3, '0')}`
      )
    )
    expect(result.totalCompressedSize).toBe(
      result.volumes?.reduce((total, volume) => total + volume.size, 0)
    )
    expect(result.entries.some(entry => entry.path.endsWith('big.bin'))).toBe(true)
  }, 60_000)
})

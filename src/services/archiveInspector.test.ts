import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import * as tar from 'tar'
import { compressArchive } from './compressor'
import { inspectArchive } from './archiveInspector'

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
      size: Buffer.byteLength(contents)
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

  it('uses the GZ trailer to report the uncompressed file metadata', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'notes.txt.gz')
    const contents = 'gzip contents'
    await fs.writeFile(archivePath, zlib.gzipSync(contents))

    const result = await inspectArchive(archivePath)

    expect(result).toMatchObject({
      format: 'GZ',
      totalFiles: 1,
      totalUncompressedSize: Buffer.byteLength(contents)
    })
    expect(result.entries).toEqual([expect.objectContaining({
      name: 'notes.txt',
      path: 'notes.txt',
      size: Buffer.byteLength(contents)
    })])
  })

  it('rejects missing files and unsupported extensions', async () => {
    const directory = await createTemporaryDirectory()
    const textPath = path.join(directory, 'not-an-archive.txt')
    await fs.writeFile(textPath, 'plain text')

    await expect(inspectArchive(path.join(directory, 'missing.zip'))).rejects.toThrow('File does not exist')
    await expect(inspectArchive(textPath)).rejects.toThrow('Unsupported archive format')
  })
})

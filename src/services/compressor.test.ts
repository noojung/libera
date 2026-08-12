import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import { calculateTotalSize, compressArchive, type ProgressData } from './compressor'

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
  it('sums files in nested directories without following symbolic links', async () => {
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
      const entryPaths = new AdmZip(outputPath).getEntries().map(entry => entry.entryName)
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

  it('rejects passwords for non-ZIP formats and directory input for GZ', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    await fs.mkdir(sourceDir)

    await expect(compressArchive({
      inputPaths: [],
      outputPath: path.join(directory, 'archive.tar'),
      format: 'tar',
      password: 'not-supported'
    })).rejects.toThrow('ZIP archives only')
    await expect(compressArchive({
      inputPaths: [sourceDir],
      outputPath: path.join(directory, 'archive.gz'),
      format: 'gz'
    })).rejects.toThrow('single files only')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import { strToU8, zipSync } from 'fflate'
import { extractArchive, isSupportedArchivePath } from './extractor'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-extractor-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createZip(archivePath: string, entries: Record<string, string>): Promise<void> {
  const zip = new AdmZip()
  for (const [entryPath, contents] of Object.entries(entries)) {
    zip.addFile(entryPath, Buffer.from(contents))
  }
  zip.writeZip(archivePath)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('extractArchive security checks', () => {
  it('recognizes supported archive extensions case-insensitively', () => {
    expect(isSupportedArchivePath('/tmp/archive.ZIP')).toBe(true)
    expect(isSupportedArchivePath('/tmp/archive.TAR.GZ')).toBe(true)
    expect(isSupportedArchivePath('/tmp/archive.7z')).toBe(false)
  })

  it('extracts a normal ZIP entry inside the target directory', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await createZip(archivePath, { 'docs/readme.txt': 'safe content' })

    await extractArchive({ archivePath, targetDir })

    await expect(fs.readFile(path.join(targetDir, 'docs', 'readme.txt'), 'utf8')).resolves.toBe('safe content')
  })

  it('does not overwrite an existing destination file', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await createZip(archivePath, { 'existing.txt': 'archive content' })
    await fs.mkdir(targetDir)
    await fs.writeFile(path.join(targetDir, 'existing.txt'), 'original content')

    await expect(extractArchive({ archivePath, targetDir })).rejects.toThrow('destination already exists')
    await expect(fs.readFile(path.join(targetDir, 'existing.txt'), 'utf8')).resolves.toBe('original content')
  })

  it('rejects ZIP Slip paths before writing outside the target directory', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    const outsidePath = path.join(directory, 'escape.txt')
    await fs.writeFile(archivePath, zipSync({ '../escape.txt': strToU8('unsafe') }))

    await expect(extractArchive({ archivePath, targetDir })).rejects.toThrow('entry path escapes the destination')
    await expect(fs.access(outsidePath)).rejects.toThrow()
  })

  it('rejects extraction through an existing destination symbolic link', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    const outsideDir = path.join(directory, 'outside')
    await createZip(archivePath, { 'linked/escape.txt': 'unsafe' })
    await fs.mkdir(targetDir)
    await fs.mkdir(outsideDir)
    await fs.symlink(outsideDir, path.join(targetDir, 'linked'))

    await expect(extractArchive({ archivePath, targetDir })).rejects.toThrow('destination parent is a symbolic link')
    await expect(fs.access(path.join(outsideDir, 'escape.txt'))).rejects.toThrow()
  })

  it('rejects TAR symbolic link entries before extraction', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const archivePath = path.join(directory, 'archive.tar')
    const targetDir = path.join(directory, 'output')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'file.txt'), 'content')
    await fs.symlink('file.txt', path.join(sourceDir, 'link.txt'))
    await tar.c({ cwd: sourceDir, file: archivePath }, ['link.txt'])

    await expect(extractArchive({ archivePath, targetDir })).rejects.toThrow('symbolic and hard link entries are not supported')
  })

  it('extracts the descendants of a selected directory from a TAR.GZ archive', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const archivePath = path.join(directory, 'archive.tar.gz')
    const targetDir = path.join(directory, 'output')
    await fs.mkdir(path.join(sourceDir, 'docs'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'docs', 'readme.txt'), 'selected')
    await fs.writeFile(path.join(sourceDir, 'skip.txt'), 'not selected')
    await tar.c({ cwd: sourceDir, file: archivePath, gzip: true }, ['docs', 'skip.txt'])

    await extractArchive({ archivePath, targetDir, selectedEntries: ['docs/'] })

    await expect(fs.readFile(path.join(targetDir, 'docs', 'readme.txt'), 'utf8')).resolves.toBe('selected')
    await expect(fs.access(path.join(targetDir, 'skip.txt'))).rejects.toThrow()
  })

  it('extracts a normal GZ archive', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'document.txt.gz')
    const targetDir = path.join(directory, 'output')
    await fs.writeFile(archivePath, zlib.gzipSync('gzip content'))

    await extractArchive({ archivePath, targetDir })

    await expect(fs.readFile(path.join(targetDir, 'document.txt'), 'utf8')).resolves.toBe('gzip content')
  })
})

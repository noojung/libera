import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { openLibera7zFile, writeLibera7z } from './libera7zNode'
import { listSevenZipEntries } from './sevenZipList'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-7zlist-'))
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

describe('listSevenZipEntries', () => {
  it('reads directories, modes, symlinks and non-ASCII names written by Libera7z', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(path.join(sourceDir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'a.txt'), 'hello')
    await fs.writeFile(path.join(sourceDir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await fs.writeFile(path.join(sourceDir, 'empty.txt'), '')
    await fs.writeFile(path.join(sourceDir, 'sub', '공백 이름.txt'), 'x')
    if (process.platform !== 'win32') await fs.symlink('a.txt', path.join(sourceDir, 'link.txt'))

    const archivePath = path.join(directory, 't.7z')
    await writeLibera7z({ inputPaths: [sourceDir], outputPath: archivePath, level: 1 })

    const listing = await listSevenZipEntries(archivePath)
    const byName = new Map(listing.entries.map(entry => [path.basename(entry.path), entry]))

    expect(byName.get('src')).toMatchObject({ isDirectory: true })
    expect(byName.get('a.txt')).toMatchObject({ isDirectory: false, size: 5 })
    expect(byName.get('empty.txt')).toMatchObject({ size: 0, isDirectory: false })
    if (process.platform !== 'win32') {
      expect(byName.get('a.txt')).toMatchObject({ mode: 0o644 })
      expect(byName.get('run.sh')).toMatchObject({ mode: 0o755, isSymlink: false })
      expect(byName.get('link.txt')).toMatchObject({ isSymlink: true })
    }
    const names = listing.entries.map(entry => path.basename(entry.path).normalize('NFC'))
    expect(names).toContain('공백 이름.txt')
  }, 60_000)

  it('reports the exact decoded size for every file entry', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    for (let index = 1; index <= 20; index += 1) {
      await fs.writeFile(path.join(sourceDir, `f${index}.bin`), Buffer.alloc(index * 37, index))
    }
    const archivePath = path.join(directory, 'many.7z')
    await writeLibera7z({ inputPaths: [sourceDir], outputPath: archivePath, level: 1 })

    const listing = await listSevenZipEntries(archivePath)
    const archive = await openLibera7zFile(archivePath)
    try {
      const decodedSizes = await Promise.all(archive.entries
        .filter(entry => !entry.isDirectory)
        .map(async entry => (await collect(archive.openEntry(entry.id))).length))
      const declared = listing.entries.filter(entry => !entry.isDirectory).map(entry => entry.size)
      expect(decodedSizes).toEqual(declared)
    } finally {
      await archive.close()
    }
  }, 60_000)
})

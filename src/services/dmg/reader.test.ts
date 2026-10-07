import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DmgReader, parseDmgListing } from './reader'
import { dmgFixture } from './testFixture'
import { inspectArchive } from '../archiveInspector'
import { previewArchiveEntry, MAX_ARCHIVE_PREVIEW_BYTES } from '../archivePreview'
import { extractArchive } from '../extractor'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
async function fixture(files: Parameters<typeof dmgFixture>[0] = [{ name: 'hello.txt', data: Buffer.from('Hello DMG!') }]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-dmg-'))
  directories.push(directory)
  const archivePath = path.join(directory, 'archive.DMG')
  await fs.writeFile(archivePath, dmgFixture(files))
  return { archivePath, targetDir: path.join(directory, 'out') }
}
const context = { getAvailableBytes: async () => 10n ** 12n }

describe('DMG WASM integration', () => {
  it('lists, previews and extracts a compressed HFS+ disk image without system utilities', async () => {
    const options = await fixture()
    const inspected = await inspectArchive(options.archivePath)
    expect(inspected.format).toBe('DMG')
    const entry = inspected.entries.find(entry => entry.name === 'hello.txt')!
    expect(entry.size).toBe(10)
    const preview = await previewArchiveEntry(options.archivePath, entry.id)
    expect(preview).toMatchObject({ kind: 'text', text: 'Hello DMG!' })
    expect(await extractArchive(options, undefined, context)).toMatchObject({ extractedCount: 1 })
    expect(await fs.readFile(path.join(options.targetDir, entry.path), 'utf8')).toBe('Hello DMG!')
  })

  it('enforces listing limits and rejects malformed metadata', async () => {
    const { archivePath } = await fixture()
    await expect(DmgReader.open(archivePath, 0)).rejects.toMatchObject({ code: 'TOO_MANY_ENTRIES' })
    expect(() => parseDmgListing('Path = a\nPath = b\nSize = 2', 10)).toThrow('Ambiguous')
  })

  it('rejects invalid images and cancelled operations', async () => {
    const options = await fixture()
    await fs.writeFile(options.archivePath, Buffer.alloc(512))
    await expect(inspectArchive(options.archivePath)).rejects.toThrow('Unsupported DMG')
    await expect(extractArchive(options, undefined, { ...context, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'EXTRACTION_CANCELLED' })
  })

  it('caps text previews and stops the worker while keeping the result', async () => {
    const options = await fixture([{ name: 'large.txt', data: Buffer.alloc(MAX_ARCHIVE_PREVIEW_BYTES + 4096, 65) }])
    const info = await inspectArchive(options.archivePath)
    const entry = info.entries.find(entry => entry.name === 'large.txt')!
    expect(await previewArchiveEntry(options.archivePath, entry.id)).toMatchObject({
      kind: 'text', truncated: true, previewedBytes: MAX_ARCHIVE_PREVIEW_BYTES
    })
  })

  it('selects individual files and supports overwrite policies', async () => {
    const options = await fixture([{ name: 'a*.txt', data: Buffer.from('literal') }, { name: 'abc.txt', data: Buffer.from('other') }])
    const info = await inspectArchive(options.archivePath)
    const selected = info.entries.find(entry => entry.name === 'abc.txt')!
    const selection = { ...options, selectedEntries: [selected.path] }
    await extractArchive(selection, undefined, context)
    await fs.writeFile(path.join(options.targetDir, selected.path), 'keep')
    expect(await extractArchive({ ...selection, overwritePolicy: 'skip' }, undefined, context)).toMatchObject({ extractedCount: 0 })
    expect(await fs.readFile(path.join(options.targetDir, selected.path), 'utf8')).toBe('keep')
    await extractArchive({ ...selection, overwritePolicy: 'overwrite' }, undefined, context)
    expect(await fs.readFile(path.join(options.targetDir, selected.path), 'utf8')).toBe('other')
  })

  it('cancels an active stream promptly and terminates its worker', async () => {
    const options = await fixture([{ name: 'large.txt', data: Buffer.alloc(2 * 1024 * 1024, 65) }])
    const reader = await DmgReader.open(options.archivePath)
    const entry = reader.entries.find(entry => entry.path.endsWith('large.txt'))!
    const controller = new AbortController()
    await expect(reader.read(entry, entry.size, async () => { controller.abort() }, controller.signal))
      .rejects.toMatchObject({ code: 'EXTRACTION_CANCELLED' })
    await reader.close()
  })

  it('excludes external installer shortcuts and restores safe links when supported', async () => {
    const options = await fixture([
      { name: 'hello.txt', data: Buffer.from('hello'), mode: 0o100755 },
      { name: 'internal', data: Buffer.from('hello.txt'), mode: 0o120777 },
      { name: 'Applications', data: Buffer.from('/Applications'), mode: 0o120777 }
    ])
    const result = await extractArchive(options, undefined, context)
    const root = path.join(options.targetDir, 'Fixture')
    await expect(fs.lstat(path.join(root, 'Applications'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform === 'win32') {
      expect(result.symbolicLinksExcluded).toBe(2)
    } else {
      expect(result.symbolicLinksExcluded).toBe(1)
      expect(await fs.readlink(path.join(root, 'internal'))).toBe('hello.txt')
      expect((await fs.stat(path.join(root, 'hello.txt'))).mode & 0o777).toBe(0o755)
    }
  })

  it('reads APFS mode and symbolic-link metadata without a Folder property', () => {
    expect(parseDmgListing('Path = link\nSize = 10\nMode = lrwxrwxrwx\nSymbolic Link = hello.txt\n', 10))
      .toMatchObject([{ path: 'link', isLink: true, linkTarget: 'hello.txt' }])
    expect(parseDmgListing('Path = file:attribute\nSize = 4\nAlternate Stream = +\n', 10)).toEqual([])
  })

  it('reports unsupported inner filesystems instead of extracting a raw partition', () => {
    expect(() => parseDmgListing('Path = 0.unknown partition\nSize = 1024\n', 10))
      .toThrow('Unsupported DMG filesystem')
  })

  it('requires enough disk space before writing payload files', async () => {
    const options = await fixture()
    await expect(extractArchive(options, undefined, {
      getAvailableBytes: async () => 1n, policy: { minimumReserveBytes: 0, reserveRatioPercent: 0 }
    })).rejects.toMatchObject({ code: 'INSUFFICIENT_DISK_SPACE' })
    await expect(fs.stat(options.targetDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back when the configured expanded size limit is exceeded', async () => {
    const options = await fixture()
    await expect(extractArchive(options, undefined, { ...context, policy: { maxFileBytes: 5 } }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(fs.stat(options.targetDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

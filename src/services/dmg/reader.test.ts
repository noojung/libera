import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DmgReader, type DmgEntry } from './reader'
import { dmgFixture, hfsDisk, udifImage } from './testFixture'
import { DMG_FIXTURES } from './fixtures.testData'
import { UdifImage } from './udif'
import { inspectArchive } from '../archiveInspector'
import { previewArchiveEntry, MAX_ARCHIVE_PREVIEW_BYTES } from '../archivePreview'
import { extractArchive } from '../extractor'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
async function workDir() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-dmg-'))
  directories.push(directory)
  return directory
}
async function imageFile(bytes: Buffer, name = 'archive.DMG') {
  const directory = await workDir()
  const archivePath = path.join(directory, name)
  await fs.writeFile(archivePath, bytes)
  return { archivePath, targetDir: path.join(directory, 'out') }
}
const fixture = (files: Parameters<typeof dmgFixture>[0] = [{ name: 'hello.txt', data: Buffer.from('Hello DMG!') }]) =>
  imageFile(dmgFixture(files))
const hdiutilImage = (name: string) => imageFile(Buffer.from(DMG_FIXTURES[name], 'base64'), `${name}.dmg`)
const context = { getAvailableBytes: async () => 10n ** 12n }

async function contents(reader: DmgReader, entry: DmgEntry): Promise<Buffer> {
  const parts: Buffer[] = []
  await reader.read(entry, Math.max(entry.size, 4096), async bytes => { parts.push(Buffer.from(bytes)) })
  return Buffer.concat(parts)
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('DMG reader', () => {
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

  it('reads chunks stored without compression', async () => {
    const { archivePath } = await imageFile(udifImage(hfsDisk([{ name: 'raw.txt', data: Buffer.from('stored as is') }]), 'raw'))
    const reader = await DmgReader.open(archivePath)
    const entry = reader.entries.find(entry => entry.path === 'Fixture/raw.txt')!
    expect((await contents(reader, entry)).toString()).toBe('stored as is')
    await reader.close()
  })

  it('enforces listing limits', async () => {
    const { archivePath } = await fixture()
    await expect(DmgReader.open(archivePath, 0)).rejects.toMatchObject({ code: 'TOO_MANY_ENTRIES' })
  })

  it('rejects invalid and encrypted images and cancelled operations', async () => {
    const options = await fixture()
    await fs.writeFile(options.archivePath, Buffer.alloc(512))
    await expect(inspectArchive(options.archivePath)).rejects.toThrow('Unsupported DMG')
    // An encrypted image opens with its own header and keeps the trailer inside the encrypted data.
    await fs.writeFile(options.archivePath, Buffer.concat([Buffer.from('encrcdsa'), Buffer.alloc(4096)]))
    await expect(inspectArchive(options.archivePath)).rejects.toThrow('expected an unencrypted UDIF disk image')
    await expect(extractArchive(options, undefined, { ...context, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'EXTRACTION_CANCELLED' })
  })

  it('rejects truncated images', async () => {
    const image = dmgFixture([{ name: 'hello.txt', data: Buffer.from('Hello DMG!') }])
    const { archivePath } = await imageFile(Buffer.concat([image.subarray(0, 40), image.subarray(image.length - 512)]))
    await expect(DmgReader.open(archivePath)).rejects.toThrow('Invalid DMG')
  })

  it('caps text previews and keeps the result', async () => {
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

  it('cancels an active stream promptly', async () => {
    const options = await fixture([{ name: 'large.txt', data: Buffer.alloc(2 * 1024 * 1024, 65) }])
    const reader = await DmgReader.open(options.archivePath)
    const entry = reader.entries.find(entry => entry.path.endsWith('large.txt'))!
    const controller = new AbortController()
    await expect(reader.read(entry, entry.size, async () => { controller.abort() }, controller.signal))
      .rejects.toMatchObject({ code: 'EXTRACTION_CANCELLED' })
    await reader.close()
  })

  it('stops a stream that passes the caller\'s limit', async () => {
    const options = await fixture([{ name: 'large.txt', data: Buffer.alloc(1024 * 1024, 65) }])
    const reader = await DmgReader.open(options.archivePath)
    const entry = reader.entries.find(entry => entry.path.endsWith('large.txt'))!
    await expect(reader.read(entry, 1000, async () => {})).rejects.toThrow('exceeds the configured size limit')
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

  it('rejects device files and other entries it cannot represent', async () => {
    const { archivePath } = await fixture([{ name: 'fifo', data: Buffer.alloc(0), mode: 0o010644 }])
    await expect(DmgReader.open(archivePath)).rejects.toThrow('Unsupported DMG file type')
  })

  it('reports unsupported inner filesystems instead of extracting a raw partition', async () => {
    const { archivePath } = await imageFile(udifImage(Buffer.alloc(64 * 512, 0x5a)))
    await expect(DmgReader.open(archivePath)).rejects.toThrow('Unsupported DMG filesystem')
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

// The images in fixtures.testData.ts, made by hdiutil from the same tree.
const FIXTURE_TREE = [
  'Fixture', 'Fixture/Applications', 'Fixture/a:b.txt', 'Fixture/empty.txt', 'Fixture/hard1.txt', 'Fixture/hard2.txt',
  'Fixture/hello.txt', 'Fixture/link-internal', 'Fixture/nested', 'Fixture/nested/deeper', 'Fixture/nested/deeper/note.md',
  'Fixture/run.sh', 'Fixture/한글 파일.txt'
]

describe('DMG images written by hdiutil', () => {
  it.each(['hfs-ulfo', 'hfs-ulmo', 'hfs-udbz', 'hfs-apm', 'hfs-none', 'apfs-udzo'])('reads %s', async name => {
    const { archivePath } = await hdiutilImage(name)
    const reader = await DmgReader.open(archivePath)
    const byPath = new Map(reader.entries.map(entry => [entry.path.normalize('NFC'), entry]))
    const expected = name === 'hfs-ulfo' ? [...FIXTURE_TREE, 'Fixture/big.bin'] : FIXTURE_TREE
    expect([...byPath.keys()].sort()).toEqual([...expected].sort())

    const text = async (entryPath: string) => (await contents(reader, byPath.get(entryPath)!)).toString()
    expect(await text('Fixture/hello.txt')).toBe('Hello DMG!')
    expect(await text('Fixture/nested/deeper/note.md')).toBe('# note\nnested file\n')
    expect(await text('Fixture/한글 파일.txt')).toBe('unicode')
    expect(await text('Fixture/a:b.txt')).toBe('colon')
    expect(await text('Fixture/empty.txt')).toBe('')
    // Both names of a hard link read the one file they share.
    expect(await text('Fixture/hard1.txt')).toBe('shared by two names')
    expect(await text('Fixture/hard2.txt')).toBe('shared by two names')
    expect(byPath.get('Fixture/run.sh')!.mode! & 0o777).toBe(0o755)
    expect(byPath.get('Fixture/nested')).toMatchObject({ isDirectory: true })
    for (const [link, target] of [['Fixture/link-internal', 'hello.txt'], ['Fixture/Applications', '/Applications']]) {
      const entry = byPath.get(link)!
      expect(entry.isLink).toBe(true)
      expect(entry.linkTarget ?? await text(link)).toBe(target)
    }
    if (name === 'hfs-ulfo') {
      const big = byPath.get('Fixture/big.bin')!
      expect(big.size).toBe(1_250_000)
      expect(sha256(await contents(reader, big))).toBe('fd98e1139ee5885ae5c93916fc87991a466aa55e64c238d3aa19de28863f1789')
    }
    await reader.close()
  })

  it.each(['hfs-decmpfs', 'apfs-decmpfs'])('expands files stored with filesystem compression in %s', async name => {
    const { archivePath } = await hdiutilImage(name)
    const reader = await DmgReader.open(archivePath)
    const byPath = new Map(reader.entries.map(entry => [entry.path, entry]))
    const attribute = byPath.get('Packed/attr.txt')!
    expect(attribute.size).toBe(20300)
    expect((await contents(reader, attribute)).toString()).toBe('compress me in the attribute '.repeat(700))
    const fork = byPath.get('Packed/fork.txt')!
    expect(fork.size).toBe(140000)
    expect(sha256(await contents(reader, fork))).toBe('dff65fe544b358b2f541e5ffc009fd289d0f99175de90f873e949177a84c18fa')
    await reader.close()
  })

  it.each(['fat12', 'fat32'])('reads long and short names from %s', async name => {
    const { archivePath } = await hdiutilImage(name)
    const reader = await DmgReader.open(archivePath)
    const byPath = new Map(reader.entries.map(entry => [entry.path, entry]))
    expect((await contents(reader, byPath.get('FIXTURE/HELLO.TXT')!)).toString()).toBe('fat hello')
    expect((await contents(reader, byPath.get('FIXTURE/A long file name.txt')!)).toString()).toBe('long name')
    expect((await contents(reader, byPath.get('FIXTURE/Sub/inner.txt')!)).toString()).toBe('sub')
    expect(byPath.get('FIXTURE/Sub')).toMatchObject({ isDirectory: true })
    await reader.close()
  })

  it('extracts an APFS image the same way as an HFS+ one', async () => {
    const options = await hdiutilImage('apfs-udzo')
    const result = await extractArchive(options, undefined, context)
    const root = path.join(options.targetDir, 'Fixture')
    expect(await fs.readFile(path.join(root, 'hard2.txt'), 'utf8')).toBe('shared by two names')
    expect(await fs.readFile(path.join(root, 'nested', 'deeper', 'note.md'), 'utf8')).toBe('# note\nnested file\n')
    await expect(fs.lstat(path.join(root, 'Applications'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') {
      expect(result.symbolicLinksExcluded).toBe(1)
      expect(await fs.readlink(path.join(root, 'link-internal'))).toBe('hello.txt')
    }
  })

  it('fails cleanly on damaged filesystem metadata', async () => {
    // Each image's disk is decoded, a few metadata bytes are changed, and the
    // disk is stored again; whatever the damage, reading either works or
    // reports the image as invalid.
    let seed = 7
    const random = (limit: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit
    for (const name of ['hfs-none', 'apfs-udzo', 'fat32']) {
      const bytes = Buffer.from(DMG_FIXTURES[name], 'base64')
      const image = await UdifImage.open({ size: bytes.length, read: async (at, length) => bytes.subarray(at, at + length) })
      const disk = Buffer.from(await image.read(0, image.size))
      const used: number[] = []
      for (let sector = 0; sector < disk.length / 512 && used.length < 120; sector++) {
        if (disk.subarray(sector * 512, sector * 512 + 512).some(byte => byte !== 0)) used.push(sector)
      }
      for (let round = 0; round < 25; round++) {
        const damaged = Buffer.from(disk)
        for (let flips = 1 + random(6); flips > 0; flips--) damaged[used[random(used.length)] * 512 + random(512)] = random(256)
        const { archivePath } = await imageFile(udifImage(damaged, 'raw'))
        try {
          const reader = await DmgReader.open(archivePath)
          for (const entry of reader.entries) {
            if (!entry.isDirectory) await contents(reader, entry).catch(error => { expect(error.message).toMatch(/DMG/) })
          }
          await reader.close()
        } catch (error) {
          expect((error as Error).message).toMatch(/DMG/)
        }
      }
    }
  })
})

import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { extractArchive, isSupportedArchivePath } from './extractor'
import { inspectArchive } from './archiveInspector'
import { previewArchiveEntry } from './archivePreview'
import { isTarArchivePath, tarCompressionFor } from './tarCompression'
import { TAR_BINARY_ENTRY, TAR_BZ2, TAR_BZ2_BAD_CRC, TAR_XZ, TAR_ZST } from './tarCompression.testData'

// One tarball, one row per codec wrapped around it, so every reader is held to
// the same three entries and the same bytes.
const FIXTURES = {
  '.tar.xz': { bytes: TAR_XZ, format: 'TAR.XZ', summary: 'XZ / LZMA2 Stream', codec: 'XZ (LZMA2)' },
  '.tar.bz2': { bytes: TAR_BZ2, format: 'TAR.BZ2', summary: 'BZip2 Stream', codec: 'BZip2' },
  '.tar.zst': { bytes: TAR_ZST, format: 'TAR.ZST', summary: 'Zstandard Stream', codec: 'Zstandard' }
} as const
const BINARY_ENTRY = Buffer.from(TAR_BINARY_ENTRY, 'base64')

async function withArchive<T>(
  suffix: keyof typeof FIXTURES,
  run: (archivePath: string, directory: string) => Promise<T>
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-tar-'))
  try {
    const archivePath = path.join(directory, `sample${suffix}`)
    await fs.writeFile(archivePath, Buffer.from(FIXTURES[suffix].bytes, 'base64'))
    return await run(archivePath, directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const suffixes = Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]

// Both are read by decoding the codec in front of the tarball, so the three
// things the app does with an archive - list it, look inside one entry, and
// write it out - are each held against what the reference tools produced.
describe.each(suffixes)('reading a %s', suffix => {
  it('lists what the tarball holds', async () => {
    await withArchive(suffix, async archivePath => {
      const inspected = await inspectArchive(archivePath)
      expect(inspected.format).toBe(FIXTURES[suffix].format)
      expect(inspected.entries.filter(entry => !entry.isDirectory).map(entry => entry.path).sort())
        .toEqual(['src/a.txt', 'src/b.bin', 'src/nested/c.txt'])
    })
  }, 60_000)

  it('names the codec wrapped around it', async () => {
    await withArchive(suffix, async archivePath => {
      const inspected = await inspectArchive(archivePath)
      expect(inspected.headerInfo?.codecSummary).toBe(FIXTURES[suffix].summary)
      expect(inspected.entries.find(entry => entry.path === 'src/a.txt')?.codec)
        .toBe(FIXTURES[suffix].codec)
    })
  }, 60_000)

  it('previews an entry without writing anything out', async () => {
    await withArchive(suffix, async archivePath => {
      const inspected = await inspectArchive(archivePath)
      const entry = inspected.entries.find(item => item.path === 'src/a.txt')!
      expect(await previewArchiveEntry(archivePath, entry.id, {}))
        .toMatchObject({ kind: 'text', text: 'hello from libera\n' })
    })
  }, 60_000)

  it('extracts every entry, byte for byte', async () => {
    await withArchive(suffix, async (archivePath, directory) => {
      const targetDir = path.join(directory, 'out')
      const result = await extractArchive({ archivePath, targetDir } as never)

      expect(result.extractedCount).toBeGreaterThanOrEqual(3)
      expect(await fs.readFile(path.join(targetDir, 'src', 'a.txt'), 'utf8')).toBe('hello from libera\n')
      expect(await fs.readFile(path.join(targetDir, 'src', 'nested', 'c.txt'), 'utf8')).toBe('nested file\n')
      // Random bytes, so nothing but a correct decode reproduces them.
      expect(await fs.readFile(path.join(targetDir, 'src', 'b.bin'))).toEqual(BINARY_ENTRY)
    })
  }, 60_000)

  it('reports damage rather than handing back what it decoded so far', async () => {
    await withArchive(suffix, async (archivePath, directory) => {
      const bytes = await fs.readFile(archivePath)
      bytes[Math.floor(bytes.length / 2)] ^= 0xff
      const damagedPath = path.join(directory, `damaged${suffix}`)
      await fs.writeFile(damagedPath, bytes)

      await expect(extractArchive({ archivePath: damagedPath, targetDir: path.join(directory, 'bad') } as never))
        .rejects.toThrow()
    })
  }, 60_000)
})

// Corrupting the compressed data anywhere else fails in the Huffman decode
// before the block's check is compared, so this fixture flips a byte inside the
// stored CRC alone: the data decodes, and only the check disagrees.
it('rejects a bzip2 block whose CRC does not match', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-tar-'))
  try {
    const archivePath = path.join(directory, 'badcrc.tar.bz2')
    await fs.writeFile(archivePath, Buffer.from(TAR_BZ2_BAD_CRC, 'base64'))
    await expect(extractArchive({ archivePath, targetDir: path.join(directory, 'out') } as never))
      .rejects.toThrow(/CRC/)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 60_000)

describe('recognising the suffixes', () => {
  it.each([
    ['archive.tar.xz', 'xz'],
    ['archive.txz', 'xz'],
    ['ARCHIVE.TAR.XZ', 'xz'],
    ['archive.tar.bz2', 'bzip2'],
    ['archive.tbz2', 'bzip2'],
    ['archive.tbz', 'bzip2'],
    ['archive.tar.zst', 'zstd'],
    ['archive.tzst', 'zstd'],
    ['ARCHIVE.TAR.ZST', 'zstd'],
    ['archive.tar', 'none'],
    ['archive.tar.gz', 'none'],
    ['archive.zip', 'none']
  ])('reads %s as %s', (name, expected) => {
    expect(tarCompressionFor(name)).toBe(expected)
  })

  it.each([
    'a.tar.xz', 'a.txz', 'a.tar.bz2', 'a.tbz2', 'a.tbz',
    'a.tar.zst', 'a.tzst', 'a.tar', 'a.tgz', 'a.tar.gz'
  ])('takes %s for a tarball', name => { expect(isTarArchivePath(name)).toBe(true) })

  it.each(['a.zip', 'a.7z', 'a.gz', 'a.xz', 'a.bz2', 'a.zst'])(
    'does not take %s for a tarball',
    name => { expect(isTarArchivePath(name)).toBe(false) }
  )

  it('offers the new suffixes to the open dialog', () => {
    for (const name of ['a.tar.xz', 'a.txz', 'a.tar.bz2', 'a.tbz2', 'a.tbz', 'a.tar.zst', 'a.tzst']) {
      expect(isSupportedArchivePath(name)).toBe(true)
    }
  })
})

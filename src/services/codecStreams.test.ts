import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { extractArchive, isSupportedArchivePath } from './extractor'
import { inspectArchive } from './archiveInspector'
import { previewArchiveEntry } from './archivePreview'
import { streamCodecFor, streamEntryName } from './codecStreams'
import { A_TXT_BZ2, A_TXT_GZ, A_TXT_XZ, A_TXT_ZST, SINGLE_FILE_TEXT } from './codecStreams.testData'

// The four codecs that wrap one file and carry no entry table of their own.
// Each fixture holds the same text, so one set of assertions covers them all.
const FIXTURES = {
  '.gz': { bytes: A_TXT_GZ, format: 'GZ', codec: 'Gzip (Deflate)', summary: 'Gzip / Deflate Stream' },
  '.xz': { bytes: A_TXT_XZ, format: 'XZ', codec: 'XZ (LZMA2)', summary: 'XZ / LZMA2 Stream' },
  '.bz2': { bytes: A_TXT_BZ2, format: 'BZ2', codec: 'BZip2', summary: 'BZip2 Stream' },
  '.zst': { bytes: A_TXT_ZST, format: 'ZST', codec: 'Zstandard', summary: 'Zstandard Stream' }
} as const

type Suffix = keyof typeof FIXTURES

async function withArchive<T>(
  suffix: Suffix,
  run: (archivePath: string, directory: string) => Promise<T>,
  archiveName = `a.txt${suffix}`
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-stream-'))
  try {
    const archivePath = path.join(directory, archiveName)
    await fs.writeFile(archivePath, Buffer.from(FIXTURES[suffix].bytes, 'base64'))
    return await run(archivePath, directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const suffixes = Object.keys(FIXTURES) as Suffix[]

describe.each(suffixes)('reading a lone %s stream', suffix => {
  it('lists the one file it holds, named without the codec suffix', async () => {
    await withArchive(suffix, async archivePath => {
      const inspected = await inspectArchive(archivePath)
      expect(inspected.format).toBe(FIXTURES[suffix].format)
      expect(inspected.totalFiles).toBe(1)
      expect(inspected.entries).toHaveLength(1)
      expect(inspected.entries[0].path).toBe('a.txt')
      expect(inspected.entries[0].codec).toBe(FIXTURES[suffix].codec)
      expect(inspected.headerInfo?.codecSummary).toBe(FIXTURES[suffix].summary)
      // Knowing the size would mean decoding the whole stream, which listing
      // does not pay for.
      expect(inspected.totalUncompressedSize).toBeNull()
    })
  }, 30_000)

  it('previews the file without writing anything out', async () => {
    await withArchive(suffix, async (archivePath, directory) => {
      const inspected = await inspectArchive(archivePath)
      expect(await previewArchiveEntry(archivePath, inspected.entries[0].id, {}))
        .toMatchObject({ kind: 'text', text: SINGLE_FILE_TEXT })
      expect(await fs.readdir(directory)).toEqual([path.basename(archivePath)])
    })
  }, 30_000)

  it('refuses an entry past the only one there is', async () => {
    await withArchive(suffix, async archivePath => {
      await expect(previewArchiveEntry(archivePath, 'entry-1', {})).rejects.toThrow()
    })
  }, 30_000)

  it('extracts the file, byte for byte', async () => {
    await withArchive(suffix, async (archivePath, directory) => {
      const targetDir = path.join(directory, 'out')
      const result = await extractArchive({ archivePath, targetDir } as never)

      expect(result.extractedCount).toBe(1)
      expect(await fs.readFile(path.join(targetDir, 'a.txt'), 'utf8')).toBe(SINGLE_FILE_TEXT)
    })
  }, 30_000)

  it('reports damage rather than handing back what it decoded so far', async () => {
    await withArchive(suffix, async (archivePath, directory) => {
      const bytes = await fs.readFile(archivePath)
      bytes[Math.floor(bytes.length / 2)] ^= 0xff
      const damagedPath = path.join(directory, `damaged${suffix}`)
      await fs.writeFile(damagedPath, bytes)

      await expect(extractArchive({ archivePath: damagedPath, targetDir: path.join(directory, 'bad') } as never))
        .rejects.toThrow()
    })
  }, 30_000)

  it('names the entry after the file even when the suffix is upper case', async () => {
    // `path.basename(p, ext)` compares the suffix case sensitively, so an
    // archive shouted at the filesystem used to keep its own name as the entry.
    await withArchive(suffix, async (archivePath, directory) => {
      const inspected = await inspectArchive(archivePath)
      expect(inspected.entries[0].path).toBe('REPORT.txt')

      const targetDir = path.join(directory, 'out')
      await extractArchive({ archivePath, targetDir } as never)
      expect(await fs.readFile(path.join(targetDir, 'REPORT.txt'), 'utf8')).toBe(SINGLE_FILE_TEXT)
    }, `REPORT.txt${suffix.toUpperCase()}`)
  }, 30_000)
})

describe('recognising the suffixes', () => {
  it.each([
    ['report.gz', 'gzip'],
    ['REPORT.GZ', 'gzip'],
    ['report.xz', 'xz'],
    ['report.bz2', 'bzip2'],
    ['report.zst', 'zstd'],
    ['REPORT.ZST', 'zstd']
  ] as const)('reads %s as a %s stream', (name, expected) => {
    expect(streamCodecFor(name)).toBe(expected)
  })

  it.each(['report.zip', 'report.7z', 'report.tar', 'notes.txt', 'report'])(
    'reads %s as no stream at all',
    name => { expect(streamCodecFor(name)).toBeNull() }
  )

  it.each([
    ['/tmp/report.txt.gz', 'report.txt'],
    ['/tmp/REPORT.TXT.GZ', 'REPORT.TXT'],
    ['/tmp/report.txt.zst', 'report.txt'],
    ['/tmp/report.txt.bz2', 'report.txt'],
    ['/tmp/notes.txt', 'notes.txt'],
    // Nothing but a suffix keeps it, since the alternative is an empty name.
    ['/tmp/.gz', '.gz']
  ])('stores %s under the name %s', (archivePath, expected) => {
    expect(streamEntryName(archivePath)).toBe(expected)
  })

  it('offers every lone-file suffix to the open dialog', () => {
    for (const name of ['a.gz', 'a.xz', 'a.bz2', 'a.zst']) {
      expect(isSupportedArchivePath(name)).toBe(true)
    }
  })
})

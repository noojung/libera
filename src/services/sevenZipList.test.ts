import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { listSevenZipEntries, parseSevenZipListing, parseUnixModeString } from './sevenZipList'
import { runSevenZip } from './sevenZip'
import { buildExtractionPlan, DEFAULT_EXTRACTION_POLICY, ExtractionError } from './extractionSafety'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-7zlist-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

// Captured verbatim from the bundled p7zip 17.03. Note there is no `Folder`
// property: a directory is only identifiable from the `D` in Attributes.
const LISTING = `
7-Zip (a) [64] 17.03 : Copyright (c) 1999-2020 Igor Pavlov : 2017-08-28
p7zip Version 17.03 (locale=utf8,Utf16=on,HugeFiles=on,64 bits,6 CPUs x64)

Scanning the drive for archives:
1 file, 238 bytes (1 KiB)

Listing archive: t.7z

--
Path = t.7z
Type = 7z
Physical Size = 238
Solid = +

----------
Path = src
Size = 0
Packed Size = 0
Modified = 2026-08-18 23:43:15
Attributes = D_ drwxr-xr-x
CRC =
Encrypted = -

Path = src/a.txt
Size = 5
Packed Size = 23
Modified = 2026-08-18 23:43:15
Attributes = A_ -rw-r--r--
CRC = 3610A686
Encrypted = -

Path = src/run.sh
Size = 11
Packed Size = 0
Modified = 2026-08-18 23:43:15
Attributes = A_ -rwxr-xr-x
CRC = 1234ABCD
Encrypted = -

Path = src/link.txt
Size = 5
Packed Size = 0
Modified = 2026-08-18 23:43:15
Attributes = A_ lrwxr-xr-x
CRC = C1EBF7BA
Encrypted = -
`

describe('parseUnixModeString', () => {
  it('reads the permission bits out of an ls style string', () => {
    expect(parseUnixModeString('-rw-r--r--')).toBe(0o644)
    expect(parseUnixModeString('drwxr-xr-x')).toBe(0o755)
    expect(parseUnixModeString('lrwxr-xr-x')).toBe(0o755)
    expect(parseUnixModeString('----------')).toBe(0o000)
  })

  it('rejects anything that is not one', () => {
    // Archives written by Windows tools carry no permission part at all.
    expect(parseUnixModeString('A')).toBeUndefined()
    expect(parseUnixModeString('D_')).toBeUndefined()
    expect(parseUnixModeString('')).toBeUndefined()
  })
})

describe('parseSevenZipListing', () => {
  it('skips the archive property block and reads the entries', () => {
    const listing = parseSevenZipListing(LISTING)

    expect(listing.entries.map(entry => entry.path)).toEqual([
      'src',
      'src/a.txt',
      'src/run.sh',
      'src/link.txt'
    ])
    // The archive's own `Path = t.7z` must not be mistaken for an entry.
    expect(listing.entries.some(entry => entry.path === 't.7z')).toBe(false)
  })

  it('identifies directories from Attributes, since p7zip emits no Folder property', () => {
    const listing = parseSevenZipListing(LISTING)

    expect(listing.entries[0]).toMatchObject({ path: 'src', isDirectory: true, mode: 0o755 })
    expect(listing.entries[1]).toMatchObject({ path: 'src/a.txt', isDirectory: false, size: 5, mode: 0o644 })
  })

  it('carries the executable bit and marks symbolic links', () => {
    const listing = parseSevenZipListing(LISTING)

    expect(listing.entries[2]).toMatchObject({ path: 'src/run.sh', mode: 0o755, isSymlink: false })
    expect(listing.entries[3]).toMatchObject({ path: 'src/link.txt', isSymlink: true, size: 5 })
  })

  it('reads the volume count from a split set preamble', () => {
    const split = `
--
Path = m.7z.001
Type = Split
Volumes = 7
Total Physical Size = 200000

----
Path = m.7z
Size = 200000

--
Path = m.7z
Type = 7z

----------
Path = big.bin
Size = 200000
Attributes = A_ -rw-r--r--
Encrypted = -
`
    const listing = parseSevenZipListing(split)

    expect(listing.volumeCount).toBe(7)
    // Neither the Split container nor the inner archive block is an entry.
    expect(listing.entries.map(entry => entry.path)).toEqual(['big.bin'])
  })

  it('reports encrypted entries', () => {
    const encrypted = LISTING.replace('Path = src/a.txt\nSize = 5\nPacked Size = 23\nModified = 2026-08-18 23:43:15\nAttributes = A_ -rw-r--r--\nCRC = 3610A686\nEncrypted = -', 'Path = src/a.txt\nSize = 5\nAttributes = A_ -rw-r--r--\nEncrypted = +')

    const listing = parseSevenZipListing(encrypted)
    expect(listing.anyEncrypted).toBe(true)
  })

  it('drops anti-file deletion markers, which carry no content', () => {
    const withAnti = `
----------
Path = removed.txt
Size = 0
Attributes = A_ -rw-r--r--
Anti = +

Path = kept.txt
Size = 3
Attributes = A_ -rw-r--r--
`
    expect(parseSevenZipListing(withAnti).entries.map(entry => entry.path)).toEqual(['kept.txt'])
  })

  it('returns nothing for an empty archive rather than inventing an entry', () => {
    expect(parseSevenZipListing('--\nPath = e.7z\nType = 7z\n\n----------\n').entries).toEqual([])
  })
})

describe('a hostile listing fed through the extraction plan', () => {
  const targetRoot = path.resolve('/tmp/libera-target')

  function planFor(listingText: string) {
    const listing = parseSevenZipListing(listingText)
    return () => buildExtractionPlan(
      listing.entries.map(entry => ({
        archivePath: entry.path,
        isDirectory: entry.isDirectory,
        size: entry.size,
        isLink: entry.isSymlink,
        mode: entry.mode
      })),
      targetRoot,
      null,
      DEFAULT_EXTRACTION_POLICY
    )
  }

  it('rejects a parent-directory traversal', () => {
    expect(planFor(`
----------
Path = ../escape.txt
Size = 4
Attributes = A_ -rw-r--r--
`)).toThrow(ExtractionError)
  })

  it('rejects an absolute path', () => {
    expect(planFor(`
----------
Path = /etc/passwd
Size = 4
Attributes = A_ -rw-r--r--
`)).toThrow('entry path escapes the destination')
  })

  it('rejects a link entry whose target was never resolved', () => {
    expect(planFor(`
----------
Path = link.txt
Size = 5
Attributes = A_ lrwxr-xr-x
`)).toThrow('symbolic and hard link entries are not supported')
  })

  it('rejects duplicate output paths, which 7z permits but the filesystem does not', () => {
    expect(planFor(`
----------
Path = same.txt
Size = 1
Attributes = A_ -rw-r--r--

Path = same.txt
Size = 2
Attributes = A_ -rw-r--r--
`)).toThrow('duplicate output paths')
  })
})

// The fixture above is a snapshot; this pins the parser against whatever the
// bundled binary actually prints, so a p7zip upgrade cannot drift past it.
describe('against a real archive', () => {
  it('reads directories, modes, symlinks and non-ASCII names as written by the bundled binary', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(path.join(sourceDir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'a.txt'), 'hello')
    await fs.writeFile(path.join(sourceDir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await fs.writeFile(path.join(sourceDir, 'empty.txt'), '')
    await fs.writeFile(path.join(sourceDir, 'sub', '공백 이름.txt'), 'x')
    await fs.symlink('a.txt', path.join(sourceDir, 'link.txt'))

    const archivePath = path.join(directory, 't.7z')
    await runSevenZip(['a', '-snl', '-mx=1', archivePath, sourceDir], undefined)

    const listing = await listSevenZipEntries(archivePath)
    const byName = new Map(listing.entries.map(entry => [path.basename(entry.path), entry]))

    expect(byName.get('src')).toMatchObject({ isDirectory: true })
    expect(byName.get('a.txt')).toMatchObject({ isDirectory: false, size: 5, mode: 0o644 })
    expect(byName.get('run.sh')).toMatchObject({ mode: 0o755, isSymlink: false })
    expect(byName.get('empty.txt')).toMatchObject({ size: 0, isDirectory: false })
    expect(byName.get('link.txt')).toMatchObject({ isSymlink: true })
    // A name with a space and Hangul must survive the round trip. macOS stores
    // filenames decomposed, so 7-Zip reports NFD and the comparison has to
    // normalize - paths themselves are passed through untouched, since
    // rewriting them would rename the file on any other platform.
    const names = listing.entries.map(entry => path.basename(entry.path).normalize('NFC'))
    expect(names).toContain('공백 이름.txt')
  }, 60_000)

  it('sums entry sizes to exactly what a single -so stream produces', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    for (let index = 1; index <= 20; index += 1) {
      await fs.writeFile(path.join(sourceDir, `f${index}.bin`), Buffer.alloc(index * 37, index))
    }
    const archivePath = path.join(directory, 'many.7z')
    await runSevenZip(['a', '-mx=1', archivePath, sourceDir], undefined)

    const listing = await listSevenZipEntries(archivePath)
    const declared = listing.entries.reduce((total, entry) => total + (entry.isDirectory ? 0 : entry.size), 0)

    // This equality is what lets the extractor split one -so stream at the
    // header-declared boundaries instead of staging files on disk.
    const { stdout } = await runSevenZip(['x', '-so', '-bso0', '-bse0', '--', archivePath], undefined)
    expect(Buffer.byteLength(stdout, 'binary')).toBe(declared)
  }, 60_000)
})

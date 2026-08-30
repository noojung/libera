import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { SplitVolumeError } from '../zip/volumes'
import { canonicalArchivePath } from '../archiveVolumes'
import { listSevenZipEntries } from './list'
import { openLibera7zFile, writeLibera7z } from './node'
import {
  discoverSevenZipVolumes,
  firstVolumePath,
  isSevenZipArchivePath,
  isSevenZipVolumePath,
  removeStaleSevenZipVolumes,
  sevenZipVolumeBase
} from './volumes'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-7zvol-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('7z volume naming', () => {
  it('recognizes volumes and plain archives', () => {
    expect(isSevenZipVolumePath('/tmp/a.7z.001')).toBe(true)
    expect(isSevenZipVolumePath('/tmp/a.7z.014')).toBe(true)
    expect(isSevenZipVolumePath('/tmp/A.7Z.002')).toBe(true)
    // Two digits is not 7-Zip's naming, and a plain archive is not a volume.
    expect(isSevenZipVolumePath('/tmp/a.7z.01')).toBe(false)
    expect(isSevenZipVolumePath('/tmp/a.7z')).toBe(false)

    expect(isSevenZipArchivePath('/tmp/a.7z')).toBe(true)
    expect(isSevenZipArchivePath('/tmp/a.7z.003')).toBe(true)
    expect(isSevenZipArchivePath('/tmp/a.zip')).toBe(false)
  })

  it('does not collide with the ZIP volume suffix', () => {
    // ZIP volumes are `.z01`; there is no `.z` before the digits here.
    expect(/\.z\d{2,}$/i.test('/tmp/a.7z.001')).toBe(false)
  })

  it('resolves any volume to the first one, the mirror image of ZIP', () => {
    expect(firstVolumePath('/tmp/a.7z.014')).toBe('/tmp/a.7z.001')
    expect(firstVolumePath('/tmp/a.7z.001')).toBe('/tmp/a.7z.001')
    expect(firstVolumePath('/tmp/a.7z')).toBe('/tmp/a.7z')
    expect(sevenZipVolumeBase('/tmp/a.7z.014')).toBe('/tmp/a.7z')
  })

  it('routes each format to the end of the set that can be opened', () => {
    expect(canonicalArchivePath('/tmp/a.7z.014')).toBe('/tmp/a.7z.001')
    // A ZIP set is read from its terminal volume instead.
    expect(canonicalArchivePath('/tmp/a.z03')).toBe('/tmp/a.zip')
    expect(canonicalArchivePath('/tmp/a.zip')).toBe('/tmp/a.zip')
  })
})

describe('discoverSevenZipVolumes', () => {
  async function writeVolumes(directory: string, numbers: number[]): Promise<string> {
    for (const number of numbers) {
      await fs.writeFile(path.join(directory, `set.7z.${String(number).padStart(3, '0')}`), 'x')
    }
    return path.join(directory, 'set.7z.001')
  }

  it('returns a contiguous set in order', async () => {
    const directory = await createTemporaryDirectory()
    const first = await writeVolumes(directory, [1, 2, 3])

    await expect(discoverSevenZipVolumes(first)).resolves.toEqual([
      path.join(directory, 'set.7z.001'),
      path.join(directory, 'set.7z.002'),
      path.join(directory, 'set.7z.003')
    ])
  })

  it('reports a gap rather than silently reading a short set', async () => {
    const directory = await createTemporaryDirectory()
    const first = await writeVolumes(directory, [1, 3])

    await expect(discoverSevenZipVolumes(first)).rejects.toBeInstanceOf(SplitVolumeError)
  })

  it('reports the missing first volume, which carries the headers', async () => {
    const directory = await createTemporaryDirectory()
    await writeVolumes(directory, [2, 3])

    await expect(discoverSevenZipVolumes(path.join(directory, 'set.7z.001')))
      .rejects.toMatchObject({ code: 'SPLIT_VOLUME_MISSING' })
  })
})

describe('removeStaleSevenZipVolumes', () => {
  it('clears files from a previous split or non-split run', async () => {
    const directory = await createTemporaryDirectory()
    for (const name of ['out.7z', 'out.7z.001', 'out.7z.002', 'out.7z.tmp', 'keep.txt']) {
      await fs.writeFile(path.join(directory, name), 'x')
    }

    await removeStaleSevenZipVolumes(path.join(directory, 'out.7z'))

    await expect(fs.readdir(directory)).resolves.toEqual(['keep.txt'])
  })
})

describe('against a Libera7z split archive', () => {
  it('lists a set opened from any volume and reports the volume count', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    // Incompressible, so the set genuinely spans several volumes.
    await fs.writeFile(path.join(sourceDir, 'big.bin'), Buffer.alloc(200_000).map(() => Math.floor(Math.random() * 256)))
    const outputPath = path.join(directory, 'm.7z')
    await writeLibera7z({
      inputPaths: [sourceDir],
      outputPath,
      level: 0,
      splitSize: 30_000
    })

    const volumes = await discoverSevenZipVolumes(path.join(directory, 'm.7z.001'))
    expect(volumes.length).toBeGreaterThan(1)

    // The TypeScript reader sees the numbered files as one contiguous source,
    // even when the caller hands it the last volume.
    const archive = await openLibera7zFile(volumes[volumes.length - 1])
    try {
      expect(archive.entries.map(entry => path.basename(entry.path))).toContain('big.bin')
    } finally {
      await archive.close()
    }

    // Opening a later volume must resolve back to the first one.
    const listing = await listSevenZipEntries(canonicalArchivePath(volumes[volumes.length - 1]))
    expect(listing.volumeCount).toBe(volumes.length)
    expect(listing.entries.map(entry => path.basename(entry.path))).toContain('big.bin')

    const lastVolume = volumes.at(-1)!
    await fs.unlink(lastVolume)
    await expect(discoverSevenZipVolumes(volumes[0])).rejects.toMatchObject({
      name: 'SplitVolumeError',
      code: 'SPLIT_VOLUME_MISSING'
    })
  }, 60_000)
})

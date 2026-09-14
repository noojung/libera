import { describe, expect, it } from 'vitest'
import { SUPPORTED_ARCHIVE_EXTENSIONS, isSupportedArchivePath } from './extractor'
import { terminalVolumePath } from './zip/volumes'
import {
  compressionLevels,
  nearestLevel,
  supportsLevel,
  supportsHeaderEncryption,
  supportsPassword,
  supportsSplit,
  type ArchiveFormat
} from './compressor'
import * as renderer from '../renderer/src/utils/archivePaths'

/** What an open dialog filters on: the last suffix segment of a path. */
function dialogExtension(extension: string): string {
  return extension.split('.').pop() as string
}

/**
 * The two the dialog offers that name a volume rather than a whole archive,
 * each with the file it is there to let through. A 7z set's first volume is
 * `name.7z.001`, so the filter needs `001` even though `name.001` alone is
 * not an archive.
 */
const VOLUME_DIALOG_EXTENSIONS = [
  { offered: 'z01', example: '/tmp/archive.z01' },
  { offered: '001', example: '/tmp/archive.7z.001' }
]

// The renderer cannot import the services (they pull in fs/path), so it keeps
// its own copy of the archive path rules. This pins the two together.
describe('renderer archive path helper', () => {
  it('lists the same supported extensions as the extractor', () => {
    expect([...renderer.SUPPORTED_ARCHIVE_EXTENSIONS]).toEqual([...SUPPORTED_ARCHIVE_EXTENSIONS])
  })

  it('accepts and rejects the same paths as the extractor', () => {
    const candidates = [
      'C:\\archives\\archive.zip',
      'C:\\archives\\archive.z01',
      'C:\\archives\\archive.z09',
      'C:\\archives\\archive.z100',
      'C:\\archives\\ARCHIVE.ZIP',
      '/tmp/library.jar',
      '/tmp/LIBRARY.JAR',
      '/tmp/webapp.war',
      '/tmp/WEBAPP.WAR',
      'C:\\archives\\ARCHIVE.Z02',
      '/tmp/archive.tar',
      '/tmp/archive.tar.gz',
      '/tmp/archive.tgz',
      '/tmp/archive.gz',
      '/tmp/archive.xz',
      '/tmp/archive.bz2',
      '/tmp/archive.zst',
      '/tmp/archive.tar.zst',
      '/tmp/archive.tzst',
      '/tmp/ARCHIVE.ZST',
      '/tmp/archive.7z',
      '/tmp/archive.rar',
      '/tmp/archive.lz4',
      '/tmp/archive.z1',
      '/tmp/archive.zzz',
      '/tmp/notes.txt',
      '/tmp/archive'
    ]

    for (const candidate of candidates) {
      expect(renderer.isSupportedArchivePath(candidate)).toBe(isSupportedArchivePath(candidate))
    }
  })

  // The open dialog filters on the last segment of a name, so `.tar.gz` reaches
  // it as `gz`. Nothing held these two together before, which is how the dialog
  // came to offer `.xz` and `.bz2` months before either could be opened.
  it('offers every extension the extractor accepts', () => {
    const offered = new Set(renderer.EXTRACT_DIALOG_EXTENSIONS)

    for (const extension of SUPPORTED_ARCHIVE_EXTENSIONS) {
      expect(offered, `${extension} is supported but the dialog hides it`)
        .toContain(dialogExtension(extension))
    }
  })

  it('offers nothing the extractor would then refuse', () => {
    const accepted = new Set(SUPPORTED_ARCHIVE_EXTENSIONS.map(dialogExtension))

    const volumeOffers = VOLUME_DIALOG_EXTENSIONS.map(volume => volume.offered)
    for (const offered of renderer.EXTRACT_DIALOG_EXTENSIONS) {
      if (volumeOffers.includes(offered)) continue
      expect(accepted, `the dialog offers .${offered}, which cannot be opened`)
        .toContain(offered)
      // And the file the filter lets through really is one the app takes.
      expect(isSupportedArchivePath(`/tmp/archive.${offered}`)).toBe(true)
    }
  })

  it('offers the volume suffixes that stand in for a split set', () => {
    for (const { offered, example } of VOLUME_DIALOG_EXTENSIONS) {
      expect(renderer.EXTRACT_DIALOG_EXTENSIONS).toContain(offered)
      expect(isSupportedArchivePath(example)).toBe(true)
    }
  })

  it('canonicalizes volume paths the same way as the reader', () => {
    const candidates = [
      'C:\\archives\\archive.z01',
      'C:\\archives\\archive.z100',
      'C:\\archives\\ARCHIVE.Z02',
      'C:\\archives\\archive.zip',
      '/tmp/archive.tar'
    ]

    for (const candidate of candidates) {
      expect(renderer.terminalVolumePath(candidate)).toBe(terminalVolumePath(candidate))
    }
  })

  it('groups every volume of one set under a single key', () => {
    const key = renderer.splitVolumeGroupKey('C:\\archives\\archive.zip')
    expect(renderer.splitVolumeGroupKey('C:\\archives\\archive.z01')).toBe(key)
    expect(renderer.splitVolumeGroupKey('C:\\archives\\archive.z42')).toBe(key)
    expect(renderer.splitVolumeGroupKey('C:\\archives\\other.zip')).not.toBe(key)
  })
})

// The format capability helpers are duplicated for the same reason as the path
// rules: CompressionPanel needs them and cannot import compressor.ts.
describe('renderer compression format helper', () => {
  it('offers exactly the formats compressArchive accepts', () => {
    const serviceFormats: ArchiveFormat[] = ['zip', 'tar', 'gz', 'tgz', 'zst', 'tzst', '7z']
    expect([...renderer.COMPRESSION_FORMATS]).toEqual(serviceFormats)
  })

  it('agrees with the service about which formats take a password', () => {
    for (const format of renderer.COMPRESSION_FORMATS) {
      expect(renderer.supportsPassword(format)).toBe(supportsPassword(format))
    }
  })

  it('agrees with the service about which formats can hide their file names', () => {
    for (const format of renderer.COMPRESSION_FORMATS) {
      expect(renderer.supportsHeaderEncryption(format)).toBe(supportsHeaderEncryption(format))
    }
  })

  it('agrees with the service about which formats can be split', () => {
    for (const format of renderer.COMPRESSION_FORMATS) {
      expect(renderer.supportsSplit(format)).toBe(supportsSplit(format))
    }
  })

  it('agrees with the service about which formats take a compression level', () => {
    for (const format of renderer.COMPRESSION_FORMATS) {
      expect(renderer.supportsLevel(format)).toBe(supportsLevel(format))
      expect([...renderer.compressionLevels(format)]).toEqual([...compressionLevels(format)])
      for (let level = 0; level <= 9; level += 1) {
        expect(renderer.nearestLevel(level, format)).toBe(nearestLevel(level, format))
      }
    }
  })
})

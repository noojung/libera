import { describe, expect, it } from 'vitest'
import { SUPPORTED_ARCHIVE_EXTENSIONS, isSupportedArchivePath } from './extractor'
import { terminalVolumePath } from './splitZipVolumes'
import { supportsLevel, supportsPassword, supportsSplit, type ArchiveFormat } from './compressor'
import * as renderer from '../renderer/src/utils/archivePaths'

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
      '/tmp/archive.7z',
      '/tmp/archive.rar',
      '/tmp/archive.z1',
      '/tmp/archive.zzz',
      '/tmp/notes.txt',
      '/tmp/archive'
    ]

    for (const candidate of candidates) {
      expect(renderer.isSupportedArchivePath(candidate)).toBe(isSupportedArchivePath(candidate))
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
    const serviceFormats: ArchiveFormat[] = ['zip', 'tar', 'gz', 'tgz', '7z']
    expect([...renderer.COMPRESSION_FORMATS]).toEqual(serviceFormats)
  })

  it('agrees with the service about which formats take a password', () => {
    for (const format of renderer.COMPRESSION_FORMATS) {
      expect(renderer.supportsPassword(format)).toBe(supportsPassword(format))
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
    }
  })
})

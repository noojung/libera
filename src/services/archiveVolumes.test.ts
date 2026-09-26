import { describe, expect, it } from 'vitest'
import { canonicalArchivePath, isZipFormatExtension, zipFormatLabel } from './archiveVolumes'
import * as renderer from '../renderer/src/utils/archivePaths'

describe('canonicalArchivePath', () => {
  // ZIP is read from its last volume, 7z from its first, so a user who picks
  // the "wrong" end of either set still lands on the volume that opens.
  it.each([
    ['/tmp/set.z01', '/tmp/set.zip'],
    ['/tmp/set.z99', '/tmp/set.zip'],
    ['/tmp/set.z100', '/tmp/set.zip'],
    ['/tmp/set.Z03', '/tmp/set.zip'],
    ['/tmp/set.7z.001', '/tmp/set.7z.001'],
    ['/tmp/set.7z.004', '/tmp/set.7z.001'],
    ['/tmp/set.7z.1000', '/tmp/set.7z.001'],
    ['C:\\Users\\me\\set.7z.002', 'C:\\Users\\me\\set.7z.001'],
    ['C:\\Users\\me\\set.z02', 'C:\\Users\\me\\set.zip']
  ])('rewrites the volume %s to %s', (picked, opened) => {
    expect(canonicalArchivePath(picked)).toBe(opened)
  })

  it.each([
    '/tmp/plain.zip',
    '/tmp/plain.7z',
    '/tmp/plain.tar.gz',
    // Too few digits to be a volume of either set.
    '/tmp/plain.z1',
    '/tmp/plain.7z.01',
    // A bare `.001` is not a 7z volume without the `.7z` before it.
    '/tmp/plain.001'
  ])('leaves %s alone', archivePath => {
    expect(canonicalArchivePath(archivePath)).toBe(archivePath)
  })

  // The window groups volumes with its own copy of this rule and hands the
  // result to the main process, so the two must name the same file.
  it('agrees with the copy the window uses', () => {
    for (const archivePath of [
      '/tmp/set.z01', '/tmp/set.Z03', '/tmp/set.7z.004', '/tmp/set.7Z.002',
      '/tmp/plain.zip', '/tmp/plain.7z', '/tmp/plain.001', 'C:\\set.z02'
    ]) {
      expect(renderer.canonicalArchivePath(archivePath)).toBe(canonicalArchivePath(archivePath))
    }
  })
})

describe('ZIP-family extensions', () => {
  it('reads JAR and WAR through the ZIP reader', () => {
    expect(isZipFormatExtension('.zip')).toBe(true)
    expect(isZipFormatExtension('.jar')).toBe(true)
    expect(isZipFormatExtension('.war')).toBe(true)
  })

  it('does not claim other containers', () => {
    for (const extension of ['.7z', '.tar', '.gz', '.z01', '.ear', 'zip', '']) {
      expect(isZipFormatExtension(extension)).toBe(false)
    }
  })

  it('labels each by what it is rather than by its container', () => {
    expect(zipFormatLabel('.jar')).toBe('JAR')
    expect(zipFormatLabel('.war')).toBe('WAR')
    expect(zipFormatLabel('.zip')).toBe('ZIP')
  })
})

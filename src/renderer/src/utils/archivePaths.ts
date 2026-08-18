// Mirrors the archive path rules in src/services (extractor.ts and
// splitZipVolumes.ts). The services reach for fs and path, which cannot be
// bundled into the renderer, so the rules are restated here and pinned by a
// test that compares the two.

export const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz', '.gz', '.7z'] as const

export const NUMBERED_VOLUME_SUFFIX = /\.z\d{2,}$/i

export const SEVEN_ZIP_VOLUME_SUFFIX = /\.7z\.\d{3,}$/i

export function isNumberedVolumePath(archivePath: string): boolean {
  return NUMBERED_VOLUME_SUFFIX.test(archivePath)
}

export function isSevenZipVolumePath(archivePath: string): boolean {
  return SEVEN_ZIP_VOLUME_SUFFIX.test(archivePath)
}

export function isSupportedArchivePath(archivePath: string): boolean {
  const normalizedPath = archivePath.toLowerCase()
  if (SUPPORTED_ARCHIVE_EXTENSIONS.some(extension => normalizedPath.endsWith(extension))) return true
  // Neither `.z01` nor `.7z.001` ends in a supported extension.
  return isNumberedVolumePath(normalizedPath) || isSevenZipVolumePath(normalizedPath)
}

export function isZipArchivePath(archivePath: string): boolean {
  return archivePath.toLowerCase().endsWith('.zip') || isNumberedVolumePath(archivePath)
}

/** Rewrites any volume of a split set to the terminal `.zip` that holds its directory. */
export function terminalVolumePath(archivePath: string): string {
  if (!isNumberedVolumePath(archivePath)) return archivePath
  return `${archivePath.replace(NUMBERED_VOLUME_SUFFIX, '')}.zip`
}

/**
 * Every volume of one set shares this key, so a set dragged in whole collapses
 * to a single job instead of one job per volume.
 */
export function splitVolumeGroupKey(archivePath: string): string {
  return canonicalArchivePath(archivePath).toLowerCase()
}

/**
 * The one volume of a set that can be opened. ZIP keeps its directory in the
 * terminal volume, 7z keeps its headers in the first one.
 */
export function canonicalArchivePath(archivePath: string): string {
  if (isSevenZipVolumePath(archivePath)) {
    return `${archivePath.replace(SEVEN_ZIP_VOLUME_SUFFIX, '.7z')}.001`
  }
  return terminalVolumePath(archivePath)
}

/** Extensions offered in the extract file dialog, first volume included. */
export const EXTRACT_DIALOG_EXTENSIONS = ['zip', 'z01', 'tar', 'tgz', 'gz', '7z', '001']

// The compression formats the panel offers, mirroring compressor.ts's own
// union and capability helpers for the same reason as the path rules above.
export const COMPRESSION_FORMATS = ['zip', 'tar', 'gz', 'tgz', '7z'] as const

export type ArchiveFormat = (typeof COMPRESSION_FORMATS)[number]

/** ZIP encrypts with ZipCrypto for reach, 7z with AES-256. */
export function supportsPassword(format: ArchiveFormat): boolean {
  return format === 'zip' || format === '7z'
}

export function supportsSplit(format: ArchiveFormat): boolean {
  return format === 'zip' || format === '7z'
}

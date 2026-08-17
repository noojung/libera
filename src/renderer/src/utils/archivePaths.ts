// Mirrors the archive path rules in src/services (extractor.ts and
// splitZipVolumes.ts). The services reach for fs and path, which cannot be
// bundled into the renderer, so the rules are restated here and pinned by a
// test that compares the two.

export const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz', '.gz'] as const

export const NUMBERED_VOLUME_SUFFIX = /\.z\d{2,}$/i

export function isNumberedVolumePath(archivePath: string): boolean {
  return NUMBERED_VOLUME_SUFFIX.test(archivePath)
}

export function isSupportedArchivePath(archivePath: string): boolean {
  const normalizedPath = archivePath.toLowerCase()
  if (SUPPORTED_ARCHIVE_EXTENSIONS.some(extension => normalizedPath.endsWith(extension))) return true
  return isNumberedVolumePath(normalizedPath)
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
  const canonical = terminalVolumePath(archivePath)
  return canonical.toLowerCase()
}

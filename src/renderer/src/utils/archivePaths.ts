// Mirrors the archive path rules in src/services (extractor.ts and
// zip/volumes.ts). The services reach for fs and path, which cannot be
// bundled into the renderer, so the rules are restated here and pinned by a
// test that compares the two.

export const SUPPORTED_ARCHIVE_EXTENSIONS = [
  '.zip', '.jar', '.war', '.tar', '.tgz', '.tar.gz',
  '.tar.xz', '.txz', '.tar.bz2', '.tbz2', '.tbz',
  '.gz', '.7z'
] as const

export const NUMBERED_VOLUME_SUFFIX = /\.z\d{2,}$/i

export const SEVEN_ZIP_VOLUME_SUFFIX = /\.7z\.\d{3,}$/i

export function isNumberedVolumePath(archivePath: string): boolean {
  return NUMBERED_VOLUME_SUFFIX.test(archivePath)
}

export function isSevenZipVolumePath(archivePath: string): boolean {
  return SEVEN_ZIP_VOLUME_SUFFIX.test(archivePath)
}

export function isSevenZipArchivePath(archivePath: string): boolean {
  return archivePath.toLowerCase().endsWith('.7z') || isSevenZipVolumePath(archivePath)
}

export function isSupportedArchivePath(archivePath: string): boolean {
  const normalizedPath = archivePath.toLowerCase()
  if (SUPPORTED_ARCHIVE_EXTENSIONS.some(extension => normalizedPath.endsWith(extension))) return true
  // Neither `.z01` nor `.7z.001` ends in a supported extension.
  return isNumberedVolumePath(normalizedPath) || isSevenZipVolumePath(normalizedPath)
}

export function isZipArchivePath(archivePath: string): boolean {
  const normalizedPath = archivePath.toLowerCase()
  // A JAR and a WAR are ZIP containers, so they use the same reader.
  return normalizedPath.endsWith('.zip') ||
    normalizedPath.endsWith('.jar') ||
    normalizedPath.endsWith('.war') ||
    isNumberedVolumePath(archivePath)
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
export const EXTRACT_DIALOG_EXTENSIONS = [
  'zip', 'jar', 'war', 'z01', 'tar', 'tgz', 'txz', 'tbz2', 'tbz', 'xz', 'bz2', 'gz', '7z', '001'
]

// The compression formats the panel offers, mirroring compressor.ts's own
// union and capability helpers for the same reason as the path rules above.
export const COMPRESSION_FORMATS = ['zip', 'tar', 'gz', 'tgz', '7z'] as const

export type ArchiveFormat = (typeof COMPRESSION_FORMATS)[number]

/** ZIP and 7Z are the formats whose containers define an encryption scheme. */
export function supportsPassword(format: ArchiveFormat): boolean {
  return format === 'zip' || format === '7z'
}

/** Only 7Z can encrypt its header, which is what hides the file names. */
export function supportsHeaderEncryption(format: ArchiveFormat): boolean {
  return format === '7z'
}

export function supportsSplit(format: ArchiveFormat): boolean {
  return format === 'zip' || format === '7z'
}

const DEFLATE_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const
const SEVEN_ZIP_LEVELS = [0, 1, 3, 5, 7, 9] as const

/** The levels a format's writer actually distinguishes, in slider order. */
export function compressionLevels(format: ArchiveFormat): readonly number[] {
  if (format === 'tar') return []
  return format === '7z' ? SEVEN_ZIP_LEVELS : DEFLATE_LEVELS
}

/** TAR only concatenates files, so a compression level would do nothing. */
export function supportsLevel(format: ArchiveFormat): boolean {
  return compressionLevels(format).length > 0
}

/** The nearest level a format supports, so switching formats keeps the intent. */
export function nearestLevel(level: number, format: ArchiveFormat): number {
  const levels = compressionLevels(format)
  if (levels.length === 0) return level
  return levels.reduce((best, candidate) =>
    Math.abs(candidate - level) < Math.abs(best - level) ? candidate : best
  )
}

/** The extension written for each format. TGZ archives are named `.tar.gz`. */
const FORMAT_EXTENSIONS: Record<ArchiveFormat, string> = {
  zip: '.zip',
  tar: '.tar',
  gz: '.gz',
  tgz: '.tar.gz',
  '7z': '.7z'
}

/** Extensions the save dialog may leave behind, rewritten to the canonical one. */
const FORMAT_EXTENSION_ALIASES: Record<ArchiveFormat, readonly string[]> = {
  zip: [],
  tar: [],
  gz: [],
  tgz: ['.tgz', '.tar', '.gz'],
  '7z': []
}

export function archiveExtension(format: ArchiveFormat): string {
  return FORMAT_EXTENSIONS[format]
}

/** The single extension the save dialog filters on; `.tar.gz` filters as `gz`. */
export function saveDialogExtension(format: ArchiveFormat): string {
  return FORMAT_EXTENSIONS[format].split('.').pop() as string
}

/** How a format is named in the UI, so `tgz` reads as TAR.GZ. */
export function formatLabel(format: string): string {
  return (format === 'tgz' ? 'tar.gz' : format).toUpperCase()
}

/** Forces `filePath` to carry the format's extension, replacing a known alias. */
export function withArchiveExtension(filePath: string, format: ArchiveFormat): string {
  const canonical = FORMAT_EXTENSIONS[format]
  const normalizedPath = filePath.toLowerCase()
  if (normalizedPath.endsWith(canonical)) return filePath
  for (const alias of FORMAT_EXTENSION_ALIASES[format]) {
    if (normalizedPath.endsWith(alias)) return `${filePath.slice(0, -alias.length)}${canonical}`
  }
  return `${filePath}${canonical}`
}

/** The format an archive picked for extraction is listed under. */
export function formatFromArchiveName(archiveName: string): string {
  const normalizedName = archiveName.toLowerCase()
  if (normalizedName.endsWith('.tar.gz') || normalizedName.endsWith('.tgz')) return 'tgz'
  return normalizedName.split('.').pop() || 'zip'
}

/** An archive's name without its extension, `.tar.gz` counting as one. */
export function archiveBaseName(archiveName: string): string {
  if (archiveName.toLowerCase().endsWith('.tar.gz')) return archiveName.slice(0, -'.tar.gz'.length)
  return archiveName.replace(/\.[^/.]+$/, '')
}

/**
 * What each format the app reads can be asked to do.
 *
 * The same information sits in the README and on the site, so this is a third
 * copy - which is why it names only the format and its suffixes, and derives
 * every capability from the constants and helpers above. A test holds the
 * suffixes here against `SUPPORTED_ARCHIVE_EXTENSIONS`, so a format added there
 * and forgotten here fails rather than quietly disappearing from the list.
 */
export interface SupportedFormat {
  /** How the format is written in the UI, matching the README's table. */
  name: string
  extensions: readonly string[]
  compress: boolean
  extract: boolean
  /** Browsing the entries and previewing one, without writing anything out. */
  read: boolean
  password: boolean
  split: boolean
}

/** The compression format each readable one corresponds to, where there is one. */
const WRITABLE_AS: Partial<Record<string, ArchiveFormat>> = {
  ZIP: 'zip', '7Z': '7z', TAR: 'tar', 'TAR.GZ': 'tgz', GZ: 'gz'
}

const READABLE_FORMATS: readonly (readonly [string, readonly string[]])[] = [
  ['ZIP', ['.zip']],
  ['7Z', ['.7z']],
  ['TAR', ['.tar']],
  ['TAR.GZ', ['.tar.gz', '.tgz']],
  ['TAR.XZ', ['.tar.xz', '.txz']],
  ['TAR.BZ2', ['.tar.bz2', '.tbz2', '.tbz']],
  ['GZ', ['.gz']],
  ['JAR', ['.jar']],
  ['WAR', ['.war']]
]

export const SUPPORTED_FORMATS: readonly SupportedFormat[] = READABLE_FORMATS.map(
  ([name, extensions]) => {
    const writable = WRITABLE_AS[name]
    return {
      name,
      extensions,
      compress: writable !== undefined,
      // Being readable is what puts a format on this list at all; both are
      // carried as data so a format that ever loses one can say so.
      extract: true,
      read: true,
      password: writable !== undefined && supportsPassword(writable),
      split: writable !== undefined && supportsSplit(writable)
    }
  }
)

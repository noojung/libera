// Mirrors the archive path rules in src/services (extractor.ts and
// zip/volumes.ts). The services reach for fs and path, which cannot be
// bundled into the renderer, so the rules are restated here and pinned by a
// test that compares the two.

export const SUPPORTED_ARCHIVE_EXTENSIONS = [
  '.zip', '.jar', '.war', '.tar', '.tgz', '.tar.gz',
  '.tar.xz', '.txz', '.tar.bz2', '.tbz2', '.tbz',
  '.tar.zst', '.tzst',
  '.gz', '.xz', '.bz2', '.zst', '.7z'
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
  'zip', 'jar', 'war', 'z01', 'tar', 'tgz', 'txz', 'tbz2', 'tbz', 'tzst',
  'xz', 'bz2', 'zst', 'gz', '7z', '001'
]

// The compression formats the panel offers, mirroring compressor.ts's own
// union and capability helpers for the same reason as the path rules above.
export const COMPRESSION_FORMATS = ['zip', 'tar', 'gz', 'tgz', 'zst', 'tzst', '7z'] as const

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
const ZSTD_LEVELS = DEFLATE_LEVELS

/** The levels a format's writer actually distinguishes, in slider order. */
export function compressionLevels(format: ArchiveFormat): readonly number[] {
  if (format === 'tar') return []
  if (format === '7z') return SEVEN_ZIP_LEVELS
  return format === 'zst' || format === 'tzst' ? ZSTD_LEVELS : DEFLATE_LEVELS
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

/**
 * The extension written for each format. The two tar-inside-a-codec formats
 * are named for what they are - `.tar.gz` and `.tar.zst` - rather than for
 * their short aliases.
 */
const FORMAT_EXTENSIONS: Record<ArchiveFormat, string> = {
  zip: '.zip',
  tar: '.tar',
  gz: '.gz',
  tgz: '.tar.gz',
  zst: '.zst',
  tzst: '.tar.zst',
  '7z': '.7z'
}

/** Extensions the save dialog may leave behind, rewritten to the canonical one. */
const FORMAT_EXTENSION_ALIASES: Record<ArchiveFormat, readonly string[]> = {
  zip: [],
  tar: [],
  gz: [],
  tgz: ['.tgz', '.tar', '.gz'],
  zst: [],
  tzst: ['.tzst', '.tar', '.zst'],
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
  if (format === 'tgz') return 'TAR.GZ'
  if (format === 'tzst') return 'TAR.ZST'
  return format.toUpperCase()
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
  if (normalizedName.endsWith('.tar.zst') || normalizedName.endsWith('.tzst')) return 'tzst'
  return normalizedName.split('.').pop() || 'zip'
}

/** An archive's name without its extension, `.tar.gz` counting as one. */
export function archiveBaseName(archiveName: string): string {
  const normalizedName = archiveName.toLowerCase()
  for (const compound of ['.tar.gz', '.tar.xz', '.tar.bz2', '.tar.zst']) {
    if (normalizedName.endsWith(compound)) return archiveName.slice(0, -compound.length)
  }
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
  codecs: FormatCodecs
}

/**
 * The codecs a format carries. `write` is empty for one this app only reads,
 * and both are empty for TAR, which stores its entries rather than coding them.
 */
export interface FormatCodecs {
  write: readonly string[]
  read: readonly string[]
}

/**
 * What each format is coded with. A reader this app has but no writer for shows
 * up as a read entry alone, which is what makes the read-only rows read-only.
 */
const FORMAT_CODECS: Record<string, FormatCodecs> = {
  ZIP: {
    write: ['Store', 'Deflate', 'LZMA', 'Zstandard'],
    read: ['Store', 'Deflate', 'Deflate64', 'LZMA', 'Zstandard']
  },
  '7Z': {
    write: ['Copy', 'LZMA2'],
    read: ['Copy', 'LZMA', 'LZMA2', 'PPMd7', 'Deflate', 'Deflate64', 'BZip2']
  },
  TAR: { write: [], read: [] },
  'TAR.GZ': { write: ['Deflate'], read: ['Deflate'] },
  'TAR.XZ': { write: [], read: ['LZMA2'] },
  'TAR.BZ2': { write: [], read: ['BZip2'] },
  'TAR.ZST': { write: ['Zstandard'], read: ['Zstandard'] },
  GZ: { write: ['Deflate'], read: ['Deflate'] },
  XZ: { write: [], read: ['LZMA2'] },
  BZ2: { write: [], read: ['BZip2'] },
  ZST: { write: ['Zstandard'], read: ['Zstandard'] },
  JAR: { write: [], read: ['Store', 'Deflate', 'Deflate64'] },
  WAR: { write: [], read: ['Store', 'Deflate', 'Deflate64'] }
}

/** The compression format each readable one corresponds to, where there is one. */
const WRITABLE_AS: Partial<Record<string, ArchiveFormat>> = {
  ZIP: 'zip', '7Z': '7z', TAR: 'tar', 'TAR.GZ': 'tgz', 'TAR.ZST': 'tzst', GZ: 'gz', ZST: 'zst'
}

const READABLE_FORMATS: readonly (readonly [string, readonly string[]])[] = [
  ['ZIP', ['.zip']],
  ['7Z', ['.7z']],
  ['TAR', ['.tar']],
  ['TAR.GZ', ['.tar.gz', '.tgz']],
  ['TAR.XZ', ['.tar.xz', '.txz']],
  ['TAR.BZ2', ['.tar.bz2', '.tbz2', '.tbz']],
  ['TAR.ZST', ['.tar.zst', '.tzst']],
  ['GZ', ['.gz']],
  ['XZ', ['.xz']],
  ['BZ2', ['.bz2']],
  ['ZST', ['.zst']],
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
      split: writable !== undefined && supportsSplit(writable),
      // A format with no entry here is one nobody said how to code, which the
      // table would render as a blank cell rather than fail on.
      codecs: FORMAT_CODECS[name] ?? { write: [], read: [] }
    }
  }
)

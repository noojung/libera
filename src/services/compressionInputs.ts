import { createArchiveEntryFilter } from './entryPatterns'

// The source-side filters every writer honours. Extraction has the mirror of
// these in extractor.ts - `restoreSymlinks`, `excludeMacMetadata` and
// `filterPattern` - and these decide what reaches the archive in the first
// place.

export interface CompressionInputFilters {
  /** Drops symbolic links instead of storing them as link entries. */
  excludeSymlinks?: boolean
  /** Drops the bookkeeping files macOS leaves in a folder it has opened. */
  excludeMacMetadata?: boolean
  /** Drops dot-prefixed names, and everything below a dot-prefixed folder. */
  excludeHiddenFiles?: boolean
  /** The glob list that decides which files are worth archiving at all. */
  filterPattern?: string
}

/**
 * True for a name macOS writes for itself: the Finder's per-folder `.DS_Store`,
 * the `__MACOSX` folder an archiver adds, and the `._name` AppleDouble sidecars
 * that carry resource forks on filesystems without them.
 *
 * Extraction has `isMacMetadataPath`, which reads whole archive paths and
 * leaves `._name` alone because the extractor merges those sidecars back into
 * the file they describe. Nothing merges them on the way in, so a compression
 * filter that kept them would leave the noise it was asked to remove.
 */
export function isMacMetadataName(name: string): boolean {
  return name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._')
}

/**
 * True for a name every desktop platform hides by convention. Windows also has
 * a hidden attribute of its own, but a filter that read it would hide files the
 * user can see in Explorer on one platform and not the other, so the dot is the
 * only rule here.
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..'
}

/** True when any segment of a relative path is macOS bookkeeping. */
export function hasMacMetadataSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some(segment => segment.length > 0 && isMacMetadataName(segment))
}

/**
 * The Unix mode a stored link entry carries. The link type has to be spelled
 * out because Windows reports no permission bits of its own, and readers -
 * this app's included - recognise a link entry by that type alone.
 */
export function symlinkUnixMode(mode: number): number {
  return 0o120000 | ((mode & 0o7777) || 0o777)
}

/** What each walk knows about the entry it is standing on. */
export interface InputEntryKind {
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/**
 * The filter set as the two questions a directory walk actually asks, built
 * once per job so the pattern list is parsed once rather than per entry.
 *
 * The split is not cosmetic. A blocked *name* prunes the subtree under it -
 * `.git` and `__MACOSX` are worth nothing without their contents - while the
 * pattern only ever drops leaves, since a folder that matches no pattern still
 * holds the files that do.
 */
export interface CompressionInputFilter {
  /** False for a walk step whose whole subtree should be skipped. */
  allowsName(name: string): boolean
  /** `allowsName` over every segment, for walks that skip no step of their own. */
  allowsPath(relativePath: string): boolean
  /** False for an entry that must not be written, given what it is. */
  allowsEntry(relativePath: string, kind: InputEntryKind): boolean
}

export function createCompressionInputFilter(
  filters: CompressionInputFilters = {}
): CompressionInputFilter {
  const matchesPattern = createArchiveEntryFilter(filters.filterPattern)
  const blocksName = (name: string): boolean =>
    (filters.excludeMacMetadata === true && isMacMetadataName(name)) ||
    (filters.excludeHiddenFiles === true && isHiddenName(name))

  return {
    allowsName: name => !blocksName(name),
    allowsPath: relativePath => relativePath
      .split(/[\\/]/)
      .every(segment => segment.length === 0 || !blocksName(segment)),
    allowsEntry: (relativePath, kind) => {
      if (filters.excludeSymlinks === true && kind.isSymbolicLink()) return false
      // A folder carries no content of its own to match against.
      if (kind.isDirectory()) return true
      return matchesPattern(relativePath)
    }
  }
}

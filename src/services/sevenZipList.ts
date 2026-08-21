import { runSevenZip, SevenZipError } from './sevenZip'
import { Libera7zError } from '../lib/libera7z'
import { canFallbackFromLibera7z, openLibera7zFile } from './libera7zNode'
import { isSevenZipVolumePath } from './sevenZipVolumes'

// Reading `7za l -slt`. The inspector, the previewer and the extractor all go
// through here so that an entry's position in the list means the same thing to
// each of them - the preview ids are positional, so a second opinion about
// ordering would silently preview the wrong file.

export interface SevenZipEntry {
  path: string
  size: number
  packedSize?: number
  isDirectory: boolean
  isSymlink: boolean
  encrypted: boolean
  mode?: number
  modified?: string
  crc?: string
}

export interface SevenZipListing {
  entries: SevenZipEntry[]
  volumeCount: number
  anyEncrypted: boolean
}

// Entries follow the last run of dashes; everything above it describes the
// archive itself, and a split set adds a second `Type = Split` block there.
const ENTRY_SECTION_SEPARATOR = /^-{10,}$/
const PROPERTY_PATTERN = /^([A-Za-z][A-Za-z0-9 ]*) = ?(.*)$/

/**
 * Turns the permission part of an `Attributes` value into a mode. p7zip writes
 * it as a ten character `ls` string (`-rw-r--r--`, `drwxr-xr-x`); archives made
 * by Windows tools carry no such part and simply produce no mode.
 */
export function parseUnixModeString(value: string): number | undefined {
  if (!/^[-dlbcps][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]$/.test(value)) return undefined

  let mode = 0
  for (let index = 0; index < 9; index += 1) {
    if (value[index + 1] !== '-') mode |= 1 << (8 - index)
  }
  return mode
}

function parseAttributes(value: string): { isDirectory: boolean; isSymlink: boolean; mode?: number } {
  const parts = value.trim().split(/\s+/)
  const dosPart = parts[0] ?? ''
  const unixPart = parts.find(part => part.length === 10 && parseUnixModeString(part) !== undefined)

  return {
    isDirectory: dosPart.includes('D') || unixPart?.startsWith('d') === true,
    isSymlink: unixPart?.startsWith('l') === true,
    mode: unixPart ? parseUnixModeString(unixPart) : undefined
  }
}

function parseNumber(value: string | undefined): number {
  if (!value) return 0
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function toEntry(properties: Map<string, string>): SevenZipEntry | null {
  const path = properties.get('Path')
  if (!path) return null

  // An "anti" entry is a deletion marker for incremental backups, not content.
  if (properties.get('Anti') === '+') return null

  const attributes = parseAttributes(properties.get('Attributes') ?? '')
  const isDirectory = attributes.isDirectory || properties.get('Folder') === '+'

  return {
    path,
    size: parseNumber(properties.get('Size')),
    packedSize: properties.has('Packed Size') ? parseNumber(properties.get('Packed Size')) : undefined,
    isDirectory,
    isSymlink: attributes.isSymlink && !isDirectory,
    encrypted: properties.get('Encrypted') === '+',
    mode: attributes.mode,
    modified: properties.get('Modified') || undefined,
    crc: properties.get('CRC') || undefined
  }
}

/**
 * Parses `-slt` output. Pure, so the hostile shapes worth testing - a `..`
 * path, an absolute path, a truncated block - need no archive to reproduce.
 */
export function parseSevenZipListing(output: string): SevenZipListing {
  const lines = output.split(/\r?\n/)

  let separatorIndex = -1
  let volumeCount = 1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (ENTRY_SECTION_SEPARATOR.test(line.trim())) separatorIndex = index
    const volumeMatch = /^Volumes = (\d+)$/.exec(line.trim())
    if (volumeMatch && separatorIndex === -1) volumeCount = Number(volumeMatch[1])
  }

  const entries: SevenZipEntry[] = []
  let anyEncrypted = false
  let properties = new Map<string, string>()

  const flush = () => {
    if (properties.size === 0) return
    const entry = toEntry(properties)
    if (entry) {
      entries.push(entry)
      if (entry.encrypted) anyEncrypted = true
    }
    properties = new Map()
  }

  for (const line of lines.slice(separatorIndex + 1)) {
    if (!line.trim()) {
      flush()
      continue
    }
    const match = PROPERTY_PATTERN.exec(line)
    // A `Path` starts a new block even without the blank line before it.
    if (!match) continue
    if (match[1] === 'Path' && properties.has('Path')) flush()
    properties.set(match[1], match[2])
  }
  flush()

  return { entries, volumeCount, anyEncrypted }
}

export interface ListSevenZipOptions {
  password?: string
  signal?: AbortSignal
  maxEntries?: number
}

/**
 * Lists an archive. `--` keeps an archive whose name begins with a dash from
 * being read as a switch.
 */
export async function listSevenZipEntries(
  archivePath: string,
  options: ListSevenZipOptions = {}
): Promise<SevenZipListing> {
  if (!isSevenZipVolumePath(archivePath)) {
    try {
      const archive = await openLibera7zFile(archivePath, {
        signal: options.signal,
        maxEntries: options.maxEntries
      })
      try {
        const entries = archive.entries.map(entry => {
          const size = Number(entry.size)
          const packedSize = entry.packedSize === undefined ? undefined : Number(entry.packedSize)
          if (!Number.isSafeInteger(size) || (packedSize !== undefined && !Number.isSafeInteger(packedSize))) {
            throw new SevenZipError('SEVEN_ZIP_FAILED', '7z entry size exceeds JavaScript safe integer range')
          }
          return {
            path: entry.path,
            size,
            packedSize,
            isDirectory: entry.isDirectory,
            isSymlink: false,
            encrypted: false,
            mode: entry.mode,
            modified: entry.modified?.toISOString(),
            crc: entry.crc?.toString(16).toUpperCase().padStart(8, '0')
          }
        })
        return { entries, volumeCount: 1, anyEncrypted: false }
      } finally {
        await archive.close()
      }
    } catch (error) {
      if (error instanceof Libera7zError && error.code === 'CANCELLED') {
        throw new SevenZipError('SEVEN_ZIP_CANCELLED', '7z listing was cancelled')
      }
      if (!canFallbackFromLibera7z(error)) throw error
    }
  }

  const { stdout } = await runSevenZip(['l', '-slt', '--', archivePath], options.password, {
    signal: options.signal,
    timeoutMs: 60_000
  })

  const listing = parseSevenZipListing(stdout)
  if (options.maxEntries !== undefined && listing.entries.length > options.maxEntries) {
    throw new SevenZipError(
      'SEVEN_ZIP_FAILED',
      `archive contains more than ${options.maxEntries.toLocaleString()} entries`
    )
  }
  return listing
}

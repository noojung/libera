import { promises as fsPromises } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'

// Reading of AppleDouble `._name` sidecars, the form macOS archivers use to
// carry a file's extended attributes and resource fork through formats that
// have no place for them. Left as plain files they pollute a `.app` bundle and
// break its sealed code signature, so on macOS they are folded back onto the
// file they describe instead of being written out.

const execFileAsync = promisify(execFile)

const APPLE_DOUBLE_MAGIC = 0x00051607
const APPLE_DOUBLE_VERSION = 0x00020000
const HEADER_LENGTH = 26
const DESCRIPTOR_LENGTH = 12
const ENTRY_RESOURCE_FORK = 2
const ENTRY_FINDER_INFO = 9
const FINDER_INFO_LENGTH = 32

// The extended attributes macOS stores after the 32 byte Finder info block.
const ATTR_MAGIC = 0x41545452 // 'ATTR'
const ATTR_HEADER_LENGTH = 36
const ATTR_ENTRY_HEADER_LENGTH = 11

export const APPLE_DOUBLE_PREFIX = '._'
/** Sidecars are metadata; anything larger is treated as an ordinary file. */
export const MAX_APPLE_DOUBLE_BYTES = 8 * 1024 * 1024
/**
 * `xattr` takes the value as an argument, so a very large attribute would
 * overflow ARG_MAX. Resource forks avoid this by going through the named fork.
 */
const MAX_XATTR_VALUE_BYTES = 256 * 1024

export interface AppleDoubleAttribute {
  name: string
  value: Buffer
}

export interface AppleDoubleMetadata {
  finderInfo?: Buffer
  resourceFork?: Buffer
  attributes: AppleDoubleAttribute[]
}

/**
 * The path an AppleDouble sidecar describes, or null when the name is not a
 * sidecar name. Only a sidecar whose subject is also present in the archive is
 * worth folding in; a lone `._name` is just a file.
 */
export function appleDoubleSubjectPath(entryPath: string): string | null {
  const normalizedPath = entryPath.replace(/\\/g, '/')
  const separatorIndex = normalizedPath.lastIndexOf('/')
  const directory = separatorIndex === -1 ? '' : normalizedPath.slice(0, separatorIndex + 1)
  const baseName = normalizedPath.slice(separatorIndex + 1)

  if (!baseName.startsWith(APPLE_DOUBLE_PREFIX) || baseName.length === APPLE_DOUBLE_PREFIX.length) return null
  return `${directory}${baseName.slice(APPLE_DOUBLE_PREFIX.length)}`
}

function isPrintableAttributeName(name: string): boolean {
  return name.length > 0 && name.length <= 127 && /^[\x21-\x7e]+$/.test(name)
}

/**
 * macOS pads the Finder info block out to a 4 byte boundary before writing the
 * attribute header, so the header does not reliably start right after it.
 */
function findAttributeSection(buffer: Buffer, searchStart: number): number {
  const lastCandidate = Math.min(searchStart + 3, buffer.length - 4)
  for (let offset = searchStart; offset <= lastCandidate; offset++) {
    if (buffer.readUInt32BE(offset) === ATTR_MAGIC) return offset
  }
  return -1
}

function readAttributes(buffer: Buffer, searchStart: number): AppleDoubleAttribute[] {
  const sectionStart = findAttributeSection(buffer, searchStart)
  if (sectionStart === -1 || sectionStart + ATTR_HEADER_LENGTH > buffer.length) return []

  const attributeCount = buffer.readUInt16BE(sectionStart + 34)
  const attributes: AppleDoubleAttribute[] = []
  let cursor = sectionStart + ATTR_HEADER_LENGTH

  for (let index = 0; index < attributeCount; index++) {
    if (cursor + ATTR_ENTRY_HEADER_LENGTH > buffer.length) break

    // Offsets in an attribute entry are measured from the start of the file.
    const valueOffset = buffer.readUInt32BE(cursor)
    const valueLength = buffer.readUInt32BE(cursor + 4)
    const nameLength = buffer.readUInt8(cursor + 10)
    const nameStart = cursor + ATTR_ENTRY_HEADER_LENGTH
    if (nameLength === 0 || nameStart + nameLength > buffer.length) break

    // The recorded length counts the terminating NUL byte.
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength - 1)
    const valueEnd = valueOffset + valueLength
    if (valueEnd > valueOffset && valueEnd <= buffer.length && isPrintableAttributeName(name)) {
      attributes.push({ name, value: buffer.subarray(valueOffset, valueEnd) })
    }

    // Each entry is padded so the next one starts on a 4 byte boundary.
    cursor = nameStart + nameLength
    cursor += (4 - (cursor % 4)) % 4
  }

  return attributes
}

/**
 * Reads a sidecar's contents, or null when the bytes are not AppleDouble at
 * all - in which case the caller should keep treating the entry as a file. A
 * well formed sidecar that turns out to carry nothing still parses, so that it
 * is dropped rather than written out beside the file it describes.
 */
export function parseAppleDouble(buffer: Buffer): AppleDoubleMetadata | null {
  if (buffer.length < HEADER_LENGTH) return null
  if (buffer.readUInt32BE(0) !== APPLE_DOUBLE_MAGIC) return null
  if (buffer.readUInt32BE(4) !== APPLE_DOUBLE_VERSION) return null

  const descriptorCount = buffer.readUInt16BE(24)
  if (HEADER_LENGTH + descriptorCount * DESCRIPTOR_LENGTH > buffer.length) return null

  const metadata: AppleDoubleMetadata = { attributes: [] }

  for (let index = 0; index < descriptorCount; index++) {
    const descriptorStart = HEADER_LENGTH + index * DESCRIPTOR_LENGTH
    const entryId = buffer.readUInt32BE(descriptorStart)
    const entryOffset = buffer.readUInt32BE(descriptorStart + 4)
    const entryLength = buffer.readUInt32BE(descriptorStart + 8)
    if (entryLength === 0 || entryOffset + entryLength > buffer.length) continue

    if (entryId === ENTRY_RESOURCE_FORK) {
      metadata.resourceFork = buffer.subarray(entryOffset, entryOffset + entryLength)
      continue
    }
    if (entryId !== ENTRY_FINDER_INFO || entryLength < FINDER_INFO_LENGTH) continue

    const finderInfo = buffer.subarray(entryOffset, entryOffset + FINDER_INFO_LENGTH)
    // An all zero Finder info block carries nothing worth restoring.
    if (finderInfo.some(byte => byte !== 0)) metadata.finderInfo = finderInfo
    if (entryLength > FINDER_INFO_LENGTH) {
      metadata.attributes = readAttributes(buffer, entryOffset + FINDER_INFO_LENGTH)
    }
  }

  return metadata
}

async function writeExtendedAttribute(targetPath: string, name: string, value: Buffer): Promise<void> {
  if (value.length > MAX_XATTR_VALUE_BYTES) return
  await execFileAsync('xattr', ['-wx', name, value.toString('hex'), targetPath])
}

/**
 * Folds a parsed sidecar onto the file it describes. Metadata is best effort:
 * a rejected attribute must not fail an extraction whose file contents are
 * already correct, which is also how `ditto` treats them.
 */
export async function applyAppleDouble(targetPath: string, metadata: AppleDoubleMetadata): Promise<void> {
  if (metadata.resourceFork) {
    // macOS exposes the resource fork as a path, which keeps a large fork off
    // the `xattr` command line entirely.
    await fsPromises
      .writeFile(`${targetPath}/..namedfork/rsrc`, metadata.resourceFork)
      .catch(() => undefined)
  }

  if (metadata.finderInfo) {
    await writeExtendedAttribute(targetPath, 'com.apple.FinderInfo', metadata.finderInfo).catch(() => undefined)
  }

  for (const attribute of metadata.attributes) {
    await writeExtendedAttribute(targetPath, attribute.name, attribute.value).catch(() => undefined)
  }
}

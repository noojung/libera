import { describe, expect, it } from 'vitest'
import { appleDoubleSubjectPath, parseAppleDouble } from './appleDouble'

const APPLE_DOUBLE_MAGIC = 0x00051607
const APPLE_DOUBLE_VERSION = 0x00020000
const ENTRY_FINDER_INFO = 9
const ENTRY_RESOURCE_FORK = 2

function align4(offset: number): number {
  return offset + ((4 - (offset % 4)) % 4)
}

/**
 * Builds the layout macOS writes: a 32 byte Finder info block padded out to a 4
 * byte boundary, then the attribute header, entries and values.
 */
function buildAppleDouble(
  attributes: { name: string; value: Buffer }[],
  options: { finderInfo?: Buffer; resourceFork?: Buffer } = {}
): Buffer {
  const descriptorCount = options.resourceFork ? 2 : 1
  const finderInfoOffset = 26 + descriptorCount * 12
  const attrHeaderOffset = align4(finderInfoOffset + 32)

  let cursor = attrHeaderOffset + 36
  const entries = attributes.map(attribute => {
    const nameLength = Buffer.byteLength(attribute.name) + 1
    const start = cursor
    cursor = align4(start + 11 + nameLength)
    return { ...attribute, nameLength, start }
  })

  const dataStart = cursor
  const valueOffsets: number[] = []
  for (const entry of entries) {
    valueOffsets.push(cursor)
    cursor += entry.value.length
  }
  const finderInfoEnd = cursor
  const resourceForkOffset = cursor
  const total = cursor + (options.resourceFork?.length ?? 0)

  const buffer = Buffer.alloc(total)
  buffer.writeUInt32BE(APPLE_DOUBLE_MAGIC, 0)
  buffer.writeUInt32BE(APPLE_DOUBLE_VERSION, 4)
  buffer.writeUInt16BE(descriptorCount, 24)

  buffer.writeUInt32BE(ENTRY_FINDER_INFO, 26)
  buffer.writeUInt32BE(finderInfoOffset, 30)
  buffer.writeUInt32BE(finderInfoEnd - finderInfoOffset, 34)
  options.finderInfo?.copy(buffer, finderInfoOffset)

  if (options.resourceFork) {
    buffer.writeUInt32BE(ENTRY_RESOURCE_FORK, 38)
    buffer.writeUInt32BE(resourceForkOffset, 42)
    buffer.writeUInt32BE(options.resourceFork.length, 46)
    options.resourceFork.copy(buffer, resourceForkOffset)
  }

  buffer.write('ATTR', attrHeaderOffset, 'ascii')
  buffer.writeUInt32BE(total, attrHeaderOffset + 8)
  buffer.writeUInt32BE(dataStart, attrHeaderOffset + 12)
  buffer.writeUInt16BE(attributes.length, attrHeaderOffset + 34)

  entries.forEach((entry, index) => {
    buffer.writeUInt32BE(valueOffsets[index], entry.start)
    buffer.writeUInt32BE(entry.value.length, entry.start + 4)
    buffer.writeUInt8(entry.nameLength, entry.start + 10)
    buffer.write(entry.name, entry.start + 11, 'ascii')
    entry.value.copy(buffer, valueOffsets[index])
  })

  return buffer
}

describe('appleDoubleSubjectPath', () => {
  it('names the file a sidecar describes', () => {
    expect(appleDoubleSubjectPath('dir/._notes.txt')).toBe('dir/notes.txt')
    expect(appleDoubleSubjectPath('._notes.txt')).toBe('notes.txt')
  })

  it('ignores names that are not sidecars', () => {
    expect(appleDoubleSubjectPath('dir/notes.txt')).toBeNull()
    expect(appleDoubleSubjectPath('dir/._')).toBeNull()
    expect(appleDoubleSubjectPath('._dir/notes.txt')).toBeNull()
  })
})

describe('parseAppleDouble', () => {
  it('reads attributes written after the padded Finder info block', () => {
    const buffer = buildAppleDouble([
      { name: 'com.apple.cs.CodeDirectory', value: Buffer.from('directory-bytes') },
      { name: 'com.apple.cs.CodeSignature', value: Buffer.from('signature-bytes') }
    ])

    const metadata = parseAppleDouble(buffer)

    expect(metadata?.attributes.map(attribute => attribute.name)).toEqual([
      'com.apple.cs.CodeDirectory',
      'com.apple.cs.CodeSignature'
    ])
    expect(metadata?.attributes[0].value.toString()).toBe('directory-bytes')
    expect(metadata?.attributes[1].value.toString()).toBe('signature-bytes')
  })

  it('reads the resource fork and a non-empty Finder info block', () => {
    const finderInfo = Buffer.alloc(32)
    finderInfo.write('ICON', 0, 'ascii')
    const buffer = buildAppleDouble([], { finderInfo, resourceFork: Buffer.from('fork-bytes') })

    const metadata = parseAppleDouble(buffer)

    expect(metadata?.resourceFork?.toString()).toBe('fork-bytes')
    expect(metadata?.finderInfo?.subarray(0, 4).toString()).toBe('ICON')
  })

  it('omits an all zero Finder info block', () => {
    const metadata = parseAppleDouble(buildAppleDouble([], { finderInfo: Buffer.alloc(32) }))

    expect(metadata).not.toBeNull()
    expect(metadata?.finderInfo).toBeUndefined()
  })

  it('rejects bytes that are not AppleDouble so they stay ordinary files', () => {
    expect(parseAppleDouble(Buffer.from('just a file that starts with a dot underscore'))).toBeNull()
    expect(parseAppleDouble(Buffer.alloc(4))).toBeNull()
  })

  it('ignores an attribute whose value runs past the end of the sidecar', () => {
    const buffer = buildAppleDouble([{ name: 'com.apple.test', value: Buffer.from('value') }])
    // Point the single attribute's value beyond the buffer.
    const attrHeaderOffset = buffer.indexOf(Buffer.from('ATTR', 'ascii'))
    buffer.writeUInt32BE(buffer.length + 1024, attrHeaderOffset + 36)

    expect(parseAppleDouble(buffer)?.attributes).toEqual([])
  })
})

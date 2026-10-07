import { type ByteSource, inflateExact, invalid, u32be, u32le, u64le, unsupported } from './bytes'
import { decodeLzfse } from './lzfse'
import { decodeLzvn } from './lzvn'

// Filesystem compression, which HFS+ and APFS share. A compressed file's data
// fork is empty; its `com.apple.decmpfs` attribute opens with a header naming
// the codec and the expanded size. Small files keep the compressed bytes in
// that attribute; larger ones keep them in the resource fork, cut into 64 KiB
// chunks that each compress on their own.

export const DECMPFS_ATTRIBUTE = 'com.apple.decmpfs'
export const RESOURCE_FORK_ATTRIBUTE = 'com.apple.ResourceFork'
/** The BSD flag that marks a file as compressed. */
export const UF_COMPRESSED = 0x20

const MAGIC = 0x636d7066
const CHUNK = 64 * 1024
// Attribute-held data decodes in one piece, so it gets a ceiling of its own.
const MAX_ATTRIBUTE_BYTES = 64 * 1024 * 1024
const MAX_CHUNKS = 1 << 24

const ZLIB_ATTRIBUTE = 3
const ZLIB_FORK = 4
const LZVN_ATTRIBUTE = 7
const LZVN_FORK = 8
const STORED_ATTRIBUTE = 9
const STORED_FORK = 10
const LZFSE_ATTRIBUTE = 11
const LZFSE_FORK = 12

export function decmpfsSize(header: Uint8Array): number {
  if (header.length < 16 || u32le(header, 0) !== MAGIC) invalid('malformed compressed file header')
  return u64le(header, 8)
}

export function decmpfsUsesResourceFork(header: Uint8Array): boolean {
  return [ZLIB_FORK, LZVN_FORK, STORED_FORK, LZFSE_FORK].includes(u32le(header, 4))
}

function stored(data: Uint8Array, size: number): Uint8Array {
  if (data.length < size) invalid('compressed file data is truncated')
  return data.subarray(0, size)
}

async function decodeChunk(type: number, data: Uint8Array, size: number): Promise<Uint8Array> {
  switch (type) {
    case ZLIB_ATTRIBUTE:
    case ZLIB_FORK:
      // A leading 0xff marks a chunk that did not compress and was stored.
      return data[0] === 0xff ? stored(data.subarray(1), size) : inflateExact(data, size)
    case LZVN_ATTRIBUTE:
    case LZVN_FORK:
      return data[0] === 0x06 ? stored(data.subarray(1), size) : decodeLzvn(data, size)
    case LZFSE_ATTRIBUTE:
    case LZFSE_FORK:
      return data[0] === 0xff ? stored(data.subarray(1), size) : decodeLzfse(data, size)
    default:
      return data.length === size + 1 && data[0] === 0xff ? stored(data.subarray(1), size) : stored(data, size)
  }
}

/** Streams a compressed file's expanded bytes. */
export async function* readDecmpfs(header: Uint8Array, resourceFork: ByteSource | undefined): AsyncGenerator<Uint8Array> {
  const size = decmpfsSize(header)
  const type = u32le(header, 4)
  if (![ZLIB_ATTRIBUTE, ZLIB_FORK, LZVN_ATTRIBUTE, LZVN_FORK, STORED_ATTRIBUTE, STORED_FORK, LZFSE_ATTRIBUTE, LZFSE_FORK].includes(type)) {
    unsupported(`filesystem compression type ${type}`)
  }
  if (size === 0) return
  if (!decmpfsUsesResourceFork(header)) {
    if (size > MAX_ATTRIBUTE_BYTES) invalid('compressed attribute is too large')
    yield await decodeChunk(type, header.subarray(16), size)
    return
  }
  if (!resourceFork) invalid('compressed file has no resource fork')
  const count = Math.ceil(size / CHUNK)
  if (count > MAX_CHUNKS) invalid('compressed file is too large')
  // zlib keeps a classic resource fork, whose one resource holds a table of
  // (offset, size) pairs. The other codecs write a bare table of offsets.
  const spans: [number, number][] = []
  if (type === ZLIB_FORK) {
    const head = await resourceFork.read(0, 16)
    const dataOffset = u32be(head, 0)
    const table = await resourceFork.read(dataOffset, 8 + count * 8)
    if (u32le(table, 4) !== count) invalid('compressed file chunk count does not match')
    const base = dataOffset + 4
    for (let i = 0; i < count; i++) spans.push([base + u32le(table, 8 + i * 8), u32le(table, 12 + i * 8)])
  } else {
    const table = await resourceFork.read(0, (count + 1) * 4)
    if (u32le(table, 0) !== (count + 1) * 4) invalid('compressed file chunk count does not match')
    for (let i = 0; i < count; i++) {
      const start = u32le(table, i * 4)
      const end = u32le(table, i * 4 + 4)
      if (end < start) invalid('malformed compressed file chunk table')
      spans.push([start, end - start])
    }
  }
  for (let i = 0; i < count; i++) {
    const [offset, length] = spans[i]
    if (length > CHUNK * 2) invalid('compressed file chunk is too large')
    yield await decodeChunk(type, await resourceFork.read(offset, length), Math.min(CHUNK, size - i * CHUNK))
  }
}

import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import zlib from 'zlib'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { isPrecompressedName, maxDeflatedSize, shouldStoreEntry } from './storeHeuristics'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-store-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeFile(name: string, contents: Buffer | string): Promise<string> {
  const filePath = path.join(await createTemporaryDirectory(), name)
  await fs.writeFile(filePath, contents)
  return filePath
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ))
})

describe('isPrecompressedName', () => {
  it('recognises the formats that carry their own compression, whatever the case', () => {
    expect(isPrecompressedName('holiday.jpg')).toBe(true)
    expect(isPrecompressedName('/photos/Holiday.JPEG')).toBe(true)
    expect(isPrecompressedName('screenshot.png')).toBe(true)
    expect(isPrecompressedName('clip.mp4')).toBe(true)
    expect(isPrecompressedName('bundle.zip')).toBe(true)
    expect(isPrecompressedName('report.docx')).toBe(true)
  })

  it('leaves everything else to be measured', () => {
    expect(isPrecompressedName('notes.txt')).toBe(false)
    expect(isPrecompressedName('data.csv')).toBe(false)
    expect(isPrecompressedName('archive.tar')).toBe(false)
    expect(isPrecompressedName('README')).toBe(false)
  })
})

describe('maxDeflatedSize', () => {
  it('leaves room for the stored blocks deflate falls back to', () => {
    // Every 64 KiB block that cannot be compressed is framed in five bytes.
    expect(maxDeflatedSize(0)).toBeGreaterThanOrEqual(0)
    expect(maxDeflatedSize(65535)).toBeGreaterThan(65535)
    expect(zlib.deflateRawSync(crypto.randomBytes(256 * 1024), { level: 6 }).length)
      .toBeLessThanOrEqual(maxDeflatedSize(256 * 1024))
  })
})

describe('shouldStoreEntry', () => {
  it('stores a file whose bytes deflate no smaller than they arrived', async () => {
    // The complaint this rule answers: a short text file left deflate with
    // nothing to find, so the entry came out bigger than the file.
    const tiny = await writeFile('note.txt', 'hello')
    expect(shouldStoreEntry(tiny, 5, 6)).toBe(true)

    const random = await writeFile('blob.bin', crypto.randomBytes(4096))
    expect(shouldStoreEntry(random, 4096, 6)).toBe(true)
  })

  it('compresses a file that deflate can shrink', async () => {
    const text = await writeFile('notes.txt', 'the quick brown fox\n'.repeat(200))
    expect(shouldStoreEntry(text, (await fs.stat(text)).size, 6)).toBe(false)
  })

  it('stores an already-compressed format on its name alone', async () => {
    // Compressible bytes under a name that says otherwise. The point of the
    // name is to skip the read: a photo library is not worth a pass over
    // every byte for the few percent deflate would find in some of it.
    const jpeg = await writeFile('photo.jpg', Buffer.alloc(128 * 1024, 0x41))
    expect(shouldStoreEntry(jpeg, 128 * 1024, 6)).toBe(true)
  })

  it('measures anything the name does not settle', async () => {
    const misnamed = await writeFile('notes.txt', crypto.randomBytes(128 * 1024))
    expect(shouldStoreEntry(misnamed, 128 * 1024, 6)).toBe(true)
  })

  it('weighs the whole file, not the part that happens to compress', async () => {
    // A compressible header on an incompressible payload: worth compressing,
    // because the header is a real saving and the payload costs nothing.
    const size = 4 * 1024 * 1024
    const withHeader = await writeFile('clip.bin', Buffer.concat([
      Buffer.alloc(64 * 1024, 0x41),
      crypto.randomBytes(size - 64 * 1024)
    ]))
    expect(shouldStoreEntry(withHeader, size, 6)).toBe(false)

    // The same payload with nothing to find anywhere in it.
    const payload = await writeFile('payload.bin', crypto.randomBytes(size))
    expect(shouldStoreEntry(payload, size, 6)).toBe(true)
  })

  it('stores empty files and anything at level 0', async () => {
    const empty = await writeFile('empty.txt', '')
    expect(shouldStoreEntry(empty, 0, 6)).toBe(true)

    const text = await writeFile('notes.txt', 'the quick brown fox\n'.repeat(200))
    expect(shouldStoreEntry(text, (await fs.stat(text)).size, 0)).toBe(true)
  })

  it('leaves an unreadable file to the writer rather than deciding for it', () => {
    expect(shouldStoreEntry(path.join(os.tmpdir(), 'libera-store-missing.txt'), 10, 6)).toBe(false)
  })
})

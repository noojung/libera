import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { PROBE_BYTES, probeOffsets, sampleResistsDeflate, shouldStoreEntry } from './storeHeuristics'

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

describe('probeOffsets', () => {
  it('reads a file it can judge whole in one window', () => {
    expect(probeOffsets(PROBE_BYTES)).toEqual([0])
    expect(probeOffsets(1)).toEqual([0])
  })

  it('spreads its windows over the start, middle and end of a longer file', () => {
    const size = 10 * 1024 * 1024
    const offsets = probeOffsets(size)
    expect(offsets).toHaveLength(3)
    expect(offsets[0]).toBe(0)
    expect(offsets[2]).toBe(size - 32 * 1024)
    expect(offsets[1]).toBe(offsets[2] / 2)
  })
})

describe('sampleResistsDeflate', () => {
  it('holds that random bytes and empty input are not worth compressing', () => {
    expect(sampleResistsDeflate(crypto.randomBytes(64 * 1024), 6)).toBe(true)
    expect(sampleResistsDeflate(new Uint8Array(0), 6)).toBe(true)
  })

  it('holds that repetitive bytes are', () => {
    expect(sampleResistsDeflate(Buffer.alloc(4096, 0x41), 6)).toBe(false)
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

  it('judges by the bytes, not by the name', async () => {
    const named = await writeFile('photo.jpg', Buffer.alloc(128 * 1024, 0x41))
    expect(shouldStoreEntry(named, 128 * 1024, 6)).toBe(false)

    const misnamed = await writeFile('notes.txt', crypto.randomBytes(128 * 1024))
    expect(shouldStoreEntry(misnamed, 128 * 1024, 6)).toBe(true)
  })

  it('is not fooled by a compressible header on an incompressible file', async () => {
    // What a media container looks like: metadata that deflates well, then a
    // payload that does not. Reading only the front would deflate the lot.
    const size = 4 * 1024 * 1024
    const media = await writeFile('clip.bin', Buffer.concat([
      Buffer.alloc(64 * 1024, 0x41),
      crypto.randomBytes(size - 64 * 1024)
    ]))
    expect(shouldStoreEntry(media, size, 6)).toBe(true)
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

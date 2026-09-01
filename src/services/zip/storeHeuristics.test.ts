import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import zlib from 'zlib'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { shouldStoreAfterDeflate } from './storeHeuristics'
import type { DeflateStrategy } from './methodOverrides'

const temporaryDirectories: string[] = []

async function writeFile(name: string, contents: Buffer | string): Promise<{ filePath: string; contents: Buffer }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-store-'))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, name)
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  await fs.writeFile(filePath, buffer)
  return { filePath, contents: buffer }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ))
})

describe('shouldStoreAfterDeflate', () => {
  it('stores only payloads whose actual Deflate result is larger', async () => {
    for (const contents of [Buffer.from('hello'), crypto.randomBytes(4096), Buffer.from('repeat me '.repeat(1000))]) {
      const { filePath } = await writeFile('payload.bin', contents)
      await expect(shouldStoreAfterDeflate(filePath, contents.length, { level: 6 }))
        .resolves.toBe(zlib.deflateRawSync(contents, { level: 6 }).length > contents.length)
    }
  })

  it('does not assume a file is incompressible from its extension', async () => {
    const { filePath, contents } = await writeFile('photo.jpg', Buffer.alloc(128 * 1024, 0x41))
    expect(zlib.deflateRawSync(contents, { level: 6 }).length).toBeLessThan(contents.length)
    await expect(shouldStoreAfterDeflate(filePath, contents.length, { level: 6 })).resolves.toBe(false)
  })

  it.each([
    ['default', zlib.constants.Z_DEFAULT_STRATEGY],
    ['filtered', zlib.constants.Z_FILTERED],
    ['huffman_only', zlib.constants.Z_HUFFMAN_ONLY],
    ['rle', zlib.constants.Z_RLE],
    ['fixed', zlib.constants.Z_FIXED]
  ] as const)('uses the selected %s strategy for the decision', async (strategy, zlibStrategy) => {
    const { filePath, contents } = await writeFile('strategy.txt', Buffer.from('aaaaabbbbbccccc-012345\n'.repeat(500)))
    await expect(shouldStoreAfterDeflate(filePath, contents.length, {
      level: 6,
      strategy: strategy as DeflateStrategy
    })).resolves.toBe(zlib.deflateRawSync(contents, { level: 6, strategy: zlibStrategy }).length > contents.length)
  })

  it('streams the complete file and respects level zero', async () => {
    const { filePath, contents } = await writeFile('large.bin', Buffer.concat([
      Buffer.alloc(64 * 1024, 0x41),
      crypto.randomBytes(4 * 1024 * 1024 - 64 * 1024)
    ]))
    await expect(shouldStoreAfterDeflate(filePath, contents.length, { level: 6 }))
      .resolves.toBe(zlib.deflateRawSync(contents, { level: 6 }).length > contents.length)
    await expect(shouldStoreAfterDeflate(filePath, contents.length, { level: 0 })).resolves.toBe(true)
  })

  it('stores empty input and reports unreadable input', async () => {
    const { filePath } = await writeFile('empty.txt', '')
    await expect(shouldStoreAfterDeflate(filePath, 0, { level: 6 })).resolves.toBe(true)
    await expect(shouldStoreAfterDeflate(path.join(os.tmpdir(), 'libera-store-missing.txt'), 10, { level: 6 }))
      .rejects.toThrow()
  })
})

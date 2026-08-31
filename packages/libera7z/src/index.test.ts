import { describe, expect, it } from 'vitest'
import * as Libera7z from './index.js'

describe('Libera7z public API', () => {
  it('exposes the container, I/O, error and checksum APIs', () => {
    expect(Libera7z).toMatchObject({
      create7z: expect.any(Function),
      open7z: expect.any(Function),
      MemorySink: expect.any(Function),
      MemorySource: expect.any(Function),
      Libera7zError: expect.any(Function),
      crc32: expect.any(Function),
      Crc32: expect.any(Function),
      dictionaryPropertyForSize: expect.any(Function),
      dictionarySizeFromProperty: expect.any(Function)
    })
  })
})

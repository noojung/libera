import { describe, expect, it } from 'vitest'
import { decodeSevenZipFilter } from './filters.js'

describe('7z simple filters', () => {
  it('decodes Delta byte distances', () => {
    expect(decodeSevenZipFilter('delta', Uint8Array.of(1, 2, 2, 2), Uint8Array.of(0)))
      .toEqual(Uint8Array.of(1, 3, 5, 7))
    expect(decodeSevenZipFilter('delta', Uint8Array.of(1, 10, 2, 20, 3, 30), Uint8Array.of(1)))
      .toEqual(Uint8Array.of(1, 10, 3, 30, 6, 60))
  })

  it('decodes Swap2 and Swap4 words without changing an incomplete tail', () => {
    expect(decodeSevenZipFilter('swap2', Uint8Array.of(1, 2, 3, 4, 5), new Uint8Array()))
      .toEqual(Uint8Array.of(2, 1, 4, 3, 5))
    expect(decodeSevenZipFilter('swap4', Uint8Array.of(1, 2, 3, 4, 5), new Uint8Array()))
      .toEqual(Uint8Array.of(4, 3, 2, 1, 5))
  })

  it('decodes ARM64 branches and page-relative addresses', () => {
    // Encoded once with the XZ Utils 5.8.3 ARM64 filter at start offset 4096.
    const encoded = Uint8Array.of(
      0x04, 0x04, 0x00, 0x94,
      0x00, 0x00, 0x00, 0xb0,
      0x0a, 0x04, 0x00, 0x94,
      0x20, 0x00, 0x00, 0xb0
    )
    const original = Uint8Array.of(
      0x04, 0x00, 0x00, 0x94,
      0x00, 0x00, 0x00, 0x90,
      0x08, 0x00, 0x00, 0x94,
      0x20, 0x00, 0x00, 0x90
    )

    expect(decodeSevenZipFilter('arm64', encoded, Uint8Array.of(0x00, 0x10, 0x00, 0x00)))
      .toEqual(original)
  })

  it('decodes RISC-V JAL instructions', () => {
    // Encoded once with the XZ Utils 5.8.3 RISC-V filter at start offset 4096.
    const encoded = Uint8Array.of(
      0xef, 0x00, 0x08, 0x00,
      0x13, 0x00, 0x00, 0x00,
      0xef, 0x00, 0x08, 0x08,
      0x13, 0x00, 0x00, 0x00
    )
    const original = Uint8Array.of(
      0xef, 0x00, 0x00, 0x00,
      0x13, 0x00, 0x00, 0x00,
      0xef, 0x00, 0x80, 0x00,
      0x13, 0x00, 0x00, 0x00
    )

    expect(decodeSevenZipFilter('riscv', encoded, Uint8Array.of(0x00, 0x10, 0x00, 0x00)))
      .toEqual(original)
  })

  it('validates filter properties', () => {
    expect(() => decodeSevenZipFilter('delta', new Uint8Array(), new Uint8Array()))
      .toThrow(/properties/)
    expect(() => decodeSevenZipFilter('arm', new Uint8Array(), Uint8Array.of(1)))
      .toThrow(/properties/)
  })
})

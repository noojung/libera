import { createCipheriv } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  decryptSevenZipAes,
  deriveSevenZipAesKey,
  generateSevenZipAesProperties,
  parseSevenZipAesProperties,
  serializeSevenZipAesProperties,
  SevenZipAesEncryptor,
  Sha256
} from './aes'

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex')
}

describe('7zAES primitives', () => {
  it('implements incremental SHA-256', () => {
    const hash = new Sha256()
      .update(new TextEncoder().encode('a'))
      .update(new TextEncoder().encode('bc'))
      .digest()
    expect(hex(hash)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('parses salt and IV sizes and derives direct-mode keys', () => {
    const properties = parseSevenZipAesProperties(Uint8Array.of(0xff, 0x00, 0xaa, 0xbb))
    expect(properties).toEqual({
      cyclesPower: 0x3f,
      salt: Uint8Array.of(0xaa),
      iv: Uint8Array.of(0xbb, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    })
    const key = deriveSevenZipAesKey('A', properties)
    expect(key.slice(0, 5)).toEqual(Uint8Array.of(0xaa, 0x41, 0, 0, 0))
  })

  it('decrypts raw AES-256-CBC blocks without PKCS padding', async () => {
    const properties = Uint8Array.of(0x3f)
    const parsed = parseSevenZipAesProperties(properties)
    const key = deriveSevenZipAesKey('secret', parsed)
    const clear = Buffer.from('0123456789abcdeftrailing payload')
    const padded = Buffer.alloc(Math.ceil(clear.length / 16) * 16)
    clear.copy(padded)
    const cipher = createCipheriv('aes-256-cbc', key, parsed.iv)
    cipher.setAutoPadding(false)
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()])

    const decrypted = await decryptSevenZipAes(encrypted, properties, 'secret', clear.length)
    expect(Buffer.from(decrypted)).toEqual(clear)
  })

  it('serialises properties the parser reads back', () => {
    const properties = generateSevenZipAesProperties(length => new Uint8Array(length).fill(length))
    const serialised = serializeSevenZipAesProperties(properties)
    expect(serialised.length).toBe(34)
    expect(serialised[0]).toBe(0xd3)
    expect(serialised[1]).toBe(0xff)
    expect(parseSevenZipAesProperties(serialised)).toEqual(properties)
    expect(parseSevenZipAesProperties(serializeSevenZipAesProperties({
      cyclesPower: 0x3f,
      salt: new Uint8Array(0),
      iv: new Uint8Array(0)
    }))).toEqual({ cyclesPower: 0x3f, salt: new Uint8Array(0), iv: new Uint8Array(16) })
  })

  it.each([[1], [15], [16], [17], [4096]])(
    'encrypts raw AES-256-CBC blocks in %i-byte chunks',
    async (chunkSize) => {
      const parsed = generateSevenZipAesProperties(length => new Uint8Array(length).fill(7))
      const key = deriveSevenZipAesKey('secret', parsed)
      const clear = Buffer.from('the quick brown fox jumps over the lazy dog, repeatedly.'.repeat(40))
      const padded = Buffer.alloc(Math.ceil(clear.length / 16) * 16)
      clear.copy(padded)
      const cipher = createCipheriv('aes-256-cbc', key, parsed.iv)
      cipher.setAutoPadding(false)
      const expected = Buffer.concat([cipher.update(padded), cipher.final()])

      const encryptor = await SevenZipAesEncryptor.create(key, parsed.iv)
      const parts: Uint8Array[] = []
      for (let offset = 0; offset < clear.length; offset += chunkSize) {
        parts.push(await encryptor.update(clear.subarray(offset, offset + chunkSize)))
      }
      parts.push(await encryptor.final())
      const encrypted = Buffer.concat(parts.map(part => Buffer.from(part)))

      expect(encrypted).toEqual(expected)
      expect(encryptor.plainSize).toBe(BigInt(clear.length))
      expect(encryptor.cipherSize).toBe(BigInt(padded.length))
      const decrypted = await decryptSevenZipAes(
        encrypted,
        serializeSevenZipAesProperties(parsed),
        'secret',
        clear.length
      )
      expect(Buffer.from(decrypted)).toEqual(clear)
    },
    // The 2^19-round key derivation dominates each case.
    60_000
  )

  it('encrypts nothing when nothing was written', async () => {
    const parsed = generateSevenZipAesProperties(length => new Uint8Array(length))
    const encryptor = await SevenZipAesEncryptor.create(deriveSevenZipAesKey('x', parsed), parsed.iv)
    expect(await encryptor.final()).toEqual(new Uint8Array(0))
    expect(encryptor.cipherSize).toBe(0n)
  })
})

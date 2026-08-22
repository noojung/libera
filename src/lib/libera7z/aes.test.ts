import { createCipheriv } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  decryptSevenZipAes,
  deriveSevenZipAesKey,
  parseSevenZipAesProperties,
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
})

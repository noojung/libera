import { describe, expect, it } from 'vitest'
import { Crc32, crc32 } from './crc32'

describe('CRC-32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('produces the same digest when updated incrementally', () => {
    const crc = new Crc32()
    crc.update(new TextEncoder().encode('1234'))
    crc.update(new TextEncoder().encode('56789'))

    expect(crc.digest()).toBe(0xcbf43926)
  })
})

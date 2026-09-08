import { describe, expect, it } from 'vitest'
import { ERR_INVALID_SIGNATURE, type Entry } from '@zip.js/zip.js'
import { readZipEntry } from '../extractor'

const encrypted = { encrypted: true } as Entry
const plain = { encrypted: false } as Entry

const reject = (message: string) => () => Promise.reject(new Error(message))

// ZipCrypto verifies a password against one byte, so roughly one wrong
// password in 256 gets past it and the entry decodes to noise. The CRC failing
// afterwards is the only sign, and the archive holds nothing that tells that
// apart from real damage - so which of the two gets reported is a judgement
// about what the reader can have been given, not a fact the format supplies.
describe('reporting a ZIP entry that fails to verify', () => {
  it('blames the password when an encrypted entry fails its check', async () => {
    await expect(readZipEntry(encrypted, 'nope', reject(ERR_INVALID_SIGNATURE)))
      .rejects.toMatchObject({ code: 'WRONG_ZIP_PASSWORD' })
  })

  it('leaves an unencrypted entry that fails its check as damage', async () => {
    // Nothing was decrypted, so the password cannot be what went wrong.
    await expect(readZipEntry(plain, 'nope', reject(ERR_INVALID_SIGNATURE)))
      .rejects.toMatchObject({ message: ERR_INVALID_SIGNATURE })
  })

  it('leaves an encrypted entry read without a password as damage', async () => {
    await expect(readZipEntry(encrypted, undefined, reject(ERR_INVALID_SIGNATURE)))
      .rejects.toMatchObject({ message: ERR_INVALID_SIGNATURE })
  })

  it('passes every other failure through untouched', async () => {
    // Only the checks a wrong password can break are reported as one; a full
    // disk or a cancelled read keeps its own meaning.
    await expect(readZipEntry(encrypted, 'nope', reject('ENOSPC')))
      .rejects.toMatchObject({ message: 'ENOSPC' })
  })

  it('returns what the read returned when nothing fails', async () => {
    await expect(readZipEntry(encrypted, 'secret', () => Promise.resolve('data')))
      .resolves.toBe('data')
  })
})

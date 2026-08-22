import { invalidArchive, Libera7zError, throwIfCancelled } from './errors'

const SHA256_INITIAL = Uint32Array.of(
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
)

const SHA256_ROUND = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
)

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count))
}

/** Small incremental SHA-256 used by the 7zAES key derivation loop. */
export class Sha256 {
  private readonly state = SHA256_INITIAL.slice()
  private readonly block = new Uint8Array(64)
  private blockLength = 0
  private length = 0n

  update(bytes: Uint8Array): this {
    this.length += BigInt(bytes.length)
    let offset = 0
    while (offset < bytes.length) {
      const length = Math.min(64 - this.blockLength, bytes.length - offset)
      this.block.set(bytes.subarray(offset, offset + length), this.blockLength)
      this.blockLength += length
      offset += length
      if (this.blockLength === 64) {
        this.compress(this.block)
        this.blockLength = 0
      }
    }
    return this
  }

  private compress(block: Uint8Array): void {
    const words = new Uint32Array(64)
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4
      words[index] = (
        (block[offset] << 24) |
        (block[offset + 1] << 16) |
        (block[offset + 2] << 8) |
        block[offset + 3]
      ) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]
      const b = words[index - 2]
      const small0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3)
      const small1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10)
      words[index] = (words[index - 16] + small0 + words[index - 7] + small1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = this.state
    for (let index = 0; index < 64; index += 1) {
      const big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const first = (h + big1 + choose + SHA256_ROUND[index] + words[index]) >>> 0
      const big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const second = (big0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + first) >>> 0
      d = c
      c = b
      b = a
      a = (first + second) >>> 0
    }
    this.state[0] = (this.state[0] + a) >>> 0
    this.state[1] = (this.state[1] + b) >>> 0
    this.state[2] = (this.state[2] + c) >>> 0
    this.state[3] = (this.state[3] + d) >>> 0
    this.state[4] = (this.state[4] + e) >>> 0
    this.state[5] = (this.state[5] + f) >>> 0
    this.state[6] = (this.state[6] + g) >>> 0
    this.state[7] = (this.state[7] + h) >>> 0
  }

  digest(): Uint8Array {
    const bitLength = this.length * 8n
    this.block[this.blockLength++] = 0x80
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength)
      this.compress(this.block)
      this.blockLength = 0
    }
    this.block.fill(0, this.blockLength, 56)
    for (let index = 0; index < 8; index += 1) {
      this.block[63 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn)
    }
    this.compress(this.block)
    this.blockLength = 0

    const result = new Uint8Array(32)
    for (let index = 0; index < 8; index += 1) {
      const value = this.state[index]
      result[index * 4] = value >>> 24
      result[index * 4 + 1] = value >>> 16
      result[index * 4 + 2] = value >>> 8
      result[index * 4 + 3] = value
    }
    return result
  }
}

export interface SevenZipAesProperties {
  cyclesPower: number
  salt: Uint8Array
  iv: Uint8Array
}

export function parseSevenZipAesProperties(properties: Uint8Array): SevenZipAesProperties {
  if (properties.length === 0) return { cyclesPower: 0, salt: new Uint8Array(0), iv: new Uint8Array(16) }
  const first = properties[0]
  const cyclesPower = first & 0x3f
  if (cyclesPower > 24 && cyclesPower !== 0x3f) throw new Libera7zError('UNSUPPORTED_FEATURE', '7zAES KDF cycle count is unsupported')
  if ((first & 0xc0) === 0) {
    if (properties.length !== 1) throw invalidArchive('7zAES properties are malformed')
    return { cyclesPower, salt: new Uint8Array(0), iv: new Uint8Array(16) }
  }
  if (properties.length < 2) throw invalidArchive('7zAES properties are truncated')
  const second = properties[1]
  const saltSize = ((first >>> 7) & 1) + (second >>> 4)
  const ivSize = ((first >>> 6) & 1) + (second & 0x0f)
  if (saltSize > 16 || ivSize > 16 || properties.length !== 2 + saltSize + ivSize) {
    throw invalidArchive('7zAES properties are malformed')
  }
  const salt = properties.slice(2, 2 + saltSize)
  const iv = new Uint8Array(16)
  iv.set(properties.subarray(2 + saltSize))
  return { cyclesPower, salt, iv }
}

function utf16Le(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    bytes[index * 2] = code
    bytes[index * 2 + 1] = code >>> 8
  }
  return bytes
}

export function deriveSevenZipAesKey(
  password: string,
  properties: SevenZipAesProperties,
  signal?: AbortSignal
): Uint8Array {
  const passwordBytes = utf16Le(password)
  if (properties.cyclesPower === 0x3f) {
    const key = new Uint8Array(32)
    const combined = new Uint8Array(properties.salt.length + passwordBytes.length)
    combined.set(properties.salt)
    combined.set(passwordBytes, properties.salt.length)
    key.set(combined.subarray(0, key.length))
    return key
  }

  const rounds = 2 ** properties.cyclesPower
  const block = new Uint8Array(properties.salt.length + passwordBytes.length + 8)
  block.set(properties.salt)
  block.set(passwordBytes, properties.salt.length)
  const counterOffset = properties.salt.length + passwordBytes.length
  const hash = new Sha256()
  for (let round = 0; round < rounds; round += 1) {
    if ((round & 0x3fff) === 0) throwIfCancelled(signal)
    let value = round
    for (let byte = 0; byte < 8; byte += 1) {
      block[counterOffset + byte] = value & 0xff
      value = Math.floor(value / 256)
    }
    hash.update(block)
  }
  return hash.digest()
}

export async function decryptSevenZipAes(
  input: Uint8Array,
  properties: Uint8Array,
  password: string | undefined,
  outputSize: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (password === undefined) throw new Libera7zError('PASSWORD_REQUIRED', 'The 7z archive needs a password')
  if ((input.length & 15) !== 0) throw invalidArchive('7zAES packed stream is not block aligned')
  if (!Number.isSafeInteger(outputSize) || outputSize < 0 || outputSize > input.length) {
    throw invalidArchive('7zAES output size is invalid')
  }
  const parsed = parseSevenZipAesProperties(properties)
  const key = deriveSevenZipAesKey(password, parsed, signal)
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Libera7zError('UNSUPPORTED_FEATURE', 'AES-CBC is unavailable in this JavaScript runtime')
  try {
    throwIfCancelled(signal)
    const cryptoKey = await subtle.importKey(
      'raw',
      key as Uint8Array<ArrayBuffer>,
      { name: 'AES-CBC' },
      false,
      ['encrypt', 'decrypt']
    )
    // Web Crypto always applies PKCS#7 padding. Append one valid padding block
    // chained from the real ciphertext, then let decrypt() remove only that
    // synthetic block. The original 7z zero padding remains byte-for-byte.
    const paddingIv = input.length === 0 ? parsed.iv : input.subarray(input.length - 16)
    const padding = new Uint8Array(await subtle.encrypt(
      { name: 'AES-CBC', iv: paddingIv as Uint8Array<ArrayBuffer> },
      cryptoKey,
      new Uint8Array(0)
    ))
    const extended = new Uint8Array(input.length + padding.length)
    extended.set(input)
    extended.set(padding, input.length)
    const clear = new Uint8Array(await subtle.decrypt(
      { name: 'AES-CBC', iv: parsed.iv as Uint8Array<ArrayBuffer> },
      cryptoKey,
      extended
    ))
    throwIfCancelled(signal)
    return clear.slice(0, outputSize)
  } catch (error) {
    if (error instanceof Libera7zError) throw error
    throw invalidArchive(`7zAES decryption failed: ${(error as Error).message}`)
  } finally {
    key.fill(0)
  }
}

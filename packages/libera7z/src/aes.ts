import { concatBytes } from './binary'
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
  // The derivation loop compresses hundreds of thousands of blocks, so the
  // message schedule is reused instead of allocated once per block.
  private readonly words = new Uint32Array(64)
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
    const words = this.words
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

const EMPTY = new Uint8Array(0)

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Libera7zError('UNSUPPORTED_FEATURE', 'AES-CBC is unavailable in this JavaScript runtime')
  return subtle
}

export function importSevenZipAesKey(key: Uint8Array): Promise<CryptoKey> {
  return requireSubtle().importKey('raw', key as Uint8Array<ArrayBuffer>, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt'])
}

/**
 * Raw CBC without padding. Web Crypto always applies PKCS#7, so one valid
 * padding block chained from the real ciphertext is appended and decrypt()
 * removes only that synthetic block. The original 7z zero padding survives
 * byte-for-byte.
 */
export async function decryptAesCbcRaw(cryptoKey: CryptoKey, iv: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const subtle = requireSubtle()
  const paddingIv = input.length === 0 ? iv : input.subarray(input.length - 16)
  const padding = new Uint8Array(await subtle.encrypt(
    { name: 'AES-CBC', iv: paddingIv as Uint8Array<ArrayBuffer> },
    cryptoKey,
    EMPTY
  ))
  const extended = new Uint8Array(input.length + padding.length)
  extended.set(input)
  extended.set(padding, input.length)
  return new Uint8Array(await subtle.decrypt(
    { name: 'AES-CBC', iv: iv as Uint8Array<ArrayBuffer> },
    cryptoKey,
    extended
  ))
}

/** The encryption mirror of the trick above: the trailing padding block is dropped. */
async function encryptAesCbcRaw(cryptoKey: CryptoKey, iv: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const padded = new Uint8Array(await requireSubtle().encrypt(
    { name: 'AES-CBC', iv: iv as Uint8Array<ArrayBuffer> },
    cryptoKey,
    input as Uint8Array<ArrayBuffer>
  ))
  return padded.slice(0, input.length)
}

/**
 * Derives the archive key, letting callers substitute a memoised derivation.
 * The default runs the full 2^cyclesPower hashing loop on every call.
 */
export type SevenZipAesKeyDeriver = (
  password: string,
  properties: SevenZipAesProperties,
  signal?: AbortSignal
) => Uint8Array

export async function decryptSevenZipAes(
  input: Uint8Array,
  properties: Uint8Array,
  password: string | undefined,
  outputSize: number,
  signal?: AbortSignal,
  deriveKey: SevenZipAesKeyDeriver = deriveSevenZipAesKey
): Promise<Uint8Array> {
  if (password === undefined) throw new Libera7zError('PASSWORD_REQUIRED', 'The 7z archive needs a password')
  if ((input.length & 15) !== 0) throw invalidArchive('7zAES packed stream is not block aligned')
  if (!Number.isSafeInteger(outputSize) || outputSize < 0 || outputSize > input.length) {
    throw invalidArchive('7zAES output size is invalid')
  }
  const parsed = parseSevenZipAesProperties(properties)
  const key = deriveKey(password, parsed, signal)
  try {
    throwIfCancelled(signal)
    const cryptoKey = await importSevenZipAesKey(key)
    const clear = await decryptAesCbcRaw(cryptoKey, parsed.iv, input)
    throwIfCancelled(signal)
    return clear.slice(0, outputSize)
  } catch (error) {
    if (error instanceof Libera7zError) throw error
    throw invalidArchive(`7zAES decryption failed: ${(error as Error).message}`)
  } finally {
    key.fill(0)
  }
}

export function serializeSevenZipAesProperties(properties: SevenZipAesProperties): Uint8Array {
  const { cyclesPower, salt, iv } = properties
  if (!Number.isInteger(cyclesPower) || cyclesPower < 0 || (cyclesPower > 24 && cyclesPower !== 0x3f)) {
    throw new RangeError(`7zAES cycle count is out of range: ${cyclesPower}`)
  }
  if (salt.length > 16 || iv.length > 16) throw new RangeError('7zAES salt and IV cannot exceed 16 bytes')
  if (salt.length === 0 && iv.length === 0) return Uint8Array.of(cyclesPower)
  const first = cyclesPower | (salt.length > 0 ? 0x80 : 0) | (iv.length > 0 ? 0x40 : 0)
  const second = ((salt.length > 0 ? salt.length - 1 : 0) << 4) | (iv.length > 0 ? iv.length - 1 : 0)
  return concatBytes([Uint8Array.of(first, second), salt, iv])
}

/** 7-Zip omits the salt, so every archive shares one key per password. A random
 * salt costs two bytes of header and makes the key archive-specific instead. */
export function generateSevenZipAesProperties(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes
): SevenZipAesProperties {
  return { cyclesPower: 19, salt: randomBytes(16), iv: randomBytes(16) }
}

export function defaultRandomBytes(length: number): Uint8Array {
  const random = globalThis.crypto?.getRandomValues
  if (!random) throw new Libera7zError('UNSUPPORTED_FEATURE', 'Secure random bytes are unavailable in this JavaScript runtime')
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

/**
 * Streaming 7zAES encryption. 7z pads the final block with zeroes and relies on
 * the coder's declared output size to trim them, so `plainSize` (what went in)
 * and `cipherSize` (what came out) are both reported.
 */
export class SevenZipAesEncryptor {
  private pending = EMPTY
  private plain = 0n
  private cipher = 0n

  private constructor(private readonly cryptoKey: CryptoKey, private iv: Uint8Array) {}

  static async create(key: Uint8Array, iv: Uint8Array): Promise<SevenZipAesEncryptor> {
    if (iv.length !== 16) throw new RangeError('7zAES needs a 16-byte IV')
    return new SevenZipAesEncryptor(await importSevenZipAesKey(key), iv.slice())
  }

  /** Total bytes fed in, which is the AES coder's declared output size. */
  get plainSize(): bigint {
    return this.plain
  }

  /** Total ciphertext produced, which is the packed stream size. */
  get cipherSize(): bigint {
    return this.cipher
  }

  async update(bytes: Uint8Array): Promise<Uint8Array> {
    this.plain += BigInt(bytes.length)
    const joined = this.pending.length === 0 ? bytes : concatBytes([this.pending, bytes])
    const aligned = joined.length & ~15
    // slice() rather than subarray(): the caller may reuse its buffer, and the
    // remainder has to survive until the next call.
    this.pending = joined.slice(aligned)
    if (aligned === 0) return EMPTY
    return this.encrypt(joined.subarray(0, aligned))
  }

  async final(): Promise<Uint8Array> {
    if (this.pending.length === 0) return EMPTY
    const block = new Uint8Array(16)
    block.set(this.pending)
    this.pending = EMPTY
    return this.encrypt(block)
  }

  private async encrypt(input: Uint8Array): Promise<Uint8Array> {
    const output = await encryptAesCbcRaw(this.cryptoKey, this.iv, input)
    // A copy, because the next call hands this buffer to Web Crypto as the IV
    // while the ciphertext itself is already on its way to the sink.
    this.iv = output.slice(output.length - 16)
    this.cipher += BigInt(output.length)
    return output
  }
}

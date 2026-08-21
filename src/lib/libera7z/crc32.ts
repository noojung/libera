const TABLE = new Uint32Array(256)

for (let value = 0; value < TABLE.length; value += 1) {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
  }
  TABLE[value] = crc >>> 0
}

export class Crc32 {
  private value = 0xffffffff

  update(bytes: Uint8Array): void {
    let value = this.value
    for (let index = 0; index < bytes.length; index += 1) {
      value = TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8)
    }
    this.value = value >>> 0
  }

  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0
  }
}

export function crc32(bytes: Uint8Array): number {
  const crc = new Crc32()
  crc.update(bytes)
  return crc.digest()
}

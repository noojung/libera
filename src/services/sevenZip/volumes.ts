import { promises as fsPromises } from 'fs'
import path from 'path'
import { crc32 } from 'libera7z'
import { normalizeName, SplitVolumeError } from '../zip/volumes'

// Naming and discovery for split 7z sets. Deliberately separate from
// zip/volumes.ts because the two formats number their volumes from
// opposite ends: a ZIP set is read from the terminal `.zip` that carries the
// central directory, a 7z set from `.7z.001`. Only the error type is shared,
// so the main process and the translations already handle these failures.

// 7-Zip pads to three digits and keeps counting past 999 rather than widening,
// so the count is capped where the padding still holds.
export const MAX_SEVEN_ZIP_VOLUMES = 999
export const SEVEN_ZIP_VOLUME_SUFFIX = /\.7z\.\d{3,}$/i
const SEVEN_ZIP_SIGNATURE = Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)
const SEVEN_ZIP_SIGNATURE_HEADER_SIZE = 32

export function isSevenZipVolumePath(archivePath: string): boolean {
  return SEVEN_ZIP_VOLUME_SUFFIX.test(archivePath)
}

export function isSevenZipArchivePath(archivePath: string): boolean {
  return archivePath.toLowerCase().endsWith('.7z') || isSevenZipVolumePath(archivePath)
}

/** The `foo.7z` a volume set is built around, without any volume number. */
export function sevenZipVolumeBase(archivePath: string): string {
  return archivePath.replace(SEVEN_ZIP_VOLUME_SUFFIX, '.7z')
}

export function sevenZipVolumePath(basePath: string, volumeNumber: number): string {
  return `${basePath}.${String(volumeNumber).padStart(3, '0')}`
}

/**
 * Rewrites any volume of a set to `.001`. 7-Zip records the archive's headers
 * in the first volume and reads the rest from there, which is the mirror image
 * of the ZIP layout - opening a later volume directly looks like a corrupt
 * archive.
 */
export function firstVolumePath(archivePath: string): string {
  if (!isSevenZipVolumePath(archivePath)) return archivePath
  return sevenZipVolumePath(sevenZipVolumeBase(archivePath), 1)
}

async function readVolumePrefix(volumePaths: readonly string[], length: number): Promise<Uint8Array> {
  const prefix = Buffer.alloc(length)
  let written = 0
  for (const volumePath of volumePaths) {
    if (written === length) break
    const handle = await fsPromises.open(volumePath, 'r')
    try {
      let volumeOffset = 0
      while (written < length) {
        const { bytesRead } = await handle.read(prefix, written, length - written, volumeOffset)
        if (bytesRead === 0) break
        written += bytesRead
        volumeOffset += bytesRead
      }
    } finally {
      await handle.close()
    }
  }
  return new Uint8Array(prefix.buffer, prefix.byteOffset, written).slice()
}

function hasSevenZipSignature(prefix: Uint8Array): boolean {
  return prefix.length >= SEVEN_ZIP_SIGNATURE.length &&
    SEVEN_ZIP_SIGNATURE.every((value, index) => prefix[index] === value)
}

function declaredSevenZipSize(signatureHeader: Uint8Array): bigint | null {
  if (signatureHeader.length < SEVEN_ZIP_SIGNATURE_HEADER_SIZE || !hasSevenZipSignature(signatureHeader)) return null
  const view = new DataView(signatureHeader.buffer, signatureHeader.byteOffset, signatureHeader.byteLength)
  if (crc32(signatureHeader.subarray(12, 32)) !== view.getUint32(8, true)) return null
  const nextHeaderOffset = view.getBigUint64(12, true)
  const nextHeaderSize = view.getBigUint64(20, true)
  return BigInt(SEVEN_ZIP_SIGNATURE_HEADER_SIZE) + nextHeaderOffset + nextHeaderSize
}

/**
 * Returns every volume of the set in order. 7-Zip only needs the first one
 * handed to it, but the set is still checked for gaps here so a missing volume
 * is reported as such instead of surfacing as a decode failure much later.
 */
export async function discoverSevenZipVolumes(firstPath: string): Promise<string[]> {
  const directory = path.dirname(path.resolve(firstPath))
  const baseName = path.basename(sevenZipVolumeBase(firstPath))

  let names: string[]
  try {
    names = await fsPromises.readdir(directory)
  } catch {
    throw new SplitVolumeError('SPLIT_VOLUME_UNREADABLE', directory, `Cannot read the archive folder: ${directory}`)
  }

  const prefix = normalizeName(`${baseName}.`)
  const byNumber = new Map<number, string>()

  for (const name of names) {
    const normalized = normalizeName(name)
    if (!normalized.startsWith(prefix)) continue

    const match = /^(\d{3,})$/.exec(normalized.slice(prefix.length))
    if (!match) continue

    const volumeNumber = Number(match[1])
    if (!Number.isSafeInteger(volumeNumber) || volumeNumber < 1) continue
    if (byNumber.has(volumeNumber)) {
      throw new SplitVolumeError('SPLIT_VOLUME_MISMATCH', name, `The folder holds more than one volume numbered ${volumeNumber}.`)
    }
    byNumber.set(volumeNumber, path.join(directory, name))
  }

  const firstName = path.basename(sevenZipVolumePath(baseName, 1))
  if (!byNumber.has(1)) {
    throw new SplitVolumeError('SPLIT_VOLUME_MISSING', firstName, `Missing the first volume: ${firstName}`)
  }
  if (byNumber.size > MAX_SEVEN_ZIP_VOLUMES) {
    throw new SplitVolumeError('SPLIT_VOLUME_MISMATCH', firstName, `The set holds more than ${MAX_SEVEN_ZIP_VOLUMES} volumes.`)
  }

  const volumePaths: string[] = []
  for (let volumeNumber = 1; volumeNumber <= byNumber.size; volumeNumber += 1) {
    const volume = byNumber.get(volumeNumber)
    if (!volume) {
      const missing = path.basename(sevenZipVolumePath(baseName, volumeNumber))
      throw new SplitVolumeError('SPLIT_VOLUME_MISSING', missing, `Missing volume: ${missing}`)
    }
    volumePaths.push(volume)
  }

  let availableSize = 0n
  for (const volume of volumePaths) {
    const stat = await fsPromises.lstat(volume).catch(() => null)
    if (!stat || !stat.isFile()) {
      const name = path.basename(volume)
      throw new SplitVolumeError('SPLIT_VOLUME_MISSING', name, `Volume is not a readable file: ${name}`)
    }
    availableSize += BigInt(stat.size)
  }

  let signatureHeader: Uint8Array
  try {
    signatureHeader = await readVolumePrefix(volumePaths, SEVEN_ZIP_SIGNATURE_HEADER_SIZE)
  } catch {
    throw new SplitVolumeError('SPLIT_VOLUME_UNREADABLE', firstName, `Cannot read the archive volumes: ${firstName}`)
  }
  if (hasSevenZipSignature(signatureHeader) && signatureHeader.length < SEVEN_ZIP_SIGNATURE_HEADER_SIZE) {
    const missing = path.basename(sevenZipVolumePath(baseName, volumePaths.length + 1))
    throw new SplitVolumeError('SPLIT_VOLUME_MISSING', missing, `The split 7z header is incomplete; missing volume: ${missing}`)
  }
  const declaredSize = declaredSevenZipSize(signatureHeader)
  if (declaredSize !== null && availableSize < declaredSize) {
    const missing = path.basename(sevenZipVolumePath(baseName, volumePaths.length + 1))
    throw new SplitVolumeError(
      'SPLIT_VOLUME_MISSING',
      missing,
      `The split 7z set is missing data at or after volume: ${missing}`
    )
  }

  return volumePaths
}

/**
 * Clears volumes left by an earlier run. A shorter second run would otherwise
 * leave the previous set's higher-numbered volumes beside the new ones and the
 * mixed set would read as corrupt - the same hazard ZIP volumes have.
 */
export async function removeStaleSevenZipVolumes(outputPath: string): Promise<void> {
  const directory = path.dirname(path.resolve(outputPath))
  const baseName = path.basename(sevenZipVolumeBase(outputPath))
  const prefix = normalizeName(`${baseName}.`)

  const names = await fsPromises.readdir(directory).catch(() => null)
  if (!names) return

  await Promise.all(names.map(async name => {
    const normalized = normalizeName(name)
    const isVolume = normalized.startsWith(prefix) && /^(\d{3,})$/.test(normalized.slice(prefix.length))
    const isBase = normalized === normalizeName(baseName)
    const isTemporary = normalized === normalizeName(`${baseName}.tmp`)
    if (!isVolume && !isBase && !isTemporary) return
    await fsPromises.rm(path.join(directory, name), { force: true }).catch(() => undefined)
  }))
}

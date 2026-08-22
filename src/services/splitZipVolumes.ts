import { promises as fsPromises } from 'fs'
import path from 'path'

// Naming and discovery for split ZIP volume sets. Kept free of zip.js and of
// the writer so both the writer and the reader can depend on it: the writer
// already imports the reader's NodeFileReader, so the reverse direction would
// close a cycle.

export const MAX_SPLIT_VOLUMES = 65535

export type SplitVolumeErrorCode =
  | 'SPLIT_VOLUME_MISSING'
  | 'SPLIT_VOLUME_MISMATCH'
  | 'SPLIT_VOLUME_UNREADABLE'

export class SplitVolumeError extends Error {
  constructor(
    public readonly code: SplitVolumeErrorCode,
    public readonly volume: string,
    message: string
  ) {
    super(message)
    this.name = 'SplitVolumeError'
  }
}

const isWindows = process.platform === 'win32'
const NUMBERED_VOLUME_SUFFIX = /\.z\d{2,}$/i
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const END_OF_CENTRAL_DIRECTORY_SIZE = 22
const MAX_ZIP_COMMENT_SIZE = 0xffff

export function normalizeName(name: string): string {
  return isWindows ? name.toLowerCase() : name
}

/**
 * The last volume of a split set carries the `.zip` extension, the preceding
 * ones `.z01`, `.z02` and so on, all sharing this base.
 */
export function splitVolumeBase(outputPath: string): string {
  return outputPath.replace(/\.zip$/i, '')
}

export function volumePathForDisk(basePath: string, diskNumber: number): string {
  return `${basePath}.z${String(diskNumber + 1).padStart(2, '0')}`
}

export function isSplitVolumeName(baseName: string, candidateName: string): boolean {
  const base = normalizeName(baseName)
  const candidate = normalizeName(candidateName)
  if (!candidate.startsWith(`${base}.`)) return false

  const suffix = candidate.slice(base.length + 1)
  return suffix === 'zip' || /^z\d{2,}$/.test(suffix)
}

export function createVolumePredicate(outputPath: string): (candidate: string) => boolean {
  const directory = path.resolve(path.dirname(outputPath))
  const baseName = path.basename(splitVolumeBase(outputPath))

  return (candidate) => {
    const resolved = path.resolve(candidate)
    if (normalizeName(path.dirname(resolved)) !== normalizeName(directory)) return false
    return isSplitVolumeName(baseName, path.basename(resolved))
  }
}

/**
 * Rewrites any volume of a set to the terminal `.zip`. Only the first volume
 * carries the spanning signature and only the last one carries the central
 * directory, so a middle volume opened directly is indistinguishable from a
 * corrupt archive - every read starts from the terminal volume instead.
 */
export function terminalVolumePath(archivePath: string): string {
  if (!NUMBERED_VOLUME_SUFFIX.test(archivePath)) return archivePath
  return `${archivePath.replace(NUMBERED_VOLUME_SUFFIX, '')}.zip`
}

export function isNumberedVolumePath(archivePath: string): boolean {
  return NUMBERED_VOLUME_SUFFIX.test(archivePath)
}

/** Reads the zero-based terminal disk number recorded by a ZIP archive. */
export async function readZipTerminalDiskNumber(terminalPath: string): Promise<number | null> {
  const handle = await fsPromises.open(terminalPath, 'r')
  try {
    const stat = await handle.stat()
    const tailLength = Math.min(stat.size, END_OF_CENTRAL_DIRECTORY_SIZE + MAX_ZIP_COMMENT_SIZE)
    if (tailLength < END_OF_CENTRAL_DIRECTORY_SIZE) return null

    const tail = Buffer.allocUnsafe(tailLength)
    const { bytesRead } = await handle.read(tail, 0, tail.length, stat.size - tailLength)
    if (bytesRead !== tail.length) return null

    for (let offset = tail.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue
      const commentLength = tail.readUInt16LE(offset + 20)
      if (offset + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength !== tail.length) continue
      return tail.readUInt16LE(offset + 4)
    }
    return null
  } finally {
    await handle.close()
  }
}

/**
 * Returns every volume of the set in disk order, terminal `.zip` last, which is
 * the order SplitDataReader maps onto its concatenated address space.
 */
export async function discoverSplitVolumes(terminalPath: string): Promise<string[]> {
  const directory = path.dirname(path.resolve(terminalPath))
  const baseName = path.basename(splitVolumeBase(terminalPath))
  const terminalName = path.basename(terminalPath)

  let names: string[]
  try {
    names = await fsPromises.readdir(directory)
  } catch {
    throw new SplitVolumeError('SPLIT_VOLUME_UNREADABLE', directory, `Cannot read the archive folder: ${directory}`)
  }

  const prefix = normalizeName(`${baseName}.`)
  const byDisk = new Map<number, string>()
  let terminal: string | null = null

  for (const name of names) {
    const normalized = normalizeName(name)
    if (!normalized.startsWith(prefix)) continue

    const suffix = normalized.slice(prefix.length)
    if (suffix === 'zip') {
      terminal = path.join(directory, name)
      continue
    }

    const match = /^z(\d{2,})$/.exec(suffix)
    if (!match) continue

    const diskNumber = Number(match[1])
    if (!Number.isSafeInteger(diskNumber) || diskNumber < 1) continue
    if (byDisk.has(diskNumber)) {
      throw new SplitVolumeError('SPLIT_VOLUME_MISMATCH', name, `The folder holds more than one volume numbered ${diskNumber}.`)
    }
    byDisk.set(diskNumber, path.join(directory, name))
  }

  if (!terminal) {
    throw new SplitVolumeError('SPLIT_VOLUME_MISSING', terminalName, `Missing the final volume: ${terminalName}`)
  }
  let expectedNumberedVolumes: number | null
  try {
    expectedNumberedVolumes = await readZipTerminalDiskNumber(terminal)
  } catch {
    throw new SplitVolumeError('SPLIT_VOLUME_UNREADABLE', terminalName, `Cannot read the final volume: ${terminalName}`)
  }
  if (expectedNumberedVolumes === null) {
    throw new SplitVolumeError(
      'SPLIT_VOLUME_MISSING',
      terminalName,
      `The final volume is missing or incomplete: ${terminalName}`
    )
  }
  if (expectedNumberedVolumes + 1 > MAX_SPLIT_VOLUMES) {
    throw new SplitVolumeError('SPLIT_VOLUME_MISMATCH', terminalName, `The set holds more than ${MAX_SPLIT_VOLUMES} volumes.`)
  }

  const volumePaths: string[] = []
  for (let diskNumber = 1; diskNumber <= expectedNumberedVolumes; diskNumber += 1) {
    const volume = byDisk.get(diskNumber)
    if (!volume) {
      const missing = path.basename(volumePathForDisk(baseName, diskNumber - 1))
      throw new SplitVolumeError('SPLIT_VOLUME_MISSING', missing, `Missing volume: ${missing}`)
    }
    volumePaths.push(volume)
  }
  const unexpectedDisk = [...byDisk.keys()].find(diskNumber => diskNumber > expectedNumberedVolumes)
  if (unexpectedDisk !== undefined) {
    const unexpected = path.basename(byDisk.get(unexpectedDisk)!)
    throw new SplitVolumeError('SPLIT_VOLUME_MISMATCH', unexpected, `Unexpected volume: ${unexpected}`)
  }
  volumePaths.push(terminal)

  for (const volume of volumePaths) {
    const stat = await fsPromises.lstat(volume).catch(() => null)
    if (!stat || !stat.isFile()) {
      const name = path.basename(volume)
      throw new SplitVolumeError('SPLIT_VOLUME_MISSING', name, `Volume is not a readable file: ${name}`)
    }
  }

  return volumePaths
}

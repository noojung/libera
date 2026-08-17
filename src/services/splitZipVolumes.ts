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
  if (byDisk.size + 1 > MAX_SPLIT_VOLUMES) {
    throw new SplitVolumeError('SPLIT_VOLUME_MISMATCH', terminalName, `The set holds more than ${MAX_SPLIT_VOLUMES} volumes.`)
  }

  const volumePaths: string[] = []
  for (let diskNumber = 1; diskNumber <= byDisk.size; diskNumber += 1) {
    const volume = byDisk.get(diskNumber)
    if (!volume) {
      const missing = path.basename(volumePathForDisk(baseName, diskNumber - 1))
      throw new SplitVolumeError('SPLIT_VOLUME_MISSING', missing, `Missing volume: ${missing}`)
    }
    volumePaths.push(volume)
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

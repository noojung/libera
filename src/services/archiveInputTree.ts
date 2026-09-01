import { promises as fsPromises } from 'fs'
import path from 'path'

export interface ArchiveInputTreeEntry {
  path: string
  name: string
  isDirectory: boolean
  size: number
}

/** Lists one directory level without following symbolic links. */
export async function listArchiveInputChildren(directoryPath: string): Promise<ArchiveInputTreeEntry[]> {
  const children = await fsPromises.readdir(directoryPath, { withFileTypes: true })
  const entries = await Promise.all(children.map(async child => {
    if (child.isSymbolicLink()) return null
    const childPath = path.join(directoryPath, child.name)
    try {
      const stat = await fsPromises.lstat(childPath)
      if (stat.isSymbolicLink()) return null
      return {
        path: childPath,
        name: child.name,
        isDirectory: stat.isDirectory(),
        size: stat.isDirectory() ? 0 : stat.size
      } satisfies ArchiveInputTreeEntry
    } catch {
      // Match the compressor's directory walk: entries that disappear or
      // become unreadable during the scan are skipped rather than fatal.
      return null
    }
  }))

  return entries
    .filter((entry): entry is ArchiveInputTreeEntry => entry !== null)
    .sort((left, right) => (
      Number(right.isDirectory) - Number(left.isDirectory) ||
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    ))
}

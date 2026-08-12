import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import * as tar from 'tar'

export interface ArchiveEntry {
  id: string
  name: string
  path: string
  isDirectory: boolean
  size: number
  compressedSize?: number
  ratio?: number
  date?: string
}

export interface ArchiveInspectionResult {
  archivePath: string
  format: string
  passwordProtected: boolean
  totalFiles: number
  totalUncompressedSize: number
  totalCompressedSize: number
  overallRatio: number
  entries: ArchiveEntry[]
}

export async function inspectArchive(archivePath: string): Promise<ArchiveInspectionResult> {
  const ext = path.extname(archivePath).toLowerCase()
  const fullExt = archivePath.toLowerCase()

  if (!fs.existsSync(archivePath)) {
    throw new Error(`File does not exist: ${archivePath}`)
  }

  const stat = fs.statSync(archivePath)
  const totalCompressedSize = stat.size

  if (ext === '.zip') {
    const zip = new AdmZip(archivePath)
    const zipEntries = zip.getEntries()
    const passwordProtected = zipEntries.some(entry => (entry.header as any).encrypted)
    let totalUncompressedSize = 0
    let entriesCompressedSizeSum = 0

    const entries: ArchiveEntry[] = zipEntries.map((entry, idx) => {
      totalUncompressedSize += entry.header.size
      entriesCompressedSizeSum += entry.header.compressedSize

      const ratio = entry.header.size > 0 
        ? Math.round((1 - (entry.header.compressedSize / entry.header.size)) * 100) 
        : 0

      return {
        id: `entry-${idx}`,
        name: path.basename(entry.entryName) || entry.entryName,
        path: entry.entryName,
        isDirectory: entry.isDirectory,
        size: entry.header.size,
        compressedSize: entry.header.compressedSize,
        ratio,
        date: entry.header.time ? new Date(entry.header.time).toLocaleDateString() : undefined
      }
    })

    const overallRatio = totalUncompressedSize > 0 
      ? Math.round((1 - (totalCompressedSize / totalUncompressedSize)) * 100) 
      : 0

    return {
      archivePath,
      format: 'ZIP',
      passwordProtected,
      totalFiles: entries.filter(e => !e.isDirectory).length,
      totalUncompressedSize,
      totalCompressedSize,
      overallRatio,
      entries
    }
  } else if (ext === '.tar' || fullExt.endsWith('.tgz') || fullExt.endsWith('.tar.gz')) {
    const entries: ArchiveEntry[] = []
    let totalUncompressedSize = 0
    let idx = 0

    await tar.t({
      file: archivePath,
      onentry: (entry: any) => {
        const size = entry.size || 0
        totalUncompressedSize += size
        entries.push({
          id: `entry-${idx++}`,
          name: path.basename(entry.path),
          path: entry.path,
          isDirectory: entry.type === 'Directory',
          size,
          date: entry.mtime ? new Date(entry.mtime).toLocaleDateString() : undefined
        })
      }
    })

    const overallRatio = totalUncompressedSize > 0 
      ? Math.round((1 - (totalCompressedSize / totalUncompressedSize)) * 100) 
      : 0

    return {
      archivePath,
      format: fullExt.endsWith('.tgz') || fullExt.endsWith('.tar.gz') ? 'TAR.GZ' : 'TAR',
      passwordProtected: false,
      totalFiles: entries.filter(e => !e.isDirectory).length,
      totalUncompressedSize,
      totalCompressedSize,
      overallRatio,
      entries
    }
  } else if (ext === '.gz') {
    const baseName = path.basename(archivePath, '.gz')
    let uncompressedSize = totalCompressedSize
    try {
      if (totalCompressedSize >= 8) {
        const fd = fs.openSync(archivePath, 'r')
        const buffer = Buffer.alloc(4)
        fs.readSync(fd, buffer, 0, 4, totalCompressedSize - 4)
        fs.closeSync(fd)
        uncompressedSize = buffer.readUInt32LE(0)
      }
    } catch {
      uncompressedSize = totalCompressedSize
    }

    const overallRatio = uncompressedSize > 0
      ? Math.max(0, Math.round((1 - (totalCompressedSize / uncompressedSize)) * 100))
      : 0

    return {
      archivePath,
      format: 'GZ',
      passwordProtected: false,
      totalFiles: 1,
      totalUncompressedSize: uncompressedSize,
      totalCompressedSize,
      overallRatio,
      entries: [
        {
          id: 'entry-0',
          name: baseName,
          path: baseName,
          isDirectory: false,
          size: uncompressedSize,
          compressedSize: totalCompressedSize,
          ratio: overallRatio
        }
      ]
    }
  } else {
    throw new Error(`Unsupported archive format: ${ext}`)
  }
}

import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import zlib from 'zlib'
import { ProgressCallback } from './compressor'

export interface ExtractionOptions {
  archivePath: string
  targetDir: string
  selectedEntries?: string[] // Optional filter for selective extraction
  password?: string
}

export const WRONG_ZIP_PASSWORD_ERROR_CODE = 'WRONG_ZIP_PASSWORD'
export const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz', '.gz'] as const

export function isSupportedArchivePath(archivePath: string): boolean {
  const normalizedPath = archivePath.toLowerCase()
  return SUPPORTED_ARCHIVE_EXTENSIONS.some(extension => normalizedPath.endsWith(extension))
}

export function isWrongZipPasswordError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Wrong Password')
}

function createWrongZipPasswordError(): Error & { code: string } {
  const error = new Error('Wrong ZIP password') as Error & { code: string }
  error.code = WRONG_ZIP_PASSWORD_ERROR_CODE
  return error
}

export async function extractArchive(
  options: ExtractionOptions,
  onProgress?: ProgressCallback
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const startTime = Date.now()
  const { archivePath, targetDir, selectedEntries, password } = options

  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive file does not exist: ${archivePath}`)
  }

  if (!fs.statSync(archivePath).isFile()) {
    throw new Error('Extraction requires an archive file, not a folder')
  }

  if (!isSupportedArchivePath(archivePath)) {
    throw new Error(`Unsupported archive format for extraction: ${path.extname(archivePath).toLowerCase()}`)
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  const ext = path.extname(archivePath).toLowerCase()
  const fullExt = archivePath.toLowerCase()

  if (ext === '.zip') {
    return new Promise((resolve, reject) => {
      try {
        const zip = new AdmZip(archivePath)
        const entries = (zip as any).getEntries(password)
        const totalEntries = entries.length
        let extractedCount = 0

        const filterMap = selectedEntries ? new Set(selectedEntries) : null

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]
          if (entry.isDirectory || (filterMap && !filterMap.has(entry.entryName))) {
            continue
          }

          zip.extractEntryTo(entry, targetDir, true, true)
          extractedCount++

          if (onProgress) {
            onProgress({
              processedBytes: i + 1,
              totalBytes: totalEntries,
              percent: Math.min(100, Math.round(((i + 1) / totalEntries) * 100)),
              currentFile: entry.entryName
            })
          }
        }

        resolve({
          targetDir,
          extractedCount,
          durationMs: Date.now() - startTime
        })
      } catch (err) {
        // adm-zip reports an incorrect ZipCrypto password as "Wrong Password".
        // Expose a stable error code so the renderer can ask for the password again.
        reject(isWrongZipPasswordError(err) ? createWrongZipPasswordError() : err)
      }
    })
  } else if (ext === '.tar' || fullExt.endsWith('.tgz') || fullExt.endsWith('.tar.gz')) {
    return new Promise((resolve, reject) => {
      let count = 0
      const filterMap = selectedEntries ? new Set(selectedEntries) : null
      tar.x({
        file: archivePath,
        cwd: targetDir,
        filter: (entryPath: string) => {
          if (!filterMap) return true
          return filterMap.has(entryPath)
        },
        onentry: (entry: any) => {
          count++
          if (onProgress) {
            onProgress({
              processedBytes: count,
              totalBytes: 100, // tar stream estimate
              percent: 50,
              currentFile: entry.path
            })
          }
        }
      }).then(() => {
        if (onProgress) {
          onProgress({
            processedBytes: count,
            totalBytes: count,
            percent: 100,
            currentFile: 'Complete'
          })
        }
        resolve({
          targetDir,
          extractedCount: count,
          durationMs: Date.now() - startTime
        })
      }).catch(reject)
    })
  } else if (ext === '.gz') {
    // Single GZ file extraction
    return new Promise((resolve, reject) => {
      const baseName = path.basename(archivePath, '.gz')
      const targetPath = path.join(targetDir, baseName)

      const gunzip = zlib.createGunzip()
      const readStream = fs.createReadStream(archivePath)
      const writeStream = fs.createWriteStream(targetPath)

      readStream.pipe(gunzip).pipe(writeStream)

      writeStream.on('finish', () => {
        resolve({
          targetDir,
          extractedCount: 1,
          durationMs: Date.now() - startTime
        })
      })

      writeStream.on('error', reject)
      readStream.on('error', reject)
      gunzip.on('error', reject)
    })
  } else {
    throw new Error(`Unsupported archive format for extraction: ${ext}`)
  }
}

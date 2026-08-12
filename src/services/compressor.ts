import fs from 'fs'
import path from 'path'
import archiver from 'archiver'
import * as tar from 'tar'
import zlib from 'zlib'

// Archiver does not provide password protection for ZIP archives itself.
// This plugin adds the ZipCrypto format used below. It is registered once when
// this module is loaded; registering it per job would throw in later jobs.
const zipEncrypted = require('archiver-zip-encrypted')
archiver.registerFormat('zip-encrypted', zipEncrypted)

export interface CompressionOptions {
  inputPaths: string[]
  outputPath: string
  format: 'zip' | 'tar' | 'gz' | 'tgz'
  level?: number // 0 (fastest/none) to 9 (maximum)
  password?: string
}

export interface ProgressData {
  processedBytes: number
  totalBytes: number
  percent: number
  currentFile: string
}

export type ProgressCallback = (data: ProgressData) => void

/**
 * Calculates total size of files/directories recursively.
 */
export function calculateTotalSize(paths: string[]): number {
  let total = 0
  for (const p of paths) {
    try {
      const stat = fs.statSync(p)
      if (stat.isDirectory()) {
        const files = fs.readdirSync(p)
        total += calculateTotalSize(files.map(f => path.join(p, f)))
      } else {
        total += stat.size
      }
    } catch {
      // Ignore unreadable files
    }
  }
  return total
}

export async function compressArchive(
  options: CompressionOptions,
  onProgress?: ProgressCallback
): Promise<{ outputPath: string; originalSize: number; compressedSize: number; durationMs: number }> {
  const startTime = Date.now()
  const { inputPaths, outputPath, format, level = 6 } = options

  if (options.password && format !== 'zip') {
    throw new Error('Password protection is currently available for ZIP archives only.')
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  const totalBytes = calculateTotalSize(inputPaths)

  if (format === 'zip' || format === 'tar' || format === 'tgz') {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath)
      
      const archiverFormat = format === 'tgz'
        ? 'tar'
        : format === 'zip' && options.password
          ? 'zip-encrypted'
          : format
      const archiveOptions: archiver.ArchiverOptions = {
        zlib: { level }
      }

      if (options.password) {
        // ZipCrypto is intentionally used instead of AES so the archive can
        // also be extracted by the app's current ZIP reader (adm-zip).
        // The UI explains that this is for compatibility, not strong secrecy.
        Object.assign(archiveOptions, {
          password: options.password,
          encryptionMethod: 'zip20'
        })
      }

      if (format === 'tgz') {
        archiveOptions.gzip = true
        archiveOptions.gzipOptions = { level }
      }

      const archive = archiver(archiverFormat as archiver.Format, archiveOptions)

      let processedBytes = 0

      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
          console.warn('Archiver warning:', err)
        } else {
          reject(err)
        }
      })

      archive.on('error', (err) => {
        reject(err)
      })

      archive.on('entry', (entry) => {
        processedBytes += entry.stats?.size || 0
        if (onProgress) {
          const percent = totalBytes > 0 ? Math.min(100, Math.round((processedBytes / totalBytes) * 100)) : 0
          onProgress({
            processedBytes,
            totalBytes,
            percent,
            currentFile: entry.name
          })
        }
      })

      archive.pipe(output)

      // Add files and directories to archive
      for (const itemPath of inputPaths) {
        try {
          const stat = fs.statSync(itemPath)
          const baseName = path.basename(itemPath)
          if (stat.isDirectory()) {
            archive.directory(itemPath, baseName)
          } else {
            archive.file(itemPath, { name: baseName })
          }
        } catch (err) {
          console.error(`Error reading ${itemPath}:`, err)
        }
      }

      output.on('close', () => {
        const compressedSize = fs.statSync(outputPath).size
        const durationMs = Date.now() - startTime
        if (onProgress) {
          onProgress({
            processedBytes: totalBytes,
            totalBytes,
            percent: 100,
            currentFile: 'Complete'
          })
        }
        resolve({
          outputPath,
          originalSize: totalBytes,
          compressedSize,
          durationMs
        })
      })

      archive.finalize()
    })
  } else if (format === 'gz') {
    // Single file GZIP
    return new Promise((resolve, reject) => {
      if (inputPaths.length === 0) {
        return reject(new Error('No input files specified for GZ compression.'))
      }
      const sourceFile = inputPaths[0]
      const inputStat = fs.statSync(sourceFile)
      if (inputStat.isDirectory()) {
        return reject(new Error('GZ format supports single files only. Please use .tgz or .zip for folder compression.'))
      }
      
      const gzip = zlib.createGzip({ level })
      const readStream = fs.createReadStream(sourceFile)
      const writeStream = fs.createWriteStream(outputPath)

      let processed = 0
      readStream.on('data', (chunk) => {
        processed += chunk.length
        if (onProgress) {
          onProgress({
            processedBytes: processed,
            totalBytes: inputStat.size,
            percent: Math.min(100, Math.round((processed / inputStat.size) * 100)),
            currentFile: path.basename(sourceFile)
          })
        }
      })

      readStream.pipe(gzip).pipe(writeStream)

      writeStream.on('finish', () => {
        const compressedSize = fs.statSync(outputPath).size
        const durationMs = Date.now() - startTime
        resolve({
          outputPath,
          originalSize: inputStat.size,
          compressedSize,
          durationMs
        })
      })

      writeStream.on('error', reject)
      readStream.on('error', reject)
      gzip.on('error', reject)
    })
  } else {
    throw new Error(`Unsupported format: ${format}`)
  }
}

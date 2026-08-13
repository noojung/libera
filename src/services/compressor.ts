import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import archiver from 'archiver'
import zipEncrypted from 'archiver-zip-encrypted'
import zlib from 'zlib'

// Archiver does not provide password protection for ZIP archives itself.
// This plugin adds the ZipCrypto format used below. It is registered once when
// this module is loaded; registering it per job would throw in later jobs.
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
  totalBytes: number | null
  percent: number | null
  phase: 'processing' | 'complete'
  currentFile?: string
}

export type ProgressCallback = (data: ProgressData) => void

/**
 * Calculates total size of files/directories recursively without following
 * symbolic links. This keeps directory scans non-blocking and prevents
 * symlink cycles from being traversed.
 */
export async function calculateTotalSize(paths: string[]): Promise<number> {
  const visitedDirectories = new Set<string>()

  const calculatePathSize = async (itemPath: string): Promise<number> => {
    try {
      const stat = await fsPromises.lstat(itemPath)
      if (stat.isSymbolicLink()) return 0

      if (!stat.isDirectory()) return stat.size

      const resolvedPath = await fsPromises.realpath(itemPath)
      if (visitedDirectories.has(resolvedPath)) return 0
      visitedDirectories.add(resolvedPath)

      const entries = await fsPromises.readdir(itemPath, { withFileTypes: true })
      let total = 0
      for (const entry of entries) {
        total += await calculatePathSize(path.join(itemPath, entry.name))
      }
      return total
    } catch {
      // Ignore unreadable files and directories.
      return 0
    }
  }

  let total = 0
  for (const itemPath of paths) {
    total += await calculatePathSize(itemPath)
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
  await fsPromises.mkdir(outputDir, { recursive: true })

  const totalBytes = await calculateTotalSize(inputPaths)

  if (format === 'zip' || format === 'tar' || format === 'tgz') {
    const archiveInputs: { itemPath: string; isDirectory: boolean }[] = []
    for (const itemPath of inputPaths) {
      try {
        const stat = await fsPromises.lstat(itemPath)
        archiveInputs.push({ itemPath, isDirectory: stat.isDirectory() })
      } catch (err) {
        console.error(`Error reading ${itemPath}:`, err)
      }
    }

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
        // also be extracted by the app's current ZIP reader.
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
            phase: 'processing',
            currentFile: entry.name
          })
        }
      })

      archive.pipe(output)

      // Add files and directories to archive
      for (const { itemPath, isDirectory } of archiveInputs) {
        const baseName = path.basename(itemPath)
        if (isDirectory) {
          archive.directory(itemPath, baseName)
        } else {
          archive.file(itemPath, { name: baseName })
        }
      }

      output.on('close', async () => {
        try {
          const compressedSize = (await fsPromises.stat(outputPath)).size
          const durationMs = Date.now() - startTime
          if (onProgress) {
            onProgress({
              processedBytes: totalBytes,
              totalBytes,
              percent: 100,
              phase: 'complete'
            })
          }
          resolve({
            outputPath,
            originalSize: totalBytes,
            compressedSize,
            durationMs
          })
        } catch (err) {
          reject(err)
        }
      })

      archive.finalize()
    })
  } else if (format === 'gz') {
    // Single file GZIP
    if (inputPaths.length === 0) {
      throw new Error('No input files specified for GZ compression.')
    }

    const sourceFile = inputPaths[0]
    const inputStat = await fsPromises.lstat(sourceFile)
    if (inputStat.isDirectory()) {
      throw new Error('GZ format supports single files only. Please use .tgz or .zip for folder compression.')
    }

    return new Promise((resolve, reject) => {
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
            phase: 'processing',
            currentFile: path.basename(sourceFile)
          })
        }
      })

      readStream.pipe(gzip).pipe(writeStream)

      writeStream.on('finish', async () => {
        try {
          const compressedSize = (await fsPromises.stat(outputPath)).size
          const durationMs = Date.now() - startTime
          resolve({
            outputPath,
            originalSize: inputStat.size,
            compressedSize,
            durationMs
          })
        } catch (err) {
          reject(err)
        }
      })

      writeStream.on('error', reject)
      readStream.on('error', reject)
      gzip.on('error', reject)
    })
  } else {
    throw new Error(`Unsupported format: ${format}`)
  }
}

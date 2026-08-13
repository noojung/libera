import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import * as tar from 'tar'
import { strToU8, zipSync } from 'fflate'
import { compressArchive, type ProgressData } from './compressor'
import {
  buildExtractionPlan,
  calculateUsableExtractionBytes,
  DEFAULT_EXTRACTION_POLICY,
  extractArchive,
  ExtractionError,
  isSupportedArchivePath,
  MAX_ARCHIVE_ENTRIES,
  MAX_FILE_EXTRACTED_BYTES,
  MAX_TOTAL_EXTRACTED_BYTES
} from './extractor'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-extractor-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createZip(archivePath: string, entries: Record<string, string>): Promise<void> {
  await fs.writeFile(archivePath, zipSync(Object.fromEntries(
    Object.entries(entries).map(([entryPath, contents]) => [entryPath, strToU8(contents)])
  )))
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('extractArchive security checks', () => {
  it('recognizes supported archive extensions case-insensitively', () => {
    expect(isSupportedArchivePath('/tmp/archive.ZIP')).toBe(true)
    expect(isSupportedArchivePath('/tmp/archive.TAR.GZ')).toBe(true)
    expect(isSupportedArchivePath('/tmp/archive.7z')).toBe(false)
  })

  it('extracts a normal ZIP entry inside the target directory', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await createZip(archivePath, { 'docs/readme.txt': 'safe content' })

    await extractArchive({ archivePath, targetDir })

    await expect(fs.readFile(path.join(targetDir, 'docs', 'readme.txt'), 'utf8')).resolves.toBe('safe content')
  })

  it('does not overwrite an existing destination file', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await createZip(archivePath, { 'existing.txt': 'archive content' })
    await fs.mkdir(targetDir)
    await fs.writeFile(path.join(targetDir, 'existing.txt'), 'original content')

    await expect(extractArchive({ archivePath, targetDir })).rejects.toThrow('destination already exists')
    await expect(fs.readFile(path.join(targetDir, 'existing.txt'), 'utf8')).resolves.toBe('original content')
  })

  it('rejects ZIP Slip paths before writing outside the target directory', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    const outsidePath = path.join(directory, 'escape.txt')
    await fs.writeFile(archivePath, zipSync({ '../escape.txt': strToU8('unsafe') }))

    await expect(extractArchive({ archivePath, targetDir })).rejects.toThrow('entry path escapes the destination')
    await expect(fs.access(outsidePath)).rejects.toThrow()
  })

  it('rejects extraction through an existing destination symbolic link', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    const outsideDir = path.join(directory, 'outside')
    await createZip(archivePath, { 'linked/escape.txt': 'unsafe' })
    await fs.mkdir(targetDir)
    await fs.mkdir(outsideDir)
    await fs.symlink(outsideDir, path.join(targetDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(extractArchive({ archivePath, targetDir })).rejects.toThrow('destination parent is a symbolic link')
    await expect(fs.access(path.join(outsideDir, 'escape.txt'))).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('rejects TAR symbolic link entries before extraction', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const archivePath = path.join(directory, 'archive.tar')
    const targetDir = path.join(directory, 'output')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'file.txt'), 'content')
    await fs.symlink('file.txt', path.join(sourceDir, 'link.txt'))
    await tar.c({ cwd: sourceDir, file: archivePath }, ['link.txt'])

    await expect(extractArchive({ archivePath, targetDir })).rejects.toThrow('symbolic and hard link entries are not supported')
  })

  it('extracts the descendants of a selected directory from a TAR.GZ archive', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const archivePath = path.join(directory, 'archive.tar.gz')
    const targetDir = path.join(directory, 'output')
    await fs.mkdir(path.join(sourceDir, 'docs'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'docs', 'readme.txt'), 'selected')
    await fs.writeFile(path.join(sourceDir, 'skip.txt'), 'not selected')
    await tar.c({ cwd: sourceDir, file: archivePath, gzip: true }, ['docs', 'skip.txt'])

    await extractArchive({ archivePath, targetDir, selectedEntries: ['docs/'] })

    await expect(fs.readFile(path.join(targetDir, 'docs', 'readme.txt'), 'utf8')).resolves.toBe('selected')
    await expect(fs.access(path.join(targetDir, 'skip.txt'))).rejects.toThrow()
  })

  it('extracts a normal GZ archive', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'document.txt.gz')
    const targetDir = path.join(directory, 'output')
    await fs.writeFile(archivePath, zlib.gzipSync('gzip content'))

    await extractArchive({ archivePath, targetDir })

    await expect(fs.readFile(path.join(targetDir, 'document.txt'), 'utf8')).resolves.toBe('gzip content')
  })

  it('extracts a ZipCrypto archive with the correct password and rejects a wrong one', async () => {
    const directory = await createTemporaryDirectory()
    const sourcePath = path.join(directory, 'secret.txt')
    const archivePath = path.join(directory, 'secret.zip')
    const targetDir = path.join(directory, 'output')
    await fs.writeFile(sourcePath, 'classified')
    await compressArchive({
      inputPaths: [sourcePath],
      outputPath: archivePath,
      format: 'zip',
      password: 'correct-password'
    })

    await expect(extractArchive({ archivePath, targetDir, password: 'wrong-password' }))
      .rejects.toMatchObject({ code: 'WRONG_ZIP_PASSWORD' })
    await extractArchive({ archivePath, targetDir, password: 'correct-password' })

    await expect(fs.readFile(path.join(targetDir, 'secret.txt'), 'utf8')).resolves.toBe('classified')
  })

  it('reports byte progress for streamed ZIP extraction', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    const contents = 'streamed zip contents'
    const progress: ProgressData[] = []
    await createZip(archivePath, { 'large.txt': contents })

    await extractArchive({ archivePath, targetDir }, update => progress.push(update))

    expect(progress.at(-1)).toMatchObject({
      processedBytes: Buffer.byteLength(contents),
      totalBytes: Buffer.byteLength(contents),
      percent: 100
    })
  })

  it('cancels GZ extraction and removes its partial output', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'large.txt.gz')
    const targetDir = path.join(directory, 'output')
    const controller = new AbortController()
    await fs.writeFile(archivePath, zlib.gzipSync(Buffer.alloc(1024 * 1024, 65)))

    await expect(extractArchive(
      { archivePath, targetDir },
      progress => {
        if (progress.processedBytes > 0) controller.abort()
      },
      { signal: controller.signal }
    )).rejects.toMatchObject({ code: 'EXTRACTION_CANCELLED' })

    await expect(fs.access(path.join(targetDir, 'large.txt'))).rejects.toThrow()
  })

  it('cancels ZIP extraction and removes files created by the job', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'large.zip')
    const targetDir = path.join(directory, 'nested', 'zip-output')
    const controller = new AbortController()
    await fs.writeFile(archivePath, zipSync({ 'large.bin': new Uint8Array(2 * 1024 * 1024) }, { level: 0 }))

    await expect(extractArchive(
      { archivePath, targetDir },
      progress => {
        if (progress.processedBytes > 0) controller.abort()
      },
      { signal: controller.signal }
    )).rejects.toMatchObject({ code: 'EXTRACTION_CANCELLED' })

    await expect(fs.access(path.join(directory, 'nested'))).rejects.toThrow()
  })

  it('cancels TAR extraction and removes files created by the job', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const archivePath = path.join(directory, 'large.tar')
    const targetDir = path.join(directory, 'nested', 'tar-output')
    const controller = new AbortController()
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'large.bin'), Buffer.alloc(2 * 1024 * 1024, 65))
    await tar.c({ cwd: sourceDir, file: archivePath }, ['large.bin'])

    await expect(extractArchive(
      { archivePath, targetDir },
      progress => {
        if (progress.processedBytes > 0) controller.abort()
      },
      { signal: controller.signal }
    )).rejects.toMatchObject({ code: 'EXTRACTION_CANCELLED' })

    await expect(fs.access(path.join(directory, 'nested'))).rejects.toThrow()
  })

  it('enforces an injected streaming limit and removes partial GZ output', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'limited.txt.gz')
    const targetDir = path.join(directory, 'output')
    await fs.writeFile(archivePath, zlib.gzipSync('more than five bytes'))

    await expect(extractArchive(
      { archivePath, targetDir },
      undefined,
      {
        policy: { maxFileBytes: 5, maxTotalBytes: 5, minimumReserveBytes: 0, reserveRatioPercent: 0 },
        getAvailableBytes: async () => 1024n
      }
    )).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(fs.access(path.join(targetDir, 'limited.txt'))).rejects.toThrow()
  })

  it('rejects extraction when the configured disk reserve leaves no usable space', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const createdParentDir = path.join(directory, 'new-parent')
    const targetDir = path.join(createdParentDir, 'nested', 'output')
    await createZip(archivePath, { 'file.txt': 'content' })

    await expect(extractArchive(
      { archivePath, targetDir },
      undefined,
      { getAvailableBytes: async () => BigInt(DEFAULT_EXTRACTION_POLICY.minimumReserveBytes) }
    )).rejects.toMatchObject({ code: 'INSUFFICIENT_DISK_SPACE' })
    await expect(fs.access(createdParentDir)).rejects.toThrow()
  })

  it('preserves existing destination files when TAR and GZ extraction is rejected', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'source')
    const tarPath = path.join(directory, 'archive.tar')
    const gzPath = path.join(directory, 'existing.txt.gz')
    const tarTarget = path.join(directory, 'tar-output')
    const gzTarget = path.join(directory, 'gz-output')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'existing.txt'), 'archive content')
    await tar.c({ cwd: sourceDir, file: tarPath }, ['existing.txt'])
    await fs.writeFile(gzPath, zlib.gzipSync('archive content'))
    await fs.mkdir(tarTarget)
    await fs.mkdir(gzTarget)
    await fs.writeFile(path.join(tarTarget, 'existing.txt'), 'original tar content')
    await fs.writeFile(path.join(gzTarget, 'existing.txt'), 'original gz content')

    await expect(extractArchive({ archivePath: tarPath, targetDir: tarTarget }))
      .rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
    await expect(extractArchive({ archivePath: gzPath, targetDir: gzTarget }))
      .rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
    await expect(fs.readFile(path.join(tarTarget, 'existing.txt'), 'utf8')).resolves.toBe('original tar content')
    await expect(fs.readFile(path.join(gzTarget, 'existing.txt'), 'utf8')).resolves.toBe('original gz content')
  })
})

describe('extraction limits', () => {
  it('uses 1 TiB file and archive limits with 100,000 entries', () => {
    expect(MAX_ARCHIVE_ENTRIES).toBe(100_000)
    expect(MAX_FILE_EXTRACTED_BYTES).toBe(1024 ** 4)
    expect(MAX_TOTAL_EXTRACTED_BYTES).toBe(1024 ** 4)
  })

  it('reserves five percent or at least 1 GiB and clamps the result to 1 TiB', () => {
    const gib = 1024n ** 3n
    const tib = 1024n ** 4n
    expect(calculateUsableExtractionBytes(10n * gib, DEFAULT_EXTRACTION_POLICY)).toBe(Number(9n * gib))
    expect(calculateUsableExtractionBytes(100n * gib, DEFAULT_EXTRACTION_POLICY)).toBe(Number(95n * gib))
    expect(calculateUsableExtractionBytes(2n * tib, DEFAULT_EXTRACTION_POLICY)).toBe(Number(tib))
  })

  it('counts only selected entries toward extraction size limits', () => {
    const policy = { ...DEFAULT_EXTRACTION_POLICY, maxFileBytes: 10, maxTotalBytes: 10 }
    const plan = buildExtractionPlan([
      { archivePath: 'selected.txt', isDirectory: false, size: 10 },
      { archivePath: 'ignored.bin', isDirectory: false, size: 1_000 }
    ], path.resolve('target'), new Set(['selected.txt']), policy)

    expect(plan.selectedTotalBytes).toBe(10)
    expect(plan.entries.find(entry => entry.archivePath === 'ignored.bin')?.shouldExtract).toBe(false)
  })

  it('accepts exact boundaries and rejects values above them', () => {
    const policy = { ...DEFAULT_EXTRACTION_POLICY, maxEntries: 1, maxFileBytes: 10, maxTotalBytes: 10 }
    expect(buildExtractionPlan([
      { archivePath: 'file.txt', isDirectory: false, size: 10 }
    ], path.resolve('target'), null, policy).selectedTotalBytes).toBe(10)

    expect(() => buildExtractionPlan([
      { archivePath: 'first.txt', isDirectory: false, size: 1 },
      { archivePath: 'second.txt', isDirectory: false, size: 1 }
    ], path.resolve('target'), null, policy)).toThrow(ExtractionError)
    expect(() => buildExtractionPlan([
      { archivePath: 'file.txt', isDirectory: false, size: 11 }
    ], path.resolve('target'), null, policy)).toThrow(ExtractionError)
  })
})

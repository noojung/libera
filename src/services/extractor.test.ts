import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import * as tar from 'tar'
import { strToU8, zipSync } from 'fflate'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { compressArchive, type ProgressData } from './compressor'
import { runSevenZip } from './sevenZip'
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

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-extractor-'))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * The macOS layout: a 32 byte Finder info block padded to a 4 byte boundary,
 * then the attribute header, one entry and its value.
 */
function buildAppleDoubleSidecar(attributeName: string, value: string): Uint8Array {
  const valueBytes = Buffer.from(value)
  const nameLength = Buffer.byteLength(attributeName) + 1
  const finderInfoOffset = 26 + 12
  const attrHeaderOffset = finderInfoOffset + 32 + 2
  const entryOffset = attrHeaderOffset + 36
  const dataStart = entryOffset + 11 + nameLength + ((4 - ((entryOffset + 11 + nameLength) % 4)) % 4)
  const total = dataStart + valueBytes.length

  const buffer = Buffer.alloc(total)
  buffer.writeUInt32BE(0x00051607, 0)
  buffer.writeUInt32BE(0x00020000, 4)
  buffer.writeUInt16BE(1, 24)
  buffer.writeUInt32BE(9, 26)
  buffer.writeUInt32BE(finderInfoOffset, 30)
  buffer.writeUInt32BE(total - finderInfoOffset, 34)
  buffer.write('ATTR', attrHeaderOffset, 'ascii')
  buffer.writeUInt32BE(total, attrHeaderOffset + 8)
  buffer.writeUInt32BE(dataStart, attrHeaderOffset + 12)
  buffer.writeUInt16BE(1, attrHeaderOffset + 34)
  buffer.writeUInt32BE(dataStart, entryOffset)
  buffer.writeUInt32BE(valueBytes.length, entryOffset + 4)
  buffer.writeUInt8(nameLength, entryOffset + 10)
  buffer.write(attributeName, entryOffset + 11, 'ascii')
  valueBytes.copy(buffer, dataStart)

  return new Uint8Array(buffer)
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
    expect(isSupportedArchivePath('/tmp/archive.7z')).toBe(true)
    expect(isSupportedArchivePath('/tmp/archive.7z.001')).toBe(true)
    expect(isSupportedArchivePath('/tmp/library.jar')).toBe(true)
    expect(isSupportedArchivePath('/tmp/archive.rar')).toBe(false)
  })

  it('extracts a normal ZIP entry inside the target directory', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await createZip(archivePath, { 'docs/readme.txt': 'safe content' })

    await extractArchive({ archivePath, targetDir })

    await expect(fs.readFile(path.join(targetDir, 'docs', 'readme.txt'), 'utf8')).resolves.toBe('safe content')
  })

  it('extracts a JAR through the ZIP reader', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'library.jar')
    const targetDir = path.join(directory, 'output')
    await createZip(archivePath, {
      'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n',
      'com/example/App.class': 'class bytes'
    })

    const result = await extractArchive({ archivePath, targetDir })

    expect(result.extractedCount).toBeGreaterThanOrEqual(2)
    await expect(fs.readFile(path.join(targetDir, 'META-INF', 'MANIFEST.MF'), 'utf8'))
      .resolves.toBe('Manifest-Version: 1.0\n')
    await expect(fs.readFile(path.join(targetDir, 'com', 'example', 'App.class'), 'utf8'))
      .resolves.toBe('class bytes')
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

  it.skipIf(process.platform === 'win32')('recreates a ZIP symlink entry whose target stays inside the destination', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    const symlinkMode = 0o120777 << 16
    await fs.writeFile(archivePath, zipSync({
      'real.txt': strToU8('target content'),
      'link.txt': [strToU8('real.txt'), { os: 3, attrs: symlinkMode }]
    }))

    await extractArchive({ archivePath, targetDir })

    const linkPath = path.join(targetDir, 'link.txt')
    await expect(fs.lstat(linkPath).then(stat => stat.isSymbolicLink())).resolves.toBe(true)
    await expect(fs.readlink(linkPath)).resolves.toBe('real.txt')
    await expect(fs.readFile(linkPath, 'utf8')).resolves.toBe('target content')
  })

  it.skipIf(process.platform === 'win32')('rejects a ZIP symlink entry whose target escapes the destination', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    const outsidePath = path.join(directory, 'escape.txt')
    const symlinkMode = 0o120777 << 16
    await fs.writeFile(archivePath, zipSync({
      'link.txt': [strToU8('../escape.txt'), { os: 3, attrs: symlinkMode }]
    }))

    await expect(extractArchive({ archivePath, targetDir })).rejects.toThrow('symlink target escapes the destination')
    await expect(fs.access(outsidePath)).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('restores the executable permission recorded in a ZIP entry', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await fs.writeFile(archivePath, zipSync({
      'run.sh': [strToU8('#!/bin/sh\necho hi\n'), { os: 3, attrs: 0o100755 << 16 }],
      'plain.txt': [strToU8('data'), { os: 3, attrs: 0o100644 << 16 }]
    }))

    await extractArchive({ archivePath, targetDir })

    const modeOf = async (name: string) => (await fs.stat(path.join(targetDir, name))).mode & 0o777
    await expect(modeOf('run.sh')).resolves.toBe(0o755)
    await expect(modeOf('plain.txt')).resolves.toBe(0o644)
  })

  it.skipIf(process.platform === 'win32')('strips setuid and setgid bits from ZIP entry permissions', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await fs.writeFile(archivePath, zipSync({
      'sneaky': [strToU8('payload'), { os: 3, attrs: (0o100000 | 0o6755) << 16 }]
    }))

    await extractArchive({ archivePath, targetDir })

    const stat = await fs.stat(path.join(targetDir, 'sneaky'))
    expect(stat.mode & 0o7000).toBe(0)
    expect(stat.mode & 0o777).toBe(0o755)
  })

  it.skipIf(process.platform !== 'darwin')('folds an AppleDouble sidecar into the extended attributes of its subject', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await fs.writeFile(archivePath, zipSync({
      'signed.wasm': strToU8('payload'),
      '._signed.wasm': buildAppleDoubleSidecar('com.apple.cs.CodeSignature', 'signature-bytes')
    }))

    await extractArchive({ archivePath, targetDir })

    // The sidecar itself must not survive: a stray ._ file breaks the sealed
    // resources of a signed bundle.
    await expect(fs.access(path.join(targetDir, '._signed.wasm'))).rejects.toThrow()
    await expect(fs.readFile(path.join(targetDir, 'signed.wasm'), 'utf8')).resolves.toBe('payload')

    const { stdout } = await execFileAsync('xattr', ['-px', 'com.apple.cs.CodeSignature', path.join(targetDir, 'signed.wasm')])
    expect(Buffer.from(stdout.replace(/\s/g, ''), 'hex').toString()).toBe('signature-bytes')
  })

  it.skipIf(process.platform !== 'darwin')('keeps a ._ entry that is not AppleDouble as an ordinary file', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await createZip(archivePath, { 'notes.txt': 'real', '._notes.txt': 'not a sidecar' })

    await extractArchive({ archivePath, targetDir })

    await expect(fs.readFile(path.join(targetDir, '._notes.txt'), 'utf8')).resolves.toBe('not a sidecar')
  })

  it.skipIf(process.platform !== 'darwin')('propagates the archive\'s quarantine flag onto the top level extracted item', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await createZip(archivePath, { 'App/Contents/Info.plist': 'plist', 'App/Contents/MacOS/App': 'binary' })
    const quarantineValue = '0081;00000000;Safari;'
    await execFileAsync('xattr', ['-w', 'com.apple.quarantine', quarantineValue, archivePath])

    await extractArchive({ archivePath, targetDir })

    const { stdout } = await execFileAsync('xattr', ['-p', 'com.apple.quarantine', path.join(targetDir, 'App')])
    expect(stdout.trim()).toBe(quarantineValue)
    await expect(execFileAsync('xattr', ['-p', 'com.apple.quarantine', path.join(targetDir, 'App', 'Contents', 'Info.plist')]))
      .rejects.toThrow()
  })

  it.skipIf(process.platform !== 'darwin')('leaves extracted items unquarantined when the archive itself carries no quarantine flag', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await createZip(archivePath, { 'note.txt': 'content' })

    await extractArchive({ archivePath, targetDir })

    await expect(execFileAsync('xattr', ['-p', 'com.apple.quarantine', path.join(targetDir, 'note.txt')])).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('leaves the restrictive default mode on entries that record no permissions', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await createZip(archivePath, { 'note.txt': 'content' })

    await extractArchive({ archivePath, targetDir })

    const stat = await fs.stat(path.join(targetDir, 'note.txt'))
    expect(stat.mode & 0o777).toBe(0o600)
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

/**
 * The Windows branches decide what libera does with metadata the platform
 * cannot represent, so they are exercised everywhere by re-importing the module
 * under a stubbed platform rather than only on a Windows runner.
 */
describe('Windows extraction behaviour', () => {
  async function importExtractorAsWindows(): Promise<typeof import('./extractor')> {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.resetModules()
    return import('./extractor')
  }

  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform)
    vi.resetModules()
  })

  it('rejects ZIP symlink entries, which Windows cannot create without a privilege', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await fs.writeFile(archivePath, zipSync({
      'real.txt': strToU8('target content'),
      'link.txt': [strToU8('real.txt'), { os: 3, attrs: 0o120777 << 16 }]
    }))

    const { extractArchive: extractOnWindows } = await importExtractorAsWindows()

    await expect(extractOnWindows({ archivePath, targetDir }))
      .rejects.toThrow('symbolic and hard link entries are not supported')
  })

  it('leaves unix modes unapplied, so a read-only entry stays deletable for rollback', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await fs.writeFile(archivePath, zipSync({
      'runner.sh': [strToU8('#!/bin/sh\n'), { os: 3, attrs: 0o100755 << 16 }],
      'readonly.txt': [strToU8('content'), { os: 3, attrs: 0o100444 << 16 }]
    }))

    const { extractArchive: extractOnWindows } = await importExtractorAsWindows()
    await extractOnWindows({ archivePath, targetDir })

    // Both keep the mode they were created with instead of the archive's, so
    // an entry recorded read-only is not actually read-only here - the exact
    // value differs by platform (POSIX honors the 0600 passed to open(),
    // Windows only tracks a single read-only flag and reports 0666/0444), so
    // what is checked is that the archive's modes were not applied, not the
    // literal bits.
    const modeOf = async (name: string) => (await fs.stat(path.join(targetDir, name))).mode & 0o777
    await expect(modeOf('runner.sh')).resolves.toBe(await modeOf('readonly.txt'))
    await expect(fs.unlink(path.join(targetDir, 'readonly.txt'))).resolves.toBeUndefined()
  })

  it('keeps AppleDouble sidecars as ordinary files, matching every Windows unzip tool', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'archive.zip')
    const targetDir = path.join(directory, 'output')
    await fs.writeFile(archivePath, zipSync({
      'signed.wasm': strToU8('payload'),
      '._signed.wasm': buildAppleDoubleSidecar('com.apple.cs.CodeSignature', 'signature-bytes')
    }))

    const { extractArchive: extractOnWindows } = await importExtractorAsWindows()
    await extractOnWindows({ archivePath, targetDir })

    await expect(fs.access(path.join(targetDir, '._signed.wasm'))).resolves.toBeUndefined()
  })
})

describe('7z extraction', () => {
  async function seedSource(directory: string): Promise<string> {
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(path.join(sourceDir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'a.txt'), 'alpha')
    await fs.writeFile(path.join(sourceDir, 'sub', 'b.txt'), 'bravo bravo')
    await fs.writeFile(path.join(sourceDir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await fs.writeFile(path.join(sourceDir, 'empty.txt'), '')
    return sourceDir
  }

  it('restores contents, the executable bit and empty files', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await seedSource(directory)
    const archivePath = path.join(directory, 'archive.7z')
    const targetDir = path.join(directory, 'out')
    await runSevenZip(['a', '-mx=1', archivePath, sourceDir], undefined)

    const result = await extractArchive({ archivePath, targetDir })

    expect(result.extractedCount).toBe(4)
    await expect(fs.readFile(path.join(targetDir, 'src', 'a.txt'), 'utf8')).resolves.toBe('alpha')
    await expect(fs.readFile(path.join(targetDir, 'src', 'sub', 'b.txt'), 'utf8')).resolves.toBe('bravo bravo')
    await expect(fs.readFile(path.join(targetDir, 'src', 'empty.txt'), 'utf8')).resolves.toBe('')
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(targetDir, 'src', 'run.sh'))).mode & 0o777).toBe(0o755)
    }
  }, 60_000)

  it('meters every byte it writes, so progress is real rather than inferred', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'payload.bin'), Buffer.alloc(1024 * 1024, 9))
    const archivePath = path.join(directory, 'metered.7z')
    await runSevenZip(['a', '-mx=1', archivePath, sourceDir], undefined)

    const updates: ProgressData[] = []
    await extractArchive({ archivePath, targetDir: path.join(directory, 'out') }, data => updates.push(data))

    const processing = updates.filter(update => update.phase === 'processing')
    expect(processing.length).toBeGreaterThan(1)
    expect(processing.at(-1)?.processedBytes).toBe(1024 * 1024)
    expect(updates.at(-1)).toMatchObject({ phase: 'complete', percent: 100 })
  }, 60_000)

  it.skipIf(process.platform === 'win32')('recreates a symlink whose target stays inside the destination', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await seedSource(directory)
    await fs.symlink('a.txt', path.join(sourceDir, 'link.txt'))
    const archivePath = path.join(directory, 'linked.7z')
    const targetDir = path.join(directory, 'out')
    await runSevenZip(['a', '-snl', '-mx=1', archivePath, sourceDir], undefined)

    await extractArchive({ archivePath, targetDir })

    const linkPath = path.join(targetDir, 'src', 'link.txt')
    await expect(fs.lstat(linkPath).then(stat => stat.isSymbolicLink())).resolves.toBe(true)
    await expect(fs.readlink(linkPath)).resolves.toBe('a.txt')
    await expect(fs.readFile(linkPath, 'utf8')).resolves.toBe('alpha')
  }, 60_000)

  it.skipIf(process.platform === 'win32')('refuses a symlink pointing outside and writes nothing', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'a.txt'), 'alpha')
    await fs.symlink('../../escape.txt', path.join(sourceDir, 'escape.txt'))
    const archivePath = path.join(directory, 'escape.7z')
    const targetDir = path.join(directory, 'out')
    await runSevenZip(['a', '-snl', '-mx=1', archivePath, sourceDir], undefined)

    await expect(extractArchive({ archivePath, targetDir }))
      .rejects.toThrow('symlink target escapes the destination')
    // Rollback must leave the destination as it found it.
    await expect(fs.readdir(targetDir).catch(() => [])).resolves.toEqual([])
  }, 60_000)

  it('extracts only the selected entries', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await seedSource(directory)
    const archivePath = path.join(directory, 'partial.7z')
    const targetDir = path.join(directory, 'out')
    await runSevenZip(['a', '-mx=1', archivePath, sourceDir], undefined)

    await extractArchive({ archivePath, targetDir, selectedEntries: ['src/sub'] })

    await expect(fs.readFile(path.join(targetDir, 'src', 'sub', 'b.txt'), 'utf8')).resolves.toBe('bravo bravo')
    await expect(fs.access(path.join(targetDir, 'src', 'a.txt'))).rejects.toThrow()
  }, 60_000)

  it('extracts an encrypted archive and rejects the wrong password', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await seedSource(directory)
    const archivePath = path.join(directory, 'enc.7z')
    await runSevenZip(['a', '-mx=1', '-mhe=on', archivePath, sourceDir], 'hunter2')

    await expect(extractArchive({ archivePath, targetDir: path.join(directory, 'bad'), password: 'nope' }))
      .rejects.toMatchObject({ code: 'SEVEN_ZIP_WRONG_PASSWORD' })

    const targetDir = path.join(directory, 'good')
    await extractArchive({ archivePath, targetDir, password: 'hunter2' })
    await expect(fs.readFile(path.join(targetDir, 'src', 'a.txt'), 'utf8')).resolves.toBe('alpha')
  }, 60_000)

  it('does not overwrite a file already in the destination', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = await seedSource(directory)
    const archivePath = path.join(directory, 'clash.7z')
    const targetDir = path.join(directory, 'out')
    await runSevenZip(['a', '-mx=1', archivePath, sourceDir], undefined)
    await fs.mkdir(path.join(targetDir, 'src'), { recursive: true })
    await fs.writeFile(path.join(targetDir, 'src', 'a.txt'), 'original')

    await expect(extractArchive({ archivePath, targetDir })).rejects.toThrow('destination already exists')
    await expect(fs.readFile(path.join(targetDir, 'src', 'a.txt'), 'utf8')).resolves.toBe('original')
  }, 60_000)

  it('rolls back everything it wrote when cancelled mid-archive', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    for (let index = 0; index < 40; index += 1) {
      await fs.writeFile(path.join(sourceDir, `f${index}.bin`), Buffer.alloc(256 * 1024, index))
    }
    const archivePath = path.join(directory, 'cancel.7z')
    const targetDir = path.join(directory, 'out')
    await runSevenZip(['a', '-mx=0', archivePath, sourceDir], undefined)

    const controller = new AbortController()
    const extraction = extractArchive({ archivePath, targetDir }, data => {
      if (data.processedBytes > 512 * 1024) controller.abort()
    }, { signal: controller.signal })

    await expect(extraction).rejects.toMatchObject({ code: 'EXTRACTION_CANCELLED' })
    await expect(fs.readdir(targetDir).catch(() => [])).resolves.toEqual([])
  }, 120_000)

  it('extracts a split set opened from a later volume', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'big.bin'), Buffer.alloc(200_000).map(() => Math.floor(Math.random() * 256)))
    await runSevenZip(['a', '-v30k', '-mx=0', path.join(directory, 'set.7z'), sourceDir], undefined)
    const targetDir = path.join(directory, 'out')

    await extractArchive({ archivePath: path.join(directory, 'set.7z.003'), targetDir })

    const extracted = await fs.readFile(path.join(targetDir, 'src', 'big.bin'))
    const original = await fs.readFile(path.join(sourceDir, 'big.bin'))
    expect(extracted.equals(original)).toBe(true)
  }, 120_000)
})

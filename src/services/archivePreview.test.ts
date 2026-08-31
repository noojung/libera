import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import * as tar from 'tar'
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { referenceSevenZipFixture } from 'libera7z/testing'
import { compressArchive } from './compressor'
import { inspectArchive } from './archiveInspector'
import { writeLibera7z } from './sevenZip/node'
import {
  ArchivePreviewError,
  MAX_ARCHIVE_PREVIEW_BYTES,
  MAX_IMAGE_PREVIEW_BYTES,
  previewArchiveEntry
} from './archivePreview'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-preview-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeZip(
  archivePath: string,
  entries: Array<{ name: string; contents: string | Uint8Array }>
): Promise<void> {
  const output = new Uint8ArrayWriter()
  const writer = new ZipWriter(output, { useWebWorkers: false })
  for (const entry of entries) {
    const reader = typeof entry.contents === 'string'
      ? new TextReader(entry.contents)
      : new Uint8ArrayReader(entry.contents)
    await writer.add(entry.name, reader)
  }
  await fs.writeFile(archivePath, await writer.close())
}

function createPng(width: number, height: number, byteLength = 24): Buffer {
  const data = Buffer.alloc(Math.max(byteLength, 24))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data)
  data.writeUInt32BE(13, 8)
  data.write('IHDR', 12, 'ascii')
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return data
}

function createJpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9
  ])
}

function createGif(width: number, height: number): Buffer {
  const data = Buffer.alloc(10)
  data.write('GIF89a', 0, 'ascii')
  data.writeUInt16LE(width, 6)
  data.writeUInt16LE(height, 8)
  return data
}

function writeUInt24LE(data: Buffer, value: number, offset: number): void {
  data[offset] = value & 0xff
  data[offset + 1] = (value >>> 8) & 0xff
  data[offset + 2] = (value >>> 16) & 0xff
}

function createWebp(width: number, height: number): Buffer {
  const data = Buffer.alloc(30)
  data.write('RIFF', 0, 'ascii')
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WEBP', 8, 'ascii')
  data.write('VP8X', 12, 'ascii')
  data.writeUInt32LE(10, 16)
  writeUInt24LE(data, width - 1, 24)
  writeUInt24LE(data, height - 1, 27)
  return data
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('previewArchiveEntry', () => {
  it.each([
    ['ZIP', 'sample.zip', false],
    ['JAR', 'sample.jar', false],
    ['WAR', 'sample.war', false],
    ['TAR', 'sample.tar', false],
    ['TGZ', 'sample.tgz', true],
    ['TAR.GZ', 'sample.tar.gz', true],
    ['GZ', 'sample.txt.gz', true]
  ] as const)('previews UTF-8 text from %s archives', async (format, archiveName, gzip) => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, archiveName)
    const contents = `hello from ${format}`

    if (format === 'ZIP' || format === 'JAR' || format === 'WAR') {
      await writeZip(archivePath, [{ name: 'sample.txt', contents }])
    } else if (format === 'GZ') {
      await fs.writeFile(archivePath, zlib.gzipSync(contents))
    } else {
      const sourcePath = path.join(directory, 'sample.txt')
      await fs.writeFile(sourcePath, contents)
      await tar.c({ cwd: directory, file: archivePath, gzip }, ['sample.txt'])
    }

    await expect(previewArchiveEntry(archivePath, 'entry-0')).resolves.toMatchObject({
      kind: 'text',
      text: contents,
      encoding: 'utf-8',
      truncated: false,
      previewedBytes: Buffer.byteLength(contents)
    })
  })

  it('keeps exactly 1 MiB and truncates larger expanded content', async () => {
    const directory = await createTemporaryDirectory()
    const exactPath = path.join(directory, 'exact.txt.gz')
    const oversizedPath = path.join(directory, 'oversized.txt.gz')
    await fs.writeFile(exactPath, zlib.gzipSync('a'.repeat(MAX_ARCHIVE_PREVIEW_BYTES)))
    await fs.writeFile(oversizedPath, zlib.gzipSync('b'.repeat(MAX_ARCHIVE_PREVIEW_BYTES + 1)))

    const exact = await previewArchiveEntry(exactPath, 'entry-0')
    const oversized = await previewArchiveEntry(oversizedPath, 'entry-0')

    expect(exact).toMatchObject({ kind: 'text', truncated: false, previewedBytes: MAX_ARCHIVE_PREVIEW_BYTES })
    expect(oversized).toMatchObject({ kind: 'text', truncated: true, previewedBytes: MAX_ARCHIVE_PREVIEW_BYTES })
    if (oversized.kind !== 'text') throw new Error('Expected a text preview')
    expect(oversized.text).toHaveLength(MAX_ARCHIVE_PREVIEW_BYTES)
  })

  it.each([
    ['ZIP', 'oversized.zip'],
    ['TAR', 'oversized.tar']
  ] as const)('enforces the expanded-byte limit for %s entries', async (format, archiveName) => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, archiveName)
    const contents = 'x'.repeat(MAX_ARCHIVE_PREVIEW_BYTES + 1)
    if (format === 'ZIP') {
      await writeZip(archivePath, [{ name: 'oversized.txt', contents }])
    } else {
      await fs.writeFile(path.join(directory, 'oversized.txt'), contents)
      await tar.c({ cwd: directory, file: archivePath }, ['oversized.txt'])
    }

    await expect(previewArchiveEntry(archivePath, 'entry-0')).resolves.toMatchObject({
      kind: 'text',
      truncated: true,
      previewedBytes: MAX_ARCHIVE_PREVIEW_BYTES
    })
  })

  it('drops an incomplete trailing UTF-8 character at the preview boundary', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'unicode.txt.gz')
    const contents = `${'a'.repeat(MAX_ARCHIVE_PREVIEW_BYTES - 1)}🙂`
    await fs.writeFile(archivePath, zlib.gzipSync(contents))

    const result = await previewArchiveEntry(archivePath, 'entry-0')

    if (result.kind !== 'text') throw new Error('Expected a text preview')
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('a'.repeat(MAX_ARCHIVE_PREVIEW_BYTES - 1))
  })

  it('decodes UTF-8, UTF-16 LE, and UTF-16 BE byte-order marks', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'encodings.zip')
    const text = '안녕하세요'
    const utf16Le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    const utf16BeBody = Buffer.from(text, 'utf16le')
    for (let index = 0; index < utf16BeBody.length; index += 2) {
      ;[utf16BeBody[index], utf16BeBody[index + 1]] = [utf16BeBody[index + 1], utf16BeBody[index]]
    }
    const utf16Be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BeBody])
    await writeZip(archivePath, [
      { name: 'utf8.txt', contents: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]) },
      { name: 'utf16le.txt', contents: utf16Le },
      { name: 'utf16be.txt', contents: utf16Be }
    ])

    await expect(previewArchiveEntry(archivePath, 'entry-0')).resolves.toMatchObject({ kind: 'text', text, encoding: 'utf-8' })
    await expect(previewArchiveEntry(archivePath, 'entry-1')).resolves.toMatchObject({ kind: 'text', text, encoding: 'utf-16le' })
    await expect(previewArchiveEntry(archivePath, 'entry-2')).resolves.toMatchObject({ kind: 'text', text, encoding: 'utf-16be' })
  })

  it('uses the entry id to distinguish duplicate archive paths', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'duplicate.tar')
    const sourcePath = path.join(directory, 'duplicate.txt')
    await fs.writeFile(sourcePath, 'first')
    await tar.c({ cwd: directory, file: archivePath }, ['duplicate.txt'])
    await fs.writeFile(sourcePath, 'second')
    await tar.r({ cwd: directory, file: archivePath }, ['duplicate.txt'])

    await expect(previewArchiveEntry(archivePath, 'entry-0')).resolves.toMatchObject({ kind: 'text', text: 'first' })
    await expect(previewArchiveEntry(archivePath, 'entry-1')).resolves.toMatchObject({ kind: 'text', text: 'second' })
  })

  it.each([
    ['ZIP', 'image.zip', false],
    ['TAR', 'image.tar', false],
    ['TGZ', 'image.tgz', true],
    ['TAR.GZ', 'image.tar.gz', true],
    ['GZ', 'image.bin.gz', true]
  ] as const)('previews signature-detected PNG data from %s archives', async (format, archiveName, gzip) => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, archiveName)
    const image = createPng(320, 200)

    if (format === 'ZIP') {
      await writeZip(archivePath, [{ name: 'no-extension', contents: image }])
    } else if (format === 'GZ') {
      await fs.writeFile(archivePath, zlib.gzipSync(image))
    } else {
      await fs.writeFile(path.join(directory, 'no-extension'), image)
      await tar.c({ cwd: directory, file: archivePath, gzip }, ['no-extension'])
    }

    const result = await previewArchiveEntry(archivePath, 'entry-0')
    expect(result).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      width: 320,
      height: 200,
      previewedBytes: image.length
    })
    if (result.kind !== 'image') throw new Error('Expected an image preview')
    expect(Buffer.from(result.data)).toEqual(image)
  })

  it('reads JPEG, WebP, and GIF dimensions from their headers', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'formats.zip')
    await writeZip(archivePath, [
      { name: 'wrong-extension.txt', contents: createJpeg(640, 480) },
      { name: 'image.webp', contents: createWebp(800, 600) },
      { name: 'image.gif', contents: createGif(160, 90) }
    ])

    await expect(previewArchiveEntry(archivePath, 'entry-0')).resolves.toMatchObject({
      kind: 'image', mediaType: 'image/jpeg', width: 640, height: 480
    })
    await expect(previewArchiveEntry(archivePath, 'entry-1')).resolves.toMatchObject({
      kind: 'image', mediaType: 'image/webp', width: 800, height: 600
    })
    await expect(previewArchiveEntry(archivePath, 'entry-2')).resolves.toMatchObject({
      kind: 'image', mediaType: 'image/gif', width: 160, height: 90
    })
  })

  it('rejects images over the byte and dimension limits', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'unsafe-images.zip')
    await writeZip(archivePath, [
      { name: 'too-large.png', contents: createPng(1, 1, MAX_IMAGE_PREVIEW_BYTES + 1) },
      { name: 'too-wide.png', contents: createPng(16_385, 1) },
      { name: 'too-many-pixels.png', contents: createPng(5_001, 5_000) }
    ])

    await expect(previewArchiveEntry(archivePath, 'entry-0')).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    await expect(previewArchiveEntry(archivePath, 'entry-1')).rejects.toMatchObject({ code: 'IMAGE_DIMENSIONS_TOO_LARGE' })
    await expect(previewArchiveEntry(archivePath, 'entry-2')).rejects.toMatchObject({ code: 'IMAGE_DIMENSIONS_TOO_LARGE' })
  })

  it('rejects unsupported and malformed image signatures while keeping SVG as text', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'invalid-images.zip')
    const malformedPng = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(malformedPng)
    await writeZip(archivePath, [
      { name: 'unsupported.bmp', contents: Buffer.from([0x42, 0x4d, 0, 0, 0, 0]) },
      { name: 'malformed.png', contents: malformedPng },
      { name: 'safe.svg', contents: '<svg><text>source only</text></svg>' }
    ])

    await expect(previewArchiveEntry(archivePath, 'entry-0')).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' })
    await expect(previewArchiveEntry(archivePath, 'entry-1')).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(previewArchiveEntry(archivePath, 'entry-2')).resolves.toMatchObject({
      kind: 'text', text: '<svg><text>source only</text></svg>'
    })
  })

  it('rejects binary data and non-file entries', async () => {
    const directory = await createTemporaryDirectory()
    const zipPath = path.join(directory, 'binary.zip')
    const tarPath = path.join(directory, 'folder.tar')
    await writeZip(zipPath, [{ name: 'binary.bin', contents: Uint8Array.from([0, 1, 2, 3]) }])
    await fs.mkdir(path.join(directory, 'folder'))
    await tar.c({ cwd: directory, file: tarPath }, ['folder'])

    await expect(previewArchiveEntry(zipPath, 'entry-0')).rejects.toMatchObject({ code: 'NOT_TEXT' })
    await expect(previewArchiveEntry(tarPath, 'entry-0')).rejects.toMatchObject({ code: 'ENTRY_NOT_PREVIEWABLE' })
  })

  it('returns bounded raw bytes for the expert Hex viewer', async () => {
    const directory = await createTemporaryDirectory()
    const zipPath = path.join(directory, 'binary.zip')
    const bytes = Uint8Array.from([0, 1, 2, 3, 0xfe, 0xff])
    await writeZip(zipPath, [{ name: 'binary.bin', contents: bytes }])

    const result = await previewArchiveEntry(zipPath, 'entry-0', { includeRawBytes: true })
    expect(result).toMatchObject({ kind: 'binary', truncated: false, previewedBytes: bytes.length })
    if (result.kind !== 'binary') throw new Error('Expected a binary preview')
    expect(result.rawBytes).toEqual(bytes)
  })

  it('previews an encrypted ZIP entry once given the password', async () => {
    const directory = await createTemporaryDirectory()
    const sourcePath = path.join(directory, 'secret.txt')
    const archivePath = path.join(directory, 'secret.zip')
    const contents = 'classified paragraph\n'.repeat(20)
    await fs.writeFile(sourcePath, contents)
    await compressArchive({
      inputPaths: [sourcePath],
      outputPath: archivePath,
      format: 'zip',
      password: 'hunter2'
    })

    // The central directory lists the entry without a password, so the prompt
    // belongs to the preview rather than the listing.
    await expect(previewArchiveEntry(archivePath, 'entry-0')).rejects.toMatchObject({
      code: 'PASSWORD_REQUIRED'
    })
    await expect(previewArchiveEntry(archivePath, 'entry-0', { password: 'wrong' })).rejects.toMatchObject({
      code: 'WRONG_PASSWORD'
    })
    await expect(previewArchiveEntry(archivePath, 'entry-0', { password: 'hunter2' })).resolves.toMatchObject({
      kind: 'text',
      text: contents
    })
  })

  it('previews an encrypted ZIP image entry', async () => {
    const directory = await createTemporaryDirectory()
    const sourcePath = path.join(directory, 'secret.png')
    const archivePath = path.join(directory, 'secret-image.zip')
    await fs.writeFile(sourcePath, createPng(32, 32))
    await compressArchive({
      inputPaths: [sourcePath],
      outputPath: archivePath,
      format: 'zip',
      password: 'hunter2'
    })

    await expect(previewArchiveEntry(archivePath, 'entry-0', { password: 'hunter2' })).resolves.toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      width: 32,
      height: 32
    })
  })

  it('rejects missing entries and cancelled requests with stable error codes', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'sample.zip')
    await writeZip(archivePath, [{ name: 'sample.txt', contents: 'sample' }])
    const controller = new AbortController()
    controller.abort()

    await expect(previewArchiveEntry(archivePath, 'entry-9')).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' })
    await expect(previewArchiveEntry(archivePath, 'entry-0', { signal: controller.signal })).rejects.toEqual(
      expect.any(ArchivePreviewError)
    )
    await expect(previewArchiveEntry(archivePath, 'entry-0', { signal: controller.signal })).rejects.toMatchObject({
      code: 'PREVIEW_CANCELLED'
    })
  })

  it('rejects damaged archive streams', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'damaged.gz')
    await fs.writeFile(archivePath, Buffer.from('not gzip data'))

    await expect(previewArchiveEntry(archivePath, 'entry-0')).rejects.toThrow()
  })

  it('cancels an in-flight expanded stream', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'cancel.txt.gz')
    await fs.writeFile(archivePath, zlib.gzipSync('cancel me'.repeat(200_000)))
    const controller = new AbortController()

    const preview = previewArchiveEntry(archivePath, 'entry-0', { signal: controller.signal })
    controller.abort()

    await expect(preview).rejects.toMatchObject({ code: 'PREVIEW_CANCELLED' })
  })
})

describe('7z preview', () => {
  it('previews an archive written by the pure JavaScript backend', async () => {
    const directory = await createTemporaryDirectory()
    const sourcePath = path.join(directory, 'plain.txt')
    const archivePath = path.join(directory, 'javascript.7z')
    await fs.writeFile(sourcePath, 'preview through the JavaScript reader')
    await compressArchive({ inputPaths: [sourcePath], outputPath: archivePath, format: '7z', level: 5 })

    const listing = await inspectArchive(archivePath)
    const preview = await previewArchiveEntry(archivePath, listing.entries[0].id)

    expect(preview).toMatchObject({ kind: 'text', text: 'preview through the JavaScript reader' })
  })

  it('previews a pure TypeScript split archive opened from a later volume', async () => {
    const directory = await createTemporaryDirectory()
    const sourcePath = path.join(directory, 'split.txt')
    const contents = 'preview across split volumes\n'.repeat(4_000)
    await fs.writeFile(sourcePath, contents)
    const written = await writeLibera7z({
      inputPaths: [sourcePath],
      outputPath: path.join(directory, 'split.7z'),
      level: 0,
      splitSize: 30_000
    })
    const archivePath = written.volumePaths!.at(-1)!

    const listing = await inspectArchive(archivePath)
    const preview = await previewArchiveEntry(archivePath, listing.entries[0].id)

    expect(preview).toMatchObject({ kind: 'text', text: contents, truncated: false })
  })

  it('returns an entry byte for byte, so 7-Zip chatter cannot contaminate it', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    // Newline heavy plus a stretch that must survive verbatim.
    const contents = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n')
    await fs.writeFile(path.join(sourceDir, 'a.txt'), contents)
    await fs.writeFile(path.join(sourceDir, 'b.txt'), 'second entry')
    const archivePath = path.join(directory, 'p.7z')
    await writeLibera7z({ inputPaths: [sourceDir], outputPath: archivePath, level: 1 })

    const listing = await inspectArchive(archivePath)
    const target = listing.entries.find(entry => entry.path.endsWith('a.txt'))!

    const preview = await previewArchiveEntry(archivePath, target.id)

    expect(preview.kind).toBe('text')
    expect((preview as { text: string }).text).toBe(contents)
  }, 60_000)

  it('resolves the same ids the inspector handed out', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await fs.writeFile(path.join(sourceDir, name), `contents of ${name}`)
    }
    const archivePath = path.join(directory, 'ids.7z')
    await writeLibera7z({ inputPaths: [sourceDir], outputPath: archivePath, level: 1 })

    const listing = await inspectArchive(archivePath)
    for (const entry of listing.entries.filter(one => !one.isDirectory)) {
      const preview = await previewArchiveEntry(archivePath, entry.id)
      expect((preview as { text: string }).text).toBe(`contents of ${path.basename(entry.path)}`)
    }
  }, 60_000)

  it('previews an image entry', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'pixel.png'), createPng(1, 1))
    const archivePath = path.join(directory, 'img.7z')
    await writeLibera7z({ inputPaths: [sourceDir], outputPath: archivePath, level: 1 })

    const listing = await inspectArchive(archivePath)
    const target = listing.entries.find(entry => entry.path.endsWith('pixel.png'))!

    const preview = await previewArchiveEntry(archivePath, target.id)

    expect(preview).toMatchObject({ kind: 'image', mediaType: 'image/png', width: 1, height: 1 })
  }, 60_000)

  it('previews an entry of an encrypted archive once given the password', async () => {
    const directory = await createTemporaryDirectory()
    const archivePath = path.join(directory, 'enc.7z')
    await fs.writeFile(archivePath, referenceSevenZipFixture('aes-header'))

    const listing = await inspectArchive(archivePath, { password: 'hunter2' })
    const target = listing.entries.find(entry => entry.path.endsWith('secret.txt'))!

    // Unlike ZIP, an encrypted 7z entry can be previewed rather than refused.
    const preview = await previewArchiveEntry(archivePath, target.id, { password: 'hunter2' })
    expect((preview as { text: string }).text).toBe('encrypted external archive\n'.repeat(1_000))

    await expect(previewArchiveEntry(archivePath, target.id))
      .rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' })
  }, 60_000)

  it('refuses a directory entry', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(path.join(sourceDir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'sub', 'a.txt'), 'alpha')
    const archivePath = path.join(directory, 'dir.7z')
    await writeLibera7z({ inputPaths: [sourceDir], outputPath: archivePath, level: 1 })

    const listing = await inspectArchive(archivePath)
    const folder = listing.entries.find(entry => entry.isDirectory)!

    await expect(previewArchiveEntry(archivePath, folder.id))
      .rejects.toMatchObject({ code: 'ENTRY_NOT_PREVIEWABLE' })
  }, 60_000)

  it('truncates an entry larger than the preview cap instead of loading it whole', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'big.txt'), 'x'.repeat(MAX_ARCHIVE_PREVIEW_BYTES + 4096))
    const archivePath = path.join(directory, 'big.7z')
    await writeLibera7z({ inputPaths: [sourceDir], outputPath: archivePath, level: 1 })

    const listing = await inspectArchive(archivePath)
    const target = listing.entries.find(entry => entry.path.endsWith('big.txt'))!

    const preview = await previewArchiveEntry(archivePath, target.id)

    expect(preview).toMatchObject({ kind: 'text', truncated: true })
    expect(preview.previewedBytes).toBeLessThanOrEqual(MAX_ARCHIVE_PREVIEW_BYTES)
  }, 60_000)
})

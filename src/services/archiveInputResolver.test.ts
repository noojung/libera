import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { resolveExtractionInput } from './archiveInputResolver'
import { compressArchive } from './compressor'
import { writeLibera7z } from './sevenZip/node'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-input-resolver-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('extraction input resolver', () => {
  it('resolves any split ZIP volume to one archive with every physical file', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'payload.bin')
    const outputPath = path.join(directory, 'archive.zip')
    await fs.writeFile(inputPath, crypto.randomBytes(4 * 1024 * 1024))
    const written = await compressArchive({
      inputPaths: [inputPath],
      outputPath,
      format: 'zip',
      level: 0,
      splitSize: 1024 * 1024
    })

    const selectedVolume = written.volumePaths![1]
    const resolved = await resolveExtractionInput(selectedVolume)

    expect(resolved.path).toBe(outputPath)
    expect(resolved.volumes?.map(volume => volume.path)).toEqual(written.volumePaths)
    expect(resolved.size).toBe(written.compressedSize)

    await fs.unlink(written.volumePaths!.at(-2)!)
    await expect(resolveExtractionInput(written.volumePaths![0]))
      .rejects.toMatchObject({ code: 'SPLIT_VOLUME_MISSING' })
  }, 30_000)

  it('resolves any split 7z volume to the first volume and the complete ordered set', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'payload.bin')
    const outputPath = path.join(directory, 'archive.7z')
    await fs.writeFile(inputPath, crypto.randomBytes(128 * 1024))
    const written = await writeLibera7z({
      inputPaths: [inputPath],
      outputPath,
      level: 0,
      splitSize: 30_000
    })

    const resolved = await resolveExtractionInput(written.volumePaths!.at(-1)!)
    const expectedSize = (await Promise.all(written.volumePaths!.map(volume => fs.stat(volume))))
      .reduce((sum, stat) => sum + stat.size, 0)

    expect(resolved.path).toBe(written.volumePaths![0])
    expect(resolved.volumes?.map(volume => volume.path)).toEqual(written.volumePaths)
    expect(resolved.size).toBe(expectedSize)

    const lastVolume = written.volumePaths!.at(-1)!
    const lastContents = await fs.readFile(lastVolume)
    await fs.truncate(lastVolume, Math.max(0, lastContents.length - 1))
    await expect(resolveExtractionInput(written.volumePaths![0]))
      .rejects.toMatchObject({ code: 'SPLIT_VOLUME_MISSING' })

    await fs.writeFile(lastVolume, lastContents)
    await fs.unlink(lastVolume)
    await expect(resolveExtractionInput(written.volumePaths![0]))
      .rejects.toMatchObject({ code: 'SPLIT_VOLUME_MISSING' })
  }, 30_000)

  it('does not mistake an unrelated numbered sibling for an ordinary ZIP volume', async () => {
    const directory = await createTemporaryDirectory()
    const inputPath = path.join(directory, 'payload.txt')
    const outputPath = path.join(directory, 'archive.zip')
    await fs.writeFile(inputPath, 'ordinary archive')
    await compressArchive({ inputPaths: [inputPath], outputPath, format: 'zip' })
    await fs.writeFile(path.join(directory, 'archive.z01'), 'not a ZIP volume')

    const resolved = await resolveExtractionInput(outputPath)

    expect(resolved.volumes).toBeUndefined()
    expect(resolved.size).toBe((await fs.stat(outputPath)).size)
  })
})

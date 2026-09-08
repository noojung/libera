import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { compressArchive } from '../compressor'
import { openLibera7zFile } from './node'

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-7z-overwrite-'))
  try {
    return await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const SPLIT_SIZE = 1024 * 1024

/**
 * Incompressible on purpose, so the run really does span several volumes and
 * takes long enough to be caught mid-write.
 */
async function writeInput(dir: string, bytes = 2 * 1024 * 1024): Promise<string> {
  const source = path.join(dir, 'source')
  await fs.mkdir(source, { recursive: true })
  const noise = Buffer.alloc(bytes)
  // Math.imul keeps the multiply in 32 bits; the plain operator overflows
  // what a double holds exactly and the sequence degenerates into a pattern.
  let state = 7
  for (let index = 0; index < bytes; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) | 0
    noise[index] = (state >>> 16) & 0xff
  }
  await fs.writeFile(path.join(source, 'big.bin'), noise)
  return source
}

/** Compresses, aborting as soon as the first byte is reported. */
async function compressAndCancel(source: string, outputPath: string, splitSize?: number): Promise<unknown> {
  const controller = new AbortController()
  return compressArchive(
    { inputPaths: [source], outputPath, format: '7z', splitSize } as never,
    progress => { if (progress.processedBytes > 0) controller.abort() },
    { signal: controller.signal }
  ).then(() => undefined, error => error)
}

const volumesIn = async (dir: string): Promise<string[]> =>
  (await fs.readdir(dir)).filter(name => /\.7z(\.\d{3})?$/.test(name)).sort()

// The save dialog asks about `archive.7z`, which a split run never writes. The
// volumes beside it were never a file the user agreed to lose, so a run that
// does not finish has to leave the set that was already there untouched. These
// go through `compressArchive` rather than the writer under it, since that is
// the path the app takes and the one the guarantee has to hold on.
describe('replacing a 7z archive', () => {
  it('leaves the previous split set alone when the write is cancelled', async () => {
    await withTempDir(async dir => {
      const source = await writeInput(dir)
      const outputPath = path.join(dir, 'backup.7z')
      await fs.writeFile(`${outputPath}.001`, 'previous backup')
      await fs.writeFile(`${outputPath}.002`, 'previous backup, continued')

      const error = await compressAndCancel(source, outputPath, SPLIT_SIZE)
      expect(error).toBeInstanceOf(Error)

      expect(await fs.readFile(`${outputPath}.001`, 'utf8')).toBe('previous backup')
      expect(await fs.readFile(`${outputPath}.002`, 'utf8')).toBe('previous backup, continued')
    })
  })

  it('leaves no half-written volume behind after a cancelled write', async () => {
    await withTempDir(async dir => {
      const source = await writeInput(dir)
      const outputPath = path.join(dir, 'fresh.7z')

      expect(await compressAndCancel(source, outputPath, SPLIT_SIZE)).toBeInstanceOf(Error)

      expect(await fs.readdir(dir)).toEqual(['source'])
    })
  })

  it('leaves the previous whole archive alone when a split write is cancelled', async () => {
    await withTempDir(async dir => {
      const source = await writeInput(dir)
      const outputPath = path.join(dir, 'backup.7z')
      await fs.writeFile(outputPath, 'previous whole archive')

      expect(await compressAndCancel(source, outputPath, SPLIT_SIZE)).toBeInstanceOf(Error)

      expect(await fs.readFile(outputPath, 'utf8')).toBe('previous whole archive')
    })
  })

  it('replaces the previous set once the new one is whole', async () => {
    await withTempDir(async dir => {
      const source = await writeInput(dir, 3 * 1024 * 1024)
      const outputPath = path.join(dir, 'backup.7z')
      await fs.writeFile(`${outputPath}.001`, 'previous backup')

      const result = await compressArchive({
        inputPaths: [source], outputPath, format: '7z', splitSize: SPLIT_SIZE
      } as never)

      expect(result.volumePaths!.length).toBeGreaterThan(1)
      expect(await fs.readFile(`${outputPath}.001`, 'utf8')).not.toBe('previous backup')
      expect((await fs.readdir(dir)).filter(name => name.endsWith('.partial'))).toEqual([])
    })
  })

  // A shorter run used to leave the tail of the longer one beside it, which
  // reads back as a set with a volume missing from the middle.
  it('sweeps volumes the previous, longer set left behind', async () => {
    await withTempDir(async dir => {
      const source = await writeInput(dir, 3 * 1024 * 1024)
      const outputPath = path.join(dir, 'backup.7z')
      for (let number = 1; number <= 12; number += 1) {
        await fs.writeFile(`${outputPath}.${String(number).padStart(3, '0')}`, 'stale')
      }

      const result = await compressArchive({
        inputPaths: [source], outputPath, format: '7z', splitSize: SPLIT_SIZE
      } as never)

      expect(await volumesIn(dir))
        .toEqual(result.volumePaths!.map(volumePath => path.basename(volumePath)).sort())
    })
  })

  it('clears an earlier split set when the new archive is whole', async () => {
    await withTempDir(async dir => {
      const source = await writeInput(dir, 2 * 1024 * 1024)
      const outputPath = path.join(dir, 'backup.7z')
      for (const number of ['001', '002', '003']) {
        await fs.writeFile(`${outputPath}.${number}`, 'stale')
      }

      await compressArchive({ inputPaths: [source], outputPath, format: '7z' } as never)

      // Only the whole archive is left; the two shapes must not sit together.
      expect(await volumesIn(dir)).toEqual(['backup.7z'])
    })
  })

  // The set being replaced now survives the walk that reads the inputs, so the
  // walk has to step over it the way it steps over the output path itself.
  it('keeps the set it is replacing out of the archive it writes', async () => {
    await withTempDir(async dir => {
      const source = path.join(dir, 'source')
      await fs.mkdir(source, { recursive: true })
      await fs.writeFile(path.join(source, 'kept.txt'), 'x'.repeat(64 * 1024))
      // The archive lands inside the folder being compressed, so the walk meets
      // the old volumes, and whatever a crashed run left half-written.
      const outputPath = path.join(source, 'backup.7z')
      await fs.writeFile(`${outputPath}.001`, 'previous backup')
      await fs.writeFile(`${outputPath}.002`, 'previous backup, continued')
      await fs.writeFile(`${outputPath}.003.partial`, 'abandoned by an earlier run')

      const result = await compressArchive({
        inputPaths: [source], outputPath, format: '7z', splitSize: SPLIT_SIZE
      } as never)

      const archive = await openLibera7zFile(result.outputPath)
      try {
        expect(archive.entries.map(entry => entry.path)).toEqual(['source', 'source/kept.txt'])
      } finally {
        await archive.close()
      }
    })
  })
})

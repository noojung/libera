import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { openLibera7zFile, writeLibera7z } from './node'

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-7z-overwrite-'))
  try {
    return await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Big enough that a small split size makes several volumes. */
async function writeInput(dir: string, bytes = 256 * 1024): Promise<string> {
  const input = path.join(dir, 'large.bin')
  await fs.writeFile(input, Buffer.alloc(bytes, 7))
  return input
}

describe('split 7z volume overwriting', () => {
  // The save dialog asks about `archive.7z`, which a split run never writes.
  // The volumes beside it were never a file the user agreed to lose, so they
  // have to survive a run that does not finish.
  it('leaves the previous set alone when the write is cancelled', async () => {
    await withTempDir(async dir => {
      const input = await writeInput(dir)
      const output = path.join(dir, 'backup.7z')
      await fs.writeFile(`${output}.001`, 'previous backup')
      await fs.writeFile(`${output}.002`, 'previous backup, continued')

      const controller = new AbortController()
      await expect(writeLibera7z({
        inputPaths: [input],
        outputPath: output,
        level: 0,
        splitSize: 30_000,
        signal: controller.signal,
        onProgress: bytes => { if (bytes > 0n) controller.abort() }
      })).rejects.toMatchObject({ code: 'CANCELLED' })

      expect(await fs.readFile(`${output}.001`, 'utf8')).toBe('previous backup')
      expect(await fs.readFile(`${output}.002`, 'utf8')).toBe('previous backup, continued')
    })
  })

  it('leaves no half-written volume behind after a cancelled write', async () => {
    await withTempDir(async dir => {
      const input = await writeInput(dir)
      const output = path.join(dir, 'fresh.7z')

      const controller = new AbortController()
      await expect(writeLibera7z({
        inputPaths: [input],
        outputPath: output,
        level: 0,
        splitSize: 30_000,
        signal: controller.signal,
        onProgress: bytes => { if (bytes > 0n) controller.abort() }
      })).rejects.toMatchObject({ code: 'CANCELLED' })

      expect(await fs.readdir(dir)).toEqual(['large.bin'])
    })
  })

  it('replaces the previous set once the new one is whole', async () => {
    await withTempDir(async dir => {
      const input = await writeInput(dir)
      const output = path.join(dir, 'backup.7z')
      await fs.writeFile(`${output}.001`, 'previous backup')

      const result = await writeLibera7z({
        inputPaths: [input],
        outputPath: output,
        level: 0,
        splitSize: 30_000
      })

      expect(result.volumePaths!.length).toBeGreaterThan(1)
      expect(result.outputPath).toBe(`${output}.001`)
      expect(await fs.readFile(`${output}.001`, 'utf8')).not.toBe('previous backup')
      // Nothing is left under the name the volumes were written through.
      const names = await fs.readdir(dir)
      expect(names.filter(name => name.endsWith('.partial'))).toEqual([])
    })
  })

  // A shorter run used to leave the tail of the longer one beside it, which
  // reads back as a set with a volume missing from the middle.
  it('sweeps volumes the previous, longer set left behind', async () => {
    await withTempDir(async dir => {
      const input = await writeInput(dir)
      const output = path.join(dir, 'backup.7z')
      for (const number of ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']) {
        await fs.writeFile(`${output}.${number}`, 'stale')
      }

      const result = await writeLibera7z({
        inputPaths: [input],
        outputPath: output,
        level: 9,
        splitSize: 1024 * 1024
      })

      const volumes = (await fs.readdir(dir)).filter(name => /\.7z\.\d{3}$/.test(name)).sort()
      expect(volumes).toEqual(result.volumePaths!.map(volumePath => path.basename(volumePath)).sort())
    })
  })

  // The set being replaced now survives the walk that reads the inputs, so the
  // walk has to step over it the way it steps over the output path itself.
  it('keeps the set it is replacing out of the archive it writes', async () => {
    await withTempDir(async dir => {
      const source = path.join(dir, 'source')
      await fs.mkdir(source)
      await fs.writeFile(path.join(source, 'kept.txt'), 'x'.repeat(64 * 1024))
      // The archive lands inside the folder being compressed, so the walk meets
      // the old volumes, and whatever a crashed run left half-written.
      const output = path.join(source, 'backup.7z')
      await fs.writeFile(`${output}.001`, 'previous backup')
      await fs.writeFile(`${output}.002`, 'previous backup, continued')
      await fs.writeFile(`${output}.003.partial`, 'abandoned by an earlier run')

      const result = await writeLibera7z({
        inputPaths: [source],
        outputPath: output,
        level: 0,
        splitSize: 30_000
      })

      const archive = await openLibera7zFile(result.outputPath)
      try {
        expect(archive.entries.map(entry => entry.path)).toEqual(['source', 'source/kept.txt'])
      } finally {
        await archive.close()
      }
    })
  })
})

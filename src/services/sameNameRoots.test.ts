import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { compressArchive, type ArchiveFormat } from './compressor'
import { inspectArchive } from './archiveInspector'

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-roots-'))
  try {
    return await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Two folders that share a name, each holding a file that names its parent. */
async function twoRootsCalledSrc(dir: string): Promise<string[]> {
  const roots: string[] = []
  for (const parent of ['work', 'hobby']) {
    const root = path.join(dir, parent, 'src')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, `${parent}.txt`), `from ${parent}`)
    roots.push(root)
  }
  return roots
}

const filePaths = async (archivePath: string): Promise<string[]> =>
  (await inspectArchive(archivePath)).entries
    .filter(entry => !entry.isDirectory)
    .map(entry => entry.path.replace(/\\/g, '/'))
    .sort()

// Picking two folders that happen to share a name is an ordinary thing to do -
// `~/work/src` and `~/hobby/src` - and the roots carry only their basename into
// the archive. ZIP had a rule for this and 7Z did not, so the same selection
// worked in one format and failed in the other with an internal message.
describe('input roots that share a name', () => {
  it.each<ArchiveFormat>(['zip', 'tar', '7z'])('keeps both roots in a %s archive', async format => {
    await withTempDir(async dir => {
      const roots = await twoRootsCalledSrc(dir)
      const outputPath = path.join(dir, `archive.${format}`)

      await compressArchive({ inputPaths: roots, outputPath, format } as never)

      // The second root is suffixed rather than folded onto the first, so both
      // files survive and neither is hidden behind the other.
      expect(await filePaths(outputPath)).toEqual(['src (2)/hobby.txt', 'src/work.txt'])
    })
  }, 60_000)

  it('numbers each further root in turn', async () => {
    await withTempDir(async dir => {
      const roots: string[] = []
      for (const parent of ['a', 'b', 'c']) {
        const root = path.join(dir, parent, 'src')
        await fs.mkdir(root, { recursive: true })
        await fs.writeFile(path.join(root, `${parent}.txt`), parent)
        roots.push(root)
      }
      const outputPath = path.join(dir, 'archive.7z')

      await compressArchive({ inputPaths: roots, outputPath, format: '7z' } as never)

      expect(await filePaths(outputPath))
        .toEqual(['src (2)/b.txt', 'src (3)/c.txt', 'src/a.txt'])
    })
  }, 60_000)

  it('leaves roots that already differ alone', async () => {
    await withTempDir(async dir => {
      const roots: string[] = []
      for (const name of ['alpha', 'beta']) {
        const root = path.join(dir, name)
        await fs.mkdir(root, { recursive: true })
        await fs.writeFile(path.join(root, 'file.txt'), name)
        roots.push(root)
      }
      const outputPath = path.join(dir, 'archive.7z')

      await compressArchive({ inputPaths: roots, outputPath, format: '7z' } as never)

      expect(await filePaths(outputPath)).toEqual(['alpha/file.txt', 'beta/file.txt'])
    })
  }, 60_000)
})

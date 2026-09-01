import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { listArchiveInputChildren } from './archiveInputTree'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('archive input tree', () => {
  it('lists folders first, reports file sizes, and does not follow symbolic links', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-input-tree-'))
    temporaryDirectories.push(directory)
    await fs.mkdir(path.join(directory, 'folder'))
    await fs.writeFile(path.join(directory, '10.txt'), 'ten')
    await fs.writeFile(path.join(directory, '2.txt'), 'two')
    if (process.platform !== 'win32') await fs.symlink(path.join(directory, 'folder'), path.join(directory, 'link'))

    await expect(listArchiveInputChildren(directory)).resolves.toEqual([
      { path: path.join(directory, 'folder'), name: 'folder', isDirectory: true, size: 0 },
      { path: path.join(directory, '2.txt'), name: '2.txt', isDirectory: false, size: 3 },
      { path: path.join(directory, '10.txt'), name: '10.txt', isDirectory: false, size: 3 }
    ])
  })
})

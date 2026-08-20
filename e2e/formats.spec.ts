import { promises as fs } from 'fs'
import path from 'path'
import { expect, seedFiles, stubDialogs, test } from './fixtures'

test('compresses a folder to TAR and extracts it back', async ({ app, page, workDir }) => {
  const source = path.join(workDir, 'source')
  await seedFiles(source, ['one.bin', 'two.bin'], 64 * 1024)
  const outputPath = path.join(workDir, 'out', 'archive.tar')

  await stubDialogs(app, { filePaths: [source] })
  await page.getByRole('button', { name: 'Browse folders' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.getByRole('button', { name: '.TAR', exact: true }).click()
  await page.locator('.compression-panel__destination-row .input-text').fill(outputPath)
  await page.locator('.compression-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect((await fs.stat(outputPath)).size).toBeGreaterThan(0)

  const extractDir = path.join(workDir, 'unpacked')
  await page.getByRole('button', { name: 'Extract' }).click()
  await stubDialogs(app, { filePaths: [outputPath] })
  await page.getByRole('button', { name: 'Browse files' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.locator('.extraction-panel__destination-row .input-text').fill(extractDir)
  await page.locator('.extraction-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(2, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect((await fs.stat(path.join(extractDir, 'archive', 'source', 'one.bin'))).size).toBe(64 * 1024)
})

test('rewrites a .tgz save path to .tar.gz and extracts it back', async ({ app, page, workDir }) => {
  const source = path.join(workDir, 'source')
  await seedFiles(source, ['one.bin'], 64 * 1024)
  // The save dialog hands back an alias extension, which only the renderer
  // rewrites to the canonical one before the job is queued.
  const chosenPath = path.join(workDir, 'out', 'archive.tgz')
  const outputPath = path.join(workDir, 'out', 'archive.tar.gz')

  await stubDialogs(app, { filePaths: [source], savePath: chosenPath })
  await page.getByRole('button', { name: 'Browse folders' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.getByRole('button', { name: '.TAR.GZ', exact: true }).click()
  await page.getByRole('button', { name: 'Browse', exact: true }).click()
  await expect(page.locator('.compression-panel__destination-row .input-text')).toHaveValue(outputPath)

  await page.locator('.compression-panel__start-button').click()
  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect((await fs.stat(outputPath)).size).toBeGreaterThan(0)
  await expect(fs.stat(chosenPath)).rejects.toThrow()

  const extractDir = path.join(workDir, 'unpacked')
  await page.getByRole('button', { name: 'Extract' }).click()
  await stubDialogs(app, { filePaths: [outputPath] })
  await page.getByRole('button', { name: 'Browse files' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.locator('.extraction-panel__destination-row .input-text').fill(extractDir)
  await page.locator('.extraction-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(2, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect((await fs.stat(path.join(extractDir, 'archive', 'source', 'one.bin'))).size).toBe(64 * 1024)
})

test('compresses a single file to GZ and extracts it back', async ({ app, page, workDir }) => {
  const contents = 'libera gz round trip'
  const sourcePath = path.join(workDir, 'notes.txt')
  await fs.writeFile(sourcePath, contents)
  const outputPath = path.join(workDir, 'out', 'notes.txt.gz')

  await stubDialogs(app, { filePaths: [sourcePath] })
  await page.getByRole('button', { name: 'Browse files' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.getByRole('button', { name: '.GZ', exact: true }).click()
  await page.locator('.compression-panel__destination-row .input-text').fill(outputPath)
  await page.locator('.compression-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect((await fs.stat(outputPath)).size).toBeGreaterThan(0)

  const extractDir = path.join(workDir, 'unpacked')
  await page.getByRole('button', { name: 'Extract' }).click()
  await stubDialogs(app, { filePaths: [outputPath] })
  await page.getByRole('button', { name: 'Browse files' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.locator('.extraction-panel__destination-row .input-text').fill(extractDir)
  await page.locator('.extraction-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(2, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect(await fs.readFile(path.join(extractDir, 'notes.txt', 'notes.txt'), 'utf8')).toBe(contents)
})

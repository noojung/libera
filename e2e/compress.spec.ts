import { promises as fs } from 'fs'
import path from 'path'
import { expect, seedFiles, stubDialogs, test } from './fixtures'

async function findFile(directory: string, name: string): Promise<string | null> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, name)
      if (nested) return nested
    } else if (entry.name === name) {
      return candidate
    }
  }
  return null
}

test('compresses a folder and reports completion', async ({ app, page, workDir }) => {
  const source = path.join(workDir, 'source')
  await seedFiles(source, ['one.bin', 'two.bin'], 256 * 1024)
  const outputPath = path.join(workDir, 'out', 'archive.zip')

  await stubDialogs(app, { filePaths: [source] })
  await page.getByRole('button', { name: 'Browse folders' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.locator('.compression-panel__destination-row .input-text').fill(outputPath)
  await page.locator('.compression-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect((await fs.stat(outputPath)).size).toBeGreaterThan(0)
})

test('writes the archive inside the folder being compressed without stalling', async ({
  app,
  page,
  workDir
}) => {
  await seedFiles(workDir, ['a-data.bin', 'ab-data.bin', 'ac-data.bin'], 2 * 1024 * 1024)

  await stubDialogs(app, { filePaths: [workDir] })
  await page.getByRole('button', { name: 'Browse folders' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.locator('.compression-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 60_000 })
  expect((await fs.stat(path.join(workDir, 'archive.zip'))).size).toBeGreaterThan(0)
})

test('extracts an archive it just produced', async ({ app, page, workDir }) => {
  const source = path.join(workDir, 'source')
  const contents = 'libera round trip'
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'note.txt'), contents)

  const archivePath = path.join(workDir, 'out', 'archive.zip')
  await stubDialogs(app, { filePaths: [source] })
  await page.getByRole('button', { name: 'Browse folders' }).click()
  await page.locator('.compression-panel__destination-row .input-text').fill(archivePath)
  await page.locator('.compression-panel__start-button').click()
  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 30_000 })

  const restoreDir = path.join(workDir, 'restored')
  await stubDialogs(app, { filePaths: [archivePath] })
  await page.locator('.titlebar__tab--extract').click()
  await page.getByRole('button', { name: 'Browse files' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.locator('.extraction-panel__destination-row .input-text').fill(restoreDir)
  await page.locator('.extraction-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)

  const restored = await findFile(restoreDir, 'note.txt')
  expect(restored).not.toBeNull()
  expect(await fs.readFile(restored as string, 'utf8')).toBe(contents)
})

test('compresses a folder to 7z and extracts it back', async ({ app, page, workDir }) => {
  const source = path.join(workDir, 'source')
  await seedFiles(source, ['one.bin', 'two.bin'], 128 * 1024)
  const outputPath = path.join(workDir, 'out', 'archive.7z')

  await stubDialogs(app, { filePaths: [source] })
  await page.getByRole('button', { name: 'Browse folders' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.getByRole('button', { name: '.7Z' }).click()
  await page.locator('.compression-panel__destination-row .input-text').fill(outputPath)
  await page.locator('.compression-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect((await fs.stat(outputPath)).size).toBeGreaterThan(0)

  // Now round trip it back out through the extract tab.
  await page.getByRole('button', { name: 'Extract' }).click()
  await stubDialogs(app, { filePaths: [outputPath] })
  await page.getByRole('button', { name: 'Browse files' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  const extractDir = path.join(workDir, 'unpacked')
  await page.locator('.extraction-panel__destination-row .input-text').fill(extractDir)
  await page.locator('.extraction-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(2, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect(await findFile(extractDir, 'one.bin')).not.toBeNull()
})

test('compresses a folder to an encrypted 7z with hidden names and extracts it back', async ({ app, page, workDir }) => {
  const source = path.join(workDir, 'source')
  await seedFiles(source, ['one.bin', 'two.bin'], 128 * 1024)
  const outputPath = path.join(workDir, 'out', 'secret.7z')

  // Hiding the file names is an expert option, so the app has to be in that
  // mode before the checkbox is on screen.
  await page.addInitScript(() => window.localStorage.setItem('libera_expert_mode', 'true'))
  await page.reload()

  await stubDialogs(app, { filePaths: [source] })
  await page.getByRole('button', { name: 'Browse folders' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.getByRole('button', { name: '.7Z' }).click()
  await page.getByPlaceholder('Enter password').fill('hunter2')
  await page.getByPlaceholder('Confirm password').fill('hunter2')
  await page.getByText('Hide the file names too').click()
  await page.locator('.compression-panel__destination-row .input-text').fill(outputPath)
  await page.locator('.compression-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect((await fs.stat(outputPath)).size).toBeGreaterThan(0)

  // The header is encrypted, so even listing the archive has to ask first.
  await page.getByRole('button', { name: 'Extract' }).click()
  await stubDialogs(app, { filePaths: [outputPath] })
  await page.getByRole('button', { name: 'Browse files' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  const extractDir = path.join(workDir, 'unpacked')
  await page.locator('.extraction-panel__destination-row .input-text').fill(extractDir)
  await page.locator('.extraction-panel__start-button').click()

  await expect(page.locator('.password-prompt')).toBeVisible({ timeout: 60_000 })
  await page.locator('.password-prompt input[type="password"]').fill('hunter2')
  await page.locator('.password-prompt__submit').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(2, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)
  expect(await findFile(extractDir, 'one.bin')).not.toBeNull()
})

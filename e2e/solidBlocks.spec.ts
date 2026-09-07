import { promises as fs } from 'fs'
import path from 'path'
import { expect, stubDialogs, test } from './fixtures'

// The preview counts what a write would lay down and the inspector counts what
// the archive turns out to hold. They are two readings of one number, so a
// stream holding a single file - never a block - must not reach either count.
test('previews as many solid blocks as the written archive reports', async ({ app, page, workDir }) => {
  const source = path.join(workDir, 'source')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'a.txt'), 'shared settings '.repeat(60))
  await fs.writeFile(path.join(source, 'b.txt'), 'shared settings '.repeat(60))
  await fs.writeFile(path.join(source, 'c.txt'), 'a larger file '.repeat(20000))
  await fs.writeFile(path.join(source, 'd.bin'), Buffer.alloc(4096, 7))
  await fs.writeFile(path.join(source, 'e.txt'), 'shared settings '.repeat(60))

  await page.addInitScript(() => window.localStorage.setItem('libera_expert_mode', 'true'))
  await page.reload()
  await page.locator('.titlebar').waitFor()

  await stubDialogs(app, { filePaths: [source] })
  await page.getByRole('button', { name: 'Browse folders' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.getByRole('button', { name: '.7Z' }).click()
  await page.getByRole('checkbox', { name: /Solid block compression/ }).check()
  await page.locator('.compression-panel__mode-toggle-track').click()
  await page.getByRole('button', { name: 'Per-file compression settings' }).click()

  // Dropping d.bin to Copy breaks the run into one real block and two streams
  // that hold a single file each.
  await page.getByRole('button', { name: 'Open source' }).click()
  await page.getByRole('combobox', { name: 'Compression method for d.bin' }).click()
  await page.getByRole('option', { name: 'Copy (No compression)' }).click()

  const preview = page.getByRole('button', { name: 'Solid block preview' })
  await expect(preview).toHaveText(/1 block · 2 standalone files/)
  await preview.click()
  await expect(page.locator('.zip-method-modal__block-name')).toHaveCount(1)
  await expect(page.locator('.zip-method-modal__blocks-standalone-list li')).toHaveCount(2)

  await page.getByRole('button', { name: 'Close per-file compression settings' }).click()
  const archivePath = path.join(workDir, 'out', 'blocks.7z')
  await page.locator('.compression-panel__destination-row .input-text').fill(archivePath)
  await page.locator('.compression-panel__start-button').click()
  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)

  await stubDialogs(app, { filePaths: [archivePath] })
  await page.locator('.titlebar__tab--inspect').click()
  await page.getByRole('button', { name: 'Open file...' }).click()
  await expect(page.locator('.archive-inspector__solid-panel-title').locator('..')).toContainText('1 block')
})

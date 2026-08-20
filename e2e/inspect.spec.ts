import { promises as fs } from 'fs'
import path from 'path'
import { expect, stubDialogs, test, writeZipArchive } from './fixtures'

const MANIFEST = 'Manifest-Version: 1.0\nMain-Class: com.example.App\n'

test('lists a JAR under its own format and previews an entry', async ({ app, page, workDir }) => {
  const archivePath = path.join(workDir, 'library.jar')
  await writeZipArchive(archivePath, {
    'META-INF/MANIFEST.MF': MANIFEST,
    'com/example/App.class': 'class bytes'
  })

  await stubDialogs(app, { filePaths: [archivePath] })
  await page.locator('.titlebar__tab--inspect').click()
  await page.getByRole('button', { name: 'Open file...' }).click()

  await expect(page.locator('.archive-inspector__stat-value--accent')).toHaveText('JAR')
  await expect(page.locator('.archive-inspector__entry')).toHaveCount(2)

  await page.locator('.archive-inspector__entry', { hasText: 'META-INF' }).click()
  await page.locator('.archive-inspector__breadcrumb.is-active').waitFor()
  await page.locator('.archive-inspector__entry', { hasText: 'MANIFEST.MF' }).click()

  await expect(page.locator('.archive-preview__content')).toHaveText(MANIFEST.trim())
  await expect(page.locator('.archive-preview__path')).toHaveText('META-INF/MANIFEST.MF')
})

test('lists a WAR under its own format', async ({ app, page, workDir }) => {
  const archivePath = path.join(workDir, 'webapp.war')
  await writeZipArchive(archivePath, {
    'WEB-INF/web.xml': '<web-app />',
    'index.html': '<!doctype html>'
  })

  await stubDialogs(app, { filePaths: [archivePath] })
  await page.locator('.titlebar__tab--inspect').click()
  await page.getByRole('button', { name: 'Open file...' }).click()

  await expect(page.locator('.archive-inspector__stat-value--accent')).toHaveText('WAR')
  await expect(page.locator('.archive-inspector__entry')).toHaveCount(2)
})

test('extracts a WAR into the chosen folder', async ({ app, page, workDir }) => {
  const archivePath = path.join(workDir, 'webapp.war')
  const targetDir = path.join(workDir, 'unpacked')
  await writeZipArchive(archivePath, {
    'WEB-INF/web.xml': '<web-app />',
    'index.html': '<!doctype html>'
  })

  await stubDialogs(app, { filePaths: [archivePath] })
  await page.locator('.titlebar__tab--extract').click()
  await page.getByRole('button', { name: 'Browse files' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)

  await page.locator('.extraction-panel__destination-row .input-text').fill(targetDir)
  await page.locator('.extraction-panel__start-button').click()

  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.queue-manager__job--error')).toHaveCount(0)

  const extractedRoot = path.join(targetDir, 'webapp')
  expect(await fs.readFile(path.join(extractedRoot, 'index.html'), 'utf8')).toBe('<!doctype html>')
  expect(await fs.readFile(path.join(extractedRoot, 'WEB-INF', 'web.xml'), 'utf8')).toBe('<web-app />')
})

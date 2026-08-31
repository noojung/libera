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

test('keeps the preview header whole when the window is narrow', async ({ app, page, workDir }) => {
  const archivePath = path.join(workDir, 'notes.zip')
  await writeZipArchive(archivePath, { 'notes.txt': 'first line\r\nsecond line\r\n' })

  // The view toggle and the copy button are expert controls, so the app has to
  // be in that mode before they are on screen.
  await page.addInitScript(() => window.localStorage.setItem('libera_expert_mode', 'true'))
  await page.reload()

  await stubDialogs(app, { filePaths: [archivePath] })
  await page.locator('.titlebar__tab--inspect').click()
  await page.getByRole('button', { name: 'Open file...' }).click()
  await page.locator('.archive-inspector__entry', { hasText: 'notes.txt' }).click()

  await expect(page.locator('.archive-preview__footer')).toContainText('CRLF')

  const size = async (selector: string) => {
    const box = await page.locator(selector).first().boundingBox()
    return { width: box?.width, height: box?.height }
  }

  // Narrow enough that the header has to give somewhere. It used to give in
  // the icons, which flex shrank into slivers - an svg goes before any text
  // wraps.
  for (const width of [720, 560, 460]) {
    await page.setViewportSize({ width, height: 640 })
    expect(await size('.archive-preview__toggle-btn svg')).toEqual({ width: 13, height: 13 })
    expect(await size('.archive-preview__copy-btn svg')).toEqual({ width: 14, height: 14 })
    expect(await size('.archive-preview__icon')).toEqual({ width: 40, height: 40 })
  }
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

test('previews a file inside an encrypted ZIP after asking for the password', async ({ app, page, workDir }) => {
  const source = path.join(workDir, 'source')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'secret.txt'), 'classified paragraph\n'.repeat(20))
  const archivePath = path.join(workDir, 'secret.zip')

  await stubDialogs(app, { filePaths: [source] })
  await page.getByRole('button', { name: 'Browse folders' }).click()
  await expect(page.locator('.drop-zone__item')).toHaveCount(1)
  await page.getByPlaceholder('Enter password').fill('hunter2')
  await page.getByPlaceholder('Confirm password').fill('hunter2')
  await page.locator('.compression-panel__destination-row .input-text').fill(archivePath)
  await page.locator('.compression-panel__start-button').click()
  await expect(page.locator('.queue-manager__job--completed')).toHaveCount(1, { timeout: 60_000 })

  // The listing needs no password; only the entry's content does.
  await page.getByRole('button', { name: 'Inspect' }).click()
  await stubDialogs(app, { filePaths: [archivePath] })
  await page.getByRole('button', { name: 'Open file...' }).click()
  // The archive wraps the folder that was compressed, so step into it first.
  await page.getByText('source', { exact: true }).click()
  await page.getByText('secret.txt').click()

  await expect(page.locator('.password-prompt')).toBeVisible({ timeout: 30_000 })
  await page.locator('.password-prompt input[type="password"]').fill('hunter2')
  await page.locator('.password-prompt__submit').click()

  await expect(page.locator('.archive-preview__content')).toContainText('classified paragraph', { timeout: 30_000 })
})

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { promises as fs } from 'fs'
import path from 'path'
import { expect, stubDialogs, test } from './fixtures'

// A 1x1 PNG, so a preview has to be drawn from a blob: URL.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

test('refuses nothing the app itself needs under its content security policy', async ({ app, page, workDir }) => {
  const archivePath = path.join(workDir, 'pixel.zip')
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  await writer.add('pixel.png', new Uint8ArrayReader(new Uint8Array(PIXEL)))
  await fs.writeFile(archivePath, await writer.close())

  // Listening from the first script on means a refusal during load counts too.
  await page.addInitScript(() => {
    const violations: string[] = []
    ;(window as unknown as { cspViolations: string[] }).cspViolations = violations
    document.addEventListener('securitypolicyviolation', event => {
      violations.push(`${event.effectiveDirective} ${event.blockedURI}`)
    })
  })
  await page.reload()
  await page.locator('.titlebar').waitFor()

  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1)

  for (const mode of ['extract', 'queue', 'compress']) {
    await page.locator(`.titlebar__tab--${mode}`).click()
  }
  await page.locator('.titlebar__info-button').click()
  await page.getByRole('button', { name: 'Open source licenses' }).click()
  // Closing the licenses goes back to the about dialog, which closes in turn.
  await page.keyboard.press('Escape')
  await page.locator('.about-modal').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.locator('.about-modal')).toHaveCount(0)

  await stubDialogs(app, { filePaths: [archivePath] })
  await page.locator('.titlebar__tab--inspect').click()
  await page.getByRole('button', { name: 'Browse files' }).click()
  await page.locator('.archive-inspector__entry', { hasText: 'pixel.png' }).click()
  await expect(page.locator('.archive-preview__image')).toHaveJSProperty('naturalWidth', 1)

  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([])
})

test('stays on the app when the page tries to go elsewhere', async ({ app, page, workDir }) => {
  const elsewhere = path.join(workDir, 'dropped.txt')
  await fs.writeFile(elsewhere, 'not the app')

  // Asked through the main process: Playwright keeps waiting on a navigation
  // that was refused, so the page itself cannot be asked afterwards.
  const run = <T>(script: string) => app.evaluate(
    ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source),
    script
  ) as Promise<T>
  const currentUrl = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())
  const appUrl = await currentUrl()

  for (const url of [`file://${elsewhere}`, 'https://example.com/']) {
    await page.evaluate(target => { window.location.href = target }, url)
    // A navigation that went through would replace the page; give it the time.
    await page.waitForTimeout(500)
    expect(await currentUrl()).toBe(appUrl)
    expect(await run<boolean>("document.querySelector('.titlebar') !== null")).toBe(true)
  }

  expect(await run<boolean>("window.open('https://example.com/') === null")).toBe(true)
  expect(app.windows()).toHaveLength(1)
})

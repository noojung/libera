import { expect, test } from './fixtures'

test('draws its typefaces from fonts bundled with the app', async ({ page }) => {
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await page.reload()
  await page.locator('.titlebar').waitFor()

  // Korean text pulls in the Korean slices as well as the Latin ones.
  await page.evaluate(() => document.fonts.load('16px "Gowun Dodum"', '압축 Archive'))
  await page.evaluate(() => document.fonts.load('16px "Gaegu"', '압축 Archive'))
  await page.evaluate(() => document.fonts.ready)
  const loaded = await page.evaluate(() =>
    [...new Set([...document.fonts].filter(font => font.status === 'loaded').map(font => font.family))].sort()
  )
  expect(loaded).toEqual(['Gaegu', 'Gowun Dodum', 'JetBrains Mono'])

  expect(requests.some(url => url.startsWith('file:') && url.endsWith('.woff2'))).toBe(true)
  expect(requests.filter(url => !url.startsWith('file:'))).toEqual([])
})

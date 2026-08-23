import { expect, test } from './fixtures'

const themeOf = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'))

const storedPreference = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.localStorage.getItem('libera_theme'))

test('follows the system appearance until the user picks a theme', async ({ page }) => {
  // A fresh profile has no stored theme, so the preference is "system" and the
  // appearance comes from the OS rather than a baked-in default.
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => themeOf(page)).toBe('light')
  expect(await storedPreference(page)).toBe('system')

  // Still "system": the app tracks the OS instead of latching one value.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => themeOf(page)).toBe('dark')
  expect(await storedPreference(page)).toBe('system')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => themeOf(page)).toBe('light')
  expect(await storedPreference(page)).toBe('system')
})

test('keeps an explicit choice even when the system disagrees', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => themeOf(page)).toBe('light')

  // The title bar control cycles system -> light -> dark.
  const toggle = page.locator('.titlebar__theme-button')
  await toggle.click()
  await expect.poll(() => storedPreference(page)).toBe('light')
  await toggle.click()
  await expect.poll(() => storedPreference(page)).toBe('dark')
  await expect.poll(() => themeOf(page)).toBe('dark')

  // A system flip must not override what the user asked for.
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForTimeout(200)
  expect(await themeOf(page)).toBe('dark')
})

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  expect: {
    timeout: 15_000
  }
})

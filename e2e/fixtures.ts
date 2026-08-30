import { test as base, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

const repoRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(repoRoot, 'dist', 'main', 'main.js')

export interface DialogStub {
  filePaths?: string[]
  savePath?: string
}

export async function stubDialogs(app: ElectronApplication, stub: DialogStub): Promise<void> {
  await app.evaluate(({ dialog }, options) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: options.filePaths ?? []
    })) as typeof dialog.showOpenDialog
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: options.savePath ?? ''
    })) as typeof dialog.showSaveDialog
  }, stub)
}

export async function seedFiles(directory: string, names: string[], bytes: number): Promise<void> {
  await fs.mkdir(directory, { recursive: true })
  for (const name of names) {
    await fs.writeFile(path.join(directory, name), crypto.randomBytes(bytes))
  }
}

export async function writeZipArchive(
  archivePath: string,
  entries: Record<string, string>
): Promise<void> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(name, new TextReader(contents))
  }
  await fs.mkdir(path.dirname(archivePath), { recursive: true })
  await fs.writeFile(archivePath, await writer.close())
}

interface Fixtures {
  app: ElectronApplication
  page: Page
  workDir: string
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  workDir: async ({}, use) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-e2e-'))
    await use(directory)
    await fs.rm(directory, { recursive: true, force: true })
  },

  app: async ({ workDir }, use) => {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'VITE_DEV_SERVER_URL') env[key] = value
    }

    // Without its own profile the run inherits the developer's installed app -
    // its theme, language and window state - so a preference set by hand at
    // some point silently decides what the tests see. Keep the profile outside
    // workDir because some tests compress that entire directory; on Windows,
    // Electron's live profile contains locked files that cannot be archived.
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-e2e-profile-'))
    let app: ElectronApplication | undefined

    try {
      app = await _electron.launch({
        args: [mainEntry, `--user-data-dir=${userDataDir}`],
        cwd: repoRoot,
        env
      })

      await app.evaluate(({ app: electronApp }, directory) => {
        electronApp.setPath('downloads', directory)
      }, workDir)

      await use(app)
    } finally {
      try {
        await app?.close()
      } finally {
        await fs.rm(userDataDir, { recursive: true, force: true })
      }
    }
  },

  page: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.addInitScript(() => window.localStorage.setItem('libera.language', 'en'))
    await page.reload()
    await page.locator('.titlebar').waitFor()
    await use(page)
  }
})

export { expect } from '@playwright/test'

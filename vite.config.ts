import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron, { type ElectronOptions } from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import tsconfigPaths from 'vite-tsconfig-paths'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

// libera7z ships its worker as a self-contained bundle. The packaged app only
// carries dist/, so the file is copied beside main, where workerSetup.ts looks
// for it. The .mjs suffix keeps Node reading it as the ES module it is.
function copyLibera7zWorker(): Plugin {
  return {
    name: 'copy-libera7z-worker',
    closeBundle() {
      const source = createRequire(import.meta.url).resolve('libera7z/worker')
      const target = path.resolve(__dirname, 'dist/worker/libera7zWorker.mjs')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
    }
  }
}

type ElectronStartup = Parameters<NonNullable<ElectronOptions['onstart']>>[0]['startup']

// vite-plugin-electron spawns Electron with the cwd set to Vite's `root`,
// which here is src/renderer - a directory with no package.json, so Electron
// comes up with nothing loaded. The app is started from the project root.
function launchElectron(startup: ElectronStartup): Promise<boolean> {
  return startup(['.', '--no-sandbox'], { cwd: __dirname })
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      // The preload script is built first because vite-plugin-electron only
      // starts Electron once every entry's first build has finished, and it
      // does so through the last entry to complete.
      {
        entry: path.resolve(__dirname, 'src/preload/preload.ts'),
        onstart({ startup, reload }) {
          // Reload the renderer once the preload build lands - unless Electron
          // is not up yet, in which case it has to be launched instead.
          if (process.electronApp) reload()
          else launchElectron(startup)
        },
        vite: {
          build: {
            outDir: path.resolve(__dirname, 'dist/preload'),
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      },
      {
        // Main-process entrypoint of the Electron App.
        entry: path.resolve(__dirname, 'src/main/main.ts'),
        onstart({ startup }) {
          launchElectron(startup)
        },
        vite: {
          plugins: [copyLibera7zWorker()],
          build: {
            outDir: path.resolve(__dirname, 'dist/main'),
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      },
    ]),
    renderer(),
    // `root` below points at src/renderer, so the plugin is told where the
    // tsconfig that owns the path aliases actually lives.
    tsconfigPaths({ root: __dirname })
  ],
  root: 'src/renderer',
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true
  }
})

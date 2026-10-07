import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron, { type ElectronOptions } from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
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

// Keep the replaceable WASM runtime alongside its worker, outside the JS bundle.
function copyDmgWorker(): Plugin {
  return {
    name: 'copy-dmg-worker',
    closeBundle() {
      const engineRoot = path.dirname(createRequire(import.meta.url).resolve('7z-wasm'))
      const target = path.resolve(__dirname, 'dist/worker/dmg')
      fs.mkdirSync(target, { recursive: true })
      fs.copyFileSync(path.resolve(__dirname, 'src/services/dmg/worker.cjs'), path.join(target, 'worker.cjs'))
      for (const [source, destination] of [['7zz.umd.js', '7zz.cjs'], ['7zz.wasm', '7zz.wasm'], ['License.txt', 'License.txt'], ['unRarLicense.txt', 'unRarLicense.txt'], ['README.md', 'README.md']]) {
        fs.copyFileSync(path.join(engineRoot, source), path.join(target, destination))
      }
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
          plugins: [copyLibera7zWorker(), copyDmgWorker()],
          build: {
            outDir: path.resolve(__dirname, 'dist/main'),
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      },
    ]),
    renderer()
  ],
  // Vite resolves each import through the tsconfig nearest the importing file,
  // so the path aliases apply even though `root` below is src/renderer.
  resolve: {
    tsconfigPaths: true
  },
  root: 'src/renderer',
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true
  }
})

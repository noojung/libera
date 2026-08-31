import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
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

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        // Main-process entrypoint of the Electron App.
        entry: path.resolve(__dirname, 'src/main/main.ts'),
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
      {
        entry: path.resolve(__dirname, 'src/preload/preload.ts'),
        onstart(options) {
          // Notify the Renderer-Process to reload the page when the Preload-Scripts build is complete
          options.reload()
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

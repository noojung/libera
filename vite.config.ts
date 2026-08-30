import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import tsconfigPaths from 'vite-tsconfig-paths'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        // Main-process entrypoint of the Electron App.
        entry: path.resolve(__dirname, 'src/main/main.ts'),
        vite: {
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
      {
        entry: path.resolve(__dirname, 'src/services/libera7zWorkerCodec.ts'),
        vite: {
          build: {
            outDir: path.resolve(__dirname, 'dist/worker'),
            emptyOutDir: true,
            rollupOptions: {
              external: ['worker_threads']
            }
          }
        }
      }
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

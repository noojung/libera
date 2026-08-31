import { defineConfig } from 'vite'
import path from 'path'

// The worker is loaded by path, so it is built on its own and bundled whole:
// a shared chunk would not resolve once a consumer copies the file.
export default defineConfig({
  build: {
    target: 'esnext',
    minify: false,
    sourcemap: true,
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, 'src/worker/entry.ts'),
      formats: ['es'],
      fileName: () => 'worker.js'
    }
  }
})

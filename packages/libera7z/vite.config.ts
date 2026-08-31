import { defineConfig } from 'vite'
import path from 'path'

// The library has no dependencies and no Node built-ins, so everything it
// needs is bundled and the output stays usable in a browser or in Node.
export default defineConfig({
  build: {
    target: 'esnext',
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        index: path.resolve(__dirname, 'src/index.ts'),
        testing: path.resolve(__dirname, 'src/testing.ts')
      },
      formats: ['es']
    }
  }
})

import { defineConfig } from 'vite'
import path from 'path'

// The library has no dependencies and no Node built-ins, so everything it
// needs is bundled and the output stays usable in a browser or in Node.
export default defineConfig({
  build: {
    target: 'esnext',
    // Only the Node adapter touches a built-in, and it must stay external so
    // the browser entries keep their zero-dependency bundles.
    rollupOptions: { external: ['worker_threads'] },
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        index: path.resolve(__dirname, 'src/index.ts'),
        'index.node': path.resolve(__dirname, 'src/index.node.ts'),
        node: path.resolve(__dirname, 'src/node.ts'),
        testing: path.resolve(__dirname, 'src/testing.ts')
      },
      formats: ['es']
    }
  }
})

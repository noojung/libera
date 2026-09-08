import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  test: {
    // Projects do not inherit the root config's plugins, so the alias
    // resolver has to be declared in each one.
    projects: [
      {
        plugins: [tsconfigPaths()],
        test: {
          name: 'node',
          environment: 'node',
          // These drive the real writers and readers, so a case compresses and
          // extracts megabytes through the same TypeScript codecs the library
          // tests warn about below. Several sit a second or two from the
          // default 5s here and well past it on the slowest CI runner.
          testTimeout: 30_000,
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']
        }
      },
      {
        // The library is its own package, so its tests run against its source
        // rather than the bundle the app imports.
        test: {
          name: 'libera7z',
          environment: 'node',
          // The codecs are pure TypeScript, so a single case can spend seconds
          // coding a hundred kilobytes; the default 5s cuts them off on the
          // slowest CI runner.
          testTimeout: 30_000,
          include: ['packages/libera7z/src/**/*.test.ts']
        }
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          setupFiles: ['src/renderer/src/test/setup.ts'],
          include: ['src/renderer/src/**/*.test.tsx']
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // The whole app, not just the window: the services decide what is written
      // to and read from a user's files, and the codecs under them are where a
      // gap costs the most, so measuring only the renderer reported on the
      // least of it.
      include: ['src/**/*.{ts,tsx}', 'packages/libera7z/src/**/*.ts'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        // Test-only: the renderer's harness, the worker the library's own
        // tests drive it through, and the reference archives it checks itself
        // against.
        'src/renderer/src/test/**',
        'packages/libera7z/src/testing.ts',
        'packages/libera7z/src/worker/testWorker.ts',
        'packages/libera7z/src/**/*.testData.ts',
        // Entry points, which hold wiring rather than behaviour.
        'src/renderer/src/main.tsx',
        'packages/libera7z/src/index.ts',
        'packages/libera7z/src/index.node.ts'
      ]
    }
  }
})

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
      include: ['src/renderer/src/**/*.{ts,tsx}'],
      exclude: [
        'src/renderer/src/**/*.test.{ts,tsx}',
        'src/renderer/src/test/**',
        'src/renderer/src/main.tsx',
        'src/renderer/src/vite-env.d.ts'
      ]
    }
  }
})

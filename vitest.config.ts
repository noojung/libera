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

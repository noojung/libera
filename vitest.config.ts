import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts']
        }
      },
      {
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

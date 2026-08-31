import { expect, test } from '@playwright/test'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { createServer, type Server } from 'http'
import path from 'path'

// The rest of the suite drives the Electron app, which covers libera7z's Node
// path. This one covers the browser path: a real browser loading the package's
// built browser entry and the worker bundle it ships, straight off a static
// server so no bundler stands between the test and what npm would deliver.

const packageRoot = path.resolve(__dirname, '..', 'packages', 'libera7z')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

function startStaticServer(root: string): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0])
    const target = path.join(root, requested.endsWith('/') ? `${requested}index.html` : requested)
    // Anything outside the package is not ours to serve.
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end()
      return
    }
    void stat(target).then(
      stats => {
        if (!stats.isFile()) {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream' })
        createReadStream(target).pipe(response)
      },
      () => response.writeHead(404).end()
    )
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ origin: `http://127.0.0.1:${port}`, server })
    })
  })
}

test('the built browser entry and the worker it ships pass every check', async ({ page }) => {
  const { origin, server } = await startStaticServer(packageRoot)
  const consoleErrors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', error => consoleErrors.push(String(error)))

  try {
    await page.goto(`${origin}/browser-check/`)
    await page.waitForFunction(
      () => (window as unknown as { __results?: CheckResult[] }).__results !== undefined,
      undefined,
      { timeout: 90_000 }
    )
    const results = await page.evaluate(
      () => (window as unknown as { __results: CheckResult[] }).__results
    )

    expect(results.filter(result => !result.ok)).toEqual([])
    expect(consoleErrors).toEqual([])
    // Guards the checks themselves: a page that silently stopped running them
    // would otherwise report no failures.
    expect(results.map(result => result.name)).toContain('the shipped worker starts from workerScript alone')
    expect(results.length).toBeGreaterThanOrEqual(6)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

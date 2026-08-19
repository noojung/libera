import { describe, expect, it } from 'vitest'
import fs from 'fs'
import { generate, outputPath } from './generateThirdPartyLicenses.cjs'

// Regenerates the license list and checks it against what is committed, the
// same shape as the app's other parity tests: this is the guard against an
// About screen that silently goes stale as dependencies change.
describe('generateThirdPartyLicenses', () => {
  it('produces one entry per runtime dependency plus the bundled 7-Zip notice', () => {
    const entries = generate()
    const names = entries.map(entry => entry.name)

    expect(names).toContain('7-Zip')
    expect(names).not.toContain('7zip-bin')
    expect(new Set(names).size).toBe(names.length)
    for (const entry of entries) {
      expect(entry.version).toBeTruthy()
      expect(entry.license).toBeTruthy()
      expect(entry.text.length).toBeGreaterThan(0)
    }
  })

  it('includes the full LGPL text for the bundled 7-Zip binary', () => {
    const entries = generate()
    const sevenZip = entries.find(entry => entry.name === '7-Zip')

    expect(sevenZip).toBeDefined()
    expect(sevenZip?.license).toBe('LGPL-2.1-or-later')
    expect(sevenZip?.text).toMatch(/GNU LESSER GENERAL PUBLIC LICENSE/)
  })

  it('matches the file the app actually ships, so a dependency bump cannot go unnoticed', () => {
    const committed = fs.readFileSync(outputPath, 'utf8')
    const fresh = `${JSON.stringify(generate(), null, 2)}\n`

    expect(committed).toBe(fresh)
  })
})

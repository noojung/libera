import { describe, expect, it } from 'vitest'
import fs from 'fs'
import { generate, outputPath } from './generateThirdPartyLicenses.cjs'

// Regenerates the license list and checks it against what is committed, the
// same shape as the app's other parity tests: this is the guard against an
// About screen that silently goes stale as dependencies change.
describe('generateThirdPartyLicenses', () => {
  it('produces one entry per runtime dependency', () => {
    const entries = generate()
    const names = entries.map(entry => entry.name)
    const dependencyNames = Object.keys(JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies)

    expect(names.sort()).toEqual(dependencyNames.sort())
    expect(new Set(names).size).toBe(names.length)
    for (const entry of entries) {
      expect(entry.version).toBeTruthy()
      expect(entry.license).toBeTruthy()
      expect(entry.text.length).toBeGreaterThan(0)
    }
  })

  it('matches the file the app actually ships, so a dependency bump cannot go unnoticed', () => {
    const committed = fs.readFileSync(outputPath, 'utf8')
    const fresh = `${JSON.stringify(generate(), null, 2)}\n`

    expect(committed).toBe(fresh)
  })
})

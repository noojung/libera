import { describe, expect, it } from 'vitest'
import fs from 'fs'
import { generate, outputPath } from './generateThirdPartyLicenses.cjs'

// Regenerates the license list and checks it against what is committed, the
// same shape as the app's other parity tests: this is the guard against an
// About screen that silently goes stale as dependencies change.
function workspacePackageNames(patterns: string[]): string[] {
  return patterns.flatMap(pattern => {
    const directory = pattern.replace(/\/\*$/, '')
    return fs.readdirSync(directory)
      .map(name => JSON.parse(fs.readFileSync(`${directory}/${name}/package.json`, 'utf8')).name as string)
  })
}

describe('generateThirdPartyLicenses', () => {
  it('produces one entry per third-party runtime dependency', () => {
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const entries = generate()
    const names = entries.map(entry => entry.name)
    // Workspace packages are this repo's own code, covered by the app's licence.
    const workspaceNames = workspacePackageNames(manifest.workspaces ?? [])
    const dependencyNames = Object.keys(manifest.dependencies)
      .filter(name => !workspaceNames.includes(name))

    expect(workspaceNames).toContain('libera7z')
    expect(names).not.toContain('libera7z')
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

import { describe, expect, it } from 'vitest'
import fs from 'fs'
const { generate, outputPath } = require('./generateAppInfo.cjs')

describe('generateAppInfo', () => {
  it('reads version and links from package.json and copyright from LICENSE', () => {
    const info = generate()

    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(info.homepage).toMatch(/^https:\/\//)
    // package.json's repository.url is a git remote; the generator has to
    // turn it into a page a click can actually open.
    expect(info.repositoryUrl).toMatch(/^https:\/\//)
    expect(info.repositoryUrl).not.toMatch(/\.git$/)
    expect(info.copyrightYear).toMatch(/^\d{4}$/)
    expect(info.copyrightHolder).toBeTruthy()
  })

  it('matches the file the app actually ships, so a version bump cannot go unnoticed', () => {
    const committed = fs.readFileSync(outputPath, 'utf8')
    const fresh = `${JSON.stringify(generate(), null, 2)}\n`

    expect(committed).toBe(fresh)
  })
})

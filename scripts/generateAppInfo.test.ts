import { describe, expect, it } from 'vitest'
import fs from 'fs'
import { generate, outputPath } from './generateAppInfo.cjs'

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

  it('keeps the packaged copyright in step with LICENSE', () => {
    const info = generate()
    // electron-builder writes build.copyright into the bundle metadata, while
    // the About panel and the about dialog read the generated file, so the two
    // have to agree on one line.
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))

    expect(packageJson.build.copyright).toBe(`© ${info.copyrightYear} ${info.copyrightHolder}`)
  })

  it('matches the file the app actually ships, so a version bump cannot go unnoticed', () => {
    const committed = fs.readFileSync(outputPath, 'utf8')
    const fresh = `${JSON.stringify(generate(), null, 2)}\n`

    expect(committed).toBe(fresh)
  })
})

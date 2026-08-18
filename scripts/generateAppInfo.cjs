// Builds the small metadata block the licenses screen's "about" strip reads
// (version, homepage, source link, copyright). Run automatically before
// dev/build/test alongside generateThirdPartyLicenses.cjs, for the same
// reason: it must never silently drift from package.json / LICENSE.
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const outputPath = path.join(repoRoot, 'src', 'renderer', 'src', 'generated', 'appInfo.json')

function parseCopyright() {
  const licenseText = fs.readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8')
  const match = /Copyright \(c\) (\d{4}) (.+)/.exec(licenseText)
  if (!match) throw new Error('Could not find a "Copyright (c) YYYY Name" line in LICENSE')
  return { year: match[1], holder: match[2].trim() }
}

function repositoryUrl(repository) {
  // package.json's "repository.url" is a git remote (git+https://... .git),
  // not a browsable page, so it is normalized into one.
  const raw = typeof repository === 'string' ? repository : repository.url
  return raw.replace(/^git\+/, '').replace(/\.git$/, '')
}

function generate() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const copyright = parseCopyright()

  const info = {
    version: packageJson.version,
    homepage: packageJson.homepage,
    repositoryUrl: repositoryUrl(packageJson.repository),
    copyrightYear: copyright.year,
    copyrightHolder: copyright.holder
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(info, null, 2)}\n`)
  return info
}

if (require.main === module) {
  const info = generate()
  console.log(`Wrote app info to ${path.relative(repoRoot, outputPath)}: v${info.version}`)
}

module.exports = { generate, outputPath }

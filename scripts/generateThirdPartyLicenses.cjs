// Builds the third-party license list the app's About screen reads. Run
// automatically before dev/build/test (see package.json) so it can never drift
// from package.json; CI regenerates it and fails on any diff, so the generated
// file has to be committed alongside the dependency change that moves it.
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const outputPath = path.join(repoRoot, 'src', 'renderer', 'src', 'generated', 'thirdPartyLicenses.json')

// 7zip-bin only carries the binaries; the binaries themselves are licensed
// separately (see below), so listing the npm package too would just repeat
// the same notice under a different name.
const EXCLUDED_PACKAGES = new Set(['7zip-bin'])

function readLicenseFile(packageDir) {
  const entries = fs.readdirSync(packageDir)
  const licenseFile = entries.find(name => /^licen[cs]e/i.test(name))
  if (!licenseFile) return null
  return fs.readFileSync(path.join(packageDir, licenseFile), 'utf8').trim()
}

function collectNpmDependencies() {
  const rootPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const dependencyNames = Object.keys(rootPackageJson.dependencies || {}).filter(name => !EXCLUDED_PACKAGES.has(name))

  return dependencyNames.map(name => {
    const packageDir = path.join(repoRoot, 'node_modules', name)
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    const text = readLicenseFile(packageDir)
    if (!text) throw new Error(`No LICENSE file found for dependency: ${name}`)

    return {
      name,
      version: packageJson.version,
      license: packageJson.license || 'unknown',
      text
    }
  })
}

/**
 * 7-Zip is not an npm package - it is a standalone executable bundled as an
 * extraResource - so its entry is assembled from the notice already shipped
 * with the app rather than discovered from node_modules.
 */
function collectSevenZipEntry() {
  const noticePath = path.join(repoRoot, 'resources', 'licenses', '7-Zip-LICENSE.txt')
  const text = fs.readFileSync(noticePath, 'utf8').trim()
  const bundledVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).dependencies['7zip-bin']

  return {
    name: '7-Zip',
    version: bundledVersion,
    license: 'LGPL-2.1-or-later',
    text
  }
}

function generate() {
  const entries = [...collectNpmDependencies(), collectSevenZipEntry()]
    .sort((a, b) => a.name.localeCompare(b.name))

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(entries, null, 2)}\n`)
  return entries
}

if (require.main === module) {
  const entries = generate()
  console.log(`Wrote ${entries.length} third-party license entries to ${path.relative(repoRoot, outputPath)}`)
}

module.exports = { generate, outputPath }

// Builds the third-party license list the app's About screen reads. Run
// automatically before dev/build/test (see package.json) so it can never drift
// from package.json; CI regenerates it and fails on any diff, so the generated
// file has to be committed alongside the dependency change that moves it.
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const outputPath = path.join(repoRoot, 'src', 'renderer', 'src', 'generated', 'thirdPartyLicenses.json')

function readLicenseFile(packageDir) {
  const entries = fs.readdirSync(packageDir)
  const licenseFile = entries.find(name => /^licen[cs]e/i.test(name))
  if (!licenseFile) return null
  return fs.readFileSync(path.join(packageDir, licenseFile), 'utf8').trim()
}

function collectNpmDependencies() {
  const rootPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const dependencyNames = Object.keys(rootPackageJson.dependencies || {})

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

function generate() {
  const entries = collectNpmDependencies()
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

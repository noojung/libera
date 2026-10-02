#!/usr/bin/env node
// Writes Resources/licenses.json: every crate linked into libera-core's static
// library, with its license text, for the app's Licenses dialog. The fonts and
// icons bundled with the UI carry their own notices beside them.
//
// The list comes from `cargo tree` rather than `cargo metadata`, which unifies
// features across the workspace and so would also name the bindings generator
// and the proc-macros that run only while compiling.
//
// Run from anywhere: node apps/macos/scripts/generate-licenses.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const output = path.join(root, 'apps/macos/Sources/LiberaUI/Resources/licenses.json')
const cargo = (...args) => execFileSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const shipped = new Set()
for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
  const tree = cargo('tree', '-p', 'libera-ffi', '-e', 'normal,no-proc-macro', '--target', target, '--prefix', 'none', '--format', '{p}')
  for (const line of tree.split('\n')) {
    const [name, version] = line.replace(/ \(\*\)$/, '').split(' ')
    // This repo's own crates are covered by the app's license.
    if (name && !name.startsWith('libera-')) shipped.add(`${name} ${version.replace(/^v/, '')}`)
  }
}

const metadata = JSON.parse(cargo('metadata', '--format-version', '1'))
const NOTICE = /^(licen[cs]e|copying|notice|unlicense)/i
// Standard texts, by SPDX id, for a crate that ships no license file of its own.
const standardTexts = path.join(root, 'apps/macos/scripts/licenses')

/** The crate's license files, or the ones a vendored C library keeps a level down. */
function licenseFiles(directory) {
  const own = fs.readdirSync(directory).filter(name => NOTICE.test(name)).map(name => path.join(directory, name))
  if (own.length > 0) return own
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => fs.readdirSync(path.join(directory, entry.name))
      .filter(name => NOTICE.test(name))
      .map(name => path.join(directory, entry.name, name)))
}

// Each license file is kept once - most crates carry the same Apache text -
// and a package lists the files it ships by name and index.
const texts = []
const textIndex = text => {
  const index = texts.indexOf(text)
  return index >= 0 ? index : texts.push(text) - 1
}

const packages = metadata.packages
  .filter(pkg => shipped.has(`${pkg.name} ${pkg.version}`))
  .map(pkg => {
    const directory = path.dirname(pkg.manifest_path)
    const found = licenseFiles(directory).filter(file => fs.statSync(file).isFile()).sort()
    const standard = path.join(standardTexts, `${pkg.license}.txt`)
    let files
    if (found.length > 0) {
      files = found.map(file => [path.relative(directory, file), textIndex(fs.readFileSync(file, 'utf8').trim())])
    } else if (fs.existsSync(standard)) {
      // The crate ships no file of its own, so the standard text stands in.
      files = [[`${pkg.license}.txt`, textIndex(fs.readFileSync(standard, 'utf8').trim())]]
    } else {
      throw new Error(`No license text for ${pkg.name}; add its standard text to ${path.relative(root, standardTexts)}`)
    }
    return { name: pkg.name, version: pkg.version, license: pkg.license ?? pkg.license_file ?? 'unknown', files }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

const missing = [...shipped].filter(id => !packages.some(entry => `${entry.name} ${entry.version}` === id))
if (missing.length > 0) throw new Error(`No metadata for ${missing.join(', ')}`)

fs.writeFileSync(output, `${JSON.stringify({ texts, packages })}\n`)
console.log(`Wrote ${packages.length} crate licenses (${texts.length} distinct files) to ${path.relative(root, output)}`)

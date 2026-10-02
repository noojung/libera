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

const entries = metadata.packages
  .filter(pkg => shipped.has(`${pkg.name} ${pkg.version}`))
  .map(pkg => {
    const directory = path.dirname(pkg.manifest_path)
    const files = licenseFiles(directory).filter(file => fs.statSync(file).isFile()).sort()
    const standard = path.join(standardTexts, `${pkg.license}.txt`)
    const text = files.length > 0
      ? files.map(file => (files.length > 1 ? `--- ${path.relative(directory, file)} ---\n\n` : '') + fs.readFileSync(file, 'utf8').trim()).join('\n\n')
      : fs.existsSync(standard)
        ? `${pkg.name} ships no license file of its own; it is distributed under ${pkg.license}, whose text follows.\n\n${fs.readFileSync(standard, 'utf8').trim()}`
        : `${pkg.name} is distributed under ${pkg.license}. The crate ships no license file; its terms are at ${pkg.repository ?? `https://crates.io/crates/${pkg.name}`}.`
    return { name: pkg.name, version: pkg.version, license: pkg.license ?? pkg.license_file ?? 'unknown', text }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

const missing = [...shipped].filter(id => !entries.some(entry => `${entry.name} ${entry.version}` === id))
if (missing.length > 0) throw new Error(`No metadata for ${missing.join(', ')}`)

fs.writeFileSync(output, `${JSON.stringify(entries, null, 2)}\n`)
const bare = entries.filter(entry => entry.text.includes('The crate ships no license file')).map(entry => entry.name)
if (bare.length > 0) throw new Error(`No license text for ${bare.join(', ')}; add its standard text to ${path.relative(root, standardTexts)}`)
console.log(`Wrote ${entries.length} crate licenses to ${path.relative(root, output)}`)

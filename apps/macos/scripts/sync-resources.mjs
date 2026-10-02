#!/usr/bin/env node
// Regenerates the SwiftUI app's copies of the renderer's translations and
// icons, so the two UIs read the same text and draw the same glyphs:
//
//   Resources/strings.json  <- src/renderer/src/i18n/resources.ts
//   Resources/icons.json    <- every lucide-react icon the renderer imports
//
// Run from anywhere: node apps/macos/scripts/sync-resources.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const renderer = path.join(root, 'src/renderer/src')
const resources = path.join(root, 'apps/macos/Sources/LiberaUI/Resources')
const lucide = path.join(root, 'node_modules/lucide-react/dist/esm')

const { resources: translations } = await import(path.join(renderer, 'i18n/resources.ts'))
fs.writeFileSync(path.join(resources, 'strings.json'), `${JSON.stringify(translations, null, 2)}\n`)

// lucide-react's index re-exports each icon file under its name and aliases
// (`Home` is `house.js`), so it is what turns an import into a file.
const files = new Map()
const index = fs.readFileSync(path.join(lucide, 'lucide-react.js'), 'utf8')
for (const [, names, file] of index.matchAll(/export \{([^}]+)\} from '\.\/icons\/([\w-]+)\.js'/g)) {
  for (const [, name] of names.matchAll(/default as (\w+)/g)) files.set(name, file)
}

function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : []
  })
}

const used = new Set()
for (const source of sources(renderer)) {
  const text = fs.readFileSync(source, 'utf8')
  for (const [, names] of text.matchAll(/import \{([^}]+)\} from 'lucide-react'/g)) {
    for (const name of names.split(',').map(part => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      if (name.startsWith('type ')) continue
      const file = files.get(name)
      if (!file) throw new Error(`No lucide icon file for ${name} in ${path.relative(root, source)}`)
      used.add(file)
    }
  }
}

const icons = {}
for (const file of [...used].sort()) {
  const text = fs.readFileSync(path.join(lucide, 'icons', `${file}.js`), 'utf8')
  const nodes = text.match(/const __iconNode = ([\s\S]*?);\nconst /)
  if (!nodes) throw new Error(`Could not read the nodes of ${file}`)
  // The node list is a JS literal of string-valued objects; drop React's keys.
  icons[file] = Function(`return ${nodes[1]}`)().map(([kind, { key, ...attrs }]) => [kind, attrs])
}
fs.writeFileSync(path.join(resources, 'icons.json'), `${JSON.stringify(icons)}\n`)
console.log(`strings.json and ${Object.keys(icons).length} icons written to ${path.relative(root, resources)}`)

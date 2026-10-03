#!/usr/bin/env node
// Runs the native app and rebuilds and relaunches it whenever its sources
// change: the native counterpart of `npm run dev`. Arguments go to the app, so
// a relaunch can come back to the screen being worked on:
//
//   node apps/macos/scripts/dev.mjs --screen inspect --expert --lang ko
//
// Swift has no hot reload outside Xcode's canvas, so a change restarts the app.
// A change under crates/ rebuilds libera-core first, for this Mac alone.
// Press Ctrl+C to stop.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const app = path.join(root, 'apps/macos')
const binary = path.join(app, '.build/debug/LiberaMacUI')
const appArgs = process.argv.slice(2)
const hostTarget = os.arch() === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'

function developerDir() {
  if (process.env.DEVELOPER_DIR) return process.env.DEVELOPER_DIR
  try {
    const selected = fs.realpathSync('/var/db/xcode_select_link')
    if (!selected.includes('CommandLineTools')) return selected
  } catch {
    // No selection recorded; fall back to the usual Xcode location.
  }
  return '/Applications/Xcode.app/Contents/Developer'
}
const env = { ...process.env, DEVELOPER_DIR: developerDir() }

const log = message => console.log(`\x1b[35m[libera dev]\x1b[0m ${message}`)

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: app, stdio: 'inherit', env: { ...env, ...options.env } })
    child.on('exit', code => resolve(code === 0))
  })
}

const buildCore = () => {
  log(`building libera-core for ${hostTarget}…`)
  return run(path.join(app, 'scripts/build-core.sh'), [], { env: { LIBERA_CORE_TARGETS: hostTarget } })
}
const buildApp = () => run('swift', ['build', '--product', 'LiberaMacUI'])

let child = null
let launches = 0

function launch() {
  launches += 1
  // Only the first launch takes the focus; later ones leave it in the editor.
  const extra = launches > 1 ? { LIBERA_DEV_RELAUNCH: '1' } : {}
  child = spawn(binary, appArgs, { stdio: 'inherit', env: { ...env, ...extra } })
  const current = child
  child.on('exit', () => {
    if (child === current) {
      child = null
      log('the app closed; it starts again on the next change (Ctrl+C stops)')
    }
  })
}

function stop() {
  const current = child
  if (!current) return Promise.resolve()
  child = null
  return new Promise(resolve => {
    const force = setTimeout(() => current.kill('SIGKILL'), 3000)
    current.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    current.kill('SIGTERM')
  })
}

let building = false
let pending = null

/** Runs one build at a time; changes made meanwhile wait for the next. */
async function rebuild(core) {
  if (building) {
    pending = { core: core || pending?.core === true }
    return
  }
  building = true
  const started = Date.now()
  const built = (!core || (await buildCore())) && (await buildApp())
  if (built) {
    log(`built in ${((Date.now() - started) / 1000).toFixed(1)} s; relaunching`)
    await stop()
    launch()
  } else {
    log('the build failed; the running app stays until the next change')
  }
  building = false
  if (pending) {
    const next = pending
    pending = null
    rebuild(next.core)
  }
}

let timer = null
let coreChanged = false

function watch(directory, core, accepts) {
  fs.watch(directory, { recursive: true }, (_, file) => {
    if (!file || !accepts(file)) return
    coreChanged ||= core
    clearTimeout(timer)
    timer = setTimeout(() => {
      const core = coreChanged
      coreChanged = false
      log(`${core ? 'crates/' : 'Sources/'} changed`)
      rebuild(core)
    }, 250)
  })
}

const editorNoise = file => /(^|\/)\.|~$|\.sw.$/.test(file)
// build-core.sh writes the bindings and the app info itself, mid-build.
const generated = file => file.includes('Generated/') || file.endsWith('appInfo.json')
watch(path.join(app, 'Sources'), false, file => !editorNoise(file) && !generated(file))
watch(path.join(root, 'crates'), true, file => !editorNoise(file) && /\.(rs|toml)$/.test(file))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await stop()
    process.exit(0)
  })
}

const prepared = ['Frameworks/LiberaCoreFFI.xcframework', 'Sources/LiberaCore/Generated/libera_core.swift', 'Sources/LiberaUI/Resources/appInfo.json']
  .every(file => fs.existsSync(path.join(app, file)))
if (!prepared && !(await buildCore())) process.exit(1)
log('watching apps/macos/Sources and crates/')
await rebuild(false)

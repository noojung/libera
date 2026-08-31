import fs from 'fs'
import path from 'path'
import { configure } from 'libera7z'
// The package's node export condition brings the worker_threads factory with
// it. The bundle itself is copied beside main by the Vite build.

// Vitest runs these modules from source, where no bundle has been built, so the
// library is told to stay in process there. Electron builds always have one.
const workerScript = path.resolve(__dirname, '../worker/libera7zWorker.mjs')

configure({
  workerScript,
  useWorkers: process.versions.electron !== undefined && fs.existsSync(workerScript)
})

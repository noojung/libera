import { promises as fsPromises, constants as fsConstants } from 'fs'
import path from 'path'

// Locating the bundled 7-Zip executable. 7zip-bin's own `path7za` is computed
// from __dirname, which is useless here: vite bundles the main process into a
// single dist/main/main.js, so __dirname points at the bundle rather than at
// the package. The binary is therefore located by convention instead - shipped
// as an extraResource next to the app in production, read out of node_modules
// in development and tests.

export const SEVEN_ZIP_PATH_ENV = 'LIBERA_7ZA_PATH'
export const SEVEN_ZIP_RESOURCE_DIRECTORY = '7zip'

export function sevenZipBinaryName(): string {
  return process.platform === 'win32' ? '7za.exe' : '7za'
}

function packageDirectoryName(): string {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'win'
  return 'linux'
}

/**
 * npm does not reliably preserve the executable bit when unpacking 7zip-bin,
 * so a binary that is present but not executable is repaired rather than
 * rejected. Failing to chmod is not fatal: the access check that follows is
 * what decides whether the candidate is usable.
 */
async function ensureExecutable(candidate: string): Promise<boolean> {
  try {
    await fsPromises.access(candidate, fsConstants.X_OK)
    return true
  } catch {
    if (process.platform === 'win32') return false
  }

  try {
    const stat = await fsPromises.stat(candidate)
    await fsPromises.chmod(candidate, stat.mode | 0o111)
    await fsPromises.access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function developmentCandidates(binaryName: string): string[] {
  const relativePath = path.join('node_modules', '7zip-bin', packageDirectoryName(), process.arch, binaryName)
  const candidates: string[] = []

  for (const root of [process.cwd(), __dirname]) {
    let current = path.resolve(root)
    while (true) {
      candidates.push(path.join(current, relativePath))
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  return candidates
}

let cachedPath: string | null = null

export function resetSevenZipBinaryCache(): void {
  cachedPath = null
}

export class SevenZipUnavailableError extends Error {
  readonly code = 'SEVEN_ZIP_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'SevenZipUnavailableError'
  }
}

export async function resolveSevenZipBinaryPath(): Promise<string> {
  if (cachedPath) return cachedPath

  const binaryName = sevenZipBinaryName()
  const candidates: string[] = []

  const override = process.env[SEVEN_ZIP_PATH_ENV]
  if (override) candidates.push(path.resolve(override))

  // process.resourcesPath is also defined when running `electron .` in
  // development, where it points at Electron's own Resources, so the packaged
  // candidate has to be probed for existence rather than trusted outright.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, SEVEN_ZIP_RESOURCE_DIRECTORY, binaryName))
  }

  candidates.push(...developmentCandidates(binaryName))

  for (const candidate of candidates) {
    if (await ensureExecutable(candidate)) {
      cachedPath = candidate
      return candidate
    }
  }

  throw new SevenZipUnavailableError(
    `Unable to locate a usable 7-Zip binary (${binaryName}). Looked in: ${candidates.slice(0, 4).join(', ')}`
  )
}

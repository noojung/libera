const fs = require('fs/promises')
const path = require('path')

const KEPT_MAC_ELECTRON_LOCALES = new Set(['en.lproj', 'ko.lproj'])

async function removeUnusedMacElectronLocales(appPath) {
  const resourcesPath = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Resources'
  )
  const entries = await fs.readdir(resourcesPath, { withFileTypes: true })
  const localeDirectories = entries
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.lproj'))
    .map(entry => entry.name)

  for (const locale of KEPT_MAC_ELECTRON_LOCALES) {
    if (!localeDirectories.includes(locale)) {
      throw new Error(`Required Electron locale is missing: ${locale}`)
    }
  }

  await Promise.all(
    localeDirectories
      .filter(locale => !KEPT_MAC_ELECTRON_LOCALES.has(locale))
      .map(locale => fs.rm(path.join(resourcesPath, locale), { recursive: true }))
  )
}

/**
 * npm does not reliably preserve the executable bit on the 7zip-bin payload,
 * and extraResources copies whatever mode it finds, so the shipped binary is
 * hardened here. This runs before electron-builder seals the bundle with its
 * ad-hoc signature, so changing the file now is safe.
 */
async function hardenSevenZipBinary(resourcesPath, binaryName) {
  const binaryPath = path.join(resourcesPath, '7zip', binaryName)

  try {
    await fs.access(binaryPath)
  } catch {
    throw new Error(`The bundled 7-Zip binary is missing from the package: ${binaryPath}`)
  }

  await fs.chmod(binaryPath, 0o755)
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    const appPath = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`
    )

    // Remove the backing Electron Framework resources before electron-builder
    // applies the configured ad-hoc signature to the complete app bundle.
    await removeUnusedMacElectronLocales(appPath)
    await hardenSevenZipBinary(path.join(appPath, 'Contents', 'Resources'), '7za')
    return
  }

  if (context.electronPlatformName === 'win32') {
    await hardenSevenZipBinary(path.join(context.appOutDir, 'resources'), '7za.exe')
  }
}

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

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    const appPath = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`
    )

    // Remove the backing Electron Framework resources before electron-builder
    // applies the configured ad-hoc signature to the complete app bundle.
    await removeUnusedMacElectronLocales(appPath)
  }
}

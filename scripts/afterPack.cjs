const fs = require('fs/promises')
const path = require('path')
const { signAsync } = require('@electron/osx-sign')

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
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  // electron-builder 25 only removes the top-level locale links on macOS.
  // Remove the backing Electron Framework resources before signing the app.
  await removeUnusedMacElectronLocales(appPath)

  // electron-builder 25 does not support mac.identity="-". Sign the complete
  // Electron bundle ad-hoc after packaging so its nested helpers and
  // frameworks have consistent signatures. Gatekeeper still warns because
  // this is not a paid Developer ID signature, but the approved app can run.
  await signAsync({
    app: appPath,
    identity: '-',
    identityValidation: false,
    gatekeeperAssess: false,
    optionsForFile: () => ({ hardenedRuntime: false })
  })
}

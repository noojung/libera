const path = require('path')
const { signAsync } = require('@electron/osx-sign')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

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

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

// Screenshots must look the same no matter who captures them. Without this the
// output resolution follows the host display (150% on Windows, 200% on macOS),
// which silently splits the set across machines.
app.commandLine.appendSwitch('force-device-scale-factor', '2')

const projectRoot = path.resolve(__dirname, '..')
const outputDirectory = path.join(projectRoot, 'site', 'static', 'images')
const rendererEntry = path.join(projectRoot, 'dist', 'renderer', 'index.html')

const screens = [
  ['libera-app-compress', 'compress'],
  ['libera-app-extract', 'extract'],
  ['libera-app-inspect', 'inspect']
]

const themes = [
  { name: 'light', suffix: '', background: '#faf7f2' },
  { name: 'dark', suffix: '-dark', background: '#241f1b' }
]

async function settle(window) {
  await window.webContents.executeJavaScript(`
    Promise.all([
      document.fonts ? document.fonts.ready : Promise.resolve(),
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    ])
  `)
}

async function applyPreferences(window, theme) {
  await window.webContents.executeJavaScript(`
    window.localStorage.setItem('libera.language', 'en')
    window.localStorage.setItem('libera_theme', '${theme.name}')
  `)
  const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve))
  window.webContents.reload()
  await reloaded

  // The window never becomes visible, so Chromium can throttle rendering and
  // decouple wall-clock waits from what has actually been painted. Disabling
  // transitions removes that race instead of trying to outwait it.
  await window.webContents.insertCSS('*, *::before, *::after { transition: none !important; animation: none !important; }')
}

async function captureScreens() {
  await fs.mkdir(outputDirectory, { recursive: true })

  const window = new BrowserWindow({
    width: 1050,
    height: 720,
    show: false,
    backgroundColor: themes[0].background,
    webPreferences: {
      preload: path.join(projectRoot, 'dist', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  await window.loadFile(rendererEntry)

  for (const theme of themes) {
    window.setBackgroundColor(theme.background)
    await applyPreferences(window, theme)

    for (const [baseName, mode] of screens) {
      const selected = await window.webContents.executeJavaScript(`
        (() => {
          const tab = document.querySelector('.titlebar__tab--${mode}')
          if (!tab) return false
          tab.click()
          return true
        })()
      `)

      if (!selected) {
        throw new Error(`Could not find the ${mode} tab`)
      }

      await settle(window)
      const image = await window.capturePage()
      await fs.writeFile(path.join(outputDirectory, `${baseName}${theme.suffix}.png`), image.toPNG())
    }
  }

  window.destroy()
}

app.whenReady()
  .then(captureScreens)
  .then(() => app.quit())
  .catch(error => {
    console.error(error)
    app.exit(1)
  })

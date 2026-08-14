const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const outputDirectory = path.join(projectRoot, 'site', 'static', 'images')
const rendererEntry = path.join(projectRoot, 'dist', 'renderer', 'index.html')

const screens = [
  ['libera-app-compress.png', 'compress'],
  ['libera-app-extract.png', 'extract'],
  ['libera-app-inspect.png', 'inspect']
]

async function settle(window) {
  await window.webContents.executeJavaScript(`
    Promise.all([
      document.fonts ? document.fonts.ready : Promise.resolve(),
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    ])
  `)
}

async function captureScreens() {
  await fs.mkdir(outputDirectory, { recursive: true })

  const window = new BrowserWindow({
    width: 1050,
    height: 720,
    show: false,
    backgroundColor: '#faf7f2',
    webPreferences: {
      preload: path.join(projectRoot, 'dist', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  await window.loadFile(rendererEntry)
  await window.webContents.executeJavaScript(`window.localStorage.setItem('libera.language', 'ko')`)
  const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve))
  window.webContents.reload()
  await reloaded

  for (const [fileName, mode] of screens) {
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
    await fs.writeFile(path.join(outputDirectory, fileName), image.toPNG())
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

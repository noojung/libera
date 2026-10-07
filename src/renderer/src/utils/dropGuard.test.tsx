import { afterEach, describe, expect, it } from 'vitest'
import { installDropGuard } from './dropGuard'

/** jsdom has no DragEvent, so a plain event carries the drag's data. */
function drag(type: 'dragover' | 'drop', target: EventTarget = document.body) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const dataTransfer = { dropEffect: 'copy' }
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  target.dispatchEvent(event)
  return { event, dataTransfer }
}

describe('dropping files outside a drop zone', () => {
  let uninstall: (() => void) | undefined

  afterEach(() => {
    uninstall?.()
    uninstall = undefined
    document.body.replaceChildren()
  })

  it('shows the drag as refused', () => {
    uninstall = installDropGuard()
    const { event, dataTransfer } = drag('dragover')
    expect(event.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('none')
  })

  it('keeps the drop from opening the file', () => {
    uninstall = installDropGuard()
    expect(drag('drop').event.defaultPrevented).toBe(true)
  })

  it('leaves a drag a drop zone accepted alone', () => {
    uninstall = installDropGuard()
    const zone = document.createElement('div')
    zone.addEventListener('dragover', event => event.preventDefault())
    document.body.append(zone)

    expect(drag('dragover', zone).dataTransfer.dropEffect).toBe('copy')
  })

  it('stops guarding once uninstalled', () => {
    installDropGuard()()
    expect(drag('drop').event.defaultPrevented).toBe(false)
  })
})

/**
 * Keeps a file dragged over the window from being opened in place of the app.
 *
 * The drop zones handle their own drags and stop them there, so a drag that
 * reaches the window is over something that takes nothing: it is shown as
 * refused, and a drop is ignored. The main process refuses the navigation as
 * well; this is what keeps the cursor from promising a drop that goes nowhere.
 */
export function installDropGuard(target: Window = window): () => void {
  const refuseDrag = (event: DragEvent) => {
    if (event.defaultPrevented) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
  }
  const refuseDrop = (event: DragEvent) => event.preventDefault()

  target.addEventListener('dragover', refuseDrag)
  target.addEventListener('drop', refuseDrop)
  return () => {
    target.removeEventListener('dragover', refuseDrag)
    target.removeEventListener('drop', refuseDrop)
  }
}

export type LineEnding = 'crlf' | 'lf' | 'cr' | 'mixed' | 'none'

/**
 * Which line ending the text uses. A lone CR is counted only where it is not
 * the CR of a CRLF pair, so an old Mac file is told apart from a Windows one.
 */
export function detectLineEnding(text: string): LineEnding {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\r') {
      if (text[index + 1] === '\n') {
        crlf += 1
        index += 1
      } else {
        cr += 1
      }
    } else if (character === '\n') {
      lf += 1
    }
  }
  const kinds = (crlf > 0 ? 1 : 0) + (lf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0)
  if (kinds === 0) return 'none'
  if (kinds > 1) return 'mixed'
  if (crlf > 0) return 'crlf'
  return lf > 0 ? 'lf' : 'cr'
}

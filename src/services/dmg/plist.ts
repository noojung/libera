import { invalid } from './bytes'

// Just enough of Apple's XML property list format to read a UDIF image's
// resource map: dictionaries, arrays, strings, data, numbers and booleans.

export type PlistValue = string | number | boolean | Uint8Array | PlistValue[] | { [key: string]: PlistValue }

const MAX_DEPTH = 32

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity] ?? match
  })
}

export function parsePlist(xml: string): PlistValue {
  let pos = 0

  // Skips the prolog, comments and doctype, then returns the next tag.
  function nextTag(): { name: string; closing: boolean; empty: boolean } {
    for (;;) {
      const open = xml.indexOf('<', pos)
      if (open < 0) invalid('truncated property list')
      if (xml.startsWith('<!--', open)) {
        const end = xml.indexOf('-->', open + 4)
        if (end < 0) invalid('truncated property list')
        pos = end + 3
        continue
      }
      const close = xml.indexOf('>', open)
      if (close < 0) invalid('truncated property list')
      pos = close + 1
      if (xml[open + 1] === '?' || xml[open + 1] === '!') continue
      let body = xml.slice(open + 1, close).trim()
      const closing = body.startsWith('/')
      const empty = body.endsWith('/')
      if (closing) body = body.slice(1)
      if (empty) body = body.slice(0, -1)
      return { name: body.split(/\s/, 1)[0], closing, empty }
    }
  }

  function textUntil(name: string): string {
    const end = xml.indexOf(`</${name}>`, pos)
    if (end < 0) invalid('truncated property list')
    const text = xml.slice(pos, end)
    pos = end + name.length + 3
    return text
  }

  function value(tag: { name: string; closing: boolean; empty: boolean }, depth: number): PlistValue {
    if (depth > MAX_DEPTH || tag.closing) invalid('malformed property list')
    switch (tag.name) {
      case 'dict': {
        const dict: { [key: string]: PlistValue } = Object.create(null)
        if (tag.empty) return dict
        for (;;) {
          const key = nextTag()
          if (key.closing && key.name === 'dict') return dict
          if (key.name !== 'key' || key.empty) invalid('malformed property list')
          const name = decodeText(textUntil('key'))
          dict[name] = value(nextTag(), depth + 1)
        }
      }
      case 'array': {
        const array: PlistValue[] = []
        if (tag.empty) return array
        for (;;) {
          const item = nextTag()
          if (item.closing && item.name === 'array') return array
          array.push(value(item, depth + 1))
        }
      }
      case 'string':
        return tag.empty ? '' : decodeText(textUntil('string'))
      case 'data':
        return tag.empty ? new Uint8Array() : new Uint8Array(Buffer.from(textUntil('data').replace(/\s+/g, ''), 'base64'))
      case 'integer':
      case 'real': {
        const number = Number(textUntil(tag.name).trim())
        if (!Number.isFinite(number)) invalid('malformed property list number')
        return number
      }
      case 'true':
      case 'false':
        if (!tag.empty) textUntil(tag.name)
        return tag.name === 'true'
      default:
        invalid('unexpected property list element')
    }
  }

  const root = nextTag()
  if (root.name !== 'plist' || root.closing) invalid('not a property list')
  return value(nextTag(), 0)
}

import { describe, expect, it } from 'vitest'
import fs from 'fs'
import { generate, outputPath } from './generateSiteFormats.cjs'
import { SUPPORTED_FORMATS } from '../src/renderer/src/utils/archivePaths'

describe('generateSiteFormats', () => {
  it('writes every format the app itself lists, in the same order', async () => {
    const { formats } = await generate()

    expect(formats.map(format => format.name)).toEqual(SUPPORTED_FORMATS.map(format => format.name))
    expect(formats.map(format => format.extensions))
      .toEqual(SUPPORTED_FORMATS.map(format => [...format.extensions]))
  })

  it('carries the abilities across rather than restating them', async () => {
    const { formats } = await generate()

    for (const [index, format] of formats.entries()) {
      const source = SUPPORTED_FORMATS[index]
      expect(format).toMatchObject({
        compress: source.compress,
        extract: source.extract,
        read: source.read,
        password: source.password,
        split: source.split
      })
    }
  })

  it('names a codec for everything but TAR, which stores its entries', async () => {
    const { formats } = await generate()

    for (const format of formats) {
      if (format.name === 'TAR') {
        expect(format.codecs).toEqual({ write: [], read: [] })
        continue
      }
      // A format nobody gave codecs to would render as a blank cell, which
      // reads as "none" rather than as the gap it is.
      expect(format.codecs.read.length).toBeGreaterThan(0)
      // Only a format the app writes names a write codec, and never more of
      // them than it can read back.
      expect(format.codecs.write.length > 0).toBe(format.compress)
      for (const codec of format.codecs.write) expect(format.codecs.read).toContain(codec)
    }
  })

  it('matches the file the site actually builds from', async () => {
    // Hugo builds the site on its own runner and never runs npm, so what is
    // committed is what ships. CI runs the generator and diffs this same file.
    const committed = fs.readFileSync(outputPath, 'utf8')
    const fresh = `${JSON.stringify(await generate(), null, 2)}\n`

    expect(committed).toBe(fresh)
  })
})

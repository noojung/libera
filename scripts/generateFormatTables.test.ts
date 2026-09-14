import { describe, expect, it } from 'vitest'
import fs from 'fs'
import { generate, readFormats, readmeTable, siteData, outputPath, readmePath } from './generateFormatTables.cjs'
import { SUPPORTED_FORMATS } from '../src/renderer/src/utils/archivePaths'

describe('generateFormatTables', () => {
  it('carries every format the app lists, in the same order', async () => {
    const formats = await readFormats()

    expect(formats.map(format => format.name)).toEqual(SUPPORTED_FORMATS.map(format => format.name))
    expect(formats.map(format => format.extensions))
      .toEqual(SUPPORTED_FORMATS.map(format => [...format.extensions]))
  })

  it('takes the abilities across rather than restating them', async () => {
    const formats = await readFormats()

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
    const formats = await readFormats()

    for (const format of formats) {
      if (format.name === 'TAR') {
        expect(format.codecs).toEqual({ write: [], read: [] })
        continue
      }
      expect(format.codecs.read.length).toBeGreaterThan(0)
      // Only a format the app writes names a write codec, and never one it
      // could not read back.
      expect(format.codecs.write.length > 0).toBe(format.compress)
      for (const codec of format.codecs.write) expect(format.codecs.read).toContain(codec)
    }
  })

  it('gives every format a note, and an encryption line only where there is one', async () => {
    const formats = await readFormats()

    for (const format of formats) {
      expect(format.notes, `${format.name} has no note`).toBeTruthy()
      // Naming an algorithm for a format with no password would promise
      // something the writer cannot do.
      expect(format.encryption.length > 0).toBe(format.password)
    }
  })

  it('keeps the site out of the README-only detail', async () => {
    const formats = await readFormats()
    const { formats: rows } = siteData(formats)

    for (const row of rows) {
      expect(row).not.toHaveProperty('notes')
      expect(row).not.toHaveProperty('encryption')
      expect(row).not.toHaveProperty('readFilters')
    }
  })

  it('writes a row per format into the README table', async () => {
    const formats = await readFormats()
    const table = readmeTable(formats)
    const rows = table.split('\n')

    // A header, its divider, and one row each.
    expect(rows).toHaveLength(formats.length + 2)
    expect(rows[0]).toContain('| Extensions |')
    for (const format of formats) {
      expect(table).toContain(`| ${format.name} | ${format.extensions.join(' ')} |`)
    }
  })

  it('matches the files the site and the README actually ship', async () => {
    // Hugo builds the site on its own runner and never runs npm, so what is
    // committed is what ships. CI runs the generator and diffs these same files.
    const committedData = fs.readFileSync(outputPath, 'utf8')
    const committedReadme = fs.readFileSync(readmePath, 'utf8')

    const { data } = await generate()

    expect(committedData).toBe(`${JSON.stringify(data, null, 2)}\n`)
    expect(fs.readFileSync(readmePath, 'utf8')).toBe(committedReadme)
  })
})

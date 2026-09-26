import { afterEach, describe, expect, it } from 'vitest'
import {
  createCompressionInputFilter,
  createUniqueRootNamer,
  hasMacMetadataSegment,
  isHiddenName,
  isMacMetadataName,
  symlinkUnixMode,
  type InputEntryKind
} from './compressionInputs'

const originalPlatform = process.platform

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => onPlatform(originalPlatform))

const file: InputEntryKind = { isDirectory: () => false, isSymbolicLink: () => false }
const folder: InputEntryKind = { isDirectory: () => true, isSymbolicLink: () => false }
const link: InputEntryKind = { isDirectory: () => false, isSymbolicLink: () => true }
const linkedFolder: InputEntryKind = { isDirectory: () => true, isSymbolicLink: () => true }

describe('isMacMetadataName', () => {
  it('recognises what macOS writes for itself', () => {
    for (const name of ['.DS_Store', '__MACOSX', '._photo.jpg', '._']) {
      expect(isMacMetadataName(name)).toBe(true)
    }
  })

  it('leaves look-alikes alone', () => {
    for (const name of ['DS_Store', '.DS_Store.bak', '__macosx', 'photo._jpg', '.hidden', '_notes']) {
      expect(isMacMetadataName(name)).toBe(false)
    }
  })
})

describe('isHiddenName', () => {
  it('hides dot-prefixed names', () => {
    expect(isHiddenName('.git')).toBe(true)
    expect(isHiddenName('.env.local')).toBe(true)
  })

  it('does not hide the directory references or names with an inner dot', () => {
    for (const name of ['.', '..', 'a.txt', 'name.']) {
      expect(isHiddenName(name)).toBe(false)
    }
  })
})

describe('hasMacMetadataSegment', () => {
  it('finds bookkeeping at any depth, with either separator', () => {
    expect(hasMacMetadataSegment('__MACOSX/photos/a.jpg')).toBe(true)
    expect(hasMacMetadataSegment('photos/.DS_Store')).toBe(true)
    expect(hasMacMetadataSegment('photos\\._a.jpg')).toBe(true)
  })

  it('passes ordinary paths, empty segments included', () => {
    expect(hasMacMetadataSegment('photos/a.jpg')).toBe(false)
    expect(hasMacMetadataSegment('/photos//a.jpg/')).toBe(false)
    expect(hasMacMetadataSegment('')).toBe(false)
  })
})

describe('symlinkUnixMode', () => {
  it('marks the entry as a link and keeps its permission bits', () => {
    expect(symlinkUnixMode(0o755)).toBe(0o120755)
    expect(symlinkUnixMode(0o4755)).toBe(0o124755)
  })

  it('replaces whatever file type the mode carried', () => {
    expect(symlinkUnixMode(0o100644)).toBe(0o120644)
    expect(symlinkUnixMode(0o040755)).toBe(0o120755)
  })

  // Windows reports no permission bits of its own.
  it('falls back to 777 when there are no permission bits', () => {
    expect(symlinkUnixMode(0)).toBe(0o120777)
    expect(symlinkUnixMode(0o100000)).toBe(0o120777)
  })
})

describe('createCompressionInputFilter', () => {
  it('lets everything through by default', () => {
    const filter = createCompressionInputFilter()
    expect(filter.allowsName('.DS_Store')).toBe(true)
    expect(filter.allowsName('.git')).toBe(true)
    expect(filter.allowsPath('.git/__MACOSX/._a')).toBe(true)
    expect(filter.allowsEntry('a.txt', file)).toBe(true)
    expect(filter.allowsEntry('link', link)).toBe(true)
  })

  it('blocks macOS bookkeeping by name and by any segment of a path', () => {
    const filter = createCompressionInputFilter({ excludeMacMetadata: true })
    expect(filter.allowsName('__MACOSX')).toBe(false)
    expect(filter.allowsName('._a.jpg')).toBe(false)
    expect(filter.allowsName('.git')).toBe(true)
    expect(filter.allowsPath('photos/__MACOSX/a.jpg')).toBe(false)
    expect(filter.allowsPath('photos\\.DS_Store')).toBe(false)
    expect(filter.allowsPath('photos/a.jpg')).toBe(true)
  })

  it('blocks hidden names and everything beneath a hidden folder', () => {
    const filter = createCompressionInputFilter({ excludeHiddenFiles: true })
    expect(filter.allowsName('.git')).toBe(false)
    expect(filter.allowsName('src')).toBe(true)
    expect(filter.allowsPath('src/.git/config')).toBe(false)
    expect(filter.allowsPath('.config\\app.json')).toBe(false)
    expect(filter.allowsPath('src/app.ts')).toBe(true)
    // A leading or doubled separator is an empty segment, not a hidden one.
    expect(filter.allowsPath('/src//app.ts')).toBe(true)
  })

  it('drops symbolic links, folder links included, only when asked', () => {
    const filter = createCompressionInputFilter({ excludeSymlinks: true })
    expect(filter.allowsEntry('link', link)).toBe(false)
    expect(filter.allowsEntry('linked', linkedFolder)).toBe(false)
    expect(filter.allowsEntry('a.txt', file)).toBe(true)
    expect(createCompressionInputFilter().allowsEntry('linked', linkedFolder)).toBe(true)
  })

  it('matches the pattern against files and never against folders', () => {
    const filter = createCompressionInputFilter({ filterPattern: '*.txt' })
    expect(filter.allowsEntry('notes/a.txt', file)).toBe(true)
    expect(filter.allowsEntry('notes/a.log', file)).toBe(false)
    // A folder that matches nothing may still hold a file that does.
    expect(filter.allowsEntry('notes', folder)).toBe(true)
    // The pattern decides leaves only; it never prunes a walk step.
    expect(filter.allowsName('notes')).toBe(true)
  })
})

describe('createUniqueRootNamer', () => {
  it('numbers repeated names from 2', () => {
    const name = createUniqueRootNamer()
    expect(['src', 'src', 'src', 'docs'].map(name)).toEqual(['src', 'src (2)', 'src (3)', 'docs'])
  })

  it('skips a numbered name the user already picked', () => {
    const name = createUniqueRootNamer()
    expect(['src (2)', 'src', 'src'].map(name)).toEqual(['src (2)', 'src', 'src (3)'])
  })

  it('keeps each namer to its own job', () => {
    expect(createUniqueRootNamer()('src')).toBe('src')
    expect(createUniqueRootNamer()('src')).toBe('src')
  })

  it('treats names differing only in case as a collision on Windows only', () => {
    onPlatform('win32')
    const windows = createUniqueRootNamer()
    expect(['src', 'Src', 'SRC (2)'].map(windows)).toEqual(['src', 'Src (2)', 'SRC (2) (2)'])

    onPlatform('darwin')
    const mac = createUniqueRootNamer()
    expect(['src', 'Src'].map(mac)).toEqual(['src', 'Src'])
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeEntryPath } from './extractionSafety'

// Format libraries increasingly reject hostile paths themselves, which is
// welcome but means an end-to-end extraction test can stop reaching our own
// guard without anything failing. These cover it directly, so the check keeps
// its coverage whichever layer happens to reject first.
describe('normalizeEntryPath', () => {
  it.each([
    ['a parent traversal', '../escape.txt'],
    ['a traversal in the middle', 'nested/../../escape.txt'],
    ['a Windows-separated traversal', '..\\escape.txt'],
    ['an absolute POSIX path', '/etc/passwd'],
    ['a Windows drive path', 'C:/Windows/system32'],
    ['a Windows drive root', 'C:']
  ])('rejects %s', (_label, entryPath) => {
    expect(() => normalizeEntryPath(entryPath)).toThrow('entry path escapes the destination')
  })

  it.each([
    ['an empty path', ''],
    ['a null byte', 'nested/evil\0.txt']
  ])('rejects %s', (_label, entryPath) => {
    expect(() => normalizeEntryPath(entryPath)).toThrow('entry path is empty or contains a null byte')
  })

  it('rejects a path that normalizes away to nothing', () => {
    expect(() => normalizeEntryPath('./')).toThrow('invalid entry path')
  })

  it.each([
    ['a plain name', 'notes.txt', 'notes.txt'],
    ['a nested path', 'nested/notes.txt', 'nested/notes.txt'],
    ['a leading ./', './nested/notes.txt', 'nested/notes.txt'],
    ['backslash separators', 'nested\\notes.txt', 'nested/notes.txt'],
    ['a trailing slash', 'nested/', 'nested'],
    ['a name that merely starts with dots', '..notes.txt', '..notes.txt']
  ])('keeps %s', (_label, entryPath, expected) => {
    expect(normalizeEntryPath(entryPath)).toBe(expected)
  })
})

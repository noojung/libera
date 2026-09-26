import { afterEach, describe, expect, it } from 'vitest'
import { createArchiveEntryFilter } from './entryPatterns'

const originalPlatform = process.platform

/** The matcher reads the platform when it is built, so each case can pick one. */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => onPlatform(originalPlatform))

/** The subset of `paths` a pattern list keeps. */
const kept = (patternText: string | undefined, paths: string[]): string[] =>
  paths.filter(createArchiveEntryFilter(patternText))

describe('createArchiveEntryFilter', () => {
  it('keeps everything when there is no pattern', () => {
    for (const patternText of [undefined, '', '   ', ',;\n']) {
      expect(kept(patternText, ['a.txt', 'dir/b.log', '.hidden'])).toEqual(['a.txt', 'dir/b.log', '.hidden'])
    }
  })

  it('matches a pattern without a slash against the name in any folder', () => {
    expect(kept('*.txt', ['a.txt', 'deep/down/b.txt', 'c.log', 'txt'])).toEqual(['a.txt', 'deep/down/b.txt'])
  })

  it('matches a pattern with a slash against the whole path', () => {
    expect(kept('docs/*.md', ['docs/a.md', 'other/docs/a.md', 'a.md'])).toEqual(['docs/a.md'])
  })

  it('stops a single star at a folder and lets a double star cross them', () => {
    const paths = ['src/a.ts', 'src/lib/b.ts', 'src/lib/deep/c.ts']
    expect(kept('src/*.ts', paths)).toEqual(['src/a.ts'])
    expect(kept('src/**.ts', paths)).toEqual(paths)
    expect(kept('src/**/*.ts', paths)).toEqual(['src/lib/b.ts', 'src/lib/deep/c.ts'])
  })

  it('matches exactly one character with a question mark', () => {
    expect(kept('file?.txt', ['file1.txt', 'file12.txt', 'file.txt'])).toEqual(['file1.txt'])
    expect(kept('a?b', ['a/b', 'axb'])).toEqual(['axb'])
  })

  it('treats regular expression characters literally', () => {
    expect(kept('a.txt', ['a.txt', 'abtxt'])).toEqual(['a.txt'])
    expect(kept('c++ (v2) [x]{1}|$^.cpp', ['c++ (v2) [x]{1}|$^.cpp', 'cc (v2) x1.cpp'])).toEqual(['c++ (v2) [x]{1}|$^.cpp'])
  })

  it('subtracts exclusions from everything when no include is given', () => {
    expect(kept('!*.log', ['a.txt', 'b.log', 'dir/c.log'])).toEqual(['a.txt'])
  })

  it('lets an exclusion override an include', () => {
    expect(kept('*.txt, !secret*', ['a.txt', 'secret.txt', 'b.log'])).toEqual(['a.txt'])
  })

  it('splits on commas, semicolons and newlines and trims each pattern', () => {
    const paths = ['a.txt', 'b.md', 'c.log', 'd.bin']
    expect(kept(' *.txt ;*.md\n  *.log  ', paths)).toEqual(['a.txt', 'b.md', 'c.log'])
  })

  it('ignores a lone exclamation mark rather than excluding everything', () => {
    expect(kept('!', ['a.txt'])).toEqual(['a.txt'])
  })

  it('reads backslashes in paths and patterns as separators', () => {
    expect(kept('docs\\*.md', ['docs/a.md', 'docs\\b.md', 'c.md'])).toEqual(['docs/a.md', 'docs\\b.md'])
  })

  it('ignores a leading ./ and a trailing slash on the entry', () => {
    expect(kept('docs/*.md', ['./docs/a.md', 'docs/b.md/'])).toEqual(['./docs/a.md', 'docs/b.md/'])
    expect(kept('dir', ['dir/', 'parent/dir/'])).toEqual(['dir/', 'parent/dir/'])
  })

  it('reads at most 100 patterns', () => {
    const patterns = Array.from({ length: 100 }, (_, index) => `f${index}.txt`)
    const filter = createArchiveEntryFilter([...patterns, 'late.txt'].join(','))
    expect(filter('f99.txt')).toBe(true)
    expect(filter('late.txt')).toBe(false)
  })

  it('ignores letter case on Windows only', () => {
    onPlatform('win32')
    expect(kept('*.TXT', ['a.txt', 'B.Txt'])).toEqual(['a.txt', 'B.Txt'])

    onPlatform('darwin')
    expect(kept('*.TXT', ['a.txt', 'B.TXT'])).toEqual(['B.TXT'])

    onPlatform('linux')
    expect(kept('*.TXT', ['a.txt', 'B.TXT'])).toEqual(['B.TXT'])
  })
})

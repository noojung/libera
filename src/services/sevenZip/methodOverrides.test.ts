import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  resolveSevenZipMethod,
  validateSevenZipMethodOverrides,
  type SevenZipMethodOverride
} from './methodOverrides'

describe('7z method overrides', () => {
  const root = path.resolve('/inputs/project')
  const nested = path.join(root, 'assets')
  const file = path.join(nested, 'photo.bin')

  it('uses an exact file rule ahead of the nearest directory rule', () => {
    const overrides: SevenZipMethodOverride[] = [
      { sourcePath: root, scope: 'tree', method: 'copy' },
      { sourcePath: nested, scope: 'tree', method: 'auto' },
      { sourcePath: file, scope: 'file', method: 'lzma2' }
    ]

    expect(resolveSevenZipMethod(file, 'lzma2', overrides)).toEqual({ method: 'lzma2', explicit: true })
    expect(resolveSevenZipMethod(path.join(nested, 'other.bin'), 'lzma2', overrides))
      .toEqual({ method: 'auto', explicit: true })
    expect(resolveSevenZipMethod(path.join(root, 'README.md'), 'lzma2', overrides))
      .toEqual({ method: 'copy', explicit: true })
  })

  it('falls back to the archive method outside every rule', () => {
    expect(resolveSevenZipMethod(file, 'copy', [])).toEqual({ method: 'copy', explicit: false })
  })

  it('accepts supported rules inside a selected input', () => {
    expect(() => validateSevenZipMethodOverrides([
      { sourcePath: root, scope: 'tree', method: 'auto' },
      { sourcePath: file, scope: 'file', method: 'copy' }
    ], [root])).not.toThrow()
  })

  it('rejects malformed, unsupported and out-of-tree rules', () => {
    expect(() => validateSevenZipMethodOverrides({} as never, [root])).toThrow(TypeError)
    expect(() => validateSevenZipMethodOverrides([
      { sourcePath: file, scope: 'single' as never, method: 'copy' }
    ], [root])).toThrow('scope')
    expect(() => validateSevenZipMethodOverrides([
      { sourcePath: file, scope: 'file', method: 'ppmd' as never }
    ], [root])).toThrow('unsupported')
    expect(() => validateSevenZipMethodOverrides([
      { sourcePath: path.resolve('/elsewhere/file.bin'), scope: 'file', method: 'copy' }
    ], [root])).toThrow('inside')
  })
})

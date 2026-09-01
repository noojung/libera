import { describe, expect, it } from 'vitest'
import path from 'path'
import { resolveZipMethod, validateZipMethodOverrides, type ZipMethodOverride } from './methodOverrides'

describe('ZIP method overrides', () => {
  it('prefers an exact file rule over the nearest recursive folder rule', () => {
    const root = path.resolve('/input')
    const nested = path.join(root, 'nested')
    const file = path.join(nested, 'notes.txt')
    const rules: ZipMethodOverride[] = [
      { sourcePath: root, scope: 'tree', method: 'lzma' },
      { sourcePath: nested, scope: 'tree', method: 'zstd' },
      { sourcePath: file, scope: 'file', method: 'deflate' }
    ]

    expect(resolveZipMethod(file, 'store', rules)).toEqual({ method: 'deflate', explicit: true })
    expect(resolveZipMethod(path.join(nested, 'other.txt'), 'store', rules)).toEqual({ method: 'zstd', explicit: true })
    expect(resolveZipMethod(path.join(root, 'root.txt'), 'store', rules)).toEqual({ method: 'lzma', explicit: true })
    expect(resolveZipMethod('/elsewhere.txt', 'store', rules)).toEqual({ method: 'store', explicit: false })
  })

  it('rejects invalid methods and paths outside the selected inputs', () => {
    const root = path.resolve('/input')
    expect(() => validateZipMethodOverrides([
      { sourcePath: path.join(root, 'a.txt'), scope: 'file', method: 'deflate' }
    ], [root])).not.toThrow()

    expect(() => validateZipMethodOverrides([
      { sourcePath: path.resolve('/other/a.txt'), scope: 'file', method: 'deflate' }
    ], [root])).toThrow(/selected input/)

    expect(() => validateZipMethodOverrides([
      { sourcePath: path.join(root, 'a.txt'), scope: 'file', method: 'brotli' as never }
    ], [root])).toThrow(/unsupported/)
  })

  it('resolves Deflate strategies with the same file and folder precedence', () => {
    const root = path.resolve('/input')
    const nested = path.join(root, 'nested')
    const file = path.join(nested, 'notes.txt')
    const rules: ZipMethodOverride[] = [
      { sourcePath: root, scope: 'tree', method: 'deflate', deflateStrategy: 'filtered' },
      { sourcePath: nested, scope: 'tree', method: 'deflate', deflateStrategy: 'rle' },
      { sourcePath: file, scope: 'file', method: 'deflate', deflateStrategy: 'fixed' }
    ]

    expect(resolveZipMethod(file, 'deflate', rules)).toEqual({
      method: 'deflate',
      explicit: true,
      deflateStrategy: 'fixed'
    })
    expect(resolveZipMethod(path.join(nested, 'other.txt'), 'deflate', rules)).toEqual({
      method: 'deflate',
      explicit: true,
      deflateStrategy: 'rle'
    })
  })

  it('allows Automatic to carry a Deflate strategy and strength', () => {
    const root = path.resolve('/input')
    const file = path.join(root, 'notes.txt')
    const rules: ZipMethodOverride[] = [{
      sourcePath: root,
      scope: 'tree',
      method: 'auto',
      deflateStrategy: 'rle',
      level: 8
    }]

    expect(resolveZipMethod(file, 'auto', rules)).toEqual({
      method: 'auto',
      explicit: true,
      deflateStrategy: 'rle',
      level: 8
    })
  })

  it('cascades compression strength independently from a more specific method rule', () => {
    const root = path.resolve('/input')
    const nested = path.join(root, 'nested')
    const file = path.join(nested, 'notes.txt')
    const rules: ZipMethodOverride[] = [
      { sourcePath: root, scope: 'tree', method: 'deflate', level: 9 },
      { sourcePath: nested, scope: 'tree', method: 'deflate', level: 3 },
      { sourcePath: file, scope: 'file', method: 'lzma' }
    ]

    expect(resolveZipMethod(file, 'deflate', rules)).toEqual({
      method: 'lzma',
      explicit: true,
      level: 3
    })
  })

  it('rejects unsupported Deflate strategies and strategies on other methods', () => {
    const root = path.resolve('/input')
    const file = path.join(root, 'a.txt')

    expect(() => validateZipMethodOverrides([{
      sourcePath: file,
      scope: 'file',
      method: 'deflate',
      deflateStrategy: 'dynamic' as never
    }], [root])).toThrow(/strategy override is unsupported/)

    expect(() => validateZipMethodOverrides([{
      sourcePath: file,
      scope: 'file',
      method: 'store',
      deflateStrategy: 'rle'
    }], [root])).toThrow(/Automatic or Deflate method/)

    expect(() => validateZipMethodOverrides([{
      sourcePath: file,
      scope: 'file',
      method: 'deflate',
      level: 0
    }], [root])).toThrow(/between 1 and 9/)

    expect(() => validateZipMethodOverrides([{
      sourcePath: file,
      scope: 'file',
      method: 'auto',
      level: 0,
      deflateStrategy: 'rle'
    }], [root])).not.toThrow()

    expect(() => validateZipMethodOverrides([{
      sourcePath: file,
      scope: 'file',
      method: 'store',
      level: 5
    }], [root])).toThrow(/Store method/)
  })
})

import { describe, expect, it } from 'vitest'
import { invalidArchive, Libera7zError, throwIfCancelled, unsupportedFeature } from './errors.js'

describe('Libera7z errors', () => {
  it('creates typed archive and feature errors', () => {
    expect(invalidArchive('broken')).toMatchObject({
      name: 'Libera7zError',
      code: 'INVALID_ARCHIVE',
      message: 'broken'
    })
    expect(unsupportedFeature('encrypted')).toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
      message: 'encrypted'
    })
  })

  it('throws only for an aborted operation', () => {
    expect(() => throwIfCancelled()).not.toThrow()
    const controller = new AbortController()
    controller.abort()

    expect(() => throwIfCancelled(controller.signal)).toThrowError(
      expect.objectContaining<Partial<Libera7zError>>({ code: 'CANCELLED' })
    )
  })
})

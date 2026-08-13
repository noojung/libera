import { describe, expect, it } from 'vitest'
import { resolveInitialLanguage } from './language'

describe('resolveInitialLanguage', () => {
  it('prefers a supported stored language', () => {
    expect(resolveInitialLanguage('en', ['ko-KR'])).toBe('en')
    expect(resolveInitialLanguage('ko', ['en-US'])).toBe('ko')
  })

  it('detects Korean from the system language list', () => {
    expect(resolveInitialLanguage(null, ['en-US', 'ko-KR'])).toBe('ko')
  })

  it('falls back to English for unsupported or non-Korean languages', () => {
    expect(resolveInitialLanguage('ja', ['ja-JP'])).toBe('en')
    expect(resolveInitialLanguage(null, [])).toBe('en')
  })
})

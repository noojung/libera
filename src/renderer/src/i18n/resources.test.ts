import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import { resources } from './resources'

function semanticKeys(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const semanticKey = key.replace(/_(one|other)$/, '')
    const path = prefix ? `${prefix}.${semanticKey}` : semanticKey
    return typeof child === 'object' ? semanticKeys(child, path) : [path]
  })
}

describe('translation resources', () => {
  it('keeps matching semantic keys in English and Korean', () => {
    const englishKeys = new Set(semanticKeys(resources.en.translation))
    const koreanKeys = new Set(semanticKeys(resources.ko.translation))
    expect(englishKeys).toEqual(koreanKeys)
  })

  it('interpolates counts and applies English plural forms', async () => {
    const instance = i18next.createInstance()
    await instance.init({ resources, lng: 'en', fallbackLng: 'en' })

    expect(instance.t('dropZone.selectedItems', { count: 1 })).toBe('1 selected item')
    expect(instance.t('dropZone.selectedItems', { count: 2 })).toBe('2 selected items')

    await instance.changeLanguage('ko')
    expect(instance.t('dropZone.selectedItems', { count: 2 })).toBe('선택한 항목 (2개)')
  })
})

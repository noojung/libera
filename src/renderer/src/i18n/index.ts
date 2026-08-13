import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { LANGUAGE_STORAGE_KEY, resolveInitialLanguage, type AppLanguage } from './language'
import { resources } from './resources'

function readStoredLanguage(): string | null {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
  } catch {
    return null
  }
}

const initialLanguage = resolveInitialLanguage(readStoredLanguage(), navigator.languages)

void i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLanguage,
    fallbackLng: 'en',
    supportedLngs: ['en', 'ko'],
    interpolation: { escapeValue: false },
    react: { useSuspense: false }
  })

export function applyLanguage(language: AppLanguage): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Language switching still works when storage is unavailable.
  }
  document.documentElement.lang = language
  void i18n.changeLanguage(language)
}

document.documentElement.lang = initialLanguage

export default i18n

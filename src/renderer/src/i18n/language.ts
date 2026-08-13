export type AppLanguage = 'en' | 'ko'

export const LANGUAGE_STORAGE_KEY = 'libera.language'
export const SUPPORTED_LANGUAGES: AppLanguage[] = ['en', 'ko']

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.includes(value as AppLanguage)
}

export function resolveInitialLanguage(
  storedLanguage: string | null | undefined,
  systemLanguages: readonly string[] = []
): AppLanguage {
  if (isAppLanguage(storedLanguage)) return storedLanguage
  return systemLanguages.some(language => language.toLowerCase().startsWith('ko')) ? 'ko' : 'en'
}

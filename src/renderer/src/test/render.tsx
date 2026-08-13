import React, { type ReactElement } from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next, { type i18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { resources } from '../i18n/resources'
import type { AppLanguage } from '../i18n/language'

export function createTestI18n(language: AppLanguage = 'en'): i18n {
  const instance = i18next.createInstance()
  void instance.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: 'en',
    supportedLngs: ['en', 'ko'],
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    initAsync: false
  })
  return instance
}

export function renderWithI18n(
  ui: ReactElement,
  options: RenderOptions & { language?: AppLanguage } = {}
) {
  const { language = 'en', ...renderOptions } = options
  const instance = createTestI18n(language)
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <I18nextProvider i18n={instance}>{children}</I18nextProvider>
  )
  return {
    user: userEvent.setup(),
    i18n: instance,
    ...render(ui, { ...renderOptions, wrapper: Wrapper })
  }
}

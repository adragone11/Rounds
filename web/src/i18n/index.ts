import { I18n } from 'i18n-js'
import { enUS, es as esLocale, pt as ptLocale } from 'date-fns/locale'
import type { Locale } from 'date-fns'

import en from './locales/en.json'
import es from './locales/es.json'
import pt from './locales/pt.json'

// Mirrors mobile's src/i18n/index.ts. Locale JSONs are a verbatim copy so web
// and mobile stay key-compatible — any new key added on mobile flows here.

const LANGUAGE_KEY = '@pip_language'

export type SupportedLanguage = 'en' | 'es' | 'pt'

export const LANGUAGES: { code: SupportedLanguage; name: string; nativeName: string }[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
]

const i18n = new I18n({ en, es, pt })
i18n.defaultLocale = 'en'
i18n.enableFallback = true

function readStored(): SupportedLanguage | null {
  if (typeof window === 'undefined') return null
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY)
    if (saved === 'en' || saved === 'es' || saved === 'pt') return saved
  } catch {
    // storage disabled
  }
  return null
}

function detectFromBrowser(): SupportedLanguage {
  if (typeof navigator === 'undefined') return 'en'
  const tag = (navigator.language || 'en').toLowerCase()
  if (tag.startsWith('es')) return 'es'
  if (tag.startsWith('pt')) return 'pt'
  return 'en'
}

export function initializeLanguage(): SupportedLanguage {
  const stored = readStored()
  const initial = stored ?? detectFromBrowser()
  i18n.locale = initial
  return initial
}

export function setLanguage(language: SupportedLanguage): void {
  i18n.locale = language
  try { localStorage.setItem(LANGUAGE_KEY, language) } catch { /* noop */ }
}

export function getCurrentLanguage(): SupportedLanguage {
  return i18n.locale as SupportedLanguage
}

export function t(key: string, options?: object): string {
  return i18n.t(key, options)
}

export function getDateLocale(): Locale {
  switch (getCurrentLanguage()) {
    case 'es': return esLocale
    case 'pt': return ptLocale
    default: return enUS
  }
}

export default i18n

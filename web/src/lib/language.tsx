import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Locale } from 'date-fns'
import {
  initializeLanguage,
  setLanguage as setI18nLanguage,
  t as translate,
  getDateLocale,
  type SupportedLanguage,
} from '../i18n'

// Mirrors mobile's src/context/LanguageContext.tsx. Per-device (localStorage),
// not synced to Supabase — matches the currency/theme strategy we established.

interface LanguageContextValue {
  language: SupportedLanguage
  setLanguage: (next: SupportedLanguage) => void
  t: (key: string, options?: object) => string
  dateLocale: Locale
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<SupportedLanguage>(() => initializeLanguage())

  // Keep multiple tabs in sync (storage event fires in *other* tabs).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== '@pip_language') return
      if (e.newValue === 'en' || e.newValue === 'es' || e.newValue === 'pt') {
        setI18nLanguage(e.newValue)
        setLanguageState(e.newValue)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setLanguage = useCallback((next: SupportedLanguage) => {
    setI18nLanguage(next)
    setLanguageState(next)
  }, [])

  // t() is a stable ref that captures the *current* language at render time;
  // re-creating it per language change triggers downstream rerenders.
  const t = useCallback((key: string, options?: object) => translate(key, options), [language])
  const dateLocale = useMemo(() => getDateLocale(), [language])

  const value = useMemo(
    () => ({ language, setLanguage, t, dateLocale }),
    [language, setLanguage, t, dateLocale],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used inside LanguageProvider')
  return ctx
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

/** Theme preference, mirrored from mobile's src/context/ThemeContext.tsx.
 *
 *  Per-device: persisted to localStorage, NOT synced to the Supabase profile
 *  (matches mobile). First-run default follows OS `prefers-color-scheme`
 *  unless the user overrode it.
 *
 *  Applied by toggling `data-theme="dark"` on <html>. CSS variables in
 *  index.css flip all token-based surfaces; Tailwind `dark:` variants are
 *  wired to the same attribute via `@custom-variant dark`. */

const THEME_KEY = '@app_theme'

export type Theme = 'light' | 'dark'

interface ThemeContextValue {
  theme: Theme
  setTheme: (next: Theme) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

function readStored(): Theme | null {
  if (typeof window === 'undefined') return null
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // storage disabled
  }
  return null
}

function detectDefault(): Theme {
  if (typeof window === 'undefined') return 'light'
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyToDocument(theme: Theme) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
  // Native form controls / scrollbars pick this up for free.
  document.documentElement.style.colorScheme = theme
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStored() ?? detectDefault())

  // Apply on mount + on every theme change.
  useEffect(() => {
    applyToDocument(theme)
  }, [theme])

  // Follow OS preference when the user hasn't chosen manually.
  useEffect(() => {
    if (readStored()) return
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (!readStored()) setThemeState(mq.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Keep multiple tabs in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return
      if (e.newValue === 'light' || e.newValue === 'dark') {
        setThemeState(e.newValue)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setTheme = useCallback((next: Theme) => {
    try { localStorage.setItem(THEME_KEY, next) } catch { /* noop */ }
    setThemeState(next)
  }, [])

  const toggle = useCallback(() => {
    setThemeState(prev => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      try { localStorage.setItem(THEME_KEY, next) } catch { /* noop */ }
      return next
    })
  }, [])

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}

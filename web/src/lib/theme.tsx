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

export type Theme = 'light' | 'dark'

interface ThemeContextValue {
  theme: Theme
  setTheme: (next: Theme) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

function applyToDocument(theme: Theme) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.style.colorScheme = theme
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Force light mode only for Rounds beta
  const [theme] = useState<Theme>('light')

  // Apply on mount + on every theme change.
  useEffect(() => {
    applyToDocument(theme)
  }, [theme])

  // OS preference listener disabled for Rounds beta (light mode only)

  // Storage sync disabled for Rounds beta (light mode only)

  // Disabled for Rounds beta (light mode only)
  const setTheme = useCallback((_next: Theme) => {}, [])
  const toggle = useCallback(() => {}, [])

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}

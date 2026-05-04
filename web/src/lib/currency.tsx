import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

/** Currency preference, mirrored from mobile's src/context/CurrencyContext.tsx.
 *
 *  Per-device: persisted to localStorage, NOT synced to the Supabase profile.
 *  If users switch between phone and web they'll re-select once per device.
 *  (Mobile uses AsyncStorage with the same key shape. Same 7 codes.) */

const CURRENCY_KEY = '@pip_currency'

export type SupportedCurrency = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'MXN' | 'BRL' | 'AUD'

export interface CurrencyInfo {
  code: SupportedCurrency
  symbol: string
  name: string
  locale: string
}

export const CURRENCIES: CurrencyInfo[] = [
  { code: 'USD', symbol: '$', name: 'US Dollar', locale: 'en-US' },
  { code: 'EUR', symbol: '€', name: 'Euro', locale: 'de-DE' },
  { code: 'GBP', symbol: '£', name: 'British Pound', locale: 'en-GB' },
  { code: 'CAD', symbol: '$', name: 'Canadian Dollar', locale: 'en-CA' },
  { code: 'MXN', symbol: '$', name: 'Mexican Peso', locale: 'es-MX' },
  { code: 'BRL', symbol: 'R$', name: 'Brazilian Real', locale: 'pt-BR' },
  { code: 'AUD', symbol: '$', name: 'Australian Dollar', locale: 'en-AU' },
]

interface CurrencyContextValue {
  currency: SupportedCurrency
  currencyInfo: CurrencyInfo
  setCurrency: (c: SupportedCurrency) => void
  formatCurrency: (amount: number, options?: { compact?: boolean }) => string
}

const CurrencyContext = createContext<CurrencyContextValue | undefined>(undefined)

function detectDefault(): SupportedCurrency {
  // First-run leapfrog: mobile has a TODO for this; web can use navigator.language.
  // Map a handful of locales → currency so the default matches user expectation
  // without waiting for them to open Settings.
  if (typeof navigator === 'undefined') return 'USD'
  const lang = (navigator.language || 'en-US').toLowerCase()
  if (lang.startsWith('en-gb')) return 'GBP'
  if (lang.startsWith('en-ca') || lang === 'fr-ca') return 'CAD'
  if (lang.startsWith('en-au')) return 'AUD'
  if (lang.startsWith('es-mx')) return 'MXN'
  if (lang.startsWith('pt-br')) return 'BRL'
  if (lang.startsWith('de') || lang.startsWith('fr') || lang.startsWith('es')
      || lang.startsWith('it') || lang.startsWith('pt') || lang.startsWith('nl')) return 'EUR'
  return 'USD'
}

function readStored(): SupportedCurrency {
  if (typeof window === 'undefined') return 'USD'
  try {
    const saved = localStorage.getItem(CURRENCY_KEY)
    if (saved && CURRENCIES.some(c => c.code === saved)) {
      return saved as SupportedCurrency
    }
  } catch {
    // localStorage disabled → fall through
  }
  return detectDefault()
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<SupportedCurrency>(readStored)

  useEffect(() => {
    // Keep multiple tabs in sync.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== CURRENCY_KEY || !e.newValue) return
      if (CURRENCIES.some(c => c.code === e.newValue)) {
        setCurrencyState(e.newValue as SupportedCurrency)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setCurrency = useCallback((next: SupportedCurrency) => {
    try { localStorage.setItem(CURRENCY_KEY, next) } catch { /* noop */ }
    setCurrencyState(next)
  }, [])

  const currencyInfo = useMemo(
    () => CURRENCIES.find(c => c.code === currency) ?? CURRENCIES[0],
    [currency],
  )

  const formatCurrency = useCallback((amount: number, options?: { compact?: boolean }) => {
    const info = currencyInfo
    if (!Number.isFinite(amount)) return `${info.symbol}0`

    if (options?.compact) {
      if (Math.abs(amount) >= 1_000_000) {
        const m = amount / 1_000_000
        const s = m.toFixed(1)
        return `${info.symbol}${s.endsWith('.0') ? s.slice(0, -2) : s}M`
      }
      if (Math.abs(amount) >= 1_000) {
        const k = amount / 1_000
        const s = k.toFixed(1)
        return `${info.symbol}${s.endsWith('.0') ? s.slice(0, -2) : s}K`
      }
    }

    try {
      return new Intl.NumberFormat(info.locale, {
        style: 'currency',
        currency: info.code,
        minimumFractionDigits: 0,
        maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
      }).format(amount)
    } catch {
      return `${info.symbol}${Math.round(amount)}`
    }
  }, [currencyInfo])

  const value = useMemo(
    () => ({ currency, currencyInfo, setCurrency, formatCurrency }),
    [currency, currencyInfo, setCurrency, formatCurrency],
  )

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>
}

export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext)
  if (!ctx) throw new Error('useCurrency must be used inside CurrencyProvider')
  return ctx
}

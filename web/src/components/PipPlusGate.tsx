import { useState, type ReactNode } from 'react'
import { useProfile } from '../lib/profile'
import { useLanguage } from '../lib/language'
import type { PipPlusFeature } from '../lib/entitlements'

// Per-feature copy. Keeps the lock screen specific to *what* the user
// is trying to use rather than a generic "Upgrade for more" — specific
// copy converts better because the user already knows what they want.
const FEATURE_COPY: Record<PipPlusFeature, { title: string; tagline: string }> = {
  'schedule-builder': {
    title: 'Schedule Builder',
    tagline: 'Plan your whole week in 5 minutes — drag, drop, and publish a route-aware schedule.',
  },
  'smart-placement': {
    title: 'Smart Placement',
    tagline: 'Pip suggests the best day for every new client based on your existing route.',
  },
  'custom-templates': {
    title: 'Custom Templates',
    tagline: 'Save reusable job and message templates so you stop typing the same thing twice.',
  },
  'reports': {
    title: 'Reports',
    tagline: 'Earnings, unpaid invoices, follow-ups, and per-client trends — all in one place.',
  },
}

const APP_STORE_URL = 'https://apps.apple.com/app/id6756827353'

/** Gate Pip+ features. Web is read-only on entitlement — mobile owns the
 *  paywall (RevenueCat → profiles.is_plus). When a free user hits a gated
 *  feature we explain that upgrades happen on mobile, since we can't run
 *  IAP on the web. */
export default function PipPlusGate({
  feature,
  children,
  layout = 'page',
}: {
  feature: PipPlusFeature
  children: ReactNode
  layout?: 'page' | 'inline'
}) {
  const { profile, loading } = useProfile()
  const { t } = useLanguage()
  const [modalOpen, setModalOpen] = useState(false)

  if (loading) return null
  if (profile.isPlus) return <>{children}</>

  const copy = FEATURE_COPY[feature]

  if (layout === 'inline') {
    return (
      <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-left">
        <div className="flex items-start gap-2">
          <span className="inline-block mt-0.5 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-600 text-white">Pip+</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-gray-900">{copy.title}</p>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {t('web.paywall.upgradeOnMobile') || 'Upgrade in the Pip mobile app to unlock this on web.'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8 bg-surface-page">
      <div className="max-w-md w-full bg-surface-card rounded-2xl p-8 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04),0_1px_3px_rgba(0,0,0,0.04)] ring-1 ring-edge-default">
        <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-blue-50 dark:bg-blue-500/15 flex items-center justify-center">
          <svg className="w-7 h-7 text-blue-600 dark:text-blue-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </div>
        <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-blue-600 mb-1.5">Pip+ feature</div>
        <h1 className="text-2xl font-bold tracking-[-0.01em] text-ink-primary mb-2">{copy.title}</h1>
        <p className="text-sm text-ink-secondary mb-6">{copy.tagline}</p>
        <button
          onClick={() => setModalOpen(true)}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm py-2.5 rounded-lg transition-colors"
        >
          Unlock with Pip+
        </button>
        <p className="text-xs text-ink-tertiary mt-3">Subscriptions are managed in the iOS app.</p>
      </div>
      {modalOpen && <UpgradeModal onClose={() => setModalOpen(false)} />}
    </div>
  )
}

/** Pip+ is RevenueCat-managed on mobile — there's no web checkout. The modal
 *  explains that and points users to the App Store link. Sidebar already has
 *  a persistent app link, but this is the conversion moment. */
function UpgradeModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-surface-card w-full max-w-md rounded-2xl shadow-2xl ring-1 ring-edge-default overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start justify-between mb-4">
            <h2 className="text-xl font-bold tracking-[-0.01em] text-ink-primary">Upgrade to Pip+</h2>
            <button onClick={onClose} className="p-1 -mr-1 rounded-md hover:bg-gray-100 text-ink-tertiary">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="text-sm text-ink-secondary mb-5">Pip+ unlocks the planning power and reporting tools that make running a service business effortless.</p>
          <ul className="space-y-2.5 mb-6">
            {[
              'Schedule Builder — plan your week in 5 minutes',
              'Smart Placement — auto-suggest the best day',
              'Custom job & message templates',
              'Reports — earnings, follow-ups, per-client trends',
            ].map(line => (
              <li key={line} className="flex items-start gap-2.5 text-sm text-ink-primary">
                <svg className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                {line}
              </li>
            ))}
          </ul>
          <a
            href={APP_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm py-3 rounded-lg text-center transition-colors"
          >
            Open in iOS app
          </a>
          <p className="text-xs text-ink-tertiary text-center mt-3">Subscriptions are managed via the App Store.</p>
        </div>
      </div>
    </div>
  )
}

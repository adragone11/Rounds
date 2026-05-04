import { useEffect } from 'react'
import { useProfile } from '../lib/profile'
import { useLanguage } from '../lib/language'

/** "Manage Subscription" — visual parity with EditProfileModal:
 *  centered white card, back-arrow header, sectioned body, primary CTA at
 *  bottom. RevenueCat is the source of truth on mobile; for management we
 *  deep-link to the App Store subscriptions page. */
const APP_STORE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions'

export default function SubscriptionModal({ onClose }: { onClose: () => void }) {
  const { profile } = useProfile()
  const { t } = useLanguage()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const isPlus = profile.isPlus

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header — back-arrow pattern, matches EditProfileModal */}
        <div className="p-5 border-b border-gray-100 shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="text-blue-600 hover:text-blue-700 p-1 -ml-1"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <p className="text-lg font-bold text-gray-900">{t('subscription.manageTitle') || 'Manage Subscription'}</p>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Plan tile — same shape/position as the EditProfile avatar */}
          <div className="flex flex-col items-center gap-3">
            <div className={`w-20 h-20 rounded-2xl flex items-center justify-center text-white ${isPlus ? 'bg-blue-600' : 'bg-gray-400'}`}>
              <CrownIcon />
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-gray-900">
                {isPlus ? 'Pip+' : (t('subscription.free') || 'Free Plan')}
              </p>
              <p className="text-sm text-gray-500 mt-0.5">
                {isPlus
                  ? (t('subscription.plusActive') || 'Subscription active')
                  : (t('subscription.freeStatus') || 'Limited features')}
              </p>
            </div>
          </div>

          {/* Action stack */}
          {isPlus ? (
            <div className="space-y-2.5">
              <a
                href={APP_STORE_SUBSCRIPTIONS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
              >
                <ExternalLinkIcon />
                {t('subscription.manage') || 'Manage in App Store'}
              </a>
              <a
                href={APP_STORE_SUBSCRIPTIONS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-3 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold transition-colors"
              >
                <RestoreIcon />
                {t('subscription.restore') || 'Restore Purchases'}
              </a>
              <p className="pt-2 text-center text-xs text-gray-500 leading-relaxed">
                {t('subscription.appleNote') || 'Plan details, renewal date, and billing live in your Apple ID settings. Use the button above to manage or cancel.'}
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-blue-50 ring-1 ring-blue-100 p-4 text-center">
              <p className="text-sm font-semibold text-blue-900">
                {t('subscription.upgradeOnMobile') || 'Upgrade in the Pip mobile app'}
              </p>
              <p className="text-xs text-blue-700/80 mt-1 leading-relaxed">
                {t('subscription.syncsToWeb') || 'Your subscription syncs to web automatically once active.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CrownIcon() {
  return (
    <svg className="w-9 h-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 17h19l-2-9-5 4-3-7-3 7-5-4-1 9z" />
    </svg>
  )
}

function ExternalLinkIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M18 13v7a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h7" />
    </svg>
  )
}

function RestoreIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 11-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

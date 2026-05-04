import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { CURRENCIES, useCurrency, type SupportedCurrency } from '../lib/currency'
import { LANGUAGES, type SupportedLanguage } from '../i18n'
import { useLanguage } from '../lib/language'
import { useTheme } from '../lib/theme'
import { useProfile } from '../lib/profile'
import EditProfileModal from '../components/EditProfileModal'
import MessageTemplatesModal from '../components/MessageTemplatesModal'
import SubscriptionModal from '../components/SubscriptionModal'

export default function Settings() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const { currency, currencyInfo, setCurrency } = useCurrency()
  const { language, setLanguage, t } = useLanguage()
  const { theme, toggle: toggleTheme } = useTheme()
  const { profile } = useProfile()
  const [currencyPickerOpen, setCurrencyPickerOpen] = useState(false)
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [subscriptionOpen, setSubscriptionOpen] = useState(false)
  const activeLanguage = LANGUAGES.find(l => l.code === language) ?? LANGUAGES[0]
  const displayName = profile.fullName || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'
  const initial = displayName.charAt(0).toUpperCase()

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-surface-page">
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Mobile-parity layout: each section is a labeled card. Profile +
            Subscription are dedicated feature cards at the top. */}
        <div className="max-w-[720px] mx-auto px-6 pt-12 pb-24">
          <h1 className="text-[28px] font-bold text-ink-primary tracking-[-0.02em] leading-tight">{t('settings.title')}</h1>
          <p className="text-[13px] text-ink-secondary mt-1 mb-7">
            {t('settings.subtitle') || 'Manage your account, app preferences, and subscription.'}
          </p>

          {/* Profile — its own card, mirrors mobile */}
          <button
            onClick={() => setProfileOpen(true)}
            className="w-full bg-white rounded-xl ring-1 ring-gray-200 p-4 flex items-center gap-4 text-left hover:ring-gray-300 hover:bg-gray-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 mb-3"
          >
            <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center text-white text-xl font-bold shrink-0">
              {initial}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-gray-900 truncate">{displayName}</p>
              <p className="text-sm text-gray-500 truncate">
                {profile.startAddress || user?.email || (t('settings.profile.editCta') || 'Edit Profile')}
              </p>
            </div>
            <Chevron />
          </button>

          {/* Subscription — its own card, same shape as profile */}
          <button
            onClick={() => setSubscriptionOpen(true)}
            className="w-full bg-white rounded-xl ring-1 ring-gray-200 p-4 flex items-center gap-4 text-left hover:ring-gray-300 hover:bg-gray-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-white shrink-0 ${profile.isPlus ? 'bg-blue-600' : 'bg-gray-400'}`}>
              <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 17h19l-2-9-5 4-3-7-3 7-5-4-1 9z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-gray-900 truncate">
                {profile.isPlus ? 'Pip+' : (t('subscription.free') || 'Free Plan')}
              </p>
              <p className="text-sm text-gray-500 truncate">
                {profile.isPlus
                  ? (t('subscription.manage') || 'Manage in App Store')
                  : (t('subscription.upgradeOnMobile') || 'Upgrade in the Pip mobile app')}
              </p>
            </div>
            {profile.isPlus && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/20 shrink-0">
                {t('subscription.activeBadge') || 'Active'}
              </span>
            )}
            <Chevron />
          </button>

          {/* Each section header sits above its own card. Matches mobile. */}
          <Section title={t('settings.sections.appearance').toUpperCase()}>
            <SettingRow
              tone="violet"
              icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>}
              label={t('settings.appearance.darkMode')}
              sub={theme === 'dark' ? 'On' : 'Off'}
              trailing={<Toggle on={theme === 'dark'} onClick={toggleTheme} />}
              onClick={toggleTheme}
            />
          </Section>

          <Section title={t('settings.sections.language').toUpperCase()}>
            <SettingRow
              tone="blue"
              icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>}
              label={t('settings.language.changeLanguage')}
              trailing={<span className="flex items-center gap-1.5 text-[13px] text-ink-secondary">{activeLanguage.nativeName} <Chevron /></span>}
              onClick={() => setLanguagePickerOpen(true)}
              border
            />
            <SettingRow
              tone="green"
              icon={<span className="text-[15px] font-bold">{currencyInfo.symbol}</span>}
              label={t('settings.currency.changeCurrency')}
              trailing={<span className="flex items-center gap-1.5 text-[13px] text-ink-secondary">{currency} <Chevron /></span>}
              onClick={() => setCurrencyPickerOpen(true)}
            />
          </Section>

          <Section title={t('settings.sections.messaging').toUpperCase()}>
            <SettingRow
              tone="amber"
              icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>}
              label={t('settings.messaging.messageTemplates')}
              trailing={<Chevron />}
              onClick={() => setTemplatesOpen(true)}
            />
          </Section>

          <Section title="REPORTS">
            <SettingRow
              tone="green"
              icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>}
              label="Reports"
              sub="Earnings, hours, job history"
              trailing={profile.isPlus ? <Chevron /> : <PlusBadgeAndChevron />}
              onClick={() => navigate('/settings/reports')}
            />
          </Section>

          <Section title={t('settings.sections.about').toUpperCase()}>
            <SettingRow
              tone="gray"
              icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16v.01" /></svg>}
              label={t('settings.about.aboutPip') || 'About Pip'}
              sub="Version 1.1.2"
              trailing={<Chevron />}
            />
          </Section>

          {/* Sign Out — full red. The previous tinted version got lost in the
              page; user wants the destructive action to actually read as
              destructive. */}
          {user && (
            <div className="pt-2">
              <button
                onClick={signOut}
                className="w-full py-3 rounded-lg bg-red-600 text-white text-sm font-semibold flex items-center justify-center gap-2 hover:bg-red-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" /></svg>
                {t('auth.signOut') || 'Sign Out'}
              </button>
              <p className="text-center text-xs text-gray-400 mt-3">Pip v1.1.2</p>
            </div>
          )}
        </div>
      </div>

      {currencyPickerOpen && (
        <CurrencyPicker
          active={currency}
          onPick={next => { setCurrency(next); setCurrencyPickerOpen(false) }}
          onClose={() => setCurrencyPickerOpen(false)}
        />
      )}

      {languagePickerOpen && (
        <LanguagePicker
          active={language}
          onPick={next => { setLanguage(next); setLanguagePickerOpen(false) }}
          onClose={() => setLanguagePickerOpen(false)}
          title={t('settings.language.changeLanguage')}
        />
      )}

      {profileOpen && <EditProfileModal onClose={() => setProfileOpen(false)} />}

      {templatesOpen && <MessageTemplatesModal onClose={() => setTemplatesOpen(false)} />}

      {subscriptionOpen && <SubscriptionModal onClose={() => setSubscriptionOpen(false)} />}
    </div>
  )
}

function LanguagePicker({ active, onPick, onClose, title }: {
  active: SupportedLanguage
  onPick: (l: SupportedLanguage) => void
  onClose: () => void
  title: string
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-sm max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-5 border-b border-gray-100 shrink-0 flex items-center justify-between">
          <p className="text-lg font-bold text-gray-900">{title}</p>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {LANGUAGES.map(l => {
            const isActive = l.code === active
            return (
              <button
                key={l.code}
                onClick={() => onPick(l.code)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors ${isActive ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'}`}
              >
                <span className="w-8 text-center text-xs font-bold text-gray-500 uppercase">{l.code}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{l.nativeName}</p>
                  <p className="text-xs text-gray-500">{l.name}</p>
                </div>
                {isActive && (
                  <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function CurrencyPicker({ active, onPick, onClose }: {
  active: SupportedCurrency
  onPick: (c: SupportedCurrency) => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-sm max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-5 border-b border-gray-100 shrink-0 flex items-center justify-between">
          <p className="text-lg font-bold text-gray-900">Currency</p>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {CURRENCIES.map(c => {
            const isActive = c.code === active
            return (
              <button
                key={c.code}
                onClick={() => onPick(c.code)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors ${isActive ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'}`}
              >
                <span className="w-8 text-center text-lg font-bold text-gray-500">{c.symbol}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{c.name}</p>
                  <p className="text-xs text-gray-500">{c.code}</p>
                </div>
                {isActive && (
                  <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Section: uppercase header above its own dedicated card. Matches mobile —
 *  every settings group reads as a labeled, distinct surface. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2 px-1">{title}</h2>
      <div className="bg-white rounded-xl ring-1 ring-gray-200 overflow-hidden">{children}</div>
    </div>
  )
}

type IconTone = 'gray' | 'blue' | 'green' | 'amber' | 'violet'

// Class-based tones so dark-mode overrides in index.css can flip the
// tint surfaces. Inline styles wouldn't respond to [data-theme="dark"].
const TONE_CLASSES: Record<IconTone, string> = {
  gray:   'bg-gray-100 text-gray-500',
  blue:   'bg-blue-50 text-blue-600',
  green:  'bg-emerald-50 text-emerald-600',
  amber:  'bg-amber-50 text-amber-600',
  violet: 'bg-violet-50 text-violet-600',
}

function SettingRow({ icon, label, sub, trailing, border = false, onClick, tone = 'gray' }: {
  icon: React.ReactNode
  label: string
  sub?: string
  trailing?: React.ReactNode
  border?: boolean
  onClick?: () => void
  tone?: IconTone
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3.5 px-4 py-3.5 text-left hover:bg-gray-50 transition-colors focus-visible:outline-none focus-visible:bg-blue-50/50 ${border ? 'border-b border-edge-default' : ''}`}
    >
      <span className={`w-8 h-8 rounded-[9px] flex items-center justify-center shrink-0 ${TONE_CLASSES[tone]}`}>
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] font-semibold text-ink-primary">{label}</span>
        {sub && <span className="block text-[12px] text-ink-secondary mt-px">{sub}</span>}
      </span>
      {trailing}
    </button>
  )
}

function Chevron() {
  return <svg className="w-4 h-4 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
}

function PlusBadgeAndChevron() {
  return (
    <span className="flex items-center gap-2 shrink-0">
      <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-600 text-white">Pip+</span>
      <Chevron />
    </span>
  )
}

function Toggle({ on, onClick }: { on?: boolean; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <span
      role="switch"
      aria-checked={!!on}
      onClick={e => { e.stopPropagation(); onClick?.(e) }}
      className="w-[42px] h-6 rounded-full relative cursor-pointer shrink-0 transition-colors"
      style={{ background: on ? '#34C759' : '#E5E5EA' }}
    >
      <span
        className={`w-5 h-5 bg-white rounded-full absolute top-0.5 shadow-sm transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
      />
    </span>
  )
}

import { useEffect, useState } from 'react'
import { useProfile } from '../lib/profile'
import { useAuth } from '../lib/auth'
import { useLanguage } from '../lib/language'
import { useStore } from '../store'
import { deleteAllJobs, deleteAllData } from '../lib/dataReset'
import AddressAutocomplete from './AddressAutocomplete'

export default function EditProfileModal({ onClose }: { onClose: () => void }) {
  const { profile, save } = useProfile()
  const { user, signOut } = useAuth()
  const { t } = useLanguage()
  const { refreshClients, refreshJobs, clearLocalScheduleState } = useStore()

  const [fullName, setFullName] = useState(profile.fullName ?? '')
  const [startAddress, setStartAddress] = useState(profile.startAddress ?? '')
  const [startCoords, setStartCoords] = useState<{ lat: number; lng: number } | null>(
    profile.startLat != null && profile.startLng != null
      ? { lat: profile.startLat, lng: profile.startLng }
      : null,
  )
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dirty =
    fullName.trim() !== (profile.fullName ?? '') ||
    startAddress.trim() !== (profile.startAddress ?? '') ||
    (startCoords?.lat ?? null) !== profile.startLat ||
    (startCoords?.lng ?? null) !== profile.startLng

  const addressSaved = !!profile.startAddress && profile.startLat != null && profile.startLng != null

  const initial = (fullName || user?.email || 'A').charAt(0).toUpperCase()

  const handleSave = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    const trimmedAddress = startAddress.trim()
    const patch = {
      fullName: fullName.trim() || null,
      startAddress: trimmedAddress || null,
      startLat: trimmedAddress ? startCoords?.lat ?? null : null,
      startLng: trimmedAddress ? startCoords?.lng ?? null : null,
    }
    const err = await save(patch)
    setSaving(false)
    if (err) { setError(err); return }
    onClose()
  }

  const handleClearAddress = () => {
    setStartAddress('')
    setStartCoords(null)
  }

  const handleDeleteAllJobs = async () => {
    if (!user) return
    if (!confirm(t('settings.deleteAllJobs.message') || 'Delete every job? This is permanent.')) return
    if (!confirm(t('settings.deleteAllJobs.finalConfirm') || 'Are you absolutely sure? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    const err = await deleteAllJobs(user.id)
    if (err) { setError(err); setBusy(false); return }
    // Web-only: also wipe placements + recurrence meta. Without this the
    // calendar keeps painting recurring chips even though the underlying
    // jobs are gone, while the sidebar correctly shows everyone unplaced.
    clearLocalScheduleState()
    await refreshJobs()
    setBusy(false)
    alert(t('settings.deleteAllJobs.successMessage') || 'All jobs deleted.')
  }

  const handleResetData = async () => {
    if (!user) return
    if (!confirm(t('settings.deleteData.step1Message') || 'Wipe all clients and jobs? This is permanent.')) return
    if (!confirm(t('settings.deleteData.finalConfirm') || 'Last chance. This deletes everything.')) return
    setBusy(true)
    setError(null)
    const err = await deleteAllData(user.id)
    if (err) { setError(err); setBusy(false); return }
    await Promise.all([refreshClients(), refreshJobs()])
    setBusy(false)
    onClose()
    alert(t('settings.deleteData.successMessage') || 'All data deleted.')
  }

  const handleDeleteAccount = async () => {
    if (!user) return
    if (!confirm(t('settings.deleteAccount.step1Message') || 'Delete your account and all data? This is permanent.')) return
    const typed = window.prompt(t('settings.deleteAccount.step2Message') || 'Type DELETE to confirm.')
    const ok = typed && ['DELETE', 'ELIMINAR', 'EXCLUIR'].includes(typed.toUpperCase())
    if (!ok) {
      if (typed != null) alert(t('settings.deleteAccount.typeMismatch') || 'You did not type DELETE.')
      return
    }
    setBusy(true)
    setError(null)
    const err = await deleteAllData(user.id)
    if (err) { setError(err); setBusy(false); return }
    await signOut()
  }

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
        {/* Header */}
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
            <p className="text-lg font-bold text-gray-900">{t('settings.profile.title') || 'Edit Profile'}</p>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Avatar */}
          <div className="flex justify-center">
            <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-white text-3xl font-bold" style={{ backgroundColor: '#3B82F6' }}>
              {initial}
            </div>
          </div>

          {/* Personal information */}
          <Section title={t('settings.profile.personalInfo') || 'Personal Information'}>
            <Row icon={<UserIcon />}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-gray-700">{t('settings.profile.name') || 'Name'}</span>
                <input
                  type="text"
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  placeholder={t('settings.profile.namePlaceholder') || 'Your name'}
                  className="flex-1 text-right text-sm font-semibold text-gray-900 bg-transparent focus:outline-none placeholder:text-gray-300"
                />
              </div>
            </Row>
            <Divider />
            <Row icon={<MailIcon />}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-gray-700">{t('settings.profile.email') || 'Email'}</span>
                <span className="text-sm text-gray-400 truncate">{user?.email}</span>
              </div>
            </Row>
          </Section>

          {/* Starting address */}
          <Section title={t('settings.profile.startAddressTitle') || 'Starting Address'}>
            <div className="px-4 py-3">
              <div className="flex items-start gap-3">
                <PinIcon />
                <div className="flex-1 min-w-0">
                  <AddressAutocomplete
                    value={startAddress}
                    onChange={v => { setStartAddress(v); setStartCoords(null) }}
                    onSelect={r => { setStartAddress(r.address); setStartCoords({ lat: r.lat, lng: r.lng }) }}
                    placeholder={t('settings.profile.startAddressPlaceholder') || 'Home or office address'}
                    className="w-full text-sm font-semibold text-gray-900 bg-transparent focus:outline-none placeholder:text-gray-300"
                  />
                  <div className="flex items-center justify-between mt-1.5 gap-2">
                    {addressSaved && startAddress === (profile.startAddress ?? '') ? (
                      <p className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        {t('settings.profile.addressSaved') || 'Address saved'}
                      </p>
                    ) : startAddress && !startCoords ? (
                      <p className="text-[11px] text-amber-600">
                        {t('settings.profile.addressNeedsPick') || 'Pick from the dropdown so we can map your route.'}
                      </p>
                    ) : (
                      <p className="text-[11px] text-gray-400">
                        {t('settings.profile.startAddressHint') || 'Used as the start point for daily routes.'}
                      </p>
                    )}
                    {startAddress && (
                      <button
                        onClick={handleClearAddress}
                        className="text-[11px] font-semibold text-gray-400 hover:text-gray-600 shrink-0"
                      >
                        {t('common.clear') || 'Clear'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </Section>

          {/* Danger Zone */}
          <div>
            <p className="text-[11px] font-bold text-red-500 uppercase tracking-wider mb-2 px-1">
              {t('settings.dangerZoneLabel') || 'Danger Zone'}
            </p>
            <div className="bg-white rounded-2xl border border-red-100 overflow-hidden">
              <DangerRow
                icon={<CalendarXIcon />}
                label={t('settings.dangerZone.deleteAllJobs') || 'Delete All Jobs'}
                onClick={handleDeleteAllJobs}
                disabled={busy}
              />
              <Divider />
              <DangerRow
                icon={<TrashIcon />}
                label={t('settings.dangerZone.resetData') || 'Reset Data'}
                onClick={handleResetData}
                disabled={busy}
              />
              <Divider />
              <DangerRow
                icon={<UserXIcon />}
                label={t('settings.dangerZone.deleteAccount') || 'Delete Account'}
                onClick={handleDeleteAccount}
                disabled={busy}
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg p-3 bg-red-50 border border-red-200">
              <p className="text-xs font-semibold text-red-700">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-100 shrink-0">
          <button
            onClick={handleSave}
            disabled={!dirty || saving || busy}
            className="w-full py-3 rounded-xl text-sm font-bold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: '#3B82F6' }}
          >
            {saving ? (t('common.saving') || 'Saving…') : (t('settings.profile.save') || 'Save Profile')}
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 px-1">{title}</p>
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">{children}</div>
    </div>
  )
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <span className="shrink-0 text-blue-500">{icon}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

function Divider() {
  return <div className="h-px bg-gray-100 mx-4" />
}

function DangerRow({ icon, label, onClick, disabled }: {
  icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full px-4 py-3.5 flex items-center gap-3 text-left hover:bg-red-50/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span className="shrink-0 text-red-500">{icon}</span>
      <span className="flex-1 text-sm font-semibold text-red-500">{label}</span>
      <svg className="w-4 h-4 text-red-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
      </svg>
    </button>
  )
}

function UserIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
    </svg>
  )
}
function MailIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>
  )
}
function PinIcon() {
  return (
    <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
    </svg>
  )
}
function CalendarXIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 14.25l4.5 4.5m0-4.5l-4.5 4.5" />
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  )
}
function UserXIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 10.5h-6m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
    </svg>
  )
}

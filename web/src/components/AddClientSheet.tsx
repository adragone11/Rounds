import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useProfile } from '../lib/profile'
import { useToast } from '../lib/toast'
import { useLanguage } from '../lib/language'
import AddressAutocomplete from './AddressAutocomplete'
import type { DayOfWeek } from '../types'

const DAYS: { day: DayOfWeek; label: string }[] = [
  { day: 0, label: 'S' }, { day: 1, label: 'M' }, { day: 2, label: 'T' },
  { day: 3, label: 'W' }, { day: 4, label: 'T' }, { day: 5, label: 'F' },
  { day: 6, label: 'S' },
]
const BLOCKED_COLOR = '#EF4444'

/**
 * Modal sheet for creating a client. Mirrors the field set we ask for on
 * mobile (name + optional phone, address, blocked days) so a user planning
 * on web can fully onboard a client without bouncing to the phone.
 *
 * Address geocoding waits for an autocomplete selection — typing alone
 * doesn't commit coords. The pin color signals state: green = saved,
 * amber = typed but not selected, gray = empty. Blocked Days is Pip+; free
 * users see a locked tile with the upgrade hint instead of toggles.
 */
export default function AddClientSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated?: (id: string) => void
}) {
  const store = useStore()
  const { profile } = useProfile()
  const toast = useToast()
  const { t } = useLanguage()
  const isPlus = profile.isPlus

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [blockedDays, setBlockedDays] = useState<DayOfWeek[]>([])
  const [saving, setSaving] = useState(false)

  // Reset on open so the sheet doesn't show stale draft data after a
  // previous save/cancel (modal stays mounted so animations can finish).
  useEffect(() => {
    if (!open) return
    setName('')
    setPhone('')
    setAddress('')
    setCoords(null)
    setBlockedDays([])
    setSaving(false)
  }, [open])

  // Esc closes the sheet — matches MessageTemplatesModal pattern.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, saving, onClose])

  if (!open) return null

  const addrTrim = address.trim()
  const addrGeocoded = !!coords && addrTrim.length > 0
  const addrPending = addrTrim.length > 0 && !coords
  const pinColor = addrGeocoded ? '#16A34A' : addrPending ? '#D97706' : '#9CA3AF'

  const toggleBlockedDay = (d: DayOfWeek) => {
    setBlockedDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    const id = await store.addClient(trimmed, addrTrim, coords, phone.trim() || undefined)
    if (id) {
      // Save blocked days for both tiers — free users keep them as
      // saved-for-later metadata. Smart Placement (Pip+) is what actually
      // honors them at scheduling time.
      if (blockedDays.length > 0) {
        store.updateClientBlockedDays(id, blockedDays)
      }
      toast(t('clientsWeb.clientAdded') || 'Client added')
      onCreated?.(id)
      onClose()
    } else {
      toast(t('clientsWeb.addFailed') || 'Could not add client')
    }
    setSaving(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => { if (!saving) onClose() }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-gray-100 shrink-0 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-[18px] font-bold text-gray-900 leading-tight">
              {t('clientsWeb.addClient') || 'Add Client'}
            </h2>
            <p className="text-[12px] text-gray-400 mt-0.5">
              {t('clientsWeb.addClientSubtitle') || 'Just a name to start — the rest is optional.'}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            className="w-7 h-7 -mr-1 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-40"
            title={t('common.cancel') || 'Cancel'}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Name (required) */}
          <div>
            <label className="block text-[12px] font-semibold text-gray-900 mb-1.5">
              {t('common.name') || 'Name'}
            </label>
            <div className="flex items-center gap-2 bg-surface-chip rounded-[10px] px-3 py-2.5 border border-transparent focus-within:border-blue-500 focus-within:bg-white">
              <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
              </svg>
              <input
                autoFocus
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('clientsWeb.namePlaceholder') || 'e.g., Sarah Johnson'}
                className="flex-1 min-w-0 text-[14px] bg-transparent focus:outline-none text-gray-900"
              />
            </div>
          </div>

          {/* Phone (optional) */}
          <div>
            <label className="block text-[12px] font-semibold text-gray-900 mb-1.5">
              {t('common.phone') || 'Phone'} <span className="text-gray-400 font-normal">({t('common.optional') || 'optional'})</span>
            </label>
            <div className="flex items-center gap-2 bg-surface-chip rounded-[10px] px-3 py-2.5 border border-transparent focus-within:border-blue-500 focus-within:bg-white">
              <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
              </svg>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder={t('clientsWeb.phonePlaceholder') || '(555) 123-4567'}
                className="flex-1 min-w-0 text-[14px] bg-transparent focus:outline-none text-gray-900"
              />
            </div>
          </div>

          {/* Address (optional) */}
          <div>
            <label className="block text-[12px] font-semibold text-gray-900 mb-1.5">
              {t('common.address') || 'Address'} <span className="text-gray-400 font-normal">({t('common.optional') || 'optional'})</span>
            </label>
            <div className="flex items-center gap-2 bg-surface-chip rounded-[10px] px-3 py-2.5 border border-transparent focus-within:border-blue-500 focus-within:bg-white">
              <svg
                className="w-4 h-4 shrink-0 transition-colors"
                style={{ color: pinColor }}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              <AddressAutocomplete
                value={address}
                onChange={(v) => {
                  setAddress(v)
                  if (coords) setCoords(null)
                }}
                onSelect={(r) => {
                  setAddress(r.address)
                  setCoords({ lat: r.lat, lng: r.lng })
                }}
                placeholder={t('clientsWeb.addressPlaceholder') || 'Start typing an address…'}
                className="flex-1 min-w-0 text-[14px] bg-transparent focus:outline-none text-gray-900"
              />
            </div>
            {(addrGeocoded || addrPending) && (
              <p className={`mt-1 px-1 text-[11px] font-semibold inline-flex items-center gap-1 ${addrGeocoded ? 'text-emerald-600' : 'text-amber-600'}`}>
                {addrGeocoded ? (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v4M12 16h.01" />
                  </svg>
                )}
                {addrGeocoded
                  ? (t('clientsWeb.addressSaved') || 'Address saved')
                  : (t('clientsWeb.addressNotSaved') || 'Pick a suggestion to save')}
              </p>
            )}
          </div>

          {/* Blocked days — toggle for everyone, saved as metadata. Pip+ users
              get Smart Placement to honor them at scheduling time; free users
              keep the data ready for when they upgrade. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">
                {t('clientsWeb.blockedDays') || 'Blocked Days'}{' '}
                <span className="text-gray-400 font-normal">({t('common.optional') || 'optional'})</span>
              </label>
              {!isPlus && (
                <span className="text-[8px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-blue-600 text-white">Pip+</span>
              )}
            </div>
            <div className="flex gap-1">
              {DAYS.map(({ day, label }) => {
                const blocked = blockedDays.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleBlockedDay(day)}
                    className={`flex-1 py-1.5 text-[11px] font-bold rounded-md border transition-all ${blocked ? 'line-through' : ''}`}
                    style={blocked ? {
                      backgroundColor: BLOCKED_COLOR + '18',
                      color: BLOCKED_COLOR,
                      borderColor: BLOCKED_COLOR + '55',
                    } : {
                      backgroundColor: '#fff',
                      color: '#374151',
                      borderColor: '#E5E7EB',
                    }}
                  >{label}</button>
                )
              })}
            </div>
            {blockedDays.length > 0 && (
              <p className={`mt-1.5 px-0.5 text-[11px] leading-snug ${isPlus ? 'text-gray-500' : 'text-blue-600'}`}>
                {isPlus
                  ? (name.trim()
                      ? t('clientsWeb.blockedDaysHintPlus', { name: name.trim() }) || `Smart Placement won't suggest these days for ${name.trim()}`
                      : t('clientsWeb.blockedDaysHintPlusGeneric') || `Smart Placement won't suggest these days for this client`)
                  : (t('clientsWeb.blockedDaysHintFree') || 'Saved for later — activates with Pip+ Smart Placement')}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 shrink-0 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-[13px] font-semibold text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-40"
          >
            {t('common.cancel') || 'Cancel'}
          </button>
          <button
            onClick={() => void submit()}
            disabled={!name.trim() || saving}
            className="px-5 py-2 text-[13px] font-semibold text-white rounded-full transition-colors disabled:opacity-40"
            style={{ background: '#3B82F6' }}
          >
            {saving
              ? (t('common.adding') || 'Adding…')
              : (t('clientsWeb.addClient') || 'Add Client')}
          </button>
        </div>
      </div>
    </div>
  )
}

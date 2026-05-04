import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useCurrency } from '../lib/currency'
import type { Job } from '../lib/jobs'
import type { Client } from '../types'

type Scope = 'this' | 'all'

/**
 * Tight, single-purpose modal for the Reports → Needs Price flow.
 * Only edits price. Scope toggle decides whether the price applies to this
 * visit alone or also bakes into the recurring template (so future virtuals
 * inherit it). Per-occurrence flags (completed/paid/cancelled) are never
 * written here — opening the full EditJobModal for a Needs Price job risked
 * the user accidentally toggling completion with scope='all', which would
 * try to flip the template's completed flag (now blocked by the store guard,
 * but still a confusing UI). Keep this modal price-only.
 */
export default function AddPriceModal({ job, client, onClose }: {
  job: Job
  client: Client | null
  onClose: () => void
}) {
  const { updateJobWithScope, refreshJobs } = useStore()
  const { currencyInfo } = useCurrency()

  // Recurrence detection mirrors EditJobModal — three OR'd signals because
  // the job row alone isn't reliable. Without the client.frequency check,
  // older instances missing templateId never get the scope toggle even
  // though they belong to a series.
  const clientIsRecurring = !!client && client.frequency !== 'one-time'
  const isRecurring = job.isTemplate || !!job.templateId || job.isRecurring || clientIsRecurring

  const [priceStr, setPriceStr] = useState<string>(job.price > 0 ? String(job.price) : '')
  const [scope, setScope] = useState<Scope>('this')
  const [saving, setSaving] = useState(false)

  // Esc-to-close mirrors EditJobModal so the two feel consistent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const priceNum = priceStr === '' ? 0 : Number(priceStr)
  const priceValid = priceStr === '' || (Number.isFinite(priceNum) && priceNum >= 0)
  const priceChanged = priceNum !== (job.price ?? 0)
  const canSave = priceValid && priceChanged && !saving

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await updateJobWithScope(job, { price: priceNum }, isRecurring ? scope : 'this')
      await refreshJobs()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 border-b border-gray-100 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Add price</p>
              <p className="text-lg font-bold text-gray-900 truncate mt-0.5">
                {client?.name ?? job.title ?? 'Job'}
              </p>
              <p className="text-sm text-gray-500 mt-0.5">{formatLongDate(job.date)}</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 shrink-0"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Price</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-emerald-500 font-semibold">{currencyInfo.symbol}</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step={5}
                value={priceStr}
                onChange={e => setPriceStr(e.target.value)}
                placeholder="0"
                autoFocus
                className="w-full pl-7 pr-3 py-2.5 border border-gray-200 rounded-lg text-sm font-semibold text-gray-900 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
              />
            </div>
          </div>

          {isRecurring && (
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Apply to</label>
              <div className="flex gap-2">
                <ScopeButton
                  active={scope === 'this'}
                  onClick={() => setScope('this')}
                  label="This one"
                  sub={formatShortDate(job.date)}
                />
                <ScopeButton
                  active={scope === 'all'}
                  onClick={() => setScope('all')}
                  label="All future"
                  sub="This + upcoming"
                />
              </div>
              <p className="text-[11px] text-gray-400 mt-1.5">
                {scope === 'all'
                  ? 'Sets this visit and bakes the price into the recurring series. Other past visits are never changed.'
                  : 'Sets the price for this visit only.'}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-100 shrink-0 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ScopeButton({ active, onClick, label, sub }: {
  active: boolean; onClick: () => void; label: string; sub: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 py-3 rounded-lg text-sm font-semibold transition-colors text-left px-3 ${active
        ? 'bg-emerald-50 text-emerald-900 ring-1 ring-emerald-300'
        : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
    >
      <div className="font-bold">{label}</div>
      <div className="text-[11px] font-normal mt-0.5 opacity-80">{sub}</div>
    </button>
  )
}

function formatLongDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function formatShortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

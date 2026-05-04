import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useCurrency } from '../lib/currency'
import { useLanguage } from '../lib/language'
import { useAuth } from '../lib/auth'
import { DEFAULT_AVATAR_COLOR } from '../theme'
import ColorPickerChip from './ColorPickerChip'
import type { Job } from '../lib/jobs'
import type { Client, Frequency } from '../types'
import {
  getJobTimeEntries,
  updateTimeEntry,
  createTimeEntry,
  deleteTimeEntry,
  formatDurationMs,
  type TimeEntry,
} from '../lib/timeEntries'

// ── Time-segment editor helpers ─────────────────────────────────────────────
// Web edits only the TIME portion. The date portion is implicit (= the date
// the entry already lives on, or job.date for new entries). This keeps the
// UI simple — cleaners don't need to retype the date every time.

const pad = (n: number) => String(n).padStart(2, '0')

function isoToDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function isoToTime(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function dateAndTimeToIso(date: string, time: string): string {
  // new Date('YYYY-MM-DDTHH:mm') is parsed as local time — exactly what we want
  return new Date(`${date}T${time}`).toISOString()
}

type EditableEntry = {
  /** existing DB id, or `new-{n}` placeholder for unsaved rows */
  id: string
  /** Date portion ("YYYY-MM-DD"). Preserved from server for existing entries,
   *  set to job.date for new ones. Not user-editable from this UI. */
  date: string
  /** Time portion ("HH:mm") — user-editable */
  clockInTime: string
  /** empty string when unset (only legal for an existing active segment) */
  clockOutTime: string
  origClockIn?: string
  origClockOut?: string | null
  /** marked for deletion on save */
  deleted?: boolean
  /** active = clock_out is null on the server. Rendered read-only on web; mobile must end it. */
  active?: boolean
}

type Scope = 'this' | 'all'

/** Edit-job modal, web port of mobile's EditJobScreen.
 *
 *  Scope semantics for recurring jobs:
 *   - "This one" → materializes the virtual (if needed) and patches only that row
 *   - "All future" → patches the template and wipes future overrides so the new
 *     values propagate. Past/completed occurrences are frozen.
 *
 *  Marking paid is always this-instance-only — "mark all future paid" would be
 *  a lie. If the user edits the price on a paid job, surface a warning.
 */
export default function EditJobModal({ job, client, onClose }: {
  job: Job
  client: Client | null
  onClose: () => void
}) {
  const { updateJobWithScope, refreshJobs } = useStore()
  const { currencyInfo } = useCurrency()
  const { t } = useLanguage()
  const { user } = useAuth()

  // Recurrence detection — three OR'd signals because the job row alone
  // isn't reliable:
  //  - isTemplate / templateId: cleanest (template + materialized instance)
  //  - job.isRecurring: set by some flows, missing in others
  //  - client.frequency !== 'one-time': the most reliable user-intent
  //    signal — if Sarah is weekly, every Sarah job is part of the series
  //    regardless of how mobile stored it
  // Without this third check, older instances missing templateId would
  // never get the scope picker even though they belong to a series.
  const clientIsRecurring = !!client && client.frequency !== 'one-time'
  const isRecurring = job.isTemplate || !!job.templateId || job.isRecurring || clientIsRecurring
  // For the scope picker, default:
  //  - one-time: 'this' (no choice shown)
  //  - recurring: 'this' — safer default; user opts in to "all future"
  const [scope, setScope] = useState<Scope>(isRecurring ? 'this' : 'this')

  const initialColor = job.avatarColor || client?.color || DEFAULT_AVATAR_COLOR
  const [priceStr, setPriceStr] = useState<string>(job.price ? String(job.price) : '')
  // Duration is stored as decimal hours (1.5 = 1h 30m) but rendered as
  // two inputs — hours integer + minutes remainder — because typing
  // ".5" or ".25" in a single field is awkward. We split on mount and
  // recompose at save time.
  const initHours = Math.floor(job.duration ?? 0)
  const initMinutes = Math.round(((job.duration ?? 0) - initHours) * 60)
  const [hoursStr, setHoursStr] = useState<string>(initHours > 0 ? String(initHours) : '')
  const [minutesStr, setMinutesStr] = useState<string>(initMinutes > 0 ? String(initMinutes) : '')
  const [completed, setCompleted] = useState<boolean>(job.completed)
  const [paid, setPaid] = useState<boolean>(job.paid)
  const [color, setColor] = useState<string>(initialColor)
  const [saving, setSaving] = useState(false)

  // ── Time entries (clock in/out segments) ──
  // Templates and virtual occurrences don't have rows in job_time_entries —
  // mobile materializes the instance on clock-in. So skip the fetch unless
  // the job has a real id (not a template).
  const canEditTime = !job.isTemplate
  const [entries, setEntries] = useState<EditableEntry[]>([])
  const [entriesLoaded, setEntriesLoaded] = useState(false)
  const [newCounter, setNewCounter] = useState(0)
  useEffect(() => {
    if (!canEditTime) { setEntriesLoaded(true); return }
    let cancelled = false
    getJobTimeEntries(job.id)
      .then((rows: TimeEntry[]) => {
        if (cancelled) return
        setEntries(rows.map(r => ({
          id: r.id,
          date: isoToDate(r.clockIn),
          clockInTime: isoToTime(r.clockIn),
          clockOutTime: r.clockOut ? isoToTime(r.clockOut) : '',
          origClockIn: r.clockIn,
          origClockOut: r.clockOut,
          active: !r.clockOut,
        })))
        setEntriesLoaded(true)
      })
      .catch(() => { if (!cancelled) setEntriesLoaded(true) })
    return () => { cancelled = true }
  }, [job.id, canEditTime])

  const entriesDirty = entries.some(e => {
    if (e.deleted) return true
    if (e.id.startsWith('new-')) return true
    if (e.active) return false
    const origIn = e.origClockIn ? isoToTime(e.origClockIn) : ''
    const origOut = e.origClockOut ? isoToTime(e.origClockOut) : ''
    return e.clockInTime !== origIn || e.clockOutTime !== origOut
  })

  const priceNum = Number(priceStr)
  const priceValid = priceStr === '' || (!Number.isNaN(priceNum) && priceNum >= 0)

  // Recompose hours+minutes → decimal hours. Both empty == 0 (cleared).
  const hoursNum = hoursStr === '' ? 0 : Number(hoursStr)
  const minutesNum = minutesStr === '' ? 0 : Number(minutesStr)
  const durationNum = hoursNum + minutesNum / 60
  const durationValid =
    !Number.isNaN(hoursNum) && !Number.isNaN(minutesNum) &&
    hoursNum >= 0 && minutesNum >= 0 && minutesNum < 60 &&
    (hoursStr === '' && minutesStr === '' ? true : durationNum > 0)

  const priceChanged = priceStr !== (job.price ? String(job.price) : '')
  // Compare against original decimal hours. Tiny float epsilon since
  // 1h 30m → 1.5 exactly but 1h 20m → 1.333…
  const durationChanged = Math.abs(durationNum - (job.duration ?? 0)) > 1e-6
  const completedChanged = completed !== job.completed
  const paidChanged = paid !== job.paid
  const colorChanged = color !== initialColor
  const dirty = priceChanged || durationChanged || completedChanged || paidChanged || colorChanged || entriesDirty

  const warnPaidPriceChange = job.paid && priceChanged

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSave = async () => {
    if (!dirty || !priceValid || !durationValid || saving) return
    setSaving(true)
    try {
      // Paid toggle is always this-instance-only. Split into two calls if both
      // price/duration AND paid changed with scope='all', so the template gets
      // the price and only this row gets the paid flag.
      const scopedPatch: Record<string, unknown> = {}
      if (priceChanged) scopedPatch.price = priceStr === '' ? 0 : priceNum
      if (durationChanged) scopedPatch.duration = durationNum
      if (colorChanged) scopedPatch.avatar_color = color

      if (Object.keys(scopedPatch).length > 0) {
        await updateJobWithScope(job, scopedPatch, scope)
      }
      if (completedChanged) {
        // Completion toggle is always this-instance-only. If we're uncompleting,
        // also clear paid — a "scheduled" job can't have been paid.
        const patch: Record<string, unknown> = { completed }
        if (!completed) patch.paid = false
        await updateJobWithScope(job, patch, 'this')
      }
      if (paidChanged && completed) {
        // Paid status only matters when completed. If the user uncompleted the
        // job above, paid was already cleared — skip this branch.
        await updateJobWithScope(job, { paid }, 'this')
      }
      // Time-entry diff: deletes, updates, creates. Active segments are not
      // editable on web — mobile owns ending them.
      if (entriesDirty && canEditTime) {
        for (const e of entries) {
          if (e.deleted) {
            if (!e.id.startsWith('new-')) await deleteTimeEntry(e.id)
            continue
          }
          if (e.active) continue
          if (e.id.startsWith('new-')) {
            if (!user?.id) continue
            if (!e.clockInTime || !e.clockOutTime) continue
            await createTimeEntry(
              job.id,
              user.id,
              dateAndTimeToIso(e.date, e.clockInTime),
              dateAndTimeToIso(e.date, e.clockOutTime),
            )
            continue
          }
          const origIn = e.origClockIn ? isoToTime(e.origClockIn) : ''
          const origOut = e.origClockOut ? isoToTime(e.origClockOut) : ''
          if (e.clockInTime === origIn && e.clockOutTime === origOut) continue
          const patch: { clockIn?: string; clockOut?: string } = {}
          if (e.clockInTime !== origIn) patch.clockIn = dateAndTimeToIso(e.date, e.clockInTime)
          if (e.clockOutTime !== origOut) patch.clockOut = dateAndTimeToIso(e.date, e.clockOutTime)
          await updateTimeEntry(e.id, patch)
        }
      }
      // Re-pull from DB so callers (Reports tables, Schedule chips) see the
      // truth without waiting on realtime. Local setJobs paths cover most
      // cases, but materialize+update on virtuals and 'all future' soft-deletes
      // can leave the UI a render behind. One extra round-trip per save is
      // worth the consistency.
      await refreshJobs()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const canSave = dirty && priceValid && durationValid && !saving

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 border-b border-gray-100 shrink-0">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Edit job</p>
              <p className="text-lg font-bold text-gray-900 truncate mt-0.5">
                {client?.name ?? job.title ?? 'Job'}
              </p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <p className="text-sm text-gray-500">{formatLongDate(job.date)}</p>
                {/* Recurrence chip — answers "is this part of a series?" so
                    users know whether the scope picker can apply this
                    edit to future occurrences. */}
                <RecurrenceChip frequency={client?.frequency} intervalWeeks={client?.intervalWeeks} t={t} />
              </div>
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
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Scope picker — pinned to top so the user sees the choice before
              they start typing. Always shown for recurring jobs (including
              completed/past visits) so the Needs Price flow can propagate a
              price into the series in one step. Per-occurrence flags
              (completed/paid) ignore scope and stay this-only — see handleSave. */}
          {isRecurring && (
            <Field label="Apply to">
              <div className="flex gap-2">
                <ScopeButton active={scope === 'this'} onClick={() => setScope('this')} label="This one" sub={formatShortDate(job.date)} />
                <ScopeButton active={scope === 'all'} onClick={() => setScope('all')} label="All future" sub="This + upcoming" />
              </div>
              <p className="text-[11px] text-gray-400 mt-1.5">
                {scope === 'all'
                  ? (job.completed
                      ? 'Sets this visit and bakes the price into the recurring series. Other past visits are never changed.'
                      : 'Updates the recurring series. Past visits are never changed.')
                  : 'Changes apply to this visit only.'}
              </p>
            </Field>
          )}

          {/* Price */}
          <Field label="Price">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 font-semibold">{currencyInfo.symbol}</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step={5}
                value={priceStr}
                onChange={e => setPriceStr(e.target.value)}
                placeholder="0"
                className="w-full pl-7 pr-3 py-2.5 border border-gray-200 rounded-lg text-sm font-semibold text-gray-900 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
              />
            </div>
          </Field>

          {/* Duration — split into hours + minutes so users don't have to
              think in decimals (1h 30m, not 1.5). Sum is recomposed back
              to decimal hours at save time. */}
          <Field label="Duration">
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={hoursStr}
                  onChange={e => setHoursStr(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="0"
                  className="w-full pl-3 pr-10 py-2.5 border border-gray-200 rounded-lg text-sm font-semibold text-gray-900 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">hr</span>
              </div>
              <div className="flex-1 relative">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={59}
                  step={5}
                  value={minutesStr}
                  onChange={e => {
                    const cleaned = e.target.value.replace(/[^\d]/g, '')
                    // Cap at 59 — 60+ should roll into hours, but we don't
                    // auto-roll mid-typing because it fights the user.
                    const capped = cleaned === '' ? '' : String(Math.min(Number(cleaned), 59))
                    setMinutesStr(capped)
                  }}
                  placeholder="0"
                  className="w-full pl-3 pr-10 py-2.5 border border-gray-200 rounded-lg text-sm font-semibold text-gray-900 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">min</span>
              </div>
            </div>
          </Field>

          {/* Color — chip preview mirrors the calendar chip */}
          <Field label="Color">
            <ColorPickerChip
              color={color}
              label={client?.name ?? job.title ?? 'Job'}
              onChange={setColor}
            />
          </Field>

          {/* Status — scheduled vs completed (this-instance-only) */}
          <Field label="Status">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCompleted(false)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${!completed
                  ? 'bg-blue-100 text-blue-900 ring-1 ring-blue-300'
                  : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
              >
                Scheduled
              </button>
              <button
                type="button"
                onClick={() => setCompleted(true)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${completed
                  ? 'bg-emerald-100 text-emerald-900 ring-1 ring-emerald-300'
                  : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
              >
                Completed
              </button>
            </div>
            {completedChanged && !completed && job.paid && (
              <p className="text-[11px] text-amber-700 mt-1.5">
                Marking as scheduled will also clear the paid flag.
              </p>
            )}
          </Field>

          {/* Paid toggle — only when the job is currently marked completed */}
          {completed && (
            <Field label="Payment status">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPaid(false)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${!paid
                    ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300'
                    : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
                >
                  Unpaid
                </button>
                <button
                  type="button"
                  onClick={() => setPaid(true)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${paid
                    ? 'bg-emerald-100 text-emerald-900 ring-1 ring-emerald-300'
                    : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
                >
                  Paid
                </button>
              </div>
              <p className="text-[11px] text-gray-400 mt-1.5">Only applies to this job.</p>
            </Field>
          )}

          {warnPaidPriceChange && (
            <div className="rounded-lg p-3 flex gap-2.5" style={{ backgroundColor: '#FEF3C7', border: '1px solid #FDE68A' }}>
              <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="#92400E" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <p className="text-xs font-semibold" style={{ color: '#92400E' }}>
                This job is marked paid. Editing the price won't change what was collected — it just updates the record.
              </p>
            </div>
          )}

          {/* Time log — clock in/out segments. View-only on web for active
              segments; mobile must end them. Edit/add/delete supported for
              completed segments so users can fix mistakes (forgot to clock
              out, wrong start time). */}
          {canEditTime && entriesLoaded && (
            <Field label="Time tracked">
              {entries.filter(e => !e.deleted).length === 0 ? (
                <p className="text-[11px] text-gray-400 mb-2">No time logged yet.</p>
              ) : (
                <div className="space-y-2 mb-2">
                  {entries.map((e, idx) => {
                    if (e.deleted) return null
                    // Duration: minutes between two HH:mm strings on the same day.
                    let inMs = 0
                    if (e.clockInTime && e.clockOutTime) {
                      const [ih, im] = e.clockInTime.split(':').map(Number)
                      const [oh, om] = e.clockOutTime.split(':').map(Number)
                      inMs = ((oh * 60 + om) - (ih * 60 + im)) * 60 * 1000
                      if (inMs < 0) inMs = 0
                    }
                    return (
                      <div key={e.id} className="rounded-lg bg-gray-50 border border-gray-100 p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-sm font-bold text-sky-700 tabular-nums">
                            {e.active ? 'Running' : (inMs > 0 ? formatDurationMs(inMs) : '—')}
                          </span>
                          <button
                            type="button"
                            onClick={() => setEntries(prev => prev.map((p, i) => i === idx ? { ...p, deleted: true } : p))}
                            aria-label="Delete time entry"
                            className="ml-auto shrink-0 w-7 h-7 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                            </svg>
                          </button>
                        </div>
                        <div className="flex items-center gap-3">
                          <input
                            type="time"
                            value={e.clockInTime}
                            disabled={e.active}
                            onChange={ev => setEntries(prev => prev.map((p, i) => i === idx ? { ...p, clockInTime: ev.target.value } : p))}
                            className="flex-1 min-w-0 px-3 py-2 text-sm rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:bg-gray-100 disabled:text-gray-400 tabular-nums"
                          />
                          <span className="text-gray-400 text-xs shrink-0">→</span>
                          {e.active ? (
                            <span className="flex-1 px-3 py-2 text-xs font-semibold text-amber-700 bg-amber-50 rounded-md text-center">End on mobile</span>
                          ) : (
                            <input
                              type="time"
                              value={e.clockOutTime}
                              onChange={ev => setEntries(prev => prev.map((p, i) => i === idx ? { ...p, clockOutTime: ev.target.value } : p))}
                              className="flex-1 min-w-0 px-3 py-2 text-sm rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400 tabular-nums"
                            />
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  // Default new segment to 9–10am on the job's date — user adjusts.
                  setEntries(prev => [...prev, {
                    id: `new-${newCounter}`,
                    date: job.date,
                    clockInTime: '09:00',
                    clockOutTime: '10:00',
                  }])
                  setNewCounter(c => c + 1)
                }}
                className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
              >
                + Add segment
              </button>
            </Field>
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
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: '#10B981' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">{label}</label>
      {children}
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

/**
 * Tiny pill in the modal header that names the job's cadence so the user
 * knows whether the scope picker can apply edits to future occurrences.
 * Reads from the client because frequency lives there, not on the job
 * itself. Color-coded to match the rest of the app's recurrence chips.
 */
function RecurrenceChip({
  frequency,
  intervalWeeks,
  t,
}: {
  frequency: Frequency | undefined
  intervalWeeks: number | undefined
  t: (key: string, options?: object) => string
}) {
  // No client (task-style job) — render nothing rather than a misleading "One-time".
  if (!frequency) return null

  let label: string
  let cls: string
  switch (frequency) {
    case 'weekly':
      label = t('recurrence.weekly') || 'Weekly'
      cls = 'bg-blue-100 text-blue-700'
      break
    case 'biweekly':
      label = t('recurrence.biWeekly') || 'Bi-weekly'
      cls = 'bg-purple-100 text-purple-700'
      break
    case 'monthly':
      label = t('recurrence.monthly') || 'Monthly'
      cls = 'bg-orange-100 text-orange-700'
      break
    case 'custom':
      label = `Every ${intervalWeeks ?? '?'}w`
      cls = 'bg-amber-100 text-amber-700'
      break
    case 'one-time':
    default:
      label = t('recurrence.oneTime') || 'One-time'
      cls = 'bg-gray-100 text-gray-600'
      break
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${cls}`}>
      {label}
    </span>
  )
}

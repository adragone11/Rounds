import { useState, useMemo, useEffect } from 'react'
import type { Client } from '../types'
import type { GridCell } from '../types'
import type { PerfectScheduleResult } from '../lib/scheduleBuilder'
import { generatePerfectSchedule } from '../lib/scheduleBuilder'
import AddressAutocomplete from './AddressAutocomplete'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_COLORS = ['#F97316', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4']

type Frequency = 'weekly' | 'biweekly' | 'monthly'
type Step = 'config' | 'recurrence' | 'results'

const FREQ_OPTIONS: { value: Frequency; label: string; color: string; bg: string }[] = [
  { value: 'weekly', label: 'Weekly', color: '#3B82F6', bg: '#EFF6FF' },
  { value: 'biweekly', label: 'Bi-weekly', color: '#8B5CF6', bg: '#F5F3FF' },
  { value: 'monthly', label: 'Monthly', color: '#F97316', bg: '#FFF7ED' },
]

const DURATION_OPTIONS: number[] = []
for (let m = 15; m <= 480; m += 15) DURATION_OPTIONS.push(m)

function formatDuration(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function formatDateForInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface Props {
  open: boolean
  onClose: () => void
  clients: Client[]
  clientDayMap: Map<string, number>
  homeAddress: { address: string; lat: number; lng: number } | null
  onSetHomeAddress: (address: string, coords?: { lat: number; lng: number }) => Promise<void>
  onApply: (assignments: Map<string, number>, recurrenceMap: Map<string, Client['frequency']>, rotations: Map<string, number>, startDate: Date, changes: Array<{ clientId: string; clientName: string; fromDay: number; toDay: number }>, config: { maxJobsPerDay: number; workingDays: boolean[] }) => void
}

export default function PerfectScheduleModal({ open, onClose, clients, clientDayMap, homeAddress, onSetHomeAddress, onApply }: Props) {
  const [step, setStep] = useState<Step>('config')

  // ── Step 1: Config state ──
  const [maxJobsPerDay, setMaxJobsPerDay] = useState(5)
  const [workingDays, setWorkingDays] = useState<boolean[]>([false, true, true, true, true, true, false])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() =>
    new Set(clients.filter(c => c.lat !== null && c.lng !== null).map(c => c.id))
  )
  const [homeInputValue, setHomeInputValue] = useState(homeAddress?.address ?? '')
  const [homeCoords, setHomeCoords] = useState<{ lat: number; lng: number } | null>(
    homeAddress ? { lat: homeAddress.lat, lng: homeAddress.lng } : null
  )
  const [editingHome, setEditingHome] = useState(!homeAddress)

  // Start date for the 4-week cycle (defaults to most recent Monday, so cycle covers current week)
  const [startDate, setStartDate] = useState<Date>(() => {
    const d = new Date()
    const daysSinceMonday = (d.getDay() - 1 + 7) % 7 // 0 if today is Monday
    const lastMon = new Date(d)
    lastMon.setDate(d.getDate() - daysSinceMonday)
    return lastMon
  })

  // ── Step 2: Recurrence state ──
  const [recurrenceMap, setRecurrenceMap] = useState<Map<string, Frequency>>(() => {
    const m = new Map<string, Frequency>()
    clients.forEach(c => {
      const f = c.frequency === 'one-time' ? 'weekly' : c.frequency as Frequency
      m.set(c.id, f)
    })
    return m
  })
  const [durationMap, setDurationMap] = useState<Map<string, number>>(() => {
    const m = new Map<string, number>()
    clients.forEach(c => m.set(c.id, 60))
    return m
  })
  const [setAllRec, setSetAllRec] = useState<Frequency>('biweekly')
  const [setAllDur, setSetAllDur] = useState(60)
  const [expandedClientId, setExpandedClientId] = useState<string | null>(null)

  // ── Step 3: Results state ──
  const [result, setResult] = useState<PerfectScheduleResult | null>(null)
  const [loading, setLoading] = useState(false)

  // Reset to step 1 when modal opens
  useEffect(() => {
    if (open) {
      setStep('config')
      setResult(null)
      setLoading(false)
    }
  }, [open])

  // ── Derived ──
  const geocodedClients = useMemo(() => clients.filter(c => c.lat !== null && c.lng !== null), [clients])
  const noAddressClients = useMemo(() => clients.filter(c => c.lat === null || c.lng === null), [clients])
  const selectedClients = useMemo(() => geocodedClients.filter(c => selectedIds.has(c.id)), [geocodedClients, selectedIds])
  const allSelected = geocodedClients.length > 0 && geocodedClients.every(c => selectedIds.has(c.id))
  const hasHome = homeAddress || homeCoords
  const canProceedConfig = hasHome && selectedClients.length >= 3 && workingDays.some(Boolean)

  const recStats = useMemo(() => {
    const counts: Record<Frequency, number> = { weekly: 0, biweekly: 0, monthly: 0 }
    for (const id of selectedIds) {
      const r = recurrenceMap.get(id) ?? 'biweekly'
      counts[r]++
    }
    return counts
  }, [selectedIds, recurrenceMap])

  // Active day indices for grid columns
  const activeDayIndices = useMemo(() =>
    workingDays.map((on, i) => on ? i : -1).filter(i => i >= 0),
    [workingDays]
  )

  if (!open) return null

  const toggleClient = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set())
    else setSelectedIds(new Set(geocodedClients.map(c => c.id)))
  }

  const applyAllRecurrence = () => {
    setRecurrenceMap(prev => {
      const next = new Map(prev)
      for (const id of selectedIds) next.set(id, setAllRec)
      return next
    })
    setDurationMap(prev => {
      const next = new Map(prev)
      for (const id of selectedIds) next.set(id, setAllDur)
      return next
    })
  }

  const runPerfectSchedule = async () => {
    const home = homeCoords ?? (homeAddress ? { lat: homeAddress.lat, lng: homeAddress.lng } : null)
    if (!home) return

    // Save home address if changed
    if (homeInputValue && homeCoords && !homeAddress) {
      await onSetHomeAddress(homeInputValue, homeCoords)
    }

    // Sort by id so the optimizer's tie-breaks (seed picker + biweekly A/B split)
    // resolve identically to mobile, which sorts the same way before calling the
    // engine. Without this, duplicate-coord clients hit ties in input-array order
    // and the two platforms produce different schedules from the same input.
    const sortedClients = [...selectedClients].sort((a, b) => a.id.localeCompare(b.id))
    const clientsWithDays = sortedClients.map(c => ({
      client: c,
      currentDay: clientDayMap.get(c.id) ?? new Date().getDay(),
    }))

    setLoading(true)
    try {
      const recMap = new Map<string, string>()
      for (const id of selectedIds) {
        recMap.set(id, recurrenceMap.get(id) ?? 'weekly')
      }

      const r = await generatePerfectSchedule(
        clientsWithDays,
        { maxJobsPerDay, workingDays },
        home,
        durationMap,
        recMap,
      )
      setResult(r)
      setStep('results')
    } catch (err) {
      console.error('Perfect schedule failed:', err)
      alert('Failed to generate perfect schedule')
    } finally {
      setLoading(false)
    }
  }

  const handleApply = () => {
    if (!result) return
    const recMap = new Map<string, Client['frequency']>()
    for (const id of selectedIds) {
      recMap.set(id, recurrenceMap.get(id) ?? 'weekly')
    }
    onApply(result.assignments, recMap, result.rotations, startDate, result.changes, { maxJobsPerDay, workingDays })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[720px] max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header with step indicator */}
        <div className="p-5 border-b border-gray-200 shrink-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-900">Schedule Builder</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {/* Step indicators */}
          <div className="flex items-center gap-2">
            {(['config', 'recurrence', 'results'] as const).map((s, i) => (
              <div key={s} className="flex items-center gap-2 flex-1">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  step === s ? 'bg-purple-600 text-white'
                  : i < ['config', 'recurrence', 'results'].indexOf(step) ? 'bg-green-500 text-white'
                  : 'bg-gray-200 text-gray-500'
                }`}>
                  {i < ['config', 'recurrence', 'results'].indexOf(step) ? (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  ) : i + 1}
                </div>
                <span className={`text-xs font-medium ${step === s ? 'text-purple-700' : 'text-gray-400'}`}>
                  {s === 'config' ? 'Setup' : s === 'recurrence' ? 'Recurrence' : 'Grid'}
                </span>
                {i < 2 && <div className="flex-1 h-px bg-gray-200" />}
              </div>
            ))}
          </div>
        </div>

        {/* STEP 1: CONFIG */}
        {step === 'config' && (
          <>
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* Starting Address */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Starting Address</label>
                {hasHome && !editingHome ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-green-50 rounded-lg border border-green-200">
                    <svg className="w-4 h-4 text-green-500 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3L4 9v12h5v-7h6v7h5V9l-8-6z"/></svg>
                    <span className="text-sm text-gray-700 flex-1 truncate">{homeAddress?.address ?? homeInputValue}</span>
                    <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    <button onClick={() => setEditingHome(true)} className="text-xs text-gray-400 hover:text-gray-600 ml-1">Edit</button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <AddressAutocomplete
                      autoFocus
                      value={homeInputValue}
                      onChange={v => { setHomeInputValue(v); setHomeCoords(null) }}
                      onSelect={r => { setHomeInputValue(r.address); setHomeCoords({ lat: r.lat, lng: r.lng }); setEditingHome(false) }}
                      onKeyDown={async e => {
                        if (e.key === 'Enter' && homeInputValue.trim() && homeCoords) {
                          await onSetHomeAddress(homeInputValue.trim(), homeCoords)
                          setEditingHome(false)
                        }
                      }}
                      placeholder="Your starting address"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500/20"
                    />
                    {homeAddress && (
                      <button onClick={() => setEditingHome(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                    )}
                  </div>
                )}
              </div>

              {/* Settings row */}
              <div className="grid grid-cols-3 gap-4">
                {/* Max Jobs */}
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Max Jobs / Day</label>
                  <div className="flex items-center gap-2 bg-gray-100 rounded-lg p-1">
                    <button
                      onClick={() => setMaxJobsPerDay(Math.max(1, maxJobsPerDay - 1))}
                      disabled={maxJobsPerDay <= 1}
                      className="w-8 h-8 flex items-center justify-center bg-white rounded-md shadow-sm text-gray-500 disabled:opacity-30 hover:bg-gray-50"
                    >
                      -
                    </button>
                    <span className="flex-1 text-center text-sm font-bold text-gray-900">{maxJobsPerDay}</span>
                    <button
                      onClick={() => setMaxJobsPerDay(Math.min(10, maxJobsPerDay + 1))}
                      disabled={maxJobsPerDay >= 10}
                      className="w-8 h-8 flex items-center justify-center bg-white rounded-md shadow-sm text-gray-500 disabled:opacity-30 hover:bg-gray-50"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* Working Days */}
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Working Days</label>
                  <div className="flex gap-1">
                    {DAYS.map((day, i) => (
                      <button
                        key={day}
                        onClick={() => {
                          const next = [...workingDays]
                          next[i] = !next[i]
                          setWorkingDays(next)
                        }}
                        className={`flex-1 h-8 text-[10px] font-semibold rounded-md transition-colors ${
                          workingDays[i]
                            ? 'text-white'
                            : 'bg-white text-gray-400 border border-gray-200'
                        }`}
                        style={workingDays[i] ? { backgroundColor: DAY_COLORS[i] } : undefined}
                      >
                        {day[0]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Start Date */}
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Cycle Start</label>
                  <input
                    type="date"
                    value={formatDateForInput(startDate)}
                    onChange={e => {
                      const d = new Date(e.target.value + 'T00:00:00')
                      if (!isNaN(d.getTime())) setStartDate(d)
                    }}
                    className="w-full h-8 px-2 text-sm border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
                  />
                </div>
              </div>

              {/* Client Selection */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Clients ({selectedIds.size}/{geocodedClients.length})
                  </label>
                  {geocodedClients.length > 0 && (
                    <button onClick={toggleAll} className="text-xs font-medium text-purple-600 hover:text-purple-800">
                      {allSelected ? 'Deselect All' : 'Select All'}
                    </button>
                  )}
                </div>
                <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-[240px] overflow-y-auto">
                  {geocodedClients.map(client => {
                    const selected = selectedIds.has(client.id)
                    return (
                      <button
                        key={client.id}
                        onClick={() => toggleClient(client.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50 transition-colors ${
                          !selected ? 'opacity-50' : ''
                        }`}
                      >
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
                          selected ? 'bg-purple-600 border-purple-600' : 'border-gray-300'
                        }`}>
                          {selected && (
                            <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                            </svg>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-800 truncate">{client.name}</p>
                          {client.address && (
                            <p className="text-[10px] text-gray-400 truncate">{client.address}</p>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
                {noAddressClients.length > 0 && (
                  <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-amber-50 rounded-lg border border-amber-200">
                    <svg className="w-4 h-4 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <p className="text-xs text-amber-700">
                      {noAddressClients.length} client{noAddressClients.length !== 1 ? 's' : ''} without address: {noAddressClients.map(c => c.name).join(', ')}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-gray-200 flex justify-between">
              <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
              <button
                onClick={() => setStep('recurrence')}
                disabled={!canProceedConfig}
                className="px-5 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
              >
                Continue to Recurrence
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            </div>
          </>
        )}

        {/* STEP 2: RECURRENCE */}
        {step === 'recurrence' && (
          <>
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Set All card */}
              <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-gray-900">Set All</h3>
                  <button
                    onClick={applyAllRecurrence}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-purple-600 rounded-lg hover:bg-purple-700 transition-colors"
                  >
                    Apply to All
                  </button>
                </div>

                {/* Recurrence pills */}
                <div className="mb-3">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Recurrence</p>
                  <div className="flex gap-2">
                    {FREQ_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setSetAllRec(opt.value)}
                        className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${
                          setAllRec === opt.value ? 'text-white' : 'border border-gray-200 text-gray-500'
                        }`}
                        style={setAllRec === opt.value ? { backgroundColor: opt.color } : undefined}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Duration */}
                <div>
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Duration</p>
                  <select
                    value={setAllDur}
                    onChange={e => setSetAllDur(parseInt(e.target.value))}
                    className="text-sm font-medium border border-gray-200 rounded-lg px-3 py-2 bg-white"
                  >
                    {DURATION_OPTIONS.map(d => (
                      <option key={d} value={d}>{formatDuration(d)}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Stats strip */}
              <div className="flex bg-gray-100 rounded-lg overflow-hidden">
                {FREQ_OPTIONS.map((opt, i) => (
                  <div
                    key={opt.value}
                    className={`flex-1 text-center py-2 ${i > 0 ? 'border-l border-gray-200' : ''}`}
                  >
                    <p className="text-lg font-bold" style={{ color: recStats[opt.value] > 0 ? opt.color : '#9CA3AF' }}>
                      {recStats[opt.value]}
                    </p>
                    <p className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: recStats[opt.value] > 0 ? opt.color : '#9CA3AF' }}>
                      {opt.label}
                    </p>
                  </div>
                ))}
              </div>

              {/* Per-client cards */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Clients</p>
                  <p className="text-xs text-gray-400">Tap to edit</p>
                </div>
                <div className="space-y-1.5">
                  {selectedClients.map(client => {
                    const rec = recurrenceMap.get(client.id) ?? 'biweekly'
                    const dur = durationMap.get(client.id) ?? 60
                    const isExpanded = expandedClientId === client.id
                    const freqOpt = FREQ_OPTIONS.find(o => o.value === rec)!
                    const town = client.address ? client.address.split(',')[0] : ''

                    return (
                      <div key={client.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                        {/* Collapsed row */}
                        <button
                          onClick={() => setExpandedClientId(isExpanded ? null : client.id)}
                          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-gray-50 transition-colors"
                        >
                          <div className="w-2.5 h-2.5 rounded-full shrink-0 bg-purple-500" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-gray-800 truncate">{client.name}</p>
                            {town && <p className="text-[10px] text-gray-400 truncate">{town}</p>}
                          </div>
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ color: freqOpt.color, backgroundColor: freqOpt.bg }}>
                            {freqOpt.label}
                          </span>
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                            {formatDuration(dur)}
                          </span>
                          <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                          </svg>
                        </button>

                        {/* Expanded controls */}
                        {isExpanded && (
                          <div className="px-3 pb-3 pt-2 border-t border-gray-100 space-y-3">
                            <div>
                              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Recurrence</p>
                              <div className="flex gap-1.5">
                                {FREQ_OPTIONS.map(opt => (
                                  <button
                                    key={opt.value}
                                    onClick={() => setRecurrenceMap(prev => { const n = new Map(prev); n.set(client.id, opt.value); return n })}
                                    className={`flex-1 py-1.5 text-[10px] font-semibold rounded-md transition-colors ${
                                      rec === opt.value ? 'text-white' : 'border border-gray-200 text-gray-500'
                                    }`}
                                    style={rec === opt.value ? { backgroundColor: opt.color } : undefined}
                                  >
                                    {opt.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div>
                              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Duration</p>
                              <select
                                value={dur}
                                onChange={e => setDurationMap(prev => { const n = new Map(prev); n.set(client.id, parseInt(e.target.value)); return n })}
                                className="text-xs font-medium border border-gray-200 rounded-md px-2.5 py-1.5 bg-white"
                              >
                                {DURATION_OPTIONS.map(d => (
                                  <option key={d} value={d}>{formatDuration(d)}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-gray-200 flex justify-between">
              <button onClick={() => setStep('config')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
                Back
              </button>
              <button
                onClick={runPerfectSchedule}
                disabled={loading}
                className="px-5 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-40 transition-colors flex items-center gap-2"
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Computing...
                  </>
                ) : (
                  <>
                    Build Schedule
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                    </svg>
                  </>
                )}
              </button>
            </div>
          </>
        )}

        {/* STEP 3: 4-WEEK GRID RESULTS */}
        {step === 'results' && result && (
          <>
            {/* Summary stats */}
            <div className="p-4 border-b border-gray-100 shrink-0">
              <div className="flex gap-3 mb-3">
                <div className="flex-1 bg-gray-100 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-gray-500 font-medium uppercase">Current</p>
                  <p className="text-sm font-bold text-gray-800">{result.currentDriveMinutes}m/wk</p>
                </div>
                <div className="flex-1 bg-purple-50 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-purple-600 font-medium uppercase">Optimized</p>
                  <p className="text-sm font-bold text-purple-700">{result.totalDriveMinutes}m/wk</p>
                </div>
                <div className="flex-1 bg-green-50 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-green-600 font-medium uppercase">Savings</p>
                  <p className="text-sm font-bold text-green-700">{Math.max(0, result.currentDriveMinutes - result.totalDriveMinutes)}m/wk</p>
                </div>
              </div>
              <p className="text-[10px] text-gray-400 text-center">
                {result.changes.length} client{result.changes.length !== 1 ? 's' : ''} would change days
                {' '}&middot;{' '}
                Cycle starts {startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </p>
            </div>

            {/* 4-week grid */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="w-16 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider text-left pl-2">Week</th>
                      {activeDayIndices.map(dayIdx => (
                        <th
                          key={dayIdx}
                          className="py-2 text-[10px] font-bold uppercase tracking-wider text-center"
                          style={{ color: DAY_COLORS[dayIdx] }}
                        >
                          {DAYS[dayIdx]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[0, 1, 2, 3].map(week => (
                      <tr key={week} className={week % 2 === 0 ? 'bg-gray-50/50' : ''}>
                        <td className="py-2 pl-2 align-top">
                          <span className="text-[10px] font-bold text-gray-400">Wk {week + 1}</span>
                        </td>
                        {activeDayIndices.map(dayIdx => {
                          const gridKey = `${week}-${dayIdx}`
                          const cellClients: GridCell[] = result.grid.get(gridKey) || []
                          return (
                            <td key={dayIdx} className="py-1.5 px-1 align-top">
                              <div className="min-h-[40px] space-y-1">
                                {cellClients.length === 0 ? (
                                  <div className="h-[40px] rounded-md border border-dashed border-gray-200" />
                                ) : (
                                  cellClients
                                    .sort((a, b) => a.routeOrder - b.routeOrder)
                                    .map((cell, ci) => {
                                      const freqOpt = FREQ_OPTIONS.find(o => o.value === cell.recurrence)
                                      const chipColor = DAY_COLORS[dayIdx]
                                      return (
                                        <div
                                          key={`${cell.clientId}-${ci}`}
                                          className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-white text-[10px] font-semibold leading-tight"
                                          style={{ backgroundColor: chipColor }}
                                          title={`${cell.clientName} (${cell.recurrence}${cell.recurrence === 'biweekly' ? ` Rot ${cell.rotation === 0 ? 'A' : 'B'}` : ''})`}
                                        >
                                          <span className="truncate">{cell.clientName}</span>
                                          {freqOpt && cell.recurrence !== 'weekly' && (
                                            <span className="shrink-0 text-[8px] opacity-75 font-bold uppercase bg-white/20 px-1 rounded">
                                              {cell.recurrence === 'biweekly' ? (cell.rotation === 0 ? 'A' : 'B') : 'M'}
                                            </span>
                                          )}
                                        </div>
                                      )
                                    })
                                )}
                              </div>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Legend */}
              <div className="mt-3 flex items-center gap-4 justify-center text-[9px] text-gray-400">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />
                  Weekly = all 4 weeks
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block px-1 text-[8px] font-bold bg-gray-200 rounded">A</span>
                  Bi-weekly Wk 1,3
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block px-1 text-[8px] font-bold bg-gray-200 rounded">B</span>
                  Bi-weekly Wk 2,4
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block px-1 text-[8px] font-bold bg-gray-200 rounded">M</span>
                  Monthly
                </span>
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-gray-200 flex justify-between">
              <button onClick={() => setStep('recurrence')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
                Back
              </button>
              <button
                onClick={handleApply}
                className="px-5 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                </svg>
                Apply to Schedule
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

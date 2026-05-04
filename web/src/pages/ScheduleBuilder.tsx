import { useState, useMemo, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Client, GridCell } from '../types'
import type { PerfectScheduleResult } from '../lib/scheduleBuilder'
import { generatePerfectSchedule, emptyScheduleContext } from '../lib/scheduleBuilder'
import { buildTransitionMoves, computeSmartPlacement } from '../optimizer'
import { getORSMatrixSeconds } from '../lib/routing'
import { useStore } from '../store'
import { useCurrency } from '../lib/currency'
import { useLanguage } from '../lib/language'
import { useTheme } from '../lib/theme'
import AddressAutocomplete from '../components/AddressAutocomplete'
import AITracePanel from '../components/AITracePanel'
import ClientMap from '../components/ClientMap'
import WeekTimeGrid from '../components/WeekTimeGrid'
import { optimizeViaAI } from '../lib/ai/aiClient'
import type { OptimizationTrace } from '../lib/ai/types'
import { ROUTE_COLOR } from '../theme'

// ── Constants ──

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Frequency = 'weekly' | 'biweekly' | 'monthly'

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

// ── Active schedule-change detection ──
// An "active schedule change" means the user applied a plan and is mid-rollout
// — some clients still need to be confirmed. We detect this by reading the
// persisted Transition context from localStorage. If we'd let Apply fire
// during this, the fresh applyId would orphan the in-flight rollout and
// silently nuke the user's progress.
type ActiveChangeInfo = {
  applyId: string
  confirmed: number
  total: number
  resolved: number
}

function readActiveChange(): ActiveChangeInfo | null {
  try {
    const raw = localStorage.getItem('pip-schedule-plan')
    if (!raw) return null
    const plan = JSON.parse(raw) as { id: string; clients: Array<{ status: string }>; status: string }
    if (plan.status !== 'active') return null
    const total = plan.clients.length
    const confirmed = plan.clients.filter(c => c.status === 'confirmed').length
    if (total === 0) return null
    return { applyId: plan.id, confirmed, total, resolved: confirmed }
  } catch {
    return null
  }
}

function clearActiveChange(_applyId: string) {
  try {
    localStorage.removeItem('pip-schedule-plan')
  } catch { /* ignore */ }
}

// ── Component ──

type BuilderStep = 'setup' | 'results'

// ── sessionStorage persistence ──
// Keeps the results view alive across tab switches (Dashboard → Clients → back).
// Serializes Maps as arrays of entries.
const SESSION_KEY = 'pip.scheduleBuilder.session'

interface PersistedSession {
  builderStep: BuilderStep
  maxJobsPerDay: number
  workingDays: boolean[]
  dayStartMinutes?: number // minutes past midnight, e.g. 480 = 8:00am
  dayEndMinutes?: number   // minutes past midnight, e.g. 1020 = 5:00pm
  selectedIds: string[]
  startDate: string // ISO
  recurrenceMap: [string, Frequency][]
  durationMap: [string, number][]
  intervalWeeksMap: [string, number][]
  result: {
    assignments: [string, number][]
    rotations: [string, number][]
    routesByDay: [number, string[]][]
    grid: [string, GridCell[]][]
    totalDriveMinutes: number
    currentDriveMinutes: number
    changes: PerfectScheduleResult['changes']
    benched: string[]
    legTimes: [string, number[]][]
    cellDriveMinutes: [string, number][]
  } | null
  benchClients: Array<{ id: string; name: string; color: string; frequency: Client['frequency'] }>
  hasRunAutoSort?: boolean
}

function loadSession(): PersistedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) as PersistedSession : null
  } catch { return null }
}

function resultFromPersisted(r: PersistedSession['result']): PerfectScheduleResult | null {
  if (!r) return null
  return {
    assignments: new Map(r.assignments),
    rotations: new Map(r.rotations),
    routesByDay: new Map(r.routesByDay),
    grid: new Map(r.grid),
    totalDriveMinutes: r.totalDriveMinutes,
    currentDriveMinutes: r.currentDriveMinutes,
    changes: r.changes,
    benched: r.benched,
    legTimes: new Map(r.legTimes ?? []),
    cellDriveMinutes: new Map(r.cellDriveMinutes ?? []),
    _context: emptyScheduleContext(),
  }
}

function resultToPersisted(r: PerfectScheduleResult | null): PersistedSession['result'] {
  if (!r) return null
  return {
    assignments: [...r.assignments.entries()],
    rotations: [...r.rotations.entries()],
    routesByDay: [...r.routesByDay.entries()],
    grid: [...r.grid.entries()],
    totalDriveMinutes: r.totalDriveMinutes,
    currentDriveMinutes: r.currentDriveMinutes,
    changes: r.changes,
    benched: r.benched,
    legTimes: [...r.legTimes.entries()],
    cellDriveMinutes: [...r.cellDriveMinutes.entries()],
  }
}

export default function ScheduleBuilder() {
  const navigate = useNavigate()
  const store = useStore()
  const { currencyInfo } = useCurrency()
  const { t } = useLanguage()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const DAY_COLORS = store.dayColors

  const persisted = useRef<PersistedSession | null>(typeof window !== 'undefined' ? loadSession() : null).current
  const [builderStep, setBuilderStep] = useState<BuilderStep>(persisted?.builderStep ?? 'setup')

  // ── Config state ──
  const [maxJobsPerDay, setMaxJobsPerDay] = useState(persisted?.maxJobsPerDay ?? 5)
  const [workingDays, setWorkingDays] = useState<boolean[]>(persisted?.workingDays ?? [false, true, true, true, true, true, false])
  // Day window in minutes past midnight. Default 8:00–17:00 = 9h window.
  const [dayStartMinutes, setDayStartMinutes] = useState<number>(persisted?.dayStartMinutes ?? 8 * 60)
  const [dayEndMinutes, setDayEndMinutes] = useState<number>(persisted?.dayEndMinutes ?? 17 * 60)
  const workingMinutes = Math.max(0, dayEndMinutes - dayStartMinutes)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() =>
    persisted?.selectedIds
      ? new Set(persisted.selectedIds)
      : new Set(store.clients.filter(c => c.lat !== null && c.lng !== null).map(c => c.id))
  )
  const [homeInputValue, setHomeInputValue] = useState(store.homeAddress?.address ?? '')
  const [homeCoords, setHomeCoords] = useState<{ lat: number; lng: number } | null>(
    store.homeAddress ? { lat: store.homeAddress.lat, lng: store.homeAddress.lng } : null
  )
  const [editingHome, setEditingHome] = useState(!store.homeAddress)

  // Start date is now chosen at Apply time in Schedule Change — kept here only
  // so persisted snapshots stay readable.
  const [startDate] = useState<Date>(() => {
    if (persisted?.startDate) return new Date(persisted.startDate)
    const d = new Date()
    const dayOfWeek = d.getDay()
    const daysUntilMonday = dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7 || 7
    const nextMon = new Date(d)
    nextMon.setDate(d.getDate() + daysUntilMonday)
    return nextMon
  })

  // ── Recurrence state ──
  const [recurrenceMap, setRecurrenceMap] = useState<Map<string, Frequency>>(() => {
    if (persisted?.recurrenceMap) return new Map(persisted.recurrenceMap)
    const m = new Map<string, Frequency>()
    store.clients.forEach(c => {
      const f = c.frequency === 'one-time' ? 'biweekly' : c.frequency as Frequency
      m.set(c.id, f)
    })
    return m
  })
  const [durationMap, setDurationMap] = useState<Map<string, number>>(() => {
    if (persisted?.durationMap) return new Map(persisted.durationMap)
    const m = new Map<string, number>()
    store.clients.forEach(c => m.set(c.id, store.getClientDuration(c.id)))
    return m
  })
  const [intervalWeeksMap] = useState<Map<string, number>>(() => {
    if (persisted?.intervalWeeksMap) return new Map(persisted.intervalWeeksMap)
    const m = new Map<string, number>()
    store.clients.forEach(c => { if (c.intervalWeeks) m.set(c.id, c.intervalWeeks) })
    return m
  })
  const [setAllRec, setSetAllRec] = useState<Frequency>('biweekly')
  const [setAllDur, setSetAllDur] = useState(60)
  const [setAllPrice, setSetAllPrice] = useState<string>('0')
  const [expandedClientId, setExpandedClientId] = useState<string | null>(null)

  // ── Results state ──
  const [result, setResult] = useState<PerfectScheduleResult | null>(() => resultFromPersisted(persisted?.result ?? null))
  const [loading, setLoading] = useState(false)

  // ── AI polish state ──
  const [aiPolishing, setAiPolishing] = useState(false)
  const [aiTrace, setAiTrace] = useState<OptimizationTrace | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)

  // ── Map selection state ──
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState<number | null>(null)

  // ── Resizable divider state ──
  const [mapWidthPercent, setMapWidthPercent] = useState(45)
  const isDraggingDivider = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // ── JSON import state ──
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  // ── Compare & confirm state ──
  const [showChanges, setShowChanges] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [mapWeekFilter, setMapWeekFilter] = useState<number | null>(null)
  const [routeData, setRouteData] = useState<{ coordinates: Array<{ lat: number; lng: number }>; durationMinutes: number | null; distanceMiles: number | null; color: string } | null>(null)
  const [benchClients, setBenchClients] = useState<Array<{ id: string; name: string; color: string; frequency: Client['frequency'] }>>(persisted?.benchClients ?? [])
  // Tracks whether the user has actually pressed Auto Sort in this session.
  // Pre-Auto-Sort, the bench is the *initial roster* (manual-first flow), not a
  // list of clients the engine couldn't fit — so the orange "couldn't fit"
  // banner and "Best days" suggestion copy must stay hidden until the engine runs.
  const [hasRunAutoSort, setHasRunAutoSort] = useState<boolean>(persisted?.hasRunAutoSort ?? false)
  const [showRaiseMaxConfirm, setShowRaiseMaxConfirm] = useState(false)
  const [showBlockedApply, setShowBlockedApply] = useState(false)
  const [showStartOverConfirm, setShowStartOverConfirm] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  // Detect an in-flight schedule change (applied plan with unresolved clients).
  // If one exists, Apply is gated — the user must finish/reset it first, or
  // explicitly choose to start over. Re-reads on window focus so the gate
  // updates if the user closes the rollout in another tab.
  const [activeChange, setActiveChange] = useState<ActiveChangeInfo | null>(() => readActiveChange())
  useEffect(() => {
    const refresh = () => setActiveChange(readActiveChange())
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  // ── Persist to sessionStorage whenever results-relevant state changes ──
  useEffect(() => {
    if (builderStep !== 'results' || !result) {
      sessionStorage.removeItem(SESSION_KEY)
      return
    }
    const payload: PersistedSession = {
      builderStep,
      maxJobsPerDay,
      workingDays,
      dayStartMinutes,
      dayEndMinutes,
      selectedIds: [...selectedIds],
      startDate: startDate.toISOString(),
      recurrenceMap: [...recurrenceMap.entries()],
      durationMap: [...durationMap.entries()],
      intervalWeeksMap: [...intervalWeeksMap.entries()],
      result: resultToPersisted(result),
      benchClients,
      hasRunAutoSort,
    }
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload)) } catch {}
  }, [builderStep, maxJobsPerDay, workingDays, dayStartMinutes, dayEndMinutes, selectedIds, startDate, recurrenceMap, durationMap, intervalWeeksMap, result, benchClients, hasRunAutoSort])

  // ── Unsaved-work guard ──
  // Warn on browser tab close / reload when results or optimization are in flight.
  const hasUnsavedWork = builderStep === 'results' || loading
  useEffect(() => {
    if (!hasUnsavedWork) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsavedWork])

  // Intercept the in-app "Back to Schedule" action with a confirm dialog.
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  const requestExit = () => {
    if (hasUnsavedWork) setShowExitConfirm(true)
    else navigate('/schedule')
  }

  const navGuardModal = showExitConfirm ? (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-2">{t('scheduleBuilderWeb.leaveTitle')}</h2>
        <p className="text-sm text-gray-600 mb-5">
          {t('scheduleBuilderWeb.leaveMessage')}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setShowExitConfirm(false)}
            className="flex-1 px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            {t('alerts.stay')}
          </button>
          <button
            onClick={() => { setShowExitConfirm(false); sessionStorage.removeItem(SESSION_KEY); navigate('/schedule') }}
            className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
          >
            {t('scheduleBuilderWeb.leaveAnyway')}
          </button>
        </div>
      </div>
    </div>
  ) : null

  // ── Derived values ──
  const activeDayIndices = useMemo(() =>
    workingDays.map((on, i) => on ? i : -1).filter(i => i >= 0),
    [workingDays]
  )

  const geocodedClients = useMemo(() => store.clients.filter(c => c.lat !== null && c.lng !== null), [store.clients])
  const noAddressClients = useMemo(() => store.clients.filter(c => c.lat === null || c.lng === null), [store.clients])
  const selectedClients = useMemo(() => geocodedClients.filter(c => selectedIds.has(c.id)), [geocodedClients, selectedIds])
  const allSelected = geocodedClients.length > 0 && geocodedClients.every(c => selectedIds.has(c.id))
  const hasHome = store.homeAddress || homeCoords
  const canBuild = hasHome && selectedClients.length >= 3 && workingDays.some(Boolean)

  const recStats = useMemo(() => {
    const counts: Record<Frequency, number> = { weekly: 0, biweekly: 0, monthly: 0 }
    for (const id of selectedIds) {
      const r = recurrenceMap.get(id) ?? 'biweekly'
      counts[r]++
    }
    return counts
  }, [selectedIds, recurrenceMap])

  const clientDayMap = useMemo(() => {
    // Anchor weekday from the client's startDate — independent of calendar month
    // so monthly/biweekly clients whose next occurrence lives in a future month
    // still report their real placement weekday (not a fallback like "today").
    // Unplaced clients are intentionally absent; callers treat missing as -1.
    const map = new Map<string, number>()
    store.clients.forEach(client => {
      if (client.startDate) {
        map.set(client.id, new Date(client.startDate + 'T00:00:00').getDay())
      }
    })
    return map
  }, [store.clients])

  // ── Map computed values (must be at top level for hooks rules) ──
  const builderPlacedIds = useMemo(() => {
    if (!result) return new Set<string>()
    return new Set(result.assignments.keys())
  }, [result])

  const builderDayColorMap = useMemo(() => {
    if (!result) return new Map<string, string>()
    const map = new Map<string, string>()
    // Builder pins inherit the assigned-day color so clients group visually by
    // weekday on the map — matching the column tint in the week-time grid.
    for (const [clientId, day] of result.assignments) {
      map.set(clientId, DAY_COLORS[day])
    }
    return map
  }, [result, DAY_COLORS])

  // ── Change tracking for compare mode ──
  const { changedClientIds, clientFromDay } = useMemo(() => {
    const ids = new Set<string>()
    const fromDay = new Map<string, number>()
    if (result) {
      for (const c of result.changes) {
        ids.add(c.clientId)
        fromDay.set(c.clientId, c.fromDay)
      }
    }
    return { changedClientIds: ids, clientFromDay: fromDay }
  }, [result])

  // ── Route fetching for selected day ──
  useEffect(() => {
    setRouteData(null)
    if (!result || selectedDay === null || !store.homeAddress) return

    // Use the active week filter or default to week 0
    const week = mapWeekFilter ?? 0
    const cells = result.grid.get(`${week}-${selectedDay}`) ?? []
    if (cells.length < 1) return

    const clientsForDay = cells
      .map(c => store.clients.find(cl => cl.id === c.clientId))
      .filter((c): c is Client => c != null && c.lat != null && c.lng != null)

    if (clientsForDay.length < 1) return

    const home = { lat: store.homeAddress.lat, lng: store.homeAddress.lng }
    const ordered: Array<{ lat: number; lng: number }> = [home]
    const remaining = clientsForDay.map(c => ({ lat: c.lat!, lng: c.lng! }))

    let current = home
    while (remaining.length > 0) {
      let bestIdx = 0
      let bestDist = Infinity
      for (let i = 0; i < remaining.length; i++) {
        const d = (remaining[i].lat - current.lat) ** 2 + (remaining[i].lng - current.lng) ** 2
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
      current = remaining.splice(bestIdx, 1)[0]
      ordered.push(current)
    }

    const coordinates = ordered.map(c => [c.lng, c.lat])
    const color = ROUTE_COLOR
    let cancelled = false

    fetch('/api/ors-directions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data?.coordinates?.length) return
        setRouteData({ coordinates: data.coordinates, durationMinutes: data.durationMinutes, distanceMiles: data.distanceMiles, color })
      })
      .catch(() => {})

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, selectedDay, mapWeekFilter, store.homeAddress])

  // ── Resizable divider effect ──
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingDivider.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const schedulePercent = Math.max(30, Math.min(80, (mouseX / rect.width) * 100))
      setMapWidthPercent(100 - schedulePercent)
    }
    const handleMouseUp = () => {
      isDraggingDivider.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // ── Suggested days for unplaced clients ──
  const suggestedDays = useMemo(() => {
    if (!result) return undefined
    const map = new Map<string, { day: number; label: string }>()
    for (const [clientId] of result.assignments) {
      let lightestDay = activeDayIndices[0]
      let lightestCount = Infinity
      for (const day of activeDayIndices) {
        const key = `0-${day}`
        const count = (result.grid.get(key) || []).length
        if (count < lightestCount) { lightestCount = count; lightestDay = day }
      }
      map.set(clientId, { day: lightestDay, label: `${lightestCount}/${maxJobsPerDay}` })
    }
    return map
  }, [result, activeDayIndices, maxJobsPerDay])

  // ── Top 3 day suggestions for the currently selected bench client ──
  // Reuses the Smart Placement scorer (nearest-neighbor + cluster fit + capacity).
  // Only computed when a bench client is selected.
  const benchSuggestions = useMemo<Array<{ day: number; dayName: string; cadenceLabel: string; rotation: 0 | 1; nearestNeighborMin: number; nearbyCount: number; capacityLeft: number; wouldOverflow: boolean }>>(() => {
    if (!selectedClientId || !result) return []
    const selected = benchClients.find(c => c.id === selectedClientId)
    if (!selected) return []
    const client = store.clients.find(c => c.id === selectedClientId)
    if (!client || client.lat == null || client.lng == null) return []

    // Build dayGroups from current assignments (skip the bench client itself).
    const dayGroups = new Map<number, Client[]>()
    const clientDurations = new Map<string, number>()
    const clientFrequency = new Map<string, Client['frequency']>()
    for (const [cId, day] of result.assignments) {
      if (cId === selectedClientId) continue
      const c = store.clients.find(cl => cl.id === cId)
      if (!c) continue
      const group = dayGroups.get(day) ?? []
      group.push(c)
      dayGroups.set(day, group)
      clientDurations.set(cId, durationMap.get(cId) ?? 60)
      clientFrequency.set(cId, recurrenceMap.get(cId) ?? c.frequency)
    }

    const freq = recurrenceMap.get(selectedClientId) ?? client.frequency
    const home = homeCoords ?? (store.homeAddress ? { lat: store.homeAddress.lat, lng: store.homeAddress.lng } : undefined)
    const suggestions = computeSmartPlacement(
      { lat: client.lat, lng: client.lng, frequency: freq, intervalWeeks: intervalWeeksMap.get(selectedClientId), blockedDays: client.blockedDays ?? [] },
      dayGroups,
      { maxJobsPerDay, workingDays, workingMinutes },
      clientDurations,
      clientFrequency,
      durationMap.get(selectedClientId) ?? 60,
      home,
    )

    // Frequency-aware capacity math. A biweekly client only occupies half the weeks,
    // so scoping the peak to the rotation it would actually land on prevents false
    // "over cap" flags on days that look full only because the *other* rotation is full.
    const countOf = (w: number, day: number) => (result.grid.get(`${w}-${day}`) ?? []).length
    const intervalWeeks = intervalWeeksMap.get(selectedClientId) ?? 4
    const peakForDay = (day: number): { peak: number; rotation: 0 | 1; label: string } => {
      if (freq === 'weekly') {
        let peak = 0
        for (let w = 0; w < 4; w++) peak = Math.max(peak, countOf(w, day))
        return { peak, rotation: 0, label: 'every wk' }
      }
      if (freq === 'biweekly') {
        const peakA = Math.max(countOf(0, day), countOf(2, day))
        const peakB = Math.max(countOf(1, day), countOf(3, day))
        return peakA <= peakB
          ? { peak: peakA, rotation: 0, label: 'Wk 1,3' }
          : { peak: peakB, rotation: 1, label: 'Wk 2,4' }
      }
      if (freq === 'monthly') {
        return { peak: countOf(0, day), rotation: 0, label: 'Wk 1' }
      }
      if (freq === 'custom') {
        let peak = 0
        for (let w = 0; w < 4; w += intervalWeeks) peak = Math.max(peak, countOf(w, day))
        return { peak, rotation: 0, label: `every ${intervalWeeks}w` }
      }
      return { peak: countOf(0, day), rotation: 0, label: 'once' }
    }

    const DAY_NAMES_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    // Always return top 3 — days at cap become "over by 1" stretch picks (hard-capped at max+1).
    return suggestions
      .slice(0, 3)
      .map(s => {
        const { peak, rotation, label } = peakForDay(s.day)
        return {
          day: s.day,
          dayName: DAY_NAMES_FULL[s.day],
          cadenceLabel: label,
          rotation,
          nearestNeighborMin: s.nearestNeighborMin,
          nearbyCount: s.nearbyCount,
          capacityLeft: Math.max(0, maxJobsPerDay - peak),
          wouldOverflow: peak >= maxJobsPerDay,
        }
      })
  }, [selectedClientId, benchClients, result, store.clients, durationMap, recurrenceMap, intervalWeeksMap, homeCoords, store.homeAddress, maxJobsPerDay, workingDays, startDate])

  const highlightedClientIds = useMemo(() => {
    if (selectedDay !== null && result) {
      // Use the active week's grid cells for accurate biweekly filtering.
      // Selecting a day still dims other pins — we *want* the day's clients to pop.
      const week = mapWeekFilter ?? 0
      const cells = result.grid.get(`${week}-${selectedDay}`) ?? []
      return new Set(cells.map(c => c.clientId))
    }
    // Tapping a single client (bench or placed) should NOT dim the others —
    // the user needs geographic context. Use emphasizedClientId instead.
    return null
  }, [selectedDay, result, mapWeekFilter])

  const selectedDayLabel = selectedDay !== null ? DAYS[selectedDay] : null

  const handleBuilderPinClick = (clientId: string) => {
    setSelectedDay(null)
    if (!clientId) { setSelectedClientId(null); return }
    setSelectedClientId(prev => prev === clientId ? null : clientId)
  }

  // ── Handlers ──
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

  const handleImportJSON = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    try {
      const text = await file.text()
      const data = JSON.parse(text) as {
        name?: string
        clients: Array<{ name: string; address: string; lat?: number; lng?: number; phone?: string }>
      }
      if (!data.clients || !Array.isArray(data.clients)) {
        alert('Invalid JSON: expected { clients: [...] }')
        return
      }
      const newIds: string[] = []
      for (const c of data.clients) {
        if (!c.name || !c.address) continue
        const coords = c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng } : null
        const id = await store.addClient(c.name, c.address, coords, c.phone)
        if (id) {
          newIds.push(id)
          recurrenceMap.set(id, 'biweekly')
          durationMap.set(id, 60)
        }
      }
      setSelectedIds(prev => {
        const next = new Set(prev)
        newIds.forEach(id => next.add(id))
        return next
      })
      setRecurrenceMap(new Map(recurrenceMap))
      setDurationMap(new Map(durationMap))
      alert(`Imported ${newIds.length} clients from "${data.name || file.name}"`)
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
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
    // Recurrence/intervalWeeks stay local to the builder until Apply so
    // cancelling the schedule change doesn't mutate live clients. Duration is
    // a separate property and continues to sync to the store.
    for (const id of selectedIds) {
      store.updateClientScheduleMeta(id, { duration: setAllDur })
    }
    // Default price — only applied when user explicitly typed one in Set All.
    // Mass set: writes the per-recurrence price into scheduleMeta AND rewrites
    // jobs.price on all forward-looking rows (templates + upcoming instances) for
    // the selected clients. Past completed jobs are frozen. Leave existing prices
    // alone if field is blank. 0 is a valid "clear everyone's price" action — only
    // skip when the field is genuinely empty.
    const priceNum = setAllPrice.trim() ? Number(setAllPrice) : NaN
    if (Number.isFinite(priceNum) && priceNum >= 0) {
      store.bulkUpdateClientPrice(Array.from(selectedIds), priceNum)
    }
  }

  // ── Shared: rebuild changes by comparing assignments against clientDayMap (original days) ──
  const rebuildChanges = (assignments: Map<string, number>) => {
    const changes: Array<{ clientId: string; clientName: string; fromDay: number; toDay: number }> = []
    for (const [cId, newDay] of assignments) {
      const c = store.clients.find(cl => cl.id === cId)
      if (!c) continue
      const originalDay = clientDayMap.get(cId)
      // Include change if: client had an original day and it differs, OR client was unplaced (no original day)
      if (originalDay !== undefined && newDay !== originalDay) {
        changes.push({ clientId: cId, clientName: c.name, fromDay: originalDay, toDay: newDay })
      } else if (originalDay === undefined) {
        // Client was unplaced — treat as new placement (fromDay = -1 as sentinel)
        changes.push({ clientId: cId, clientName: c.name, fromDay: -1, toDay: newDay })
      }
    }
    return changes
  }

  // ── Manual move: reassign a client to a different day ──
  const moveClientToDay = (clientId: string, toDay: number) => {
    if (!result) return
    const currentDay = result.assignments.get(clientId)
    if (currentDay === undefined || currentDay === toDay) return

    const client = store.clients.find(c => c.id === clientId)
    if (!client) return

    const freq = recurrenceMap.get(clientId) ?? client.frequency
    const rotation = result.rotations.get(clientId) ?? 0

    // Build new assignments
    const newAssignments = new Map(result.assignments)
    newAssignments.set(clientId, toDay)

    // Build new grid — remove from old day, add to new day
    const newGrid = new Map(result.grid)

    // Determine which weeks this client appears in
    let maxWeeks = 4
    for (const key of newGrid.keys()) {
      const w = parseInt(key.split('-')[0])
      if (w >= maxWeeks) maxWeeks = w + 1
    }
    let weeks: number[]
    if (freq === 'weekly') {
      weeks = Array.from({ length: maxWeeks }, (_, i) => i)
    } else if (freq === 'biweekly') {
      const start = rotation === 0 ? 0 : 1
      weeks = []
      for (let w = start; w < maxWeeks; w += 2) weeks.push(w)
    } else if (freq === 'custom') {
      const interval = client.intervalWeeks ?? 4
      weeks = []
      for (let w = 0; w < maxWeeks; w += interval) weeks.push(w)
    } else {
      weeks = [0]
    }

    // Remove from old day cells
    for (const w of weeks) {
      const oldKey = `${w}-${currentDay}`
      const oldCells = newGrid.get(oldKey) ?? []
      newGrid.set(oldKey, oldCells.filter(c => c.clientId !== clientId))
    }

    // Add to new day cells
    for (const w of weeks) {
      const newKey = `${w}-${toDay}`
      const existing = newGrid.get(newKey) ?? []
      newGrid.set(newKey, [...existing, {
        clientId,
        clientName: client.name,
        routeOrder: existing.length,
        recurrence: freq as 'weekly' | 'biweekly' | 'monthly' | 'one-time' | 'custom',
        rotation: rotation as 0 | 1,
      }])
    }

    setResult({
      ...result,
      assignments: newAssignments,
      grid: newGrid,
      changes: rebuildChanges(newAssignments),
    })
    setSelectedClientId(null)
    setSelectedDay(null)
  }

  // ── Remove client from grid to bench ──
  const removeClientToBench = (clientId: string) => {
    if (!result) return
    const currentDay = result.assignments.get(clientId)
    if (currentDay === undefined) return

    const client = store.clients.find(c => c.id === clientId)
    if (!client) return

    const freq = recurrenceMap.get(clientId) ?? client.frequency
    const rotation = result.rotations.get(clientId) ?? 0

    // Remove from grid
    const newGrid = new Map(result.grid)
    let maxWeeks = 4
    for (const key of newGrid.keys()) {
      const w = parseInt(key.split('-')[0])
      if (w >= maxWeeks) maxWeeks = w + 1
    }
    let weeks: number[]
    if (freq === 'weekly') {
      weeks = Array.from({ length: maxWeeks }, (_, i) => i)
    } else if (freq === 'biweekly') {
      weeks = []
      for (let w = rotation === 0 ? 0 : 1; w < maxWeeks; w += 2) weeks.push(w)
    } else if (freq === 'custom') {
      weeks = []
      for (let w = 0; w < maxWeeks; w += (client.intervalWeeks ?? 4)) weeks.push(w)
    } else {
      weeks = [0]
    }
    for (const w of weeks) {
      const key = `${w}-${currentDay}`
      const cells = newGrid.get(key) ?? []
      newGrid.set(key, cells.filter(c => c.clientId !== clientId))
    }

    // Remove from assignments
    const newAssignments = new Map(result.assignments)
    newAssignments.delete(clientId)

    // Rebuild changes
    const newChanges = result.changes.filter(c => c.clientId !== clientId)

    setBenchClients(prev => [...prev, { id: clientId, name: client.name, color: client.color, frequency: recurrenceMap.get(clientId) ?? client.frequency }])
    setResult({ ...result, assignments: newAssignments, grid: newGrid, changes: newChanges })
    // Keep client selected so user can immediately click a day to place them
    setSelectedClientId(clientId)
  }

  // ── Place client from bench onto a day ──
  // `rotationOverride` lets the bench suggestion pill put a biweekly client on the
  // lighter rotation (A vs B) even if the user is viewing the other week.
  const placeClientFromBench = (clientId: string, toDay: number, rotationOverride?: 0 | 1) => {
    if (!result) return
    const client = store.clients.find(c => c.id === clientId)
    if (!client) return

    const freq = recurrenceMap.get(clientId) ?? client.frequency

    const newGrid = new Map(result.grid)
    let maxWeeks = 4
    for (const key of newGrid.keys()) {
      const w = parseInt(key.split('-')[0])
      if (w >= maxWeeks) maxWeeks = w + 1
    }

    // Manual placement rotation: prefer explicit override from the suggestion pill.
    // Fallback: viewing W1/W3 (even) → rotation 0, W2/W4 (odd) → rotation 1.
    const viewingWeek = mapWeekFilter ?? 0
    const rotation: 0 | 1 = freq === 'biweekly'
      ? (rotationOverride ?? (viewingWeek % 2 === 0 ? 0 : 1))
      : 0

    let weeks: number[]
    if (freq === 'weekly') {
      weeks = Array.from({ length: maxWeeks }, (_, i) => i)
    } else if (freq === 'biweekly') {
      weeks = []
      for (let w = rotation === 0 ? 0 : 1; w < maxWeeks; w += 2) weeks.push(w)
    } else if (freq === 'custom') {
      weeks = []
      for (let w = 0; w < maxWeeks; w += (client.intervalWeeks ?? 4)) weeks.push(w)
    } else {
      weeks = [0]
    }

    // Capacity guard: block placements that would push any target week over the cap.
    // Users should steer via the suggestion pills (already capacity-filtered) or
    // raise max jobs/day to make room.
    // Allow one-over stretch (max+1) for manual placements from bench suggestions.
    // Hard cap beyond that so a "full" schedule can still absorb a few benched clients
    // without the user having to raise the setting for everyone.
    for (const w of weeks) {
      const count = (newGrid.get(`${w}-${toDay}`) ?? []).length
      if (count >= maxJobsPerDay + 1) {
        alert(t('scheduleBuilderWeb.dayAtCap', { day: DAYS[toDay], count, max: maxJobsPerDay }))
        return
      }
    }

    for (const w of weeks) {
      const newKey = `${w}-${toDay}`
      const existing = newGrid.get(newKey) ?? []
      newGrid.set(newKey, [...existing, {
        clientId,
        clientName: client.name,
        routeOrder: existing.length,
        recurrence: freq as 'weekly' | 'biweekly' | 'monthly' | 'one-time' | 'custom',
        rotation: rotation as 0 | 1,
      }])
    }

    const newAssignments = new Map(result.assignments)
    newAssignments.set(clientId, toDay)

    const newRotations = new Map(result.rotations)
    newRotations.set(clientId, rotation)

    setBenchClients(prev => prev.filter(c => c.id !== clientId))
    setResult({ ...result, assignments: newAssignments, rotations: newRotations, grid: newGrid, changes: rebuildChanges(newAssignments) })
    setSelectedClientId(null)
  }

  const runEngine = async (overrideMaxJobs?: number) => {
    const home = homeCoords ?? (store.homeAddress ? { lat: store.homeAddress.lat, lng: store.homeAddress.lng } : null)
    if (!home) return

    // Save home address if changed
    if (homeInputValue && homeCoords && !store.homeAddress) {
      await store.setHomeAddress(homeInputValue, homeCoords)
    }

    const effectiveMaxJobs = overrideMaxJobs ?? maxJobsPerDay

    // Build locks from current grid state. Iterate placed cells in week/day order
    // so each client locks to its FIRST occurrence — repeats of the same client
    // across weeks (biweekly A/B, monthly, custom) inherit the first cell's day.
    // Web grid keys are `${week}-${day}` (not mobile's `w${w}-d${day}`).
    // Empty on the first run (no result yet) — engine treats undefined locks as none.
    const lockedClients = new Map<string, { day: number; rotation: 0 | 1 }>()
    if (result) {
      const sortedGridKeys = [...result.grid.keys()].sort((a, b) => {
        const [aw, ad] = a.split('-').map(Number)
        const [bw, bd] = b.split('-').map(Number)
        return aw - bw || ad - bd
      })
      for (const key of sortedGridKeys) {
        const m = key.match(/^(\d+)-(\d+)$/)
        if (!m) continue
        const week = Number(m[1])
        const day = Number(m[2])
        const cells = result.grid.get(key) ?? []
        for (const cell of cells) {
          if (lockedClients.has(cell.clientId)) continue
          const rotation: 0 | 1 = cell.recurrence === 'biweekly' ? ((week % 2) as 0 | 1) : 0
          lockedClients.set(cell.clientId, { day, rotation })
        }
      }
    }

    // Sort by id so the engine's tie-breaks (seed picker + biweekly A/B split)
    // resolve identically to mobile, which sorts the same way before calling in.
    // Without this, duplicate-coord clients hit ties in input-array order and
    // the two platforms diverge on rotation labels for the same dataset.
    const sortedClients = [...selectedClients].sort((a, b) => a.id.localeCompare(b.id))
    const clientsWithDays = sortedClients.map(c => ({
      client: {
        ...c,
        frequency: recurrenceMap.get(c.id) ?? c.frequency,
        intervalWeeks: intervalWeeksMap.get(c.id) ?? c.intervalWeeks,
      },
      // -1 sentinel for unplaced — the optimizer emits fromDay=-1 in its changes,
      // which the UI renders as "New" instead of a weekday.
      currentDay: clientDayMap.get(c.id) ?? -1,
    }))

    setLoading(true)
    try {
      const recMap = new Map<string, string>()
      for (const id of selectedIds) {
        recMap.set(id, recurrenceMap.get(id) ?? 'biweekly')
      }

      // ── Debug logging (compare web vs mobile engine output) ────────────────
      // Mirrors mobile's scheduleBuilderAdapter logger byte-for-byte so logs diff
      // literally. Tags: [ENGINE-IN] inputs · [MATRIX] ORS matrix · [ENGINE-OUT].
      // Force-on for the cross-platform diff — Vite's import.meta.env.DEV is
      // false in any production build, so we'd lose the log on Vercel. Flip
      // back to `import.meta.env.DEV && true` once the diff is done.
      const DEBUG_ENGINE = true
      const DEBUG_MATRIX = DEBUG_ENGINE && true
      const dump = (tag: string, payload: unknown) => {
        // One line per tag — terminal copy-paste preserves structure.
        console.log(`[${tag}] ${JSON.stringify(payload)}`)
      }

      if (DEBUG_ENGINE) {
        const stops = [...selectedClients]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(c => ({
            id: c.id,
            name: c.name,
            lat: c.lat ?? null,
            lng: c.lng ?? null,
            freq: recurrenceMap.get(c.id) ?? c.frequency ?? null,
            duration: durationMap.get(c.id) ?? null,
            rate: c.rate ?? null,
            blocked: [...(c.blockedDays ?? [])].sort((a, b) => a - b),
          }))
        dump('ENGINE-IN', {
          home: { lat: home.lat, lng: home.lng },
          config: {
            maxJobsPerDay: effectiveMaxJobs,
            workingDays,
            workingMinutes: workingMinutes ?? null,
          },
          stops,
          locked: [...lockedClients.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, { day, rotation }]) => ({ id, day, rotation })),
        })
      }

      // Mirrors mobile: separate matrix call so we can log it. Doubles ORS quota
      // when DEBUG_MATRIX is on — only enable while debugging.
      if (DEBUG_MATRIX) {
        const sortedStops = [...selectedClients].sort((a, b) => a.id.localeCompare(b.id))
        const debugCoords: Array<{ lat: number; lng: number }> = [{ lat: home.lat, lng: home.lng }]
        const labels: string[] = ['home']
        for (const s of sortedStops) {
          if (s.lat == null || s.lng == null) continue
          debugCoords.push({ lat: s.lat, lng: s.lng })
          labels.push(s.id)
        }
        try {
          const matrix = await getORSMatrixSeconds(debugCoords)
          dump('MATRIX', {
            labels,
            // Round to whole seconds so float noise doesn't create false diffs.
            seconds: matrix.map(row => row.map(v => Math.round(v))),
          })
        } catch (err) {
          console.warn('[MATRIX] ORS fetch failed:', err)
        }
      }

      const r = await generatePerfectSchedule(
        clientsWithDays,
        { maxJobsPerDay: effectiveMaxJobs, workingDays, workingMinutes },
        home,
        durationMap,
        recMap,
        lockedClients,
      )

      if (DEBUG_ENGINE) {
        const assignments = [...r.assignments.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, day]) => ({
            id,
            day,
            rotation: (r.rotations.get(id) ?? 0) as 0 | 1,
          }))
        dump('ENGINE-OUT', {
          assignments,
          benched: [...r.benched].sort(),
          totalDriveMinutes: r.totalDriveMinutes,
          currentDriveMinutes: r.currentDriveMinutes,
        })

        // Per-week grid view — shows exactly what the engine placed in each cell.
        // Format: "W1 Su:0/0 Mo:4/5 Tu:4/5 We:3/5 Th:5/5 Fr:5/5 Sa:0/0"
        // Numerator = clients in that cell. Denominator = maxJobsPerDay (or 0 for inactive days).
        const DAY_ABBR = ['Su','Mo','Tu','We','Th','Fr','Sa']
        let maxWeeks = 4
        for (const [, cells] of r.grid) {
          for (const cell of cells) {
            if (cell.recurrence === 'custom') {
              const c = selectedClients.find(cl => cl.id === cell.clientId)
              if (c?.intervalWeeks && c.intervalWeeks > maxWeeks) maxWeeks = c.intervalWeeks
            }
          }
        }
        for (let w = 0; w < maxWeeks; w++) {
          const parts = DAY_ABBR.map((abbr, d) => {
            const isActive = workingDays[d]
            if (!isActive) return `${abbr}:0/0`
            const key = `${w}-${d}`
            const count = r.grid.get(key)?.length ?? 0
            return `${abbr}:${count}/${effectiveMaxJobs}`
          })
          console.log(`[SCHEDULE-VIEW] W${w + 1} ${parts.join(' ')}`)
        }
        if (r.benched.length > 0) {
          const names = r.benched.map(id => selectedClients.find(c => c.id === id)?.name ?? id)
          console.log(`[SCHEDULE-VIEW] Benched (${r.benched.length}): ${names.join(', ')}`)
        }
      }

      setResult(r)
      // Always reset bench from the fresh result — stale bench from a prior run
      // (e.g. after the user raised max jobs and everything now fits) must clear.
      const benchedClients = r.benched.map(id => {
        const client = selectedClients.find(c => c.id === id)
        if (!client) return null
        return {
          id: client.id,
          name: client.name,
          color: client.color,
          frequency: recurrenceMap.get(client.id) ?? client.frequency,
        }
      }).filter((c): c is { id: string; name: string; color: string; frequency: Client['frequency'] } => c !== null)
      setBenchClients(benchedClients)
      setHasRunAutoSort(true)
      setBuilderStep('results')
    } catch (err) {
      console.error('Perfect schedule failed:', err)
      alert(t('generator.failedToast'))
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmRaiseMax = () => {
    const newMax = maxJobsPerDay + 1
    setMaxJobsPerDay(newMax)
    setShowRaiseMaxConfirm(false)
    runEngine(newMax)
  }

  // ── AI polish: ship the engine result to /api/ai/optimize, swap in the
  //    refined schedule + trace. Engine result is unchanged on failure. ──
  const polishWithAI = async () => {
    if (!result) return
    setAiPolishing(true)
    setAiError(null)
    try {
      const { refinedSchedule, trace } = await optimizeViaAI({
        schedule: result,
        scheduleId: `session-${Date.now()}`,
      })
      setResult(refinedSchedule)
      setAiTrace(trace)
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err))
    } finally {
      setAiPolishing(false)
    }
  }

  // ── Enter the builder with everyone unplaced ──
  // Mirrors mobile's flow: user lands on an empty grid with all eligible clients
  // in the bench, can manually pre-place specific clients on specific days, then
  // hits Auto Sort to fill in the rest. Pre-placed clients become locks (handled
  // by runEngine via lockedClients), so the engine respects manual choices.
  const enterManualMode = () => {
    const eligible = selectedClients.filter(c => c.lat !== null && c.lng !== null)
    const emptyResult: PerfectScheduleResult = {
      assignments: new Map(),
      rotations: new Map(),
      routesByDay: new Map(),
      grid: new Map(),
      totalDriveMinutes: 0,
      currentDriveMinutes: 0,
      changes: [],
      benched: eligible.map(c => c.id),
      legTimes: new Map(),
      cellDriveMinutes: new Map(),
      _context: emptyScheduleContext(),
    }
    setResult(emptyResult)
    setBenchClients(eligible.map(c => ({
      id: c.id,
      name: c.name,
      color: c.color,
      frequency: recurrenceMap.get(c.id) ?? c.frequency,
    })))
    setHasRunAutoSort(false)
    setBuilderStep('results')
  }

  // ── Results mode ──
  if (builderStep === 'results' && result) {
    const builderClients = selectedClients.filter(c => c.lat !== null && c.lng !== null)
    const placedCount = result.assignments.size
    const totalCount = selectedClients.length
    const saved = Math.max(0, result.currentDriveMinutes - result.totalDriveMinutes)

    // Filter clients shown on map by active week
    const weekClientIds = mapWeekFilter !== null
      ? new Set(
          activeDayIndices.flatMap(day => {
            const cells = result.grid.get(`${mapWeekFilter}-${day}`) ?? []
            return cells.map(c => c.clientId)
          })
        )
      : null
    // Always include bench clients on the map regardless of week filter
    const benchIds = new Set(benchClients.map(c => c.id))
    const mapClients = weekClientIds
      ? builderClients.filter(c => weekClientIds.has(c.id) || benchIds.has(c.id))
      : builderClients
    const mapPlacedIds = weekClientIds
      ? new Set([...builderPlacedIds].filter(id => weekClientIds.has(id)))
      : builderPlacedIds

    const confirmApply = () => {
      if (!result) return
      // Only place clients who were actually assigned (skip benched) — bench
      // clients have dayOfWeek = -1 and shouldn't get a new recurrence.
      const assignments = new Map<string, number>()
      const recMap = new Map<string, Client['frequency']>()
      for (const [clientId, day] of result.assignments) {
        if (day < 0) continue
        assignments.set(clientId, day)
        recMap.set(clientId, (recurrenceMap.get(clientId) ?? 'biweekly') as Client['frequency'])
      }

      // Non-destructive: stash Builder output as a draft SchedulePlan and nav
      // to the Transition workspace. Live schedule untouched until the user
      // hits the final Apply inside Transition.
      const planId = store.createSchedulePlan(assignments, result.rotations, recMap, intervalWeeksMap)

      // Still surface Transition moves for the UI — they read from the plan now.
      const allChanges = [] as typeof result.changes
      for (const [clientId, toDay] of result.assignments) {
        if (toDay < 0) continue
        const client = store.clients.find(c => c.id === clientId)
        if (!client) continue
        const fromDay = clientDayMap.get(clientId) ?? -1
        allChanges.push({ clientId, clientName: client.name, fromDay, toDay })
      }
      const moves = buildTransitionMoves(allChanges, store.clients, result.rotations, recMap as unknown as Map<string, string>)
      sessionStorage.removeItem(SESSION_KEY)
      navigate('/schedule-change', {
        state: {
          transitionMoves: moves,
          transitionRecMap: Object.fromEntries(recMap),
          transitionRotations: Object.fromEntries(result.rotations),
          transitionConfig: { maxJobsPerDay, workingDays },
          planId,
        },
      })
    }

    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-200/80 bg-white shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setBuilderStep('setup')}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
              <span className="font-medium">{t('scheduleBuilderWeb.backToSetup')}</span>
            </button>
            <h1 className="text-sm font-bold text-gray-900 tracking-tight">{t('scheduleBuilder.title')}</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowResetConfirm(true)}
              disabled={loading || result.assignments.size === 0}
              title={result.assignments.size === 0
                ? 'Nothing placed yet — bench already has everyone.'
                : 'Move every placed client back to the bench. Recurrence and durations stay set.'}
              className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-600 transition-colors"
            >
              Reset
            </button>
            <button
              onClick={() => runEngine()}
              disabled={loading || benchClients.length === 0}
              title={benchClients.length === 0
                ? 'All clients are placed — nothing to sort.'
                : "Place all unplaced clients via the optimizer. Anything you've already placed stays put."}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600 transition-colors flex items-center gap-1.5"
            >
              {loading ? (
                <>
                  <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Sorting…
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                  </svg>
                  Auto Sort
                </>
              )}
            </button>
            <button
              onClick={polishWithAI}
              disabled={aiPolishing || loading || result.assignments.size === 0}
              title={result.assignments.size === 0
                ? 'Run Auto Sort first.'
                : 'Send the schedule to the AI optimizer for a final pass. Engine result is preserved on failure.'}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-gradient-to-r from-purple-600 to-fuchsia-600 rounded-lg hover:from-purple-700 hover:to-fuchsia-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
            >
              {aiPolishing ? (
                <>
                  <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Polishing…
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 16v-2m6-6h2M4 12H2m13.07-7.07l1.41 1.41M5.52 18.48l1.41-1.41m0-10.14L5.52 5.52m12.96 12.96l-1.41-1.41M12 9a3 3 0 100 6 3 3 0 000-6z" />
                  </svg>
                  Polish with AI
                </>
              )}
            </button>
            <div className="flex items-center gap-1.5 bg-gray-100 rounded-lg px-3 py-1.5">
              <span className="text-xs font-bold text-gray-700 tabular-nums">{placedCount}</span>
              <span className="text-xs text-gray-400">/</span>
              <span className="text-xs text-gray-400 tabular-nums">{totalCount}</span>
              <span className="text-[10px] text-gray-400 ml-0.5">{t('scheduleBuilder.placed')}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-400 tabular-nums">{result.currentDriveMinutes}m</span>
              <svg className="w-3 h-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
              <span className="font-bold text-gray-700 tabular-nums">{result.totalDriveMinutes}m</span>
              <span className="text-gray-400">{t('scheduleBuilderWeb.avgPerWeek')}</span>
              {saved > 0 && (
                <span className="text-xs font-bold text-green-600 bg-green-50 px-1.5 py-0.5 rounded-md">
                  -{saved}m
                </span>
              )}
            </div>
          </div>
        </div>

        {/* AI status strip — hidden in Rounds rebrand */}
        {false && (aiTrace || aiError) && (
          <div className="px-4 py-2 border-b border-gray-100 bg-white">
            {aiError ? (
              <div className="flex items-center justify-between gap-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                <span className="text-xs text-red-800">
                  <span className="font-semibold">AI polish failed:</span> {aiError}
                </span>
                <button
                  onClick={() => setAiError(null)}
                  className="text-xs text-red-700 hover:text-red-900 px-2 py-0.5"
                >
                  Dismiss
                </button>
              </div>
            ) : aiTrace ? (
              <AITracePanel trace={aiTrace} onDismiss={() => setAiTrace(null)} />
            ) : null}
          </div>
        )}

        {/* Two-panel body */}
        <div ref={containerRef} className="flex-1 flex overflow-hidden">
          {/* Schedule panel (left) */}
          <div className="flex flex-col bg-white min-w-0" style={{ flex: `${100 - mapWidthPercent} 0 0%` }}>
            <WeekTimeGrid
              grid={result.grid}
              activeDays={activeDayIndices}
              durationMap={durationMap}
              legTimes={result.legTimes}
              cellDriveMinutes={result.cellDriveMinutes}
              maxJobsPerDay={maxJobsPerDay}
              selectedClientId={selectedClientId}
              onClientClick={(clientId) => {
                setSelectedDay(null)
                setSelectedClientId(prev => prev === clientId ? null : clientId)
              }}
              onDayClick={(day) => {
                if (selectedClientId) {
                  // Check if selected client is on bench or on grid
                  const onBench = benchClients.some(c => c.id === selectedClientId)
                  if (onBench) {
                    placeClientFromBench(selectedClientId, day)
                  } else {
                    moveClientToDay(selectedClientId, day)
                  }
                } else {
                  setSelectedDay(prev => prev === day ? null : day)
                }
              }}
              selectedDay={selectedDay}
              suggestedDays={suggestedDays}
              changedClientIds={changedClientIds}
              clientFromDay={clientFromDay}
              onWeekChange={setMapWeekFilter}
              showAllWeeksOption
              onRemoveClient={removeClientToBench}
              benchHasClients={benchClients.length > 0}
              unplacedClients={benchClients}
              hasRunAutoSort={hasRunAutoSort}
              onConfirmSchedule={() => setShowConfirm(true)}
              benchSuggestions={benchSuggestions}
              onPlaceBenchClient={placeClientFromBench}
              onRaiseMaxJobs={() => setShowRaiseMaxConfirm(true)}
              maxJobsPerDayForBench={maxJobsPerDay}
              onPlaceClient={(clientId, dayIndex) => {
                const onBench = benchClients.some(c => c.id === clientId)
                if (onBench) {
                  placeClientFromBench(clientId, dayIndex)
                } else {
                  moveClientToDay(clientId, dayIndex)
                }
              }}
              onReorderClients={(day, week, orderedIds) => {
                if (!result) return
                const newGrid = new Map(result.grid)
                const key = `${week}-${day}`
                const cells = newGrid.get(key) ?? []
                // Reorder cells to match the new order
                const reordered = orderedIds
                  .map((id, i) => {
                    const cell = cells.find(c => c.clientId === id)
                    return cell ? { ...cell, routeOrder: i } : null
                  })
                  .filter((c): c is NonNullable<typeof c> => c !== null)
                newGrid.set(key, reordered)
                setResult({ ...result, grid: newGrid })
              }}
            />
          </div>

          {/* Divider */}
          <div
            className="w-1.5 bg-gray-200 cursor-col-resize hover:bg-gray-400 active:bg-gray-500 transition-colors shrink-0"
            onMouseDown={() => {
              isDraggingDivider.current = true
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
            }}
          />

          {/* Map panel (right) */}
          <div className="relative" style={{ flex: `${mapWidthPercent} 0 0%` }}>
            <ClientMap
              clients={mapClients}
              placedClientIds={mapPlacedIds}
              clientDayColorMap={builderDayColorMap}
              highlightedClientIds={highlightedClientIds}
              emphasizedClientId={selectedClientId}
              selectedDateLabel={selectedDayLabel}
              onPinClick={handleBuilderPinClick}
              homeAddress={store.homeAddress ? { lat: store.homeAddress.lat, lng: store.homeAddress.lng } : null}
              route={routeData}
              dayColors={DAY_COLORS}
            />
          </div>
        </div>

        {/* Changes panel — slides up from footer */}
        {showChanges && (
          <div className="border-t border-gray-200/80 bg-white shrink-0 max-h-[40vh] overflow-y-auto">
            <div className="px-4 py-3">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-bold text-gray-900">{t('scheduleBuilderWeb.clientsMoving', { count: changedClientIds.size })}</h3>
                  <span className="text-[10px] text-gray-400">{t('scheduleBuilderWeb.unchangedCount', { count: (result?.assignments.size ?? 0) - changedClientIds.size })}</span>
                </div>
                <button onClick={() => setShowChanges(false)} className="text-gray-400 hover:text-gray-600">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="space-y-1">
                {result.changes.map(change => (
                  <button
                    key={change.clientId}
                    onClick={() => {
                      setSelectedClientId(prev => prev === change.clientId ? null : change.clientId)
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                      selectedClientId === change.clientId ? 'bg-amber-50 ring-1 ring-amber-200' : 'hover:bg-gray-50'
                    }`}
                  >
                    <span className="text-xs font-semibold text-gray-800 flex-1 truncate">{change.clientName}</span>
                    {change.fromDay === -1 ? (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded text-gray-500 bg-gray-100">
                        {t('common.new')}
                      </span>
                    ) : (
                      <span
                        className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                        style={{ color: DAY_COLORS[change.fromDay], backgroundColor: DAY_COLORS[change.fromDay] + '15' }}
                      >
                        {DAYS[change.fromDay]}
                      </span>
                    )}
                    <svg className="w-3 h-3 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                    </svg>
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                      style={{ color: DAY_COLORS[change.toDay], backgroundColor: DAY_COLORS[change.toDay] + '15' }}
                    >
                      {DAYS[change.toDay]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-gray-200/80 bg-white shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowChanges(prev => !prev)}
              className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold rounded-md transition-all duration-150 ${
                showChanges
                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                  : 'text-gray-500 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              <span>{t('scheduleBuilderWeb.changesCount', { count: changedClientIds.size })}</span>
              <svg className={`w-3 h-3 transition-transform ${showChanges ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
              </svg>
            </button>
            <span className="text-[11px] font-bold text-green-600">
              -{saved}m {t('scheduleBuilderWeb.avgPerWeek')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {activeChange ? (
              <button
                onClick={() => setShowBlockedApply(true)}
                title={t('scheduleBuilderWeb.blockedTooltip', { resolved: activeChange.resolved, total: activeChange.total })}
                className="px-4 py-2 text-[11px] font-bold text-gray-400 bg-gray-100 rounded-lg cursor-not-allowed border border-gray-200 flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                {t('scheduleBuilderWeb.applyBlocked')}
              </button>
            ) : (
              <button
                onClick={() => setShowConfirm(true)}
                className="px-4 py-2 text-[11px] font-bold text-white bg-gray-900 rounded-lg hover:bg-gray-800 transition-all duration-150 shadow-sm shadow-gray-900/20 flex items-center gap-1.5"
              >
                {t('scheduleBuilderWeb.startScheduleChange')}
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Confirmation modal */}
        {showConfirm && result && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowConfirm(false)}>
            <div className="bg-white rounded-xl shadow-2xl w-[400px] p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 mb-4">{t('scheduleBuilderWeb.startScheduleChangeTitle')}</h3>
              <div className="space-y-2 mb-5">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('scheduleBuilderWeb.clientsChangingDays')}</span>
                  <span className="font-semibold text-gray-900">{result.changes.length}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('scheduleBuilderWeb.driveTimeSaved')}</span>
                  <span className="font-semibold text-green-600">
                    {Math.max(0, result.currentDriveMinutes - result.totalDriveMinutes)}m {t('scheduleBuilderWeb.avgPerWeek')}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('scheduleBuilderWeb.totalClients')}</span>
                  <span className="font-semibold text-gray-900">{result.assignments.size}</span>
                </div>
              </div>
              <div className="text-xs text-gray-500 mb-5">
                <p>
                  {t('scheduleBuilderWeb.confirmDescription')}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={confirmApply}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700"
                >
                  {t('generator.recurrenceTagging.apply')}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Blocked Apply modal — surfaces when a schedule change is still in flight. */}
        {showBlockedApply && activeChange && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowBlockedApply(false)}>
            <div className="bg-white rounded-xl shadow-2xl w-[420px] p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{t('scheduleBuilderWeb.blockedTitle')}</h3>
              <p className="text-sm text-gray-600 mb-2">
                {t('scheduleBuilderWeb.blockedBodyBefore')} <span className="font-semibold">{t('scheduleBuilderWeb.blockedProgress', { resolved: activeChange.resolved, total: activeChange.total })}</span> {t('scheduleBuilderWeb.blockedBodyAfter')}
              </p>
              <p className="text-xs text-gray-500 mb-5">
                {t('scheduleBuilderWeb.blockedHint')}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowBlockedApply(false)}
                  className="flex-1 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    setShowBlockedApply(false)
                    navigate('/schedule')
                  }}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-800"
                >
                  {t('scheduleBuilderWeb.goToSchedule')}
                </button>
              </div>
              <button
                onClick={() => {
                  setShowBlockedApply(false)
                  setShowStartOverConfirm(true)
                }}
                className="mt-3 w-full text-xs text-red-600 hover:text-red-700 font-medium"
              >
                {t('scheduleBuilderWeb.startOverAnyway')}
              </button>
            </div>
          </div>
        )}

        {/* Start over confirm modal — destroys the in-flight change + proceeds to Apply. */}
        {showStartOverConfirm && activeChange && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowStartOverConfirm(false)}>
            <div className="bg-white rounded-xl shadow-2xl w-[420px] p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{t('scheduleBuilderWeb.startOverTitle')}</h3>
              <p className="text-sm text-gray-600 mb-2">
                {t('scheduleBuilderWeb.startOverBodyBefore')} <span className="font-semibold">{t('scheduleBuilderWeb.confirmationsLost', { count: activeChange.confirmed })}</span> {t('scheduleBuilderWeb.startOverBodyAfter')}
              </p>
              <p className="text-xs text-gray-500 mb-5">
                {t('scheduleBuilderWeb.startOverHint')}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowStartOverConfirm(false)}
                  className="flex-1 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    clearActiveChange(activeChange.applyId)
                    setActiveChange(null)
                    setShowStartOverConfirm(false)
                    setShowConfirm(true)
                  }}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
                >
                  {t('scheduleBuilderWeb.discardAndContinue')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Reset confirm modal — wipes the grid back to an empty bench. */}
        {showResetConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowResetConfirm(false)}>
            <div className="bg-white rounded-xl shadow-2xl w-[400px] p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 mb-2">Reset schedule?</h3>
              <p className="text-sm text-gray-600 mb-5">
                Move every placed client back to the bench. Recurrence, durations, and your client selection stay set — only the day assignments are cleared.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="flex-1 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => { setShowResetConfirm(false); enterManualMode() }}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Raise max-jobs-per-day confirm modal */}
        {showRaiseMaxConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowRaiseMaxConfirm(false)}>
            <div className="bg-white rounded-xl shadow-2xl w-[400px] p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 mb-3">Raise max jobs per day?</h3>
              <p className="text-sm text-gray-600 mb-2">
                Rerun the schedule with <span className="font-semibold text-gray-900">{maxJobsPerDay + 1}</span> max jobs/day
                (up from {maxJobsPerDay}).
              </p>
              <p className="text-xs text-gray-400 mb-5">
                Your current assignments will be recomputed — any manual moves will not be preserved.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowRaiseMaxConfirm(false)}
                  className="flex-1 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmRaiseMax}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700"
                >
                  Rerun
                </button>
              </div>
            </div>
          </div>
        )}
        {navGuardModal}
      </div>
    )
  }

  // ── Setup mode ──
  return (
    <div className="h-full flex flex-col bg-surface-page">
      {navGuardModal}
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-200 bg-white shrink-0 flex items-center gap-3">
        <button
          onClick={requestExit}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Back to Schedule
        </button>
        <h1 className="text-base font-bold text-gray-900">Schedule Builder</h1>
      </div>

      {/* Scrollable form body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[720px] mx-auto py-6 px-4 space-y-6">

          {/* ═══ SECTION 1: Configuration ═══ */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="text-sm font-bold text-gray-900">Configuration</h2>
            </div>
            <div className="p-5 space-y-5">
              {/* Starting Address */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Starting Address</label>
                {hasHome && !editingHome ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-emerald-50 rounded-lg border border-emerald-200 dark:border-emerald-400/30">
                    <svg className="w-4 h-4 text-emerald-500 dark:text-emerald-300 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3L4 9v12h5v-7h6v7h5V9l-8-6z"/></svg>
                    <span className="text-sm text-gray-700 flex-1 truncate">{store.homeAddress?.address ?? homeInputValue}</span>
                    <svg className="w-4 h-4 text-emerald-500 dark:text-emerald-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
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
                      onSelect={async r => {
                        setHomeInputValue(r.address)
                        setHomeCoords({ lat: r.lat, lng: r.lng })
                        await store.setHomeAddress(r.address, { lat: r.lat, lng: r.lng })
                        setEditingHome(false)
                      }}
                      onKeyDown={async e => {
                        if (e.key === 'Enter' && homeInputValue.trim() && homeCoords) {
                          await store.setHomeAddress(homeInputValue.trim(), homeCoords)
                          setEditingHome(false)
                        }
                      }}
                      placeholder="Your starting address"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500/20"
                    />
                    {store.homeAddress && (
                      <button onClick={() => setEditingHome(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                    )}
                  </div>
                )}
              </div>

              {/* Settings row */}
              {/* Working hours — single window applied to all working days.
                  Sum of job durations per day must fit. Drive time ignored
                  (grouping by location makes it negligible). */}
              <div className="mb-4">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">
                  Working Hours <span className="text-gray-400 font-normal normal-case">({Math.floor(workingMinutes / 60)}h{workingMinutes % 60 > 0 ? ` ${workingMinutes % 60}m` : ''} window)</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={`${String(Math.floor(dayStartMinutes / 60)).padStart(2, '0')}:${String(dayStartMinutes % 60).padStart(2, '0')}`}
                    onChange={e => {
                      const [h, m] = e.target.value.split(':').map(Number)
                      if (!Number.isNaN(h) && !Number.isNaN(m)) setDayStartMinutes(h * 60 + m)
                    }}
                    className="flex-1 h-8 px-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500/20 dark:bg-surface-subtle dark:text-ink-primary"
                  />
                  <span className="text-xs text-gray-400">to</span>
                  <input
                    type="time"
                    value={`${String(Math.floor(dayEndMinutes / 60)).padStart(2, '0')}:${String(dayEndMinutes % 60).padStart(2, '0')}`}
                    onChange={e => {
                      const [h, m] = e.target.value.split(':').map(Number)
                      if (!Number.isNaN(h) && !Number.isNaN(m)) setDayEndMinutes(h * 60 + m)
                    }}
                    className="flex-1 h-8 px-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500/20 dark:bg-surface-subtle dark:text-ink-primary"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                {/* Max Jobs */}
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">Max Jobs / Day</label>
                  <div className="flex items-center gap-2 bg-gray-100 rounded-lg p-1 dark:bg-surface-page">
                    <button
                      onClick={() => setMaxJobsPerDay(Math.max(1, maxJobsPerDay - 1))}
                      disabled={maxJobsPerDay <= 1}
                      className="w-8 h-8 flex items-center justify-center bg-white rounded-md shadow-sm text-gray-500 disabled:opacity-30 hover:bg-gray-50 dark:bg-surface-chip dark:text-ink-primary dark:border dark:border-edge-default"
                    >
                      -
                    </button>
                    <span className="flex-1 text-center text-sm font-bold text-gray-900">{maxJobsPerDay}</span>
                    <button
                      onClick={() => setMaxJobsPerDay(Math.min(10, maxJobsPerDay + 1))}
                      disabled={maxJobsPerDay >= 10}
                      className="w-8 h-8 flex items-center justify-center bg-white rounded-md shadow-sm text-gray-500 disabled:opacity-30 hover:bg-gray-50 dark:bg-surface-chip dark:text-ink-primary dark:border dark:border-edge-default"
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
                            : 'bg-white text-gray-400 border border-gray-200 dark:bg-surface-chip'
                        }`}
                        style={workingDays[i] ? { backgroundColor: DAY_COLORS[i] } : undefined}
                      >
                        {day[0]}
                      </button>
                    ))}
                  </div>
                </div>

              </div>

              {/* Client Selection */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Clients ({selectedIds.size}/{geocodedClients.length})
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json"
                      onChange={handleImportJSON}
                      className="hidden"
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={importing}
                      className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 flex items-center gap-1"
                    >
                      {importing ? (
                        <>
                          <div className="w-3 h-3 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
                          Importing…
                        </>
                      ) : (
                        <>
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                          </svg>
                          Import JSON
                        </>
                      )}
                    </button>
                    {geocodedClients.length > 0 && (
                      <button onClick={toggleAll} className="text-xs font-medium text-purple-600 hover:text-purple-800">
                        {allSelected ? 'Deselect All' : 'Select All'}
                      </button>
                    )}
                  </div>
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
                  <div className="mt-3">
                    <div className="flex items-center gap-2 mb-2">
                      <label className="text-xs font-semibold text-amber-700 uppercase tracking-wider">
                        Address not verified ({noAddressClients.length})
                      </label>
                      <p className="text-[10px] text-amber-700/70">— add an address to include them</p>
                    </div>
                    <div className="bg-amber-50/60 border border-amber-200 rounded-lg divide-y divide-amber-200/60 max-h-[200px] overflow-y-auto dark:bg-amber-500/10 dark:border-amber-400/30 dark:divide-amber-400/20">
                      {noAddressClients.map(client => (
                        <div key={client.id} className="px-3 py-2.5 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <svg className="w-3.5 h-3.5 text-amber-500 dark:text-amber-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25s-7.5-4.108-7.5-11.25a7.5 7.5 0 1115 0z" />
                            </svg>
                            <p className="text-sm font-medium text-gray-800 truncate">{client.name}</p>
                          </div>
                          <AddressAutocomplete
                            value=""
                            onChange={() => {}}
                            onSelect={async r => {
                              await store.updateClient(client.id, client.name, r.address, { lat: r.lat, lng: r.lng })
                              // Auto-select the newly-addressed client so they flow into the builder.
                              setSelectedIds(prev => new Set(prev).add(client.id))
                            }}
                            placeholder="Add address…"
                            className="w-full px-2.5 py-1.5 text-xs border border-amber-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400/30 bg-white dark:bg-surface-chip dark:border-amber-400/30 dark:text-ink-primary"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ═══ SECTION 2: Recurrence & Duration ═══ */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="text-sm font-bold text-gray-900">Recurrence & Duration</h2>
            </div>
            <div className="p-5 space-y-4">
              {/* Set All card */}
              <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 dark:bg-surface-page">
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
                          setAllRec === opt.value ? 'text-white' : 'border border-gray-200 text-gray-500 bg-white dark:bg-surface-chip'
                        }`}
                        style={setAllRec === opt.value ? { backgroundColor: opt.color } : undefined}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Duration */}
                <div className="mb-3">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Duration</p>
                  <select
                    value={setAllDur}
                    onChange={e => setSetAllDur(parseInt(e.target.value))}
                    className="text-sm font-medium border border-gray-200 rounded-lg px-3 py-2 bg-white dark:bg-surface-chip dark:text-ink-primary"
                  >
                    {DURATION_OPTIONS.map(d => (
                      <option key={d} value={d}>{formatDuration(d)}</option>
                    ))}
                  </select>
                </div>

                {/* Default Price */}
                <div>
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Default Price</p>
                  <div className="relative w-36">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">{currencyInfo.symbol}</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="5"
                      placeholder="0"
                      value={setAllPrice}
                      onChange={e => setSetAllPrice(e.target.value)}
                      className="w-full pl-6 pr-3 py-2 text-sm font-medium border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-purple-600/20 dark:bg-surface-chip dark:text-ink-primary"
                    />
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1">Apply to All sets this price on every upcoming job for the selected clients. Use 0 to clear prices. Past completed jobs are left alone.</p>
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
                    const price = store.getClientPrice(client.id)
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
                          <span
                            className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                            style={{
                              color: freqOpt.color,
                              backgroundColor: isDark ? `${freqOpt.color}29` : freqOpt.bg,
                            }}
                          >
                            {freqOpt.label}
                          </span>
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                            {formatDuration(dur)}
                          </span>
                          {price > 0 && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600">
                              {currencyInfo.symbol}{price % 1 === 0 ? price : price.toFixed(2)}
                            </span>
                          )}
                          {client.blockedDays && client.blockedDays.length > 0 && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-500 border border-red-200 dark:border-red-400/30">
                              {client.blockedDays.length === 1
                                ? `No ${DAYS[client.blockedDays[0]]}`
                                : `${client.blockedDays.length} blocked`}
                            </span>
                          )}
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
                                    onClick={() => {
                                      setRecurrenceMap(prev => { const n = new Map(prev); n.set(client.id, opt.value); return n })
                                    }}
                                    className={`flex-1 py-1.5 text-[10px] font-semibold rounded-md transition-colors ${
                                      rec === opt.value ? 'text-white' : 'border border-gray-200 text-gray-500 bg-white dark:bg-surface-chip'
                                    }`}
                                    style={rec === opt.value ? { backgroundColor: opt.color } : undefined}
                                  >
                                    {opt.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className="flex gap-3 flex-wrap">
                              <div>
                                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Duration</p>
                                <select
                                  value={dur}
                                  onChange={e => {
                                    const val = parseInt(e.target.value)
                                    setDurationMap(prev => { const n = new Map(prev); n.set(client.id, val); return n })
                                    store.updateClientScheduleMeta(client.id, { duration: val })
                                  }}
                                  className="text-xs font-medium border border-gray-200 rounded-md px-2.5 py-1.5 bg-white dark:bg-surface-chip dark:text-ink-primary"
                                >
                                  {DURATION_OPTIONS.map(d => (
                                    <option key={d} value={d}>{formatDuration(d)}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Price</p>
                                <div className="relative w-28">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">{currencyInfo.symbol}</span>
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    min={0}
                                    step="5"
                                    placeholder="0"
                                    defaultValue={price > 0 ? String(price) : ''}
                                    onBlur={e => {
                                      const raw = e.target.value.trim()
                                      const next = raw ? Math.max(0, Number(raw) || 0) : 0
                                      if (next !== price) void store.bulkUpdateClientPrice([client.id], next)
                                    }}
                                    className="w-full pl-5 pr-2 py-1.5 text-xs font-medium border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-purple-600/30 bg-white dark:bg-surface-chip dark:text-ink-primary"
                                  />
                                </div>
                              </div>
                            </div>
                            <div>
                              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Blocked Days</p>
                              <div className="flex gap-1">
                                {DAYS.map((day, i) => {
                                  const isBlocked = client.blockedDays?.includes(i as 0|1|2|3|4|5|6)
                                  return (
                                    <button
                                      key={i}
                                      onClick={() => {
                                        const current = client.blockedDays ?? []
                                        const dayVal = i as 0|1|2|3|4|5|6
                                        const next = isBlocked
                                          ? current.filter(d => d !== dayVal)
                                          : [...current, dayVal]
                                        store.updateClientBlockedDays(client.id, next)
                                      }}
                                      className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border transition-colors ${
                                        isBlocked
                                          ? 'bg-red-100 text-red-600 border-red-300 dark:border-red-400/30'
                                          : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300 dark:bg-surface-chip'
                                      }`}
                                    >
                                      {day}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sticky bottom bar */}
      <div className="px-5 py-4 border-t border-gray-200 bg-white shrink-0 flex justify-center">
        <button
          onClick={enterManualMode}
          disabled={!canBuild}
          className="px-6 py-2.5 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          Open Builder
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
        </button>
      </div>
    </div>
  )
}

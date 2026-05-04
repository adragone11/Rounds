import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import type { Client, Placement, DayOfWeek, SchedulePlan, PlanClient } from './types'
import { useAuth } from './lib/auth'
import { useProfile } from './lib/profile'
import { computeSmartPlacement } from './optimizer'
import { DAY_COLORS as DEFAULT_DAY_COLORS, DEFAULT_AVATAR_COLOR } from './theme'
import { jobsForMonth, type Job } from './lib/jobs'
import { toMobileTime } from './lib/time'
import { createSupabaseAdapter } from './lib/supabaseAdapter'
import type { DataAdapter } from './lib/dataAdapter'

// ── Customizable weekday palette ──
// Persists in localStorage; defaults to the built-in theme. Every consumer that
// paints a weekday should pull from store.dayColors instead of importing the
// static theme constant, so a user edit propagates everywhere.
const DAY_COLORS_KEY = 'pip-day-colors'

// ── Smart Placement config ──
export type SmartConfig = {
  enabled: boolean       // master on/off — when false, no suggestions are returned
  maxJobsPerDay: number
  workingDays: boolean[] // length 7, Sun..Sat
  workingStart: string   // "HH:MM" — earliest start time of the day
  workingEnd: string     // "HH:MM" — latest end time of the day
}
const SMART_CONFIG_KEY = 'pip-smart-placement-config'
const DEFAULT_SMART_CONFIG: SmartConfig = {
  enabled: true,
  maxJobsPerDay: 5,
  workingDays: [false, true, true, true, true, true, false],
  workingStart: '08:00',
  workingEnd: '17:00',
}

/** Minutes between two "HH:MM" strings. 0 on malformed input. */
function timeWindowMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  if ([sh, sm, eh, em].some(n => Number.isNaN(n))) return 0
  return Math.max(0, (eh * 60 + em) - (sh * 60 + sm))
}

export type BestDay = {
  day: number
  dayName: string
  rank: number                   // 1, 2, 3
  score: number
  reason: string
  breakdown: string              // tooltip-ready score explanation
  firstDate: string | null       // "YYYY-MM-DD" — first fit within 12 weeks
  nearbyCount: number
  nearestNeighborMin: number
  clusterFit: number
  capacityPressure: number
  full: boolean                  // true if steady-state passed but no date fits in 12 weeks
}

const PLACEMENT_HORIZON_WEEKS = 12
const DEFAULT_VISIT_MIN = 60

// Pip's zone colors — same as the mobile app
const ZONE_COLORS = [
  '#3B82F6', '#EF4444', '#F97316', '#8B5CF6', '#10B981',
  '#EC4899', '#06B6D4', '#EAB308', '#14B8A6', '#64748B',
]

/**
 * Schedule metadata — stored separately from client objects so it survives
 * Supabase refresh. Keyed by client ID.
 */
interface ScheduleMeta {
  frequency: Client['frequency']
  intervalWeeks?: number    // only for frequency === 'custom'
  duration?: number         // visit duration in minutes (default 60)
  price?: number            // dollar price per visit, applied to all instances of the recurring series
  startDate: string | null  // recurrence anchor "YYYY-MM-DD"
  endDate?: string | null   // recurrence cutoff; virtual occurrences after this are hidden
  exceptions: string[]      // dates removed from recurring pattern
  blockedDays: DayOfWeek[]  // days the client cannot be scheduled
}

interface HomeAddress {
  address: string
  lat: number
  lng: number
}

interface Store {
  clients: Client[]
  placements: Placement[]
  loading: boolean
  homeAddress: HomeAddress | null
  setHomeAddress: (address: string, coords?: { lat: number; lng: number }) => Promise<void>
  clearHomeAddress: () => void
  addClient: (name: string, address: string, coords?: { lat: number; lng: number } | null, phone?: string) => Promise<string | null>
  removeClient: (id: string) => void
  updateClient: (id: string, name: string, address: string, coords?: { lat: number; lng: number } | null) => void
  updateClientCoords: (id: string, lat: number, lng: number) => void
  updateClientColor: (id: string, color: string) => Promise<void>
  updateClientBlockedDays: (id: string, blockedDays: DayOfWeek[]) => void
  updateClientScheduleMeta: (id: string, updates: { frequency?: Client['frequency']; intervalWeeks?: number; duration?: number; price?: number }) => void
  getClientDuration: (id: string) => number
  /** Default price for a client's recurring series — seeds jobs.price when a new
   *  template is inserted, and is the value the Schedule Builder shows/edits. */
  getClientPrice: (id: string) => number
  /** Mass-set price: stores the per-recurrence default in scheduleMeta AND rewrites
   *  price on all forward-looking jobs (templates + non-completed materialized
   *  instances) for those clients. Past completed jobs are frozen. */
  bulkUpdateClientPrice: (clientIds: string[], price: number) => Promise<void>
  /** Edit a single job with explicit scope. `scope='this'` updates only this row;
   *  `scope='all'` updates the recurring template AND soft-deletes future overrides
   *  so virtuals inherit — mirrors mobile's EditJobScreen editScope behavior. */
  updateJobWithScope: (job: Job, patch: Record<string, unknown>, scope: 'this' | 'all') => Promise<void>
  placeClient: (clientId: string, date: string) => void
  placeClientRecurring: (clientId: string, startDate: string, frequency: Client['frequency'], intervalWeeks?: number) => void
  unplaceClient: (clientId: string, date: string) => void
  unplaceClientFuture: (clientId: string, fromDate: string, year: number, month: number) => void
  unplaceClientAll: (clientId: string, year: number, month: number) => void
  /** Wipe every placement for a client across ALL months and clear recurrence
   *  meta so no virtuals regenerate. Pair with syncDeleteClientJobs for the
   *  "delete every instance ever" scope. */
  unplaceClientEverything: (clientId: string) => void
  /** Wipe ALL web-only schedule state — placements, recurrence meta, the
   *  active schedule plan, and the apply-undo snapshot. Used after a
   *  Supabase-side "delete all jobs" so calendar chips don't keep rendering
   *  recurrences whose backing jobs no longer exist. */
  clearLocalScheduleState: () => void
  getClientsForDate: (date: string) => Client[]
  getUnplacedClients: (year: number, month: number) => Client[]
  getAllDatesForClient: (clientId: string, year: number, month: number) => string[]
  getBestDays: (clientId: string) => BestDay[]
  smartConfig: SmartConfig
  setSmartConfig: (cfg: SmartConfig) => void
  dayColors: string[]                              // length 7, Sun..Sat
  setDayColor: (dayIndex: number, hex: string) => void
  resetDayColors: () => void
  bulkReassignDays: (assignments: Map<string, number>, recurrenceOverrides?: Map<string, Client['frequency']>, rotations?: Map<string, number>, startDate?: Date) => void
  /** Cut over to a new schedule: freeze pre-cutover dates as one-offs and
   *  clear everyone's recurrence. DOES NOT apply the new assignments — those
   *  live as proposals inside the Transition sidebar, and only get placed
   *  when each client is confirmed there (via reanchorClient). This gives the
   *  cleaner a one-tap-per-client commit flow for the new schedule. */
  applyNewScheduleFromBuilder: (
    assignments: Map<string, number>,
    recurrenceOverrides: Map<string, Client['frequency']>,
    rotations: Map<string, number>,
    intervalWeeksMap: Map<string, number>,
    cutoverDate: Date,
  ) => string
  /** Undo the most recent applyNewScheduleFromBuilder by restoring the snapshot
   *  taken just before it ran. Clears the snapshot after use. Returns false if
   *  no snapshot exists. */
  undoLastApply: () => boolean
  /** ISO timestamp of the last apply that can be undone, or null. */
  lastApplySnapshotAt: string | null
  /** Unique ID stamped on the most recent Apply. Used by Transition to key
   *  persisted state — fresh apply = new ID = old Transition state cleared. */
  lastApplyId: string | null
  /** Re-anchor an already-placed client to a new startDate (and optionally a new
   *  frequency). Unlike placeClientRecurring, this PRESERVES manual placements
   *  dated before newStartDate — critical for keeping frozen pre-cutover jobs
   *  intact during Transition confirms/swaps. */
  reanchorClient: (clientId: string, newStartDate: string, frequency?: Client['frequency'], intervalWeeks?: number) => void
  /** Un-place a client: clear recurrence and drop future placements (keeps
   *  frozen past). Used when reverting a Transition confirmation. */
  unconfirmClient: (clientId: string) => void
  refreshClients: () => Promise<void>
  /** Jobs read from Supabase (shared with mobile). Read-only for now — web
   *  renders these alongside placements so users can see mobile-created jobs. */
  jobs: Job[]
  refreshJobs: () => Promise<void>
  /** Jobs that land on a specific ISO date, with recurring templates expanded.
   *  Caller should combine with the current-view year/month for correct expansion. */
  getJobsForDate: (date: string, year: number, month: number) => Job[]
  /** Write a new job row to Supabase mirroring a web placement. Recurring
   *  frequencies create a template; one-time creates a single non-recurring row.
   *  If the client already has a live template/one-off, updates it in place
   *  instead of inserting a duplicate. Returns the job id or null on failure. */
  createJobFromPlacement: (clientId: string, date: string, frequency: Client['frequency']) => Promise<string | null>
  /** Mark a client's template (and one-offs) deleted in Supabase. Used when
   *  unplacing all. */
  syncDeleteClientJobs: (clientId: string) => Promise<void>
  /** Skip a single recurring occurrence on Supabase (cancelled instance row),
   *  or soft-delete a one-off job on that date. Mirrors the 'just this' remove. */
  syncCancelOccurrence: (clientId: string, date: string) => Promise<void>
  /** Stop the recurrence at the day before `fromDate` by setting
   *  template.recurring_end_date. Mirrors the 'this and future' remove. */
  syncEndRecurrence: (clientId: string, fromDate: string) => Promise<void>
  /** Move a single recurring occurrence from sourceDate → targetDate via
   *  an instance row that masks the virtual occurrence. Template untouched. */
  syncMoveOccurrence: (clientId: string, sourceDate: string, targetDate: string) => Promise<void>
  /** Reanchor a recurring client's template to newAnchor: end-dates existing
   *  templates at fromDate-1, soft-deletes any non-template future instances
   *  (overrides), and inserts a fresh template. Mirrors 'this and future' move. */
  syncReanchor: (clientId: string, fromDate: string, newAnchor: string, frequency: Client['frequency']) => Promise<void>
  /** Cancel every occurrence for this client in the given calendar month
   *  on Supabase (via cancelled instance rows for virtual occurrences and
   *  soft-delete for existing one-offs). Template untouched. */
  syncCancelMonth: (clientId: string, year: number, month: number) => Promise<void>
  /** Create a title-only task job (no client). Returns new job id or null. */
  createTaskJob: (opts: { title: string; date: string; startTime?: string | null; duration?: number; notes?: string | null; price?: number }) => Promise<string | null>
  /** Create a generic job with optional client + recurrence + custom time.
   *  Used by the Add Job sheet. Mirrors mobile's "Add Job" flow. */
  createJob: (opts: {
    title?: string | null
    clientId?: string | null
    date: string
    startTime?: string | null   // 'HH:mm'
    duration?: number           // hours
    price?: number
    recurring?: 'one-time' | 'weekly' | 'bi-weekly' | 'monthly' | 'custom'
    intervalWeeks?: number
    notes?: string | null
    checklist?: { text: string; done: boolean }[] | null
  }) => Promise<string | null>
  /** Patch an existing job row and refresh local state. */
  updateJob: (id: string, patch: Record<string, unknown>) => Promise<void>
  /** "This & future" edit: patch the template row and wipe any instance
   *  overrides on/after fromDate so the template's new values render. */
  updateRecurrenceFromDate: (templateId: string, fromDate: string, patch: Record<string, unknown>) => Promise<void>
  /** Change a recurring client's cadence from fromDate onward. Ends the old
   *  template before fromDate, wipes future overrides, and inserts a fresh
   *  template anchored at fromDate using the new frequency. If `preserve` is
   *  provided, its fields (start_time, end_time, duration, price, title,
   *  notes) are copied onto the new template so the cadence change doesn't
   *  silently reset them. */
  changeRecurrenceFrequency: (
    clientId: string,
    fromDate: string,
    newFrequency: Client['frequency'],
    preserve?: Record<string, unknown>,
  ) => Promise<void>
  /** Soft-delete a job (sets deleted=true). */
  deleteJob: (id: string) => Promise<void>
  /** Materialize a virtual template occurrence into a real instance so the
   *  action panel can mutate it. Returns the stored job id or null. */
  materializeVirtualOccurrence: (virtual: Job) => Promise<string | null>
  /** Most recent sync failure, or null. Surface via toast. */
  jobSyncError: string | null
  clearJobSyncError: () => void
  /** The active sandboxed schedule plan, or null if none. */
  schedulePlan: SchedulePlan | null
  /** Build a plan from Builder output and activate it — no live-schedule writes. Returns the new plan id. */
  createSchedulePlan: (
    assignments: Map<string, number>,
    rotations: Map<string, number>,
    recurrence: Map<string, Client['frequency']>,
    intervalWeeks: Map<string, number>,
  ) => string
  /** Discard the active plan (clears localStorage). */
  discardSchedulePlan: () => void
  /** Update the active plan via an updater fn. No-ops if plan is null. */
  updateSchedulePlan: (updater: (plan: SchedulePlan) => SchedulePlan) => void
  /** Atomically commit the active plan to the live schedule at `cutoverDate`.
   *  Returns false if no active plan or any plan client is not yet confirmed. */
  commitSchedulePlan: (cutoverDate: Date) => Promise<boolean>
}

const StoreContext = createContext<Store | null>(null)

// ── Pure helper: build a SchedulePlan from Builder output ──────────────────────
// No side effects, no localStorage, no React state.
// Used by createSchedulePlan (Task 3) and testable in isolation.
export function buildSchedulePlan(
  clients: Client[],
  assignments: Map<string, number>,
  rotations: Map<string, number>,
  recurrence: Map<string, Client['frequency']>,
  intervalWeeks: Map<string, number>,
): SchedulePlan {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `plan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  const planClients: PlanClient[] = []
  for (const [clientId, day] of assignments) {
    if (day < 0) continue
    planClients.push({
      clientId,
      plannedDay: day,
      originalPlannedDay: day,
      plannedRotation: (rotations.get(clientId) ?? 0) as 0 | 1,
      status: 'pending',
      swapPartnerClientId: null,
    })
  }

  return {
    id,
    createdAt: new Date().toISOString(),
    status: 'active',
    builderAssignments: Array.from(assignments.entries()),
    builderRotations: Array.from(rotations.entries()),
    builderRecurrence: Array.from(recurrence.entries()),
    builderIntervalWeeks: Array.from(intervalWeeks.entries()),
    rosterSnapshot: clients.map(c => c.id),
    clients: planClients,
  }
}

// ── SchedulePlan persistence ───────────────────────────────────────────────────
const SCHEDULE_PLAN_KEY = 'pip-schedule-plan'

function loadSchedulePlan(): SchedulePlan | null {
  try {
    const raw = localStorage.getItem(SCHEDULE_PLAN_KEY)
    if (!raw) return null
    const plan = JSON.parse(raw) as SchedulePlan
    if (plan.status !== 'active') return null
    return plan
  } catch {
    return null
  }
}

function saveSchedulePlan(plan: SchedulePlan | null) {
  try {
    if (plan === null) {
      localStorage.removeItem(SCHEDULE_PLAN_KEY)
    } else {
      localStorage.setItem(SCHEDULE_PLAN_KEY, JSON.stringify(plan))
    }
  } catch { /* storage full — plan not persisted */ }
}

// ── One-time legacy storage migration ─────────────────────────────────────────
// Cleans up stale pip-transition* keys left over from before the sandboxed
// SchedulePlan architecture. Runs once per session (sessionStorage gate).
if (typeof window !== 'undefined' && !sessionStorage.getItem('pip-plan-migration-v1')) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key) continue
      if (
        key.startsWith('pip-transition-state-') ||
        key === 'pip-transition-context' ||
        key === 'pip-transition-apply-id' ||
        key === 'pip-transition' ||
        key === 'pip-transition-template'
      ) {
        localStorage.removeItem(key)
      }
    }
    sessionStorage.setItem('pip-plan-migration-v1', '1')
  } catch { /* ignore */ }
}

function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  if (!address.trim()) return null
  try {
    const resp = await fetch(`/api/geocode?q=${encodeURIComponent(address)}`)
    if (!resp.ok) return null
    const data = await resp.json()
    if (data.lat != null && data.lng != null) return { lat: data.lat, lng: data.lng }
  } catch { /* silent */ }
  return null
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Compute all recurring dates for a client in a given month */
function getRecurringDates(meta: ScheduleMeta, year: number, month: number): string[] {
  if (!meta.startDate || meta.frequency === 'one-time') return []

  const anchor = new Date(meta.startDate + 'T00:00:00')
  const dates: string[] = []

  if (meta.frequency === 'custom') {
    const interval = (meta.intervalWeeks ?? 4) * 7
    const monthStart = new Date(year, month, 1)
    const monthEnd = new Date(year, month + 1, 0)
    const anchorTime = anchor.getTime()
    const startTime = monthStart.getTime()
    const diffDays = Math.floor((startTime - anchorTime) / 86400000)

    let offset: number
    if (diffDays <= 0) { offset = 0 }
    else { offset = Math.ceil(diffDays / interval) * interval }

    const cursor = new Date(anchor)
    cursor.setDate(cursor.getDate() + offset)

    while (cursor <= monthEnd) {
      if (cursor >= monthStart && cursor >= anchor) dates.push(fmt(cursor))
      cursor.setDate(cursor.getDate() + interval)
    }
  } else if (meta.frequency === 'monthly') {
    // "Monthly" = every 4 weeks (28 days) from anchor, NOT same date each calendar month.
    // Keeps the weekday locked — a Tuesday monthly stays Tuesday.
    const interval = 28
    const monthStart = new Date(year, month, 1)
    const monthEnd = new Date(year, month + 1, 0)
    const anchorTime = anchor.getTime()
    const startTime = monthStart.getTime()
    const diffDays = Math.floor((startTime - anchorTime) / 86400000)

    let offset: number
    if (diffDays <= 0) { offset = 0 }
    else { offset = Math.ceil(diffDays / interval) * interval }

    const cursor = new Date(anchor)
    cursor.setDate(cursor.getDate() + offset)

    while (cursor <= monthEnd) {
      if (cursor >= monthStart && cursor >= anchor) dates.push(fmt(cursor))
      cursor.setDate(cursor.getDate() + interval)
    }
  } else {
    const interval = meta.frequency === 'weekly' ? 7 : 14
    const monthStart = new Date(year, month, 1)
    const monthEnd = new Date(year, month + 1, 0)
    const anchorTime = anchor.getTime()
    const startTime = monthStart.getTime()
    const diffDays = Math.floor((startTime - anchorTime) / 86400000)

    let offset: number
    if (diffDays <= 0) { offset = 0 }
    else { offset = Math.ceil(diffDays / interval) * interval }

    const cursor = new Date(anchor)
    cursor.setDate(cursor.getDate() + offset)

    while (cursor <= monthEnd) {
      if (cursor >= monthStart && cursor >= anchor) dates.push(fmt(cursor))
      cursor.setDate(cursor.getDate() + interval)
    }
  }

  const exSet = new Set(meta.exceptions)
  const cutoff = meta.endDate ?? null
  return dates.filter(d => !exSet.has(d) && (!cutoff || d <= cutoff))
}

// ── Schedule metadata persistence ──
// Stored in localStorage, keyed by client ID. Survives Supabase refresh.

const SCHEDULE_META_KEY = 'pip-schedule-meta'

function loadScheduleMeta(): Record<string, ScheduleMeta> {
  return loadLocal(SCHEDULE_META_KEY, {})
}

function saveScheduleMeta(meta: Record<string, ScheduleMeta>) {
  localStorage.setItem(SCHEDULE_META_KEY, JSON.stringify(meta))
}

function getClientMeta(allMeta: Record<string, ScheduleMeta>, clientId: string): ScheduleMeta {
  return allMeta[clientId] ?? { frequency: 'weekly', startDate: null, exceptions: [], blockedDays: [], intervalWeeks: undefined }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const { profile } = useProfile()
  // Single seam through which all client/job CRUD will flow. Currently always
  // Supabase-backed; the next commit will swap in a localStorage adapter when
  // profile.isPlus is false.
  const adapter = useMemo<DataAdapter | null>(
    () => (user ? createSupabaseAdapter(user.id) : null),
    [user],
  )
  const [clients, setClients] = useState<Client[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [placements, setPlacements] = useState<Placement[]>(() => loadLocal('pip-placements', []))
  const [scheduleMeta, setScheduleMeta] = useState<Record<string, ScheduleMeta>>(loadScheduleMeta)
  const [homeAddress, setHomeAddressState] = useState<HomeAddress | null>(() => loadLocal('pip-home-address', null))
  const [smartConfig, setSmartConfigState] = useState<SmartConfig>(() => {
    const loaded = loadLocal<Partial<SmartConfig>>(SMART_CONFIG_KEY, {})
    // Tolerates the pre-start/end schema by falling back to defaults per-field.
    return {
      enabled: loaded.enabled ?? DEFAULT_SMART_CONFIG.enabled,
      maxJobsPerDay: loaded.maxJobsPerDay ?? DEFAULT_SMART_CONFIG.maxJobsPerDay,
      workingDays: loaded.workingDays ?? DEFAULT_SMART_CONFIG.workingDays,
      workingStart: loaded.workingStart ?? DEFAULT_SMART_CONFIG.workingStart,
      workingEnd: loaded.workingEnd ?? DEFAULT_SMART_CONFIG.workingEnd,
    }
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => localStorage.setItem(SMART_CONFIG_KEY, JSON.stringify(smartConfig)), [smartConfig])
  const setSmartConfig = useCallback((cfg: SmartConfig) => setSmartConfigState(cfg), [])

  // Custom weekday palette — persist any overrides.
  const [dayColors, setDayColorsState] = useState<string[]>(() => {
    const loaded = loadLocal<string[] | null>(DAY_COLORS_KEY, null)
    if (!loaded || !Array.isArray(loaded) || loaded.length !== 7) return [...DEFAULT_DAY_COLORS]
    // Preserve default slots for any invalid entries so a stray edit can't brick the UI.
    return loaded.map((c, i) => (typeof c === 'string' && /^#([0-9A-Fa-f]{6})$/.test(c) ? c : DEFAULT_DAY_COLORS[i]))
  })
  useEffect(() => localStorage.setItem(DAY_COLORS_KEY, JSON.stringify(dayColors)), [dayColors])
  const setDayColor = useCallback((dayIndex: number, hex: string) => {
    setDayColorsState(prev => {
      if (dayIndex < 0 || dayIndex > 6) return prev
      const next = [...prev]
      next[dayIndex] = hex
      return next
    })
  }, [])
  const resetDayColors = useCallback(() => setDayColorsState([...DEFAULT_DAY_COLORS]), [])

  // Persist placements
  useEffect(() => localStorage.setItem('pip-placements', JSON.stringify(placements)), [placements])

  // Persist schedule metadata
  useEffect(() => saveScheduleMeta(scheduleMeta), [scheduleMeta])

  // Persist home address
  useEffect(() => {
    if (homeAddress) localStorage.setItem('pip-home-address', JSON.stringify(homeAddress))
    else localStorage.removeItem('pip-home-address')
  }, [homeAddress])

  const setHomeAddress = async (address: string, coords?: { lat: number; lng: number }) => {
    const resolved = coords ?? await geocode(address)
    if (resolved) {
      setHomeAddressState({ address, lat: resolved.lat, lng: resolved.lng })
    }
  }

  const clearHomeAddress = () => setHomeAddressState(null)

  // Fetch clients through the active adapter. Schedule meta is layered on
  // top from localStorage — the adapter only knows the persisted columns.
  const refreshClients = useCallback(async () => {
    if (!adapter) { setClients([]); setLoading(false); return }

    setLoading(true)
    try {
      const loaded = await adapter.loadClients()
      const meta = loadScheduleMeta()
      const mapped = loaded.map(client => {
        const m = meta[client.id]
        if (m) {
          client.frequency = m.frequency
          client.intervalWeeks = m.intervalWeeks
          client.startDate = m.startDate
          client.exceptions = m.exceptions
          // blockedDays is authoritative from the row — don't let stale
          // localStorage meta override what the adapter read.
        }
        return client
      })
      setClients(mapped)
      localStorage.setItem('pip-clients-cache', JSON.stringify(mapped))
    } catch (err) {
      console.error('Failed to fetch clients:', err)
      setClients(loadLocal('pip-clients-cache', []))
    } finally {
      setLoading(false)
    }
  }, [adapter])

  useEffect(() => { refreshClients() }, [refreshClients])

  // Realtime: pick up mobile-side client edits (rate, address, color, name).
  // Cheaper to refetch than to map every column transform — the row count is
  // small and the adapter scopes the subscription to this user.
  useEffect(() => {
    if (!adapter) return
    return adapter.subscribeClients(() => { refreshClients() })
  }, [adapter, refreshClients])

  // ── Jobs (read-only from mobile's Supabase schema) ─────────────────────────
  // Signed-in users see everything they own; templates expand into virtual
  // occurrences on render.
  const refreshJobs = useCallback(async () => {
    if (!adapter) { setJobs([]); return }
    console.time('[perf] refreshJobs:fetch')
    let mapped: Job[]
    try {
      mapped = await adapter.loadJobs()
    } catch (err) {
      console.timeEnd('[perf] refreshJobs:fetch')
      console.error('Failed to fetch jobs:', err)
      return
    }
    console.timeEnd('[perf] refreshJobs:fetch')
    console.log('[perf] jobs row count:', mapped.length)
    setJobs(mapped)
  }, [adapter])

  useEffect(() => { refreshJobs() }, [refreshJobs])

  // Realtime: mobile-side mutations (complete, cancel, materialize, edit)
  // flow back to web without a manual refresh. We patch the local jobs
  // array per-event so the calendar doesn't flicker. The adapter normalizes
  // payloads into insert/update/delete with already-mapped Job shapes.
  useEffect(() => {
    if (!adapter) return
    return adapter.subscribeJobs(change => {
      if (change.type === 'insert') {
        const next = change.job
        setJobs(prev => prev.some(j => j.id === next.id) ? prev : [...prev, next])
        return
      }
      if (change.type === 'update') {
        const next = change.job
        setJobs(prev => {
          const idx = prev.findIndex(j => j.id === next.id)
          if (idx === -1) return [...prev, next]
          const copy = prev.slice()
          copy[idx] = next
          return copy
        })
        return
      }
      if (change.type === 'delete') {
        const id = change.id
        setJobs(prev => prev.filter(j => j.id !== id))
      }
    })
  }, [adapter])

  // Month-scoped lazy expansion. The cache lives in a closure rebuilt only when
  // `jobs` changes — no setState during render, so calendar cells calling this
  // can't trigger render loops. First call per (year,month) computes; rest hit
  // the closure Map.
  const getJobsForDate = useMemo(() => {
    const cache = new Map<string, Record<string, Job[]>>()
    return (date: string, year: number, month: number): Job[] => {
      const key = `${year}-${month}`
      let expanded = cache.get(key)
      if (!expanded) {
        console.time(`[perf] jobsForMonth ${key}`)
        expanded = jobsForMonth(jobs, year, month)
        console.timeEnd(`[perf] jobsForMonth ${key}`)
        cache.set(key, expanded)
      }
      return expanded[date] ?? []
    }
  }, [jobs])

  // Map web frequency → mobile recurring string.
  const freqToRecurring = (f: Client['frequency']): string => {
    if (f === 'weekly') return 'weekly'
    if (f === 'biweekly') return 'bi-weekly'
    if (f === 'monthly') return 'monthly'
    if (f === 'custom') return 'custom'
    return 'one-time'
  }

  const [jobSyncError, setJobSyncError] = useState<string | null>(null)
  const clearJobSyncError = useCallback(() => setJobSyncError(null), [])

  const createJobFromPlacement = async (
    clientId: string,
    date: string,
    frequency: Client['frequency'],
  ): Promise<string | null> => {
    if (!adapter) return null
    const client = clients.find(c => c.id === clientId)
    if (!client) return null
    const recurring = freqToRecurring(frequency)
    const isRecurring = recurring !== 'one-time'
    const durationMin = scheduleMeta[clientId]?.duration ?? 60
    const durationHours = durationMin / 60

    // If the client already has a live job that represents the same intent
    // (template for recurring, one-off for one-time), update it instead of
    // inserting a duplicate. Keeps us aligned with mobile's single-template
    // model and lets "move between days" re-anchor cleanly.
    const existing = jobs.find(j =>
      j.clientId === clientId &&
      !j.deleted &&
      (isRecurring ? j.isTemplate : (!j.isTemplate && j.recurring === 'one-time')) &&
      // Skip templates that have been end-dated — those are "wrapped up"
      // recurrences. A new anchor should start a fresh template, not
      // resurrect the old one.
      !(j.isTemplate && j.recurringEndDate)
    )

    if (existing) {
      const patch: Record<string, unknown> = {
        date,
        duration: durationHours,
        recurring,
        is_recurring: isRecurring,
        is_template: isRecurring,
        recurrence_anchor_date: isRecurring ? date : null,
        recurrence_interval: frequency === 'custom' ? (client.intervalWeeks ?? 4) : null,
        recurrence_unit: frequency === 'custom' ? 'weeks' : null,
        recurring_end_date: null, // clearing any prior "end future" cutoff
        deleted: false,
      }
      try {
        const updated = await adapter.updateJob(existing.id, patch)
        setJobs(prev => prev.map(j => j.id === updated.id ? updated : j))
        return updated.id
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setJobSyncError(`Couldn't update job for ${client.name}: ${msg}`)
        return null
      }
    }

    const row: Record<string, unknown> = {
      client_id: clientId,
      title: null,
      date,
      start_time: toMobileTime('09:00'),
      duration: durationHours,
      price: scheduleMeta[clientId]?.price ?? 0,
      recurring,
      is_recurring: isRecurring,
      is_template: isRecurring,                 // templates drive recurrence expansion
      recurrence_anchor_date: isRecurring ? date : null,
      recurrence_interval: frequency === 'custom' ? (client.intervalWeeks ?? 4) : null,
      recurrence_unit: frequency === 'custom' ? 'weeks' : null,
      completed: false,
      cancelled: false,
      deleted: false,
      paid: false,
    }
    try {
      const newJob = await adapter.insertJob(row)
      setJobs(prev => [...prev, newJob])
      return newJob.id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't sync ${client.name} to mobile: ${msg}`)
      return null
    }
  }

  const syncCancelOccurrence = async (clientId: string, date: string): Promise<void> => {
    if (!adapter) return
    const client = clients.find(c => c.id === clientId)
    // If there's a one-off job on that exact date for this client, soft-delete it.
    const oneOff = jobs.find(j =>
      j.clientId === clientId && !j.isTemplate && j.date === date && !j.deleted
    )
    if (oneOff) {
      try {
        await adapter.deleteJob(oneOff.id)
        setJobs(prev => prev.map(j => j.id === oneOff.id ? { ...j, deleted: true } : j))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setJobSyncError(`Couldn't remove occurrence for ${client?.name ?? 'client'}: ${msg}`)
      }
      return
    }
    // Otherwise this is a virtual template occurrence — materialize as a
    // cancelled instance so mobile skips it.
    const template = jobs.find(j =>
      j.clientId === clientId && j.isTemplate && !j.deleted
    )
    if (!template) return
    const row: Record<string, unknown> = {
      client_id: clientId,
      title: null,
      date,
      start_time: toMobileTime(template.startTime ?? '09:00'),
      duration: template.duration,
      price: template.price,
      recurring: 'one-time',
      is_recurring: false,
      is_template: false,
      template_id: template.id,
      original_occurrence_date: date,
      cancelled: true,
      deleted: false,
      completed: false,
      paid: false,
    }
    try {
      const stored = await adapter.insertJob(row)
      setJobs(prev => [...prev, stored])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't skip visit for ${client?.name ?? 'client'}: ${msg}`)
    }
  }

  // ── Generic job helpers (title-only tasks + action panel mutations) ───────
  // These live alongside the sync* helpers but are client-agnostic.

  const createTaskJob = async (opts: {
    title: string
    date: string
    startTime?: string | null
    duration?: number          // hours
    notes?: string | null
    price?: number
  }): Promise<string | null> => {
    if (!adapter) return null
    const row: Record<string, unknown> = {
      client_id: null,
      title: opts.title,
      date: opts.date,
      start_time: toMobileTime(opts.startTime),
      duration: opts.duration ?? 1,
      price: opts.price ?? 0,
      recurring: 'one-time',
      is_recurring: false,
      is_template: false,
      notes: opts.notes ?? null,
      completed: false,
      cancelled: false,
      deleted: false,
      paid: false,
    }
    try {
      const newJob = await adapter.insertJob(row)
      setJobs(prev => [...prev, newJob])
      return newJob.id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't create task: ${msg}`)
      return null
    }
  }

  const createJob = async (opts: {
    title?: string | null
    clientId?: string | null
    date: string
    startTime?: string | null
    duration?: number
    price?: number
    recurring?: 'one-time' | 'weekly' | 'bi-weekly' | 'monthly' | 'custom'
    intervalWeeks?: number
    notes?: string | null
    checklist?: { text: string; done: boolean }[] | null
  }): Promise<string | null> => {
    if (!adapter) return null
    const recurring = opts.recurring ?? 'one-time'
    const isRecurring = recurring !== 'one-time'
    // start_time is NOT NULL on the jobs table — default to 9 AM if unspecified.
    const startTime = opts.startTime ?? '09:00'
    // Empty checklist = NULL on the row, so the column matches the "no list
    // attached" state mobile uses. Drop falsy entries defensively.
    const checklist = opts.checklist && opts.checklist.length > 0
      ? opts.checklist.filter(c => c && c.text.trim())
      : null
    const row: Record<string, unknown> = {
      client_id: opts.clientId ?? null,
      title: opts.title ?? null,
      date: opts.date,
      start_time: toMobileTime(startTime),
      duration: opts.duration ?? 1,
      price: opts.price ?? 0,
      recurring,
      is_recurring: isRecurring,
      is_template: isRecurring,
      recurrence_anchor_date: isRecurring ? opts.date : null,
      recurrence_interval: recurring === 'custom' ? (opts.intervalWeeks ?? 4) : null,
      recurrence_unit: recurring === 'custom' ? 'weeks' : null,
      notes: opts.notes ?? null,
      checklist: checklist && checklist.length > 0 ? checklist : null,
      completed: false,
      cancelled: false,
      deleted: false,
      paid: false,
    }
    try {
      const newJob = await adapter.insertJob(row)
      setJobs(prev => [...prev, newJob])
      return newJob.id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't create job: ${msg}`)
      return null
    }
  }

  // Materialize a virtual template occurrence into a real instance row the
  // action panel can mutate. Returns the stored job's id.
  const materializeVirtualOccurrence = async (virtual: Job): Promise<string | null> => {
    if (!adapter || !virtual.templateId) return null
    // Idempotence: if an instance for this (templateId, occurrence date) already
    // exists, reuse it instead of inserting a duplicate. This was the source of
    // Reports showing the same job twice after repeated complete/uncomplete.
    const occKey = virtual.originalOccurrenceDate ?? virtual.date
    const existing = jobs.find(j =>
      !j.isTemplate &&
      !j.deleted &&
      j.templateId === virtual.templateId &&
      (j.originalOccurrenceDate ?? j.date) === occKey
    )
    if (existing) return existing.id
    const row: Record<string, unknown> = {
      client_id: virtual.clientId,
      title: virtual.title,
      date: virtual.date,
      start_time: toMobileTime(virtual.startTime),
      end_time: toMobileTime(virtual.endTime),
      duration: virtual.duration,
      price: virtual.price,
      recurring: 'one-time',
      is_recurring: false,
      is_template: false,
      template_id: virtual.templateId,
      original_occurrence_date: virtual.originalOccurrenceDate ?? virtual.date,
      avatar_color: virtual.avatarColor,
      avatar_icon: virtual.avatarIcon,
      notes: virtual.notes,
      completed: false,
      cancelled: false,
      deleted: false,
      paid: false,
    }
    try {
      const stored = await adapter.insertJob(row)
      setJobs(prev => [...prev, stored])
      return stored.id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't save occurrence: ${msg}`)
      return null
    }
  }

  // Guard: per-occurrence flags must NEVER land on a template row. A template
  // is the recurrence definition — flipping `completed`/`paid`/`cancelled` on
  // it leaks the flag onto every virtual occurrence (jobsForMonth spreads
  // template fields into virtuals), and quietly hides today's instance from
  // every screen filtered by `!isTemplate`. Any caller writing these flags
  // must materialize first (see updateJobWithScope or JobActionPanel.mutate).
  const PER_OCCURRENCE_KEYS = ['completed', 'paid', 'cancelled', 'deleted'] as const
  const updateJob = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    if (!adapter) return
    const target = jobs.find(j => j.id === id)
    if (target?.isTemplate) {
      const leaked = Object.keys(patch).filter(k => (PER_OCCURRENCE_KEYS as readonly string[]).includes(k))
      if (leaked.length) {
        const msg = `[store.updateJob] per-occurrence patch on template row id=${id} keys=${leaked.join(',')}`
        console.error(msg, { patch })
        if (import.meta.env.DEV) throw new Error(msg)
        return
      }
    }
    try {
      const updated = await adapter.updateJob(id, patch)
      setJobs(prev => prev.map(j => j.id === updated.id ? updated : j))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't update job: ${msg}`)
    }
  }

  const updateRecurrenceFromDate = async (
    templateId: string,
    fromDate: string,
    patch: Record<string, unknown>,
  ): Promise<void> => {
    if (!adapter) return
    // Symmetric guard with store.updateJob: per-occurrence flags belong on
    // instance rows, never on the template. Writing them here would poison
    // every future virtual (jobsForMonth spreads template fields into them).
    // Recurrence-wide complete/paid/cancel doesn't make product sense — those
    // are always per-visit decisions.
    const leaked = Object.keys(patch).filter(k => (PER_OCCURRENCE_KEYS as readonly string[]).includes(k))
    if (leaked.length) {
      const msg = `[store.updateRecurrenceFromDate] per-occurrence patch on template id=${templateId} keys=${leaked.join(',')}`
      console.error(msg, { patch })
      if (import.meta.env.DEV) throw new Error(msg)
      return
    }
    // 1. Patch the template row itself so future virtuals inherit.
    let updatedTemplate: Job
    try {
      updatedTemplate = await adapter.updateJob(templateId, patch)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't update recurrence: ${msg}`)
      return
    }
    // 2. Soft-delete future non-template instances (overrides) so they don't
    //    keep masking the template's new values. Past visits are preserved.
    try {
      await adapter.bulkUpdateJobs(
        { templateId, isTemplate: false, notDeleted: true, dateFrom: fromDate },
        { deleted: true },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Updated recurrence but couldn't clear overrides: ${msg}`)
    }
    setJobs(prev => prev.map(j => {
      if (j.id === templateId) return updatedTemplate
      if (j.templateId === templateId && !j.isTemplate && j.date >= fromDate) {
        return { ...j, deleted: true }
      }
      return j
    }))
  }

  const changeRecurrenceFrequency = async (
    clientId: string,
    fromDate: string,
    newFrequency: Client['frequency'],
    preserve?: Record<string, unknown>,
  ): Promise<void> => {
    if (!adapter) return
    await syncReanchor(clientId, fromDate, fromDate, newFrequency)
    if (!preserve) return
    // Pull the freshly-inserted template back by its anchor and patch the
    // preserved fields onto it. The adapter call avoids stale closure reads
    // of `jobs`.
    const tpl = await adapter.findTemplateByAnchor(clientId, fromDate)
    if (tpl) await updateJob(tpl.id, preserve)
  }

  const deleteJob = async (id: string): Promise<void> => {
    if (!adapter) return
    // Guard: deleting a template via this generic path soft-deletes the entire
    // recurrence — almost always a virtual-id leak (see PER_OCCURRENCE_KEYS
    // note above). Recurrence-scoped deletes go through syncEndRecurrence /
    // syncDeleteClientJobs / syncCancelOccurrence instead.
    const target = jobs.find(j => j.id === id)
    if (target?.isTemplate) {
      const msg = `[store.deleteJob] refusing to delete template row id=${id} — use syncCancelOccurrence / syncEndRecurrence / syncDeleteClientJobs`
      console.error(msg)
      if (import.meta.env.DEV) throw new Error(msg)
      return
    }
    try {
      await adapter.deleteJob(id)
      setJobs(prev => prev.map(j => j.id === id ? { ...j, deleted: true } : j))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't delete job: ${msg}`)
    }
  }

  const syncEndRecurrence = async (clientId: string, fromDate: string): Promise<void> => {
    if (!adapter) return
    const client = clients.find(c => c.id === clientId)
    const template = jobs.find(j =>
      j.clientId === clientId && j.isTemplate && !j.deleted
    )
    if (!template) return
    // End the day before `fromDate` so `fromDate` itself is excluded.
    const d = new Date(fromDate + 'T00:00:00')
    d.setDate(d.getDate() - 1)
    const endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    try {
      const updated = await adapter.updateJob(template.id, { recurring_end_date: endDate })
      setJobs(prev => prev.map(j => j.id === template.id ? updated : j))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't end recurrence for ${client?.name ?? 'client'}: ${msg}`)
    }
  }

  // Insert a fresh template row without any upsert matching. Used by
  // commitSchedulePlan and the 'this and future' move — both explicitly
  // want a new template, not a reuse of the existing one.
  const insertTemplate = async (clientId: string, startDate: string, frequency: Client['frequency'], avatarColorOverride?: string, startTimeOverride?: string): Promise<string | null> => {
    if (!adapter) return null
    const client = clients.find(c => c.id === clientId)
    if (!client) return null
    const recurring = freqToRecurring(frequency)
    const isRecurring = recurring !== 'one-time'
    const durationMin = scheduleMeta[clientId]?.duration ?? 60
    const durationHours = durationMin / 60
    const row: Record<string, unknown> = {
      client_id: clientId,
      title: null,
      date: startDate,
      start_time: toMobileTime(startTimeOverride ?? '09:00'),
      duration: durationHours,
      price: scheduleMeta[clientId]?.price ?? 0,
      recurring,
      is_recurring: isRecurring,
      is_template: isRecurring,
      recurrence_anchor_date: isRecurring ? startDate : null,
      recurrence_interval: frequency === 'custom' ? (client.intervalWeeks ?? 4) : null,
      recurrence_unit: frequency === 'custom' ? 'weeks' : null,
      // Mobile reads job.avatar_color (not client.avatar_color) for the
      // card paint, so the template row needs its own color copy.
      avatar_color: avatarColorOverride || client.color || DEFAULT_AVATAR_COLOR,
      completed: false,
      cancelled: false,
      deleted: false,
      paid: false,
    }
    try {
      const newJob = await adapter.insertJob(row)
      setJobs(prev => [...prev, newJob])
      return newJob.id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't insert job for ${client.name}: ${msg}`)
      return null
    }
  }

  const syncMoveOccurrence = async (clientId: string, sourceDate: string, targetDate: string): Promise<void> => {
    if (!adapter) return
    const client = clients.find(c => c.id === clientId)
    const template = jobs.find(j =>
      j.clientId === clientId && j.isTemplate && !j.deleted
    )
    if (!template) {
      // No template — this is a one-off move. Update its date.
      const oneOff = jobs.find(j =>
        j.clientId === clientId && !j.isTemplate && j.date === sourceDate && !j.deleted
      )
      if (oneOff) {
        try {
          const updated = await adapter.updateJob(oneOff.id, { date: targetDate })
          setJobs(prev => prev.map(j => j.id === oneOff.id ? updated : j))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          setJobSyncError(`Couldn't move ${client?.name ?? 'client'}: ${msg}`)
        }
      }
      return
    }
    // If there's already an instance for sourceDate (previous move/edit), update it.
    const existingInstance = jobs.find(j =>
      j.templateId === template.id && !j.deleted &&
      (j.originalOccurrenceDate === sourceDate || j.date === sourceDate)
    )
    if (existingInstance) {
      try {
        const updated = await adapter.updateJob(existingInstance.id, { date: targetDate, cancelled: false })
        setJobs(prev => prev.map(j => j.id === existingInstance.id ? updated : j))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setJobSyncError(`Couldn't move ${client?.name ?? 'client'}: ${msg}`)
      }
      return
    }
    const row: Record<string, unknown> = {
      client_id: clientId,
      title: null,
      date: targetDate,
      start_time: toMobileTime(template.startTime ?? '09:00'),
      duration: template.duration,
      price: template.price,
      recurring: 'one-time',
      is_recurring: false,
      is_template: false,
      template_id: template.id,
      original_occurrence_date: sourceDate,
      cancelled: false,
      deleted: false,
      completed: false,
      paid: false,
    }
    try {
      const stored = await adapter.insertJob(row)
      setJobs(prev => [...prev, stored])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't move ${client?.name ?? 'client'}: ${msg}`)
    }
  }

  const syncCancelMonth = async (clientId: string, year: number, month: number): Promise<void> => {
    if (!adapter) return
    const client = clients.find(c => c.id === clientId)
    const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`
    const lastDay = new Date(year, month + 1, 0).getDate()
    const monthEnd = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    // 1. Soft-delete any non-template jobs (one-offs, overrides) in this month.
    try {
      await adapter.bulkUpdateJobs(
        { clientId, isTemplate: false, notDeleted: true, dateFrom: monthStart, dateTo: monthEnd },
        { deleted: true },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't clear month for ${client?.name ?? 'client'}: ${msg}`)
      return
    }

    // 2. Insert cancelled instance rows for every virtual occurrence this month
    //    so mobile (which reads Supabase) also skips them.
    const template = jobs.find(j => j.clientId === clientId && j.isTemplate && !j.deleted)
    if (template) {
      const meta = getClientMeta(scheduleMeta, clientId)
      // Use pre-update meta to compute dates; endDate was only set for future flows, not here.
      const virtualDates = getRecurringDates(meta, year, month)
      if (virtualDates.length) {
        const rows = virtualDates.map(date => ({
          client_id: clientId,
          title: null,
          date,
          start_time: toMobileTime(template.startTime ?? '09:00'),
          duration: template.duration,
          price: template.price,
          recurring: 'one-time',
          is_recurring: false,
          is_template: false,
          template_id: template.id,
          original_occurrence_date: date,
          cancelled: true,
          deleted: false,
          completed: false,
          paid: false,
        }))
        try {
          await adapter.bulkInsertJobs(rows)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          setJobSyncError(`Couldn't skip month for ${client?.name ?? 'client'}: ${msg}`)
          return
        }
      }
    }
    await refreshJobs()
  }

  const syncReanchor = async (
    clientId: string,
    fromDate: string,
    newAnchor: string,
    frequency: Client['frequency'],
  ): Promise<void> => {
    if (!adapter) return
    const client = clients.find(c => c.id === clientId)
    // End-date day before fromDate so fromDate itself is excluded from the old pattern.
    const d = new Date(fromDate + 'T00:00:00')
    d.setDate(d.getDate() - 1)
    const endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    // 1. End-date any live template anchored before fromDate.
    try {
      await adapter.bulkUpdateJobs(
        { clientId, isTemplate: true, notDeleted: true, anchorBefore: fromDate },
        { recurring_end_date: endDate },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't end recurrence for ${client?.name ?? 'client'}: ${msg}`)
      return
    }
    // 2. Hard-delete templates anchored on/after fromDate. We hard-delete
    //    (not soft-delete) because mobile's template query doesn't filter
    //    deleted=false, so soft-deleted templates would still generate
    //    virtual jobs there. Hard delete removes the row entirely.
    try {
      await adapter.bulkDeleteJobs({ clientId, isTemplate: true, anchorOnOrAfter: fromDate })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't clear old templates for ${client?.name ?? 'client'}: ${msg}`)
      return
    }
    // 3. Soft-delete any non-template instances (overrides / one-offs) on or after fromDate.
    try {
      await adapter.bulkUpdateJobs(
        { clientId, isTemplate: false, dateFrom: fromDate },
        { deleted: true },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't clear overrides for ${client?.name ?? 'client'}: ${msg}`)
      return
    }
    // 4. Insert fresh template at newAnchor.
    await insertTemplate(clientId, newAnchor, frequency)
    await refreshJobs()
  }

  const syncDeleteClientJobs = async (clientId: string): Promise<void> => {
    if (!adapter) return
    const client = clients.find(c => c.id === clientId)

    // 1. Hard-delete every template for this client. Mobile's template
    //    query ignores deleted=false, so soft-deleted templates would keep
    //    generating virtual jobs there. Hard delete removes the row.
    try {
      await adapter.bulkDeleteJobs({ clientId, isTemplate: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't remove ${client?.name ?? 'client'} templates: ${msg}`)
      return
    }

    // 2. Soft-delete non-template rows (instances, one-offs). Mobile
    //    DOES filter deleted=false on these queries, so soft-delete is safe
    //    and keeps history auditable.
    try {
      await adapter.bulkUpdateJobs(
        { clientId, isTemplate: false, notDeleted: true },
        { deleted: true },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't remove ${client?.name ?? 'client'} jobs: ${msg}`)
      return
    }
    setJobs(prev => prev
      .filter(j => !(j.clientId === clientId && j.isTemplate))
      .map(j => j.clientId === clientId ? { ...j, deleted: true } : j)
    )
  }

  const addClient = async (name: string, address: string, preCoords?: { lat: number; lng: number } | null, phone?: string): Promise<string | null> => {
    const color = ZONE_COLORS[clients.length % ZONE_COLORS.length]
    const coords = preCoords ?? (address.trim() ? await geocode(address) : null)

    if (!adapter) return null

    const phoneClean = phone?.trim() || null
    try {
      const created = await adapter.insertClient({
        name,
        address: address || null,
        avatar_color: color,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        ...(phoneClean ? { phone: phoneClean } : {}),
      })
      setClients(prev => [...prev, created])
      return created.id
    } catch (err) {
      console.error('Failed to add client:', err)
      return null
    }
  }

  const removeClient = async (id: string) => {
    setClients(prev => prev.filter(c => c.id !== id))
    setPlacements(prev => prev.filter(p => p.clientId !== id))
    setScheduleMeta(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })

    if (!adapter) return
    try {
      await adapter.deleteClient(id)
    } catch (err) {
      console.error('Failed to delete client:', err)
    }
  }

  const updateClient = async (id: string, name: string, address: string, preCoords?: { lat: number; lng: number } | null) => {
    const old = clients.find(c => c.id === id)
    if (!old) return
    const addressChanged = old.address !== address

    setClients(prev => prev.map(c => c.id === id
      ? { ...c, name, address, ...(addressChanged ? { lat: preCoords?.lat ?? null, lng: preCoords?.lng ?? null } : {}) }
      : c
    ))

    if (!adapter) return

    if (addressChanged && address.trim()) {
      const coords = preCoords ?? await geocode(address)
      if (coords) {
        setClients(prev => prev.map(c => c.id === id ? { ...c, lat: coords.lat, lng: coords.lng } : c))
        await adapter.updateClient(id, { name, address, latitude: coords.lat, longitude: coords.lng })
        return
      }
    }

    const updates: Record<string, unknown> = { name, address: address || null }
    if (addressChanged) { updates.latitude = null; updates.longitude = null }
    await adapter.updateClient(id, updates)
  }

  const updateClientCoords = async (id: string, lat: number, lng: number) => {
    setClients(prev => prev.map(c => c.id === id ? { ...c, lat, lng } : c))
    if (!adapter) return
    await adapter.updateClient(id, { latitude: lat, longitude: lng })
  }

  const updateClientColor = async (id: string, color: string) => {
    setClients(prev => prev.map(c => c.id === id ? { ...c, color } : c))
    if (!adapter) return
    try {
      await adapter.updateClient(id, { avatar_color: color })
    } catch (err) {
      const client = clients.find(c => c.id === id)
      const msg = err instanceof Error ? err.message : String(err)
      setJobSyncError(`Couldn't save color for ${client?.name ?? 'client'}: ${msg}`)
    }
  }

  const updateClientBlockedDays = (id: string, blockedDays: DayOfWeek[]) => {
    setClients(prev => prev.map(c => c.id === id ? { ...c, blockedDays } : c))
    // Fire-and-forget; local state already updated for instant UI feedback.
    if (adapter) {
      adapter.updateClient(id, { blocked_weekdays: blockedDays }).catch(err => {
        const client = clients.find(c => c.id === id)
        const msg = err instanceof Error ? err.message : String(err)
        setJobSyncError(`Couldn't save blocked days for ${client?.name ?? 'client'}: ${msg}`)
      })
    }
    setScheduleMeta(prev => {
      const meta = getClientMeta(prev, id)
      return { ...prev, [id]: { ...meta, blockedDays } }
    })
  }

  const updateClientScheduleMeta = (id: string, updates: { frequency?: Client['frequency']; intervalWeeks?: number; duration?: number; price?: number }) => {
    if (updates.frequency !== undefined) {
      setClients(prev => prev.map(c => c.id === id ? { ...c, frequency: updates.frequency!, intervalWeeks: updates.intervalWeeks ?? c.intervalWeeks } : c))
    }
    setScheduleMeta(prev => {
      const meta = getClientMeta(prev, id)
      return {
        ...prev,
        [id]: {
          ...meta,
          ...(updates.frequency !== undefined ? { frequency: updates.frequency } : {}),
          ...(updates.intervalWeeks !== undefined ? { intervalWeeks: updates.intervalWeeks } : {}),
          ...(updates.duration !== undefined ? { duration: updates.duration } : {}),
          ...(updates.price !== undefined ? { price: updates.price } : {}),
        },
      }
    })
  }

  const getClientDuration = (id: string): number => {
    return scheduleMeta[id]?.duration ?? 60
  }

  const getClientPrice = (id: string): number => {
    return scheduleMeta[id]?.price ?? 0
  }

  const bulkUpdateClientPrice = async (clientIds: string[], price: number) => {
    if (clientIds.length === 0) return
    // 1. Persist the per-recurrence default locally so future inserts pick it up.
    setScheduleMeta(prev => {
      const next = { ...prev }
      for (const id of clientIds) {
        const meta = getClientMeta(prev, id)
        next[id] = { ...meta, price }
      }
      return next
    })
    if (!adapter) return
    // 2. Rewrite jobs.price on all forward-looking rows — templates + upcoming
    //    materialized instances. Completed/cancelled/deleted jobs are frozen.
    try {
      await adapter.bulkUpdateJobs(
        { clientIds, notCompleted: true, notCancelled: true, notDeleted: true },
        { price },
      )
    } catch (err) {
      console.error('bulkUpdateClientPrice (jobs) failed:', err)
    }
    await refreshJobs()
  }

  /** Edit a single job with explicit scope. `scope='this'` updates only this
   *  occurrence (materializing first if it's a virtual template instance).
   *  `scope='all'` updates the recurring template AND soft-deletes future
   *  overrides so virtuals inherit — mirrors mobile's EditJobScreen editScope. */
  const updateJobWithScope = async (
    job: Job,
    patch: Record<string, unknown>,
    scope: 'this' | 'all',
  ): Promise<void> => {
    if (!user) return
    if (scope === 'all') {
      // Find the template id. Direct fields first; if missing (e.g. older
      // detached instance), fall back to searching jobs for the recurring
      // template that owns this client. Without this fallback, "All future"
      // silently no-ops on jobs that lack templateId.
      let templateId: string | null = job.isTemplate
        ? job.id
        : job.templateId ?? null
      if (!templateId && job.clientId) {
        const tpl = jobs.find(j =>
          j.isTemplate && !j.deleted && j.clientId === job.clientId,
        )
        if (tpl) templateId = tpl.id
      }
      if (templateId) {
        await updateRecurrenceFromDate(templateId, job.date, patch)
        return
      }
      // No template found — fall through to single-job update so the user's
      // edit still saves (just doesn't propagate). Better than silent loss.
    }
    // scope === 'this' (or no template found)
    // Virtual occurrence: row doesn't exist yet in db (id === templateId).
    // Materialize first, then patch the materialized instance.
    const isVirtual = !job.isTemplate && !!job.templateId && job.id === job.templateId
    if (isVirtual) {
      const newId = await materializeVirtualOccurrence(job)
      if (!newId) return
      await updateJob(newId, patch)
      return
    }
    await updateJob(job.id, patch)
  }

  // ── Placement logic ──

  /** Add a single manual placement (used for moving between days) */
  const placeClient = (clientId: string, date: string) => {
    setPlacements(prev => {
      if (prev.some(p => p.clientId === clientId && p.date === date)) return prev
      return [...prev, { clientId, date }]
    })
  }

  /**
   * Set up a client's schedule.
   * - one-time: adds a single placement, no recurrence
   * - weekly/biweekly/monthly: sets recurrence metadata, dates auto-generate
   */
  const placeClientRecurring = (clientId: string, startDate: string, frequency: Client['frequency'], intervalWeeks?: number) => {
    if (frequency === 'one-time') {
      // One-time: just add a manual placement for this specific date
      setPlacements(prev => {
        if (prev.some(p => p.clientId === clientId && p.date === startDate)) return prev
        return [...prev, { clientId, date: startDate }]
      })
      // Store frequency in meta so we know it's placed
      setScheduleMeta(prev => ({
        ...prev,
        [clientId]: { frequency: 'one-time', startDate, exceptions: [], blockedDays: getClientMeta(prev, clientId).blockedDays },
      }))
    } else {
      // Recurring: set metadata, clear manual placements (recurrence handles it)
      setScheduleMeta(prev => ({
        ...prev,
        [clientId]: { frequency, intervalWeeks: frequency === 'custom' ? intervalWeeks : undefined, startDate, exceptions: [], blockedDays: getClientMeta(prev, clientId).blockedDays },
      }))
      // Remove manual placements — recurrence generates the dates now
      setPlacements(prev => prev.filter(p => p.clientId !== clientId))
    }

    // Also update client object for guest mode persistence
    setClients(prev => prev.map(c =>
      c.id === clientId ? { ...c, frequency, intervalWeeks: frequency === 'custom' ? intervalWeeks : undefined, startDate, exceptions: [] } : c
    ))
    // Single sync point for placement changes. Upserts a template (recurring)
    // or one-off job. All callers — drops, moves, bulkReassignDays — get
    // mobile sync automatically.
    void createJobFromPlacement(clientId, startDate, frequency)
  }

  /** Remove a client from a single date */
  const unplaceClient = (clientId: string, date: string) => {
    // Remove manual placement if it exists
    setPlacements(prev => prev.filter(p => !(p.clientId === clientId && p.date === date)))
    // Add exception if this was a recurring date
    const meta = getClientMeta(scheduleMeta, clientId)
    if (meta.startDate && meta.frequency !== 'one-time') {
      setScheduleMeta(prev => ({
        ...prev,
        [clientId]: { ...meta, exceptions: [...new Set([...meta.exceptions, date])] },
      }))
    }
  }

  /** Remove a client from `fromDate` forward (all months, not just current).
   *  Clears placements globally and sets meta.endDate = fromDate-1 so virtual
   *  recurrence stops at the cutoff in future month views too. */
  const unplaceClientFuture = (clientId: string, fromDate: string, _year: number, _month: number) => {
    void _year; void _month // kept for API stability; previously month-scoped
    const meta = getClientMeta(scheduleMeta, clientId)
    // Drop every manual placement on/after fromDate, regardless of month.
    setPlacements(prev => prev.filter(p => !(p.clientId === clientId && p.date >= fromDate)))

    // End the virtual recurrence one day before fromDate.
    const d = new Date(fromDate + 'T00:00:00')
    d.setDate(d.getDate() - 1)
    const endIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    if (meta.startDate && meta.frequency !== 'one-time') {
      setScheduleMeta(prev => ({
        ...prev,
        [clientId]: { ...meta, endDate: endIso },
      }))
    }
  }

  /** Remove a client from every date in the current month only.
   *  Recurrence keeps running in other months — this is a month-scoped
   *  "skip" (exceptions), not a template teardown. */
  const unplaceClientAll = (clientId: string, year: number, month: number) => {
    const meta = getClientMeta(scheduleMeta, clientId)
    const allDates = getAllDatesInternal(clientId, meta, year, month)

    setPlacements(prev => prev.filter(p => !(p.clientId === clientId && allDates.includes(p.date))))

    if (meta.startDate && meta.frequency !== 'one-time') {
      setScheduleMeta(prev => ({
        ...prev,
        [clientId]: { ...meta, exceptions: [...new Set([...meta.exceptions, ...allDates])] },
      }))
    }
  }

  /** Wipe all placements + clear recurrence meta. Used for the "every
   *  instance ever" delete scope. Recurrence is reset to defaults so the
   *  client is fully unplaced — not just skipped. */
  const unplaceClientEverything = (clientId: string) => {
    setPlacements(prev => prev.filter(p => p.clientId !== clientId))
    setScheduleMeta(prev => {
      const meta = prev[clientId]
      if (!meta) return prev
      return {
        ...prev,
        [clientId]: { ...meta, startDate: null, exceptions: [], endDate: undefined },
      }
    })
  }

  // Companion to dataReset.deleteAllJobs — without this the calendar still
  // renders recurring chips from local placements/scheduleMeta after the
  // Supabase jobs are gone, while the sidebar (which keys off jobs) shows
  // every client unplaced. The two views diverge until a hard reload.
  const clearLocalScheduleState = () => {
    setPlacements([])
    setScheduleMeta({})
    try { localStorage.removeItem(SCHEDULE_PLAN_KEY) } catch { /* ignore */ }
    try { localStorage.removeItem('pip-apply-undo') } catch { /* ignore */ }
  }

  /** Internal: get all dates for a client in a month (recurring + manual + jobs) */
  const getAllDatesInternal = (clientId: string, meta: ScheduleMeta, year: number, month: number): string[] => {
    const recurring = getRecurringDates(meta, year, month)
    const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`
    const manual = placements.filter(p => p.clientId === clientId && p.date.startsWith(monthPrefix)).map(p => p.date)
    // Include dates from mobile-authored jobs so per-client date lists (map
    // filter, route preview, week chip tags) see them too.
    const jobDates: string[] = []
    const expanded = jobsForMonth(jobs, year, month)
    for (const [iso, js] of Object.entries(expanded)) {
      if (js.some(j => j.clientId === clientId)) jobDates.push(iso)
    }
    return [...new Set([...recurring, ...manual, ...jobDates])]
  }

  const getAllDatesForClient = useCallback((clientId: string, year: number, month: number): string[] => {
    const meta = getClientMeta(scheduleMeta, clientId)
    return getAllDatesInternal(clientId, meta, year, month)
  }, [scheduleMeta, placements])

  const getClientsForDate = useCallback((date: string): Client[] => {
    const d = new Date(date + 'T00:00:00')
    const year = d.getFullYear()
    const month = d.getMonth()

    const manualIds = placements.filter(p => p.date === date).map(p => p.clientId)
    const recurringIds = clients
      .filter(c => !manualIds.includes(c.id))
      .filter(c => {
        const meta = getClientMeta(scheduleMeta, c.id)
        return getRecurringDates(meta, year, month).includes(date)
      })
      .map(c => c.id)

    // Also pull clients attached to jobs on this date (templates expanded).
    // Previously these showed only in the month grid — widening here makes
    // week/day views, map, and anything else consuming getClientsForDate see
    // mobile-created jobs too.
    const jobsOnDate = getJobsForDate(date, year, month)
    const jobClientIds = jobsOnDate
      .map(j => j.clientId)
      .filter((id): id is string => !!id)

    const allIds = [...new Set([...manualIds, ...recurringIds, ...jobClientIds])]
    return allIds.map(id => clients.find(c => c.id === id)).filter(Boolean) as Client[]
  }, [clients, placements, scheduleMeta, getJobsForDate])

  const getUnplacedClients = useCallback((_year: number, _month: number): Client[] => {
    // Single source of truth for "placed": does the client have any job
    // (template or instance) in Supabase? Web placements + scheduleMeta are
    // optimistic UI state, but they used to drive this and would drift away
    // from real jobs — that's how ghost chips happened. Now the sidebar
    // mirrors what mobile actually sees.
    const jobClientIds = new Set<string>()
    for (const j of jobs) {
      if (j.clientId && !j.deleted) jobClientIds.add(j.clientId)
    }
    return clients.filter(c => !jobClientIds.has(c.id))
  }, [clients, jobs])

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  const getBestDays = useCallback((clientId: string): BestDay[] => {
    // Smart Placement is Pip+. Gate at the data layer so callers can't accidentally
    // surface stale suggestions left over from a previous Pip+ session — the toggle
    // value lives in localStorage and would otherwise render ghost rings/cards.
    if (!profile.isPlus) return []
    if (!smartConfig.enabled) return []
    const client = clients.find(c => c.id === clientId)
    if (!client || client.lat === null || client.lng === null) return []

    // Build day groups from the current placed roster (recurrence-aware: one bucket
    // per anchor weekday). New/unplaced clients do not contribute here.
    const dayGroups = new Map<number, Client[]>()
    const clientDurations = new Map<string, number>()
    const clientFrequency = new Map<string, Client['frequency']>()
    for (const c of clients) {
      if (c.id === clientId) continue
      const meta = getClientMeta(scheduleMeta, c.id)
      if (!meta.startDate) continue
      const anchor = new Date(meta.startDate + 'T00:00:00')
      const day = anchor.getDay()
      const group = dayGroups.get(day) || []
      group.push(c)
      dayGroups.set(day, group)
      clientDurations.set(c.id, meta.duration ?? DEFAULT_VISIT_MIN)
      clientFrequency.set(c.id, meta.frequency)
    }

    const meta = getClientMeta(scheduleMeta, clientId)
    const newDuration = meta.duration ?? DEFAULT_VISIT_MIN

    const workingMin = timeWindowMinutes(smartConfig.workingStart, smartConfig.workingEnd)
    const suggestions = computeSmartPlacement(
      {
        lat: client.lat,
        lng: client.lng,
        frequency: meta.frequency,
        intervalWeeks: meta.intervalWeeks,
        blockedDays: meta.blockedDays ?? client.blockedDays ?? [],
      },
      dayGroups,
      { maxJobsPerDay: smartConfig.maxJobsPerDay, workingDays: smartConfig.workingDays, workingMinutes: workingMin },
      clientDurations,
      clientFrequency,
      newDuration,
      homeAddress ? { lat: homeAddress.lat, lng: homeAddress.lng } : undefined,
    )

    // Build a per-date load cache for the 12-week horizon so firstDate search
    // can check per-week occupancy (biweekly rotations, etc).
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const max = smartConfig.maxJobsPerDay

    function nextOccurrence(weekday: number): Date {
      // Floor at tomorrow. Web is the planning command center, not the
      // field OS — surfacing today as a "best day" mixes modes (by the
      // time the user is planning, today is dead air, and for recurring
      // chains anchoring on today locks the cadence to start now). The
      // +1..+7 range collapses today onto next week's same weekday.
      const d = new Date(today)
      const delta = ((weekday - d.getDay() + 6) % 7) + 1
      d.setDate(d.getDate() + delta)
      return d
    }

    /** Does the specific date have room for the new client? */
    function dateFits(dateStr: string): boolean {
      const jobs = getClientsForDateInternal(dateStr)
      if (max > 0 && jobs.length + 1 > max) return false
      if (workingMin > 0) {
        let minutes = newDuration
        for (const j of jobs) minutes += scheduleMeta[j.id]?.duration ?? DEFAULT_VISIT_MIN
        if (minutes > workingMin) return false
      }
      return true
    }

    /**
     * Strict-fit sustainable date search. Returns the first date in the 12-week
     * horizon where ALL subsequent recurrence instances also fit — no partial
     * fits. If the cadence can't be sustained, returns null.
     *
     * - weekly:   every week of the chosen weekday must fit
     * - biweekly: every 2 weeks must fit; tries both parity offsets, picks whichever works
     * - monthly:  every 4 weeks (matches existing recurrence.ts)
     * - one-time: first fitting date only
     * - custom:   every intervalWeeks (defaults to 1 if missing)
     */
    function findSustainableDate(weekday: number): string | null {
      const anchor = nextOccurrence(weekday)
      const freq = meta.frequency
      const stepWeeks =
        freq === 'one-time' ? 0 :
        freq === 'weekly'   ? 1 :
        freq === 'biweekly' ? 2 :
        freq === 'monthly'  ? 4 :
        freq === 'custom'   ? Math.max(1, meta.intervalWeeks ?? 1) :
        1

      // one-time: first fit, no chain check
      if (stepWeeks === 0) {
        for (let w = 0; w < PLACEMENT_HORIZON_WEEKS; w++) {
          const d = new Date(anchor); d.setDate(anchor.getDate() + w * 7)
          const ds = fmt(d)
          if (dateFits(ds)) return ds
        }
        return null
      }

      // Recurring: try each starting offset within one cadence window, then
      // verify the full chain from that start across the horizon.
      for (let startOffset = 0; startOffset < stepWeeks; startOffset++) {
        const start = new Date(anchor); start.setDate(anchor.getDate() + startOffset * 7)
        const chain: string[] = []
        for (let w = startOffset; w < PLACEMENT_HORIZON_WEEKS; w += stepWeeks) {
          const d = new Date(anchor); d.setDate(anchor.getDate() + w * 7)
          chain.push(fmt(d))
        }
        if (chain.length === 0) continue
        const allFit = chain.every(dateFits)
        if (allFit) return chain[0]
      }
      return null
    }

    // Evaluate every candidate day, filter to those that sustain, then take top 3.
    const sustainable = suggestions
      .map(s => ({ ...s, firstDate: findSustainableDate(s.day) }))
      .filter(s => s.firstDate !== null)

    const top = sustainable.slice(0, 3)
    return top.map((s, i) => {
      const nearby = s.nearbyCount
      const nearestMin = Math.round(s.nearestNeighborMin)
      const isAdjacent = s.dayClientCount > 0 && s.nearestNeighborMin < 2
      const reason = s.dayClientCount === 0
        ? 'Open day'
        : isAdjacent
          ? `Next door · ${nearby} nearby`
          : `Closest ${nearestMin}min · ${nearby} nearby`
      const capPct = Math.round(s.capacityPressure * 100)
      const breakdown =
        `Closest neighbor: ${nearestMin} min\n` +
        `Nearby (≤15 min): ${nearby} of ${s.dayClientCount}\n` +
        `Cluster center: ${Math.round(s.clusterFit)} min\n` +
        `Capacity: ${capPct}%\n` +
        `Score: ${s.score.toFixed(1)}`
      return {
        day: s.day,
        dayName: DAY_NAMES[s.day],
        rank: i + 1,
        score: s.score,
        reason,
        breakdown,
        firstDate: s.firstDate,
        nearbyCount: nearby,
        nearestNeighborMin: s.nearestNeighborMin,
        clusterFit: s.clusterFit,
        capacityPressure: s.capacityPressure,
        full: false,
      }
    })
  }, [clients, scheduleMeta, homeAddress, smartConfig, placements, profile.isPlus])

  // Internal: used by getBestDays — avoids the useCallback cycle with getClientsForDate.
  const getClientsForDateInternal = (date: string): Client[] => {
    const d = new Date(date + 'T00:00:00')
    const year = d.getFullYear()
    const month = d.getMonth()
    const manualIds = placements.filter(p => p.date === date).map(p => p.clientId)
    const recurringIds = clients
      .filter(c => !manualIds.includes(c.id))
      .filter(c => {
        const meta = getClientMeta(scheduleMeta, c.id)
        return getRecurringDates(meta, year, month).includes(date)
      })
      .map(c => c.id)
    const jobsOnDate = getJobsForDate(date, year, month)
    const jobClientIds = jobsOnDate.map(j => j.clientId).filter((id): id is string => !!id)
    const allIds = [...new Set([...manualIds, ...recurringIds, ...jobClientIds])]
    return allIds.map(id => clients.find(c => c.id === id)).filter(Boolean) as Client[]
  }

  /** Bulk reassign clients to new days, optionally setting per-client recurrence.
   *  Rotations map (0=even, 1=odd) staggers biweekly anchors so A/B groups alternate.
   *  startDate: optional cycle start date (Week 1 of the 4-week grid). Defaults to today. */
  const bulkReassignDays = (assignments: Map<string, number>, recurrenceOverrides?: Map<string, Client['frequency']>, rotations?: Map<string, number>, cycleStart?: Date) => {
    const rawBase = cycleStart ?? new Date()
    // Snap to Monday of the start week — ensures correct anchor math for any start date
    const baseDate = new Date(rawBase)
    const baseDow = baseDate.getDay()
    baseDate.setDate(baseDate.getDate() - ((baseDow + 6) % 7)) // rewind to Monday
    for (const [clientId, targetDay] of assignments) {
      const client = clients.find(c => c.id === clientId)
      if (!client) continue
      const freq = recurrenceOverrides?.get(clientId)
        ?? (client.frequency === 'one-time' ? 'weekly' : client.frequency)
      // Find the occurrence of targetDay in the same week as the snapped Monday
      const daysUntil = (targetDay - 1 + 7) % 7 // Monday=0, Tue=1, ..., Sun=6
      const anchorDate = new Date(baseDate)
      anchorDate.setDate(baseDate.getDate() + daysUntil)
      // Biweekly rotation B: offset anchor by +7 days so A/B groups alternate weeks
      const rotation = rotations?.get(clientId) ?? 0
      if (freq === 'biweekly' && rotation === 1) {
        anchorDate.setDate(anchorDate.getDate() + 7)
      }
      const dateStr = `${anchorDate.getFullYear()}-${String(anchorDate.getMonth() + 1).padStart(2, '0')}-${String(anchorDate.getDate()).padStart(2, '0')}`
      placeClientRecurring(clientId, dateStr, freq)
    }
  }

  // Undo snapshot for the most recent Schedule Builder apply. Stored in
  // localStorage so it survives reloads until the next apply overwrites it.
  const UNDO_KEY = 'pip-apply-undo'
  type UndoSnapshot = {
    placements: Placement[]
    scheduleMeta: Record<string, ScheduleMeta>
    clientSchedulingMeta: Record<string, {
      frequency: Client['frequency']
      startDate: string | null
      intervalWeeks?: number
      exceptions: string[]
    }>
    timestamp: string
    applyId?: string
  }
  const [lastApplySnapshotAt, setLastApplySnapshotAt] = useState<string | null>(() => {
    const raw = loadLocal<UndoSnapshot | null>(UNDO_KEY, null)
    return raw?.timestamp ?? null
  })
  const [lastApplyId, setLastApplyId] = useState<string | null>(() => {
    const raw = loadLocal<UndoSnapshot | null>(UNDO_KEY, null)
    return raw?.applyId ?? null
  })

  // ── SchedulePlan state ─────────────────────────────────────────────────────
  const [schedulePlan, setSchedulePlanState] = useState<SchedulePlan | null>(() => loadSchedulePlan())

  const setSchedulePlan = (plan: SchedulePlan | null) => {
    setSchedulePlanState(plan)
    saveSchedulePlan(plan)
  }

  /** Build a plan from Builder output and activate it. No live-schedule writes happen here. */
  const createSchedulePlan = (
    assignments: Map<string, number>,
    rotations: Map<string, number>,
    recurrence: Map<string, Client['frequency']>,
    intervalWeeks: Map<string, number>,
  ): string => {
    const plan = buildSchedulePlan(clients, assignments, rotations, recurrence, intervalWeeks)
    setSchedulePlan(plan)
    return plan.id
  }

  const discardSchedulePlan = () => {
    setSchedulePlan(null)
  }

  const updateSchedulePlan = (updater: (plan: SchedulePlan) => SchedulePlan) => {
    setSchedulePlanState(prev => {
      if (!prev) return prev
      const next = updater(prev)
      saveSchedulePlan(next)
      return next
    })
  }

  /** Atomically commit the active plan to the live schedule at `cutoverDate`.
   *  Reads placements from the plan (which may include swaps) rather than a
   *  fresh Builder output. Returns false if no active plan or any client is
   *  not yet confirmed. */
  const commitSchedulePlan = async (cutoverDate: Date): Promise<boolean> => {
    if (!schedulePlan || schedulePlan.status !== 'active') return false
    if (schedulePlan.clients.some(c => c.status !== 'confirmed')) return false
    if (!adapter) return false

    const recurrence = new Map<string, Client['frequency']>(schedulePlan.builderRecurrence)
    const intervalWeeks = new Map<string, number>(schedulePlan.builderIntervalWeeks)
    const assignments = new Map<string, number>(
      schedulePlan.clients.map(c => [c.clientId, c.plannedDay]),
    )
    const rotations = new Map<string, number>(
      schedulePlan.clients.map(c => [c.clientId, c.plannedRotation]),
    )

    // Local-state cutover: freeze pre-cutover dates as one-offs and clear
    // everyone's recurrence. Supabase cleanup + insert happens below.
    applyNewScheduleFromBuilder(assignments, recurrence, rotations, intervalWeeks, cutoverDate)

    const rawCutover = new Date(cutoverDate)
    rawCutover.setHours(0, 0, 0, 0)
    const toIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const cutoverIso = toIso(rawCutover)
    const dayBefore = new Date(rawCutover)
    dayBefore.setDate(dayBefore.getDate() - 1)
    const dayBeforeIso = toIso(dayBefore)
    const cutoverMonday = new Date(rawCutover)
    cutoverMonday.setDate(rawCutover.getDate() - ((rawCutover.getDay() + 6) % 7))

    // ── Backend cleanup: rewrite this user's calendar from cutover forward.
    // User-scoped (via RLS + adapter's user_id pin), NOT plan-scoped — so the
    // wipe also catches: tasks (client_id IS NULL), non-plan clients,
    // web drag-drop recurring placements, and jobs on weekdays the new
    // plan no longer uses. Pre-cutover history is preserved. ──

    // 1. Templates anchored BEFORE cutover: end-date them so past virtual
    //    occurrences keep rendering, but no future ones.
    await adapter.bulkUpdateJobs(
      { isTemplate: true, notDeleted: true, anchorBefore: cutoverIso },
      { recurring_end_date: dayBeforeIso },
    )

    // 2. Templates anchored ON/AFTER cutover: prior Builder outputs being
    //    replaced. HARD-delete (not soft) because mobile's template query
    //    doesn't filter deleted=false — soft-deleted templates would keep
    //    generating virtual jobs on mobile.
    await adapter.bulkDeleteJobs({
      isTemplate: true, anchorOnOrAfter: cutoverIso,
    })

    // 3. Non-template rows (instances, one-offs, tasks, moved visits) dated
    //    ON/AFTER cutover: soft-delete. Pre-cutover instances stay.
    await adapter.bulkUpdateJobs(
      { isTemplate: false, dateFrom: cutoverIso },
      { deleted: true },
    )

    // Sequential start times: every client on the same (day, rotation) group
    // is placed back-to-back from the configured working start, ordered by the
    // optimizer's visit sequence (= the order schedulePlan.clients was built).
    // No drive-time padding — jobs run immediately after one another.
    const [wsH, wsM] = smartConfig.workingStart.split(':').map(Number)
    const dayStartMin = (Number.isFinite(wsH) ? wsH : 8) * 60 + (Number.isFinite(wsM) ? wsM : 0)
    const cursorByGroup = new Map<string, number>()
    const fmtHHMM = (mins: number) => {
      const h = Math.floor(mins / 60)
      const m = mins % 60
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }

    // Sort by (plannedDay, plannedRotation) so a client whose plannedDay was
    // changed mid-plan (e.g. Skip on Can't Move flips them back to their
    // original day) lands in their actual day's stack instead of at their
    // pre-change array index. Sort is stable, so within each (day, rotation)
    // group the optimizer's original visit order is preserved for un-moved
    // clients.
    const orderedPlanClients = [...schedulePlan.clients].sort((a, b) => {
      if (a.plannedDay !== b.plannedDay) return a.plannedDay - b.plannedDay
      return a.plannedRotation - b.plannedRotation
    })

    // ── Insert fresh templates per the new plan ──
    for (const pc of orderedPlanClients) {
      const freq = recurrence.get(pc.clientId) ?? 'weekly'
      const iw = intervalWeeks.get(pc.clientId)

      const daysUntil = (pc.plannedDay - 1 + 7) % 7
      const anchorDate = new Date(cutoverMonday)
      anchorDate.setDate(cutoverMonday.getDate() + daysUntil)
      if (freq === 'biweekly' && pc.plannedRotation === 1) {
        anchorDate.setDate(anchorDate.getDate() + 7)
      }
      const intervalDays =
        freq === 'biweekly' ? 14 :
        freq === 'monthly' ? 28 :
        freq === 'custom'  ? (iw ?? 4) * 7 :
        7
      while (anchorDate.getTime() < rawCutover.getTime()) {
        anchorDate.setDate(anchorDate.getDate() + intervalDays)
      }
      const startDateStr = toIso(anchorDate)

      // Compute this client's start time within its day-rotation group.
      const groupKey = `${pc.plannedDay}-${pc.plannedRotation}`
      const slotMin = cursorByGroup.get(groupKey) ?? dayStartMin
      const durationMin = scheduleMeta[pc.clientId]?.duration ?? 60
      cursorByGroup.set(groupKey, slotMin + durationMin)
      const startTimeStr = fmtHHMM(slotMin)

      // Local state
      reanchorClient(pc.clientId, startDateStr, freq, iw)
      // Supabase — direct insert, no upsert (we already nuked the old ones).
      // Pass the weekday color so mobile picks it up on the job row too.
      const plannedColor = dayColors[pc.plannedDay] ?? DEFAULT_AVATAR_COLOR
      await insertTemplate(pc.clientId, startDateStr, freq, plannedColor, startTimeStr)
    }

    // Sync weekday colors → clients.avatar_color so mobile + web agree.
    // Group by target color so we do one bulk UPDATE per color, not per client.
    const colorGroups = new Map<string, string[]>()
    for (const pc of schedulePlan.clients) {
      const color = dayColors[pc.plannedDay] ?? DEFAULT_AVATAR_COLOR
      const arr = colorGroups.get(color) ?? []
      arr.push(pc.clientId)
      colorGroups.set(color, arr)
    }
    if (adapter) {
      for (const [color, ids] of colorGroups) {
        await adapter.bulkUpdateClients(ids, { avatar_color: color })
      }
    }

    // Pull fresh from Supabase so local state matches (cleanup above used
    // bulk updates that don't flow through setJobs).
    await refreshJobs()
    await refreshClients()

    setSchedulePlan(null)
    return true
  }

  const undoLastApply = (): boolean => {
    const snap = loadLocal<UndoSnapshot | null>(UNDO_KEY, null)
    if (!snap) return false
    setPlacements(snap.placements)
    setScheduleMeta(snap.scheduleMeta)
    setClients(prev => prev.map(c => {
      const entry = snap.clientSchedulingMeta[c.id]
      if (!entry) return c
      return {
        ...c,
        frequency: entry.frequency,
        intervalWeeks: entry.intervalWeeks,
        startDate: entry.startDate,
        exceptions: entry.exceptions,
      }
    }))
    try { localStorage.removeItem(UNDO_KEY) } catch { /* ignore */ }
    // Also clear any persisted Transition state tied to this apply
    try {
      if (snap.applyId) {
        localStorage.removeItem(`pip-transition-state-${snap.applyId}`)
        localStorage.removeItem('pip-transition-apply-id')
      }
    } catch { /* ignore */ }
    setLastApplySnapshotAt(null)
    setLastApplyId(null)
    return true
  }

  /** Re-anchor a placed client without wiping frozen pre-cutover placements. */
  const reanchorClient = (clientId: string, newStartDate: string, frequency?: Client['frequency'], intervalWeeks?: number) => {
    const currentMeta = getClientMeta(scheduleMeta, clientId)
    const freq = frequency ?? currentMeta.frequency
    setScheduleMeta(prev => ({
      ...prev,
      [clientId]: {
        ...currentMeta,
        frequency: freq,
        intervalWeeks: freq === 'custom' ? (intervalWeeks ?? currentMeta.intervalWeeks) : undefined,
        startDate: newStartDate,
        // Exceptions tied to old anchor's generated dates may no longer apply;
        // the safer default is to clear them on re-anchor.
        exceptions: [],
      },
    }))
    // Drop only placements on/after the new anchor — pre-anchor placements are
    // the frozen past and must stay visible.
    setPlacements(prev => prev.filter(p => p.clientId !== clientId || p.date < newStartDate))
    setClients(prev => prev.map(c =>
      c.id === clientId
        ? { ...c, frequency: freq, intervalWeeks: freq === 'custom' ? (intervalWeeks ?? currentMeta.intervalWeeks) : undefined, startDate: newStartDate, exceptions: [] }
        : c
    ))
    // NOTE: reanchorClient is local-state-only. Supabase sync is the
    // caller's responsibility. commitSchedulePlan runs a bulk cleanup +
    // insert. The Schedule-page 'this and future' move pre-syncs its own
    // end-date and insert.
  }

  /** Un-place a client: clear their recurrence back to one-time/null and drop
   *  any placements dated from today forward. Frozen pre-today placements stay
   *  intact (those are history). Used by the Transition "Revert" action and
   *  the swap flow when an already-confirmed partner is re-routed. */
  const unconfirmClient = (clientId: string) => {
    const currentMeta = getClientMeta(scheduleMeta, clientId)
    const now = new Date()
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    setScheduleMeta(prev => ({
      ...prev,
      [clientId]: {
        ...currentMeta,
        frequency: 'one-time',
        intervalWeeks: undefined,
        startDate: null,
        exceptions: [],
      },
    }))
    setPlacements(prev => prev.filter(p => p.clientId !== clientId || p.date < todayIso))
    setClients(prev => prev.map(c =>
      c.id === clientId
        ? { ...c, frequency: 'one-time', intervalWeeks: undefined, startDate: null, exceptions: [] }
        : c
    ))
  }

  /** Cutover apply: freeze the past as one-offs and clear every client's
   *  recurrence. Does NOT place anyone on the new schedule — the builder
   *  output is a proposal, and each client gets re-anchored in Transition
   *  only when the user confirms them. Future dates stay empty until then. */
  const applyNewScheduleFromBuilder = (
    assignments: Map<string, number>,
    recurrenceOverrides: Map<string, Client['frequency']>,
    rotations: Map<string, number>,
    intervalWeeksMap: Map<string, number>,
    cutoverDate: Date,
  ): string => {
    const toIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    // New apply = new ID. Any persisted Transition state tied to an older
    // applyId becomes orphaned and will be ignored on next load.
    const newApplyId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `apply-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

    // Undo snapshot — captured BEFORE any mutations so the banner on /schedule
    // can one-click revert the cutover. Persisted to localStorage; overwritten
    // by the next apply.
    const snapshot: UndoSnapshot = {
      placements: placements.map(p => ({ ...p })),
      scheduleMeta: JSON.parse(JSON.stringify(scheduleMeta)),
      clientSchedulingMeta: Object.fromEntries(clients.map(c => [c.id, {
        frequency: c.frequency,
        startDate: c.startDate ?? null,
        intervalWeeks: c.intervalWeeks,
        exceptions: c.exceptions ?? [],
      }])),
      timestamp: new Date().toISOString(),
      applyId: newApplyId,
    }
    try {
      localStorage.setItem(UNDO_KEY, JSON.stringify(snapshot))
      setLastApplySnapshotAt(snapshot.timestamp)
      setLastApplyId(newApplyId)
    } catch { /* storage full — apply still proceeds without undo */ }

    // Keep cutoverMonday for anchor math elsewhere, but use the actual cutover
    // date for the freeze boundary so mid-week jobs before cutover survive.
    const rawCutover = new Date(cutoverDate)
    rawCutover.setHours(0, 0, 0, 0)
    const cutoverIso = toIso(rawCutover)

    // Freeze window: 3 months back through the day before cutover. Keeps recent
    // history visible on the calendar so past jobs don't vanish when recurrence
    // meta is cleared.
    const freezeStart = new Date(rawCutover)
    freezeStart.setMonth(freezeStart.getMonth() - 3)
    const freezeStartIso = toIso(freezeStart)

    const frozen: Placement[] = []
    for (const client of clients) {
      const meta = getClientMeta(scheduleMeta, client.id)
      if (!meta.startDate || meta.frequency === 'one-time') continue
      // Walk each month in the window, collect recurring dates strictly before cutover.
      const cursor = new Date(freezeStart.getFullYear(), freezeStart.getMonth(), 1)
      const windowEnd = new Date(rawCutover.getFullYear(), rawCutover.getMonth(), 1)
      while (cursor <= windowEnd) {
        const dates = getRecurringDates(meta, cursor.getFullYear(), cursor.getMonth())
        for (const d of dates) {
          if (d >= freezeStartIso && d < cutoverIso && !meta.exceptions.includes(d)) {
            frozen.push({ clientId: client.id, date: d })
          }
        }
        cursor.setMonth(cursor.getMonth() + 1)
      }
    }

    // Build fresh scheduleMeta: everyone cleared. The builder output is a
    // PROPOSAL, not a commit — each client gets re-anchored onto the new
    // schedule only when the user confirms them in the Transition sidebar.
    // Past dates stay visible via the frozen placements above; future is empty
    // until confirmations roll in.
    const newMeta: Record<string, ScheduleMeta> = {}
    for (const client of clients) {
      const old = getClientMeta(scheduleMeta, client.id)
      newMeta[client.id] = {
        frequency: 'one-time',
        startDate: null,
        exceptions: [],
        blockedDays: old.blockedDays,
        duration: old.duration,
      }
    }
    // Silence unused-param lint — signature kept for callers that still pass
    // proposal context; the actual placement happens in Transition via
    // reanchorClient.
    void assignments; void recurrenceOverrides; void rotations; void intervalWeeksMap

    // Drop any manual placements dated on/after cutover (new schedule owns that range),
    // then merge in the frozen pre-cutover dates (skip any that already exist).
    setPlacements(prev => {
      const kept = prev.filter(p => p.date < cutoverIso)
      const keptKey = new Set(kept.map(p => `${p.clientId}|${p.date}`))
      const deduped = frozen.filter(f => !keptKey.has(`${f.clientId}|${f.date}`))
      return [...kept, ...deduped]
    })
    setScheduleMeta(newMeta)
    // Mirror onto client objects for guest-mode persistence.
    setClients(prev => prev.map(c => {
      const entry = newMeta[c.id]
      if (!entry) return c
      return {
        ...c,
        frequency: entry.frequency,
        intervalWeeks: entry.intervalWeeks,
        startDate: entry.startDate,
        exceptions: entry.exceptions,
      }
    }))
    return newApplyId
  }

  return (
    <StoreContext.Provider value={{
      clients, placements, loading, homeAddress, setHomeAddress, clearHomeAddress,
      addClient, removeClient, updateClient, updateClientCoords, updateClientColor, updateClientBlockedDays, updateClientScheduleMeta, getClientDuration, getClientPrice, bulkUpdateClientPrice,
      placeClient, placeClientRecurring, unplaceClient, unplaceClientFuture, unplaceClientAll, unplaceClientEverything, clearLocalScheduleState,
      getClientsForDate, getUnplacedClients, getAllDatesForClient, getBestDays, bulkReassignDays, applyNewScheduleFromBuilder, undoLastApply, lastApplySnapshotAt, lastApplyId, reanchorClient, unconfirmClient, refreshClients, jobs, refreshJobs, getJobsForDate, createJobFromPlacement, syncDeleteClientJobs, syncCancelOccurrence, syncEndRecurrence, syncMoveOccurrence, syncReanchor, syncCancelMonth, createTaskJob, createJob, updateJob, updateJobWithScope, updateRecurrenceFromDate, changeRecurrenceFrequency, deleteJob, materializeVirtualOccurrence, jobSyncError, clearJobSyncError,
      smartConfig, setSmartConfig,
      dayColors, setDayColor, resetDayColors,
      schedulePlan, createSchedulePlan, discardSchedulePlan, updateSchedulePlan, commitSchedulePlan,
    }}>
      {children}
    </StoreContext.Provider>
  )
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be inside StoreProvider')
  return ctx
}

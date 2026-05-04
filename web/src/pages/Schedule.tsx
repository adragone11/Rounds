import { useReducer, useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Frequency, DayOfWeek, Client } from '../types'
import { useStore } from '../store'
import { useToast } from '../lib/toast'
import { useLanguage } from '../lib/language'
import { useProfile } from '../lib/profile'
import ClientMap from '../components/ClientMap'
import OptimizeSidebar from '../components/OptimizeView'
import AddressAutocomplete from '../components/AddressAutocomplete'

import { DAY_ABBREV as DAYS } from '../theme'
import JobActionPanel from '../components/JobActionPanel'
import PipPlusGate from '../components/PipPlusGate'
import AddJobPanel, { emptyAddJobDraft, isAddJobDraftValid } from '../components/AddJobPanel'
import { SmartPlacementSuggestions } from '../components/SmartPlacementSuggestions'
import type { Job } from '../lib/jobs'
import {
  MONTHS,
  getDaysInMonth,
  getFirstDayOfMonth,
  dateKey,
  parseHHmm,
  fmtDuration,
  fmtHHmm,
} from '../lib/scheduleHelpers'

import { calendarReducer, clientFormReducer, uiReducer, loadPersistedCalendar, persistCalendar } from '../lib/scheduleReducers'
import { ClientCard, EditClientCard, GeocodePin } from '../components/ScheduleClientCard'
import { useRouteData } from '../hooks/useRouteData'
import { useAddJobOverlay } from '../hooks/useAddJobOverlay'
import { useScheduleDragDrop } from '../hooks/useScheduleDragDrop'
import { ScheduleConfirmModals } from '../components/ScheduleConfirmModals'
import { MonthView } from '../views/MonthView'
import { WeekView } from '../views/WeekView'
import { DayView } from '../views/DayView'

export default function Schedule() {
  const { t } = useLanguage()
  const today = new Date()

  const [cal, calDispatch] = useReducer(
    calendarReducer,
    today,
    loadPersistedCalendar,
  )

  const [form, formDispatch] = useReducer(clientFormReducer, {
    editingId: null,
    editName: '',
    editAddress: '',
    editCoords: null,
    editFrequency: 'weekly' as Frequency,
    editDuration: 60,
    editBlockedDays: [] as DayOfWeek[],
    editRate: '',
  })

  const [ui, uiDispatch] = useReducer(uiReducer, {
    dragOverDate: null,
    pendingDrop: null,
    pendingRemove: null,
    pendingMove: null,
    showOptimize: false,
    previewMoves: [],
    routeData: null,
    sidebarOpen: true,
    mapWidthPercent: 35,
    showHomeInput: false,
    homeInputValue: '',
    homeCoords: null,
    homeLoading: false,
    selectedClientId: null,
    showSmartSettings: false,
    previewBestDay: null,
    clientSearch: '',
  })

  // Job action panel + client-sidebar add-form mode (client | task).
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  // Deferred render target so we can animate the close. `selectedJob` drives
  // open/close; `displayJob` is what's actually rendered inside the panel and
  // lingers for one animation tick after close.
  const [displayJob, setDisplayJob] = useState<Job | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  // Remember whether sidebar was open before a job opened so we can restore
  // it on close. If the user had it closed already, leave it closed.
  const prevSidebarOpenRef = useRef<boolean | null>(null)

  useEffect(() => {
    if (selectedJob) {
      setDisplayJob(selectedJob)
      // Next tick so the slide-in transition actually runs from offset → 0.
      requestAnimationFrame(() => setPanelOpen(true))
    } else {
      setPanelOpen(false)
      const t = setTimeout(() => {
        // Unmount the panel slot AND restore the sidebar in the same React
        // batch so the layout swaps in a single commit — no double animation
        // where the sidebar pops in 260px while the panel is still visible.
        setDisplayJob(null)
        if (prevSidebarOpenRef.current !== null) {
          if (prevSidebarOpenRef.current) uiDispatch({ type: 'SET_SIDEBAR_OPEN', payload: true })
          prevSidebarOpenRef.current = null
        }
      }, 220)
      return () => clearTimeout(t)
    }
  }, [selectedJob])
  const closeJob = useCallback(() => setSelectedJob(null), [])
  // Click-to-toggle: tapping the same job that's already open closes the panel.
  // Keyed by a stable id + date combo because virtual template occurrences
  // share an id across dates.
  const toggleJob = useCallback((job: Job) => {
    setSelectedJob(prev => {
      if (!prev) return job
      if (prev.id === job.id && prev.date === job.date) return null
      return job
    })
  }, [])

  // Hide the sidebar the moment a job opens so the panel can dock in its slot.
  // Restoration is handled in the close timeout above so it lines up with the
  // panel actually unmounting.
  useEffect(() => {
    if (!selectedJob) return
    if (prevSidebarOpenRef.current === null) {
      prevSidebarOpenRef.current = ui.sidebarOpen
    }
    if (ui.sidebarOpen) uiDispatch({ type: 'SET_SIDEBAR_OPEN', payload: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob])

  // Destructure for convenience
  const { year, month, calendarView, focusDate, selectedDate } = cal

  // Persist calendar state for tab-eviction recovery (mobile browsers
  // reload the page on swipe-back). Cheap — single small object.
  useEffect(() => { persistCalendar(cal) }, [cal])
  const { editingId, editName, editAddress, editCoords, editFrequency, editDuration, editBlockedDays, editRate } = form
  const { dragOverDate, pendingDrop, pendingRemove, pendingMove, showOptimize, previewMoves, routeData, sidebarOpen, mapWidthPercent, showHomeInput, homeInputValue, homeCoords, homeLoading, selectedClientId, showSmartSettings, previewBestDay, clientSearch } = ui

  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const isDraggingDivider = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // ── Add Job overlay (left sidepanel form + click-day → day view → time
  // picker + drag-to-move/resize on the preview card). State, refs, and the
  // drag effect all live in the hook.
  const addJob = useAddJobOverlay()
  const {
    active: addJobActive,
    draft: addJobDraft,
    previewDate: addJobPreviewDate,
    start: addJobStart,
    end: addJobEnd,
    saving: addJobSaving,
    setDraft: setAddJobDraft,
    setStart: setAddJobStart,
    setEnd: setAddJobEnd,
    setPreviewDate: setAddJobPreviewDate,
    setSaving: setAddJobSaving,
    open: openAddJob,
    close: closeAddJob,
  } = addJob

  // Sidebar Unscheduled disclosure (collapsed by default — Scheduled is the
  // primary view; Unscheduled lives below as an expandable section).
  const [unscheduledOpen, setUnscheduledOpen] = useState(false)

  // Open Add Job mode when navigated here with ?action=addJob
  useEffect(() => {
    if (searchParams.get('action') === 'addJob') {
      openAddJob()
      // Clear the param so the sheet doesn't re-open on every render
      const next = new URLSearchParams(searchParams)
      next.delete('action')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const handleDividerMouseDown = useCallback(() => {
    isDraggingDivider.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingDivider.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const sidebarWidth = sidebarOpen ? 260 : 0 // w-[260px]
      const availableWidth = rect.width - sidebarWidth
      const mouseXInContainer = e.clientX - rect.left - sidebarWidth
      const mapPercent = Math.max(15, Math.min(70, ((availableWidth - mouseXInContainer) / availableWidth) * 100))
      uiDispatch({ type: 'SET_MAP_WIDTH_PERCENT', payload: mapPercent })
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
  }, [sidebarOpen])

  const store = useStore()
  const toast = useToast()
  const { profile } = useProfile()
  const isPlus = profile.isPlus
  const DAY_COLORS = store.dayColors

  // Open the Job Action panel when navigated here with ?jobId=...&date=...
  // Used by Dashboard's "Edit job" button to deep-link into a specific visit.
  // Virtual recurrences inherit the template's id, so we look up against the
  // expanded jobs for that date — not against store.jobs directly.
  useEffect(() => {
    const jobId = searchParams.get('jobId')
    const date = searchParams.get('date')
    if (!jobId) return
    if (date) {
      const d = new Date(date + 'T00:00:00')
      const expanded = store.getJobsForDate(date, d.getFullYear(), d.getMonth())
      const target = expanded.find(j => j.id === jobId) ?? expanded.find(j => j.templateId === jobId)
      if (target) {
        setSelectedJob(target)
        calDispatch({ type: 'SET_FOCUS_AND_DAY_VIEW', payload: d })
      }
    } else {
      const target = store.jobs.find(j => j.id === jobId)
      if (target) setSelectedJob(target)
    }
    const next = new URLSearchParams(searchParams)
    next.delete('jobId')
    next.delete('date')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, store.jobs])

  const daysInMonth = getDaysInMonth(year, month)
  const firstDay = getFirstDayOfMonth(year, month)
  const unplaced = store.getUnplacedClients(year, month)

  // Continuous month scroll — render a sliding window of months stacked
  // vertically (iOS-style) instead of one month + arrows. Window slides with
  // today: 3 months back for recent-history glance, 21 months forward for
  // planning. No deep history — owners don't plan against last year.
  const monthsList: { y: number; m: number }[] = []
  const todayYear = today.getFullYear()
  const todayMonth = today.getMonth()
  for (let offset = -3; offset <= 21; offset++) {
    const d = new Date(todayYear, todayMonth + offset, 1)
    monthsList.push({ y: d.getFullYear(), m: d.getMonth() })
  }
  const monthsScrollRef = useRef<HTMLDivElement | null>(null)
  const monthSectionRefs = useRef<Record<string, HTMLElement | null>>({})
  const initialScrollDoneRef = useRef(false)

  // On first render of month view, restore the user's last scroll position
  // if we have one (tab-eviction recovery). Otherwise scroll the current
  // month into view so the user lands on "today" instead of a year ago.
  useEffect(() => {
    if (calendarView !== 'month') { initialScrollDoneRef.current = false; return }
    if (initialScrollDoneRef.current) return
    const root = monthsScrollRef.current
    let restoredFromStorage = false
    try {
      const raw = localStorage.getItem('pip.scheduleScroll.v1')
      if (raw && root) {
        const top = Number(raw)
        if (Number.isFinite(top) && top > 0) {
          root.scrollTop = top
          restoredFromStorage = true
        }
      }
    } catch { /* noop */ }
    if (!restoredFromStorage) {
      const el = monthSectionRefs.current[`${year}-${month}`]
      if (el) el.scrollIntoView({ block: 'start' })
    }
    initialScrollDoneRef.current = true
  }, [calendarView, year, month])

  // Persist scroll position so swipe-away/back lands the user back where
  // they were. rAF-coalesced to avoid hammering localStorage on momentum.
  useEffect(() => {
    if (calendarView !== 'month') return
    const root = monthsScrollRef.current
    if (!root) return
    let pending = false
    const onScroll = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        try { localStorage.setItem('pip.scheduleScroll.v1', String(root.scrollTop)) } catch { /* noop */ }
      })
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [calendarView])

  // Track which month is most-visible so the header label and any per-month
  // computations (sidebar day-colors, suggestion ranks) follow the scroll.
  useEffect(() => {
    if (calendarView !== 'month') return
    const root = monthsScrollRef.current
    if (!root) return
    const observer = new IntersectionObserver(
      entries => {
        // Pick the entry with the largest intersection ratio that's at least
        // partly visible. Sticky-header behavior: which month dominates?
        let bestKey: string | null = null
        let bestRatio = 0
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio > bestRatio) {
            bestRatio = e.intersectionRatio
            bestKey = (e.target as HTMLElement).dataset.month ?? null
          }
        }
        if (!bestKey) return
        const [yStr, mStr] = bestKey.split('-')
        const y = Number(yStr); const m = Number(mStr)
        if (y !== year || m !== month) {
          calDispatch({ type: 'GO_TO_MONTH', payload: { year: y, month: m } })
        }
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    )
    for (const el of Object.values(monthSectionRefs.current)) {
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarView, monthsList.length])

  // Placed = has any non-deleted job (template or instance). Jobs are the
  // single source of truth — same data mobile reads. Web placements / meta
  // are optimistic UI state used to keep drag-drop instant, but they no
  // longer decide who's placed; that prevents the sidebar from drifting out
  // of sync with reality and producing ghost states.
  //
  // Day color is derived from the recurrence anchor (or the earliest job
  // date) so a client booked weekly on Mondays stays "Monday-colored"
  // regardless of which month is in view.
  // Heavy: builds four Set/Maps from every client × every job in view.
  // Memoized because it feeds ClientMap (MapKit) — without stable refs the
  // map repaints on every keystroke in AddJobPanel.
  const { placedClientIds, clientDayColorMap, clientDayMap, offMonthClientIds } = useMemo(() => {
    const placedClientIds = new Set<string>()
    const clientDayColorMap = new Map<string, string>()
    const clientDayMap = new Map<string, number>()
    const offMonthClientIds = new Set<string>()

    // Earliest anchor (template's recurrence_anchor_date, else job's date) per
    // client. Drives the weekday color when no occurrences fall in this month.
    const firstJobAnchorByClient = new Map<string, string>()
    for (const j of store.jobs) {
      if (!j.clientId || j.deleted) continue
      const anchor = j.recurrenceAnchorDate ?? j.date
      const existing = firstJobAnchorByClient.get(j.clientId)
      if (!existing || anchor < existing) firstJobAnchorByClient.set(j.clientId, anchor)
    }

    store.clients.forEach(client => {
      const anchor = firstJobAnchorByClient.get(client.id)
      if (!anchor) return  // unplaced — no jobs at all

      placedClientIds.add(client.id)

      const dates = store.getAllDatesForClient(client.id, year, month)
      let primaryDay: number
      if (dates.length > 0) {
        const counts = [0, 0, 0, 0, 0, 0, 0]
        dates.forEach(d => { counts[new Date(d + 'T00:00:00').getDay()]++ })
        primaryDay = counts.indexOf(Math.max(...counts))
      } else {
        primaryDay = new Date(anchor + 'T00:00:00').getDay()
        offMonthClientIds.add(client.id)
      }
      // Pin color = client's own avatar color (same paint as the job card on
      // mobile). Weekday color lives on calendar cells / sidebar chips where
      // the day signal matters; the map just shows "which client is this pin".
      clientDayColorMap.set(client.id, client.color)
      clientDayMap.set(client.id, primaryDay)
    })

    return { placedClientIds, clientDayColorMap, clientDayMap, offMonthClientIds }
    // store ref is rebuilt every render (context value isn't memoized), so we
    // intentionally depend on its underlying state arrays instead of `store`
    // itself — otherwise this heavy compute re-runs on every keystroke / click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.clients, store.jobs, year, month])

  // Map highlight ring — varies with selection + view. Memoized so the
  // ClientMap (MapKit) doesn't repaint annotations on every keystroke.
  const highlightedClientIds = useMemo<Set<string> | null>(() => {
    if (selectedClientId && previewBestDay) {
      const ids = new Set(store.getClientsForDate(previewBestDay).map(c => c.id))
      ids.add(selectedClientId)
      return ids
    }
    if (selectedDate) return new Set(store.getClientsForDate(selectedDate).map(c => c.id))
    if (selectedClientId) return null
    if (calendarView === 'day') {
      return new Set(store.getClientsForDate(dateKey(focusDate.getFullYear(), focusDate.getMonth(), focusDate.getDate())).map(c => c.id))
    }
    if (calendarView === 'week') {
      const weekStart = new Date(focusDate)
      weekStart.setDate(focusDate.getDate() - focusDate.getDay())
      const ids = new Set<string>()
      for (let i = 0; i < 7; i++) {
        const d = new Date(weekStart)
        d.setDate(weekStart.getDate() + i)
        store.getClientsForDate(dateKey(d.getFullYear(), d.getMonth(), d.getDate())).forEach(c => ids.add(c.id))
      }
      return ids
    }
    return null
    // store ref is rebuilt every render — depend on the actual data refs that
    // gate the result (jobs/placements) instead, so this doesn't recompute on
    // every render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, previewBestDay, selectedDate, calendarView, focusDate, store.jobs, store.placements])

  // Dates for the selected client (for calendar highlighting from map pin click)
  // Selected-client date highlighting spans every month in the scroll view
  // so amber rings keep working as the user scrolls past the current month.
  const selectedClientDates = selectedClientId
    ? new Set(monthsList.flatMap(({ y, m }) => store.getAllDatesForClient(selectedClientId, y, m)))
    : null
  const selectedClientName = selectedClientId
    ? store.clients.find(c => c.id === selectedClientId)?.name ?? null
    : null

  // Smart-placement suggestions — shown when the selected client is unplaced.
  // Computed once, shared by the sidebar panel and calendar date highlights.
  // While Add Job is active, the draft's clientId takes precedence so the
  // calendar lights up best days for the client being added, not the pin.
  const rankClientId = addJobActive && addJobDraft.clientId ? addJobDraft.clientId : selectedClientId
  const isRankClientUnplaced = rankClientId
    ? unplaced.some(u => u.id === rankClientId)
    : false
  const isSelectedUnplaced = selectedClientId
    ? unplaced.some(u => u.id === selectedClientId)
    : false
  // Gate: needs at least one OTHER placed client to produce useful suggestions.
  // With zero neighbors every day scores the same — the ranking is noise.
  const placedNeighborCount = store.clients.filter(
    c => c.id !== rankClientId && !unplaced.some(u => u.id === c.id),
  ).length
  // During Add Job, show suggestions even for already-placed clients — the
  // user is asking "where should this NEW job go?" so the rank client's
  // current placement is irrelevant. Outside Add Job, suggestions only make
  // sense for unplaced clients (otherwise we'd light up days for clients
  // already on the calendar).
  const bestDaysList = (rankClientId && (addJobActive || isRankClientUnplaced) && placedNeighborCount >= 1)
    ? store.getBestDays(rankClientId)
    : []
  // Map first-fit date → rank (1/2/3) so the month cells can render a ring.
  const suggestionDateRank = new Map<string, number>()
  for (const bd of bestDaysList) {
    if (bd.firstDate) suggestionDateRank.set(bd.firstDate, bd.rank)
  }

  const handlePinClick = useCallback((clientId: string) => {
    calDispatch({ type: 'SET_SELECTED_DATE', payload: null })
    if (!clientId) { uiDispatch({ type: 'SET_SELECTED_CLIENT_ID', payload: null }); return }
    uiDispatch({ type: 'TOGGLE_SELECTED_CLIENT_ID', payload: clientId })
  }, [])

  const confirmAddJobOnDate = async () => {
    if (!isAddJobDraftValid(addJobDraft) || addJobSaving || !addJobPreviewDate) return
    const startMin = parseHHmm(addJobStart)
    const endMin = parseHHmm(addJobEnd)
    if (startMin === null || endMin === null || endMin <= startMin) return
    setAddJobSaving(true)
    const priceNum = addJobDraft.price ? Number(addJobDraft.price) : 0
    const durationHours = (endMin - startMin) / 60
    const id = await store.createJob({
      title: addJobDraft.title.trim() || null,
      clientId: addJobDraft.clientId,
      date: addJobPreviewDate,
      startTime: addJobStart,
      duration: durationHours,
      price: Number.isFinite(priceNum) && priceNum >= 0 ? priceNum : 0,
      recurring: addJobDraft.recurring,
      notes: addJobDraft.notes.trim() || null,
      checklist: addJobDraft.checklist.length > 0 ? addJobDraft.checklist : null,
    })
    setAddJobSaving(false)
    if (id) {
      setAddJobDraft(emptyAddJobDraft)
      closeAddJob()
      calDispatch({ type: 'SET_CALENDAR_VIEW', payload: 'month' })
      toast('Job saved')
    }
  }

  const handleDateClick = (date: string) => {
    if (addJobActive) {
      if (!isAddJobDraftValid(addJobDraft)) return
      // Open the day view so the user can pick start/end on the timeline.
      setAddJobPreviewDate(date)
      setAddJobStart('09:00')
      setAddJobEnd('10:00')
      calDispatch({ type: 'SET_FOCUS_AND_DAY_VIEW', payload: new Date(date + 'T00:00:00') })
      return
    }
    uiDispatch({ type: 'SET_SELECTED_CLIENT_ID', payload: null }) // clear pin selection
    calDispatch({ type: 'TOGGLE_SELECTED_DATE', payload: date })
  }

  // Fetch driving route when a date is selected or in day view.
  const routeDate = selectedDate
    ?? (calendarView === 'day' ? dateKey(focusDate.getFullYear(), focusDate.getMonth(), focusDate.getDate()) : null)
  useRouteData(routeDate, store, payload => uiDispatch({ type: 'SET_ROUTE_DATA', payload }))

  const scrollToMonth = (y: number, m: number) => {
    const el = monthSectionRefs.current[`${y}-${m}`]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const prevMonth = () => {
    const d = new Date(year, month - 1, 1)
    if (calendarView === 'month') scrollToMonth(d.getFullYear(), d.getMonth())
    else calDispatch({ type: 'PREV_MONTH' })
  }
  const nextMonth = () => {
    const d = new Date(year, month + 1, 1)
    if (calendarView === 'month') scrollToMonth(d.getFullYear(), d.getMonth())
    else calDispatch({ type: 'NEXT_MONTH' })
  }
  const goToToday = () => {
    if (calendarView === 'month') scrollToMonth(today.getFullYear(), today.getMonth())
    else calDispatch({ type: 'GO_TO_TODAY', payload: today })
  }

  // Navigation for week/day views
  const navigatePrev = () => {
    if (calendarView === 'month') { prevMonth(); return }
    const d = new Date(focusDate)
    d.setDate(d.getDate() - (calendarView === 'week' ? 7 : 1))
    calDispatch({ type: 'NAVIGATE_FOCUS', payload: d })
  }
  const navigateNext = () => {
    if (calendarView === 'month') { nextMonth(); return }
    const d = new Date(focusDate)
    d.setDate(d.getDate() + (calendarView === 'week' ? 7 : 1))
    calDispatch({ type: 'NAVIGATE_FOCUS', payload: d })
  }

  // Get week dates for the focus date
  const getWeekDates = () => {
    const d = new Date(focusDate)
    const dayOfWeek = d.getDay()
    const sunday = new Date(d)
    sunday.setDate(d.getDate() - dayOfWeek)
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(sunday)
      date.setDate(sunday.getDate() + i)
      return date
    })
  }

  // Header title based on view
  const getHeaderTitle = () => {
    if (calendarView === 'month') return `${MONTHS[month]} ${year}`
    if (calendarView === 'week') {
      const weekDates = getWeekDates()
      const start = weekDates[0]
      const end = weekDates[6]
      if (start.getMonth() === end.getMonth()) {
        return `${MONTHS[start.getMonth()]} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`
      }
      return `${MONTHS[start.getMonth()]} ${start.getDate()} – ${MONTHS[end.getMonth()]} ${end.getDate()}`
    }
    return focusDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  }

  // Calendar grid
  const cells: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const {
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onSidebarDragOver,
    onSidebarDrop,
    confirmDrop,
    confirmRemove,
    confirmMove,
  } = useScheduleDragDrop(
    store,
    uiDispatch,
    { drop: pendingDrop, remove: pendingRemove, move: pendingMove },
    year,
    month,
  )

  // Latest-state ref for callbacks below — keeps their identity stable so
  // memoized children don't re-render when only unrelated state changes.
  const latestRef = useRef({
    store, editingId, editName, editAddress, editCoords,
    editFrequency, editDuration, editBlockedDays, editRate,
  })
  latestRef.current = {
    store, editingId, editName, editAddress, editCoords,
    editFrequency, editDuration, editBlockedDays, editRate,
  }

  const startEditing = useCallback((clientId: string) => {
    const s = latestRef.current.store
    const client = s.clients.find(c => c.id === clientId)
    if (!client) return
    formDispatch({
      type: 'START_EDITING',
      payload: {
        id: client.id,
        name: client.name,
        address: client.address,
        frequency: client.frequency ?? 'weekly',
        duration: s.getClientDuration(client.id),
        blockedDays: client.blockedDays ?? [],
        rate: s.getClientPrice(client.id),
      },
    })
  }, [])

  const saveEdit = useCallback(() => {
    const l = latestRef.current
    if (!l.editingId || !l.editName.trim()) return
    l.store.updateClient(l.editingId, l.editName.trim(), l.editAddress.trim(), l.editCoords)
    l.store.updateClientScheduleMeta(l.editingId, { frequency: l.editFrequency, duration: l.editDuration })
    l.store.updateClientBlockedDays(l.editingId, l.editBlockedDays)
    const rateNum = l.editRate.trim() ? Number(l.editRate) : 0
    void l.store.bulkUpdateClientPrice([l.editingId], Number.isFinite(rateNum) ? Math.max(0, rateNum) : 0)
    formDispatch({ type: 'CLEAR_EDITING' })
  }, [])

  const cancelEdit = useCallback(() => formDispatch({ type: 'CLEAR_EDITING' }), [])

  return (
    <div className="h-full flex flex-col bg-surface-page">
      {/* Header */}
      <div className="px-6 py-3.5 bg-white shrink-0 border-b border-edge-default">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex gap-1">
              <button
                onClick={navigatePrev}
                aria-label="Previous"
                className="w-8 h-8 rounded-[10px] border border-edge-default bg-white flex items-center justify-center text-ink-primary hover:bg-gray-50 transition-colors"
              >
                <svg className="w-[15px] h-[15px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              <button
                onClick={navigateNext}
                aria-label="Next"
                className="w-8 h-8 rounded-[10px] border border-edge-default bg-white flex items-center justify-center text-ink-primary hover:bg-gray-50 transition-colors"
              >
                <svg className="w-[15px] h-[15px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>
            <h2 className="text-[20px] font-bold text-ink-primary tracking-[-0.01em] m-0 min-w-[180px]">
              {getHeaderTitle()}
            </h2>
            <button
              onClick={goToToday}
              className="px-3 py-1.5 text-[13px] font-semibold text-ink-primary bg-white border border-edge-default rounded-[10px] hover:bg-gray-50 transition-colors"
            >
              {t('common.today')}
            </button>
            {store.schedulePlan && (
              <button
                onClick={() => navigate('/schedule-change')}
                className="px-3 py-1.5 text-[13px] font-bold rounded-[10px] text-orange-700 bg-orange-50 border border-orange-200 hover:bg-orange-100 transition-colors dark:text-orange-300 dark:bg-orange-500/15 dark:border-orange-400/30 dark:hover:bg-orange-500/25"
              >
                {t('schedule.scheduleChange')}
              </button>
            )}
          </div>

          {/* View toggle — middle of the header row, between the title
              cluster and the right-hand controls. justify-between on the
              parent gives this its centered slot. */}
          <div className="flex bg-surface-chip rounded-[10px] p-[3px]">
            {(['month', 'week', 'day'] as const).map(view => (
              <button
                key={view}
                onClick={() => calDispatch({ type: 'SET_CALENDAR_VIEW', payload: view })}
                className={`px-4 py-1.5 text-[13px] font-semibold rounded-[7px] transition-all ${
                  calendarView === view
                    ? 'bg-white text-ink-primary shadow-sm'
                    : 'text-ink-secondary hover:text-ink-primary'
                }`}
              >
                {view === 'month' ? t('calendar.viewMonth') : view === 'week' ? t('calendar.viewWeek') : t('calendar.viewDay')}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2.5">
            <div className="relative">
              <button
                onClick={() => uiDispatch({ type: 'SET_SHOW_SMART_SETTINGS', payload: !showSmartSettings })}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold rounded-[10px] transition-colors ${
                  showSmartSettings
                    ? 'bg-amber-50 text-amber-700 border border-amber-200'
                    : 'text-ink-primary bg-white border border-edge-default hover:bg-gray-50'
                }`}
                title={t('schedule.smartPlacementSettings')}
              >
                <svg className="w-[14px] h-[14px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {t('schedule.smart')}
              </button>
                    {showSmartSettings && (
                      <>
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => uiDispatch({ type: 'SET_SHOW_SMART_SETTINGS', payload: false })}
                        />
                        <div className="absolute right-0 top-full mt-1 z-20 w-64 p-3 bg-white rounded-lg border border-gray-200 shadow-lg space-y-2.5">
                          <div className="flex items-center justify-between">
                            <p className="text-[10px] font-bold text-gray-700 uppercase tracking-wider">{t('schedule.smartPlacement')}</p>
                            <button
                              onClick={() => uiDispatch({ type: 'SET_SHOW_SMART_SETTINGS', payload: false })}
                              className="text-gray-400 hover:text-gray-600"
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                          <PipPlusGate feature="smart-placement" layout="inline">
                          <label className="flex items-center justify-between gap-2 cursor-pointer select-none pb-2 border-b border-gray-100">
                            <div>
                              <p className="text-[11px] font-semibold text-gray-700">{t('schedule.suggestions')}</p>
                              <p className="text-[9px] text-gray-400">{t('schedule.suggestionsDesc')}</p>
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={store.smartConfig.enabled}
                              onClick={() => store.setSmartConfig({ ...store.smartConfig, enabled: !store.smartConfig.enabled })}
                              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                                store.smartConfig.enabled ? 'bg-amber-500' : 'bg-gray-300'
                              }`}
                            >
                              <span
                                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                                  store.smartConfig.enabled ? 'translate-x-5' : 'translate-x-1'
                                }`}
                              />
                            </button>
                          </label>
                          <div className={`space-y-2.5 ${store.smartConfig.enabled ? '' : 'opacity-40 pointer-events-none'}`}>
                            <div className="flex items-center justify-between gap-2">
                              <label className="text-[11px] text-gray-600">{t('schedule.maxJobsPerDay')}</label>
                              <input
                                type="number"
                                min={1}
                                max={20}
                                value={store.smartConfig.maxJobsPerDay}
                                onChange={e => store.setSmartConfig({ ...store.smartConfig, maxJobsPerDay: Math.max(1, Number(e.target.value) || 1) })}
                                className="w-16 px-2 py-1 text-xs border border-gray-200 rounded"
                              />
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <label className="text-[11px] text-gray-600">{t('editProfile.schedule.workingHours')}</label>
                              <div className="flex items-center gap-1">
                                <input
                                  type="time"
                                  value={store.smartConfig.workingStart}
                                  onChange={e => store.setSmartConfig({ ...store.smartConfig, workingStart: e.target.value || '08:00' })}
                                  className="px-1.5 py-1 text-xs border border-gray-200 rounded"
                                />
                                <span className="text-[11px] text-gray-400">–</span>
                                <input
                                  type="time"
                                  value={store.smartConfig.workingEnd}
                                  onChange={e => store.setSmartConfig({ ...store.smartConfig, workingEnd: e.target.value || '17:00' })}
                                  className="px-1.5 py-1 text-xs border border-gray-200 rounded"
                                />
                              </div>
                            </div>
                            <div>
                              <p className="text-[11px] text-gray-600 mb-1">{t('editProfile.schedule.workingDays')}</p>
                              <div className="flex gap-1">
                                {DAYS.map((d, i) => {
                                  const on = store.smartConfig.workingDays[i]
                                  return (
                                    <button
                                      key={d}
                                      type="button"
                                      onClick={() => {
                                        const next = [...store.smartConfig.workingDays]
                                        next[i] = !next[i]
                                        store.setSmartConfig({ ...store.smartConfig, workingDays: next })
                                      }}
                                      className="flex-1 py-1 text-[10px] font-bold rounded border transition-all"
                                      style={on ? {
                                        backgroundColor: DAY_COLORS[i],
                                        color: '#fff',
                                        borderColor: DAY_COLORS[i],
                                      } : {
                                        backgroundColor: '#fff',
                                        color: '#9CA3AF',
                                        borderColor: '#E5E7EB',
                                      }}
                                    >{d.charAt(0)}</button>
                                  )
                                })}
                              </div>
                            </div>
                          </div>
                          </PipPlusGate>
                        </div>
                      </>
                    )}
                  </div>

            <button
              onClick={() => navigate('/schedule/builder')}
              className="px-3 py-1.5 text-[10px] font-bold text-white rounded-lg transition-all shadow-sm flex items-center gap-1.5"
              style={{ backgroundColor: '#4A7CFF' }}
              title={undefined}
            >
              {t('scheduleBuilder.title')}
            </button>
          </div>
        </div>

      </div>

      {/* Body: sidebar + calendar + map */}
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        {/* Optimize sidebar (replaces client list when active) */}
        {showOptimize && sidebarOpen && (
          <OptimizeSidebar
            clients={store.clients}
            clientDayMap={clientDayMap}
            onClose={() => uiDispatch({ type: 'CLOSE_OPTIMIZE' })}
            onPreviewMoves={(moves) => uiDispatch({ type: 'SET_PREVIEW_MOVES', payload: moves })}
            onApplyMove={(clientId, newDay) => {
              // Find the next occurrence of newDay from today
              const today = new Date()
              const todayDay = today.getDay()
              const daysUntil = (newDay - todayDay + 7) % 7 || 7
              const startDate = new Date(today)
              startDate.setDate(today.getDate() + daysUntil)
              const dateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`
              store.placeClientRecurring(clientId, dateStr, 'weekly')
            }}
            homeAddress={store.homeAddress}
          />
        )}

        {/* Job action panel — docks in the sidebar's slot, map stays visible.
            Slot width is fixed at 320 while a job is selected; the inner panel
            slides via transform+opacity so the map and calendar don't relayout
            on every frame of the open/close animation. */}
        {displayJob && (
          <div className="shrink-0 overflow-hidden" style={{ width: 320 }}>
            <div
              className={`h-full transition-[transform,opacity] duration-200 ease-out ${
                panelOpen ? 'translate-x-0 opacity-100' : '-translate-x-3 opacity-0'
              }`}
            >
              <JobActionPanel job={displayJob} onClose={closeJob} />
            </div>
          </div>
        )}

        {/* Sidebar toggle (visible when closed and no job panel) */}
        {!sidebarOpen && !showOptimize && !selectedJob && (
          <button
            onClick={() => uiDispatch({ type: 'SET_SIDEBAR_OPEN', payload: true })}
            className="w-8 shrink-0 border-r border-gray-200/60 flex items-center justify-center hover:bg-white/50 transition-colors"
            title={t('schedule.showClients')}
          >
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        )}

        {/* Add Job sidepanel — replaces client sidebar while active */}
        {addJobActive && !showOptimize && (
          <AddJobPanel
            draft={addJobDraft}
            onChange={setAddJobDraft}
            onClose={closeAddJob}
            isPlus={isPlus}
            bestDays={bestDaysList}
            placedNeighborCount={placedNeighborCount}
            previewBestDay={previewBestDay}
            onTogglePreview={d => uiDispatch({ type: 'SET_PREVIEW_BEST_DAY', payload: d })}
            onPickDay={d => {
              uiDispatch({ type: 'SET_PREVIEW_BEST_DAY', payload: null })
              handleDateClick(d)
            }}
          />
        )}

        {/* Client sidebar */}
        {sidebarOpen && !showOptimize && !addJobActive && (
        <div
          className="w-[260px] border-r border-edge-default flex flex-col shrink-0 bg-white"
          onDragOver={onSidebarDragOver}
          onDrop={onSidebarDrop}
        >
          {/* Home address */}
          <div className="p-2.5 border-b border-gray-200">
            {store.homeAddress && !showHomeInput ? (
              <div className="flex items-center gap-2 group">
                <svg className="w-3.5 h-3.5 text-gray-500 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3L4 9v12h5v-7h6v7h5V9l-8-6z"/></svg>
                <GeocodePin address={store.homeAddress.address} lat={store.homeAddress.lat} lng={store.homeAddress.lng} />
                <p className="text-[10px] text-gray-500 truncate flex-1">{store.homeAddress.address}</p>
                <button onClick={() => uiDispatch({ type: 'OPEN_HOME_EDIT', payload: store.homeAddress!.address })} className="text-[10px] text-gray-400 hover:text-gray-600 opacity-0 group-hover:opacity-100">{t('common.edit')}</button>
              </div>
            ) : showHomeInput ? (
              <div className="space-y-1.5">
                <AddressAutocomplete
                  autoFocus
                  value={homeInputValue}
                  onChange={v => uiDispatch({ type: 'SET_HOME_INPUT_AND_CLEAR_COORDS', payload: v })}
                  onSelect={r => uiDispatch({ type: 'SET_HOME_INPUT_WITH_COORDS', payload: { value: r.address, coords: { lat: r.lat, lng: r.lng } } })}
                  onKeyDown={async e => {
                    if (e.key === 'Enter' && homeInputValue.trim()) {
                      uiDispatch({ type: 'SET_HOME_LOADING', payload: true })
                      await store.setHomeAddress(homeInputValue.trim(), homeCoords ?? undefined)
                      uiDispatch({ type: 'FINISH_HOME_SET' })
                    }
                    if (e.key === 'Escape') uiDispatch({ type: 'SET_SHOW_HOME_INPUT', payload: false })
                  }}
                  placeholder={t('schedule.yourStartingAddress')}
                  className="w-full px-2.5 py-1.5 text-[11px] border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/20"
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={async () => {
                      if (!homeInputValue.trim()) return
                      uiDispatch({ type: 'SET_HOME_LOADING', payload: true })
                      await store.setHomeAddress(homeInputValue.trim(), homeCoords ?? undefined)
                      uiDispatch({ type: 'FINISH_HOME_SET' })
                    }}
                    disabled={homeLoading || !homeInputValue.trim()}
                    className="flex-1 px-2 py-1 text-[10px] font-medium text-white bg-gray-900 rounded-md hover:bg-gray-800 disabled:opacity-40"
                  >
                    {homeLoading ? t('schedule.settingEllipsis') : t('schedule.set')}
                  </button>
                  <button onClick={() => uiDispatch({ type: 'SET_SHOW_HOME_INPUT', payload: false })} className="px-2 py-1 text-[10px] text-gray-500">{t('common.cancel')}</button>
                  {store.homeAddress && (
                    <button onClick={() => { store.clearHomeAddress(); uiDispatch({ type: 'CLEAR_HOME_AND_CLOSE_INPUT' }) }} className="px-2 py-1 text-[10px] text-red-400">{t('common.remove')}</button>
                  )}
                </div>
              </div>
            ) : (
              <button
                onClick={() => uiDispatch({ type: 'SET_SHOW_HOME_INPUT', payload: true })}
                className="flex items-center gap-2 text-[10px] text-gray-400 hover:text-gray-600 transition-colors w-full"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3L4 9v12h5v-7h6v7h5V9l-8-6z"/></svg>
                {t('schedule.setStartingAddress')}
              </button>
            )}
          </div>

          {/* Primary "Add Job" CTA */}
          <div className="px-3 pt-3">
            <button
              type="button"
              onClick={openAddJob}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-[10px] px-3 py-2.5 text-[13px] font-semibold text-white shadow-sm transition-colors"
              style={{ background: '#3B82F6' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#2563EB')}
              onMouseLeave={e => (e.currentTarget.style.background = '#3B82F6')}
              title="Add a new job"
            >
              <svg className="w-[14px] h-[14px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add job
            </button>
          </div>

          <div className="px-4 pt-4 pb-3 border-b border-edge-default">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[11px] font-semibold text-ink-tertiary uppercase tracking-[0.07em]">
                Scheduled
              </h2>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => uiDispatch({ type: 'SET_SIDEBAR_OPEN', payload: false })}
                  className="w-6 h-6 flex items-center justify-center rounded-lg bg-surface-chip hover:bg-gray-200 text-ink-tertiary hover:text-ink-primary transition-colors"
                  title={t('schedule.hideClients')}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 6l-6 6 6 6" />
                  </svg>
                </button>
              </div>
            </div>
            <p className="text-xs text-ink-tertiary">
              {(() => {
                const placedCount = store.clients.length - unplaced.length
                if (store.clients.length === 0) return t('schedule.addClientsToStart')
                if (placedCount === 0) return 'No clients scheduled yet'
                return `${placedCount} ${placedCount === 1 ? 'client' : 'clients'} on the calendar`
              })()}
            </p>
            {store.clients.length > 0 && (
              <div className="mt-3 bg-surface-chip rounded-[10px] px-3 py-2 flex items-center gap-2">
                <svg className="w-[14px] h-[14px] text-ink-tertiary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4-4" />
                </svg>
                <input
                  type="text"
                  value={clientSearch}
                  onChange={e => uiDispatch({ type: 'SET_CLIENT_SEARCH', payload: e.target.value })}
                  placeholder={t('clients.searchPlaceholder')}
                  className="flex-1 bg-transparent text-[13px] text-ink-primary placeholder:text-ink-tertiary outline-none min-w-0"
                />
                {clientSearch && (
                  <button
                    onClick={() => uiDispatch({ type: 'SET_CLIENT_SEARCH', payload: '' })}
                    className="w-4 h-4 flex items-center justify-center rounded-full text-ink-tertiary hover:text-ink-primary hover:bg-gray-200 transition-colors shrink-0"
                    title={t('schedule.clearSearch')}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Best days suggestion panel — only for unplaced selected
              clients in the Place flow. Add Job has its own copy of this
              panel inside AddJobPanel (see SmartPlacementSuggestions),
              since this sidebar is unmounted during Add Job. */}
          {false && selectedClientId && isSelectedUnplaced && !isPlus && (
            <div className="p-2.5 border-b border-gray-200">
              <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold text-gray-900">{t('schedule.smartPlacement') || 'Smart Placement'}</p>
                  </div>
                </div>
              </div>
            </div>
          )}
          {false && selectedClientId && isSelectedUnplaced && isPlus && (() => {
            const client = store.clients.find(c => c.id === selectedClientId)
            if (!client) return null
            const placeOnDate = (freq: Frequency, date: string) => {
              store.placeClientRecurring(selectedClientId, date, freq === 'one-time' ? 'one-time' : freq)
              const d = new Date(date + 'T00:00:00')
              calDispatch({ type: 'NAVIGATE_FOCUS', payload: d })
              uiDispatch({ type: 'SET_SELECTED_CLIENT_ID', payload: null })
            }
            return (
              <div className="p-2.5 border-b border-gray-200 bg-amber-50/50">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-semibold text-gray-700 uppercase tracking-wider">Smart placement · {client.name}</p>
                  <button onClick={() => uiDispatch({ type: 'SET_SELECTED_CLIENT_ID', payload: null })} className="text-gray-400 hover:text-gray-600">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                <SmartPlacementSuggestions
                  bestDays={bestDaysList}
                  hasCoords={!!client.lat && !!client.lng}
                  placedNeighborCount={placedNeighborCount}
                  previewBestDay={previewBestDay}
                  onTogglePreview={d => uiDispatch({ type: 'SET_PREVIEW_BEST_DAY', payload: d })}
                  onPick={d => {
                    uiDispatch({ type: 'SET_PREVIEW_BEST_DAY', payload: null })
                    placeOnDate(client.frequency ?? 'weekly', d)
                  }}
                />
              </div>
            )
          })()}


          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {(() => {
              const q = clientSearch.trim().toLowerCase()
              const matches = (c: Client) =>
                !q ||
                c.name.toLowerCase().includes(q) ||
                (c.address ?? '').toLowerCase().includes(q)
              const filteredUnplaced = unplaced.filter(matches)
              const filteredPlaced = store.clients
                .filter(c => !unplaced.find(u => u.id === c.id))
                .filter(matches)
              if (q && filteredUnplaced.length === 0 && filteredPlaced.length === 0) {
                return <p className="text-[11px] text-gray-400 px-2 py-3 text-center">No clients match "{clientSearch}"</p>
              }
              return <>
            {/* Scheduled (placed) — primary list. Empty state shows a hint
                pointing the user to the Unscheduled section below. */}
            {filteredPlaced.length === 0 && !q && (
              <div className="px-2 py-6 text-center">
                <p className="text-[12px] text-ink-tertiary">No clients scheduled yet</p>
                {filteredUnplaced.length > 0 && (
                  <p className="text-[11px] text-ink-tertiary/80 mt-1">
                    Drag from <span className="font-semibold">Unscheduled</span> below to add to the calendar
                  </p>
                )}
              </div>
            )}
            {filteredPlaced.map(client => (
                editingId === client.id ? (
                  <EditClientCard
                    key={client.id}
                    color={client.color}
                    name={editName}
                    address={editAddress}
                    frequency={editFrequency}
                    duration={editDuration}
                    blockedDays={editBlockedDays}
                    rate={editRate}
                    isPlus={isPlus}
                    onNameChange={v => formDispatch({ type: 'SET_EDIT_NAME', payload: v })}
                    onAddressChange={v => formDispatch({ type: 'SET_EDIT_ADDRESS_AND_CLEAR_COORDS', payload: v })}
                    onAddressSelect={r => formDispatch({ type: 'SET_EDIT_ADDRESS_WITH_COORDS', payload: { address: r.address, coords: { lat: r.lat, lng: r.lng } } })}
                    onFrequencyChange={f => formDispatch({ type: 'SET_EDIT_FREQUENCY', payload: f })}
                    onDurationChange={d => formDispatch({ type: 'SET_EDIT_DURATION', payload: d })}
                    onRateChange={v => formDispatch({ type: 'SET_EDIT_RATE', payload: v })}
                    onToggleBlockedDay={d => formDispatch({ type: 'TOGGLE_EDIT_BLOCKED_DAY', payload: d })}
                    onColorChange={hex => store.updateClientColor(client.id, hex)}
                    onSave={saveEdit}
                    onCancel={cancelEdit}
                    onDelete={() => { store.removeClient(client.id); formDispatch({ type: 'CLEAR_EDITING' }) }}
                  />
                ) : (
                  <ClientCard
                    key={client.id}
                    client={client}
                    dimmed={false}
                    selected={selectedClientId === client.id}
                    pinColor={clientDayColorMap.get(client.id) ?? client.color}
                    placed
                    onEdit={startEditing}
                    onClick={handlePinClick}
                  />
                )
              ))}

            {/* Unscheduled — collapsible section below the main list. Auto-expands
                when search is active so matching unplaced clients are visible. */}
            {filteredUnplaced.length > 0 && (() => {
              const expanded = unscheduledOpen || !!q
              return (
                <>
                  <button
                    type="button"
                    onClick={() => setUnscheduledOpen(o => !o)}
                    className="mt-2 w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-surface-chip transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      <svg
                        className={`w-3 h-3 text-ink-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"
                      >
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                      <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Unscheduled</span>
                    </span>
                    <span className="text-[10px] font-semibold text-ink-tertiary bg-surface-chip rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                      {filteredUnplaced.length}
                    </span>
                  </button>
                  {expanded && filteredUnplaced.map(client => (
                    editingId === client.id ? (
                      <EditClientCard
                        key={client.id}
                        color={client.color}
                        name={editName}
                        address={editAddress}
                        frequency={editFrequency}
                        duration={editDuration}
                        blockedDays={editBlockedDays}
                        rate={editRate}
                        isPlus={isPlus}
                        onNameChange={v => formDispatch({ type: 'SET_EDIT_NAME', payload: v })}
                        onAddressChange={v => formDispatch({ type: 'SET_EDIT_ADDRESS_AND_CLEAR_COORDS', payload: v })}
                        onAddressSelect={r => formDispatch({ type: 'SET_EDIT_ADDRESS_WITH_COORDS', payload: { address: r.address, coords: { lat: r.lat, lng: r.lng } } })}
                        onFrequencyChange={f => formDispatch({ type: 'SET_EDIT_FREQUENCY', payload: f })}
                        onDurationChange={d => formDispatch({ type: 'SET_EDIT_DURATION', payload: d })}
                        onRateChange={v => formDispatch({ type: 'SET_EDIT_RATE', payload: v })}
                        onToggleBlockedDay={d => formDispatch({ type: 'TOGGLE_EDIT_BLOCKED_DAY', payload: d })}
                        onColorChange={hex => store.updateClientColor(client.id, hex)}
                        onSave={saveEdit}
                        onCancel={cancelEdit}
                        onDelete={() => { store.removeClient(client.id); formDispatch({ type: 'CLEAR_EDITING' }) }}
                      />
                    ) : (
                      <ClientCard
                        key={client.id}
                        client={client}
                        dimmed
                        selected={selectedClientId === client.id}
                        draggable
                        onDragStart={onDragStart}
                        onEdit={startEditing}
                        onClick={handlePinClick}
                      />
                    )
                  ))}
                </>
              )
            })()}
              </>
            })()}
          </div>
        </div>
        )}

        {/* Calendar views */}
        <div className="flex flex-col overflow-auto min-w-0 bg-surface-page" style={{ flex: `${100 - mapWidthPercent} 0 0%` }}>

          {/* Add Job banner — collapses time-picking controls into the top
              strip while previewing a day, so the preview card on the
              timeline is never covered. */}
          {addJobActive && (() => {
            const sMin = parseHHmm(addJobStart)
            const eMin = parseHHmm(addJobEnd)
            const validTimes = sMin !== null && eMin !== null && eMin > sMin
            return (
              <div className="px-4 pt-3 shrink-0">
                <div className="flex items-center gap-2.5 px-3.5 py-2 bg-blue-50 border border-blue-100 rounded-[10px]">
                  <svg className="w-4 h-4 text-blue-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="5" width="18" height="16" rx="2" />
                    <path d="M3 9h18M8 3v4M16 3v4" />
                  </svg>
                  {addJobPreviewDate && isAddJobDraftValid(addJobDraft) ? (
                    <>
                      <input
                        type="time"
                        value={addJobStart}
                        step={300}
                        onChange={e => {
                          const v = e.target.value || '09:00'
                          setAddJobStart(v)
                          const ns = parseHHmm(v), ne = parseHHmm(addJobEnd)
                          if (ns !== null && ne !== null && ne <= ns) {
                            setAddJobEnd(fmtHHmm(Math.min(23 * 60 + 45, ns + 60)))
                          }
                        }}
                        className="px-2 py-1 text-[12px] font-semibold text-blue-700 bg-white rounded-md focus:outline-none focus:ring-2 focus:ring-blue-300"
                      />
                      <svg className="w-3.5 h-3.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                      <input
                        type="time"
                        value={addJobEnd}
                        step={300}
                        onChange={e => setAddJobEnd(e.target.value || '10:00')}
                        className="px-2 py-1 text-[12px] font-semibold text-blue-700 bg-white rounded-md focus:outline-none focus:ring-2 focus:ring-blue-300"
                      />
                      {validTimes && (
                        <span className="text-[11px] font-semibold text-blue-700/80">
                          {fmtDuration(eMin! - sMin!)}
                        </span>
                      )}
                      <div className="flex-1" />
                      <button
                        onClick={() => setAddJobPreviewDate(null)}
                        title="Pick a different day"
                        className="whitespace-nowrap text-[12px] font-semibold text-blue-700 hover:text-blue-900 transition-colors"
                      >
                        Change day
                      </button>
                      <button
                        onClick={() => void confirmAddJobOnDate()}
                        disabled={!validTimes || addJobSaving}
                        className="whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1 text-[12px] font-semibold text-white rounded-full transition-colors disabled:opacity-40"
                        style={{ background: '#3B82F6' }}
                      >
                        {addJobSaving ? 'Saving…' : 'Save Job'}
                      </button>
                      <button
                        onClick={closeAddJob}
                        className="whitespace-nowrap text-[12px] font-semibold text-blue-700/70 hover:text-blue-900 transition-colors"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-[13px] text-blue-800 flex-1">
                        {!isAddJobDraftValid(addJobDraft)
                          ? 'Add a title or pick a client, then choose a day'
                          : 'Pick a day on the calendar to schedule this job'}
                      </p>
                      <button
                        onClick={closeAddJob}
                        className="text-[13px] font-semibold text-blue-700 hover:text-blue-900 transition-colors"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })()}

          {/* ── MONTH VIEW (continuous scroll) ── */}
          {calendarView === 'month' && (
            <MonthView
              monthsList={monthsList}
              monthsScrollRef={monthsScrollRef}
              monthSectionRefs={monthSectionRefs}
              store={store}
              today={today}
              selectedDate={addJobActive ? addJobPreviewDate : selectedDate}
              selectedClientDates={selectedClientDates ?? new Set()}
              dragOverDate={dragOverDate}
              suggestionDateRank={suggestionDateRank}
              previewMoves={previewMoves}
              dayColors={DAY_COLORS}
              onDayClick={handleDateClick}
              onDayViewClick={(date) => calDispatch({ type: 'SET_FOCUS_AND_DAY_VIEW', payload: new Date(date + 'T00:00:00') })}
              onChipDragStart={onDragStart}
              onCellDragOver={onDragOver}
              onCellDragLeave={onDragLeave}
              onCellDrop={onDrop}
              toggleJob={toggleJob}
            />
          )}

          {/* ── WEEK VIEW ── */}
          {calendarView === 'week' && (
            <WeekView
              focusDate={focusDate}
              today={today}
              store={store}
              selectedDate={selectedDate}
              dragOverDate={dragOverDate}
              onDateClick={handleDateClick}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              toggleJob={toggleJob}
            />
          )}

          {/* ── DAY VIEW ── */}
          {calendarView === 'day' && (
            <DayView
              focusDate={focusDate}
              today={today}
              store={store}
              dragOverDate={dragOverDate}
              dayColors={DAY_COLORS}
              addJob={addJob}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              toggleJob={toggleJob}
            />
          )}
        </div>

        {/* Resize divider */}
        <div
          className="w-1.5 shrink-0 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors"
          onMouseDown={handleDividerMouseDown}
        />

        {/* Map */}
        <div className="shrink-0" style={{ width: `${mapWidthPercent}%` }}>
          <ClientMap
            clients={store.clients}
            placedClientIds={placedClientIds}
            clientDayColorMap={clientDayColorMap}
            offMonthClientIds={offMonthClientIds}
            dayColors={DAY_COLORS}
            emphasizedClientId={selectedClientId && !selectedDate ? selectedClientId : null}
            highlightedClientIds={highlightedClientIds}
            selectedDateLabel={
              selectedDate ? `${DAYS[new Date(selectedDate + 'T00:00:00').getDay()]} ${new Date(selectedDate + 'T00:00:00').getDate()}`
              : calendarView === 'day' && !selectedClientId
                ? `${DAYS[focusDate.getDay()]} ${focusDate.getDate()}`
              : calendarView === 'week' && !selectedClientId
                ? (() => {
                    const weekStart = new Date(focusDate)
                    weekStart.setDate(focusDate.getDate() - focusDate.getDay())
                    return `${DAYS[weekStart.getDay()]} ${weekStart.getDate()} – ${DAYS[(weekStart.getDay() + 6) % 7]} ${new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6).getDate()}`
                  })()
              : selectedClientName
            }
            onPinClick={handlePinClick}
            homeAddress={store.homeAddress}
            singleClientSelected={!!selectedClientId && !selectedDate}
            previewMoves={previewMoves}
            route={routeData}
          />
        </div>
      </div>

      <ScheduleConfirmModals
        clients={store.clients}
        pendingDrop={pendingDrop}
        pendingRemove={pendingRemove}
        pendingMove={pendingMove}
        onCancelDrop={() => uiDispatch({ type: 'SET_PENDING_DROP', payload: null })}
        onCancelRemove={() => uiDispatch({ type: 'SET_PENDING_REMOVE', payload: null })}
        onCancelMove={() => uiDispatch({ type: 'SET_PENDING_MOVE', payload: null })}
        onConfirmDrop={confirmDrop}
        onConfirmRemove={confirmRemove}
        onConfirmMove={confirmMove}
      />

    </div>
  )
}


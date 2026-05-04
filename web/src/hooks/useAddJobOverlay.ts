import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { emptyAddJobDraft } from '../components/AddJobPanel'
import type { AddJobDraft } from '../components/AddJobPanel'
import {
  DAY_VIEW_START_HOUR,
  DAY_VIEW_END_HOUR,
  DAY_VIEW_HOUR_PX,
  fmtHHmm,
  parseHHmm,
} from '../lib/scheduleHelpers'

export type AddJobResizeMode = null | 'top' | 'bottom' | 'move'

export type AddJobOverlay = {
  // State
  active: boolean
  draft: AddJobDraft
  previewDate: string | null
  start: string
  end: string
  saving: boolean
  resizing: AddJobResizeMode

  // Refs
  dayTimelineRef: RefObject<HTMLDivElement | null>

  // Setters / actions (kept narrow — submission lives in the page because
  // it depends on the store API).
  setDraft: (next: AddJobDraft) => void
  setStart: (v: string) => void
  setEnd: (v: string) => void
  setPreviewDate: (date: string | null) => void
  setSaving: (v: boolean) => void

  // Helpers
  /** Pixel Y on the day timeline → snapped HH:mm (15-min grid). Clamped to the
   *  visible window so a click outside the grid can't push the card off-screen. */
  yToHHmm: (clientY: number) => string | null
  /** Begin a body-drag (the 'move' mode). Records the cursor offset so the
   *  grab-point stays pinned to the cursor for the rest of the drag. */
  beginMoveDrag: (cursorMin: number) => void
  /** Begin a top/bottom edge resize. */
  beginResize: (mode: 'top' | 'bottom') => void

  // Lifecycle
  open: () => void
  close: () => void
}

/**
 * Persisted slice of the overlay state. Mobile browsers (DuckDuckGo,
 * Safari, Chrome on iOS) evict tab processes when the user swipes away
 * from a fullscreen tab — coming back triggers a full reload. Without
 * persistence, a half-filled Add Job form is lost. We mirror just the
 * user-meaningful fields (draft + preview window), not ephemeral drag
 * state. Versioned so a schema bump invalidates stale drafts cleanly.
 */
type PersistedOverlay = {
  v: 1
  active: boolean
  draft: AddJobDraft
  previewDate: string | null
  start: string
  end: string
}
const PERSIST_KEY = 'pip.addJobOverlay.v1'

function loadPersisted(): PersistedOverlay | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedOverlay
    if (parsed?.v !== 1) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Owns all Add-Job overlay state — the form draft, the time being previewed,
 * the resize/move drag mode + cursor handling. The page wires this into the
 * left-rail AddJobPanel, the top blue banner, and the day-view preview card.
 *
 * Drag listeners bind once per drag (deps reduced to `resizing`) and read
 * live start/end via refs — re-binding mid-drag was previously dropping
 * mousemove events and resetting times.
 *
 * State persists to localStorage so a tab eviction (mobile browser swipe-away
 * → swipe-back, which forces a full reload) doesn't blow away an in-progress
 * draft. Cleared on save / close.
 */
export function useAddJobOverlay(): AddJobOverlay {
  const persisted = loadPersisted()
  const [active, setActive] = useState(persisted?.active ?? false)
  const [draft, setDraft] = useState<AddJobDraft>(persisted?.draft ?? emptyAddJobDraft)
  const [previewDate, setPreviewDate] = useState<string | null>(persisted?.previewDate ?? null)
  const [start, setStart] = useState<string>(persisted?.start ?? '09:00')
  const [end, setEnd] = useState<string>(persisted?.end ?? '10:00')
  const [saving, setSaving] = useState(false)
  const [resizing, setResizing] = useState<AddJobResizeMode>(null)

  // Mirror the persisted slice on every change. Cheap (single small object,
  // localStorage is sync but tiny here), and we want fresh state on the next
  // mount even if the eviction lands mid-drag.
  useEffect(() => {
    try {
      if (!active) {
        localStorage.removeItem(PERSIST_KEY)
        return
      }
      const payload: PersistedOverlay = { v: 1, active, draft, previewDate, start, end }
      localStorage.setItem(PERSIST_KEY, JSON.stringify(payload))
    } catch {
      // Quota / private mode — silent. Persistence is best-effort.
    }
  }, [active, draft, previewDate, start, end])

  const moveOffsetRef = useRef(0)
  const dayTimelineRef = useRef<HTMLDivElement | null>(null)
  const startRef = useRef(start)
  const endRef = useRef(end)
  useEffect(() => { startRef.current = start }, [start])
  useEffect(() => { endRef.current = end }, [end])

  const yToHHmm = useCallback((clientY: number): string | null => {
    const rect = dayTimelineRef.current?.getBoundingClientRect()
    if (!rect) return null
    const y = clientY - rect.top
    const totalMin = DAY_VIEW_START_HOUR * 60 + (y / DAY_VIEW_HOUR_PX) * 60
    const snapped = Math.round(totalMin / 15) * 15
    const clamped = Math.max(DAY_VIEW_START_HOUR * 60, Math.min(DAY_VIEW_END_HOUR * 60 + 45, snapped))
    return fmtHHmm(clamped)
  }, [])

  // Drag-resize / drag-move the preview card.
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const t = yToHHmm(e.clientY)
      if (!t) return
      const tMin = parseHHmm(t)!
      if (resizing === 'top') {
        const endMin = parseHHmm(endRef.current) ?? tMin + 60
        setStart(fmtHHmm(Math.min(tMin, endMin - 15)))
      } else if (resizing === 'bottom') {
        const startMin = parseHHmm(startRef.current) ?? tMin - 60
        setEnd(fmtHHmm(Math.max(tMin, startMin + 15)))
      } else {
        // 'move' — preserve duration, pin grab-point to the cursor.
        const sCur = parseHHmm(startRef.current) ?? 9 * 60
        const eCur = parseHHmm(endRef.current) ?? 10 * 60
        const dur = Math.max(15, eCur - sCur)
        const dayMin = DAY_VIEW_START_HOUR * 60
        const dayMax = DAY_VIEW_END_HOUR * 60 + 45
        const desiredStart = tMin - moveOffsetRef.current
        const clampedStart = Math.max(dayMin, Math.min(dayMax - dur, desiredStart))
        const snapped = Math.round(clampedStart / 15) * 15
        setStart(fmtHHmm(snapped))
        setEnd(fmtHHmm(snapped + dur))
      }
    }
    // Defer clearing so the synthetic click that fires right after mouseup
    // still sees resizing !== null. The day-grid click handler uses that
    // flag to bail; without the defer, a drag-then-click would reset times.
    const onUp = () => { setTimeout(() => setResizing(null), 0) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    // Lock cursor + suppress text selection while dragging — kills body-shake.
    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
    }
  }, [resizing, yToHHmm])

  const beginMoveDrag = useCallback((cursorMin: number) => {
    const sMin = parseHHmm(startRef.current) ?? cursorMin
    moveOffsetRef.current = cursorMin - sMin
    setResizing('move')
  }, [])

  const beginResize = useCallback((mode: 'top' | 'bottom') => {
    setResizing(mode)
  }, [])

  const open = useCallback(() => {
    setActive(true)
    setDraft(emptyAddJobDraft)
    setPreviewDate(null)
  }, [])

  const close = useCallback(() => {
    setActive(false)
    setPreviewDate(null)
    setDraft(emptyAddJobDraft)
    setStart('09:00')
    setEnd('10:00')
    try { localStorage.removeItem(PERSIST_KEY) } catch { /* noop */ }
  }, [])

  return {
    active, draft, previewDate, start, end, saving, resizing,
    dayTimelineRef,
    setDraft, setStart, setEnd, setPreviewDate, setSaving,
    yToHHmm, beginMoveDrag, beginResize,
    open, close,
  }
}

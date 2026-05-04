/**
 * Reducers for the Schedule page — split out so the page itself isn't carrying
 * 200+ lines of action plumbing. Pure functions, no React or store dependencies.
 */

import type { ProposedMove, Frequency, DayOfWeek } from '../types'

// ── Calendar Reducer ──
export type CalendarState = {
  year: number
  month: number
  calendarView: 'month' | 'week' | 'day'
  focusDate: Date
  selectedDate: string | null
}

// Persistence — mobile browsers (DuckDuckGo, Safari, Chrome on iOS)
// evict tab processes on swipe-away and force a full reload on swipe-back.
// We mirror enough Schedule state to localStorage so the user lands back
// roughly where they were instead of bounced to today's month.
type PersistedCalendar = {
  v: 1
  year: number
  month: number
  calendarView: 'month' | 'week' | 'day'
  focusDate: string  // ISO yyyy-mm-dd; Date isn't JSON-safe
  selectedDate: string | null
}
const CALENDAR_KEY = 'pip.scheduleCalendar.v1'
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function loadPersistedCalendar(fallback: Date): CalendarState {
  try {
    const raw = localStorage.getItem(CALENDAR_KEY)
    if (raw) {
      const p = JSON.parse(raw) as PersistedCalendar
      if (p?.v === 1 && p.calendarView && p.focusDate) {
        const focusDate = new Date(p.focusDate + 'T00:00:00')
        if (!Number.isNaN(focusDate.getTime())) {
          return {
            year: p.year,
            month: p.month,
            calendarView: p.calendarView,
            focusDate,
            selectedDate: p.selectedDate ?? null,
          }
        }
      }
    }
  } catch { /* corrupt entry — fall through */ }
  return {
    year: fallback.getFullYear(),
    month: fallback.getMonth(),
    calendarView: 'month',
    focusDate: fallback,
    selectedDate: null,
  }
}
export function persistCalendar(state: CalendarState): void {
  try {
    const payload: PersistedCalendar = {
      v: 1,
      year: state.year,
      month: state.month,
      calendarView: state.calendarView,
      focusDate: isoDate(state.focusDate),
      selectedDate: state.selectedDate,
    }
    localStorage.setItem(CALENDAR_KEY, JSON.stringify(payload))
  } catch { /* quota / private mode — best-effort */ }
}

export type CalendarAction =
  | { type: 'SET_CALENDAR_VIEW'; payload: 'month' | 'week' | 'day' }
  | { type: 'SET_SELECTED_DATE'; payload: string | null }
  | { type: 'TOGGLE_SELECTED_DATE'; payload: string }
  | { type: 'GO_TO_TODAY'; payload: Date }
  | { type: 'GO_TO_MONTH'; payload: { year: number; month: number } }
  | { type: 'PREV_MONTH' }
  | { type: 'NEXT_MONTH' }
  | { type: 'SET_FOCUS_AND_DAY_VIEW'; payload: Date }
  | { type: 'NAVIGATE_FOCUS'; payload: Date }

export function calendarReducer(state: CalendarState, action: CalendarAction): CalendarState {
  switch (action.type) {
    case 'SET_CALENDAR_VIEW':
      return { ...state, calendarView: action.payload }
    case 'SET_SELECTED_DATE':
      return { ...state, selectedDate: action.payload }
    case 'TOGGLE_SELECTED_DATE':
      return { ...state, selectedDate: state.selectedDate === action.payload ? null : action.payload }
    case 'GO_TO_TODAY':
      return { ...state, year: action.payload.getFullYear(), month: action.payload.getMonth(), focusDate: action.payload }
    case 'GO_TO_MONTH':
      return { ...state, year: action.payload.year, month: action.payload.month }
    case 'PREV_MONTH':
      if (state.month === 0) return { ...state, month: 11, year: state.year - 1 }
      return { ...state, month: state.month - 1 }
    case 'NEXT_MONTH':
      if (state.month === 11) return { ...state, month: 0, year: state.year + 1 }
      return { ...state, month: state.month + 1 }
    case 'SET_FOCUS_AND_DAY_VIEW':
      return { ...state, focusDate: action.payload, calendarView: 'day' }
    case 'NAVIGATE_FOCUS':
      return { ...state, focusDate: action.payload, year: action.payload.getFullYear(), month: action.payload.getMonth() }
  }
}

// ── Client Form Reducer ──
export type Coords = { lat: number; lng: number }

export type ClientFormState = {
  editingId: string | null
  editName: string
  editAddress: string
  editCoords: Coords | null
  editFrequency: Frequency
  editDuration: number
  editBlockedDays: DayOfWeek[]
  editRate: string
}

export type ClientFormAction =
  | { type: 'START_EDITING'; payload: { id: string; name: string; address: string; frequency: Frequency; duration: number; blockedDays: DayOfWeek[]; rate: number } }
  | { type: 'SET_EDIT_NAME'; payload: string }
  | { type: 'SET_EDIT_ADDRESS_AND_CLEAR_COORDS'; payload: string }
  | { type: 'SET_EDIT_ADDRESS_WITH_COORDS'; payload: { address: string; coords: Coords } }
  | { type: 'SET_EDIT_FREQUENCY'; payload: Frequency }
  | { type: 'SET_EDIT_DURATION'; payload: number }
  | { type: 'SET_EDIT_RATE'; payload: string }
  | { type: 'TOGGLE_EDIT_BLOCKED_DAY'; payload: DayOfWeek }
  | { type: 'CLEAR_EDITING' }

export function clientFormReducer(state: ClientFormState, action: ClientFormAction): ClientFormState {
  switch (action.type) {
    case 'START_EDITING':
      return {
        ...state,
        editingId: action.payload.id,
        editName: action.payload.name,
        editAddress: action.payload.address,
        editCoords: null,
        editFrequency: action.payload.frequency,
        editDuration: action.payload.duration,
        editBlockedDays: action.payload.blockedDays,
        editRate: action.payload.rate > 0 ? String(action.payload.rate) : '',
      }
    case 'SET_EDIT_NAME':
      return { ...state, editName: action.payload }
    case 'SET_EDIT_ADDRESS_AND_CLEAR_COORDS':
      return { ...state, editAddress: action.payload, editCoords: null }
    case 'SET_EDIT_ADDRESS_WITH_COORDS':
      return { ...state, editAddress: action.payload.address, editCoords: action.payload.coords }
    case 'SET_EDIT_FREQUENCY':
      return { ...state, editFrequency: action.payload }
    case 'SET_EDIT_DURATION':
      return { ...state, editDuration: action.payload }
    case 'SET_EDIT_RATE':
      return { ...state, editRate: action.payload }
    case 'TOGGLE_EDIT_BLOCKED_DAY': {
      const blocked = state.editBlockedDays
      const next = blocked.includes(action.payload)
        ? blocked.filter(d => d !== action.payload)
        : [...blocked, action.payload]
      return { ...state, editBlockedDays: next }
    }
    case 'CLEAR_EDITING':
      return { ...state, editingId: null }
  }
}

// ── UI Reducer ──
export type RouteData = {
  coordinates: Array<{ lat: number; lng: number }>
  durationMinutes: number | null
  distanceMiles: number | null
  color: string
}

export type UIState = {
  dragOverDate: string | null
  pendingDrop: { clientId: string; date: string } | null
  pendingRemove: { clientId: string; date: string } | null
  pendingMove: { clientId: string; sourceDate: string; targetDate: string } | null
  showOptimize: boolean
  previewMoves: ProposedMove[]
  routeData: RouteData | null
  sidebarOpen: boolean
  mapWidthPercent: number
  showHomeInput: boolean
  homeInputValue: string
  homeCoords: Coords | null
  homeLoading: boolean
  selectedClientId: string | null
  showSmartSettings: boolean
  /** firstDate of the Smart Placement suggestion being previewed on the map. */
  previewBestDay: string | null
  clientSearch: string
}

export type UIAction =
  | { type: 'SET_DRAG_OVER_DATE'; payload: string | null }
  | { type: 'SET_PENDING_DROP'; payload: { clientId: string; date: string } | null }
  | { type: 'SET_PENDING_REMOVE'; payload: { clientId: string; date: string } | null }
  | { type: 'SET_PENDING_MOVE'; payload: { clientId: string; sourceDate: string; targetDate: string } | null }
  | { type: 'SET_SHOW_OPTIMIZE'; payload: boolean }
  | { type: 'SET_PREVIEW_MOVES'; payload: ProposedMove[] }
  | { type: 'CLOSE_OPTIMIZE' }
  | { type: 'SET_ROUTE_DATA'; payload: RouteData | null }
  | { type: 'SET_SIDEBAR_OPEN'; payload: boolean }
  | { type: 'SET_MAP_WIDTH_PERCENT'; payload: number }
  | { type: 'SET_SHOW_HOME_INPUT'; payload: boolean }
  | { type: 'SET_HOME_INPUT_AND_CLEAR_COORDS'; payload: string }
  | { type: 'SET_HOME_INPUT_WITH_COORDS'; payload: { value: string; coords: Coords } }
  | { type: 'SET_HOME_LOADING'; payload: boolean }
  | { type: 'FINISH_HOME_SET' }
  | { type: 'SET_SELECTED_CLIENT_ID'; payload: string | null }
  | { type: 'TOGGLE_SELECTED_CLIENT_ID'; payload: string }
  | { type: 'OPEN_HOME_EDIT'; payload: string }
  | { type: 'CLEAR_HOME_AND_CLOSE_INPUT' }
  | { type: 'SET_SHOW_SMART_SETTINGS'; payload: boolean }
  | { type: 'SET_PREVIEW_BEST_DAY'; payload: string | null }
  | { type: 'SET_CLIENT_SEARCH'; payload: string }

export function uiReducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case 'SET_DRAG_OVER_DATE':
      return { ...state, dragOverDate: action.payload }
    case 'SET_PENDING_DROP':
      return { ...state, pendingDrop: action.payload }
    case 'SET_PENDING_REMOVE':
      return { ...state, pendingRemove: action.payload }
    case 'SET_PENDING_MOVE':
      return { ...state, pendingMove: action.payload }
    case 'SET_SHOW_OPTIMIZE':
      return { ...state, showOptimize: action.payload }
    case 'SET_PREVIEW_MOVES':
      return { ...state, previewMoves: action.payload }
    case 'CLOSE_OPTIMIZE':
      return { ...state, showOptimize: false, previewMoves: [] }
    case 'SET_ROUTE_DATA':
      return { ...state, routeData: action.payload }
    case 'SET_SIDEBAR_OPEN':
      return { ...state, sidebarOpen: action.payload }
    case 'SET_MAP_WIDTH_PERCENT':
      return { ...state, mapWidthPercent: action.payload }
    case 'SET_SHOW_HOME_INPUT':
      return { ...state, showHomeInput: action.payload }
    case 'SET_HOME_INPUT_AND_CLEAR_COORDS':
      return { ...state, homeInputValue: action.payload, homeCoords: null }
    case 'SET_HOME_INPUT_WITH_COORDS':
      return { ...state, homeInputValue: action.payload.value, homeCoords: action.payload.coords }
    case 'SET_HOME_LOADING':
      return { ...state, homeLoading: action.payload }
    case 'FINISH_HOME_SET':
      return { ...state, homeLoading: false, showHomeInput: false }
    case 'SET_SELECTED_CLIENT_ID':
      return { ...state, selectedClientId: action.payload, previewBestDay: null }
    case 'TOGGLE_SELECTED_CLIENT_ID':
      return {
        ...state,
        selectedClientId: state.selectedClientId === action.payload ? null : action.payload,
        previewBestDay: null,
      }
    case 'OPEN_HOME_EDIT':
      return { ...state, showHomeInput: true, homeInputValue: action.payload }
    case 'CLEAR_HOME_AND_CLOSE_INPUT':
      return { ...state, showHomeInput: false }
    case 'SET_SHOW_SMART_SETTINGS':
      return { ...state, showSmartSettings: action.payload }
    case 'SET_PREVIEW_BEST_DAY':
      return { ...state, previewBestDay: action.payload }
    case 'SET_CLIENT_SEARCH':
      return { ...state, clientSearch: action.payload }
  }
}

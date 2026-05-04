# Schedule Builder — Full-Screen Two-Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PerfectScheduleModal overlay with a dedicated full-screen `/schedule/builder` route featuring a map + time-grid side-by-side layout with drag-and-drop manual placement of overflow clients.

**Architecture:** New route renders a `ScheduleBuilder` page. Left panel reuses `ClientMap`. Right panel is a new `WeekTimeGrid` (time-axis day columns with [Wk 1-4] tabs). Unplaced clients live in an overflow tray below the grid. Config/recurrence setup stays as a lightweight entry step on the same page. Compare toggles (schedule + map) let users diff against current.

**Tech Stack:** React + TypeScript, Vite, Tailwind CSS v4, Apple MapKit JS (via existing `ClientMap`), existing VROOM engine (`generatePerfectSchedule` in `optimizer.ts`), react-router-dom.

---

## Phase 1: Route + Layout Shell

Wire up the new route with a static two-panel layout. No engine, no data — just the skeleton with placeholder panels. This proves the layout works before we add complexity.

### Task 1: Add `/schedule/builder` route

**Files:**
- Create: `web/src/pages/ScheduleBuilder.tsx`
- Modify: `web/src/App.tsx:119-123`

- [ ] **Step 1: Create the ScheduleBuilder page shell**

```tsx
// web/src/pages/ScheduleBuilder.tsx
import { useNavigate } from 'react-router-dom'

const DAY_COLORS = ['#F97316', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4']

export default function ScheduleBuilder() {
  const navigate = useNavigate()

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-200 bg-white shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/schedule')}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Back to Schedule
          </button>
          <h1 className="text-base font-bold text-gray-900">Schedule Builder</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">Placed 0/0</span>
        </div>
      </div>

      {/* Two-panel body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Map panel */}
        <div className="flex-1 bg-gray-100 flex items-center justify-center">
          <p className="text-sm text-gray-400">Map panel</p>
        </div>

        {/* Divider */}
        <div className="w-1 bg-gray-200 cursor-col-resize hover:bg-gray-300 transition-colors" />

        {/* Schedule panel */}
        <div className="flex-1 bg-white flex flex-col">
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-gray-400">Schedule panel</p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-gray-200 bg-white shrink-0 flex items-center justify-between">
        <button className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
          Compare to Current
        </button>
        <button className="px-5 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 transition-colors">
          Apply to Schedule
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add the route to App.tsx**

In `web/src/App.tsx`, add the import and route:

```tsx
// Add import at top (after Login import, line 8):
import ScheduleBuilder from './pages/ScheduleBuilder'

// Add route inside <Routes> (after line 121):
<Route path="/schedule/builder" element={<ScheduleBuilder />} />
```

- [ ] **Step 3: Verify the route renders**

Run: `cd web && npm run dev`

Navigate to `http://localhost:5173/schedule/builder`. You should see:
- Header with "Back to Schedule" + "Schedule Builder" title
- Two equal panels with placeholder text
- Footer with "Compare to Current" and "Apply to Schedule"
- "Back to Schedule" navigates to `/schedule`

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx web/src/App.tsx
git commit -m "feat: add /schedule/builder route with layout shell"
```

---

### Task 2: Wire the "Perfect Schedule" button to navigate to builder

**Files:**
- Modify: `web/src/pages/Schedule.tsx:50,452`

- [ ] **Step 1: Replace the modal toggle with navigation**

In `web/src/pages/Schedule.tsx`:

Replace the `showPerfectModal` state usage. Change the "Perfect Schedule" button (around line 452) from `onClick={() => setShowPerfectModal(true)}` to navigation:

```tsx
// Add at top of Schedule component (after other hooks, around line 32):
const navigate = useNavigate()
```

Add the import — `useNavigate` from `react-router-dom` (it's not currently imported).

Change the button around line 452:
```tsx
<button
  onClick={() => navigate('/schedule/builder')}
  className="px-3 py-1 text-[11px] font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 transition-colors"
>
  Perfect Schedule
</button>
```

Note: Keep the existing `PerfectScheduleModal` import and usage intact for now — we'll remove it in a later phase once the builder is fully working.

- [ ] **Step 2: Verify navigation works**

Click "Perfect Schedule" on `/schedule` — it should navigate to `/schedule/builder`.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/Schedule.tsx
git commit -m "feat: wire Perfect Schedule button to /schedule/builder route"
```

---

## Phase 2: Config + Engine Integration

Bring the config/recurrence setup onto the builder page and wire up the VROOM engine. After this phase, the engine runs and we have result data — but still placeholder panels.

### Task 3: Inline config/recurrence setup on ScheduleBuilder

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

The config and recurrence steps from `PerfectScheduleModal` become an inline "setup" state on the builder page. When the page loads, it shows the setup form. After the user clicks "Build", the engine runs and the two-panel view appears.

- [ ] **Step 1: Add setup state and form**

Refactor `ScheduleBuilder.tsx` to have two modes: `setup` and `results`. Port the config/recurrence UI from `PerfectScheduleModal.tsx` (lines 238-586).

The key state to add:

```tsx
import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { generatePerfectSchedule } from '../optimizer'
import type { PerfectScheduleResult } from '../optimizer'
import type { Client } from '../types'
import AddressAutocomplete from '../components/AddressAutocomplete'

type Frequency = 'weekly' | 'biweekly' | 'monthly'
type BuilderStep = 'setup' | 'results'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_COLORS = ['#F97316', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4']

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
```

The component renders a centered card (like the old modal, but not overlaying anything) when `step === 'setup'`. It has the same config fields: home address, max jobs, working days, client selection, recurrence settings.

When "Build Perfect Schedule" is clicked, it calls `generatePerfectSchedule()` exactly like `PerfectScheduleModal.runPerfectSchedule()` (lines 152-188), stores the result in state, and switches to `step === 'results'`.

Port the setup UI from `PerfectScheduleModal` lines 238-586 into the setup view. Keep the two sub-steps (config → recurrence) as tabs or sequential sections within the setup card. The key fields:
- `maxJobsPerDay` (stepper, default 5)
- `workingDays` (7 toggle buttons)
- `startDate` (date picker)
- `selectedIds` (client checkboxes)
- `recurrenceMap` (per-client frequency)
- `durationMap` (per-client duration)
- Home address (with `AddressAutocomplete`)

- [ ] **Step 2: Wire the engine call**

When user clicks "Build Perfect Schedule", run:

```tsx
const runEngine = async () => {
  const home = homeCoords ?? (store.homeAddress ? { lat: store.homeAddress.lat, lng: store.homeAddress.lng } : null)
  if (!home) return

  if (homeInputValue && homeCoords && !store.homeAddress) {
    await store.setHomeAddress(homeInputValue, homeCoords)
  }

  const clientsWithDays = selectedClients.map(c => ({
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
```

Where `clientDayMap` is computed the same way as Schedule.tsx lines 106-120:

```tsx
const clientDayMap = useMemo(() => {
  const map = new Map<string, number>()
  const today = new Date()
  const year = today.getFullYear()
  const month = today.getMonth()
  store.clients.forEach(client => {
    const dates = store.getAllDatesForClient(client.id, year, month)
    if (dates.length > 0) {
      const counts = [0, 0, 0, 0, 0, 0, 0]
      dates.forEach(d => { counts[new Date(d + 'T00:00:00').getDay()]++ })
      map.set(client.id, counts.indexOf(Math.max(...counts)))
    }
  })
  return map
}, [store.clients])
```

- [ ] **Step 3: Show "results" state with placeholder panels + stats header**

When `step === 'results'` and `result` exists, render:
- The two-panel layout from Task 1
- Stats in the header: `Placed {assigned}/{total}` and `{currentDrive}m → {optimizedDrive}m/wk saved`
- Still placeholder content in map and schedule panels

```tsx
{step === 'results' && result && (
  <div className="h-full flex flex-col">
    {/* Header with stats */}
    <div className="px-5 py-3 border-b border-gray-200 bg-white shrink-0 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/schedule')} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Back
        </button>
        <h1 className="text-base font-bold text-gray-900">Schedule Builder</h1>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-700">
            Placed {result.assignments.size}/{selectedIds.size}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-400">{result.currentDriveMinutes}m</span>
          <span className="text-gray-300">→</span>
          <span className="font-semibold text-green-600">{result.totalDriveMinutes}m/wk</span>
          <span className="text-xs text-green-500">
            ({Math.max(0, result.currentDriveMinutes - result.totalDriveMinutes)}m saved)
          </span>
        </div>
      </div>
    </div>

    {/* Two-panel body */}
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 bg-gray-100 flex items-center justify-center">
        <p className="text-sm text-gray-400">Map — {result.assignments.size} clients assigned</p>
      </div>
      <div className="w-1 bg-gray-200 cursor-col-resize" />
      <div className="flex-1 bg-white flex items-center justify-center">
        <p className="text-sm text-gray-400">Schedule grid — {result.grid.size} cells</p>
      </div>
    </div>

    {/* Footer */}
    <div className="px-5 py-3 border-t border-gray-200 bg-white shrink-0 flex items-center justify-between">
      <button onClick={() => setStep('setup')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
        ← Re-configure
      </button>
      <button className="px-5 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 transition-colors">
        Apply to Schedule →
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 4: Verify the full setup → engine → results flow**

1. Navigate to `/schedule/builder`
2. Set home address, select clients, configure recurrence
3. Click "Build Perfect Schedule" — should show loading, then switch to results view
4. Header shows stats (placed count, drive time savings)
5. "Re-configure" goes back to setup

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx
git commit -m "feat: add config/recurrence setup and engine integration to builder"
```

---

## Phase 3: Map Panel

Wire the existing `ClientMap` into the left panel with day-colored placed pins and gray unplaced pins.

### Task 4: Render ClientMap with builder data

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

- [ ] **Step 1: Build pin data from engine result and render ClientMap**

Import `ClientMap` and compute the props it needs from `PerfectScheduleResult`:

```tsx
import ClientMap from '../components/ClientMap'
```

Derive the map data from the result:

```tsx
// Inside the results view, compute map props from engine result:
const builderClients = useMemo(() => {
  if (!result) return []
  return store.clients.filter(c => selectedIds.has(c.id) && c.lat !== null && c.lng !== null)
}, [result, store.clients, selectedIds])

const builderPlacedIds = useMemo(() => {
  if (!result) return new Set<string>()
  return new Set(result.assignments.keys())
}, [result])

const builderDayColorMap = useMemo(() => {
  if (!result) return new Map<string, string>()
  const map = new Map<string, string>()
  for (const [clientId, day] of result.assignments) {
    map.set(clientId, DAY_COLORS[day])
  }
  return map
}, [result])
```

Replace the map placeholder with:

```tsx
<div className="flex-1 relative">
  <ClientMap
    clients={builderClients}
    placedClientIds={builderPlacedIds}
    clientDayColorMap={builderDayColorMap}
    highlightedClientIds={highlightedClientIds}
    selectedDateLabel={selectedDayLabel}
    onPinClick={handlePinClick}
    homeAddress={store.homeAddress ? { lat: store.homeAddress.lat, lng: store.homeAddress.lng } : null}
  />
</div>
```

Add state for selection:

```tsx
const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
const [selectedDay, setSelectedDay] = useState<number | null>(null)

const highlightedClientIds = useMemo(() => {
  if (selectedDay !== null && result) {
    // Highlight all clients on the selected day
    const ids = new Set<string>()
    for (const [clientId, day] of result.assignments) {
      if (day === selectedDay) ids.add(clientId)
    }
    return ids
  }
  if (selectedClientId) return new Set([selectedClientId])
  return null
}, [selectedDay, selectedClientId, result])

const selectedDayLabel = selectedDay !== null ? DAYS[selectedDay] : null

const handlePinClick = (clientId: string) => {
  setSelectedDay(null)
  if (!clientId) { setSelectedClientId(null); return }
  setSelectedClientId(prev => prev === clientId ? null : clientId)
}
```

- [ ] **Step 2: Verify map renders with colored pins**

1. Run the engine
2. Map should show day-colored pins for placed clients
3. Click a pin — it highlights
4. Unplaced clients (if any overflow) show as gray

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx
git commit -m "feat: wire ClientMap into schedule builder with day-colored pins"
```

---

## Phase 4: WeekTimeGrid Component

The core new UI — a time-axis week view with [Wk 1-4] tabs. Each week shows day columns with client blocks stacked by route order.

### Task 5: Create WeekTimeGrid component

**Files:**
- Create: `web/src/components/WeekTimeGrid.tsx`

- [ ] **Step 1: Build the component**

```tsx
// web/src/components/WeekTimeGrid.tsx
import { useState, useMemo } from 'react'
import type { GridCell } from '../types'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_COLORS = ['#F97316', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4']

interface WeekTimeGridProps {
  /** 4-week grid: key = "week-day" (e.g. "0-1" = week 0, Monday) */
  grid: Map<string, GridCell[]>
  /** Which days are active (e.g. [1,2,3,4,5] for Mon-Fri) */
  activeDays: number[]
  /** Duration per client in minutes (for block height) */
  durationMap: Map<string, number>
  /** Day start time in minutes from midnight (default 480 = 8:00 AM) */
  dayStartMinutes?: number
  /** Day end time in minutes from midnight (default 1020 = 5:00 PM) */
  dayEndMinutes?: number
  /** Max jobs per day (for column header badge) */
  maxJobsPerDay: number
  /** Currently selected client ID (for highlight) */
  selectedClientId: string | null
  /** Callback when a client block is clicked */
  onClientClick?: (clientId: string) => void
  /** Callback when a day column header is clicked */
  onDayClick?: (dayIndex: number) => void
  /** Currently selected/highlighted day */
  selectedDay: number | null
}

export default function WeekTimeGrid({
  grid,
  activeDays,
  durationMap,
  dayStartMinutes = 480,
  dayEndMinutes = 1020,
  maxJobsPerDay,
  selectedClientId,
  onClientClick,
  onDayClick,
  selectedDay,
}: WeekTimeGridProps) {
  const [activeWeek, setActiveWeek] = useState(0)

  const totalMinutes = dayEndMinutes - dayStartMinutes
  const pixelsPerMinute = 1.5 // 90px per hour

  // Hours for the time axis labels
  const hours = useMemo(() => {
    const h: number[] = []
    const startHour = Math.floor(dayStartMinutes / 60)
    const endHour = Math.ceil(dayEndMinutes / 60)
    for (let i = startHour; i <= endHour; i++) h.push(i)
    return h
  }, [dayStartMinutes, dayEndMinutes])

  const hourLabel = (h: number) => h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`

  // Get clients for this week on a given day
  const getWeekDayCells = (day: number): GridCell[] => {
    const key = `${activeWeek}-${day}`
    return (grid.get(key) || []).sort((a, b) => a.routeOrder - b.routeOrder)
  }

  // Compute block positions: stack clients by route order, each gets durationMinutes height
  const deriveBlocks = (cells: GridCell[]) => {
    let currentMinutes = 0
    return cells.map(cell => {
      const duration = durationMap.get(cell.clientId) ?? 60
      const top = currentMinutes * pixelsPerMinute
      const height = duration * pixelsPerMinute
      currentMinutes += duration
      const overflows = (dayStartMinutes + currentMinutes) > dayEndMinutes
      return { ...cell, top, height, startMinutes: dayStartMinutes + currentMinutes - duration, duration, overflows }
    })
  }

  // Count clients per week (for tab badges)
  const weekCounts = useMemo(() => {
    return [0, 1, 2, 3].map(week => {
      let count = 0
      for (const day of activeDays) {
        const key = `${week}-${day}`
        count += (grid.get(key) || []).length
      }
      return count
    })
  }, [grid, activeDays])

  // Mini density bar: jobs per day per week (for the 4-week summary)
  const weekDayCounts = useMemo(() => {
    return [0, 1, 2, 3].map(week =>
      activeDays.map(day => (grid.get(`${week}-${day}`) || []).length)
    )
  }, [grid, activeDays])

  return (
    <div className="flex flex-col h-full">
      {/* 4-week mini summary bar */}
      <div className="px-3 pt-3 pb-1 shrink-0">
        <div className="flex gap-1 text-[9px] text-gray-400 font-medium">
          {activeDays.map((day, i) => (
            <span key={day} className="flex-1 text-center" style={{ color: DAY_COLORS[day] }}>
              {DAYS[day][0]}
            </span>
          ))}
        </div>
        <div className="flex gap-1 mt-0.5">
          {[0, 1, 2, 3].map(week => (
            <button
              key={week}
              onClick={() => setActiveWeek(week)}
              className={`flex-1 flex gap-px rounded overflow-hidden transition-all ${
                activeWeek === week ? 'ring-2 ring-purple-400 ring-offset-1' : 'opacity-50 hover:opacity-75'
              }`}
            >
              {weekDayCounts[week].map((count, di) => (
                <div
                  key={di}
                  className="flex-1 h-3 rounded-sm flex items-center justify-center"
                  style={{
                    backgroundColor: count > 0 ? DAY_COLORS[activeDays[di]] + '30' : '#F3F4F6',
                  }}
                >
                  <span className="text-[7px] font-bold" style={{ color: count > 0 ? DAY_COLORS[activeDays[di]] : '#D1D5DB' }}>
                    {count || ''}
                  </span>
                </div>
              ))}
            </button>
          ))}
        </div>
      </div>

      {/* Week tabs */}
      <div className="flex items-center gap-1.5 px-3 py-2 shrink-0">
        {[0, 1, 2, 3].map(week => (
          <button
            key={week}
            onClick={() => setActiveWeek(week)}
            className={`px-3 py-1 text-xs font-semibold rounded-full transition-colors ${
              activeWeek === week
                ? 'bg-purple-600 text-white'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            Wk {week + 1}
            <span className={`ml-1 text-[10px] ${activeWeek === week ? 'text-purple-200' : 'text-gray-400'}`}>
              {weekCounts[week]}
            </span>
          </button>
        ))}
      </div>

      {/* Day column headers */}
      <div className="flex shrink-0 border-b border-gray-200" style={{ paddingLeft: '48px' }}>
        {activeDays.map(day => {
          const cells = getWeekDayCells(day)
          const isSelected = selectedDay === day
          return (
            <button
              key={day}
              onClick={() => onDayClick?.(day)}
              className={`flex-1 py-2 text-center border-r border-gray-100 transition-colors ${
                isSelected ? 'bg-gray-50' : 'hover:bg-gray-50'
              }`}
            >
              <p className="text-[10px] font-bold uppercase" style={{ color: DAY_COLORS[day] }}>
                {DAYS[day]}
              </p>
              <p className={`text-[9px] font-semibold ${cells.length >= maxJobsPerDay ? 'text-red-500' : 'text-gray-400'}`}>
                {cells.length}/{maxJobsPerDay}
              </p>
            </button>
          )
        })}
      </div>

      {/* Time grid */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden relative">
        <div className="flex" style={{ minHeight: `${totalMinutes * pixelsPerMinute}px` }}>
          {/* Time labels */}
          <div className="w-12 shrink-0 relative">
            {hours.map(h => {
              const offset = (h * 60 - dayStartMinutes) * pixelsPerMinute
              return (
                <div
                  key={h}
                  className="absolute right-2 text-[10px] text-gray-400 font-medium"
                  style={{ top: `${offset}px`, transform: 'translateY(-50%)' }}
                >
                  {hourLabel(h)}
                </div>
              )
            })}
          </div>

          {/* Day columns */}
          {activeDays.map(day => {
            const blocks = deriveBlocks(getWeekDayCells(day))
            const isSelected = selectedDay === day
            return (
              <div
                key={day}
                className={`flex-1 relative border-r border-gray-100 ${isSelected ? 'bg-gray-50/50' : ''}`}
              >
                {/* Hour gridlines */}
                {hours.map(h => {
                  const offset = (h * 60 - dayStartMinutes) * pixelsPerMinute
                  return (
                    <div
                      key={h}
                      className="absolute left-0 right-0 border-t border-gray-100"
                      style={{ top: `${offset}px` }}
                    />
                  )
                })}

                {/* Client blocks */}
                {blocks.map(block => {
                  const isHighlighted = selectedClientId === block.clientId
                  const startH = Math.floor(block.startMinutes / 60)
                  const startM = block.startMinutes % 60
                  const timeStr = `${startH > 12 ? startH - 12 : startH}:${String(startM).padStart(2, '0')} ${startH >= 12 ? 'PM' : 'AM'}`

                  return (
                    <div
                      key={block.clientId}
                      onClick={() => onClientClick?.(block.clientId)}
                      className={`absolute left-1 right-1 rounded-md px-2 py-1 cursor-pointer transition-all ${
                        isHighlighted ? 'ring-2 ring-gray-900 ring-offset-1 z-10' : 'hover:brightness-110'
                      } ${block.overflows ? 'border-2 border-red-400' : ''}`}
                      style={{
                        top: `${block.top}px`,
                        height: `${Math.max(block.height, 24)}px`,
                        backgroundColor: block.overflows
                          ? `${DAY_COLORS[day]}` 
                          : DAY_COLORS[day],
                        opacity: block.overflows ? 0.7 : 1,
                      }}
                    >
                      <p className="text-[10px] font-semibold text-white truncate leading-tight">
                        {block.clientName}
                      </p>
                      {block.height >= 36 && (
                        <p className="text-[8px] text-white/70 mt-0.5">{timeStr}</p>
                      )}
                      {block.recurrence !== 'weekly' && (
                        <span className="absolute top-1 right-1 text-[7px] font-bold text-white/60 bg-white/20 px-1 rounded">
                          {block.recurrence === 'biweekly' ? (block.rotation === 0 ? 'A' : 'B') : 'M'}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify the component renders in isolation**

We'll wire it into `ScheduleBuilder` in the next task. For now, check that the file has no TypeScript errors:

Run: `cd web && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add web/src/components/WeekTimeGrid.tsx
git commit -m "feat: create WeekTimeGrid component with time-axis day columns and week tabs"
```

---

### Task 6: Wire WeekTimeGrid into ScheduleBuilder

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

- [ ] **Step 1: Replace schedule panel placeholder with WeekTimeGrid**

```tsx
import WeekTimeGrid from '../components/WeekTimeGrid'
```

Replace the schedule panel placeholder div with:

```tsx
<div className="flex-1 flex flex-col bg-white min-w-0">
  <WeekTimeGrid
    grid={result.grid}
    activeDays={activeDayIndices}
    durationMap={durationMap}
    maxJobsPerDay={maxJobsPerDay}
    selectedClientId={selectedClientId}
    onClientClick={(clientId) => {
      setSelectedDay(null)
      setSelectedClientId(prev => prev === clientId ? null : clientId)
    }}
    onDayClick={(day) => {
      setSelectedClientId(null)
      setSelectedDay(prev => prev === day ? null : day)
    }}
    selectedDay={selectedDay}
  />
</div>
```

Where `activeDayIndices` is:

```tsx
const activeDayIndices = useMemo(() =>
  workingDays.map((on, i) => on ? i : -1).filter(i => i >= 0),
  [workingDays]
)
```

- [ ] **Step 2: Verify grid ↔ map linked selection**

1. Click a client block in the grid → map pin highlights
2. Click a map pin → grid block highlights
3. Click a day column header → map dims all pins except that day's clients
4. Click the same day header again → clears filter

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx
git commit -m "feat: wire WeekTimeGrid into schedule builder with linked selection"
```

---

## Phase 5: Overflow Tray + Drag-and-Drop

Add the overflow tray below the grid and enable drag-and-drop placement.

### Task 7: Add overflow tray to WeekTimeGrid

**Files:**
- Modify: `web/src/components/WeekTimeGrid.tsx`

- [ ] **Step 1: Add unplaced clients prop and overflow tray**

Add to the props interface:

```tsx
/** Clients that didn't fit (unplaced by the engine) */
unplacedClients: Array<{ id: string; name: string; color: string }>
/** Callback when an unplaced client is dragged onto a day */
onPlaceClient?: (clientId: string, dayIndex: number) => void
```

Add the overflow tray below the time grid (between the grid scroll area and the component's closing div):

```tsx
{/* Overflow tray */}
{unplacedClients.length > 0 && (
  <div className="shrink-0 border-t border-gray-200 bg-amber-50/50 px-3 py-2.5">
    <div className="flex items-center gap-2 mb-2">
      <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
      <p className="text-xs font-semibold text-amber-700">
        {unplacedClients.length} don't fit
      </p>
      <span className="text-[10px] text-amber-500">Drag onto a day column or click to place</span>
    </div>
    <div className="flex flex-wrap gap-1.5">
      {unplacedClients.map(client => (
        <div
          key={client.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('clientId', client.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onClick={() => onClientClick?.(client.id)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 bg-white rounded-lg border border-gray-200 cursor-grab active:cursor-grabbing hover:shadow-sm transition-shadow ${
            selectedClientId === client.id ? 'ring-2 ring-amber-400' : ''
          }`}
        >
          <div className="w-2 h-2 rounded-full bg-gray-400" />
          <span className="text-xs font-medium text-gray-700">{client.name}</span>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 2: Add drop targets on day columns**

Wrap each day column div with drag-over/drop handlers:

```tsx
const [dragOverDay, setDragOverDay] = useState<number | null>(null)

// On each day column:
onDragOver={(e) => { e.preventDefault(); setDragOverDay(day) }}
onDragLeave={() => setDragOverDay(null)}
onDrop={(e) => {
  e.preventDefault()
  setDragOverDay(null)
  const clientId = e.dataTransfer.getData('clientId')
  if (clientId) onPlaceClient?.(clientId, day)
}}
```

Add visual feedback — when dragging over a column, the header lights up:

```tsx
className={`flex-1 relative border-r border-gray-100 transition-colors ${
  isSelected ? 'bg-gray-50/50' : ''
} ${dragOverDay === day ? 'bg-blue-50' : ''}`}
```

Also make the column header div show a drop indicator:

```tsx
{dragOverDay === day && (
  <div className="absolute inset-x-1 bottom-2 h-8 rounded-md border-2 border-dashed border-blue-400 bg-blue-50/50 flex items-center justify-center">
    <span className="text-[10px] font-semibold text-blue-500">+ Drop here</span>
  </div>
)}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/WeekTimeGrid.tsx
git commit -m "feat: add overflow tray with drag-and-drop to day columns"
```

---

### Task 8: Wire overflow tray data and placement logic in ScheduleBuilder

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

- [ ] **Step 1: Compute unplaced clients from engine result**

The engine's `result.assignments` contains all placed clients. Any selected client NOT in assignments is unplaced. But with the current engine, all clients get assigned (force-fit to lightest day). We need to check if any clients exceed `maxJobsPerDay` on any given week.

For now, compute from the grid — a client is "overflow" if their placement would cause a week to exceed capacity:

```tsx
const unplacedClients = useMemo(() => {
  if (!result) return []
  // Currently the engine places everyone. If we want to surface overflow,
  // we check which day-week cells exceed maxJobsPerDay.
  // For v1: all clients are placed, overflow tray is empty unless
  // we manually implement capacity enforcement.
  // The tray will populate once we add manual re-placement.
  return [] as Array<{ id: string; name: string; color: string }>
}, [result])
```

Pass to WeekTimeGrid:

```tsx
unplacedClients={unplacedClients}
onPlaceClient={(clientId, dayIndex) => {
  // For now, log the action — Phase 6 will handle re-running engine
  console.log(`Place ${clientId} on day ${dayIndex}`)
}}
```

- [ ] **Step 2: Add "Increase capacity" button in the header when overflow exists**

```tsx
{unplacedClients.length > 0 && (
  <button
    onClick={() => {
      setMaxJobsPerDay(prev => prev + 1)
      // Re-run engine with new capacity — will be wired in Phase 6
    }}
    className="px-3 py-1 text-xs font-medium text-amber-700 bg-amber-100 rounded-lg hover:bg-amber-200 transition-colors"
  >
    Increase capacity ({maxJobsPerDay} → {maxJobsPerDay + 1})
  </button>
)}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx
git commit -m "feat: wire overflow tray and increase capacity CTA into builder"
```

---

## Phase 6: Compare Toggles + Apply Flow

### Task 9: Add schedule compare toggle

**Files:**
- Modify: `web/src/components/WeekTimeGrid.tsx`

- [ ] **Step 1: Add compare mode prop and ghost blocks**

Add to props:

```tsx
/** When true, show current schedule as ghost blocks behind optimized */
compareMode: boolean
/** Current schedule grid for comparison (same key format as grid) */
currentGrid?: Map<string, GridCell[]>
```

When `compareMode` is on, render the current schedule's blocks as faded outlines behind the optimized blocks. For each day column, before rendering the optimized blocks:

```tsx
{compareMode && currentGrid && (() => {
  const currentCells = (currentGrid.get(`${activeWeek}-${day}`) || []).sort((a, b) => a.routeOrder - b.routeOrder)
  const currentBlocks = deriveBlocks(currentCells)
  return currentBlocks.map(block => (
    <div
      key={`current-${block.clientId}`}
      className="absolute left-1 right-1 rounded-md px-2 py-1 border border-dashed pointer-events-none"
      style={{
        top: `${block.top}px`,
        height: `${Math.max(block.height, 24)}px`,
        borderColor: DAY_COLORS[day] + '60',
        backgroundColor: DAY_COLORS[day] + '10',
      }}
    >
      <p className="text-[10px] font-medium truncate leading-tight" style={{ color: DAY_COLORS[day] + '80' }}>
        {block.clientName}
      </p>
    </div>
  ))
})()}
```

Also show a badge on clients that changed days:

For each optimized block, if the client exists in the current grid on a *different* day, show a small arrow badge:

```tsx
// Inside the block div, add after the recurrence badge:
{compareMode && (() => {
  // Find this client's current day
  for (const d of activeDays) {
    const cells = (currentGrid?.get(`${activeWeek}-${d}`) || [])
    if (cells.some(c => c.clientId === block.clientId) && d !== day) {
      return (
        <span className="absolute bottom-1 right-1 text-[7px] font-bold text-white/80 bg-white/25 px-1 rounded">
          ← {DAYS[d]}
        </span>
      )
    }
  }
  return null
})()}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/WeekTimeGrid.tsx
git commit -m "feat: add schedule compare toggle with ghost blocks"
```

---

### Task 10: Add map compare toggle

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

- [ ] **Step 1: Build current schedule pin data for comparison**

```tsx
const [compareSchedule, setCompareSchedule] = useState(false)
const [compareMap, setCompareMap] = useState(false)

// Current schedule color map (what the user has today)
const currentDayColorMap = useMemo(() => {
  const map = new Map<string, string>()
  const today = new Date()
  const year = today.getFullYear()
  const month = today.getMonth()
  store.clients.forEach(client => {
    const dates = store.getAllDatesForClient(client.id, year, month)
    if (dates.length > 0) {
      const counts = [0, 0, 0, 0, 0, 0, 0]
      dates.forEach(d => { counts[new Date(d + 'T00:00:00').getDay()]++ })
      map.set(client.id, DAY_COLORS[counts.indexOf(Math.max(...counts))])
    }
  })
  return map
}, [store.clients])
```

When `compareMap` is on, pass the *current* day color map to the ClientMap instead of the optimized one. This shows where clients ARE today vs where the engine would put them.

```tsx
<ClientMap
  clients={builderClients}
  placedClientIds={builderPlacedIds}
  clientDayColorMap={compareMap ? currentDayColorMap : builderDayColorMap}
  highlightedClientIds={highlightedClientIds}
  selectedDateLabel={compareMap ? 'Current Schedule' : selectedDayLabel}
  onPinClick={handlePinClick}
  homeAddress={store.homeAddress ? { lat: store.homeAddress.lat, lng: store.homeAddress.lng } : null}
/>
```

- [ ] **Step 2: Add toggle buttons in the footer**

```tsx
<div className="px-5 py-3 border-t border-gray-200 bg-white shrink-0 flex items-center justify-between">
  <div className="flex items-center gap-2">
    <button
      onClick={() => setCompareSchedule(prev => !prev)}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
        compareSchedule ? 'bg-purple-100 text-purple-700' : 'text-gray-500 hover:bg-gray-100'
      }`}
    >
      Compare Schedule
    </button>
    <button
      onClick={() => setCompareMap(prev => !prev)}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
        compareMap ? 'bg-purple-100 text-purple-700' : 'text-gray-500 hover:bg-gray-100'
      }`}
    >
      Compare Map
    </button>
  </div>
  <div className="flex items-center gap-2">
    <button onClick={() => setStep('setup')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
      Re-configure
    </button>
    <button
      onClick={handleApply}
      className="px-5 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 transition-colors"
    >
      Apply to Schedule →
    </button>
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx
git commit -m "feat: add compare toggles for schedule and map"
```

---

### Task 11: Apply flow with confirmation summary

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

- [ ] **Step 1: Add confirmation dialog before applying**

```tsx
const [showConfirm, setShowConfirm] = useState(false)

const handleApply = () => {
  setShowConfirm(true)
}

const confirmApply = () => {
  if (!result) return
  const recMap = new Map<string, Client['frequency']>()
  for (const id of selectedIds) {
    recMap.set(id, (recurrenceMap.get(id) ?? 'weekly') as Client['frequency'])
  }
  // Build transition moves (same as PerfectScheduleModal's onApply)
  const moves = buildTransitionMoves(result.changes, store.clients, result.rotations, recMap as unknown as Map<string, string>)
  // Navigate back to schedule with transition data
  navigate('/schedule', {
    state: {
      transitionMoves: moves,
      transitionRecMap: Object.fromEntries(recMap),
      transitionRotations: Object.fromEntries(result.rotations),
      transitionStartDate: startDate.toISOString(),
      transitionConfig: { maxJobsPerDay, workingDays },
    }
  })
}
```

Add the import:
```tsx
import { buildTransitionMoves } from '../optimizer'
```

Render the confirmation modal:

```tsx
{showConfirm && result && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowConfirm(false)}>
    <div className="bg-white rounded-xl shadow-2xl w-[400px] p-6" onClick={e => e.stopPropagation()}>
      <h3 className="text-lg font-bold text-gray-900 mb-4">Apply Schedule?</h3>
      <div className="space-y-2 mb-5">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Clients changing days</span>
          <span className="font-semibold text-gray-900">{result.changes.length}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Drive time saved</span>
          <span className="font-semibold text-green-600">
            {Math.max(0, result.currentDriveMinutes - result.totalDriveMinutes)}m/wk
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Total clients</span>
          <span className="font-semibold text-gray-900">{result.assignments.size}</span>
        </div>
      </div>
      <p className="text-xs text-gray-400 mb-5">
        This opens the Transition view where you confirm each client move individually.
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => setShowConfirm(false)}
          className="flex-1 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={confirmApply}
          className="flex-1 px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700"
        >
          Continue to Transition
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 2: Handle navigation state in Schedule.tsx**

In `web/src/pages/Schedule.tsx`, receive the transition data from navigation state:

```tsx
import { useLocation } from 'react-router-dom'

// Inside the Schedule component, after existing state:
const location = useLocation()

useEffect(() => {
  if (location.state?.transitionMoves) {
    const state = location.state as {
      transitionMoves: TransitionMove[]
      transitionRecMap: Record<string, string>
      transitionRotations: Record<string, number>
      transitionStartDate: string
      transitionConfig: { maxJobsPerDay: number; workingDays: boolean[] }
    }
    setTransitionMoves(state.transitionMoves)
    setTransitionRecMap(new Map(Object.entries(state.transitionRecMap)))
    setTransitionRotations(new Map(Object.entries(state.transitionRotations).map(([k, v]) => [k, Number(v)])))
    setTransitionStartDate(new Date(state.transitionStartDate))
    setTransitionConfig(state.transitionConfig)
    setShowTransition(true)
    // Clear the navigation state so refresh doesn't re-trigger
    window.history.replaceState({}, '')
  }
}, [location.state])
```

Add `useLocation` to the imports from `react-router-dom`.

- [ ] **Step 3: Verify the full flow**

1. `/schedule` → "Perfect Schedule" → `/schedule/builder`
2. Configure → Build → Review on two-panel view
3. "Apply to Schedule →" → confirmation dialog shows delta
4. "Continue to Transition" → navigates to `/schedule` with Transition sidebar open
5. Transition sidebar shows the moves for individual confirmation

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx web/src/pages/Schedule.tsx
git commit -m "feat: add confirmation dialog and wire apply flow to transition view"
```

---

## Phase 7: Resizable Panels + Polish

### Task 12: Add resizable divider between map and schedule

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

- [ ] **Step 1: Add drag-to-resize divider**

Port the resize logic from `Schedule.tsx` (lines 67-97):

```tsx
const [mapWidthPercent, setMapWidthPercent] = useState(45)
const isDraggingDivider = useRef(false)
const containerRef = useRef<HTMLDivElement>(null)

useEffect(() => {
  const handleMouseMove = (e: MouseEvent) => {
    if (!isDraggingDivider.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const percent = Math.max(20, Math.min(70, (mouseX / rect.width) * 100))
    setMapWidthPercent(percent)
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
```

Apply to the two-panel layout:

```tsx
<div ref={containerRef} className="flex-1 flex overflow-hidden">
  {/* Map */}
  <div className="relative" style={{ flex: `${mapWidthPercent} 0 0%` }}>
    <ClientMap ... />
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

  {/* Schedule */}
  <div className="flex flex-col bg-white min-w-0" style={{ flex: `${100 - mapWidthPercent} 0 0%` }}>
    <WeekTimeGrid ... />
  </div>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx
git commit -m "feat: add resizable divider between map and schedule panels"
```

---

### Task 13: Add day-filter on map when clicking day column header

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

- [ ] **Step 1: Filter map pins by selected day**

The `highlightedClientIds` computation already handles this (from Task 4). When `selectedDay` is set, it filters to that day's clients. The map dims all others. Clicking the same day again clears the filter.

Verify this works end-to-end:
1. Click "Wed" column header → map dims all non-Wednesday pins
2. Click "Wed" again → clears filter, all pins visible
3. Map label shows "Wed" when filtered

This should already work from the wiring in Task 4/Task 6. If not, ensure `selectedDay` state flows correctly through both panels.

- [ ] **Step 2: Commit** (if any changes were needed)

```bash
git add web/src/pages/ScheduleBuilder.tsx
git commit -m "fix: ensure day-column click filters map pins correctly"
```

---

### Task 14: Build currentGrid for schedule compare

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

- [ ] **Step 1: Build a grid from the user's current schedule**

To compare, we need the current schedule in the same `Map<string, GridCell[]>` format as the engine output:

```tsx
const currentGrid = useMemo(() => {
  if (!result) return undefined
  const grid = new Map<string, GridCell[]>()
  const today = new Date()
  const year = today.getFullYear()
  const month = today.getMonth()

  // Build current day assignments
  const clientCurrentDays = new Map<string, number>()
  store.clients.forEach(client => {
    if (!selectedIds.has(client.id)) return
    const dates = store.getAllDatesForClient(client.id, year, month)
    if (dates.length > 0) {
      const counts = [0, 0, 0, 0, 0, 0, 0]
      dates.forEach(d => { counts[new Date(d + 'T00:00:00').getDay()]++ })
      clientCurrentDays.set(client.id, counts.indexOf(Math.max(...counts)))
    }
  })

  // Place each client on their current day across all 4 weeks
  // (simplified — treats all as weekly for comparison purposes)
  let order = 0
  for (const [clientId, day] of clientCurrentDays) {
    const client = store.clients.find(c => c.id === clientId)
    if (!client) continue
    const freq = recurrenceMap.get(clientId) ?? 'weekly'
    const cell: GridCell = {
      clientId,
      clientName: client.name,
      routeOrder: order++,
      recurrence: freq as GridCell['recurrence'],
      rotation: 0,
    }
    const weeks = freq === 'biweekly' ? [0, 2] : freq === 'monthly' ? [0] : [0, 1, 2, 3]
    for (const w of weeks) {
      const key = `${w}-${day}`
      const existing = grid.get(key) || []
      grid.set(key, [...existing, cell])
    }
  }

  return grid
}, [result, store.clients, selectedIds, recurrenceMap])
```

Pass to `WeekTimeGrid`:

```tsx
compareMode={compareSchedule}
currentGrid={currentGrid}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx
git commit -m "feat: build currentGrid for schedule compare mode"
```

---

### Task 15: Suggested day badge for unplaced clients

**Files:**
- Modify: `web/src/components/WeekTimeGrid.tsx`

- [ ] **Step 1: Add suggested day highlighting**

Add to props:

```tsx
/** Map of clientId → suggested best day index (from engine proximity analysis) */
suggestedDays?: Map<string, { day: number; label: string }>
```

When an unplaced client is selected (clicked in the overflow tray), highlight the suggested day column with a badge:

```tsx
// In the day column header, after the count badge:
{selectedClientId && suggestedDays?.get(selectedClientId)?.day === day && (
  <span className="text-[8px] font-bold text-green-600 bg-green-50 px-1.5 rounded-full mt-0.5 block">
    closest
  </span>
)}
```

- [ ] **Step 2: Compute suggested days in ScheduleBuilder**

```tsx
const suggestedDays = useMemo(() => {
  if (!result || unplacedClients.length === 0) return undefined
  // For each unplaced client, find the day with the most nearby placed clients
  // This is a simple geographic proximity check
  const map = new Map<string, { day: number; label: string }>()
  // In practice, once we have unplaced clients, we'd use the distance matrix
  // For now, suggest the lightest day
  for (const client of unplacedClients) {
    let lightestDay = activeDayIndices[0]
    let lightestCount = Infinity
    for (const day of activeDayIndices) {
      const key = `0-${day}` // check week 0
      const count = (result.grid.get(key) || []).length
      if (count < lightestCount) { lightestCount = count; lightestDay = day }
    }
    map.set(client.id, { day: lightestDay, label: `${lightestCount}/${maxJobsPerDay}` })
  }
  return map
}, [result, unplacedClients, activeDayIndices, maxJobsPerDay])
```

Pass to WeekTimeGrid:
```tsx
suggestedDays={suggestedDays}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/WeekTimeGrid.tsx web/src/pages/ScheduleBuilder.tsx
git commit -m "feat: add suggested day badge for unplaced clients"
```

---

## Phase 8: Cleanup

### Task 16: Remove old PerfectScheduleModal dependency

**Files:**
- Modify: `web/src/pages/Schedule.tsx`
- (Keep): `web/src/components/PerfectScheduleModal.tsx` — don't delete yet, the transition view still references its data flow

- [ ] **Step 1: Remove modal render and state from Schedule.tsx**

Remove:
- `const [showPerfectModal, setShowPerfectModal] = useState(false)` (line 50)
- The entire `<PerfectScheduleModal ... />` block (lines 1143-1161)
- The `PerfectScheduleModal` import (line 8)

Keep `buildTransitionMoves` and `reoptimizeTransition` imports — they're used by the Transition view.

- [ ] **Step 2: Verify nothing breaks**

Run: `cd web && npx tsc --noEmit`

Verify: `/schedule` page loads, "Perfect Schedule" button navigates to `/schedule/builder`, Transition sidebar still works from navigation state.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/Schedule.tsx
git commit -m "chore: remove PerfectScheduleModal from Schedule page"
```

---

## Summary

| Phase | What it delivers | Can deploy? |
|-------|-----------------|-------------|
| 1 | Route + layout shell, button wired | Yes — shell only, no breakage |
| 2 | Config/recurrence + engine runs | Yes — full setup flow works |
| 3 | Map panel with day-colored pins | Yes — visual feedback |
| 4 | WeekTimeGrid with week tabs | Yes — core new UI |
| 5 | Overflow tray + drag-and-drop | Yes — manual placement |
| 6 | Compare toggles + apply flow | Yes — complete loop |
| 7 | Polish: resize, day filter, suggestions | Yes — UX refinements |
| 8 | Remove old modal | Yes — cleanup |

Each phase produces deployable, testable software. Phase 4 is the biggest — the WeekTimeGrid component is ~200 lines of new UI. Everything else is wiring existing pieces together.

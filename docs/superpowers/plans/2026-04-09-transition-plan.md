# Transition Plan Implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a "Transition Plan" feature that lets users incrementally move from their current schedule to the perfect schedule, handling client rejections gracefully through re-optimization.

**Architecture:** New `TransitionView` sidebar component (mirrors `OptimizeView` pattern). New `TransitionState` type in `types.ts`. Re-optimization reuses existing `generateOptimization()` with locked clients filtered out. State persisted in localStorage under `pip-transition`. Each confirmed move immediately applies to the real schedule via `placeClientRecurring()`.

**Tech Stack:** React + TypeScript, Tailwind CSS, existing optimizer pipeline (VROOM + ORS + Haversine fallback)

---

### Task 1: Add Transition Types

**Files:**
- Modify: `web/src/types.ts:19-38`

- [ ] **Step 1: Add TransitionMove and TransitionState types**

Add after the existing `OptimizationState` type (line 38):

```typescript
/** A single move in the transition plan */
export type TransitionMove = ProposedMove & {
  locked: boolean           // true once confirmed OR cant-move
  originalDay: number       // client's day when transition started
  iteration: number         // which re-optimization pass generated this move
}

/** Tracks the full transition from current → perfect schedule */
export type TransitionState = {
  moves: TransitionMove[]
  lockedClientIds: string[]       // clients whose positions are fixed (confirmed + rejected)
  iteration: number               // increments on each re-optimization
  status: 'active' | 'paused' | 'completed'
  startedAt: string               // ISO date
  config: {                       // snapshot of config used to generate
    maxJobsPerDay: number
    workingDays: boolean[]
  }
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd /Users/anthonydragone/Developer/pip-web/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
cd /Users/anthonydragone/Developer/pip-web
git add web/src/types.ts
git commit -m "feat: add TransitionMove and TransitionState types"
```

---

### Task 2: Add Transition Re-optimizer

**Files:**
- Modify: `web/src/optimizer.ts` (add new export at bottom)

The re-optimizer takes the current schedule + locked clients and produces a new set of moves for unconfirmed clients only. It reuses `generateOptimization()` internally.

- [ ] **Step 1: Add generateTransitionMoves function**

Add at the bottom of `web/src/optimizer.ts`:

```typescript
import type { TransitionMove } from './types'

/**
 * Generate transition moves by diffing perfect schedule against current.
 * Returns moves sorted by savings (biggest first).
 * Clients already on their perfect day are excluded.
 */
export function buildTransitionMoves(
  changes: PerfectScheduleResult['changes'],
  clients: Client[],
): TransitionMove[] {
  return changes
    .map(change => {
      const client = clients.find(c => c.id === change.clientId)
      if (!client) return null
      const weight = frequencyWeight(client.frequency)
      return {
        clientId: change.clientId,
        clientName: change.clientName,
        currentDay: change.fromDay,
        suggestedDay: change.toDay,
        savingsMinutes: 0, // placeholder — will be computed by recomputeTransitionSavings
        reason: `Move from ${DAYS_FULL[change.fromDay]} to ${DAYS_FULL[change.toDay]}`,
        status: 'to-ask' as const,
        suggestedMessage: `Hey ${change.clientName.split(' ')[0]}, would ${DAYS_FULL[change.toDay]}s work for you going forward instead of ${DAYS_FULL[change.fromDay]}s? Trying to tighten up my route.`,
        locked: false,
        originalDay: change.fromDay,
        iteration: 0,
      } satisfies TransitionMove
    })
    .filter((m): m is TransitionMove => m !== null)
}

/**
 * Re-optimize transition after a rejection.
 * 
 * Locked clients (confirmed on new day OR rejected on current day) are treated
 * as immovable. Unconfirmed clients are re-optimized around them.
 * 
 * Returns updated moves for unconfirmed clients only. Locked moves pass through unchanged.
 */
export async function reoptimizeTransition(
  allClients: Client[],
  lockedMoves: TransitionMove[],
  clientDayMap: Map<string, number>,
  config: { maxJobsPerDay: number; workingDays: boolean[] },
  homeCoords: { lat: number; lng: number },
  iteration: number,
): Promise<TransitionMove[]> {
  const lockedIds = new Set(lockedMoves.map(m => m.clientId))

  // Build the "current" day map reflecting applied moves:
  // - Confirmed clients: use their suggestedDay (already applied to schedule)
  // - Rejected clients: use their currentDay (stayed put)
  // - Unconfirmed: use current schedule day
  const effectiveDayMap = new Map<string, number>()
  for (const [clientId, day] of clientDayMap) {
    effectiveDayMap.set(clientId, day)
  }
  for (const m of lockedMoves) {
    if (m.status === 'confirmed') {
      effectiveDayMap.set(m.clientId, m.suggestedDay)
    } else {
      effectiveDayMap.set(m.clientId, m.currentDay)
    }
  }

  // Get unconfirmed clients that are placed
  const unconfirmedClients = allClients.filter(c =>
    !lockedIds.has(c.id) && effectiveDayMap.has(c.id)
  )

  if (unconfirmedClients.length < 2) {
    // Nothing meaningful to re-optimize
    return lockedMoves
  }

  const clientsWithDays = unconfirmedClients.map(c => ({
    client: c,
    currentDay: effectiveDayMap.get(c.id)!,
  }))

  // Re-run the optimizer on unconfirmed clients only
  const result = await generateOptimization(clientsWithDays, config, homeCoords)

  // Convert optimizer moves to TransitionMoves
  const newMoves: TransitionMove[] = result.moves.map(m => ({
    ...m,
    locked: false,
    originalDay: clientDayMap.get(m.clientId) ?? m.currentDay,
    iteration,
  }))

  // Also include swap moves flattened
  for (const swap of result.swaps) {
    for (const sm of [swap.moveA, swap.moveB]) {
      if (!newMoves.some(m => m.clientId === sm.clientId)) {
        newMoves.push({
          ...sm,
          locked: false,
          originalDay: clientDayMap.get(sm.clientId) ?? sm.currentDay,
          iteration,
        })
      }
    }
  }

  // Merge: locked moves stay, new moves replace unconfirmed
  return [...lockedMoves, ...newMoves].sort((a, b) => {
    // Locked first, then by savings
    if (a.locked && !b.locked) return -1
    if (!a.locked && b.locked) return 1
    return b.savingsMinutes - a.savingsMinutes
  })
}
```

- [ ] **Step 2: Fix the import at the top of optimizer.ts**

The file already imports from `./types`. Update the import to include `TransitionMove`:

At the top of `web/src/optimizer.ts`, change the existing import:
```typescript
import type { Client, ProposedMove, GridCell } from './types'
```
to:
```typescript
import type { Client, ProposedMove, GridCell, TransitionMove } from './types'
```

- [ ] **Step 3: Verify types compile**

Run: `cd /Users/anthonydragone/Developer/pip-web/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
cd /Users/anthonydragone/Developer/pip-web
git add web/src/optimizer.ts
git commit -m "feat: add buildTransitionMoves and reoptimizeTransition"
```

---

### Task 3: Build TransitionView Component

**Files:**
- Create: `web/src/components/TransitionView.tsx`

This component mirrors `OptimizeView.tsx` in structure but manages the transition-specific flow: ranked move checklist, status tracking, re-optimization on rejection, and live schedule updates.

- [ ] **Step 1: Create TransitionView.tsx**

```typescript
import { useState, useMemo, useEffect } from 'react'
import type { Client, TransitionMove, TransitionState, OptimizationStatus } from '../types'
import { reoptimizeTransition } from '../optimizer'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_COLORS = ['#F97316', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4']

const STATUS_CONFIG: Record<OptimizationStatus, { label: string; color: string; bg: string }> = {
  'to-ask':    { label: 'To Ask',      color: '#6B7280', bg: '#F3F4F6' },
  'waiting':   { label: 'Waiting',     color: '#F59E0B', bg: '#FFFBEB' },
  'confirmed': { label: 'Confirmed',   color: '#10B981', bg: '#ECFDF5' },
  'cant-move': { label: "Can't Move",  color: '#EF4444', bg: '#FEF2F2' },
}

const STORAGE_KEY = 'pip-transition'

interface TransitionViewProps {
  clients: Client[]
  clientDayMap: Map<string, number>
  initialMoves: TransitionMove[]
  config: { maxJobsPerDay: number; workingDays: boolean[] }
  homeAddress: { address: string; lat: number; lng: number }
  onClose: () => void
  onApplyMove: (clientId: string, newDay: number) => void
}

function loadPersistedState(): TransitionState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export default function TransitionView({
  clients,
  clientDayMap,
  initialMoves,
  config,
  homeAddress,
  onClose,
  onApplyMove,
}: TransitionViewProps) {
  // Try to restore persisted state, otherwise use initial moves
  const [state, setState] = useState<TransitionState>(() => {
    const persisted = loadPersistedState()
    if (persisted && persisted.status !== 'completed') {
      return persisted
    }
    return {
      moves: initialMoves,
      lockedClientIds: [],
      iteration: 0,
      status: 'active',
      startedAt: new Date().toISOString(),
      config,
    }
  })

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Persist state on change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  // Stats
  const pendingMoves = useMemo(() =>
    state.moves.filter(m => !m.locked),
  [state.moves])

  const confirmedMoves = useMemo(() =>
    state.moves.filter(m => m.status === 'confirmed'),
  [state.moves])

  const rejectedMoves = useMemo(() =>
    state.moves.filter(m => m.status === 'cant-move'),
  [state.moves])

  const totalMoves = state.moves.length
  const resolvedCount = confirmedMoves.length + rejectedMoves.length
  const confirmedSavings = confirmedMoves.reduce((s, m) => s + m.savingsMinutes, 0)
  const totalPotential = state.moves.reduce((s, m) => s + m.savingsMinutes, 0)

  const updateMoveStatus = async (clientId: string, newStatus: OptimizationStatus) => {
    const move = state.moves.find(m => m.clientId === clientId)
    if (!move) return

    const isLocking = newStatus === 'confirmed' || newStatus === 'cant-move'
    const wasLocked = move.locked

    // Update the move status and lock state
    const updatedMoves = state.moves.map(m =>
      m.clientId === clientId
        ? { ...m, status: newStatus, locked: isLocking }
        : m
    )

    const updatedLockedIds = isLocking && !wasLocked
      ? [...state.lockedClientIds, clientId]
      : state.lockedClientIds

    // If confirming, apply the move to the real schedule immediately
    if (newStatus === 'confirmed') {
      onApplyMove(clientId, move.suggestedDay)
    }

    // If this is a new rejection, re-optimize remaining moves
    if (newStatus === 'cant-move' && !wasLocked) {
      setLoading(true)
      try {
        const lockedMoves = updatedMoves.filter(m => m.locked)
        const newIteration = state.iteration + 1
        const reoptimized = await reoptimizeTransition(
          clients,
          lockedMoves,
          clientDayMap,
          state.config,
          { lat: homeAddress.lat, lng: homeAddress.lng },
          newIteration,
        )
        setState(prev => ({
          ...prev,
          moves: reoptimized,
          lockedClientIds: updatedLockedIds,
          iteration: newIteration,
        }))
      } catch (err) {
        console.error('Re-optimization failed:', err)
        // Fall back to just updating statuses without re-optimization
        setState(prev => ({
          ...prev,
          moves: updatedMoves,
          lockedClientIds: updatedLockedIds,
        }))
      } finally {
        setLoading(false)
      }
    } else {
      setState(prev => ({
        ...prev,
        moves: updatedMoves,
        lockedClientIds: updatedLockedIds,
      }))
    }

    // Check if all moves are resolved
    const allResolved = updatedMoves.every(m => m.locked)
    if (allResolved) {
      setState(prev => ({ ...prev, status: 'completed' }))
    }
  }

  const copyMessage = (move: TransitionMove) => {
    navigator.clipboard.writeText(move.suggestedMessage)
    setCopiedId(move.clientId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const formatTime = (min: number) => {
    if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`
    return `${min}m`
  }

  const clearTransition = () => {
    localStorage.removeItem(STORAGE_KEY)
    onClose()
  }

  // Check for negligible remaining savings
  const remainingPotential = pendingMoves.reduce((s, m) => s + m.savingsMinutes, 0)
  const isNegligible = pendingMoves.length > 0 && remainingPotential < 5

  // Empty / completed state
  if (state.status === 'completed' || state.moves.length === 0) {
    return (
      <div className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0">
        <div className="p-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Transition</h2>
          <button onClick={onClose} className="text-[10px] text-gray-400 hover:text-gray-600">Back</button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-2">
              <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-[11px] font-medium text-gray-600">Transition complete</p>
            <p className="text-[10px] text-gray-400 mt-0.5">
              {confirmedMoves.length} move{confirmedMoves.length !== 1 ? 's' : ''} applied, saving {formatTime(confirmedSavings)}/wk
            </p>
          </div>
          <button
            onClick={clearTransition}
            className="mt-4 px-3 py-1.5 text-[10px] font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100"
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0">
      {/* Header */}
      <div className="p-2.5 border-b border-gray-200">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Transition</h2>
          <div className="flex items-center gap-1">
            {loading && (
              <div className="w-3 h-3 border-2 border-gray-200 border-t-green-500 rounded-full animate-spin" />
            )}
            <button
              onClick={clearTransition}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 text-gray-400"
              title="Clear transition"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <button onClick={onClose} className="text-[10px] text-gray-400 hover:text-gray-600 font-medium ml-0.5">Back</button>
          </div>
        </div>

        {/* Stats bar */}
        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <div className="flex-1 bg-green-50 rounded px-2 py-1">
              <p className="text-[8px] text-green-600 font-medium uppercase">Saved</p>
              <p className="text-xs font-bold text-green-700">{formatTime(confirmedSavings)}<span className="text-[8px] font-normal text-green-500">/wk</span></p>
            </div>
            <div className="flex-1 bg-gray-100 rounded px-2 py-1">
              <p className="text-[8px] text-gray-500 font-medium uppercase">Potential</p>
              <p className="text-xs font-bold text-gray-800">{formatTime(totalPotential)}<span className="text-[8px] font-normal text-gray-400">/wk</span></p>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <p className="text-[9px] text-gray-400">{resolvedCount}/{totalMoves} resolved</p>
              {state.iteration > 0 && (
                <p className="text-[9px] text-blue-500">v{state.iteration + 1}</p>
              )}
            </div>
            <div className="h-1 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${totalMoves > 0 ? (resolvedCount / totalMoves) * 100 : 0}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* Negligible savings notice */}
      {isNegligible && (
        <div className="mx-2 mt-2 p-2 bg-yellow-50 rounded-lg border border-yellow-200">
          <p className="text-[10px] text-yellow-700 font-medium">Close enough?</p>
          <p className="text-[9px] text-yellow-600 mt-0.5">Remaining moves save less than {formatTime(remainingPotential)}/wk total.</p>
          <button
            onClick={() => setState(prev => ({ ...prev, status: 'completed' }))}
            className="mt-1.5 w-full px-2 py-1 text-[9px] font-medium text-yellow-700 bg-yellow-100 rounded hover:bg-yellow-200"
          >
            Good enough — finish
          </button>
        </div>
      )}

      {/* Move list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {/* Pending moves first */}
        {pendingMoves.length > 0 && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1 px-0.5">
              To Resolve ({pendingMoves.length})
            </p>
            <div className="space-y-1">
              {pendingMoves.map(move => (
                <TransitionMoveCard
                  key={move.clientId}
                  move={move}
                  isExpanded={expandedId === move.clientId}
                  copiedId={copiedId}
                  onToggle={() => setExpandedId(expandedId === move.clientId ? null : move.clientId)}
                  onStatusChange={status => void updateMoveStatus(move.clientId, status)}
                  onCopy={() => copyMessage(move)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Resolved moves */}
        {(confirmedMoves.length > 0 || rejectedMoves.length > 0) && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1 px-0.5 mt-2">
              Resolved ({resolvedCount})
            </p>
            <div className="space-y-1">
              {[...confirmedMoves, ...rejectedMoves].map(move => (
                <TransitionMoveCard
                  key={move.clientId}
                  move={move}
                  isExpanded={expandedId === move.clientId}
                  copiedId={copiedId}
                  onToggle={() => setExpandedId(expandedId === move.clientId ? null : move.clientId)}
                  onStatusChange={status => void updateMoveStatus(move.clientId, status)}
                  onCopy={() => copyMessage(move)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Transition Move Card ── */
function TransitionMoveCard({ move, isExpanded, copiedId, onToggle, onStatusChange, onCopy }: {
  move: TransitionMove
  isExpanded: boolean
  copiedId: string | null
  onToggle: () => void
  onStatusChange: (status: OptimizationStatus) => void
  onCopy: () => void
}) {
  const config = STATUS_CONFIG[move.status]

  return (
    <div className={`bg-white rounded-lg border transition-all ${
      move.status === 'confirmed' ? 'border-green-200 bg-green-50/30'
      : move.status === 'cant-move' ? 'border-red-200 opacity-60'
      : 'border-gray-200'
    }`}>
      <div className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer" onClick={onToggle}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <p className="text-[11px] font-semibold text-gray-900 truncate">{move.clientName}</p>
            <span className="text-[8px] font-medium px-1 py-px rounded-full shrink-0" style={{ color: config.color, backgroundColor: config.bg }}>
              {config.label}
            </span>
            {move.iteration > 0 && (
              <span className="text-[7px] font-medium px-1 py-px rounded-full bg-blue-50 text-blue-500 shrink-0">
                updated
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: DAY_COLORS[move.currentDay] }} />
            <span className="text-[10px] text-gray-400">{DAYS[move.currentDay]}</span>
            <svg className="w-2.5 h-2.5 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: DAY_COLORS[move.suggestedDay] }} />
            <span className="text-[10px] font-medium text-gray-600">{DAYS[move.suggestedDay]}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] font-bold text-green-600">
            {move.savingsMinutes > 0 ? `-${move.savingsMinutes}m` : ''}
          </p>
        </div>
      </div>

      {isExpanded && (
        <div className="px-2 pb-2 border-t border-gray-100">
          <p className="text-[10px] text-gray-500 mt-1.5 mb-2 leading-relaxed">{move.reason}</p>

          {/* Suggested message */}
          <div className="bg-gray-50 rounded p-1.5 mb-2">
            <div className="flex items-center justify-between mb-0.5">
              <p className="text-[8px] font-semibold text-gray-400 uppercase tracking-wider">Message</p>
              <button onClick={onCopy} className="text-[9px] text-blue-600 hover:text-blue-800 font-medium">
                {copiedId === move.clientId ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="text-[10px] text-gray-600 italic leading-relaxed">"{move.suggestedMessage}"</p>
          </div>

          {/* Status buttons */}
          {!move.locked ? (
            <div className="flex flex-wrap gap-1">
              {(['to-ask', 'waiting', 'confirmed', 'cant-move'] as const).map(status => {
                const sc = STATUS_CONFIG[status]
                const isActive = move.status === status
                return (
                  <button
                    key={status}
                    onClick={() => onStatusChange(status)}
                    className={`px-1.5 py-0.5 text-[9px] font-medium rounded transition-all ${
                      isActive ? 'ring-1 ring-offset-0.5' : 'hover:opacity-80'
                    }`}
                    style={{
                      color: sc.color,
                      backgroundColor: sc.bg,
                      ...(isActive ? { boxShadow: `0 0 0 1px ${sc.color}40` } : {}),
                    }}
                  >
                    {sc.label}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-[9px] text-gray-400 italic">
              {move.status === 'confirmed' ? 'Applied to schedule' : 'Locked — staying on current day'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd /Users/anthonydragone/Developer/pip-web/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
cd /Users/anthonydragone/Developer/pip-web
git add web/src/components/TransitionView.tsx
git commit -m "feat: add TransitionView sidebar component"
```

---

### Task 4: Wire TransitionView into Schedule Page

**Files:**
- Modify: `web/src/pages/Schedule.tsx`

Add the Transition Plan button and sidebar integration, mirroring how OptimizeSidebar is wired up.

- [ ] **Step 1: Add imports and state**

At the top of `web/src/pages/Schedule.tsx`, add to the existing imports:

```typescript
import TransitionView from '../components/TransitionView'
```

Add to the existing `import type` from `../types`:
```typescript
import type { TransitionMove } from '../types'
```

Inside the `Schedule` component, add these state variables near the existing `showOptimize` and `showPerfectModal` states (around line 47-48):

```typescript
const [showTransition, setShowTransition] = useState(false)
const [transitionMoves, setTransitionMoves] = useState<TransitionMove[]>([])
```

- [ ] **Step 2: Add the Transition Plan button**

After the existing "Perfect Schedule" button (around line 437-442), add:

```typescript
<button
  onClick={() => {
    // Check if there's an existing transition in localStorage
    const existing = localStorage.getItem('pip-transition')
    if (existing) {
      setShowTransition(true)
    }
  }}
  disabled={!localStorage.getItem('pip-transition')}
  className="px-3 py-1 text-[11px] font-medium text-white bg-orange-500 rounded-lg hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
  title={localStorage.getItem('pip-transition') ? 'Resume transition plan' : 'Generate a Perfect Schedule first'}
>
  Transition Plan
</button>
```

- [ ] **Step 3: Update the PerfectScheduleModal onApply to create transition**

Replace the existing `onApply` callback in the `PerfectScheduleModal` component (around line 1102-1105):

```typescript
onApply={(assignments, recMap, rotations, startDate) => {
  // Build transition moves from the changes
  const { buildTransitionMoves } = await import('../optimizer')
  // ... we need the changes from PerfectScheduleResult
}}
```

Actually, we need to pass the `changes` array from PerfectScheduleModal. Let's update the onApply to also receive the changes. Read PerfectScheduleModal to see the current onApply signature.

First, update the `onApply` in Schedule.tsx to create a transition instead of immediately applying:

```typescript
onApply={(assignments, recMap, rotations, startDate, changes) => {
  // Don't immediately apply — create a transition plan instead
  const moves = buildTransitionMoves(changes, store.clients)
  setTransitionMoves(moves)
  setShowPerfectModal(false)
  setShowTransition(true)
}}
```

Also add the import at the top of Schedule.tsx:
```typescript
import { buildTransitionMoves } from '../optimizer'
```

Note: We'll need to update PerfectScheduleModal to pass `changes` in the next step.

- [ ] **Step 4: Add TransitionView to the sidebar area**

In the body section (around line 475-495), add the TransitionView sidebar alongside the existing OptimizeSidebar conditional. Add this right after the OptimizeSidebar block:

```typescript
{showTransition && sidebarOpen && (
  <TransitionView
    clients={store.clients}
    clientDayMap={clientDayMap}
    initialMoves={transitionMoves}
    config={{
      maxJobsPerDay: 0,
      workingDays: [false, true, true, true, true, true, false],
    }}
    homeAddress={store.homeAddress!}
    onClose={() => setShowTransition(false)}
    onApplyMove={(clientId, newDay) => {
      const today = new Date()
      const todayDay = today.getDay()
      const daysUntil = (newDay - todayDay + 7) % 7 || 7
      const startDate = new Date(today)
      startDate.setDate(today.getDate() + daysUntil)
      const dateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`
      store.placeClientRecurring(clientId, dateStr, 'weekly')
    }}
  />
)}
```

Also update the client sidebar conditional (around line 511) to hide when transition is showing:

Change `{sidebarOpen && !showOptimize && (` to `{sidebarOpen && !showOptimize && !showTransition && (`

And update the sidebar toggle (around line 498):
Change `{!sidebarOpen && !showOptimize && (` to `{!sidebarOpen && !showOptimize && !showTransition && (`

- [ ] **Step 5: Verify types compile**

Run: `cd /Users/anthonydragone/Developer/pip-web/web && npx tsc --noEmit 2>&1 | head -30`
Expected: No new errors (may need to adjust PerfectScheduleModal — see Task 5)

- [ ] **Step 6: Commit**

```bash
cd /Users/anthonydragone/Developer/pip-web
git add web/src/pages/Schedule.tsx
git commit -m "feat: wire TransitionView into Schedule page"
```

---

### Task 5: Update PerfectScheduleModal to Pass Changes

**Files:**
- Modify: `web/src/components/PerfectScheduleModal.tsx`

The PerfectScheduleModal's `onApply` callback needs to also pass the `changes` array from `PerfectScheduleResult` so the transition plan knows which clients need to move.

- [ ] **Step 1: Read PerfectScheduleModal to find the onApply prop type and usage**

Read the file to find:
1. The `onApply` prop signature
2. Where `onApply` is called
3. Where `PerfectScheduleResult` is available

- [ ] **Step 2: Update the onApply prop type**

Add `changes` to the onApply callback signature:

```typescript
onApply: (
  assignments: Map<string, number>,
  recurrenceMap: Map<string, string>,
  rotations: Map<string, number>,
  startDate: Date,
  changes: Array<{ clientId: string; clientName: string; fromDay: number; toDay: number }>,
) => void
```

- [ ] **Step 3: Pass changes when calling onApply**

Where `onApply` is called, add the `changes` from the PerfectScheduleResult:

```typescript
onApply(result.assignments, recMap, result.rotations, startDate, result.changes)
```

- [ ] **Step 4: Verify types compile**

Run: `cd /Users/anthonydragone/Developer/pip-web/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
cd /Users/anthonydragone/Developer/pip-web
git add web/src/components/PerfectScheduleModal.tsx web/src/pages/Schedule.tsx
git commit -m "feat: pass changes from PerfectScheduleModal to enable transition"
```

---

### Task 6: Handle Stale Transition on Client Roster Change

**Files:**
- Modify: `web/src/components/TransitionView.tsx`

If the user adds/removes a client while a transition is active, mark it stale and prompt re-generation.

- [ ] **Step 1: Add roster change detection**

In `TransitionView`, add a `useMemo` to detect if the client list has changed since the transition started:

```typescript
const isStale = useMemo(() => {
  // Check if any move references a client that no longer exists
  const currentIds = new Set(clients.map(c => c.id))
  return state.moves.some(m => !currentIds.has(m.clientId))
}, [clients, state.moves])
```

- [ ] **Step 2: Add stale banner to the UI**

Add this right after the stats bar div, before the move list:

```typescript
{isStale && (
  <div className="mx-2 mt-2 p-2 bg-red-50 rounded-lg border border-red-200">
    <p className="text-[10px] text-red-700 font-medium">Client list changed</p>
    <p className="text-[9px] text-red-600 mt-0.5">Some clients in this plan were added or removed.</p>
    <button
      onClick={clearTransition}
      className="mt-1.5 w-full px-2 py-1 text-[9px] font-medium text-red-700 bg-red-100 rounded hover:bg-red-200"
    >
      Start fresh
    </button>
  </div>
)}
```

- [ ] **Step 3: Verify types compile**

Run: `cd /Users/anthonydragone/Developer/pip-web/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
cd /Users/anthonydragone/Developer/pip-web
git add web/src/components/TransitionView.tsx
git commit -m "feat: detect stale transition when client roster changes"
```

---

### Task 7: Handle Max Jobs Exceeded Warning

**Files:**
- Modify: `web/src/components/TransitionView.tsx`

When a rejection locks a client on a day that now exceeds max jobs/day, surface a warning.

- [ ] **Step 1: Add max jobs check**

Add a `useMemo` after the existing stats:

```typescript
const overloadedDays = useMemo(() => {
  if (state.config.maxJobsPerDay <= 0) return []

  // Count clients per day (reflecting confirmed moves)
  const dayCounts = new Map<number, number>()
  for (const [, day] of clientDayMap) {
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1)
  }

  const warnings: Array<{ day: number; count: number }> = []
  for (const [day, count] of dayCounts) {
    if (count > state.config.maxJobsPerDay) {
      warnings.push({ day, count })
    }
  }
  return warnings
}, [clientDayMap, state.config.maxJobsPerDay])
```

- [ ] **Step 2: Add warning banner**

Add after the stale banner, before the move list:

```typescript
{overloadedDays.length > 0 && (
  <div className="mx-2 mt-2 p-2 bg-amber-50 rounded-lg border border-amber-200">
    <p className="text-[10px] text-amber-700 font-medium">Day overload</p>
    {overloadedDays.map(({ day, count }) => (
      <p key={day} className="text-[9px] text-amber-600 mt-0.5">
        {DAYS_FULL[day]} has {count} jobs (max {state.config.maxJobsPerDay})
      </p>
    ))}
  </div>
)}
```

- [ ] **Step 3: Verify types compile**

Run: `cd /Users/anthonydragone/Developer/pip-web/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
cd /Users/anthonydragone/Developer/pip-web
git add web/src/components/TransitionView.tsx
git commit -m "feat: warn when day exceeds max jobs after rejection"
```

---

### Task 8: Integration Test — Full Flow Verification

**Files:**
- No new files — manual verification

- [ ] **Step 1: Start dev server**

Run: `cd /Users/anthonydragone/Developer/pip-web/web && npm run dev`

- [ ] **Step 2: Verify the full flow**

1. Open the Schedule page
2. Ensure clients are placed on the calendar
3. Click "Perfect Schedule" — complete the wizard
4. Verify the onApply now creates a transition instead of immediately applying
5. Verify the "Transition Plan" button appears (orange) and opens the TransitionView sidebar
6. Verify move cards show with correct client names, days, and status buttons
7. Mark a move as "Confirmed" — verify it applies to the calendar immediately
8. Mark a move as "Can't Move" — verify re-optimization runs (loading spinner) and moves update
9. Verify the "updated" badge appears on re-optimized moves
10. Verify stats bar updates correctly
11. Close and reopen the transition — verify state persists from localStorage
12. Verify "Close enough" message appears when remaining savings are negligible

- [ ] **Step 3: Commit any fixes**

```bash
cd /Users/anthonydragone/Developer/pip-web
git add -A
git commit -m "fix: integration fixes for transition plan flow"
```

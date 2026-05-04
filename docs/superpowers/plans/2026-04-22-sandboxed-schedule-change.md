# Sandboxed Schedule Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the destructive cutover out of "Apply to Schedule" on the Builder and into a final "Apply" inside the Transition workspace, so the live calendar (and mobile sync) stays untouched until the user commits a fully confirmed plan.

**Architecture:** Introduce a `SchedulePlan` state object that captures Builder output without mutating the live schedule. Transition UI reads/writes the plan only. The existing `applyNewScheduleFromBuilder` cutover logic moves behind a new `commitSchedulePlan` store action, triggered by a final Apply button inside the Transition workspace. The Builder's own "Apply" becomes a non-destructive handoff.

**Tech Stack:** Vite + React + TypeScript, React context store, localStorage persistence, Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-04-22-sandboxed-schedule-change-design.md`

---

## File Structure

**Modified:**
- `web/src/types.ts` — add `SchedulePlan`, `PlanClient` types
- `web/src/store.tsx` — add `createSchedulePlan`, `commitSchedulePlan`, `discardSchedulePlan`, `schedulePlan` state; refactor `applyNewScheduleFromBuilder` into an internal helper
- `web/src/pages/ScheduleBuilder.tsx` — rename button, strip cutover-date picker and destructive call from `confirmApply`, create plan + navigate
- `web/src/pages/Schedule.tsx` — detect active plan, pass to TransitionView
- `web/src/components/TransitionView.tsx` — remove live side-effects from confirm/swap handlers, add final Apply button, inline cutover modal, roster-drift banner

**Created:**
- `web/src/__tests__/schedule-plan.test.ts` — store action tests

---

## Task 1: Add SchedulePlan types

**Files:**
- Modify: `web/src/types.ts`

- [ ] **Step 1: Add new types**

Append to `web/src/types.ts` (below the existing `TransitionState` type):

```ts
/** A sandboxed draft schedule produced by Schedule Builder. Lives in
 *  localStorage and does NOT mutate the live schedule until committed. */
export type SchedulePlan = {
  id: string                       // uuid, matches the old applyId
  createdAt: string                // ISO
  status: 'active' | 'committed' | 'discarded'

  // Builder snapshot — frozen at plan creation.
  builderAssignments: Array<[string, number]>   // clientId → dayOfWeek (-1 = benched, excluded)
  builderRotations: Array<[string, number]>     // clientId → rotation (0=A, 1=B)
  builderRecurrence: Array<[string, Frequency]> // clientId → frequency
  builderIntervalWeeks: Array<[string, number]> // clientId → intervalWeeks

  // Roster at plan creation — used to detect drift (clients added/removed later).
  rosterSnapshot: string[]

  // Per-client plan state. Drives TransitionView confirm/swap semantics.
  clients: PlanClient[]
}

export type PlanClient = {
  clientId: string
  plannedDay: number               // current target day (mutates on swap)
  originalPlannedDay: number       // Builder's original assignment (immutable)
  plannedRotation: 0 | 1
  status: 'pending' | 'confirmed'
  swapPartnerClientId: string | null
}
```

- [ ] **Step 2: Verify project still type-checks**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add web/src/types.ts
git commit -m "feat: add SchedulePlan type for sandboxed Schedule Change"
```

---

## Task 2: Add plan-creation store action (no live writes)

**Files:**
- Modify: `web/src/store.tsx`
- Test: `web/src/__tests__/schedule-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/schedule-plan.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSchedulePlan } from '../store'
import type { Client } from '../types'

const mkClient = (id: string, name: string): Client => ({
  id,
  name,
  address: '1 Main St',
  phone: '',
  notes: '',
  avatarColor: '#000',
  latitude: 0,
  longitude: 0,
  rate: 0,
  frequency: 'weekly',
  startDate: '2026-01-05',
  intervalWeeks: 1,
  exceptions: [],
})

describe('buildSchedulePlan', () => {
  it('captures Builder output without mutating inputs', () => {
    const clients = [mkClient('a', 'Alice'), mkClient('b', 'Bob')]
    const assignments = new Map<string, number>([['a', 1], ['b', 3]])
    const rotations = new Map<string, number>([['a', 0], ['b', 1]])
    const rec = new Map<string, Client['frequency']>([['a', 'weekly'], ['b', 'biweekly']])
    const intervals = new Map<string, number>([['a', 1], ['b', 2]])

    const plan = buildSchedulePlan(clients, assignments, rotations, rec, intervals)

    expect(plan.status).toBe('active')
    expect(plan.rosterSnapshot).toEqual(['a', 'b'])
    expect(plan.clients).toHaveLength(2)
    expect(plan.clients[0]).toMatchObject({
      clientId: 'a',
      plannedDay: 1,
      originalPlannedDay: 1,
      plannedRotation: 0,
      status: 'pending',
    })
  })

  it('excludes benched clients (day = -1)', () => {
    const clients = [mkClient('a', 'Alice'), mkClient('b', 'Bob')]
    const assignments = new Map<string, number>([['a', 1], ['b', -1]])
    const rotations = new Map<string, number>([['a', 0], ['b', 0]])
    const rec = new Map<string, Client['frequency']>([['a', 'weekly'], ['b', 'weekly']])
    const intervals = new Map<string, number>([['a', 1], ['b', 1]])

    const plan = buildSchedulePlan(clients, assignments, rotations, rec, intervals)

    expect(plan.clients.map(c => c.clientId)).toEqual(['a'])
    expect(plan.rosterSnapshot).toEqual(['a', 'b']) // roster includes all active clients
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/schedule-plan.test.ts`
Expected: FAIL — `buildSchedulePlan` not exported.

- [ ] **Step 3: Implement `buildSchedulePlan` as a pure helper**

Add to `web/src/store.tsx` (near the other exports, before the provider):

```ts
export function buildSchedulePlan(
  clients: Client[],
  assignments: Map<string, number>,
  rotations: Map<string, number>,
  recurrence: Map<string, Client['frequency']>,
  intervalWeeks: Map<string, number>,
): SchedulePlan {
  const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
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
```

Also import the new types at the top of the file:

```ts
import type { Client, Placement, ScheduleMeta, Frequency, SchedulePlan, PlanClient } from './types'
```

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/__tests__/schedule-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/store.tsx web/src/__tests__/schedule-plan.test.ts
git commit -m "feat: buildSchedulePlan captures Builder output without live writes"
```

---

## Task 3: Add plan state + load/save + create/discard actions

**Files:**
- Modify: `web/src/store.tsx`

- [ ] **Step 1: Add storage constants and helpers**

Near the top of `web/src/store.tsx` (in the storage-keys area), add:

```ts
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
```

- [ ] **Step 2: Add plan state to the provider**

Inside the store provider, alongside other `useState` declarations:

```ts
const [schedulePlan, setSchedulePlanState] = useState<SchedulePlan | null>(() => loadSchedulePlan())

const setSchedulePlan = (plan: SchedulePlan | null) => {
  setSchedulePlanState(plan)
  saveSchedulePlan(plan)
}
```

- [ ] **Step 3: Add `createSchedulePlan` and `discardSchedulePlan` actions**

Inside the provider body:

```ts
/** Build a plan from Builder output and activate it. NO live-schedule
 *  writes happen here — the plan is a draft until commitSchedulePlan runs. */
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
```

- [ ] **Step 4: Expose the new state + actions in the store's context value**

Find the `value = { ... }` object returned from the provider and add:

```ts
schedulePlan,
createSchedulePlan,
discardSchedulePlan,
updateSchedulePlan,
```

Also extend the store's TypeScript context type (near the top of the file where other methods are declared) to include these members.

- [ ] **Step 5: Verify compile**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/store.tsx
git commit -m "feat: add SchedulePlan state with create/discard actions"
```

---

## Task 4: Add `commitSchedulePlan` — atomic cutover

**Files:**
- Modify: `web/src/store.tsx`

Rationale: the commit reuses the existing `applyNewScheduleFromBuilder` + `reanchorClient` pipeline that already handles freeze-window, placements, and undo snapshot. No new pure helper needed. Manual verification in Task 12 covers behavior; unit-testing commit requires mocking the full store state and isn't worth the overhead for this refactor.

- [ ] **Step 1: Wire `commitSchedulePlan` action**

Inside the provider body (next to `createSchedulePlan`):

```ts
/** Atomically commit the active plan to the live schedule at `cutoverDate`.
 *  Mirrors the old applyNewScheduleFromBuilder behavior but reads placements
 *  from the plan rather than a fresh Builder output. */
const commitSchedulePlan = (cutoverDate: Date): boolean => {
  if (!schedulePlan || schedulePlan.status !== 'active') return false
  // All plan clients must be confirmed before commit.
  if (schedulePlan.clients.some(c => c.status !== 'confirmed')) return false

  const assignments = new Map<string, number>(
    schedulePlan.clients.map(c => [c.clientId, c.plannedDay]),
  )
  const rotations = new Map<string, number>(
    schedulePlan.clients.map(c => [c.clientId, c.plannedRotation]),
  )
  const recurrence = new Map<string, Client['frequency']>(schedulePlan.builderRecurrence)
  const intervalWeeks = new Map<string, number>(schedulePlan.builderIntervalWeeks)

  // Reuse the existing cutover machinery — it already handles freeze of
  // pre-cutover dates, placement cleanup, and undo snapshot.
  applyNewScheduleFromBuilder(assignments, recurrence, rotations, intervalWeeks, cutoverDate)

  // After the cutover, anchor each confirmed client onto their plan day so
  // the new schedule is fully populated (no per-client reanchor required
  // from the user).
  for (const pc of schedulePlan.clients) {
    reanchorClient(
      pc.clientId,
      pc.plannedDay,
      pc.plannedRotation,
      cutoverDate,
      recurrence.get(pc.clientId) ?? 'weekly',
    )
  }

  setSchedulePlan(null)
  return true
}
```

**Important:** This is the ONE place `applyNewScheduleFromBuilder` is called going forward. Do NOT call it from ScheduleBuilder's confirm anymore (Task 5 removes that caller).

- [ ] **Step 2: Add `commitSchedulePlan` to the store's exposed value + context type**

- [ ] **Step 3: Verify compile + tests**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/store.tsx
git commit -m "feat: commitSchedulePlan runs the atomic cutover from plan state"
```

---

## Task 5: Rewire ScheduleBuilder's Apply — create plan, skip live writes

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

- [ ] **Step 1: Replace the `confirmApply` body**

In `web/src/pages/ScheduleBuilder.tsx` around line 927, replace the current `confirmApply` with:

```ts
const confirmApply = () => {
  if (!result) return
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
  navigate('/schedule', {
    state: {
      transitionMoves: moves,
      transitionRecMap: Object.fromEntries(recMap),
      transitionRotations: Object.fromEntries(result.rotations),
      transitionConfig: { maxJobsPerDay, workingDays },
      planId,
    },
  })
}
```

Note removed: `startDate` in navigation state (cutover date is now picked inside Transition). Also removed: the `applyNewScheduleFromBuilder` call.

- [ ] **Step 2: Remove cutover-date picker from the Builder modal**

In `web/src/pages/ScheduleBuilder.tsx` around lines 1237–1293 (the "Start date picker — re-confirmed here because apply is a cutover" block), delete the entire `<div className="mb-5">...</div>` that wraps the Today / Next Monday / custom picker.

Also remove the "Jobs before X" and "From that date forward..." and "Heads up" paragraphs at lines 1294–1303 — those belong on the final Apply modal in Transition, not here.

Replace with a short non-destructive summary:

```tsx
<div className="text-xs text-gray-500 mb-5">
  <p>
    This opens the Schedule Change workspace where you'll confirm each client.
    Your live calendar stays unchanged until you finish and apply.
  </p>
</div>
```

- [ ] **Step 3: Rename button text**

At lines 1207 and 1220 change:

```tsx
Apply to Schedule
```
to
```tsx
Start Schedule Change
```

And the modal heading at line 1220:

```tsx
<h3 className="text-lg font-bold text-gray-900 mb-4">Start Schedule Change?</h3>
```

- [ ] **Step 4: Verify compile**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx
git commit -m "feat: Builder 'Start Schedule Change' creates plan without live writes"
```

---

## Task 6: Resume detection — route to Transition if plan is active

**Files:**
- Modify: `web/src/pages/ScheduleBuilder.tsx`

- [ ] **Step 1: Replace `pip-transition-context` detection with `pip-schedule-plan` check**

Find the `getActiveChange` function around line 52. Replace its body with a check for the new key:

```ts
function getActiveChange(): ActiveChangeSummary | null {
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
```

- [ ] **Step 2: Replace `clearActiveChange` to clear the plan key**

Find `clearActiveChange` around line 72. Replace:

```ts
function clearActiveChange(_applyId: string) {
  try {
    localStorage.removeItem('pip-schedule-plan')
  } catch { /* */ }
}
```

- [ ] **Step 3: Verify Builder still blocks re-apply while plan active**

Run the dev server (`cd web && npm run dev`), open Builder, simulate an active plan by setting `localStorage.setItem('pip-schedule-plan', JSON.stringify({ id: 'x', status: 'active', clients: [{status:'pending'},{status:'pending'}] }))` in DevTools, reload Builder. The "Apply blocked" button should appear.

Expected: Apply is blocked; user sees "Go to Schedule" option.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/ScheduleBuilder.tsx
git commit -m "feat: Builder resume detection reads pip-schedule-plan"
```

---

## Task 7: Rewire TransitionView — confirm/swap update plan, not live schedule

**Files:**
- Modify: `web/src/components/TransitionView.tsx`

- [ ] **Step 1: Replace local `TransitionState` usage with `SchedulePlan`**

TransitionView currently owns its own state via `useState<TransitionState>` and calls `onConfirm`/`onUnconfirm` props which reanchor/unplace on the live schedule. Rewire to read from `store.schedulePlan` and call `store.updateSchedulePlan` instead.

At the top of the component, replace:

```ts
const [state, setState] = useState<TransitionState>(() => { ... })
```

with:

```ts
const plan = store.schedulePlan
if (!plan) { onClose(); return null }
const state = planToTransitionState(plan, initialMoves, config)
const setState = (updater: (prev: TransitionState) => TransitionState) => {
  const next = updater(state)
  store.updateSchedulePlan(p => transitionStateToPlan(next, p))
}
```

Add helper functions at the top of the file (below imports):

```ts
// Convert a SchedulePlan + original move list into the TransitionState shape
// the view already understands. `initialMoves` provides suggestedMessage,
// reason, etc. that the plan doesn't store.
function planToTransitionState(
  plan: SchedulePlan,
  initialMoves: TransitionMove[],
  config: { maxJobsPerDay: number; workingDays: boolean[] },
): TransitionState {
  const byId = new Map(initialMoves.map(m => [m.clientId, m]))
  const moves: TransitionMove[] = plan.clients.map(pc => {
    const base = byId.get(pc.clientId)
    if (!base) throw new Error(`No initial move for client ${pc.clientId}`)
    return {
      ...base,
      suggestedDay: pc.plannedDay,
      targetRotation: pc.plannedRotation,
      status: pc.status === 'confirmed' ? 'confirmed' : 'to-ask',
      locked: pc.status === 'confirmed',
      swapPartnerClientId: pc.swapPartnerClientId,
    }
  })
  return {
    moves,
    lockedClientIds: plan.clients.filter(c => c.status === 'confirmed').map(c => c.clientId),
    iteration: 0,
    status: 'active',
    startedAt: plan.createdAt,
    config,
  }
}

function transitionStateToPlan(ts: TransitionState, prev: SchedulePlan): SchedulePlan {
  const planById = new Map(prev.clients.map(c => [c.clientId, c]))
  const nextClients: PlanClient[] = ts.moves.map(m => {
    const existing = planById.get(m.clientId)
    return {
      clientId: m.clientId,
      plannedDay: m.suggestedDay,
      originalPlannedDay: existing?.originalPlannedDay ?? m.suggestedDay,
      plannedRotation: m.targetRotation,
      status: m.status === 'confirmed' ? 'confirmed' : 'pending',
      swapPartnerClientId: m.swapPartnerClientId ?? null,
    }
  })
  return { ...prev, clients: nextClients }
}
```

- [ ] **Step 2: Remove calls to `onConfirm` / `onUnconfirm` for live-schedule side effects**

Search `TransitionView.tsx` for every `onConfirm?.(` and `onUnconfirm?.(` call. In each handler that commits a plan-state change (confirm a client, swap, un-swap), DELETE the `onConfirm`/`onUnconfirm` call. The plan-state update (via `setState`) is the only write that should happen.

The confirm path in the current code roughly looks like:

```ts
onConfirm?.(move.clientId, move.suggestedDay, move.targetRotation)
setState(prev => ({ ...prev, /* locked=true, status=confirmed */ }))
```

After this task it should be:

```ts
setState(prev => ({ ...prev, /* locked=true, status=confirmed */ }))
```

(Same for unconfirm / swap: remove the live-writes, keep the state mutation.)

- [ ] **Step 3: Keep the old per-applyId localStorage legacy dead code OUT of the way**

Delete the now-dead functions `loadPersistedState`, `savePersistedState`, `buildFreshState` and the `PERSIST_PREFIX` / `STORAGE_KEY` / `TEMPLATE_STORAGE_KEY` constants at lines 51–140. Also delete the `applyId` prop + any key-keyed localStorage writes. Plan persistence comes from the store now.

- [ ] **Step 4: Verify compile**

Run: `cd web && npx tsc --noEmit`
Expected: PASS. If errors point to removed props, trace callers and update — usually `Schedule.tsx` passes the props.

- [ ] **Step 5: Verify dev manual test**

Start dev server, run Schedule Builder → Start Schedule Change → confirm a client. Open DevTools: `pip-schedule-plan` should show `clients[i].status === 'confirmed'`. Real schedule untouched.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/TransitionView.tsx
git commit -m "refactor: TransitionView reads/writes SchedulePlan, no live writes"
```

---

## Task 8: Add final "Apply to Schedule" button + cutover modal in Transition

**Files:**
- Modify: `web/src/components/TransitionView.tsx`

- [ ] **Step 1: Add the final-apply state + button**

Near the existing `showFinishConfirm` state, add:

```ts
const [showFinalApply, setShowFinalApply] = useState(false)
const [cutoverDate, setCutoverDate] = useState<Date>(() => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const daysUntilMon = day === 1 ? 7 : (8 - day) % 7 || 7
  const mon = new Date(d)
  mon.setDate(d.getDate() + daysUntilMon)
  return mon
})

const allConfirmed = state.moves.every(m => m.status === 'confirmed')
```

- [ ] **Step 2: Render the Apply button (enabled only when all confirmed)**

Near the existing "Finish" / "Reset" buttons (around lines 670–690 and 770–790), add:

```tsx
<button
  onClick={() => setShowFinalApply(true)}
  disabled={!allConfirmed}
  title={allConfirmed ? 'Apply this schedule to your calendar' : 'Confirm every client first'}
  className={`w-full px-3 py-2 text-xs font-bold rounded-lg transition-colors ${
    allConfirmed
      ? 'bg-purple-600 text-white hover:bg-purple-700 shadow-sm'
      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
  }`}
>
  Apply to Schedule
</button>
```

- [ ] **Step 3: Render the cutover modal**

Below the existing `{showFinishConfirm && ...}` modal, add a new block:

```tsx
{showFinalApply && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowFinalApply(false)}>
    <div className="bg-white rounded-xl shadow-2xl w-[400px] p-6" onClick={e => e.stopPropagation()}>
      <h3 className="text-lg font-bold text-gray-900 mb-4">Apply Schedule?</h3>
      <div className="space-y-2 mb-5">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Clients changing days</span>
          <span className="font-semibold text-gray-900">{state.moves.length}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Total clients</span>
          <span className="font-semibold text-gray-900">{state.moves.length}</span>
        </div>
      </div>
      <CutoverDatePicker value={cutoverDate} onChange={setCutoverDate} />
      <div className="text-xs text-gray-500 my-5 space-y-1.5">
        <p>
          Jobs before <span className="font-semibold text-gray-700">{cutoverDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span> stay on the calendar as-is.
        </p>
        <p>From that date forward, this schedule replaces everything — any client not in this builder stops recurring.</p>
      </div>
      <div className="flex gap-2">
        <button onClick={() => setShowFinalApply(false)} className="flex-1 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
        <button
          onClick={() => {
            const ok = store.commitSchedulePlan(cutoverDate)
            if (ok) {
              setShowFinalApply(false)
              onClose()
            }
          }}
          className="flex-1 px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700"
        >
          Apply
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 4: Extract `CutoverDatePicker` as a small internal component**

At the bottom of `TransitionView.tsx`, extract the Today / Next Monday / custom-date picker lifted from `ScheduleBuilder.tsx:1239–1292`. Keep it identical visually. It takes `{ value: Date; onChange: (d: Date) => void }`.

- [ ] **Step 5: Verify compile + manual test**

Run: `cd web && npx tsc --noEmit`
Start dev server. Build → Start Schedule Change → confirm all clients → click Apply to Schedule → pick date → Apply. Verify live calendar now has the new recurrences starting from the cutover date, and `pip-schedule-plan` is cleared.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/TransitionView.tsx
git commit -m "feat: final Apply to Schedule inside Transition workspace"
```

---

## Task 9: Roster-drift banner

**Files:**
- Modify: `web/src/components/TransitionView.tsx`

- [ ] **Step 1: Add drift detection**

Near the top of the component (after `plan` is pulled from the store):

```ts
const rosterDrift = useMemo(() => {
  if (!plan) return { added: [] as string[], removed: [] as string[] }
  const current = new Set(store.clients.map(c => c.id))
  const snapshot = new Set(plan.rosterSnapshot)
  const added = [...current].filter(id => !snapshot.has(id))
  const removed = [...snapshot].filter(id => !current.has(id))
  return { added, removed }
}, [plan, store.clients])
```

- [ ] **Step 2: Render the banner**

Near the top of the Transition sidebar (before the move list), render:

```tsx
{(rosterDrift.added.length > 0 || rosterDrift.removed.length > 0) && (
  <div className="mx-3 mb-2 p-2 bg-amber-50 border border-amber-200 rounded-md text-[11px] text-amber-800">
    Your client list changed since this plan was created.
    {rosterDrift.added.length > 0 && <div>Added: {rosterDrift.added.length} client(s)</div>}
    {rosterDrift.removed.length > 0 && <div>Removed: {rosterDrift.removed.length} client(s)</div>}
    <div className="mt-1 text-amber-700">Regenerate the plan to include them, or continue with the current list.</div>
  </div>
)}
```

- [ ] **Step 3: Verify compile**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Manual test**

Start dev server. Create a plan (don't apply). Go to Clients page and add a new client. Return to Schedule. Banner should appear.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TransitionView.tsx
git commit -m "feat: roster drift banner in Schedule Change workspace"
```

---

## Task 10: Wire Schedule page to pass plan → TransitionView

**Files:**
- Modify: `web/src/pages/Schedule.tsx`

- [ ] **Step 1: Replace the local `TransitionState` reducer with plan-driven rendering**

`Schedule.tsx` currently owns a `transitionReducer`/`TransitionState` and passes it to `TransitionView`. Since TransitionView now reads from the store's plan directly, this local state is redundant. Simplify:

- Remove the `transitionReducer`, `TransitionState` type alias (lines 177–228), and `loadTransitionCtx` / `saveTransitionCtx` / `TRANSITION_CTX_KEY` constants (lines 194–268).
- Remove the `useReducer(transitionReducer, ...)` call at line 401.
- Where `<TransitionView ... />` is rendered, simplify props to only what the component still requires (initial moves, config, onClose). The component reads the plan itself.

- [ ] **Step 2: Ensure navigation state from Builder is consumed once**

When the user navigates from Builder with `state.planId`, Schedule should open the Transition panel automatically. Add a `useEffect` on mount:

```ts
useEffect(() => {
  const navState = location.state as {
    transitionMoves?: TransitionMove[]
    transitionRecMap?: Record<string, string>
    transitionRotations?: Record<string, number>
    transitionConfig?: { maxJobsPerDay: number; workingDays: boolean[] }
    planId?: string
  } | null
  if (navState?.planId) {
    setShowTransition(true)
    setInitialMoves(navState.transitionMoves ?? [])
    setTransitionConfig(navState.transitionConfig ?? { maxJobsPerDay: 5, workingDays: [false,true,true,true,true,true,false] })
    // Clear nav state so reloads don't re-trigger
    window.history.replaceState({}, '')
  } else if (store.schedulePlan) {
    // Direct route with active plan — resume
    setShowTransition(true)
  }
}, [])
```

- [ ] **Step 3: Verify compile + manual test**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

Manual: Build → Apply from Builder → lands on Schedule with Transition open. Close tab, reopen — Schedule shows Transition open again (from plan detection).

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Schedule.tsx
git commit -m "feat: Schedule page drives Transition from SchedulePlan"
```

---

## Task 11: Clean up legacy storage keys

**Files:**
- Modify: `web/src/pages/Schedule.tsx`, `web/src/store.tsx`

- [ ] **Step 1: On first load, migrate/discard old transition state**

Somewhere early in the store initialization (or in `Schedule.tsx` on mount), once per session:

```ts
// One-time cleanup of legacy transition keys. A new plan always starts
// from pip-schedule-plan; stale per-applyId state can't be recovered.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (!key) continue
    if (key.startsWith('pip-transition-state-') || key === 'pip-transition-context' || key === 'pip-transition-apply-id' || key === 'pip-transition') {
      localStorage.removeItem(key)
    }
  }
} catch { /* ignore */ }
```

Place it behind a sessionStorage flag so it only runs once per session:

```ts
if (!sessionStorage.getItem('pip-plan-migration-v1')) {
  // ...cleanup...
  sessionStorage.setItem('pip-plan-migration-v1', '1')
}
```

- [ ] **Step 2: Remove the `pip-transition` key from the Schedule.tsx "clear all" list at line 451**

That line already lists keys cleared by a user action. Replace `'pip-transition'` with `'pip-schedule-plan'`.

- [ ] **Step 3: Verify compile**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Schedule.tsx web/src/store.tsx
git commit -m "chore: clean up legacy transition storage keys"
```

---

## Task 12: End-to-end manual verification

**Files:** none

- [ ] **Step 1: Full happy path**

1. Start with a clean schedule (multiple clients with recurrences).
2. Open Schedule Builder, configure, generate a plan.
3. Click "Start Schedule Change" — confirm modal shows; no cutover date picker.
4. Click the modal's "Apply" — navigate to Schedule, Transition panel open, live calendar unchanged.
5. Confirm a few clients — `pip-schedule-plan` updates; live calendar still unchanged.
6. Reload the browser — Transition panel reopens with confirmed clients preserved. Live calendar still unchanged.
7. Confirm all clients; "Apply to Schedule" button lights up.
8. Click it, pick a cutover date, click Apply.
9. Live calendar now shows the new schedule starting from the cutover date. Old recurrences stop at cutover-1. Pre-cutover past jobs are frozen as one-offs. `pip-schedule-plan` is cleared.

- [ ] **Step 2: Discard path**

1. Start a plan, confirm a few clients.
2. Click Discard plan.
3. Live calendar is unchanged from step 0.

- [ ] **Step 3: Roster drift**

1. Start a plan.
2. Add a client via Clients page.
3. Return to Schedule — banner appears.

- [ ] **Step 4: Swap path**

1. Start a plan, confirm some clients.
2. Mark one as "Can't Move", pick a swap partner, confirm swap.
3. Both swapped clients return to pending. `pip-schedule-plan.clients[i].plannedDay` reflects the swap.
4. Re-confirm both. Final apply still works.

- [ ] **Step 5: Builder blocked while plan active**

1. With an active plan, open Schedule Builder.
2. Apply button shows "Apply blocked" with resume CTA.

---

## Out of scope

- Multiple concurrent plans
- Post-commit undo/rollback (beyond the existing `UNDO_KEY` snapshot which still runs inside `commitSchedulePlan`)
- Hard-blocking Apply on roster drift
- Mid-plan client edits inside the workspace
- Server-side plan sync

# Route-Based Savings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the average-to-group proxy in the optimizer with route-based insertion/removal cost calculations so displayed savings reflect actual drive time changes.

**Architecture:** Pre-compute a nearest-neighbor TSP route for each day's clients using the ORS matrix. For each proposed move, compute the exact removal savings (skip the client in the route, reconnect neighbors) and cheapest insertion cost (best position in target day's route). For perfect world estimates, use VROOM's returned route durations instead of pairwise sums. The swap pair logic accounts for the outgoing client already being absent from the target route.

**Tech Stack:** Vitest (new), existing ORS Matrix + VROOM integration

---

## What's Wrong Today

The current `computeSavings` function uses **average drive time to all clients on a day** as a proxy for route efficiency:

```
savings = (avgDriveToCurrentDayPeers - avgDriveToTargetDayPeers) x 2
```

This is a clustering metric, not a route metric. A client perfectly positioned between two Monday stops (adding 2 min to the route) shows the same "average" as one that's a 20-min dead-end detour. The `x 2` multiplier is a hand-wave, not derived from anything.

## What We're Building

**Route-based savings:** compute an actual route order (nearest-neighbor TSP) for each day, then measure:
- **Removal savings** = the detour cost this client adds to their current day's route (reconnect predecessor ↔ successor)
- **Insertion cost** = cheapest position to add the client in the target day's route
- **Net savings** = removal savings - insertion cost

This gives a concrete answer: "removing this client shortens Monday's route by 12 min, adding them to Tuesday costs 3 min → saves 9 min/wk."

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `web/src/optimizer.ts` | Modify | Replace proxy functions with route primitives; update pipeline |
| `web/src/__tests__/optimizer.test.ts` | Create | Test route primitives and move savings |
| `web/package.json` | Modify | Add vitest |
| `web/vite.config.ts` | Modify | Add vitest config |

`OptimizeView.tsx` needs **zero changes** — it consumes `ProposedMove.savingsMinutes` and `ProposedMove.reason` which keep the same types. Only the values become more accurate.

---

### Task 1: Add Vitest

**Files:**
- Modify: `web/package.json`
- Modify: `web/vite.config.ts`

- [ ] **Step 1: Install vitest**

```bash
cd web && npm install -D vitest
```

- [ ] **Step 2: Add test script to package.json**

Add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Add vitest config to vite.config.ts**

```typescript
/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    globals: true,
  },
})
```

- [ ] **Step 4: Verify vitest runs**

```bash
cd web && npx vitest run
```

Expected: "No test files found" or clean zero-test output. No errors.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/vite.config.ts
git commit -m "chore: add vitest for optimizer tests"
```

---

### Task 2: Route Cost Primitives + Tests

**Files:**
- Modify: `web/src/optimizer.ts` (add 4 new exported functions after line 19)
- Create: `web/src/__tests__/optimizer.test.ts`

These are pure functions on a distance matrix. No API calls. No DOM. Fast to test.

- [ ] **Step 1: Write failing tests for all 4 primitives**

Create `web/src/__tests__/optimizer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  solveRoute,
  routeCost,
  removalSavings,
  cheapestInsertionCost,
} from '../optimizer'

// 4-client matrix (minutes). Symmetric.
// Layout: A(0) and B(1) are close (2 min apart).
//         C(2) and D(3) are close (3 min apart).
//         The two clusters are ~20 min apart.
//
//    A    B    C    D
// A  0    2   20   22
// B  2    0   18   20
// C  20  18    0    3
// D  22  20    3    0
const matrix = [
  [0,  2, 20, 22],
  [2,  0, 18, 20],
  [20, 18,  0,  3],
  [22, 20,  3,  0],
]

describe('solveRoute', () => {
  it('returns empty for no clients', () => {
    const result = solveRoute([], matrix)
    expect(result.order).toEqual([])
    expect(result.cost).toBe(0)
  })

  it('returns single client with zero cost', () => {
    const result = solveRoute([2], matrix)
    expect(result.order).toEqual([2])
    expect(result.cost).toBe(0)
  })

  it('finds optimal order for two clusters', () => {
    // Optimal open path: A-B-C-D or reverse (cost = 2 + 18 + 3 = 23)
    // NOT A-C-B-D (cost = 20 + 18 + 20 = 58)
    const result = solveRoute([0, 1, 2, 3], matrix)
    expect(result.cost).toBe(23)
  })

  it('handles two clients', () => {
    const result = solveRoute([0, 1], matrix)
    expect(result.cost).toBe(2)
    expect(result.order).toHaveLength(2)
  })
})

describe('routeCost', () => {
  it('sums sequential edges in order', () => {
    expect(routeCost([0, 1, 2, 3], matrix)).toBe(2 + 18 + 3) // 23
    expect(routeCost([0, 2, 1, 3], matrix)).toBe(20 + 18 + 20) // 58
  })

  it('returns 0 for single or empty route', () => {
    expect(routeCost([], matrix)).toBe(0)
    expect(routeCost([2], matrix)).toBe(0)
  })
})

describe('removalSavings', () => {
  it('saves the detour cost of a middle client', () => {
    // Route: [0, 2, 1, 3]. Remove 2 (C, wedged between A and B).
    // Before: A->C(20) + C->B(18) = 38
    // After:  A->B(2)
    // Savings: 38 - 2 = 36
    expect(removalSavings(2, [0, 2, 1, 3], matrix)).toBe(36)
  })

  it('returns 0 when client is efficiently placed', () => {
    // Route: [0, 1, 2, 3]. Remove 1 (B, between A and C).
    // Before: A->B(2) + B->C(18) = 20
    // After:  A->C(20)
    // Savings: 20 - 20 = 0
    expect(removalSavings(1, [0, 1, 2, 3], matrix)).toBe(0)
  })

  it('saves the first edge when removing first client', () => {
    // Route: [0, 1, 2]. Remove 0.
    // Savings = dist(0,1) = 2
    expect(removalSavings(0, [0, 1, 2], matrix)).toBe(2)
  })

  it('saves the last edge when removing last client', () => {
    // Route: [0, 1, 2]. Remove 2.
    // Savings = dist(1,2) = 18
    expect(removalSavings(2, [0, 1, 2], matrix)).toBe(18)
  })

  it('returns 0 for single-client route', () => {
    expect(removalSavings(0, [0], matrix)).toBe(0)
  })
})

describe('cheapestInsertionCost', () => {
  it('returns 0 for empty route (first client on day)', () => {
    expect(cheapestInsertionCost(0, [], matrix)).toBe(0)
  })

  it('returns distance to single existing client', () => {
    // Insert A(0) into [C(2)]: either [0,2] or [2,0], cost = 20
    expect(cheapestInsertionCost(0, [2], matrix)).toBe(20)
  })

  it('finds cheapest position among several options', () => {
    // Insert A(0) into route [C(2), D(3)] (cost 3)
    // Before C: [0, 2, 3] -> adds dist(0,2) = 20
    // Between C,D: [2, 0, 3] -> adds 20 + 22 - 3 = 39
    // After D: [2, 3, 0] -> adds dist(3,0) = 22
    // Cheapest = 20 (before C)
    expect(cheapestInsertionCost(0, [2, 3], matrix)).toBe(20)
  })

  it('inserting near-cluster client is cheap', () => {
    // Insert B(1) into [A(0)]: cost = dist(0,1) = 2
    expect(cheapestInsertionCost(1, [0], matrix)).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web && npx vitest run src/__tests__/optimizer.test.ts
```

Expected: FAIL — functions are not exported from `optimizer.ts`.

- [ ] **Step 3: Implement the 4 primitives in optimizer.ts**

Add these after the `DAYS_FULL` constant (line 19), before the existing `avgDriveToGroup`:

```typescript
// ── Route-based cost primitives ──
//
// These replace the old avgDriveToGroup proxy with actual route-order math.
// An "open path" means we visit clients in order without returning to start.

/**
 * Nearest-neighbor TSP: tries every starting point, keeps the shortest open path.
 * For typical per-day groups (3-8 clients) this is fast and near-optimal.
 */
export function solveRoute(
  indices: number[],
  matrix: number[][],
): { order: number[]; cost: number } {
  if (indices.length <= 1) return { order: [...indices], cost: 0 }

  let bestOrder: number[] = []
  let bestCost = Infinity

  for (const start of indices) {
    const visited = new Set<number>([start])
    const order = [start]
    let cost = 0

    while (visited.size < indices.length) {
      const current = order[order.length - 1]
      let nearestIdx = -1
      let nearestDist = Infinity
      for (const idx of indices) {
        if (visited.has(idx)) continue
        if (matrix[current][idx] < nearestDist) {
          nearestDist = matrix[current][idx]
          nearestIdx = idx
        }
      }
      order.push(nearestIdx)
      visited.add(nearestIdx)
      cost += nearestDist
    }

    if (cost < bestCost) {
      bestCost = cost
      bestOrder = order
    }
  }

  return { order: bestOrder, cost: bestCost }
}

/** Sum of sequential edge costs along an ordered open-path route. */
export function routeCost(order: number[], matrix: number[][]): number {
  let cost = 0
  for (let i = 0; i < order.length - 1; i++) {
    cost += matrix[order[i]][order[i + 1]]
  }
  return cost
}

/**
 * Drive time saved by removing a client from an open-path route.
 * Reconnects predecessor directly to successor.
 */
export function removalSavings(
  clientIdx: number,
  route: number[],
  matrix: number[][],
): number {
  const pos = route.indexOf(clientIdx)
  if (pos === -1 || route.length <= 1) return 0

  const prev = pos > 0 ? route[pos - 1] : -1
  const next = pos < route.length - 1 ? route[pos + 1] : -1

  let savings = 0
  if (prev !== -1) savings += matrix[prev][clientIdx]
  if (next !== -1) savings += matrix[clientIdx][next]
  if (prev !== -1 && next !== -1) savings -= matrix[prev][next]
  return savings
}

/**
 * Cheapest cost to insert a client into an existing open-path route.
 * Tries every position: before first, between each pair, after last.
 */
export function cheapestInsertionCost(
  clientIdx: number,
  route: number[],
  matrix: number[][],
): number {
  if (route.length === 0) return 0

  let minCost = Infinity

  // Before first stop
  minCost = Math.min(minCost, matrix[clientIdx][route[0]])

  // After last stop
  minCost = Math.min(minCost, matrix[route[route.length - 1]][clientIdx])

  // Between consecutive stops
  for (let i = 0; i < route.length - 1; i++) {
    const cost = matrix[route[i]][clientIdx]
      + matrix[clientIdx][route[i + 1]]
      - matrix[route[i]][route[i + 1]]
    minCost = Math.min(minCost, cost)
  }

  return minCost
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npx vitest run src/__tests__/optimizer.test.ts
```

Expected: All 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/optimizer.ts web/src/__tests__/optimizer.test.ts
git commit -m "feat: add route-based cost primitives (NN-TSP, removal, insertion)"
```

---

### Task 3: computeMoveSavings + Update computeDaySavingsFromMatrix

**Files:**
- Modify: `web/src/optimizer.ts`
- Modify: `web/src/__tests__/optimizer.test.ts`

Add the composite `computeMoveSavings` function and refactor `computeDaySavingsFromMatrix` to use day routes instead of the avg-to-group proxy.

- [ ] **Step 1: Write failing tests for computeMoveSavings**

Append to `web/src/__tests__/optimizer.test.ts`:

```typescript
import { computeMoveSavings } from '../optimizer'

// (reuse the same `matrix` from above — move it to module scope if not already)

describe('computeMoveSavings', () => {
  it('big savings moving client from wrong cluster to right cluster', () => {
    // C(2) is on a day with route [0, 1, 2] (A→B→C, cost 2+18=20)
    // Target day has route [3] (D only)
    //
    // Removal of C from [0, 1, 2]: saves dist(1,2)=18 (last stop)
    // Insertion of C into [3]: cost = dist(2,3)=3
    // Net savings = 18 - 3 = 15
    expect(computeMoveSavings(2, [0, 1, 2], [3], matrix)).toBe(15)
  })

  it('negative savings for moving to wrong cluster', () => {
    // A(0) is on a day with route [0, 1] (cost 2)
    // Target day has route [2, 3] (C→D, cost 3)
    //
    // Removal of A from [0, 1]: saves dist(0,1)=2 (first stop)
    // Insertion of A into [2, 3]: cheapest = min(20, 22, 20+22-3=39) = 20
    // Net savings = 2 - 20 = -18
    expect(computeMoveSavings(0, [0, 1], [2, 3], matrix)).toBe(-18)
  })

  it('zero savings moving sole client to empty day', () => {
    // Removal from [0]: 0 (only client)
    // Insertion into []: 0 (first on new day)
    expect(computeMoveSavings(0, [0], [], matrix)).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests — expect fail**

```bash
cd web && npx vitest run src/__tests__/optimizer.test.ts
```

Expected: New tests FAIL — `computeMoveSavings` not exported.

- [ ] **Step 3: Add computeMoveSavings to optimizer.ts**

Add after `cheapestInsertionCost`:

```typescript
/**
 * Net drive time saved by moving a client from one day's route to another.
 * Positive = saves time. Negative = would cost time (bad move).
 */
export function computeMoveSavings(
  clientIdx: number,
  fromRoute: number[],
  toRoute: number[],
  matrix: number[][],
): number {
  const saved = removalSavings(clientIdx, fromRoute, matrix)
  const added = cheapestInsertionCost(clientIdx, toRoute, matrix)
  return Math.round(saved - added)
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd web && npx vitest run src/__tests__/optimizer.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Refactor computeDaySavingsFromMatrix**

Replace the existing `computeDaySavingsFromMatrix` function (currently at lines 73-98) with this version that takes pre-computed day routes:

```typescript
/**
 * Compute savings for moving a client to every other working day.
 * Uses pre-computed day routes for actual insertion/removal costs.
 */
export function computeDaySavingsFromMatrix(
  idx: number,
  currentDay: number,
  dayRoutes: Map<number, number[]>,
  matrix: number[][],
  maxJobsPerDay: number,
  dayGroupIndices: Map<number, number[]>,
  workingDays?: boolean[],
): Array<{ day: number; savings: number; clientCount: number }> {
  const currentRoute = dayRoutes.get(currentDay) || []
  const results: Array<{ day: number; savings: number; clientCount: number }> = []

  for (let day = 0; day < 7; day++) {
    if (day === currentDay) continue
    if (workingDays && !workingDays[day]) continue
    const targetIndices = dayGroupIndices.get(day) || []

    if (maxJobsPerDay > 0 && targetIndices.length >= maxJobsPerDay) continue

    const targetRoute = dayRoutes.get(day) || []
    const savings = computeMoveSavings(idx, currentRoute, targetRoute, matrix)
    if (savings > 0) {
      results.push({ day, savings, clientCount: targetIndices.length })
    }
  }

  return results.sort((a, b) => b.savings - a.savings)
}
```

**Signature change:** the 3rd parameter is now `dayRoutes: Map<number, number[]>` (ordered routes) instead of the old `dayGroupIndices`. A new 6th parameter `dayGroupIndices` is added for the capacity check and `clientCount`. Callers are updated in Task 4.

- [ ] **Step 6: Delete old proxy functions**

Delete `computeSavings` (the old lines 58-67). Delete `avgDriveToGroup` (old lines 47-55) — but **only if** no other code references it. Check first:

The remaining references to `avgDriveToGroup` are in `generateOptimization` for the `reason` string (lines 324-325 and 352-353). These callers will be rewritten in Task 4. For now, keep `avgDriveToGroup` and mark it:

```typescript
/** @deprecated — only used for legacy reason strings, removed in Task 4 */
function avgDriveToGroup(
```

Delete `computeSavings` (it has no remaining callers after `computeDaySavingsFromMatrix` was refactored).

- [ ] **Step 7: Verify build compiles**

```bash
cd web && npx tsc -b --noEmit
```

Expected: Type errors in `generateOptimization` where it calls `computeDaySavingsFromMatrix` with the old signature. This is expected — Task 4 fixes these callers.

Note: if the build errors block testing, temporarily add `// @ts-expect-error` on the two call sites (lines ~316 and ~344). Remove them in Task 4.

- [ ] **Step 8: Run tests**

```bash
cd web && npx vitest run src/__tests__/optimizer.test.ts
```

Expected: All tests PASS (tests don't hit the broken callers).

- [ ] **Step 9: Commit**

```bash
git add web/src/optimizer.ts web/src/__tests__/optimizer.test.ts
git commit -m "feat: add computeMoveSavings, refactor computeDaySavingsFromMatrix to route-based"
```

---

### Task 4: Update generateOptimization Pipeline

**Files:**
- Modify: `web/src/optimizer.ts`

Wire the new route primitives into the main optimizer pipeline: pre-compute day routes, update move validation, fix swap pairs, fix perfect world estimate, update reason strings.

- [ ] **Step 1: Refactor getVroomHypothesis return type**

The perfect world calculation needs VROOM's `summary.duration`. Change the return type to include it.

Change the function signature from:
```typescript
async function getVroomHypothesis(
  ...
): Promise<Map<number, number> | null> {
```

To:
```typescript
async function getVroomHypothesis(
  ...
): Promise<{ assignments: Map<number, number>; totalDurationSeconds: number } | null> {
```

Change the return at the end of the try block from:
```typescript
    return vroomAssignments
```

To:
```typescript
    return { assignments: vroomAssignments, totalDurationSeconds: response.summary.duration }
```

- [ ] **Step 2: Pre-compute day routes in generateOptimization**

After the `dayGroupIndices` loop (after line 260), add:

```typescript
  // Pre-compute NN-TSP route for each day (used for all savings calculations)
  const dayRoutes = new Map<number, number[]>()
  for (const [day, indices] of dayGroupIndices) {
    dayRoutes.set(day, solveRoute(indices, matrix).order)
  }
```

- [ ] **Step 3: Update VROOM caller and perfect world calculation**

Replace the VROOM call and perfect-world block (lines 263-305) with:

```typescript
  // ── Step 1: VROOM hypothesis ──
  const vroomResult = await getVroomHypothesis(withCoords, matrixSeconds, config)
  const vroomAssignments = vroomResult?.assignments ?? null

  const vroomMisplaced = new Set<number>()
  let perfectWorldMinutes = 0

  if (vroomAssignments) {
    for (let idx = 0; idx < withCoords.length; idx++) {
      const vroomDay = vroomAssignments.get(idx)
      if (vroomDay !== undefined && vroomDay !== withCoords[idx].currentDay) {
        vroomMisplaced.add(idx)
      }
    }

    // Perfect world: current route costs vs VROOM's optimal travel time
    let currentTotalMinutes = 0
    for (const [, route] of dayRoutes) {
      currentTotalMinutes += routeCost(route, matrix)
    }

    // VROOM duration (seconds) includes service time (1800s per job) — subtract it
    const vroomTravelMinutes = (vroomResult.totalDurationSeconds - withCoords.length * 1800) / 60
    perfectWorldMinutes = Math.max(0, Math.round(currentTotalMinutes - Math.max(0, vroomTravelMinutes)))
  }
```

- [ ] **Step 4: Update Phase A — VROOM-guided move validation**

Replace the Phase A block (previously lines 313-337) with:

```typescript
  // Phase A: VROOM-guided — check clients VROOM says are misplaced
  for (const idx of vroomMisplaced) {
    checkedIndices.add(idx)
    const { client, currentDay } = withCoords[idx]
    const daySavings = computeDaySavingsFromMatrix(
      idx, currentDay, dayRoutes, matrix, config.maxJobsPerDay, dayGroupIndices, config.workingDays,
    )

    if (daySavings.length === 0) continue
    const best = daySavings[0]
    if (best.savings < MIN_SAVINGS) continue

    moves.push({
      clientId: client.id,
      clientName: client.name,
      currentDay,
      suggestedDay: best.day,
      savingsMinutes: best.savings,
      reason: `Saves ${best.savings} min/wk on the ${DAYS_FULL[best.day]} route (${best.clientCount} client${best.clientCount !== 1 ? 's' : ''})`,
      status: 'to-ask',
      suggestedMessage: `Hey ${client.name.split(' ')[0]}, would ${DAYS_FULL[best.day]}s work for you going forward instead of ${DAYS_FULL[currentDay]}s? Trying to tighten up my route.`,
    })
  }
```

- [ ] **Step 5: Update Phase B — full scan**

Replace the Phase B block (previously lines 341-365) — same pattern:

```typescript
  // Phase B: Full scan — catch anything VROOM missed
  for (let idx = 0; idx < withCoords.length; idx++) {
    if (checkedIndices.has(idx)) continue
    const { client, currentDay } = withCoords[idx]
    const daySavings = computeDaySavingsFromMatrix(
      idx, currentDay, dayRoutes, matrix, config.maxJobsPerDay, dayGroupIndices, config.workingDays,
    )

    if (daySavings.length === 0) continue
    const best = daySavings[0]
    if (best.savings < MIN_SAVINGS) continue

    moves.push({
      clientId: client.id,
      clientName: client.name,
      currentDay,
      suggestedDay: best.day,
      savingsMinutes: best.savings,
      reason: `Saves ${best.savings} min/wk on the ${DAYS_FULL[best.day]} route (${best.clientCount} client${best.clientCount !== 1 ? 's' : ''})`,
      status: 'to-ask',
      suggestedMessage: `Hey ${client.name.split(' ')[0]}, would ${DAYS_FULL[best.day]}s work for you going forward instead of ${DAYS_FULL[currentDay]}s? Trying to tighten up my route.`,
    })
  }
```

- [ ] **Step 6: Update swap pair logic**

Replace the Step 3 swap block (previously lines 367-415) with route-based swap savings:

```typescript
  // ── Step 3: Swap pairs ──
  const swaps: SwapPair[] = []
  const moveClientIds = new Set(moves.map(m => m.clientId))

  for (let a = 0; a < withCoords.length; a++) {
    if (moveClientIds.has(withCoords[a].client.id)) continue

    for (let b = a + 1; b < withCoords.length; b++) {
      if (moveClientIds.has(withCoords[b].client.id)) continue
      if (withCoords[a].currentDay === withCoords[b].currentDay) continue
      if (config.workingDays && (!config.workingDays[withCoords[a].currentDay] || !config.workingDays[withCoords[b].currentDay])) continue

      const aRoute = dayRoutes.get(withCoords[a].currentDay) || []
      const bRoute = dayRoutes.get(withCoords[b].currentDay) || []

      // Each client is inserted into the other's route AFTER the other is removed
      const bRouteWithoutB = bRoute.filter(i => i !== b)
      const aRouteWithoutA = aRoute.filter(i => i !== a)

      const aSavings = removalSavings(a, aRoute, matrix) - cheapestInsertionCost(a, bRouteWithoutB, matrix)
      const bSavings = removalSavings(b, bRoute, matrix) - cheapestInsertionCost(b, aRouteWithoutA, matrix)

      if (aSavings < 0 || bSavings < 0) continue
      if (aSavings + bSavings < MIN_SAVINGS * 2) continue

      const clientA = withCoords[a].client
      const clientB = withCoords[b].client
      const total = Math.round(aSavings + bSavings)

      swaps.push({
        moveA: {
          clientId: clientA.id,
          clientName: clientA.name,
          currentDay: withCoords[a].currentDay,
          suggestedDay: withCoords[b].currentDay,
          savingsMinutes: Math.round(aSavings),
          reason: `Swap with ${clientB.name} — saves ${total} min/wk total`,
          status: 'to-ask',
          suggestedMessage: `Hey ${clientA.name.split(' ')[0]}, would ${DAYS_FULL[withCoords[b].currentDay]}s work for you instead of ${DAYS_FULL[withCoords[a].currentDay]}s?`,
        },
        moveB: {
          clientId: clientB.id,
          clientName: clientB.name,
          currentDay: withCoords[b].currentDay,
          suggestedDay: withCoords[a].currentDay,
          savingsMinutes: Math.round(bSavings),
          reason: `Swap with ${clientA.name} — saves ${total} min/wk total`,
          status: 'to-ask',
          suggestedMessage: `Hey ${clientB.name.split(' ')[0]}, would ${DAYS_FULL[withCoords[a].currentDay]}s work for you instead of ${DAYS_FULL[withCoords[b].currentDay]}s?`,
        },
        totalSavings: total,
      })
    }
  }
```

- [ ] **Step 7: Delete avgDriveToGroup**

Now that no code references `avgDriveToGroup`, remove it entirely.

- [ ] **Step 8: Verify build compiles**

```bash
cd web && npx tsc -b --noEmit
```

Expected: No errors.

- [ ] **Step 9: Run all tests**

```bash
cd web && npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 10: Commit**

```bash
git add web/src/optimizer.ts
git commit -m "feat: wire route-based savings into optimizer pipeline"
```

---

### Task 5: Update Sync Haversine Fallback

**Files:**
- Modify: `web/src/optimizer.ts`

The sync `computeDaySavings` (used by the "Different Day" picker modal in `OptimizeView.tsx`) uses the same avg-to-group proxy with Haversine. Update it to build a local distance matrix and use route-based logic. No API calls — all Haversine.

- [ ] **Step 1: Replace computeDaySavings**

Replace the existing sync `computeDaySavings` function and the `avgDriveToDay` helper with:

```typescript
/**
 * Sync version for the "Different Day" picker in OptimizeView.
 * Builds a local Haversine distance matrix and uses route-based savings.
 * No API calls — instant response for UI.
 */
export function computeDaySavings(
  client: Client,
  currentDay: number,
  dayGroups: Map<number, Client[]>,
  maxJobsPerDay: number,
  workingDays?: boolean[],
): Array<{ day: number; savings: number; clientCount: number }> {
  if (client.lat === null || client.lng === null) return []

  // Collect all geocoded clients and assign local indices
  const allClients: Client[] = []
  const clientIndex = new Map<string, number>()
  for (const [, group] of dayGroups) {
    for (const c of group) {
      if (c.lat !== null && c.lng !== null && !clientIndex.has(c.id)) {
        clientIndex.set(c.id, allClients.length)
        allClients.push(c)
      }
    }
  }

  const myIdx = clientIndex.get(client.id)
  if (myIdx === undefined) return []

  // Build NxN Haversine matrix (minutes)
  const n = allClients.length
  const localMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = driveMin(allClients[i].lat!, allClients[i].lng!, allClients[j].lat!, allClients[j].lng!)
      localMatrix[i][j] = d
      localMatrix[j][i] = d
    }
  }

  // Build current day's route
  const currentDayClients = dayGroups.get(currentDay) || []
  const currentIndices = currentDayClients.filter(c => clientIndex.has(c.id)).map(c => clientIndex.get(c.id)!)
  const currentRoute = solveRoute(currentIndices, localMatrix).order

  const results: Array<{ day: number; savings: number; clientCount: number }> = []

  for (let day = 0; day < 7; day++) {
    if (day === currentDay) continue
    if (workingDays && !workingDays[day]) continue
    const targetClients = dayGroups.get(day) || []

    if (maxJobsPerDay > 0 && targetClients.length >= maxJobsPerDay) continue

    const targetIndices = targetClients.filter(c => clientIndex.has(c.id)).map(c => clientIndex.get(c.id)!)
    const targetRoute = solveRoute(targetIndices, localMatrix).order

    const savings = computeMoveSavings(myIdx, currentRoute, targetRoute, localMatrix)
    if (savings > 0) {
      results.push({ day, savings, clientCount: targetClients.length })
    }
  }

  return results.sort((a, b) => b.savings - a.savings)
}
```

- [ ] **Step 2: Delete avgDriveToDay**

The old `avgDriveToDay` helper function (used only by the old `computeDaySavings`) can now be deleted.

- [ ] **Step 3: Verify build**

```bash
cd web && npx tsc -b --noEmit
```

Expected: No errors.

- [ ] **Step 4: Run all tests**

```bash
cd web && npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/optimizer.ts
git commit -m "feat: update sync Haversine fallback to route-based savings"
```

---

### Task 6: Build Verification + Cleanup

**Files:** None modified (verification only)

- [ ] **Step 1: Full production build**

```bash
cd web && npm run build
```

Expected: Clean build, no errors, no warnings about the changed code.

- [ ] **Step 2: Run all tests**

```bash
cd web && npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 3: Verify no stale references**

```bash
cd web && grep -rn "avgDriveToGroup\|avgDriveToDay\|computeSavings" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v __tests__
```

Expected: `computeSavings` should only appear as `computeMoveSavings`. No results for `avgDriveToGroup` or `avgDriveToDay`.

- [ ] **Step 4: Start dev server and smoke test**

```bash
cd web && npm run dev
```

Open the Schedule page → click Optimize. Verify:
- Loading spinner appears, then results show
- Savings numbers display on move cards (values will differ from before — this is expected, they're now more accurate)
- Reason text shows the new format: "Saves X min/wk on the [Day] route (N clients)"
- Click a move → preview shows on the schedule
- Click "Different Day" → modal shows day options with savings
- Swap pairs show combined savings
- Settings (max jobs/day, working days) trigger re-scan

- [ ] **Step 5: Final commit if any cleanup needed**

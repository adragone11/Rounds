# Home Address as Route Depot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the optimizer use the provider's home address as the starting point for every day's route, and require it before optimization can run.

**Architecture:** Append home coords as the last index in the ORS matrix (index N, where N = number of clients). Day routes are anchored at this depot index via a new `solveRouteFromDepot` function. VROOM vehicles start from the depot. The `cheapestInsertionCost` and `computeMoveSavings` functions gain a `fixedStart` flag to prevent inserting before the depot. OptimizeView gates on home address — no home, no optimize.

**Tech Stack:** Existing ORS Matrix + VROOM + Vitest

---

## Why Home Matters

Without home, the optimizer treats all client-to-client distances equally. A client 5 min from home but 20 min from their Monday peers looks "misplaced" even though the actual Monday route (home → that client → others) is efficient. With home as the depot, route costs include the real first leg of the drive.

## Index Strategy

Home goes at the **end** of the coordinate list (index N), not the beginning. This avoids shifting every client index by +1 and keeps all existing index logic unchanged.

```
Before: coords = [client0, client1, ..., clientN-1]          matrix: NxN
After:  coords = [client0, client1, ..., clientN-1, home]    matrix: (N+1)x(N+1)

Client indices: 0..N-1 (unchanged)
Home index: N (new, last position)
Day routes: [N, client_a, client_b, ...]  (anchored at home)
VROOM vehicles: start_index = N
```

---

## File Map

| File | Action | What Changes |
|------|--------|--------------|
| `web/src/optimizer.ts` | Modify | Add `solveRouteFromDepot`, add `fixedStart` param, update `generateOptimization` + `computeDaySavings` |
| `web/src/components/OptimizeView.tsx` | Modify | Add `homeAddress` prop, gate UI, pass home coords to optimizer |
| `web/src/pages/Schedule.tsx` | Modify | Pass `store.homeAddress` to OptimizeSidebar |
| `web/src/__tests__/optimizer.test.ts` | Modify | Add depot routing + fixedStart tests |

---

### Task 1: Add `solveRouteFromDepot` + `fixedStart` Flag + Tests

**Files:**
- Modify: `web/src/optimizer.ts`
- Modify: `web/src/__tests__/optimizer.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `web/src/__tests__/optimizer.test.ts`. Add `solveRouteFromDepot` to the import. Add a second matrix at module scope for depot tests:

```typescript
// 5-point matrix: clients A(0), B(1), C(2), D(3) + Home(4)
// Home is near the A/B cluster (5-7 min), far from C/D cluster (25-27 min)
//
//       A    B    C    D    H
// A     0    2   20   22    5
// B     2    0   18   20    7
// C    20   18    0    3   25
// D    22   20    3    0   27
// H     5    7   25   27    0
const depotMatrix = [
  [0,  2, 20, 22,  5],
  [2,  0, 18, 20,  7],
  [20, 18,  0,  3, 25],
  [20, 20,  3,  0, 27],
  [5,  7, 25, 27,  0],
]

describe('solveRouteFromDepot', () => {
  it('returns depot-only route for no clients', () => {
    const result = solveRouteFromDepot(4, [], depotMatrix)
    expect(result.order).toEqual([4])
    expect(result.cost).toBe(0)
  })

  it('anchors route at depot then visits nearest', () => {
    // Home(4) → A(0) is 5, Home → B(1) is 7
    // So route = [4, 0, 1], cost = 5 + 2 = 7
    const result = solveRouteFromDepot(4, [0, 1], depotMatrix)
    expect(result.order).toEqual([4, 0, 1])
    expect(result.cost).toBe(7)
  })

  it('visits far cluster correctly', () => {
    // Home(4) → C(2) is 25, Home → D(3) is 27
    // So route = [4, 2, 3], cost = 25 + 3 = 28
    const result = solveRouteFromDepot(4, [2, 3], depotMatrix)
    expect(result.order).toEqual([4, 2, 3])
    expect(result.cost).toBe(28)
  })

  it('handles single client', () => {
    const result = solveRouteFromDepot(4, [2], depotMatrix)
    expect(result.order).toEqual([4, 2])
    expect(result.cost).toBe(25)
  })
})

describe('cheapestInsertionCost with fixedStart', () => {
  it('skips before-first position when fixedStart is true', () => {
    // Route: [4, 0, 1] (Home → A → B)
    // Insert C(2):
    //   Before Home (skipped with fixedStart): dist(2,4) = 25
    //   Between Home,A: dist(4,2)+dist(2,0)-dist(4,0) = 25+20-5 = 40
    //   Between A,B: dist(0,2)+dist(2,1)-dist(0,1) = 20+18-2 = 36
    //   After B: dist(1,2) = 18
    // Without fixedStart: min(25, 40, 36, 18) = 18
    // With fixedStart: min(40, 36, 18) = 18  (same here, but "before first" is excluded)
    expect(cheapestInsertionCost(2, [4, 0, 1], depotMatrix)).toBe(18)
    expect(cheapestInsertionCost(2, [4, 0, 1], depotMatrix, true)).toBe(18)
  })

  it('makes a difference when before-depot would win', () => {
    // Route: [4, 2] (Home → C, cost 25)
    // Insert A(0):
    //   Before Home: dist(0,4) = 5  ← would win without fixedStart
    //   Between Home,C: dist(4,0)+dist(0,2)-dist(4,2) = 5+20-25 = 0
    //   After C: dist(2,0) = 20
    // Without fixedStart: min(5, 0, 20) = 0
    // With fixedStart: min(0, 20) = 0
    // In this case both give 0 because A is on the way
    expect(cheapestInsertionCost(0, [4, 2], depotMatrix, true)).toBe(0)

    // Route: [4, 2, 3] (Home → C → D)
    // Insert A(0):
    //   Before Home: dist(0,4) = 5  ← cheapest without fixedStart
    //   Between Home,C: dist(4,0)+dist(0,2)-dist(4,2) = 5+20-25 = 0
    //   Between C,D: dist(2,0)+dist(0,3)-dist(2,3) = 20+22-3 = 39
    //   After D: dist(3,0) = 22
    // Without fixedStart: min(5, 0, 39, 22) = 0
    // With fixedStart: min(0, 39, 22) = 0
    expect(cheapestInsertionCost(0, [4, 2, 3], depotMatrix)).toBe(0)
    expect(cheapestInsertionCost(0, [4, 2, 3], depotMatrix, true)).toBe(0)
  })
})

describe('computeMoveSavings with fixedStart', () => {
  it('correctly computes savings with depot routes', () => {
    // C(2) is on Tuesday route [4, 2, 3] (Home→C→D, cost 28)
    // Move to Monday route [4, 0, 1] (Home→A→B, cost 7)
    //
    // Removal of C from [4, 2, 3]:
    //   pos=1, prev=4(Home), next=3(D)
    //   savings = dist(4,2)+dist(2,3)-dist(4,3) = 25+3-27 = 1
    //
    // Insertion of C into [4, 0, 1] (fixedStart=true):
    //   Between Home,A: 25+20-5 = 40
    //   Between A,B: 20+18-2 = 36
    //   After B: 18
    //   cheapest = 18
    //
    // Net savings = 1 - 18 = -17
    expect(computeMoveSavings(2, [4, 2, 3], [4, 0, 1], depotMatrix, true)).toBe(-17)
  })
})
```

- [ ] **Step 2: Run tests — expect fail**

```bash
cd web && npx vitest run src/__tests__/optimizer.test.ts
```

Expected: FAIL — `solveRouteFromDepot` not exported, `cheapestInsertionCost` doesn't accept 4th arg.

- [ ] **Step 3: Add `solveRouteFromDepot` to optimizer.ts**

Add after `computeMoveSavings` (after line 143):

```typescript
/**
 * Nearest-neighbor route anchored at a fixed depot (home address).
 * Always starts from depot, then greedily visits nearest unvisited client.
 */
export function solveRouteFromDepot(
  depotIdx: number,
  clientIndices: number[],
  matrix: number[][],
): { order: number[]; cost: number } {
  if (clientIndices.length === 0) return { order: [depotIdx], cost: 0 }

  const order = [depotIdx]
  const remaining = new Set(clientIndices)
  let cost = 0

  while (remaining.size > 0) {
    const current = order[order.length - 1]
    let nearestIdx = -1
    let nearestDist = Infinity
    for (const idx of remaining) {
      if (matrix[current][idx] < nearestDist) {
        nearestDist = matrix[current][idx]
        nearestIdx = idx
      }
    }
    order.push(nearestIdx)
    remaining.delete(nearestIdx)
    cost += nearestDist
  }

  return { order, cost }
}
```

- [ ] **Step 4: Add `fixedStart` parameter to `cheapestInsertionCost`**

Change the signature from:
```typescript
export function cheapestInsertionCost(
  clientIdx: number,
  route: number[],
  matrix: number[][],
): number {
```

To:
```typescript
export function cheapestInsertionCost(
  clientIdx: number,
  route: number[],
  matrix: number[][],
  fixedStart = false,
): number {
```

And wrap the "before first stop" line in a condition:

```typescript
  // Before first stop (skip if depot is fixed — can't insert before home)
  if (!fixedStart) {
    minCost = Math.min(minCost, matrix[clientIdx][route[0]])
  }
```

- [ ] **Step 5: Add `fixedStart` parameter to `computeMoveSavings`**

Change from:
```typescript
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

To:
```typescript
export function computeMoveSavings(
  clientIdx: number,
  fromRoute: number[],
  toRoute: number[],
  matrix: number[][],
  fixedStart = false,
): number {
  const saved = removalSavings(clientIdx, fromRoute, matrix)
  const added = cheapestInsertionCost(clientIdx, toRoute, matrix, fixedStart)
  return Math.round(saved - added)
}
```

- [ ] **Step 6: Run tests — expect pass**

```bash
cd web && npx vitest run src/__tests__/optimizer.test.ts
```

Expected: All tests PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
git add web/src/optimizer.ts web/src/__tests__/optimizer.test.ts
git commit -m "feat: add solveRouteFromDepot and fixedStart flag for home address support"
```

---

### Task 2: Update `generateOptimization` to Use Home Depot

**Files:**
- Modify: `web/src/optimizer.ts`

- [ ] **Step 1: Add `homeCoords` parameter to `generateOptimization`**

Change the signature from:
```typescript
export async function generateOptimization(
  clientsWithDays: ClientWithDay[],
  config: OptimizeConfig = { maxJobsPerDay: 0, workingDays: DEFAULT_WORKING_DAYS },
): Promise<OptimizationResult> {
```

To:
```typescript
export async function generateOptimization(
  clientsWithDays: ClientWithDay[],
  config: OptimizeConfig = { maxJobsPerDay: 0, workingDays: DEFAULT_WORKING_DAYS },
  homeCoords?: { lat: number; lng: number },
): Promise<OptimizationResult> {
```

- [ ] **Step 2: Append home to coordinates and track homeIdx**

Replace the coords/matrix block (lines 378-381):

```typescript
  // Fetch ORS matrix — append home if provided (becomes last index)
  const coords = withCoords.map(c => ({ lat: c.client.lat!, lng: c.client.lng! }))
  const homeIdx = homeCoords ? coords.length : -1
  if (homeCoords) coords.push(homeCoords)

  const matrixSeconds = await getORSMatrixSeconds(coords)
  const matrix = matrixSeconds.map(row => row.map(s => s / 60)) // minutes
  const hasHome = homeIdx >= 0
```

- [ ] **Step 3: Update day route computation**

Replace the dayRoutes block (lines 392-396):

```typescript
  // Pre-compute route for each day
  const dayRoutes = new Map<number, number[]>()
  if (hasHome) {
    // Initialize all working days with depot-only route
    for (let day = 0; day < 7; day++) {
      if (config.workingDays[day]) dayRoutes.set(day, [homeIdx])
    }
    // Override with actual routes for days that have clients
    for (const [day, indices] of dayGroupIndices) {
      dayRoutes.set(day, solveRouteFromDepot(homeIdx, indices, matrix).order)
    }
  } else {
    for (const [day, indices] of dayGroupIndices) {
      dayRoutes.set(day, solveRoute(indices, matrix).order)
    }
  }
```

- [ ] **Step 4: Update VROOM vehicle config in `getVroomHypothesis`**

The `getVroomHypothesis` function needs to know `homeIdx`. Add it as a parameter.

Change the signature from:
```typescript
async function getVroomHypothesis(
  withCoords: ClientWithDay[],
  matrixSeconds: number[][],
  config: OptimizeConfig,
): Promise<{ assignments: Map<number, number>; totalDurationSeconds: number } | null> {
```

To:
```typescript
async function getVroomHypothesis(
  withCoords: ClientWithDay[],
  matrixSeconds: number[][],
  config: OptimizeConfig,
  homeIdx = -1,
): Promise<{ assignments: Map<number, number>; totalDurationSeconds: number } | null> {
```

Replace the vehicle construction block inside the function. Change:
```typescript
      const v: VroomVehicle = {
        id: day,
        start_index: 0, // dummy start (first client location)
        end_index: 0,
      }
```

To:
```typescript
      const v: VroomVehicle = {
        id: day,
        start_index: homeIdx >= 0 ? homeIdx : 0,
        ...(homeIdx < 0 ? { end_index: 0 } : {}),
      }
```

When home is provided: `start_index = homeIdx`, no `end_index` (one-way open path).
When no home: `start_index = 0, end_index = 0` (existing behavior).

- [ ] **Step 5: Update the `getVroomHypothesis` call**

In `generateOptimization`, change:
```typescript
  const vroomResult = await getVroomHypothesis(withCoords, matrixSeconds, config)
```

To:
```typescript
  const vroomResult = await getVroomHypothesis(withCoords, matrixSeconds, config, homeIdx)
```

- [ ] **Step 6: Pass `fixedStart` through savings calculations**

Add `fixedStart` parameter to `computeDaySavingsFromMatrix`. Change its signature:

```typescript
export function computeDaySavingsFromMatrix(
  idx: number,
  currentDay: number,
  dayRoutes: Map<number, number[]>,
  matrix: number[][],
  maxJobsPerDay: number,
  dayGroupIndices: Map<number, number[]>,
  workingDays?: boolean[],
  fixedStart = false,
): Array<{ day: number; savings: number; clientCount: number }> {
```

Update its internal call to `computeMoveSavings`:
```typescript
    const savings = computeMoveSavings(idx, currentRoute, targetRoute, matrix, fixedStart)
```

Update ALL callers of `computeDaySavingsFromMatrix` in `generateOptimization` (Phase A and Phase B) to pass `hasHome`:

```typescript
    const daySavings = computeDaySavingsFromMatrix(
      idx, currentDay, dayRoutes, matrix, config.maxJobsPerDay, dayGroupIndices, config.workingDays, hasHome,
    )
```

- [ ] **Step 7: Update swap pair logic with `fixedStart`**

In the swap pairs block, update the `cheapestInsertionCost` calls:

```typescript
      const aSavings = removalSavings(a, aRoute, matrix) - cheapestInsertionCost(a, bRouteWithoutB, matrix, hasHome)
      const bSavings = removalSavings(b, bRoute, matrix) - cheapestInsertionCost(b, aRouteWithoutA, matrix, hasHome)
```

- [ ] **Step 8: Verify build**

```bash
cd web && npx tsc -b --noEmit
```

Expected: No errors.

- [ ] **Step 9: Run tests**

```bash
cd web && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add web/src/optimizer.ts
git commit -m "feat: generateOptimization uses home address as route depot"
```

---

### Task 3: Update Sync Haversine Fallback with Home

**Files:**
- Modify: `web/src/optimizer.ts`

- [ ] **Step 1: Add `homeCoords` parameter to `computeDaySavings`**

Change the signature from:
```typescript
export function computeDaySavings(
  client: Client,
  currentDay: number,
  dayGroups: Map<number, Client[]>,
  maxJobsPerDay: number,
  workingDays?: boolean[],
): Array<{ day: number; savings: number; clientCount: number }> {
```

To:
```typescript
export function computeDaySavings(
  client: Client,
  currentDay: number,
  dayGroups: Map<number, Client[]>,
  maxJobsPerDay: number,
  workingDays?: boolean[],
  homeCoords?: { lat: number; lng: number },
): Array<{ day: number; savings: number; clientCount: number }> {
```

- [ ] **Step 2: Include home in the local matrix and anchor routes**

After the `localMatrix` construction (after the nested for loops), add home:

```typescript
  // Add home to local matrix if provided
  let homeLocalIdx = -1
  if (homeCoords) {
    homeLocalIdx = n // append after all clients
    // Extend matrix with home row/col
    for (let i = 0; i < n; i++) {
      const d = driveMin(allClients[i].lat!, allClients[i].lng!, homeCoords.lat, homeCoords.lng)
      localMatrix[i].push(d)
    }
    localMatrix.push(Array.from({ length: n + 1 }, (_, j) => j < n
      ? driveMin(homeCoords.lat, homeCoords.lng, allClients[j].lat!, allClients[j].lng!)
      : 0
    ))
  }
  const hasHome = homeLocalIdx >= 0
```

- [ ] **Step 3: Use depot routing when home is available**

Replace the route building and savings loop. Change:

```typescript
  // Build current day's route
  const currentDayClients = dayGroups.get(currentDay) || []
  const currentIndices = currentDayClients.filter(c => clientIndex.has(c.id)).map(c => clientIndex.get(c.id)!)
  const currentRoute = solveRoute(currentIndices, localMatrix).order
```

To:

```typescript
  // Build current day's route
  const currentDayClients = dayGroups.get(currentDay) || []
  const currentIndices = currentDayClients.filter(c => clientIndex.has(c.id)).map(c => clientIndex.get(c.id)!)
  const currentRoute = hasHome
    ? solveRouteFromDepot(homeLocalIdx, currentIndices, localMatrix).order
    : solveRoute(currentIndices, localMatrix).order
```

And in the day loop, change:

```typescript
    const targetRoute = solveRoute(targetIndices, localMatrix).order
    const savings = computeMoveSavings(myIdx, currentRoute, targetRoute, localMatrix)
```

To:

```typescript
    const targetRoute = hasHome
      ? solveRouteFromDepot(homeLocalIdx, targetIndices, localMatrix).order
      : solveRoute(targetIndices, localMatrix).order
    const savings = computeMoveSavings(myIdx, currentRoute, targetRoute, localMatrix, hasHome)
```

- [ ] **Step 4: Verify build**

```bash
cd web && npx tsc -b --noEmit
```

Expected: No errors.

- [ ] **Step 5: Run tests**

```bash
cd web && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/optimizer.ts
git commit -m "feat: sync Haversine fallback supports home depot"
```

---

### Task 4: UI Gate + Wiring

**Files:**
- Modify: `web/src/components/OptimizeView.tsx`
- Modify: `web/src/pages/Schedule.tsx`

- [ ] **Step 1: Add `homeAddress` prop to OptimizeSidebar**

In `OptimizeView.tsx`, change the props interface:

```typescript
interface OptimizeSidebarProps {
  clients: Client[]
  clientDayMap: Map<string, number>
  onClose: () => void
  onPreviewMoves: (moves: ProposedMove[]) => void
  homeAddress: { address: string; lat: number; lng: number } | null
}
```

Update the component destructuring:

```typescript
export default function OptimizeSidebar({ clients, clientDayMap, onClose, onPreviewMoves, homeAddress }: OptimizeSidebarProps) {
```

- [ ] **Step 2: Add gate — render "set starting address" when no home**

Add this block right before the loading state check (before the `if (!initialized && loading)` block, around line 210):

```typescript
  // Gate: require home address
  if (!homeAddress) {
    return (
      <div className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0">
        <div className="p-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Optimize</h2>
          <button onClick={onClose} className="text-[10px] text-gray-400 hover:text-gray-600">Back</button>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-2">
              <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
              </svg>
            </div>
            <p className="text-[11px] font-medium text-gray-600">Set your starting address</p>
            <p className="text-[10px] text-gray-400 mt-0.5">A home address is needed to calculate accurate route times</p>
          </div>
        </div>
      </div>
    )
  }
```

- [ ] **Step 3: Pass home coords to `generateOptimization`**

In `runOptimizer`, change the `generateOptimization` call:

```typescript
      const result = await generateOptimization(clientsWithDays, { maxJobsPerDay: maxJobs, workingDays: days }, { lat: homeAddress.lat, lng: homeAddress.lng })
```

In `refresh`, change the `generateOptimization` call similarly:

```typescript
      const result = await generateOptimization(clientsWithDays, { maxJobsPerDay, workingDays }, { lat: homeAddress.lat, lng: homeAddress.lng })
```

- [ ] **Step 4: Pass home coords to `computeDaySavings` in the "Different Day" picker**

Find the `diffDayOptions` useMemo (around line 190). Update the `computeDaySavings` call:

```typescript
    return computeDaySavings(client, currentDay, dayGroups, maxJobsPerDay, workingDays,
      homeAddress ? { lat: homeAddress.lat, lng: homeAddress.lng } : undefined)
```

- [ ] **Step 5: Clear cached results when home address changes**

Add a `useEffect` that clears optimization cache when homeAddress changes. Add after the persist effect:

```typescript
  // Clear cached results when home address changes
  useEffect(() => {
    if (!initialized) return
    localStorage.removeItem(STORAGE_KEY)
    setMoves([])
    setSwaps([])
    setPerfectWorldMinutes(0)
    onPreviewMoves([])
    runOptimizer(maxJobsPerDay)
  }, [homeAddress?.lat, homeAddress?.lng])
```

Note: this will re-run the optimizer whenever home address coordinates change.

- [ ] **Step 6: Pass `homeAddress` from Schedule.tsx**

In `web/src/pages/Schedule.tsx`, find the `<OptimizeSidebar` JSX (around line 367). Add the prop:

```typescript
          <OptimizeSidebar
            clients={store.clients}
            clientDayMap={clientDayMap}
            onClose={() => { setShowOptimize(false); setPreviewMoves([]) }}
            onPreviewMoves={setPreviewMoves}
            homeAddress={store.homeAddress}
          />
```

- [ ] **Step 7: Verify build**

```bash
cd web && npx tsc -b --noEmit
```

Expected: No errors.

- [ ] **Step 8: Run tests**

```bash
cd web && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add web/src/components/OptimizeView.tsx web/src/pages/Schedule.tsx
git commit -m "feat: require home address before optimization, pass as depot"
```

---

### Task 5: Build Verification

**Files:** None modified (verification only)

- [ ] **Step 1: Full build**

```bash
cd web && npm run build
```

Expected: Clean build.

- [ ] **Step 2: Run all tests**

```bash
cd web && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 3: Smoke test**

```bash
cd web && npm run dev
```

Verify:
- Without home address set: click Optimize → shows "Set your starting address" message
- Set a home address in the sidebar
- Click Optimize → optimizer runs, shows results
- Savings numbers now reflect driving from home
- "Different Day" picker works
- Change home address → results clear and re-run

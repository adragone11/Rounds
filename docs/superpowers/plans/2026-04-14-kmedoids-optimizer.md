# K-Medoids Optimizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken greedy-clustering + VROOM-tightening optimizer with k-medoids (PAM) — the industry-standard algorithm for geographic territory optimization.

**Architecture:** K-medoids clusters clients into K groups (K = working days) using the ORS drive time matrix. Constraints (blocked days, max jobs, recurrence) are applied after clustering. VROOM is removed from day assignment entirely — only used optionally for stop ordering within a day. Two modes: "Best Schedule" (full re-plan) and "Add Clients" (incremental placement).

**Tech Stack:** TypeScript, Vitest, ORS Matrix API (existing), solveRouteFromDepot (existing TSP)

**Spec:** `docs/superpowers/specs/2026-04-14-kmedoids-optimizer-design.md`

---

### Task 1: Write and test the k-medoids (PAM) function

**Files:**
- Modify: `web/src/optimizer.ts` (add kMedoids function, lines ~121-340 will be replaced)
- Modify: `web/src/__tests__/optimizer.test.ts` (replace clustering tests at lines 210-400)

- [ ] **Step 1: Write the failing test for kMedoids**

Replace the entire clustering test section (lines 210-400) in `web/src/__tests__/optimizer.test.ts` with:

```typescript
// ── K-Medoids tests ──

// 6-client matrix (minutes). Three geographic clusters:
//   Cluster 1: A(0), B(1) — 2 min apart
//   Cluster 2: C(2), D(3) — 3 min apart
//   Cluster 3: E(4), F(5) — 1 min apart
//   Inter-cluster distances: ~20-30 min
const clusterMatrix = [
  [0,  2, 20, 22, 28, 29],
  [2,  0, 18, 20, 26, 27],
  [20, 18,  0,  3, 25, 26],
  [22, 20,  3,  0, 23, 24],
  [28, 26, 25, 23,  0,  1],
  [29, 27, 26, 24,  1,  0],
]

describe('kMedoids', () => {
  it('returns empty for no clients', () => {
    expect(kMedoids([], clusterMatrix, 3)).toEqual([])
  })

  it('returns one cluster when k=1', () => {
    const clusters = kMedoids([0, 1, 2, 3, 4, 5], clusterMatrix, 1)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].sort()).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('produces exactly k clusters', () => {
    const clusters = kMedoids([0, 1, 2, 3, 4, 5], clusterMatrix, 3)
    expect(clusters).toHaveLength(3)
  })

  it('groups nearby clients together', () => {
    const clusters = kMedoids([0, 1, 2, 3, 4, 5], clusterMatrix, 3)
    // Each cluster should contain a geographically close pair
    for (const cluster of clusters) {
      expect(cluster).toHaveLength(2)
      const [a, b] = cluster
      // Members should be close to each other (< 5 min)
      expect(clusterMatrix[a][b]).toBeLessThan(5)
    }
  })

  it('assigns all clients exactly once', () => {
    const clusters = kMedoids([0, 1, 2, 3, 4, 5], clusterMatrix, 3)
    const allClients = clusters.flat().sort()
    expect(allClients).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('handles k >= n (each client is own cluster)', () => {
    const clusters = kMedoids([0, 1, 2], clusterMatrix, 5)
    // Should produce 3 clusters (one per client), not 5
    expect(clusters).toHaveLength(3)
    expect(clusters.every(c => c.length === 1)).toBe(true)
  })

  it('handles single client', () => {
    const clusters = kMedoids([3], clusterMatrix, 2)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toEqual([3])
  })

  it('produces tighter clusters than random assignment', () => {
    const clusters = kMedoids([0, 1, 2, 3, 4, 5], clusterMatrix, 3)
    // Total within-cluster distance should be small
    let totalIntra = 0
    for (const cluster of clusters) {
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          totalIntra += clusterMatrix[cluster[i]][cluster[j]]
        }
      }
    }
    // The optimal grouping is {0,1}, {2,3}, {4,5} with total intra = 2+3+1 = 6
    expect(totalIntra).toBe(6)
  })
})
```

Also update the import at the top of the test file:

```typescript
import {
  solveRoute,
  routeCost,
  removalSavings,
  cheapestInsertionCost,
  computeMoveSavings,
  solveRouteFromDepot,
  kMedoids,
} from '../optimizer'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/optimizer.test.ts`
Expected: FAIL — `kMedoids` is not exported from `../optimizer`

- [ ] **Step 3: Write the kMedoids implementation**

In `web/src/optimizer.ts`, replace the entire block from line 121 (`// ── Geographic clustering ──`) through line 463 (end of `tightenClusters`) with:

```typescript
// ── K-Medoids (PAM) Clustering ──
//
// Industry-standard algorithm for geographic territory optimization.
// Groups clients into K clusters where K = number of working days.
// Uses ORS drive time matrix — real road distances, not lat/lng.

/**
 * K-Medoids (PAM — Partitioning Around Medoids).
 *
 * 1. BUILD: select K starting medoids that minimize total cost
 * 2. ASSIGN: every client → nearest medoid
 * 3. SWAP: try replacing each medoid with a non-medoid; keep if it reduces total cost
 * 4. Repeat until stable
 *
 * Returns K arrays of client indices. Each array is a geographic cluster.
 */
export function kMedoids(
  clientIndices: number[],
  matrix: number[][],
  k: number,
): number[][] {
  const n = clientIndices.length
  if (n === 0) return []
  if (k >= n) return clientIndices.map(i => [i])

  // ── BUILD: greedy medoid initialization ──
  const medoids: number[] = []
  const remaining = new Set(clientIndices)

  // First medoid: client that minimizes total distance to all others
  let bestTotal = Infinity
  let bestFirst = clientIndices[0]
  for (const c of clientIndices) {
    let total = 0
    for (const o of clientIndices) {
      if (o !== c) total += matrix[c][o]
    }
    if (total < bestTotal) { bestTotal = total; bestFirst = c }
  }
  medoids.push(bestFirst)
  remaining.delete(bestFirst)

  // Subsequent medoids: each one reduces total cost the most
  while (medoids.length < k && remaining.size > 0) {
    let bestGain = -Infinity
    let bestNext = -1

    for (const candidate of remaining) {
      let gain = 0
      for (const c of clientIndices) {
        if (c === candidate) continue
        // Current nearest medoid distance
        let currentMin = Infinity
        for (const m of medoids) currentMin = Math.min(currentMin, matrix[c][m])
        // Distance to candidate
        const candidateDist = matrix[c][candidate]
        // Gain = how much closer some clients get
        if (candidateDist < currentMin) gain += currentMin - candidateDist
      }
      if (gain > bestGain) { bestGain = gain; bestNext = candidate }
    }

    if (bestNext === -1) break
    medoids.push(bestNext)
    remaining.delete(bestNext)
  }

  // ── ASSIGN + SWAP loop ──
  let improved = true
  while (improved) {
    improved = false

    // Assign every client to nearest medoid
    const clusters = new Map<number, number[]>()
    for (const m of medoids) clusters.set(m, [])

    for (const c of clientIndices) {
      let nearestMedoid = medoids[0]
      let nearestDist = Infinity
      for (const m of medoids) {
        if (matrix[c][m] < nearestDist) {
          nearestDist = matrix[c][m]
          nearestMedoid = m
        }
      }
      clusters.get(nearestMedoid)!.push(c)
    }

    // Total cost = sum of each client's distance to its medoid
    let currentCost = 0
    for (const [m, members] of clusters) {
      for (const c of members) currentCost += matrix[c][m]
    }

    // Try swapping each medoid with each non-medoid
    let bestSwapCost = currentCost
    let swapOut = -1
    let swapIn = -1

    for (let mi = 0; mi < medoids.length; mi++) {
      const m = medoids[mi]
      for (const c of clientIndices) {
        if (medoids.includes(c)) continue
        // Temporarily swap m → c
        const testMedoids = [...medoids]
        testMedoids[mi] = c
        // Compute total cost with this swap
        let cost = 0
        for (const client of clientIndices) {
          let minDist = Infinity
          for (const tm of testMedoids) minDist = Math.min(minDist, matrix[client][tm])
          cost += minDist
        }
        if (cost < bestSwapCost) {
          bestSwapCost = cost
          swapOut = mi
          swapIn = c
        }
      }
    }

    if (swapOut !== -1) {
      medoids[swapOut] = swapIn
      improved = true
    }
  }

  // Final assignment
  const finalClusters = new Map<number, number[]>()
  for (const m of medoids) finalClusters.set(m, [])

  for (const c of clientIndices) {
    let nearestMedoid = medoids[0]
    let nearestDist = Infinity
    for (const m of medoids) {
      if (matrix[c][m] < nearestDist) {
        nearestDist = matrix[c][m]
        nearestMedoid = m
      }
    }
    finalClusters.get(nearestMedoid)!.push(c)
  }

  return [...finalClusters.values()].filter(c => c.length > 0)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/optimizer.test.ts`
Expected: All kMedoids tests PASS. Existing route math tests (solveRoute, routeCost, etc.) still PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/optimizer.ts web/src/__tests__/optimizer.test.ts
git commit -m "feat: add kMedoids (PAM) clustering — replaces greedy nearest-member"
```

---

### Task 2: Wire k-medoids into generateOptimization (move suggestions)

**Files:**
- Modify: `web/src/optimizer.ts` (replace `getHypothesis` at ~line 760 and update `generateOptimization` at ~line 872)

- [ ] **Step 1: Replace getHypothesis with getKMedoidsHypothesis**

In `web/src/optimizer.ts`, replace the entire `getHypothesis` function (async function that calls VROOM + tightenClusters + clustering fallback) with:

```typescript
/**
 * Step 1: Cluster clients by k-medoids using ORS drive time matrix.
 * Returns a map of clientIndex → suggested day.
 */
function getKMedoidsHypothesis(
  withCoords: ClientWithDay[],
  matrix: number[][],
  config: OptimizeConfig,
): { assignments: Map<number, number> } | null {
  const activeDays = config.workingDays
    .map((on, i) => on ? i : -1)
    .filter(i => i >= 0)

  if (activeDays.length === 0) return null

  const maxPerDay = config.maxJobsPerDay > 0 ? config.maxJobsPerDay : 99
  const clientIndices = withCoords.map((_, i) => i)

  // K-medoids: K = number of working days
  const clusters = kMedoids(clientIndices, matrix, activeDays.length)

  // Assign clusters to days, respecting blocked days and capacity
  const assignments = new Map<number, number>()
  const dayCount = new Map<number, number>()
  const usedDays = new Set<number>()

  // Collect blocked days per client
  const clientBlocked = new Map<number, Set<number>>()
  for (let i = 0; i < withCoords.length; i++) {
    const blocked = withCoords[i].client.blockedDays
    if (blocked && blocked.length > 0) {
      clientBlocked.set(i, new Set(blocked))
    }
  }

  // Sort clusters largest-first
  const sorted = [...clusters].sort((a, b) => b.length - a.length)

  for (const cluster of sorted) {
    // Collect blocked days for this cluster
    const clusterBlocked = new Set<number>()
    for (const idx of cluster) {
      const blocked = clientBlocked.get(idx)
      if (blocked) blocked.forEach(d => clusterBlocked.add(d))
    }

    // Find best day: empty, not blocked, has capacity
    let bestDay = -1
    for (const day of activeDays) {
      if (usedDays.has(day)) continue
      if (clusterBlocked.has(day)) continue
      bestDay = day
      break
    }
    // Fallback: any day with capacity
    if (bestDay === -1) {
      for (const day of activeDays) {
        if (clusterBlocked.has(day)) continue
        if ((dayCount.get(day) || 0) + cluster.length <= maxPerDay) {
          bestDay = day
          break
        }
      }
    }
    // Last resort
    if (bestDay === -1) bestDay = activeDays[0]

    usedDays.add(bestDay)

    // Assign clients, respecting per-client blocked days and capacity
    for (const idx of cluster) {
      const blocked = clientBlocked.get(idx)
      if (blocked && blocked.has(bestDay)) {
        // This client can't go on the cluster's day — find nearest alternative
        let altDay = -1
        let altDist = Infinity
        for (const day of activeDays) {
          if (blocked.has(day)) continue
          if (maxPerDay > 0 && (dayCount.get(day) || 0) >= maxPerDay) continue
          // Pick the day whose existing clients are closest
          const dayMembers = [...assignments.entries()].filter(([, d]) => d === day).map(([i]) => i)
          const avgDist = dayMembers.length > 0
            ? dayMembers.reduce((sum, i) => sum + matrix[idx][i], 0) / dayMembers.length
            : Infinity
          if (avgDist < altDist) { altDist = avgDist; altDay = day }
        }
        if (altDay === -1) altDay = activeDays.find(d => !blocked?.has(d)) ?? activeDays[0]
        assignments.set(idx, altDay)
        dayCount.set(altDay, (dayCount.get(altDay) || 0) + 1)
      } else {
        if (maxPerDay > 0 && (dayCount.get(bestDay) || 0) >= maxPerDay) {
          // Day is full — find nearest day with room
          let altDay = bestDay
          for (const day of activeDays) {
            if ((dayCount.get(day) || 0) < maxPerDay) { altDay = day; break }
          }
          assignments.set(idx, altDay)
          dayCount.set(altDay, (dayCount.get(altDay) || 0) + 1)
        } else {
          assignments.set(idx, bestDay)
          dayCount.set(bestDay, (dayCount.get(bestDay) || 0) + 1)
        }
      }
    }
  }

  return { assignments }
}
```

- [ ] **Step 2: Update generateOptimization to call getKMedoidsHypothesis**

In the `generateOptimization` function, find the section starting with `// ── Step 1: VROOM + cluster tightening hypothesis` and replace the hypothesis call. Change:

```typescript
hypothesisResult = await getHypothesis(withCoords, matrixSeconds, matrix, config, homeIdx)
```

to:

```typescript
const syncResult = getKMedoidsHypothesis(withCoords, matrix, config)
hypothesisResult = syncResult ? { ...syncResult, totalDurationSeconds: 0 } : null
```

Also update the cache variable names — rename `cachedHypothesisResult` type to accept `totalDurationSeconds: number` since it may be 0 now (no VROOM).

- [ ] **Step 3: Remove the VROOM import if no longer used**

Check if `solveVroom`, `VroomVehicle`, `VroomJob`, `VroomResponse` are still used anywhere else in the file. If only used in `vroomThenTighten` (which will be replaced in Task 3), keep them for now. Remove after Task 3.

- [ ] **Step 4: Run tests and build**

Run: `cd web && npx vitest run && npm run build`
Expected: All tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/optimizer.ts
git commit -m "feat: wire k-medoids into generateOptimization — replaces VROOM hypothesis"
```

---

### Task 3: Wire k-medoids into generatePerfectSchedule

**Files:**
- Modify: `web/src/optimizer.ts` (replace `vroomThenTighten` at ~line 1205 and update `generatePerfectSchedule` at ~line 1467)

- [ ] **Step 1: Replace vroomThenTighten with buildScheduleFromClusters**

Replace the entire `vroomThenTighten` function with:

```typescript
/**
 * Build schedule from k-medoids clusters.
 *
 * 1. Locked clients stay on their pinned days
 * 2. K-medoids clusters unlocked clients
 * 3. Assign clusters to days (locked clients anchor days)
 * 4. Handle recurrence: biweekly rotations, monthly placement
 * 5. Enforce peak-week capacity
 */
function buildScheduleFromClusters(
  withCoords: ClientWithDay[],
  matrixSeconds: number[][],
  activeDays: number[],
  maxJobsPerDay: number,
  recurrenceMap?: Map<string, string>,
  lockedDays?: Map<number, { day: number; rotation: 0 | 1 }>,
): InternalAssignment[] {
  const assignments: InternalAssignment[] = []
  const getFreq = (c: ClientWithDay) => recurrenceMap?.get(c.client.id) ?? c.client.frequency

  const mIdx = (clientArrayIdx: number) => clientArrayIdx + 1

  // Build client-only distance matrix (minutes)
  const n = withCoords.length
  const clientMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = matrixSeconds[mIdx(i)][mIdx(j)] / 60
      clientMatrix[i][j] = d
      clientMatrix[j][i] = d
    }
  }

  // Separate locked from unlocked
  const lockedClientIndices = new Set<number>()
  const lockedByDay = new Map<number, number[]>()

  if (lockedDays) {
    for (const [idx, locked] of lockedDays) {
      lockedClientIndices.add(idx)
      assignments.push({
        clientIdx: idx,
        dayOfWeek: locked.day,
        routeOrder: 0,
        rotation: locked.rotation,
      })
      const group = lockedByDay.get(locked.day) || []
      group.push(idx)
      lockedByDay.set(locked.day, group)
    }
  }

  const unlockedIndices = Array.from({ length: n }, (_, i) => i)
    .filter(i => !lockedClientIndices.has(i))

  if (unlockedIndices.length === 0) return assignments

  // Collect blocked days per client
  const clientBlocked = new Map<number, Set<number>>()
  for (let i = 0; i < n; i++) {
    const blocked = withCoords[i].client.blockedDays
    if (blocked && blocked.length > 0) clientBlocked.set(i, new Set(blocked))
  }

  // K-medoids on unlocked clients
  const clusters = kMedoids(unlockedIndices, clientMatrix, activeDays.length)

  // Assign clusters to days
  const dayCount = new Map<number, number>()
  for (const a of assignments) {
    dayCount.set(a.dayOfWeek, (dayCount.get(a.dayOfWeek) || 0) + 1)
  }
  const usedDays = new Set(lockedByDay.keys())

  // Sort clusters largest-first
  const sorted = [...clusters].sort((a, b) => b.length - a.length)

  for (const cluster of sorted) {
    const clusterBlocked = new Set<number>()
    for (const idx of cluster) {
      const blocked = clientBlocked.get(idx)
      if (blocked) blocked.forEach(d => clusterBlocked.add(d))
    }

    // Prefer day with locked clients closest to this cluster
    let bestDay = -1
    let bestDist = Infinity
    for (const [day, lockedIdxs] of lockedByDay) {
      if (clusterBlocked.has(day)) continue
      if ((dayCount.get(day) || 0) + cluster.length > maxJobsPerDay) continue
      let minDist = Infinity
      for (const ci of cluster) {
        for (const li of lockedIdxs) {
          if (clientMatrix[ci][li] < minDist) minDist = clientMatrix[ci][li]
        }
      }
      if (minDist < bestDist) { bestDist = minDist; bestDay = day }
    }

    // Fallback: empty non-blocked day
    if (bestDay === -1) {
      for (const day of activeDays) {
        if (usedDays.has(day)) continue
        if (clusterBlocked.has(day)) continue
        bestDay = day
        break
      }
    }

    // Fallback: any day with capacity
    if (bestDay === -1) {
      for (const day of activeDays) {
        if (clusterBlocked.has(day)) continue
        if ((dayCount.get(day) || 0) + cluster.length <= maxJobsPerDay) {
          bestDay = day
          break
        }
      }
    }

    if (bestDay === -1) bestDay = activeDays[0]
    usedDays.add(bestDay)

    // Assign cluster members, overflow if capacity exceeded
    for (const idx of cluster) {
      const blocked = clientBlocked.get(idx)
      let assignDay = bestDay
      if (blocked && blocked.has(bestDay)) {
        // Find nearest non-blocked day with room
        assignDay = activeDays.find(d => !blocked.has(d) && (dayCount.get(d) || 0) < maxJobsPerDay) ?? activeDays[0]
      } else if ((dayCount.get(bestDay) || 0) >= maxJobsPerDay) {
        assignDay = activeDays.find(d => (dayCount.get(d) || 0) < maxJobsPerDay) ?? bestDay
      }

      assignments.push({ clientIdx: idx, dayOfWeek: assignDay, routeOrder: 0, rotation: 0 })
      dayCount.set(assignDay, (dayCount.get(assignDay) || 0) + 1)
    }
  }

  // ── Biweekly rotations ──
  for (const day of activeDays) {
    const dayAssignments = assignments.filter(a => a.dayOfWeek === day)
    const weeklyCount = dayAssignments.filter(a => {
      const freq = getFreq(withCoords[a.clientIdx])
      return freq !== 'biweekly'
    }).length

    const bwOnDay = dayAssignments.filter(a => {
      return getFreq(withCoords[a.clientIdx]) === 'biweekly'
    })
    if (bwOnDay.length <= 1) continue

    const capPerRotation = Math.max(0, maxJobsPerDay - weeklyCount)
    let countA = 0, countB = 0
    for (const a of bwOnDay) {
      if (lockedClientIndices.has(a.clientIdx)) continue
      if (countA < capPerRotation && countA <= countB) { a.rotation = 0; countA++ }
      else if (countB < capPerRotation) { a.rotation = 1; countB++ }
      else { a.rotation = countA <= countB ? 0 : 1; countA <= countB ? countA++ : countB++ }
    }
  }

  // ── Peak-week enforcement ──
  for (const day of activeDays) {
    const dayAssignments = assignments.filter(a => a.dayOfWeek === day)
    const nonBw = dayAssignments.filter(a => getFreq(withCoords[a.clientIdx]) !== 'biweekly').length
    const bwA = dayAssignments.filter(a => getFreq(withCoords[a.clientIdx]) === 'biweekly' && a.rotation === 0).length
    const bwB = dayAssignments.filter(a => getFreq(withCoords[a.clientIdx]) === 'biweekly' && a.rotation === 1).length
    const peak = nonBw + Math.max(bwA, bwB)
    if (peak <= maxJobsPerDay) continue

    // Move farthest non-locked clients to nearest day with room
    const movable = dayAssignments
      .filter(a => !lockedClientIndices.has(a.clientIdx))
      .map(a => {
        const others = dayAssignments.filter(o => o.clientIdx !== a.clientIdx)
        const avgDist = others.length > 0
          ? others.reduce((sum, o) => sum + clientMatrix[a.clientIdx][o.clientIdx], 0) / others.length
          : 0
        return { assignment: a, avgDist }
      })
      .sort((a, b) => b.avgDist - a.avgDist)

    let excess = peak - maxJobsPerDay
    for (const { assignment } of movable) {
      if (excess <= 0) break
      const blocked = clientBlocked.get(assignment.clientIdx)
      const altDay = activeDays.find(d => {
        if (d === day) return false
        if (blocked && blocked.has(d)) return false
        const dAssign = assignments.filter(a => a.dayOfWeek === d)
        const dNonBw = dAssign.filter(a => getFreq(withCoords[a.clientIdx]) !== 'biweekly').length
        const dBwA = dAssign.filter(a => getFreq(withCoords[a.clientIdx]) === 'biweekly' && a.rotation === 0).length
        const dBwB = dAssign.filter(a => getFreq(withCoords[a.clientIdx]) === 'biweekly' && a.rotation === 1).length
        return dNonBw + Math.max(dBwA, dBwB) < maxJobsPerDay
      })
      if (altDay !== undefined) {
        assignment.dayOfWeek = altDay
        excess--
      }
    }
  }

  return assignments
}
```

- [ ] **Step 2: Update generatePerfectSchedule to call buildScheduleFromClusters**

Replace:
```typescript
const internalAssignments = await vroomThenTighten(
```
with:
```typescript
const internalAssignments = buildScheduleFromClusters(
```

Note: `buildScheduleFromClusters` is synchronous (no VROOM call). `generatePerfectSchedule` is still async because of `getORSMatrixSeconds`.

- [ ] **Step 3: Clean up VROOM imports**

Remove from the top of `optimizer.ts`:
```typescript
import { getORSMatrixSeconds, solveVroom } from './lib/routing'
import type { VroomVehicle, VroomJob, VroomResponse } from './lib/routing'
```

Replace with:
```typescript
import { getORSMatrixSeconds } from './lib/routing'
```

Verify no remaining references to `solveVroom`, `VroomVehicle`, `VroomJob`, or `VroomResponse` in the file.

- [ ] **Step 4: Remove dead code**

Delete these functions that are no longer called:
- `buildClusters` (old greedy clustering)
- `mergeClusters`
- `assignClustersToDays`
- `tightenClusters`
- `getHypothesis` (VROOM + tightening wrapper)
- `vroomThenTighten`

Also remove the old cache variables:
```typescript
let cachedHypothesisResult = ...
let cachedHypothesisFingerprint = ...
let cachedHypothesisClientOrder = ...
```

Replace with fresh cache for k-medoids:
```typescript
let cachedKMedoidsResult: { assignments: Map<number, number> } | null = null
let cachedKMedoidsFingerprint: string | null = null
let cachedKMedoidsClientOrder: string[] | null = null
```

Update the cache logic in `generateOptimization` accordingly (same pattern — fingerprint check, remap indices, cache miss → fresh run).

- [ ] **Step 5: Run tests and build**

Run: `cd web && npx vitest run && npm run build`
Expected: All tests pass, build succeeds. No TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/optimizer.ts
git commit -m "feat: wire k-medoids into generatePerfectSchedule, remove VROOM + dead clustering code"
```

---

### Task 4: Add placeNewClients for incremental mode

**Files:**
- Modify: `web/src/optimizer.ts` (add `placeNewClients` function)
- Modify: `web/src/__tests__/optimizer.test.ts` (add test)

- [ ] **Step 1: Write the failing test**

Add to `web/src/__tests__/optimizer.test.ts`:

```typescript
import {
  // ... existing imports ...
  kMedoids,
  placeNewClients,
} from '../optimizer'

// ... after kMedoids tests ...

describe('placeNewClients', () => {
  it('assigns new client to the nearest existing day', () => {
    // Existing schedule: day 1 has clients 0,1 (close pair), day 2 has clients 2,3 (close pair)
    const existingDays = new Map<number, number>([[0, 1], [1, 1], [2, 2], [3, 2]])
    // New client 4 is close to cluster {2,3} (E is 23-25 min from C,D)
    // But actually client 5 (F) is closest to E at 1 min
    // New client 5 is close to {4} but 4 isn't placed yet
    // Let's test with client 4 only — it's closest to {2,3} at 23-25 min vs {0,1} at 26-28 min
    const result = placeNewClients([4], existingDays, clusterMatrix, 5, [1, 2, 3])
    expect(result.get(4)).toBe(2) // should join day 2 (closer to C,D)
  })

  it('respects maxPerDay', () => {
    const existingDays = new Map<number, number>([[0, 1], [1, 1], [2, 2], [3, 2]])
    // Max 2 per day — both days are full
    // New client should go to day 3 (first available)
    const result = placeNewClients([4], existingDays, clusterMatrix, 2, [1, 2, 3])
    expect(result.get(4)).not.toBe(1) // day 1 is full
    expect(result.get(4)).not.toBe(2) // day 2 is full
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/optimizer.test.ts`
Expected: FAIL — `placeNewClients` is not exported

- [ ] **Step 3: Write the implementation**

Add to `web/src/optimizer.ts`:

```typescript
/**
 * Place new clients into an existing schedule (incremental mode).
 * Existing clients stay on their current day. Each new client is assigned
 * to the day whose existing clients they're geographically closest to.
 */
export function placeNewClients(
  newClientIndices: number[],
  existingDays: Map<number, number>,  // existingClientIdx → day
  matrix: number[][],
  maxPerDay: number,
  activeDays: number[],
  blockedDays?: Map<number, DayOfWeek[]>,
): Map<number, number> {
  const result = new Map<number, number>()
  const dayCount = new Map<number, number>()

  // Count existing clients per day
  for (const [, day] of existingDays) {
    dayCount.set(day, (dayCount.get(day) || 0) + 1)
  }

  for (const idx of newClientIndices) {
    const blocked = blockedDays?.get(idx)
    let bestDay = activeDays[0]
    let bestAvgDist = Infinity

    for (const day of activeDays) {
      if (blocked && blocked.includes(day as DayOfWeek)) continue
      if (maxPerDay > 0 && (dayCount.get(day) || 0) >= maxPerDay) continue

      // Average distance to existing clients on this day
      const dayMembers = [...existingDays.entries()]
        .filter(([, d]) => d === day)
        .map(([i]) => i)

      if (dayMembers.length === 0) continue

      const avgDist = dayMembers.reduce((sum, i) => sum + matrix[idx][i], 0) / dayMembers.length
      if (avgDist < bestAvgDist) {
        bestAvgDist = avgDist
        bestDay = day
      }
    }

    result.set(idx, bestDay)
    dayCount.set(bestDay, (dayCount.get(bestDay) || 0) + 1)
  }

  return result
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run && npm run build`
Expected: All tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/optimizer.ts web/src/__tests__/optimizer.test.ts
git commit -m "feat: add placeNewClients for incremental schedule mode"
```

---

### Task 5: Final cleanup, full test suite, push

**Files:**
- Modify: `web/src/optimizer.ts` (header comment)
- All test files

- [ ] **Step 1: Update the file header comment**

Replace the header at the top of `web/src/optimizer.ts`:

```typescript
/**
 * Schedule Optimizer — K-Medoids + Local Moves + Swap Pairs
 *
 * Each suggestion is computed against the CURRENT schedule.
 * No move depends on any other move. A "no" removes one card, everything else stays valid.
 *
 * Two types of suggestions:
 * 1. Individual moves — independently beneficial
 * 2. Swap pairs — two clients who'd both benefit from trading days
 *
 * Day assignment uses k-medoids (PAM) clustering on ORS drive time matrix.
 * Route ordering within days uses nearest-neighbor TSP + 2-opt.
 * Falls back to Haversine × 1.4 if ORS fails.
 */
```

- [ ] **Step 2: Run full test suite**

Run: `cd web && npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Build**

Run: `cd web && npm run build`
Expected: Clean build, no TypeScript errors.

- [ ] **Step 4: Commit and push**

```bash
git add web/src/optimizer.ts web/src/__tests__/optimizer.test.ts
git commit -m "chore: final cleanup — update header, verify all tests pass"
git push origin main
```

# Cluster-First Optimizer Redesign

**Date:** 2026-04-13
**Status:** Approved
**Problem:** The optimizer groups clients by route efficiency (cheapest sequential path), not geographic proximity. Clients who are physically next to each other end up on different days because they don't improve the route sequence. A far-away client gets paired with "on the way" clients instead of clients literally in their neighborhood.

## Design Principles

1. **Geography decides the groups.** Clustering is the first-class decision. "Who's near who?" is the only question for day assignment.
2. **Constraints decide which day.** Blocked days, locked clients, and max jobs per day are respected when mapping clusters to working days — never during clustering itself.
3. **Route is secondary.** Route math (TSP, VROOM) is used only to order stops within an already-decided day, and to measure savings for move cards. It never decides who goes on which day.

## Pipeline: Before vs. After

### Current (Route-First)
```
ORS Matrix → VROOM assigns days → Local move validation → Moves/Swaps
```

### New (Cluster-First)
```
ORS Matrix → clusterAssign() assigns days → VROOM/TSP orders stops per day → Local move validation → Moves/Swaps
```

## Clustering Algorithm

### Input
- All geocoded clients
- ORS NxN distance matrix (drive time in minutes, already fetched)
- `maxJobsPerDay` cap

### Steps

1. **Seed selection:** Find the two clients with the shortest drive time between them in the matrix. They become the first cluster's seed.

2. **Greedy nearest-member growth:** Repeatedly add the unassigned client who is closest to ANY member of the current cluster (minimum distance to nearest cluster member — not centroid). Stop when the cluster hits `maxJobsPerDay`.

3. **Next cluster:** From remaining unassigned clients, find the two closest to each other. Seed a new cluster. Grow it the same way.

4. **Repeat** until all clients are assigned.

### Why nearest-member, not centroid

Centroid-based growth can pull in clients that are far from every actual member but close to the geographic "average." Nearest-member guarantees every client in a cluster is within a short drive of at least one neighbor. This matches the real-world goal: neighbors on the same day.

## Cluster-to-Day Assignment

Three-step process, in order:

### Step 1: Pin locked clusters
Locked clients (confirmed/can't-move in the transition system) stay on their current day. Their cluster is pinned to that day.

### Step 2: Respect blocked days
For each unpinned cluster, collect all blocked days from its members. The cluster can only be assigned to a day not blocked by any member.

### Step 3: Assign remaining clusters to open days
Assign unpinned clusters to available working days. If multiple clusters compete for the same day, the largest cluster gets priority (more clients = more impact).

### Overflow: more clusters than working days
Merge the two closest clusters by minimum inter-cluster distance (shortest drive time between any member of cluster A and any member of cluster B). Respect `maxJobsPerDay` — if the merged cluster exceeds the cap, try the next-closest pair. Repeat until clusters fit into available days.

### Underflow: fewer clusters than working days
Some days are empty. That's correct — the engine doesn't fabricate work to fill days.

## Stop Ordering Within Each Day

After clusters are assigned to days, order the stops within each day using the existing route math:

1. Try VROOM per-day (already available via `solveVroom()`) for optimal ordering
2. Fall back to `solveRouteFromDepot()` (nearest-neighbor TSP + 2-opt) if VROOM fails

This is the only place route optimization runs. It decides visit order, not day membership.

## Move and Swap Validation (Unchanged)

The existing local validation pipeline stays identical:

- `computeMoveSavings()` — net drive time saved by moving a client between days
- `removalSavings()` / `cheapestInsertionCost()` — route insertion math for measuring impact
- `frequencyWeight()` — discounts biweekly/monthly clients
- Swap pair detection — finds pairs where both clients benefit from trading days
- `MIN_SAVINGS` threshold (5 min/wk) — filters out noise

The only difference: these functions now evaluate moves against cluster-assigned days instead of VROOM-assigned days. The math is the same; the starting point is better.

## Edge Cases

| Case | Handling |
|------|----------|
| Single outlier client (no neighbors) | Forms a cluster of 1. Gets its own day. |
| Conflicting blocked days within a cluster | Cluster stays together. Find a day that works for all members. If no day works, flag the conflict — don't break the cluster. |
| Locked client on a specific day | Seeds their cluster on that day. Unlocked nearby clients cluster around them. |
| Re-optimization after locking | Locked clients anchor clusters. Unlocked clients re-cluster around anchors and each other. |
| All clients in one area | One or two big clusters. Some days empty. Correct behavior. |
| Clients spread evenly (no natural clusters) | Algorithm still works — forms clusters of geographically nearest clients. Results may look similar to current engine in this case. |

## What Changes in Code

| File | Change |
|------|--------|
| `optimizer.ts` | New `clusterAssign()` function. `generateOptimization()` calls it instead of `getVroomHypothesis()` for day assignment. VROOM demoted to stop-ordering only. |
| `lib/routing.ts` | No changes. ORS matrix and VROOM solver stay as-is. |
| `types.ts` | No changes. `ProposedMove`, `SwapPair`, `OptimizationResult` unchanged. |
| `OptimizeView.tsx` | No changes. Consumes the same `generateOptimization()` output. |
| `TransitionView.tsx` | No changes. Consumes the same move/swap types. |
| `store.tsx` | No changes. |

## What Does NOT Change

- Move card UI, swap pair UI, confirmation flow
- Transition system (locked clients, iterations, re-optimization)
- "Different Day" picker (`computeDaySavings` — sync Haversine fallback)
- Savings calculations and reason strings
- Recurrence weighting
- ORS matrix fetching and batching
- VROOM solver code (just called differently)
- Dashboard route scoring

## Output

Identical shape to today. `OptimizationResult` with `moves`, `swaps`, `totalPotentialMinutes`, `perfectWorldMinutes`. The user sees better groupings and potentially higher savings numbers (tighter clusters = less intra-day driving).

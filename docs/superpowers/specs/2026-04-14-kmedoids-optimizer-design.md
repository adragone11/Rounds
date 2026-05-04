# K-Medoids Optimizer Redesign

**Date:** 2026-04-14
**Status:** Approved
**Replaces:** 2026-04-13-cluster-first-optimizer-design.md (failed approach)

## Problem

The optimizer must group clients into tight geographic clusters — same-color pins together on the map. Two prior approaches failed:
- **Greedy nearest-member clustering** produced chains, not clusters. Pins scattered across the map.
- **VROOM + cluster tightening** either destroyed route efficiency (292m → 411m) or tightening was gated into a no-op.

## Solution: K-Medoids (PAM)

Use the industry-standard algorithm for field service territory optimization. OptimoRoute, Workwave, and academic literature all converge on spatial clustering (k-means/k-medoids) as the correct approach.

K-medoids (PAM — Partitioning Around Medoids, Kaufman & Rousseeuw 1987) works directly with the ORS drive time matrix. It picks actual clients as cluster centers (medoids) and assigns every other client to their nearest medoid. Unlike k-means, it doesn't need Euclidean coordinates — it works with any distance matrix, including real road-network drive times.

## Algorithm: PAM

### Input
- N clients with ORS NxN drive time matrix (minutes)
- K = number of working days

### Steps

**1. BUILD initialization** — select K starting medoids:
- First medoid: the client that minimizes total distance to all others
- Each subsequent medoid: the client whose addition reduces total cost the most (total cost = sum of each client's distance to its nearest medoid)

**2. Assign** — every non-medoid client is assigned to the cluster of its nearest medoid (by drive time)

**3. SWAP** — for each medoid m, try swapping it with every non-medoid o:
- Compute total cost if o becomes the medoid instead of m
- If any swap reduces total cost, make the best swap

**4. Repeat** steps 2-3 until no swap improves the result (convergence)

### Output
K clusters of client indices. Each cluster is a geographic zone.

### Complexity
O(K × (N-K)² × N) per iteration. For typical inputs (N=20-40 clients, K=5 days), this is milliseconds. No performance concern.

## Constraint Integration

Constraints are applied AFTER clustering, not during. K-medoids produces the purest geographic grouping, then constraints trim the edges.

### Step 1: K-medoids → K clusters (pure geography)

### Step 2: Assign clusters to working days
- Each cluster gets one working day
- Collect blocked days from all members of each cluster
- Assign clusters to days that no member has blocked
- If a cluster has members blocking different days, assign the day that satisfies the most members. Move conflicting clients (those who have that day blocked) to the nearest cluster whose assigned day works for them.

### Step 3: Enforce max jobs per day
- If a cluster exceeds `maxJobsPerDay`, keep the clients closest to the medoid (the core), move the farthest members to the nearest cluster with room
- Peak-week capacity: weekly count + max(biweekly rotation A, rotation B) must not exceed maxJobsPerDay

### Step 4: Handle recurrence
- Weekly: occupies a slot every week
- Biweekly: split into rotation A/B within their day. Balance rotations so peak week doesn't exceed cap.
- Monthly/custom: placed in the lightest week on their assigned day
- One-time: placed in the lightest week

### Step 5: Route ordering within each day
- Use `solveRouteFromDepot()` (nearest-neighbor TSP + 2-opt) to order stops
- VROOM is available as an optional upgrade for stop ordering but is NOT used for day assignment

## Two Modes

### Mode 1: "Best Schedule" (build from scratch)
First-time setup or full re-plan. All clients treated as unassigned.

- Input: all clients + ORS matrix + constraints (maxJobsPerDay, workingDays, blockedDays, recurrence)
- Process: full k-medoids on entire roster → constraint application → route ordering → 4-week grid
- Output: `PerfectScheduleResult` — complete schedule with assignments, rotations, grid, route order, drive time comparison

### Mode 2: "Add Clients" (incremental)
Adding new clients to an established schedule. Existing clients locked.

- Input: new clients + existing schedule (locked) + ORS matrix + constraints
- Process: for each new client, find which existing day they're closest to (by drive time to that day's members). Assign to closest day with capacity. No existing clients move.
- Output: suggested day for each new client

### When to use which
The cleaner chooses. "Best Schedule" button rebuilds everything. Adding new clients uses "Add Clients" mode. Over time as the roster changes significantly, the cleaner can hit "Best Schedule" again for a fresh optimization.

This matches OptimoRoute's "plan from scratch" vs "re-optimize with locks" and Workwave's "full optimization" vs "insert new stops."

## What Changes in Code

### Replace (remove)
| Function | Why |
|----------|-----|
| `buildClusters()` | Greedy nearest-member — produces chains |
| `mergeClusters()` | Needed by buildClusters |
| `assignClustersToDays()` | Needed by buildClusters |
| `tightenClusters()` | Route-gated tightening — either destructive or no-op |
| `getHypothesis()` | VROOM + tightening wrapper |
| `vroomThenTighten()` | VROOM + clustering fallback + tightening |

### Add
| Function | Purpose |
|----------|---------|
| `kMedoids(indices, matrix, k)` | PAM algorithm — returns K clusters |
| `assignClustersToSchedule(clusters, config)` | Constraint application — blocked days, capacity, recurrence |
| `buildScheduleFromClusters(clients, matrix, config)` | Full pipeline: k-medoids → constraints → route ordering |
| `placeNewClients(newClients, existingSchedule, matrix, config)` | Incremental mode — find best day for new clients |

### Keep unchanged
| Function | Why |
|----------|-----|
| `solveRoute()`, `solveRouteFromDepot()` | Stop ordering within days |
| `routeCost()`, `removalSavings()`, `cheapestInsertionCost()` | Move validation math |
| `computeMoveSavings()`, `computeDaySavingsFromMatrix()` | Move suggestion scoring |
| `generateOptimization()` | Move card pipeline — uses k-medoids hypothesis instead of VROOM |
| `generatePerfectSchedule()` | Calls buildScheduleFromClusters instead of vroomThenTighten |
| `computeDaySavings()` | Sync fallback for "Different Day" picker |
| `buildRosterFingerprint()` | Cache key |
| Swap pair detection | Output unchanged |

### No changes
| File | Reason |
|------|--------|
| `lib/routing.ts` | ORS matrix + VROOM stay as-is |
| `types.ts` | ProposedMove, SwapPair, OptimizationResult, PerfectScheduleResult unchanged |
| `OptimizeView.tsx` | Consumes same generateOptimization() output |
| `TransitionView.tsx` | Consumes same move/swap types |
| `store.tsx` | No changes |

## Success Criteria

Look at the map. Same-color pins are together. Different colors are in different areas. If colors are scattered, the algorithm is wrong.

## Industry Validation

This approach is used by:
- **OptimoRoute** — multi-day planning with spatial clustering, $35-50/driver/month
- **Workwave** — zone-based territory optimization for recurring field service
- **Academic literature** — PAM (1987), widely cited for territory planning and VRP decomposition

Neither ServiceTitan nor Housecall Pro offers algorithmic territory optimization — they rely on manual dispatch. This is a gap Pip fills for the solo cleaner segment.

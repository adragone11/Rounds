---
tags: [bug, optimizer, analysis, mobile-comparison]
severity: high
status: identified
date: 2026-04-08
---

# Optimizer Gaps: Web vs Mobile

Analysis of 5 bugs + comparison with mobile's more mature optimization engine (autoSort + smartPlacement).

## Bug 1: VROOM Cache Doesn't Track Day Assignments
**File:** `optimizer.ts:434` — `buildRosterFingerprint()`
**Problem:** Fingerprint hashes `id:lat:lng` but NOT `currentDay`. If you move a client from Monday to Tuesday and re-run, the cache returns the stale hypothesis because the fingerprint didn't change.
**Fix:** Include `currentDay` in the fingerprint: `${id}:${lat}:${lng}:${currentDay}`

## Bug 2: Recurrence Invisible to Optimizer
**Problem:** A biweekly client on Monday only drives that route every other week, but the optimizer counts them as full-time. This inflates savings for biweekly/monthly clients.
**Mobile approach:** 3-phase optimization — weekly clients first, then biweekly (2N vehicles), then monthly. Each frequency tier gets its own VROOM config.
**Web fix needed:** Weight clients by frequency when computing route costs. Weekly = 1.0 weight, biweekly = 0.5, monthly = 0.25. Or run separate VROOM passes per frequency tier like mobile.

## Bug 3: Service Time Hardcoded at 30 min
**File:** `optimizer.ts:388` — `service: 1800`
**Problem:** VROOM subtracts `withCoords.length * 1800` to isolate travel time. If a client takes 2 hours, "perfect world" savings calculation is wrong.
**Mobile approach:** Per-job `durationMinutes` from client data.
**Web fix needed:** Add `durationMinutes` field to Client type, use it in VROOM jobs. Default 30 min if unset.

## Bug 4: getBestDays Uses Naive Haversine
**File:** `store.tsx:439-478`
**Problem:** Simple average distance to neighbors, no route-based cost. The optimizer has proper insertion-cost math via `computeDaySavingsFromMatrix`.
**Fix:** Replace with `computeDaySavings()` which already exists and uses proper route math with Haversine matrix.

## Bug 5: No 2-opt on Web Routes
**Problem:** Web's `solveRoute` only does nearest-neighbor from every starting point. Mobile runs 2-opt improvement after NN. For 5+ stops, 2-opt meaningfully improves route quality and savings accuracy.
**Fix:** Add 2-opt improvement pass after NN in `solveRoute` and `solveRouteFromDepot`.

---

## Mobile vs Web Comparison

| Dimension | Mobile (autoSort + smartPlacement) | Web (optimizer.ts) |
|-----------|-----------------------------------|-------------------|
| **Goal** | Assign N unplaced clients to days | Suggest moves for already-placed clients |
| **VROOM role** | Primary solver — assigns clients to days | Hypothesis generator — validated independently |
| **Vehicles** | N vehicles (1/day) for weekly; 2N for biweekly | 1 vehicle per working day, no recurrence awareness |
| **Recurrence** | 3-phase: weekly → biweekly → monthly, each with dedicated VROOM config | Ignored — treats all clients as "every week on day X" |
| **Route math** | VROOM optimal → NN chain fallback → 2-opt improvement | NN from every start point (no 2-opt) |
| **Home address** | Used in autoSort, optional in smartPlacement | Required, depot-anchored routes |
| **Independence** | All-at-once batch assignment | Each move validated alone (no cascading) |
| **Swap detection** | None | Yes — mutual-benefit pair detection |
| **Duration** | Per-job durationMinutes | Hardcoded 1800s (30 min) for all |
| **Capacity** | maxJobsPerDay + availableMinutes | maxJobsPerDay only |

## What Web Does Better
- **Independent validation** — each suggestion is safe on its own, no cascading failures
- **Swap detection** — finds mutual-benefit pairs that mobile doesn't look for
- **Iterative workflow** — user can confirm/reject moves one at a time vs batch assignment

## What Mobile Does Better
- **Recurrence-aware VROOM** — separate passes per frequency tier
- **Per-client duration** — VROOM knows actual job times
- **2-opt improvement** — better route quality
- **Time-based capacity** — availableMinutes, not just job count
- **Weighted route costs** — biweekly clients count as half

## Priority Order for Fixes
1. **Bug 1** (fingerprint includes currentDay) — easy, critical for cache correctness
2. **Bug 5** (2-opt) — medium, improves all savings calculations
3. **Bug 2** (recurrence weighting) — medium-hard, biggest accuracy improvement
4. **Bug 4** (getBestDays) — easy, use existing computeDaySavings
5. **Bug 3** (per-client duration) — needs UI for setting duration per client

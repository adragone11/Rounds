---
tags: [bug, optimizer, fixed]
severity: high
fixed: 2026-04-08
---

# VROOM Non-Deterministic Results

## Problem
Running the optimizer multiple times gives different suggestions each time. Users can't rely on "Looks Good" to stick — refreshing generates completely new moves/swaps.

## Root Cause
VROOM is a heuristic VRP solver with randomized tie-breaking. Each call can produce a different "ideal schedule" hypothesis, which changes which clients are flagged as "misplaced" and which swaps are suggested.

## Fix
Cache VROOM results by **roster fingerprint** — a hash of all client IDs + coordinates, sorted. Same roster = same cached hypothesis = same suggestions every time.

Cache invalidation triggers:
- Client added → fingerprint changes → fresh VROOM
- Client removed → fingerprint changes → fresh VROOM
- Client address changes (new lat/lng) → fingerprint changes → fresh VROOM
- Confirming a move → fingerprint unchanged → same hypothesis

## Files Changed
- `src/optimizer.ts` — `buildRosterFingerprint()`, VROOM cache logic
- `src/components/OptimizeView.tsx` — persist fingerprint, check on load

---
tags: [architecture, optimization, vroom]
updated: 2026-04-08
---

# Optimization Engine Architecture

## Pipeline
1. **ORS Matrix** — NxN drive time matrix between all clients (real road times)
2. **VROOM Hypothesis** — VRP solver generates "ideal schedule" (cached by roster fingerprint)
3. **Phase A: VROOM-guided** — validate each "misplaced" client independently
4. **Phase B: Full scan** — catch moves VROOM missed
5. **Phase C: Swap pairs** — find pairs that benefit from trading days (capped at 3 per client)

## Key Principles
- **Independent moves** — each suggestion is valid on its own, no cascading dependencies
- **VROOM is a hypothesis, not a mandate** — it guides where to look, local validation ensures safety
- **Roster fingerprint caching** — VROOM only re-runs when clients change
- **Max jobs per day** — enforced in both individual moves AND swap pairs
- **Recurrence-aware** — optimizer works in "day of week" space, not specific dates

## External Services
- **ORS Matrix API** (`/api/ors-matrix`) — drive time calculations
- **ORS Directions API** (`/api/ors-directions`) — route geometry for map polylines
- **VROOM** (`pip-vroom.fly.dev`) — VRP solver for schedule optimization
- **ORS Geocode** (`/api/geocode`) — fallback geocoding for bulk import

## Data Flow
```
User clicks Optimize
  → Build ORS matrix (all clients + home)
  → Check roster fingerprint → cached VROOM or fresh run
  → VROOM returns ideal day assignments
  → Local validation: check each move independently
  → Generate swap pairs (max 3 per client, respects capacity)
  → Cache results with fingerprint
  → Display in OptimizeView sidebar
```

## Swap Rules
- Both clients must be on different days
- Both days must be working days
- Destination days must have capacity (maxJobsPerDay)
- Both clients must individually benefit (positive savings)
- Combined savings must exceed 10 min/wk threshold
- Max 3 swaps per client (sorted by total savings)

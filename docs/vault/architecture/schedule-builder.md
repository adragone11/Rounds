---
platform: web
tags: [architecture, web, schedule-builder, smart-placement, time-budget]
updated: 2026-04-22
---

# Schedule Builder — Pip Web

> **Scope:** `pip-web` only (Vite + React + TypeScript). Schedule Builder, Smart Placement, the time budget, and Apply/Transition all live on web. Mobile (Pip, React Native + Expo) consumes the same Supabase `clients` table but does not run the optimizer or hold placement/recurrence meta.

The Schedule Builder is the planning surface where the owner configures a roster (frequency, duration, blocked days, working hours per day), then generates an optimized week. Apply commits the plan via the Transition flow.

## Entry Points
- `src/pages/ScheduleBuilder.tsx` — main UI (roster table + preview calendar + controls)
- `src/optimizer.ts` — optimization engine (`generatePerfectSchedule`, `buildScheduleFromClusters`, `computeSmartPlacement`, `computeSwapCandidates`)
- `src/store.tsx` — `scheduleMeta` (recurrence) + `placements` (one-offs) + mutation primitives, `applyNewScheduleFromBuilder`

## Roster Configuration (per client)
- **Frequency**: `weekly | biweekly | monthly | one-time | custom`
- **Interval weeks**: biweekly = 2 with rotation 0 (Wk 1,3) or 1 (Wk 2,4)
- **Duration**: minutes, used for time-budget capacity
- **Blocked days**: hard constraint — client cannot be placed on these weekdays

**Default cadence**: new-to-builder clients → `biweekly` (not weekly).

## Day Configuration
- **Working days**: boolean per weekday (Mon/Tue/Wed...)
- **Max jobs/day**: count cap (default 5)
- **Working hours**: start/end time inputs (default 8:00–17:00 = 9hr window). *Added 2026-04-22.*

## Time Budget (added 2026-04-22)
Sum of job durations on any day must fit the working window. Drive time intentionally NOT counted — location grouping is assumed to make travel negligible.

- `OptimizeConfig.workingMinutes` = `dayEnd - dayStart`
- In `buildScheduleFromClusters`, `peakMinutes(cluster)` runs alongside `peakCount(cluster)`
- Peak-week duration math: `weekly + ceil(biweekly/2) + monthly + custom` (same shape as peakCount)
- Both caps apply; first hit rejects the day; optimizer tries next-best day
- If nothing fits, client lands in the Bench with a time-based reason

### Bench behavior
Bench is the last resort. The optimizer already tries every day in route-cost order before benching. A benched client means:
- Their duration alone exceeds the window
- Every working day is full (count OR time)
- Blocked-days conflict with remaining capacity

## Optimization Flow
```
User clicks Generate
  → Build ORS matrix (drive times between all clients + home)
  → Cluster clients via greedy nearest-N with dual cap (count + time)
  → Assign clusters → active days (tightest first)
  → Split biweekly into A/B rotations via k-medoids(k=2)
  → Monthly/custom → nearest day, lightest week
  → Rebalance overflow days
  → Emit OptimizationResult with assignments + changes + bench
  → Preview on calendar
  → User clicks Apply → Transition flow kicks in
```

## Key Principles
- **Strict recurrence awareness** — biweekly only fits where both A and B rotations have capacity (no partial fits)
- **Independent assignments** — each client's placement is valid on its own
- **Frequency is immutable** during optimization — only days move
- **Location-first** — route cost drives day assignment; time cap is just a gate

## Smart Placement (sidebar recommender)
Separate from the main optimizer. When the user selects an unplaced client, Smart Placement recommends the best weekday.

- **Gate: ≥1 placed neighbor** — with zero neighbors every day scores the same; shows a hint instead. *Added 2026-04-22.*
- **Strict fit via `dateFits`** — checks both count cap AND time cap (using `smartConfig.workingStart/End`)
- **Recurrence-aware biweekly**: checks both A and B rotations
- **Preview button**: shows placement on calendar before committing
- **Enable/disable toggle** in settings
- **Reason**: displays why (neighbors, cluster distance, capacity)

## Apply → Transition Handoff
On Apply:
1. Generate `applyId` (UUID)
2. Capture Undo snapshot (placements + scheduleMeta + client scheduling meta)
3. Freeze pre-startDate dates
4. Clear all recurrences
5. Build `TransitionMove` for every client in the plan (changed + unchanged)
6. Navigate to `/schedule` with `transitionMoves` + `applyId` in route state
7. Schedule.tsx dispatches `LOAD_TRANSITION`
8. Sidebar opens; each confirm calls `reanchorClient`

See [[transition-flow]] for the commit model and persistence details.

## UI — Preview Grid
`WeekTimeGrid.tsx` renders the day columns with time-based positioning. Per-leg drive chips show between consecutive cards:
- **Home → first** (🏠 14m) — floating badge at top of block0 (fixed 2026-04-22; was clipping)
- **Mid-gap** — centered between consecutive cards if gap > 14px

Day header shows: day name · count/max · total drive minutes.

## See Also
- [[transition-flow]] — commit model and state machine
- [[swap-feature]] — symmetric swap for Can't Move cases
- [[optimization-engine]] — VROOM pipeline details
- [[message-templates]] — Transition copy presets

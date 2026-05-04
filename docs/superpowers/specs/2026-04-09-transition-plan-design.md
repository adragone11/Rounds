# Transition Plan — "How Do We Get There?"

**Date:** 2026-04-09
**Status:** Approved
**Approach:** Migration Queue (Approach A)

## Problem

The Perfect Schedule generates an ideal schedule, but getting there requires asking clients to move days. Most say yes, but one "no" can cascade and force a complete redo. We need a system that handles rejections gracefully — locking in confirmed moves, absorbing rejections as constraints, and re-optimizing around them.

## Core Flow

1. **User generates Perfect Schedule** (existing wizard — no changes)
2. **System diffs** perfect vs. current → produces a ranked list of `ProposedMove`s ordered by savings (biggest first)
3. **User opens Transition Plan** via a new button (separate from Optimize and Perfect Schedule)
4. **User works through the list:**
   - Marks a client **confirmed** → move applies immediately to the real schedule, position is **locked**
   - Marks a client **can't move** → client stays on their current day, position is **locked**
5. **On any rejection:** re-run optimizer with all locked positions as fixed constraints. Remaining unconfirmed moves update.
6. **Done when:** all clients are resolved, user manually exits, or remaining savings are negligible.

User can skip around the list — order is suggested (biggest savings first) but not enforced.

## Data Model

### Extended `ProposedMove`

Add to existing type:

- `locked: boolean` — true once confirmed OR rejected
- `originalDay: number` — client's day before transition started
- `iteration: number` — which re-optimization pass generated this move

### New `TransitionState`

```typescript
interface TransitionState {
  moves: ProposedMove[];
  lockedClientIds: string[];
  iteration: number;
  status: 'active' | 'paused' | 'completed';
  startedAt: string;
  perfectScheduleSnapshot: GridCell[][];
}
```

### Storage

localStorage under `pip-transition` key. Same pattern as current OptimizeView (`pip-optimization`). No Supabase for v1.

### Key Principle

The real schedule (placements + recurrence metadata) updates live as moves are confirmed. The transition state is a separate tracking layer for what's left to do.

## UI & Entry Point

### New Button

"Transition Plan" button in schedule header, alongside existing Optimize and Perfect Schedule buttons. Existing buttons stay untouched.

### Transition View (sidebar panel)

Similar to OptimizeView layout:

- **Stats bar (top):** X of Y resolved, Z minutes saved so far
- **Move checklist:** Each row shows:
  - Client name
  - Current day → proposed day
  - Estimated time savings
  - Status badge: pending / waiting / confirmed / can't-move
  - Action buttons: "Confirmed" / "Can't Move"
- **Update indicators:** After re-optimization, moves that changed show an "updated" badge

### User Flow

Perfect Schedule (generate ideal) → Transition Plan (get there incrementally) → each confirmation updates the real calendar live

## Re-optimization on Rejection

### Inputs

- All locked positions (confirmed on new days + rejected on current days) — fixed, untouchable
- All unconfirmed clients — free to be re-assigned
- Original config: working days, max jobs/day, home address

### Algorithm

Re-run the full optimizer pipeline (VROOM hypothesis → local validation → savings calculation) with locked clients pre-placed as immovable appointments. The full pipeline is needed (not just local validation) because locked constraints change the problem space — VROOM needs to re-solve the VRP with different fixed nodes.

### Minimal Change Bias

Before full re-solve, check if remaining unconfirmed moves still work as-is. If the rejection doesn't affect other moves (independent client), skip re-optimization — just remove that move from the queue. Only re-solve when the rejection actually breaks another move's savings.

### Post Re-optimization

- Moves that stay the same: unchanged
- Moves with new suggested day: marked "updated" + iteration number
- Moves no longer worth it: removed from queue
- New opportunities from locked positions: added to queue

## Edge Cases

### "Good Enough" Exit

User can stop anytime. Confirmed moves are already applied. Unresolved moves stay in the queue for later.

### All Confirmed

Transition auto-completes. Clean up transition state.

### Negligible Remaining Savings

If remaining moves save <2 minutes each total, surface: "Remaining moves save less than X minutes total. Your schedule is close enough." User decides to stop or continue.

### Client Roster Changes Mid-Transition

If user adds/removes a client during active transition, mark transition as stale. Prompt: "Your client list changed. Re-generate the transition plan?" Don't silently invalidate moves.

### One Longer Day (Max Jobs Exceeded)

If locking a rejected client means a day exceeds max jobs/day, surface to user: "Wednesday now has 7 jobs (your max is 6). You can adjust your max or leave it." Don't silently break constraints.

### Biweekly Rotation

When a biweekly client confirms a move, update their A/B rotation assignment. Re-optimizer respects existing force-balance logic (50/50 across rotation A/B per day).

### Already on Perfect Day

Clients who don't need to move are excluded from the queue — they're pre-locked.

## Tuning Knobs (Flag for Later)

These are configurable decisions to revisit after real-world testing:

- **Ask ordering strategy:** Currently biggest-savings-first. Could be confidence-based or dependency-aware later.
- **Re-optimization aggressiveness:** Minimal diff vs. full re-solve. Currently: check independence first, re-solve only if needed.
- **Auto-lock timing:** When to consider a move "locked" — currently on explicit user action only.
- **Savings threshold:** What counts as "negligible" remaining savings.

## Future Evolution

**Living Target (Approach B):** The perfect schedule continuously re-computes as confirmations/rejections come in, always showing the best possible outcome. Main UX challenge: the target moves, needs change-tracking UI. See memory: `project_schedule_transition.md`.

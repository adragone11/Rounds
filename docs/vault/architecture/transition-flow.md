---
platform: web
tags: [architecture, web, transition, commit-model, persistence]
updated: 2026-04-22
---

# Transition Flow (Commit Model) — Pip Web

> **Scope:** `pip-web` only (Vite + React + TypeScript). The mobile app (Pip, React Native + Expo) shares the Supabase `clients` table but does NOT share placements, recurrence meta, Transition state, or the commit model described here.

Transition is the **commit mechanism** between the Schedule Builder's proposed plan and the live schedule. Not a notification list — it's where the plan lands on the calendar, one client at a time.

## Core Files
- `src/components/TransitionView.tsx` — UI, state machine, swap/revert/undo handlers, template picker
- `src/pages/Schedule.tsx` — reducer, persistence plumbing, Transition button toggle
- `src/store.tsx` — `reanchorClient`, `unconfirmClient`, `applyNewScheduleFromBuilder`, `undoLastApply`, `lastApplyId`
- `src/optimizer.ts` — `computeSwapCandidates`

## The Commit Model (why it exists)
Old: Apply wrote everything to the calendar immediately. If a client said no, you'd already moved them.

Now:
1. **Apply freezes the past** — pre-startDate placements stay
2. **Apply clears all recurrences** — `scheduleMeta[clientId].frequency = 'one-time'`, `startDate = null`
3. **Future is empty** until each client is confirmed individually
4. **Each Confirm re-anchors one client** via `reanchorClient` — writes new frequency + startDate, preserves pre-anchor placements

At any moment, the calendar shows exactly the commits so far. No cleanup if user abandons.

## Persistence (added 2026-04-22)

### Keyed by applyId
Each `applyNewScheduleFromBuilder` generates a UUID and stamps it on:
- The Undo snapshot (`pip-apply-undo.applyId`)
- The Transition state (passed via `LOAD_TRANSITION` payload, stored in `trans.applyId`)

A fresh Apply = new applyId = stale state orphaned automatically. No cross-session bleed.

### Two persistence layers
1. **Parent reducer state** (`Schedule.tsx`) — moves, recMap, rotations, startDate, config, applyId
   - Key: `pip-transition-context`
   - Saved on every reducer change
2. **TransitionView internal state** — statuses, locked, iteration, preSwapSnapshots
   - Key: `pip-transition-state-<applyId>`
   - Saved on every setState
   - Restored on mount ONLY when applyId matches

### Lifecycle
- **Fresh Apply** → new applyId → persistence keyed to new id → old key orphaned
- **Close Transition** → hide only, no destroy
- **Reopen Transition** → state still there, picks up where left off
- **Reload browser** → parent reducer rehydrates from `pip-transition-context`, TransitionView rehydrates from keyed state
- **Start fresh** (in sidebar) → clears both keys + wipes parent reducer
- **Finish transition** → same as Start fresh
- **Undo Apply** → also clears both persistence keys (snapshot → state must match)

## State Machine

### `TransitionMove`
```ts
{
  clientId, clientName
  currentDay, currentRotation        // where they were before
  suggestedDay, targetRotation       // where they should go
  frequency, intervalWeeks
  savingsMinutes, reason, suggestedMessage
  status: 'to-ask' | 'waiting' | 'confirmed' | 'cant-move' | 'skipped'
  locked: boolean                    // true after Confirm or explicit Can't Move
  iteration: number                  // bumps on mutation (drives "updated" badge)
  swapPartnerClientId?: string       // set when originated from a swap
  preSwapSnapshot?: {                // captured pre-swap; used for Undo swap
    suggestedDay, targetRotation, reason, suggestedMessage
  }
}
```

### Sections
- **To Resolve** — `!locked && !isCarryover` — main work queue, grouped by suggestedDay
- **Carryover** — unchanged clients (`currentDay === suggestedDay`), with "Confirm all" bulk action
- **Resolved** — `locked` — confirmed or cant-move; shows Revert + Undo swap (if part of pair)

### Status transitions
```
to-ask ──confirm──▶ confirmed (locked=true) → reanchorClient
        ──cant-move──▶ cant-move (locked=true) → opens swap picker
        ──waiting──▶ waiting (no commit)

confirmed ──revert──▶ to-ask (calls unconfirmClient)
cant-move ──revert──▶ to-ask
cant-move ──trade──▶ both cards flip to to-ask, locked=false, iteration++

any state (part of swap) ──undo swap──▶ both cards → to-ask with pre-swap
  day/rotation restored; tags cleared; prior confirms un-placed
```

## Message Tone Templates
Four presets (Warm / Pricing / Reliability / Transparent) rendered from `(firstName, newDay)`. Chip picker in the header. Active template applies to every card's preview + Copy. Persisted via `pip-transition-template`. See [[message-templates]].

## UI Toggle
- Transition button in `Schedule.tsx` header dispatches `TOGGLE_TRANSITION`
- Label flips between "Transition" and "Hide Transition"
- Hiding preserves state; showing rehydrates

## Apply Warning Modal
Before Apply fires, the confirm modal in ScheduleBuilder shows:
- Cutover date impact
- "Jobs before X stay as-is; from that date forward, this schedule replaces everything"
- "You can undo this apply anytime until you finish Transition"

The Undo Apply button in Schedule header also now warns about Transition confirmations being lost: "This restores your previous schedule and will discard 7 Transition confirmations."

## See Also
- [[schedule-builder]] — upstream planning flow + time budget
- [[swap-feature]] — symmetric swap + Undo swap logic
- [[message-templates]] — tone presets
- [[optimization-engine]] — where the proposal comes from

---
name: Sandboxed Schedule Change
description: Isolate the Schedule Change flow from the live calendar so mobile/web sync stays clean until a final atomic Apply
date: 2026-04-22
status: Draft
---

# Sandboxed Schedule Change

## Problem

Today's flow mutates the live calendar mid-transition:

1. User builds a new schedule in Schedule Builder (config → 4-week grid with all clients placed).
2. Clicking "Apply to Schedule" immediately clears every client's existing recurrence and enters the Schedule Change panel.
3. Each client confirm in Schedule Change writes directly to the live schedule.
4. If the user walks away mid-transition, the live calendar is in a half-broken state: recurrences cleared, only some clients re-placed.

Mobile and web share the live schedule. Partial state leaks to mobile the instant the user clicks Apply — and stays broken until every client is confirmed.

Goal: the transition workspace must not touch the live calendar until a single atomic commit at the end.

## Solution summary

Two applies, one atomic commit:

1. **Builder → "Start Schedule Change"**: creates a `SchedulePlan` draft in localStorage. No live-calendar changes.
2. **Plan workspace** (same UI shape as today's Schedule Change panel): user confirms each client and handles "can't move" via the existing swap mechanic. All state lives in the plan.
3. **Plan → "Apply to Schedule"** (enabled only when every client is confirmed): shows the existing cutover-date modal. On confirm, a single atomic transaction kills old recurrences at the cutover date and creates new ones starting from the cutover date.

The live schedule stays completely untouched while a plan is active. Mobile sees no intermediate state.

## Flow

1. **Schedule Builder config** — unchanged.
2. **Schedule Builder grid** — unchanged. Button at bottom renamed from "Apply to Schedule" to **"Start Schedule Change"**. Disabled until all clients are placed (existing gating).
3. **Click "Start Schedule Change"** — creates a `SchedulePlan` with the Builder's placements as `builderSnapshot`. Navigates to the plan workspace. No live mutations.
4. **Plan workspace** — reuses the current Schedule Change UI (map + month calendar + sidebar list of clients to resolve). Reads and writes only to the `SchedulePlan`.
   - Confirm a client → their status moves to `confirmed` in the plan.
   - "Can't move" → existing swap picker; pick a target; both clients swap `plannedDay` within the plan. Both remain (or re-enter) the confirmation queue if their days changed post-confirmation.
   - Undo swap — existing functionality, scoped to the plan.
5. **Exit anytime** — plan persists in localStorage. Main app's "Schedule Builder" button detects an active plan and routes to the plan workspace, not a fresh Builder session.
6. **All clients confirmed** — final "Apply to Schedule" button enables in the plan workspace.
7. **Click Apply** — show the existing cutover-date modal (Today / Next Monday / custom date picker, plus the "Jobs before X stay as-is / from X forward, this replaces everything" copy).
8. **Confirm in modal → atomic commit**:
   - For every client in the plan: mark all existing recurrences as ending the day before cutover.
   - For every client in the plan: create new recurrences with `plannedDay` starting from the first occurrence ≥ cutover date.
   - Set plan `status` to `committed`.
   - Redirect to main Schedule view.

## Data model

```ts
interface SchedulePlan {
  id: string;                          // uuid
  builderSnapshot: GridCell[][];       // the 4-week Builder output, frozen
  clients: ClientInPlan[];
  status: 'active' | 'committed' | 'discarded';
  createdAt: string;                   // ISO
  rosterSnapshot: string[];            // client IDs present when plan was created
}

interface ClientInPlan {
  clientId: string;
  plannedDay: DayOfWeek;               // current target day within the plan
  originalPlannedDay: DayOfWeek;       // day Builder originally assigned (for diffing)
  status: 'pending' | 'confirmed';
  swapHistory: Swap[];
}

interface Swap {
  swappedWithClientId: string;
  dayBefore: DayOfWeek;
  dayAfter: DayOfWeek;
  timestamp: string;
}
```

**Storage key:** `pip-schedule-plan` (replaces the existing `pip-transition` key).

**Migration:** in-flight `pip-transition` states are discarded on first load after the update. Acceptable risk — the existing transition state is already fragile, and users on that key have a broken live calendar we'd inherit if we migrated. Surface a one-time toast: "Your in-progress transition was reset. Re-run Schedule Builder to start over."

## Atomic commit semantics

The commit is a single transaction:

1. For each `ClientInPlan`, locate the client's recurrence records.
2. End-date every existing recurrence at `cutoverDate - 1 day`.
3. Create a new recurrence starting at the first `plannedDay` on or after `cutoverDate`. Frequency, duration, and blocked-day metadata come from the Builder snapshot.
4. Clients not in the plan are **untouched**. (Because the Builder requires all clients to be placed, this is only meaningful if the user is using only the subset of active clients they chose at Builder-config time. Anyone added after Builder started is handled via the roster-drift banner — see Edge Cases.)
5. Update the plan's `status` to `committed`.

All writes happen in the same store update so a mid-commit failure leaves no partial state. If the commit throws, the plan stays `active` and the live schedule is unchanged.

Jobs before `cutoverDate` are never modified. One-off jobs (non-recurring) are never touched.

## Resume UX

When the main app's "Schedule Builder" button is clicked:

- **No active plan:** open a fresh Builder config (current behavior).
- **Active plan:** navigate directly to the plan workspace with an indicator: "Resuming Schedule Change — X of Y clients confirmed."

"Discard plan" button in the plan workspace clears `SchedulePlan` and returns the user to the main Schedule view. Live calendar untouched (since we never touched it).

## Edge cases (v1 minimums)

- **Roster drift while plan is active:** compare current roster against `rosterSnapshot` on plan-workspace mount. If different, show a non-blocking banner: "Client list changed since this plan was created. Regenerate to include [Name] / remove [Name]." User proceeds at their discretion. Apply is not blocked.
- **Cutover date in the past:** modal allows past dates. No guardrail in v1 (user may want backfill).
- **Browser localStorage cleared:** plan is lost. Same risk as existing `pip-transition`. Acceptable for v1.
- **Committed plan, user wants to undo:** not supported in v1. Once applied, recurrences are live. User would re-run Builder. Document this limitation in the commit modal copy.
- **User starts a new Builder session while a plan is active:** "Start Schedule Change" is hidden in the Builder; instead, user sees "You have an active plan — resume or discard." This prevents two concurrent plans.

## What changes in code

- `web/src/types.ts`: add `SchedulePlan`, `ClientInPlan`, `Swap` types. Retire `TransitionState`.
- `web/src/store.tsx`: replace `pip-transition` state with `pip-schedule-plan`. Add `createPlan`, `updatePlan`, `commitPlan`, `discardPlan` actions. No live-schedule writes until `commitPlan`.
- `web/src/components/TransitionView.tsx`: rewire all confirm/swap/undo handlers to write to plan state, not schedule. Rename file to `PlanWorkspaceView.tsx` if low-risk; otherwise keep name and document the rename for a later pass.
- `web/src/components/ScheduleBuilderView.tsx` (or equivalent): rename "Apply to Schedule" button to "Start Schedule Change". On click: create plan, navigate to workspace. Remove the pre-existing recurrence-clearing side effect.
- Main Schedule view: detect active plan, change Schedule Builder button behavior to "Resume Schedule Change" with a pill counter. Hide regular Builder entry until plan is resolved.
- Cutover-date modal component: move trigger from Builder's Apply to plan workspace's final Apply. Component itself unchanged.
- Apply commit logic: new `commitPlan` store action that performs the end-date-old + create-new recurrence transaction in a single update.
- Banner component for roster drift in plan workspace.

## Out of scope for v1

- Multiple concurrent plans.
- Post-commit undo / rollback.
- Stale-plan hard-blocking.
- Mid-plan roster editing inside the workspace.
- Server-side persistence of plans (localStorage only; same model as existing transition).

## Open tuning knobs (flag for later)

- **Roster drift strictness:** banner vs. hard-block. Revisit after users hit it in practice.
- **Commit atomicity guarantees:** localStorage is single-threaded in the tab, but if we move plans to Supabase we'll want proper transaction semantics.
- **Plan expiry:** a plan sitting for weeks drifts further from reality. Consider auto-stale flag after N days.

## Success criteria

- User can click "Start Schedule Change", confirm some clients, close the browser tab, and reopen — the live calendar (and mobile) is identical to before they started, and they can resume the plan.
- User can discard a plan mid-way with zero effect on the live schedule.
- Commit is single-transaction: success → full new schedule; failure → nothing changed.
- Mobile sync shows no intermediate/partial state at any point before commit.

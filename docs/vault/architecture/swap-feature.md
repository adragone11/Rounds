---
platform: web
tags: [architecture, web, transition, swap, undo]
updated: 2026-04-22
---

# Swap Feature (Symmetric Trade + Undo) — Pip Web

> **Scope:** `pip-web` only (Vite + React + TypeScript). Swap + Undo swap are Transition-flow features; they do not exist in the mobile app.

When a client rejects their suggested day during Transition, the user picks a partner on a different day and **both clients swap**. Trade models the real-world ask: "Laura, Thursday doesn't work — would Friday work?" then "Joe, move off Friday to Thursday?"

## Mental Model
- **Asymmetric fill (rejected)**: partner fills rejected's opening; rejected stays stuck
- **Symmetric trade (current)**: both trade days; both get re-asked

## Core Files
- `src/optimizer.ts:696` — `SwapCandidate` + `computeSwapCandidates`
- `src/components/TransitionView.tsx` — `handleSwapCommit`, `revertMove`, `undoSwap`, swap picker UI
- `src/store.tsx` — `unconfirmClient` primitive

## `SwapCandidate` shape
```ts
type SwapCandidate = {
  clientId: string
  currentDay: number         // partner's day (rejected moves here)
  currentRotation: 0 | 1
  frequency: Client['frequency']
  nearestNeighborMin: number // drive-time from rejected to partner
  nearbyCount: number
  rotationShifts: boolean    // biweekly — rotation flips as part of trade
}
```

## Candidate Scoring
Filter rules (all must pass):
1. Different day from opening
2. Same frequency as rejected
3. Day must be a working day
4. Rejected's blocked days don't include partner's day
5. Partner's blocked days don't include opening day
6. Both clients have lat/lng

Selection: **best-per-day** — for each qualifying day, closest to rejected by drive-time. Result: max one per weekday. Sorted ascending by drive time.

## Commit Flow (`handleSwapCommit`)
Both sides mutate atomically:

```
1. If partner was Confirmed (locked):
   → call unconfirmClient(partner.clientId)
2. Stash preSwapSnapshot on BOTH cards (day, rotation, reason, message)
3. Mutate state.moves:
   - Rejected:  suggestedDay=partner.currentDay, targetRotation=partnerMove.targetRotation
   - Partner:   suggestedDay=rejected.suggestedDay, targetRotation=rejected.targetRotation
   - Both:      status='to-ask', locked=false, swapPartnerClientId=<other>, iteration++
4. Remove both from lockedClientIds
5. Close swap picker, collapse cards
```

`iteration++` drives the "updated" badge on the card. `swapPartnerClientId` prevents re-using the same partner twice in subsequent pickers.

## Swap Picker UI
Per-candidate row:
- Client name
- Full day name
- Cadence label (`Weekly` / `Wk 1,3` / `Wk 2,4`)
- Drive time or `Next door` if <2min
- **rot shift** badge — biweekly rotation changes
- **re-ask needed** badge — partner was confirmed
- **Trade** button — commits

Header: "Trade day with…" with a Skip close button.

## Revert to To Ask (single-card undo)
On every resolved card (confirmed OR cant-move):
- If Confirmed → `unconfirmClient(clientId)`
- Set status=`to-ask`, locked=false
- Remove from lockedClientIds

Use cases: accidental confirm tap, solo cant-move misclick.

## Undo Swap (pair unwind, added 2026-04-22)
Appears on either card in a swap pair (pending OR locked). Uses `preSwapSnapshot` stashed at commit:

```
1. If move.status === 'confirmed': unconfirmClient(move.clientId)
2. If partner.status === 'confirmed': unconfirmClient(partner.clientId)
3. For both cards:
   - Restore suggestedDay, targetRotation, reason, suggestedMessage from snapshot
   - Set status='to-ask', locked=false
   - Clear swapPartnerClientId + preSwapSnapshot
4. Remove both from lockedClientIds
```

Both cards → back to To Ask regardless of prior Confirmed state. Rationale: user's own texts track "did they already say yes"; re-anchoring to Confirmed requires more state we don't want to manage.

## Persistence interactions
`preSwapSnapshot` persists in `pip-transition-state-<applyId>` alongside the move itself. A fresh Apply blows away the snapshot (new applyId). Undo Swap only works within a single apply's lifetime.

## Invariants
- Trade only between clients with same frequency
- Partner must not be blocked on opening day; rejected must not be blocked on partner's day
- Biweekly rotation can flip (`rotationShifts=true`), frequency preserved
- Past placements never mutated

## Known Limitations (deferred)
- Only one candidate per day (max 5-6 options)
- Scoring weights only the rejected→partner side, not partner→opening-cluster fit
- No chain undo (3-way swaps not supported)

## See Also
- [[transition-flow]] — commit model, persistence
- [[schedule-builder]] — upstream plan

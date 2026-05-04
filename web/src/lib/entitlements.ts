// Entitlement checks for paid features. Single source of truth lives on
// `profiles.is_plus` (mobile-side, written by RevenueCat). Web reads it via
// the Profile context and gates UI through these helpers.
//
// Tier structure — FINAL, LOCKED 2026-04-28. Do not change without explicit
// user direction. The Pip+ list is exactly four features:
//   1. Schedule Builder
//   2. Smart Placement
//   3. Custom Templates
//   4. Reports
//
// Everything else is free — including multi-device sync, photos, time
// tracking, notes, checklist, recurrence, bulk import.
//
// See memory/project_pip_tier_structure.md for the full split + rationale.

import { useProfile } from './profile'

/** Feature keys recognized by <PipPlusGate>. The four-feature Pip+ list is
 *  final — adding to this type means changing the locked tier structure. */
export type PipPlusFeature =
  | 'schedule-builder'
  | 'smart-placement'
  | 'custom-templates'
  | 'reports'

/** Returns true when the signed-in user has an active Pip+ entitlement.
 *  False during profile load — the Paywall renders the locked state by
 *  default, so a flicker into the unlocked state can't happen. */
export function useCanUsePipPlus(): boolean {
  const { profile } = useProfile()
  return profile.isPlus
}

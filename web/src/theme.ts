/**
 * Pip visual theme — central source of truth for colors used across the app.
 *
 * Keep these in sync with the mobile app's palette (mobile `clusterUtils.ts`).
 * When we add per-user color customization, swap the hardcoded arrays here for
 * values loaded from the store — every consumer already pulls from this module.
 */

/** Day-of-week background colors: Sun..Sat. */
export const DAY_COLORS: string[] = [
  '#F97316', // Sun — orange
  '#3B82F6', // Mon — blue
  '#EF4444', // Tue — red
  '#10B981', // Wed — green
  '#8B5CF6', // Thu — purple
  '#EC4899', // Fri — pink
  '#06B6D4', // Sat — cyan
]

/**
 * Curated color palette users can pick from when customizing day colors.
 * Keep this list short — more than ~12 swatches becomes a paint store, not a
 * choice. Order is roughly spectrum order (warm → cool → neutral).
 */
export const COLOR_PALETTE: readonly { name: string; hex: string }[] = [
  { name: 'Blue',   hex: '#3B82F6' },
  { name: 'Red',    hex: '#EF4444' },
  { name: 'Orange', hex: '#F97316' },
  { name: 'Yellow', hex: '#EAB308' },
  { name: 'Green',  hex: '#10B981' },
  { name: 'Teal',   hex: '#14B8A6' },
  { name: 'Cyan',   hex: '#06B6D4' },
  { name: 'Purple', hex: '#8B5CF6' },
  { name: 'Pink',   hex: '#EC4899' },
  { name: 'Brown',  hex: '#92400E' },
]

/** Color used when a client has no placement / no recurrence anchor. */
export const UNPLACED_COLOR = '#9CA3AF'

/** Mobile's default avatar color (blue). Used when a client has no avatar_color set. */
export const DEFAULT_AVATAR_COLOR = '#3B82F6'

/** Red used for "blocked" signals (blocked days, hard-constraint violations). */
export const BLOCKED_COLOR = '#DC2626'

/** Driving-route polyline color on the map. Fixed (not day-of-week) so the
 *  line stays distinct from pins and legible across different map tiles. */
export const ROUTE_COLOR = '#3B82F6'

/** Rank colors for smart-placement suggestions: 1=gold, 2=silver, 3=bronze. */
export const RANK_COLORS: Record<number, string> = {
  1: '#F59E0B',
  2: '#64748B',
  3: '#B45309',
}

export const DAY_ABBREV: string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const DAY_NAMES: string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

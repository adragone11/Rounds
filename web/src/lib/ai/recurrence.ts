/**
 * Recurrence Projection — the math that makes the legal-moves generator
 * safe across multi-week horizons.
 *
 * For every (client, frequency, rotation) tuple, this returns the set of
 * weeks in [0, horizonWeeks) that the client appears in. Capacity checks
 * during legal-move generation enumerate these and verify max-jobs-per-day
 * holds for EVERY projected week.
 *
 * This is the source of truth for "does the schedule still work after this
 * move?" — keep it in one place so weekly/biweekly/monthly/custom math
 * doesn't drift between callers.
 */

import type { Frequency } from '../../types'

/**
 * Which weeks (0-indexed within horizon) a client appears in, given their
 * frequency and biweekly rotation.
 *
 * Conventions match the existing engine (lib/scheduleBuilder.ts grid build):
 *   - weekly       → every week
 *   - biweekly r=0 → weeks 0, 2, 4, …  (rotation A)
 *   - biweekly r=1 → weeks 1, 3, 5, …  (rotation B)
 *   - monthly      → every 4 weeks (web convention; mobile uses calendar
 *                    addMonths, tracked separately — see memory)
 *   - custom (N)   → every N weeks
 *   - one-time     → empty (excluded from move enumeration upstream)
 */
export function computeActiveWeeks(
  frequency: Frequency,
  rotation: 0 | 1,
  horizonWeeks: number,
  intervalWeeks?: number,
): number[] {
  if (horizonWeeks <= 0) return []
  const out: number[] = []
  if (frequency === 'weekly') {
    for (let w = 0; w < horizonWeeks; w++) out.push(w)
    return out
  }
  if (frequency === 'biweekly') {
    for (let w = rotation === 0 ? 0 : 1; w < horizonWeeks; w += 2) out.push(w)
    return out
  }
  if (frequency === 'monthly') {
    for (let w = 0; w < horizonWeeks; w += 4) out.push(w)
    return out
  }
  if (frequency === 'custom') {
    const step = Math.max(1, intervalWeeks ?? 4)
    for (let w = 0; w < horizonWeeks; w += step) out.push(w)
    return out
  }
  // one-time: no recurring projection — never appears in legal moves
  return []
}

/**
 * Determine the minimum horizon needed to express every recurrence pattern
 * present in a client set. Custom intervals can exceed 4 weeks.
 *
 * Returns max(4, longest custom intervalWeeks) so a 6-week custom client
 * gets at least one full cycle of capacity verification.
 */
export function requiredHorizonWeeks(
  intervals: Iterable<number | undefined>,
  defaultMin = 4,
): number {
  let max = defaultMin
  for (const i of intervals) {
    if (i && i > max) max = i
  }
  return max
}

/**
 * Determine if a frequency is movable by the AI optimizer.
 *
 * One-time jobs are excluded from swaps and reassigns — they're a single
 * occurrence, not a recurring pattern, and the LLM has nothing useful to
 * say about them. Move-via-engine still works for these; the AI just
 * doesn't get involved.
 */
export function isMovableByAI(frequency: Frequency): boolean {
  return frequency !== 'one-time'
}

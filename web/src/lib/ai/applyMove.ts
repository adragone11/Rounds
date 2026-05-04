/**
 * Apply a LegalMove to a PerfectScheduleResult and recompute derived data.
 *
 * Surgical edit: only the days touched by the move get their routes, grid
 * cells, and drive totals rebuilt. Everything else stays exactly as the
 * engine produced it.
 *
 * Safe to call repeatedly — each call returns a NEW PerfectScheduleResult,
 * the input is not mutated.
 */

import type { GridCell } from '../../types'
import type { PerfectScheduleResult } from '../scheduleBuilder'
import { solveRouteFromDepot, frequencyWeight } from '../../optimizer'
import type { LegalMove } from './types'
import { computeActiveWeeks } from './recurrence'

export function applyLegalMove(
  schedule: PerfectScheduleResult,
  move: LegalMove,
): PerfectScheduleResult {
  const next = cloneSchedule(schedule)

  if (move.type === 'reassign') {
    next.assignments.set(move.clientId, move.toDay)
    if (next._context.clientFrequencies.get(move.clientId) === 'biweekly') {
      next.rotations.set(move.clientId, move.toRotation)
    }
    recomputeDay(next, move.fromDay)
    recomputeDay(next, move.toDay)
  } else {
    next.assignments.set(move.clientAId, move.toDayA)
    next.assignments.set(move.clientBId, move.toDayB)
    if (next._context.clientFrequencies.get(move.clientAId) === 'biweekly') {
      next.rotations.set(move.clientAId, move.toRotationA)
    }
    if (next._context.clientFrequencies.get(move.clientBId) === 'biweekly') {
      next.rotations.set(move.clientBId, move.toRotationB)
    }
    const affected = new Set<number>([move.fromDayA, move.fromDayB, move.toDayA, move.toDayB])
    for (const day of affected) recomputeDay(next, day)
  }

  next.totalDriveMinutes = computeTotalDriveMinutes(next)
  return next
}

/**
 * Apply a sequence of legal moves, dropping any move that conflicts with a
 * previously-applied one. A "conflict" is when a later move references a
 * client whose position has already changed in this pass — the LLM reasoned
 * about the original schedule, so chaining its picks blindly would produce
 * inconsistent state.
 *
 * Returns the new schedule and the list of move IDs that were actually
 * applied (subset of the input order).
 */
export function applyMoveSequence(
  schedule: PerfectScheduleResult,
  moves: LegalMove[],
): { schedule: PerfectScheduleResult; appliedIds: string[]; skipped: { id: string; reason: 'conflict' }[] } {
  const touchedClients = new Set<string>()
  const appliedIds: string[] = []
  const skipped: { id: string; reason: 'conflict' }[] = []
  let current = schedule

  for (const move of moves) {
    const movedClientIds = move.type === 'reassign'
      ? [move.clientId]
      : [move.clientAId, move.clientBId]

    if (movedClientIds.some(id => touchedClients.has(id))) {
      skipped.push({ id: move.id, reason: 'conflict' })
      continue
    }

    current = applyLegalMove(current, move)
    appliedIds.push(move.id)
    movedClientIds.forEach(id => touchedClients.add(id))
  }

  return { schedule: current, appliedIds, skipped }
}

// ────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────

function cloneSchedule(s: PerfectScheduleResult): PerfectScheduleResult {
  return {
    assignments: new Map(s.assignments),
    rotations: new Map(s.rotations),
    routesByDay: new Map(s.routesByDay),
    grid: new Map(s.grid),
    totalDriveMinutes: s.totalDriveMinutes,
    currentDriveMinutes: s.currentDriveMinutes,
    changes: s.changes,
    benched: [...s.benched],
    legTimes: new Map(s.legTimes),
    cellDriveMinutes: new Map(s.cellDriveMinutes),
    // _context is read-only metadata — share the reference
    _context: s._context,
  }
}

/**
 * Rebuild routesByDay, grid cells, legTimes, and cellDriveMinutes for a
 * single day from the current assignments + rotations. Cheap because the
 * matrix is already cached in _context.
 */
function recomputeDay(s: PerfectScheduleResult, day: number): void {
  const ctx = s._context
  if (day < 0) return

  const matrixIdx = (clientId: string): number => {
    const i = ctx.clientIds.indexOf(clientId)
    return i === -1 ? -1 : i + 1
  }

  // Members of this day (regardless of rotation — biweekly is partitioned in the grid)
  const members: string[] = []
  for (const [clientId, d] of s.assignments) {
    if (d === day) members.push(clientId)
  }

  // Day-level TSP route (used for routesByDay + drive totals)
  const dayMatrixIdxs = members.map(id => matrixIdx(id)).filter(i => i >= 0)
  if (dayMatrixIdxs.length === 0) {
    s.routesByDay.delete(day)
  } else {
    const route = solveRouteFromDepot(0, dayMatrixIdxs, ctx.matrixMinutes)
    const orderedClientIds = route.order
      .filter(i => i !== 0)
      .map(i => ctx.clientIds[i - 1])
    s.routesByDay.set(day, orderedClientIds)
  }

  // ── Rebuild grid cells for this day across all weeks ──
  // Strategy: clear every "w-day" cell, then re-add each member based on
  // their frequency × rotation × horizon.
  const gridKeysToRebuild: string[] = []
  for (const k of s.grid.keys()) {
    const [, dStr] = k.split('-')
    if (Number(dStr) === day) gridKeysToRebuild.push(k)
  }
  for (const k of gridKeysToRebuild) s.grid.delete(k)
  for (const k of gridKeysToRebuild) {
    s.legTimes.delete(k)
    s.cellDriveMinutes.delete(k)
  }

  // Determine horizon (max week index across the entire grid)
  let horizonWeeks = 4
  for (const k of s.grid.keys()) {
    const [wStr] = k.split('-')
    const w = Number(wStr)
    if (w + 1 > horizonWeeks) horizonWeeks = w + 1
  }
  // Bump for any custom intervals
  for (const interval of ctx.clientIntervalWeeks.values()) {
    if (interval && interval > horizonWeeks) horizonWeeks = interval
  }

  for (const clientId of members) {
    const freq = ctx.clientFrequencies.get(clientId)
    if (!freq) continue
    const rotation = ((s.rotations.get(clientId) ?? 0) as 0 | 1)
    const interval = ctx.clientIntervalWeeks.get(clientId)
    const cell: GridCell = {
      clientId,
      clientName: ctx.clientNames.get(clientId) ?? clientId,
      routeOrder: 0,
      recurrence: freq as GridCell['recurrence'],
      rotation,
    }

    let weeks: number[]
    if (freq === 'one-time') {
      // One-time: place once on week 0 of this day
      weeks = [0]
    } else {
      weeks = computeActiveWeeks(freq, rotation, horizonWeeks, interval)
    }
    for (const w of weeks) {
      const key = `${w}-${day}`
      const arr = s.grid.get(key) ?? []
      arr.push(cell)
      s.grid.set(key, arr)
    }
  }

  // ── Rebuild legTimes + cellDriveMinutes for this day's cells ──
  for (const k of s.grid.keys()) {
    const [, dStr] = k.split('-')
    if (Number(dStr) !== day) continue
    const cells = s.grid.get(k)!
    if (cells.length === 0) continue
    const idxs = cells.map(c => matrixIdx(c.clientId)).filter(i => i >= 0)
    if (idxs.length === 0) continue
    const route = solveRouteFromDepot(0, idxs, ctx.matrixMinutes)
    const legs: number[] = []
    for (let i = 0; i < route.order.length - 1; i++) {
      legs.push(Math.round(ctx.matrixMinutes[route.order[i]][route.order[i + 1]]))
    }
    s.legTimes.set(k, legs)
    s.cellDriveMinutes.set(k, Math.round(route.cost))

    // Reorder cells by route position so render order matches drive order
    const orderById = new Map<string, number>()
    route.order.slice(1).forEach((mIdx, pos) => {
      orderById.set(ctx.clientIds[mIdx - 1], pos)
    })
    cells.sort((a, b) => (orderById.get(a.clientId) ?? 0) - (orderById.get(b.clientId) ?? 0))
  }
}

/**
 * Total drive minutes per week (recurrence-weighted average) — same metric
 * the engine emits, so AI-refined and engine-only schedules are directly
 * comparable.
 */
function computeTotalDriveMinutes(s: PerfectScheduleResult): number {
  const ctx = s._context
  let total = 0
  for (const [day, clientIds] of s.routesByDay) {
    if (day < 0 || clientIds.length === 0) continue
    const idxs = clientIds.map(id => {
      const i = ctx.clientIds.indexOf(id)
      return i === -1 ? -1 : i + 1
    }).filter(i => i >= 0)
    if (idxs.length === 0) continue
    const route = solveRouteFromDepot(0, idxs, ctx.matrixMinutes)
    let weightSum = 0
    for (const id of clientIds) {
      const f = ctx.clientFrequencies.get(id)
      if (!f) continue
      weightSum += frequencyWeight(f, ctx.clientIntervalWeeks.get(id))
    }
    const avgWeight = weightSum / clientIds.length
    total += route.cost * avgWeight
  }
  return Math.round(total)
}

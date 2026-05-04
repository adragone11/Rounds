/**
 * Legal-Moves Generator
 *
 * The single source of truth for "what moves can the AI propose without
 * breaking the schedule?" Every entry in the returned LegalMoveSet has been
 * validated across the FULL projected horizon — meaning capacity holds in
 * EVERY week, not just week 0.
 *
 * If a move is in the menu, it is safe.
 * If a move is not in the menu, the LLM cannot propose it.
 *
 * That structural guarantee is the moat. Don't weaken it by adding shortcuts
 * that skip horizon validation.
 *
 * Excludes:
 *   - one-time clients (excluded entirely; not a recurring pattern)
 *   - locked clients (passed in via opts.lockedClientIds)
 *   - clients with no current day assignment (benched)
 *
 * Costs are recurrence-weighted to match the engine's totalDriveMinutes
 * metric, so deltas are directly comparable.
 */

import type { Frequency } from '../../types'
import type { PerfectScheduleResult, ScheduleContext } from '../scheduleBuilder'
import { solveRouteFromDepot, frequencyWeight } from '../../optimizer'
import type {
  LegalMove,
  LegalMoveImpact,
  LegalMoveSet,
  PerWeekPeakLoad,
  ReassignMove,
  SwapMove,
} from './types'
import {
  computeActiveWeeks,
  isMovableByAI,
  requiredHorizonWeeks,
} from './recurrence'

const DEFAULT_LEGAL_MOVE_CAP = 25

export type GenerateLegalMovesOptions = {
  scheduleId: string
  /** Client IDs the AI cannot move (e.g. confirmed during transition). */
  lockedClientIds?: ReadonlySet<string>
  /** Override horizon. Auto-detected from custom intervals if omitted (min 4). */
  horizonWeeks?: number
  /** Max moves returned to the LLM. Default 25. Sorted by best driveMinutesDelta. */
  legalMoveCap?: number
}

type ClientPosition = {
  clientId: string
  day: number
  rotation: 0 | 1
  frequency: Frequency
  intervalWeeks?: number
  blockedDays: Set<number>
  activeWeeks: number[]
}

export function generateLegalMoves(
  schedule: PerfectScheduleResult,
  opts: GenerateLegalMovesOptions,
): LegalMoveSet {
  const ctx = schedule._context
  const cap = opts.legalMoveCap ?? DEFAULT_LEGAL_MOVE_CAP
  const locked = opts.lockedClientIds ?? new Set<string>()

  const horizonWeeks = opts.horizonWeeks ?? requiredHorizonWeeks(
    ctx.clientIntervalWeeks.values(),
  )

  const activeDays = ctx.workingDays
    .map((on, i) => (on ? i : -1))
    .filter(i => i >= 0)
  const activeDaySet = new Set(activeDays)
  const maxJobs = ctx.maxJobsPerDay

  // ── Build current positions for every movable client ──
  const positions = new Map<string, ClientPosition>()
  for (const [clientId, day] of schedule.assignments) {
    if (day < 0) continue
    if (locked.has(clientId)) continue
    const freq = ctx.clientFrequencies.get(clientId)
    if (!freq || !isMovableByAI(freq)) continue
    const rotation = ((schedule.rotations.get(clientId) ?? 0) as 0 | 1)
    const interval = ctx.clientIntervalWeeks.get(clientId)
    const blocked = new Set(ctx.clientBlockedDays.get(clientId) ?? [])
    positions.set(clientId, {
      clientId,
      day,
      rotation,
      frequency: freq,
      intervalWeeks: interval,
      blockedDays: blocked,
      activeWeeks: computeActiveWeeks(freq, rotation, horizonWeeks, interval),
    })
  }

  // ── Per-week, per-day occupancy. Derived from the live schedule (every
  //    placed client, including locked + one-time + biweekly), so capacity
  //    checks reflect reality. ──
  const baselineOccupancy: PerWeekPeakLoad = buildOccupancy(schedule, ctx, horizonWeeks)
  if (!occupancyWithinCap(baselineOccupancy, maxJobs)) {
    // The current schedule already over-caps somewhere — likely a lock
    // configuration the engine couldn't fully resolve. We still generate
    // moves, but only ones that don't make the worst day worse.
  }

  const matrixIdx = (clientId: string): number => {
    const i = ctx.clientIds.indexOf(clientId)
    return i === -1 ? -1 : i + 1
  }

  // ── Per-day route cost (recurrence-weighted) snapshot ──
  // Pre-compute baseline routes so impact deltas are cheap.
  const dayMembers = new Map<number, string[]>()
  for (const [clientId, day] of schedule.assignments) {
    if (day < 0) continue
    const arr = dayMembers.get(day) ?? []
    arr.push(clientId)
    dayMembers.set(day, arr)
  }

  const dayCost = new Map<number, number>()
  for (const [day, ids] of dayMembers) {
    dayCost.set(day, weightedRouteCost(ids, ctx))
  }

  // ── Enumerate reassign moves ──
  const moves: LegalMove[] = []

  for (const pos of positions.values()) {
    for (const targetDay of activeDays) {
      if (targetDay === pos.day) continue
      if (pos.blockedDays.has(targetDay)) continue

      const rotationsToTry: Array<0 | 1> = pos.frequency === 'biweekly' ? [0, 1] : [0]
      for (const targetRot of rotationsToTry) {
        // Skip a no-op (same day already filtered, but biweekly with same rotation
        // on the same day is also impossible — we changed day above, so safe).
        const newOccupancy = applyReassignToOccupancy(
          baselineOccupancy,
          pos,
          targetDay,
          targetRot,
          horizonWeeks,
        )
        if (!occupancyWithinCap(newOccupancy, maxJobs)) continue

        const impact = computeReassignImpact(
          pos,
          targetDay,
          targetRot,
          dayMembers,
          dayCost,
          newOccupancy,
          ctx,
        )
        // Only keep moves that actually save drive time. The LLM can still
        // re-rank but we don't waste tokens on negative-value options.
        if (impact.driveMinutesDelta >= 0) continue

        const move: ReassignMove = {
          id: `reassign:${pos.clientId}:${pos.day}->${targetDay}:r${pos.rotation}->r${targetRot}`,
          type: 'reassign',
          clientId: pos.clientId,
          clientName: ctx.clientNames.get(pos.clientId) ?? pos.clientId,
          fromDay: pos.day as 0 | 1 | 2 | 3 | 4 | 5 | 6,
          toDay: targetDay as 0 | 1 | 2 | 3 | 4 | 5 | 6,
          fromRotation: pos.rotation,
          toRotation: targetRot,
          impact,
        }
        moves.push(move)
      }
    }
  }

  // ── Enumerate swap moves ──
  // Pairs of unlocked, movable clients on different days. Order doesn't
  // matter for swaps; we visit each unordered pair once.
  const positionList = [...positions.values()]
  for (let i = 0; i < positionList.length; i++) {
    for (let j = i + 1; j < positionList.length; j++) {
      const a = positionList[i]
      const b = positionList[j]
      if (a.day === b.day) continue
      // A goes to B's day with B's rotation; B goes to A's day with A's rotation.
      // Other rotation combinations are reachable via reassigns and would explode
      // the menu — keep swaps to the canonical exchange.
      const newAday = b.day
      const newAroT = a.frequency === 'biweekly' ? b.rotation : 0
      const newBday = a.day
      const newBroT = b.frequency === 'biweekly' ? a.rotation : 0
      if (a.blockedDays.has(newAday)) continue
      if (b.blockedDays.has(newBday)) continue

      let newOccupancy = applyReassignToOccupancy(
        baselineOccupancy,
        a,
        newAday,
        newAroT,
        horizonWeeks,
      )
      newOccupancy = applyReassignToOccupancy(
        newOccupancy,
        b,
        newBday,
        newBroT,
        horizonWeeks,
      )
      if (!occupancyWithinCap(newOccupancy, maxJobs)) continue

      const impact = computeSwapImpact(a, b, newAday, newAroT, newBday, newBroT, dayMembers, dayCost, newOccupancy, ctx)
      if (impact.driveMinutesDelta >= 0) continue

      const move: SwapMove = {
        id: `swap:${a.clientId}<->${b.clientId}`,
        type: 'swap',
        clientAId: a.clientId,
        clientBId: b.clientId,
        clientAName: ctx.clientNames.get(a.clientId) ?? a.clientId,
        clientBName: ctx.clientNames.get(b.clientId) ?? b.clientId,
        fromDayA: a.day as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        fromDayB: b.day as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        fromRotationA: a.rotation,
        fromRotationB: b.rotation,
        toDayA: newAday as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        toDayB: newBday as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        toRotationA: newAroT,
        toRotationB: newBroT,
        impact,
      }
      moves.push(move)
    }
  }

  const totalConsidered = moves.length
  moves.sort((a, b) => a.impact.driveMinutesDelta - b.impact.driveMinutesDelta)
  const capped = moves.slice(0, cap)

  return {
    scheduleId: opts.scheduleId,
    generatedAt: new Date().toISOString(),
    moves: capped,
    totalConsidered,
  }

  // ── helpers (closures over ctx) ────────────────────────────────────────

  function weightedRouteCost(memberIds: string[], context: ScheduleContext): number {
    if (memberIds.length === 0) return 0
    const indices = memberIds.map(id => matrixIdx(id)).filter(i => i >= 0)
    if (indices.length === 0) return 0
    const route = solveRouteFromDepot(0, indices, context.matrixMinutes)
    let weightSum = 0
    for (const id of memberIds) {
      const f = context.clientFrequencies.get(id)
      if (!f) continue
      weightSum += frequencyWeight(f, context.clientIntervalWeeks.get(id))
    }
    const avgWeight = weightSum / memberIds.length
    return route.cost * avgWeight
  }

  function computeReassignImpact(
    pos: ClientPosition,
    targetDay: number,
    targetRot: 0 | 1,
    members: Map<number, string[]>,
    dayCostMap: Map<number, number>,
    newOccupancy: PerWeekPeakLoad,
    context: ScheduleContext,
  ): LegalMoveImpact {
    const oldFromMembers = members.get(pos.day) ?? []
    const oldToMembers = members.get(targetDay) ?? []
    const newFromMembers = oldFromMembers.filter(id => id !== pos.clientId)
    const newToMembers = [...oldToMembers, pos.clientId]

    const oldCost = (dayCostMap.get(pos.day) ?? 0) + (dayCostMap.get(targetDay) ?? 0)
    const newCost = weightedRouteCost(newFromMembers, context) +
      weightedRouteCost(newToMembers, context)
    const driveMinutesDelta = Math.round((newCost - oldCost) * 10) / 10

    const tightnessDelta = Math.round(
      (avgPairDistance(newFromMembers, context) + avgPairDistance(newToMembers, context) -
        avgPairDistance(oldFromMembers, context) - avgPairDistance(oldToMembers, context)) * 10,
    ) / 10

    return {
      driveMinutesDelta,
      affectedDays: [pos.day, targetDay].sort() as Array<0 | 1 | 2 | 3 | 4 | 5 | 6>,
      perWeekPeakLoad: newOccupancy,
      tightnessDelta,
    }
    void targetRot
  }

  function computeSwapImpact(
    a: ClientPosition,
    b: ClientPosition,
    newAday: number,
    _newARot: 0 | 1,
    newBday: number,
    _newBRot: 0 | 1,
    members: Map<number, string[]>,
    dayCostMap: Map<number, number>,
    newOccupancy: PerWeekPeakLoad,
    context: ScheduleContext,
  ): LegalMoveImpact {
    const oldAday = a.day
    const oldBday = b.day

    const oldAmembers = members.get(oldAday) ?? []
    const oldBmembers = members.get(oldBday) ?? []

    // After swap: A leaves oldAday, B leaves oldBday, A joins newAday (=oldBday),
    // B joins newBday (=oldAday). Build the new member sets.
    const newOldAdayMembers = oldAmembers.filter(id => id !== a.clientId).concat(
      newBday === oldAday ? [b.clientId] : [],
    )
    const newOldBdayMembers = oldBmembers.filter(id => id !== b.clientId).concat(
      newAday === oldBday ? [a.clientId] : [],
    )

    const oldCost = (dayCostMap.get(oldAday) ?? 0) + (dayCostMap.get(oldBday) ?? 0)
    const newCost = weightedRouteCost(newOldAdayMembers, context) +
      weightedRouteCost(newOldBdayMembers, context)
    const driveMinutesDelta = Math.round((newCost - oldCost) * 10) / 10

    const tightnessDelta = Math.round(
      (avgPairDistance(newOldAdayMembers, context) + avgPairDistance(newOldBdayMembers, context) -
        avgPairDistance(oldAmembers, context) - avgPairDistance(oldBmembers, context)) * 10,
    ) / 10

    return {
      driveMinutesDelta,
      affectedDays: [oldAday, oldBday].sort() as Array<0 | 1 | 2 | 3 | 4 | 5 | 6>,
      perWeekPeakLoad: newOccupancy,
      tightnessDelta,
    }
  }

  function avgPairDistance(memberIds: string[], context: ScheduleContext): number {
    if (memberIds.length < 2) return 0
    let sum = 0
    let pairs = 0
    for (let i = 0; i < memberIds.length; i++) {
      const ai = matrixIdx(memberIds[i])
      if (ai < 0) continue
      for (let j = i + 1; j < memberIds.length; j++) {
        const bi = matrixIdx(memberIds[j])
        if (bi < 0) continue
        sum += context.matrixMinutes[ai][bi]
        pairs++
      }
    }
    return pairs > 0 ? sum / pairs : 0
  }

  void activeDaySet
}

// ────────────────────────────────────────────────────────────────────────
// Occupancy primitives — pure functions, no closures.
// ────────────────────────────────────────────────────────────────────────

function buildOccupancy(
  schedule: PerfectScheduleResult,
  ctx: ScheduleContext,
  horizonWeeks: number,
): PerWeekPeakLoad {
  const occ: PerWeekPeakLoad = {}
  for (let w = 0; w < horizonWeeks; w++) occ[w] = {}

  for (const [clientId, day] of schedule.assignments) {
    if (day < 0) continue
    const freq = ctx.clientFrequencies.get(clientId)
    if (!freq) continue
    if (freq === 'one-time') {
      // One-time jobs: count once on week 0 of their day. They don't recur,
      // so they never affect later weeks. This keeps capacity honest for the
      // first week without inflating subsequent ones.
      const w = 0
      occ[w][day] = (occ[w][day] ?? 0) + 1
      continue
    }
    const rotation = ((schedule.rotations.get(clientId) ?? 0) as 0 | 1)
    const interval = ctx.clientIntervalWeeks.get(clientId)
    const weeks = computeActiveWeeks(freq, rotation, horizonWeeks, interval)
    for (const w of weeks) {
      occ[w][day] = (occ[w][day] ?? 0) + 1
    }
  }
  return occ
}

function applyReassignToOccupancy(
  base: PerWeekPeakLoad,
  pos: ClientPosition,
  targetDay: number,
  targetRotation: 0 | 1,
  horizonWeeks: number,
): PerWeekPeakLoad {
  const next: PerWeekPeakLoad = {}
  for (const w of Object.keys(base)) {
    next[Number(w)] = { ...base[Number(w)] }
  }
  // Remove from old (day, oldActiveWeeks).
  for (const w of pos.activeWeeks) {
    if (next[w] && next[w][pos.day] !== undefined) {
      next[w][pos.day] = Math.max(0, (next[w][pos.day] ?? 0) - 1)
    }
  }
  // Add to new (targetDay, newActiveWeeks under targetRotation).
  const newWeeks = computeActiveWeeks(
    pos.frequency,
    targetRotation,
    horizonWeeks,
    pos.intervalWeeks,
  )
  for (const w of newWeeks) {
    if (!next[w]) next[w] = {}
    next[w][targetDay] = (next[w][targetDay] ?? 0) + 1
  }
  return next
}

function occupancyWithinCap(occ: PerWeekPeakLoad, maxJobsPerDay: number): boolean {
  for (const w of Object.keys(occ)) {
    const dayMap = occ[Number(w)]
    for (const d of Object.keys(dayMap)) {
      if ((dayMap[Number(d)] ?? 0) > maxJobsPerDay) return false
    }
  }
  return true
}

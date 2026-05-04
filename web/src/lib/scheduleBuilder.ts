/**
 * Schedule Builder — Auto-Sort Engine
 *
 * Generates the "perfect" 4-week schedule from a client list. Pipeline:
 *
 *   1. Fetch ORS drive-time matrix (home + every client)
 *   2. Score current schedule (recurrence-weighted)
 *   3. Pre-place locked clients
 *   4. Cluster unlocked clients (lock-anchored seeds + greedy most-isolated seeds)
 *   5. Assign clusters → working days (weekly-heavy first, fills Mon → Fri)
 *   6. Split biweekly clients into A/B rotations (max-pack primary; k-medoids on overflow)
 *   7. Rebalance any day still over cap (move farthest-from-center to nearest day with room)
 *   8. Consolidation pass: pull from later days to fill earlier days (slack at end of week)
 *   9. Re-pack biweekly rotations on days that received pulled clients
 *  10. Order each day's stops via TSP (solveRouteFromDepot)
 *  11. Score new schedule, build N-week grid, return result
 *
 * The cluster step is local-greedy, not globally optimal — keeps it fast and
 * predictable. Locks always override geometry.
 */

import type { Client, GridCell } from '../types'
import { getORSMatrixSeconds } from './routing'
import {
  kMedoids,
  solveRouteFromDepot,
  clusterTightness,
  frequencyWeight,
  type ClientWithDay,
  type OptimizeConfig,
} from '../optimizer'

/**
 * Internal context preserved for downstream AI diagnostics + legal-moves
 * generation. Underscore-prefixed because regular UI consumers should treat
 * the schedule as opaque — only the AI layer reads this.
 */
export type ScheduleContext = {
  /** Index-aligned with matrixMinutes: clientIds[i] sits at matrix index i+1 (home is index 0). */
  clientIds: string[]
  /** Drive-time matrix in minutes. Index 0 is home; clients start at 1. */
  matrixMinutes: number[][]
  homeCoords: { lat: number; lng: number }
  /** Active days bitmap from config (true = working day). */
  workingDays: boolean[]
  maxJobsPerDay: number
  /** Optional client-id → frequency override (used by Schedule Builder previews). */
  recurrenceMap?: Map<string, string>
  /** Optional client-id → minutes override per visit. */
  durationMap?: Map<string, number>
  /** Per-client lat/lng (cached so AI doesn't have to walk the client list again). */
  clientCoords: Map<string, { lat: number; lng: number }>
  /** Per-client name (for human-readable LLM payloads). */
  clientNames: Map<string, string>
  /** Per-client blockedDays (for legal-move enumeration). */
  clientBlockedDays: Map<string, number[]>
  /** Per-client frequency snapshot (effective frequency = recurrenceMap[id] ?? client.frequency). */
  clientFrequencies: Map<string, Client['frequency']>
  /** Per-client intervalWeeks (only meaningful for custom frequency). */
  clientIntervalWeeks: Map<string, number | undefined>
}

export interface PerfectScheduleResult {
  /** clientId → assigned day of week */
  assignments: Map<string, number>
  /** clientId → biweekly rotation (0=even weeks, 1=odd weeks). Only set for biweekly clients. */
  rotations: Map<string, number>
  /** day → ordered client IDs (route order) */
  routesByDay: Map<number, string[]>
  /** 4-week grid: key = "week-day" (e.g. "0-1" = week 0, Monday), value = clients in that cell */
  grid: Map<string, GridCell[]>
  /** total drive minutes in the perfect schedule */
  totalDriveMinutes: number
  /** total drive minutes in the current schedule */
  currentDriveMinutes: number
  /** clients that would change days */
  changes: Array<{ clientId: string; clientName: string; fromDay: number; toDay: number }>
  /** client IDs that couldn't fit within constraints — go to bench */
  benched: string[]
  /** Per-cell leg times in minutes. Key = "week-day". Array = [home→c1, c1→c2, …, c(N-1)→cN]. */
  legTimes: Map<string, number[]>
  /** Per-cell total drive minutes (home → all clients → last, no return home). */
  cellDriveMinutes: Map<string, number>
  /** Internal context for downstream AI passes. Don't mutate. */
  _context: ScheduleContext
}

/**
 * Empty ScheduleContext — for callers that construct a PerfectScheduleResult
 * literal before the engine has run (e.g. session restore stubs, empty-state
 * scaffolding). The AI layer is a no-op on schedules with empty context, so
 * this is safe.
 */
export function emptyScheduleContext(): ScheduleContext {
  return {
    clientIds: [],
    matrixMinutes: [],
    homeCoords: { lat: 0, lng: 0 },
    workingDays: [false, true, true, true, true, true, false],
    maxJobsPerDay: 0,
    clientCoords: new Map(),
    clientNames: new Map(),
    clientBlockedDays: new Map(),
    clientFrequencies: new Map(),
    clientIntervalWeeks: new Map(),
  }
}

interface InternalAssignment {
  clientIdx: number
  dayOfWeek: number
  routeOrder: number
  rotation: 0 | 1 // 0 = even weeks (A), 1 = odd weeks (B). Weekly/monthly default to 0.
}

/**
 * Build per-client day/rotation assignments from geographic clusters.
 *
 * 1. Pre-assign locked clients
 * 2. Greedy clusters (lock-anchored seeds first, then most-isolated seeds)
 * 3. Cluster → day priority sort (lock-anchored, weekly-heavy, peak-count, tightness)
 * 4. Biweekly A/B split per day (max-pack; k-medoids on overflow)
 * 5. Rebalance overflowing days
 * 6. Consolidate: pull from later days into earlier days that have headroom
 * 7. Re-pack biweekly rotations after consolidation moves
 */
function buildScheduleFromClusters(
  withCoords: ClientWithDay[],
  matrixSeconds: number[][],
  activeDays: number[],
  maxJobsPerDay: number,
  recurrenceMap?: Map<string, string>,
  lockedDays?: Map<number, { day: number; rotation: 0 | 1 }>,
  durationMap?: Map<string, number>,
  workingMinutes?: number,
): InternalAssignment[] {
  const assignments: InternalAssignment[] = []
  const getFreq = (c: ClientWithDay) => recurrenceMap?.get(c.client.id) ?? c.client.frequency
  const mIdx = (clientArrayIdx: number) => clientArrayIdx + 1

  // Build client-only distance matrix (minutes)
  const n = withCoords.length
  const clientMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = matrixSeconds[mIdx(i)][mIdx(j)] / 60
      clientMatrix[i][j] = d
      clientMatrix[j][i] = d
    }
  }

  // ── Pre-assign locked clients ──
  const lockedClientIndices = new Set<number>()
  if (lockedDays) {
    for (const [idx, locked] of lockedDays) {
      lockedClientIndices.add(idx)
      assignments.push({ clientIdx: idx, dayOfWeek: locked.day, routeOrder: 0, rotation: locked.rotation })
    }
  }

  // Collect blocked days per client
  const clientBlocked = new Map<number, Set<number>>()
  for (let i = 0; i < n; i++) {
    const blocked = withCoords[i].client.blockedDays
    if (blocked && blocked.length > 0) clientBlocked.set(i, new Set(blocked))
  }

  // All unlocked clients, regardless of frequency
  const unlocked: number[] = []
  for (let i = 0; i < n; i++) {
    if (lockedClientIndices.has(i)) continue
    unlocked.push(i)
  }

  if (unlocked.length === 0) return assignments

  // ── Frequency-aware greedy clustering ──
  //
  // 1. Pick most-isolated seed
  // 2. Add nearest clients one at a time, stopping when peak-week count
  //    (weekly + ceil(biweekly/2) + monthly + custom) would exceed maxJobsPerDay
  // 3. Lock cluster, repeat
  // 4. Assign tightest cluster → first active day (Mon)
  // 5. Split biweekly per day into rotation A/B using k-medoids(k=2)
  {
    const freqOf = (i: number) => getFreq(withCoords[i]) as Client['frequency']
    const peakCount = (cluster: number[]) => {
      let w = 0, b = 0, m = 0, c = 0
      for (const idx of cluster) {
        const f = freqOf(idx)
        if (f === 'weekly') w++
        else if (f === 'biweekly') b++
        else if (f === 'monthly') m++
        else c++
      }
      // Monthly clients spread across 4 weeks so at most ceil(m/4) land on
      // the same week. Treating them as weekly inflated peak by up to 4x and
      // caused biweekly clients to be incorrectly benched when monthly clients
      // were present on a day that had real capacity remaining.
      return w + Math.ceil(b / 2) + Math.ceil(m / 4) + c
    }
    const durationOf = (i: number): number => {
      const id = withCoords[i].client.id
      return durationMap?.get(id) ?? 60
    }
    const peakMinutes = (cluster: number[]): number => {
      let weekly = 0, biweekly = 0, monthly = 0, custom = 0
      for (const idx of cluster) {
        const d = durationOf(idx)
        const f = freqOf(idx)
        if (f === 'weekly') weekly += d
        else if (f === 'biweekly') biweekly += d
        else if (f === 'monthly') monthly += d
        else custom += d
      }
      return weekly + Math.ceil(biweekly / 2) + Math.ceil(monthly / 4) + custom
    }

    const unplaced = new Set(unlocked)
    const rawClusters: number[][] = []
    // rawClusters index → day forced by a lock anchored on this cluster.
    // Lock-anchored clusters skip the priority sort and go straight to the
    // lock's day. Non-lock clusters fall through to the existing first-empty
    // assignment logic.
    const lockClusterDay = new Map<number, number>()
    const debug = !!(globalThis as { __PIP_DEBUG__?: boolean }).__PIP_DEBUG__

    // ── Lock-anchored cluster seeds ──
    // Each unique locked day becomes a cluster seed. The locked client(s) on
    // that day are the seed; we then pull in nearest unplaced neighbors until
    // peak-count / peak-minutes hit the cap. This biases the geometry: the
    // engine fills the day with clients near the lock instead of treating
    // unlocked clients as if locks didn't exist.
    if (lockedDays && lockedDays.size > 0) {
      const locksByDay = new Map<number, number[]>()
      for (const [idx, locked] of lockedDays) {
        const arr = locksByDay.get(locked.day) ?? []
        arr.push(idx)
        locksByDay.set(locked.day, arr)
      }
      for (const [day, lockIdxs] of locksByDay) {
        const cluster = [...lockIdxs]
        const candidates = [...unplaced]
          .map(ci => {
            let nearest = Infinity
            for (const li of lockIdxs) {
              const d = clientMatrix[ci][li]
              if (d < nearest) nearest = d
            }
            return { ci, d: nearest }
          })
          .sort((a, b) => a.d - b.d)
        for (const { ci } of candidates) {
          const blocked = clientBlocked.get(ci)
          if (blocked && blocked.has(day)) continue
          if (peakCount([...cluster, ci]) > maxJobsPerDay) continue
          if (workingMinutes && peakMinutes([...cluster, ci]) > workingMinutes) continue
          cluster.push(ci)
          unplaced.delete(ci)
        }
        lockClusterDay.set(rawClusters.length, day)
        rawClusters.push(cluster)
        if (debug) {
          const lockNames = lockIdxs.map(i => withCoords[i].client.name).join(', ')
          const pulled = cluster.slice(lockIdxs.length)
            .map(i => `${withCoords[i].client.name} (${freqOf(i)})`)
            .join(', ') || '(none)'
          console.log(
            `[schedule] lock-anchored cluster on day ${day} — ` +
            `locks: [${lockNames}], pulled in: [${pulled}], ` +
            `peakCount=${peakCount(cluster)}/${maxJobsPerDay}`
          )
        }
      }
    }

    while (unplaced.size > 0) {
      // Seed: most isolated unplaced client
      let seed = -1
      let worstNearest = -Infinity
      for (const ci of unplaced) {
        let nearest = Infinity
        for (const oi of unplaced) {
          if (oi === ci) continue
          if (clientMatrix[ci][oi] < nearest) nearest = clientMatrix[ci][oi]
        }
        if (nearest > worstNearest) { worstNearest = nearest; seed = ci }
      }
      if (seed === -1) break

      const cluster = [seed]
      unplaced.delete(seed)

      const candidates = [...unplaced]
        .map(ci => ({ ci, d: clientMatrix[seed][ci] }))
        .sort((a, b) => a.d - b.d)

      for (const { ci } of candidates) {
        if (peakCount([...cluster, ci]) > maxJobsPerDay) continue
        if (workingMinutes && peakMinutes([...cluster, ci]) > workingMinutes) continue
        cluster.push(ci)
        unplaced.delete(ci)
      }

      if (debug) {
        const seedName = withCoords[seed].client.name
        const members = cluster.slice(1).map(i => withCoords[i].client.name).join(', ') || '(none)'
        console.log(
          `[schedule] free cluster — seed: ${seedName} (most isolated), ` +
          `members: [${members}], peakCount=${peakCount(cluster)}/${maxJobsPerDay}`
        )
      }

      rawClusters.push(cluster)
    }

    const clusters = rawClusters.slice(0, activeDays.length)
    // Clients in clusters beyond activeDays.length have nowhere to go — bench them
    // explicitly so they surface in result.benched instead of being silently dropped.
    for (const cluster of rawClusters.slice(activeDays.length)) {
      for (const idx of cluster) {
        if (lockedClientIndices.has(idx)) continue
        assignments.push({ clientIdx: idx, dayOfWeek: -1, routeOrder: 0, rotation: 0 })
      }
    }

    // Cluster → day priority (earliest active day first):
    //   1. Lock-anchored clusters — forced to their lock's day, claim it first.
    //   2. Weekly count DESC — weekly clients appear every week, so the
    //      day they land on stays full across W1/W2/W3/W4. Put weekly-heavy
    //      clusters on Mon/Tue so every week view fills those days first.
    //   3. Peak count DESC — fuller day first (ties broken by load).
    //   4. Tightness ASC — geographic compactness as final tiebreaker.
    const weeklyCount = (cluster: number[]) =>
      cluster.filter(i => freqOf(i) === 'weekly').length
    const usedDays = new Set<number>()
    const clusterToRawIdx = new Map<number[], number>()
    rawClusters.forEach((c, i) => clusterToRawIdx.set(c, i))
    const sorted = [...clusters].sort((a, b) => {
      const aLocked = lockClusterDay.has(clusterToRawIdx.get(a) ?? -1)
      const bLocked = lockClusterDay.has(clusterToRawIdx.get(b) ?? -1)
      if (aLocked !== bLocked) return aLocked ? -1 : 1
      const wDiff = weeklyCount(b) - weeklyCount(a)
      if (wDiff !== 0) return wDiff
      const pDiff = peakCount(b) - peakCount(a)
      if (pDiff !== 0) return pDiff
      return clusterTightness(a, clientMatrix) - clusterTightness(b, clientMatrix)
    })

    for (const cluster of sorted) {
      const rawIdx = clusterToRawIdx.get(cluster) ?? -1
      const forcedDay = lockClusterDay.get(rawIdx)

      const clusterBlocked = new Set<number>()
      for (const idx of cluster) {
        const blocked = clientBlocked.get(idx)
        if (blocked) blocked.forEach(d => clusterBlocked.add(d))
      }

      let bestDay = -1
      if (forcedDay !== undefined) {
        bestDay = forcedDay
      } else {
        for (const day of activeDays) {
          if (usedDays.has(day)) continue
          if (clusterBlocked.has(day)) continue
          bestDay = day
          break
        }
        if (bestDay === -1) {
          for (const day of activeDays) {
            if (clusterBlocked.has(day)) continue
            bestDay = day
            break
          }
        }
        if (bestDay === -1) bestDay = activeDays[0]
      }
      usedDays.add(bestDay)

      if (debug) {
        const tag = forcedDay !== undefined ? 'lock-anchored' : 'free'
        const names = cluster.map(i => withCoords[i].client.name).join(', ')
        console.log(`[schedule] ${tag} cluster → day ${bestDay}: [${names}]`)
      }

      for (const idx of cluster) {
        if (lockedClientIndices.has(idx)) continue
        const blocked = clientBlocked.get(idx)
        let assignDay = bestDay
        if (blocked && blocked.has(bestDay)) {
          assignDay = activeDays.find(d => !blocked.has(d)) ?? activeDays[0]
          if (debug) {
            const name = withCoords[idx].client.name
            console.log(`[schedule] ${name} (freq=${freqOf(idx)}) rerouted from cluster day ${bestDay} → ${assignDay} (blocked: ${[...(blocked ?? [])].join(',')})`)
          }
        }
        assignments.push({ clientIdx: idx, dayOfWeek: assignDay, routeOrder: 0, rotation: 0 })
      }
    }

    // ── Split biweekly clients per day into rotation A/B ──
    // Strategy: max-pack the primary rotation, leave the other empty when
    // possible. Users prefer "every-other-Thursday off" over "half-day both
    // weeks." Splits only when the primary's capacity overflows.
    for (const day of activeDays) {
      const bwOnDayUnlocked = assignments.filter(a =>
        a.dayOfWeek === day
        && getFreq(withCoords[a.clientIdx]) === 'biweekly'
        && !lockedClientIndices.has(a.clientIdx)
      )
      if (bwOnDayUnlocked.length === 0) continue

      const lockedBwOnDay = assignments.filter(a =>
        a.dayOfWeek === day
        && getFreq(withCoords[a.clientIdx]) === 'biweekly'
        && lockedClientIndices.has(a.clientIdx)
      )
      const lockedRot0 = lockedBwOnDay.filter(a => a.rotation === 0).length
      const lockedRot1 = lockedBwOnDay.filter(a => a.rotation === 1).length
      const hasLock0 = lockedRot0 > 0
      const hasLock1 = lockedRot1 > 0

      const nonBwOnDay = assignments.filter(a =>
        a.dayOfWeek === day && getFreq(withCoords[a.clientIdx]) !== 'biweekly'
      ).map(a => a.clientIdx)

      // ── Both rotations locked → geographic split (can't consolidate) ──
      if (hasLock0 && hasLock1) {
        const bwIndices = bwOnDayUnlocked.map(a => a.clientIdx)
        const cap0 = Math.max(0, maxJobsPerDay - nonBwOnDay.length - lockedRot0)
        const bwClusters = kMedoids(bwIndices, clientMatrix, 2, Math.max(1, cap0))
        const groupA = bwClusters[0] ?? []
        const groupB = bwClusters[1] ?? []
        let avgDist0 = 0, avgDist1 = 0
        if (nonBwOnDay.length > 0 && groupA.length > 0 && groupB.length > 0) {
          for (const ci of groupA) {
            avgDist0 += nonBwOnDay.reduce((s, w) => s + clientMatrix[ci][w], 0) / nonBwOnDay.length
          }
          avgDist0 /= groupA.length
          for (const ci of groupB) {
            avgDist1 += nonBwOnDay.reduce((s, w) => s + clientMatrix[ci][w], 0) / nonBwOnDay.length
          }
          avgDist1 /= groupB.length
        }
        const rotASet = new Set(avgDist0 <= avgDist1 ? groupA : groupB)
        for (const a of bwOnDayUnlocked) {
          a.rotation = rotASet.has(a.clientIdx) ? 0 : 1
        }
        if (debug) {
          const a0 = bwOnDayUnlocked.filter(a => a.rotation === 0).map(a => withCoords[a.clientIdx].client.name).join(', ')
          const a1 = bwOnDayUnlocked.filter(a => a.rotation === 1).map(a => withCoords[a.clientIdx].client.name).join(', ')
          console.log(`[rotation] day ${day} both-locked split: rot0=[${a0}], rot1=[${a1}]`)
        }
        continue
      }

      // ── Single primary rotation: max-pack it, spill only on overflow ──
      const primaryRot: 0 | 1 = hasLock1 ? 1 : 0
      const otherRot: 0 | 1 = primaryRot === 0 ? 1 : 0
      const lockedOnPrimary = primaryRot === 0 ? lockedRot0 : lockedRot1
      const primaryCap = Math.max(0, maxJobsPerDay - nonBwOnDay.length - lockedOnPrimary)

      if (bwOnDayUnlocked.length <= primaryCap) {
        for (const a of bwOnDayUnlocked) a.rotation = primaryRot
        if (debug) {
          const names = bwOnDayUnlocked.map(a => withCoords[a.clientIdx].client.name).join(', ')
          console.log(`[rotation] day ${day} all on rot${primaryRot} (${bwOnDayUnlocked.length}/${primaryCap}) — other rotation empty: [${names}]`)
        }
        continue
      }

      // Overflow: split into 2 geographic sub-clusters via k-medoids so houses
      // that are close together stay on the same rotation. Then assign the
      // sub-cluster nearest the locks/non-bw anchors → primary rotation.
      const bwIndices = bwOnDayUnlocked.map(a => a.clientIdx)
      const otherCap = Math.max(0, maxJobsPerDay - nonBwOnDay.length - (primaryRot === 0 ? lockedRot1 : lockedRot0))
      const bwClusters = kMedoids(bwIndices, clientMatrix, 2, Math.max(1, primaryCap))
      let groupA = [...(bwClusters[0] ?? [])]
      let groupB = [...(bwClusters[1] ?? [])]

      const anchorIdxs = [
        ...lockedBwOnDay.map(a => a.clientIdx),
        ...nonBwOnDay,
      ]
      const avgDistTo = (group: number[], anchors: number[]) => {
        if (group.length === 0 || anchors.length === 0) return Infinity
        let s = 0
        for (const ci of group) {
          for (const ai of anchors) s += clientMatrix[ci][ai]
        }
        return s / (group.length * anchors.length)
      }
      let primaryGroup: number[]
      let otherGroup: number[]
      if (anchorIdxs.length > 0) {
        const dA = avgDistTo(groupA, anchorIdxs)
        const dB = avgDistTo(groupB, anchorIdxs)
        if (dA <= dB) { primaryGroup = groupA; otherGroup = groupB }
        else { primaryGroup = groupB; otherGroup = groupA }
      } else {
        if (groupA.length >= groupB.length) { primaryGroup = groupA; otherGroup = groupB }
        else { primaryGroup = groupB; otherGroup = groupA }
      }

      const centroidDist = (ci: number, group: number[]) => {
        if (group.length === 0) return 0
        let s = 0
        for (const o of group) if (o !== ci) s += clientMatrix[ci][o]
        return group.length > 1 ? s / (group.length - 1) : 0
      }
      if (primaryGroup.length > primaryCap) {
        const ranked = [...primaryGroup].sort((x, y) =>
          centroidDist(x, primaryGroup) - centroidDist(y, primaryGroup),
        )
        const keep = new Set(ranked.slice(0, primaryCap))
        const spill = ranked.slice(primaryCap)
        primaryGroup = primaryGroup.filter(ci => keep.has(ci))
        otherGroup = [...otherGroup, ...spill]
      }
      if (otherGroup.length > otherCap) {
        const ranked = [...otherGroup].sort((x, y) =>
          centroidDist(x, otherGroup) - centroidDist(y, otherGroup),
        )
        const keep = new Set(ranked.slice(0, otherCap))
        const spill = ranked.slice(otherCap)
        otherGroup = otherGroup.filter(ci => keep.has(ci))
        primaryGroup = [...primaryGroup, ...spill]
      }

      const primarySet = new Set(primaryGroup)
      for (const a of bwOnDayUnlocked) {
        a.rotation = primarySet.has(a.clientIdx) ? primaryRot : otherRot
      }
      if (debug) {
        const primaryNames = bwOnDayUnlocked.filter(a => a.rotation === primaryRot).map(a => withCoords[a.clientIdx].client.name).join(', ')
        const spillNames = bwOnDayUnlocked.filter(a => a.rotation === otherRot).map(a => withCoords[a.clientIdx].client.name).join(', ')
        console.log(`[rotation] day ${day} overflow k-medoids split: rot${primaryRot}=[${primaryNames}] (cap ${primaryCap}), rot${otherRot}=[${spillNames}] (cap ${otherCap})`)
      }
    }
  }

  // ── Final enforcement: rebalance days that exceed maxJobsPerDay ──
  // Try to MOVE overflow clients to a day with room (geographically nearest).
  // Only bench if no day has capacity.
  const peakOf = (day: number) => {
    const dayAssign = assignments.filter(a => a.dayOfWeek === day)
    const weekly = dayAssign.filter(a => getFreq(withCoords[a.clientIdx]) === 'weekly').length
    const monthly = dayAssign.filter(a => getFreq(withCoords[a.clientIdx]) === 'monthly').length
    const other = dayAssign.filter(a => {
      const f = getFreq(withCoords[a.clientIdx])
      return f !== 'biweekly' && f !== 'weekly' && f !== 'monthly'
    }).length
    const bwA = dayAssign.filter(a => getFreq(withCoords[a.clientIdx]) === 'biweekly' && a.rotation === 0).length
    const bwB = dayAssign.filter(a => getFreq(withCoords[a.clientIdx]) === 'biweekly' && a.rotation === 1).length
    return weekly + Math.ceil(monthly / 4) + other + Math.max(bwA, bwB)
  }

  const debug = !!(globalThis as { __PIP_DEBUG__?: boolean }).__PIP_DEBUG__

  for (const day of activeDays) {
    if (peakOf(day) <= maxJobsPerDay) continue

    if (debug) {
      const dayAssign = assignments.filter(a => a.dayOfWeek === day)
      const names = dayAssign.map(a => `${withCoords[a.clientIdx].client.name}(${getFreq(withCoords[a.clientIdx])}${getFreq(withCoords[a.clientIdx]) === 'biweekly' ? (a.rotation === 0 ? '-A' : '-B') : ''})`)
      console.log(`[rebalance] Day ${day} overflows peak=${peakOf(day)} max=${maxJobsPerDay} — ${names.join(', ')}`)
    }

    const dayAssign = assignments.filter(a => a.dayOfWeek === day)
    const movable = dayAssign.filter(a => !lockedClientIndices.has(a.clientIdx))
    const sortedByDist = movable.map(a => {
      const others = dayAssign.filter(o => o.clientIdx !== a.clientIdx)
      const avg = others.length > 0
        ? others.reduce((s, o) => s + clientMatrix[a.clientIdx][o.clientIdx], 0) / others.length
        : 0
      return { assignment: a, avg }
    }).sort((a, b) => b.avg - a.avg)

    for (const { assignment } of sortedByDist) {
      if (peakOf(day) <= maxJobsPerDay) break

      const blocked = clientBlocked.get(assignment.clientIdx)
      const isBiweekly = getFreq(withCoords[assignment.clientIdx]) === 'biweekly'
      let bestAlt = -1
      let bestAltRot: 0 | 1 = 0
      let bestAltDist = Infinity
      for (const alt of activeDays) {
        if (alt === day) continue
        if (blocked?.has(alt)) continue

        const rotationsToTry: (0 | 1)[] = isBiweekly ? [0, 1] : [0]
        const originalDay = assignment.dayOfWeek
        const originalRot = assignment.rotation

        for (const tryRot of rotationsToTry) {
          assignment.dayOfWeek = alt
          assignment.rotation = tryRot
          const altPeak = peakOf(alt)
          assignment.dayOfWeek = originalDay
          assignment.rotation = originalRot
          if (altPeak > maxJobsPerDay) continue

          const altMembers = assignments.filter(a => a.dayOfWeek === alt)
          const score = altMembers.length > 0
            ? altMembers.reduce((s, m) => s + clientMatrix[assignment.clientIdx][m.clientIdx], 0) / altMembers.length
            : 0
          if (score < bestAltDist) {
            bestAltDist = score
            bestAlt = alt
            bestAltRot = tryRot
          }
        }
      }

      if (bestAlt !== -1) {
        const fromDay = assignment.dayOfWeek
        const fromRot = assignment.rotation
        assignment.dayOfWeek = bestAlt
        if (isBiweekly) assignment.rotation = bestAltRot
        if (debug) {
          const name = withCoords[assignment.clientIdx].client.name
          const rotNote = isBiweekly ? ` (rotation ${fromRot} → ${bestAltRot})` : ''
          console.log(`[rebalance]  → moved ${name} from day ${fromDay} to day ${bestAlt}${rotNote}`)
        }
      } else {
        // Last resort before benching: flip rotation on the same day.
        // Peak = max(rotA, rotB) — the lighter rotation may have room.
        let saved = false
        if (getFreq(withCoords[assignment.clientIdx]) === 'biweekly') {
          const originalRot = assignment.rotation
          const flipped: 0 | 1 = originalRot === 0 ? 1 : 0
          assignment.rotation = flipped
          if (peakOf(day) <= maxJobsPerDay) {
            saved = true
            if (debug) {
              const name = withCoords[assignment.clientIdx].client.name
              console.log(`[rebalance]  → saved ${name} on day ${day} by flipping rotation ${originalRot} → ${flipped}`)
            }
          } else {
            assignment.rotation = originalRot
          }
        }

        if (!saved) {
          if (debug) {
            const name = withCoords[assignment.clientIdx].client.name
            const blockedStr = [...(blocked ?? [])].join(',') || 'none'
            const altInfo = activeDays
              .filter(d => d !== day)
              .map(d => {
                if (blocked?.has(d)) return `${d}:blocked`
                const originalDay = assignment.dayOfWeek
                assignment.dayOfWeek = d
                const p = peakOf(d)
                assignment.dayOfWeek = originalDay
                return `${d}:peak=${p}${p > maxJobsPerDay ? '(full)' : ''}`
              })
              .join(', ')
            console.log(`[rebalance]  → BENCHED ${name} (freq=${getFreq(withCoords[assignment.clientIdx])}, blocked=[${blockedStr}]) — no alt day: ${altInfo}`)
          }
          assignment.dayOfWeek = -1
        }
      }
    }
  }

  // ── Consolidation pass: pack the start of the week ──
  // Walk active days in order. Whenever an earlier day has headroom, pull the
  // best-fitting client from a LATER day forward. Slack always sits at the end
  // of the week (Mon=4/4, Tue=4/4, ..., Fri=2/4) instead of sprinkled across
  // days. Locks never move. Geography breaks ties.
  for (let i = 0; i < activeDays.length; i++) {
    const earlierDay = activeDays[i]
    let safety = 0
    while (peakOf(earlierDay) < maxJobsPerDay && safety++ < 100) {
      let bestCand: { assignment: typeof assignments[number]; rot: 0 | 1; score: number } | null = null
      for (let j = i + 1; j < activeDays.length; j++) {
        const laterDay = activeDays[j]
        const laterMembers = assignments.filter(a => a.dayOfWeek === laterDay && !lockedClientIndices.has(a.clientIdx))
        for (const a of laterMembers) {
          const blocked = clientBlocked.get(a.clientIdx)
          if (blocked?.has(earlierDay)) continue
          const isBw = getFreq(withCoords[a.clientIdx]) === 'biweekly'
          const rotationsToTry: (0 | 1)[] = isBw ? [0, 1] : [0]
          const origDay = a.dayOfWeek
          const origRot = a.rotation
          for (const tryRot of rotationsToTry) {
            a.dayOfWeek = earlierDay
            a.rotation = tryRot
            const newEarlierPeak = peakOf(earlierDay)
            a.dayOfWeek = origDay
            a.rotation = origRot
            if (newEarlierPeak > maxJobsPerDay) continue
            const earlierMembers = assignments.filter(x => x.dayOfWeek === earlierDay && x.clientIdx !== a.clientIdx)
            const score = earlierMembers.length > 0
              ? earlierMembers.reduce((s, m) => s + clientMatrix[a.clientIdx][m.clientIdx], 0) / earlierMembers.length
              : 0
            if (!bestCand || score < bestCand.score) {
              bestCand = { assignment: a, rot: tryRot, score }
            }
          }
        }
      }
      if (!bestCand) break
      const { assignment: moved, rot } = bestCand
      const fromDay = moved.dayOfWeek
      const fromRot = moved.rotation
      moved.dayOfWeek = earlierDay
      if (getFreq(withCoords[moved.clientIdx]) === 'biweekly') moved.rotation = rot
      if (debug) {
        const name = withCoords[moved.clientIdx].client.name
        const rotNote = getFreq(withCoords[moved.clientIdx]) === 'biweekly' ? ` (rot ${fromRot}→${rot})` : ''
        console.log(`[consolidate] pulled ${name} from day ${fromDay} → day ${earlierDay}${rotNote} (peak now ${peakOf(earlierDay)}/${maxJobsPerDay})`)
      }
    }
  }

  // After consolidation, rerun the biweekly rotation max-pack within each day:
  // moves between days may have left a day with sub-optimal A/B split (e.g.
  // 3 on rot0, 1 on rot1 when both fit on rot0). Re-pack.
  for (const day of activeDays) {
    const bwOnDay = assignments.filter(a =>
      a.dayOfWeek === day && getFreq(withCoords[a.clientIdx]) === 'biweekly',
    )
    const lockedBw = bwOnDay.filter(a => lockedClientIndices.has(a.clientIdx))
    const movableBw = bwOnDay.filter(a => !lockedClientIndices.has(a.clientIdx))
    if (movableBw.length === 0) continue
    const lockedRot0 = lockedBw.filter(a => a.rotation === 0).length
    const lockedRot1 = lockedBw.filter(a => a.rotation === 1).length
    if (lockedRot0 > 0 && lockedRot1 > 0) continue
    const nonBwCount = assignments.filter(a => a.dayOfWeek === day && getFreq(withCoords[a.clientIdx]) !== 'biweekly').length
    const primaryRot: 0 | 1 = lockedRot1 > 0 ? 1 : 0
    const primaryCap = Math.max(0, maxJobsPerDay - nonBwCount - (primaryRot === 0 ? lockedRot0 : lockedRot1))
    if (movableBw.length <= primaryCap) {
      for (const a of movableBw) a.rotation = primaryRot
    }
  }

  if (debug) {
    const freqOfFinal = (i: number) => getFreq(withCoords[i]) as Client['frequency']
    const placed = assignments.filter(a => a.dayOfWeek !== -1)
    const benched = assignments.filter(a => a.dayOfWeek === -1)
    console.log(`[schedule] Final: ${placed.length} placed, ${benched.length} benched`)
    for (const day of activeDays) {
      const onDay = placed.filter(a => a.dayOfWeek === day)
      const w = onDay.filter(a => freqOfFinal(a.clientIdx) === 'weekly').length
      const bA = onDay.filter(a => freqOfFinal(a.clientIdx) === 'biweekly' && a.rotation === 0).length
      const bB = onDay.filter(a => freqOfFinal(a.clientIdx) === 'biweekly' && a.rotation === 1).length
      const m = onDay.filter(a => freqOfFinal(a.clientIdx) === 'monthly').length
      console.log(`[schedule] Day ${day}: weekly=${w} biweekly(A=${bA}, B=${bB}) monthly=${m} → W1peak=${w+bA+m} W2peak=${w+bB+m}`)
    }
  }

  return assignments
}

/**
 * Generate the perfect schedule — k-medoids geographic clustering.
 *
 * Clusters all clients by proximity using k-medoids on ORS drive times,
 * assigns clusters to days, then handles recurrence (biweekly rotations,
 * monthly placement). Route ordering within each day uses TSP (solveRouteFromDepot).
 */
export async function generatePerfectSchedule(
  clientsWithDays: ClientWithDay[],
  config: OptimizeConfig,
  homeCoords: { lat: number; lng: number },
  _durationMap?: Map<string, number>,
  recurrenceMap?: Map<string, string>,
  lockedClients?: Map<string, { day: number; rotation: 0 | 1 }>,
): Promise<PerfectScheduleResult> {
  const withCoords = clientsWithDays.filter(c => c.client.lat !== null && c.client.lng !== null)

  // Build matrix: home at index 0, clients at 1..N
  const coords: Array<{ lat: number; lng: number }> = [homeCoords]
  for (const c of withCoords) coords.push({ lat: c.client.lat!, lng: c.client.lng! })

  const matrixSeconds = await getORSMatrixSeconds(coords)
  const matrixMinutes = matrixSeconds.map(row => row.map(s => s / 60))

  // Current schedule drive time — recurrence-weighted average per week.
  // Each client contributes to a day's route proportional to how often they
  // show up: weekly=1.0, biweekly=0.5, monthly=0.25, custom=1/intervalWeeks.
  const currentDayGroups = new Map<number, number[]>()
  for (let i = 0; i < withCoords.length; i++) {
    const day = withCoords[i].currentDay
    const group = currentDayGroups.get(day) || []
    group.push(i)
    currentDayGroups.set(day, group)
  }
  let currentDriveMinutes = 0
  for (const [, indices] of currentDayGroups) {
    const matrixIndices = indices.map(i => i + 1)
    const route = solveRouteFromDepot(0, matrixIndices, matrixMinutes)
    const weight = indices.reduce((s, i) => {
      const c = withCoords[i].client
      const freq = recurrenceMap?.get(c.id) ?? c.frequency
      return s + frequencyWeight(freq as Client['frequency'], c.intervalWeeks)
    }, 0) / indices.length
    currentDriveMinutes += route.cost * weight
  }

  // Working days as index array
  const activeDays = config.workingDays
    .map((on, i) => on ? i : -1)
    .filter(i => i >= 0)

  // Translate locked clients from IDs to indices
  let lockedDays: Map<number, { day: number; rotation: 0 | 1 }> | undefined
  if (lockedClients && lockedClients.size > 0) {
    lockedDays = new Map()
    for (let i = 0; i < withCoords.length; i++) {
      const locked = lockedClients.get(withCoords[i].client.id)
      if (locked) lockedDays.set(i, locked)
    }
  }

  // Run k-medoids clustering assignment
  const internalAssignments = buildScheduleFromClusters(
    withCoords, matrixSeconds, activeDays, config.maxJobsPerDay || 99,
    recurrenceMap, lockedDays,
    _durationMap, config.workingMinutes,
  )

  // Build result — separate placed from benched
  const assignments = new Map<string, number>()
  const rotations = new Map<string, number>()
  const routesByDay = new Map<number, string[]>()
  const changes: PerfectScheduleResult['changes'] = []
  const benched: string[] = []

  // Group by day (skip benched: dayOfWeek === -1)
  const dayGroups = new Map<number, InternalAssignment[]>()
  for (const a of internalAssignments) {
    const clientId = withCoords[a.clientIdx].client.id
    if (a.dayOfWeek === -1) {
      benched.push(clientId)
      continue
    }
    assignments.set(clientId, a.dayOfWeek)
    rotations.set(clientId, a.rotation)
    const group = dayGroups.get(a.dayOfWeek) || []
    group.push(a)
    dayGroups.set(a.dayOfWeek, group)
  }

  // New schedule drive time — recurrence-weighted average per week (same
  // formula as the current number, so they're directly comparable).
  let totalDriveMinutes = 0
  for (const [day, group] of dayGroups) {
    group.sort((a, b) => a.routeOrder - b.routeOrder)
    const matrixIndices = group.map(a => a.clientIdx + 1)
    const route = solveRouteFromDepot(0, matrixIndices, matrixMinutes)
    const weight = group.reduce((s, a) => {
      const c = withCoords[a.clientIdx].client
      const freq = recurrenceMap?.get(c.id) ?? c.frequency
      return s + frequencyWeight(freq as Client['frequency'], c.intervalWeeks)
    }, 0) / group.length
    totalDriveMinutes += route.cost * weight
    routesByDay.set(day, route.order.filter(i => i !== 0).map(i => withCoords[i - 1].client.id))
  }

  // ── Build N-week grid ──
  // Key format: "week-day" e.g. "0-1" = week 0, Monday
  // Week count adapts to the longest custom recurrence interval (min 4)
  let maxWeeks = 4
  for (const a of internalAssignments) {
    const client = withCoords[a.clientIdx].client
    const freq = recurrenceMap?.get(client.id) ?? client.frequency
    if (freq === 'custom' && client.intervalWeeks && client.intervalWeeks > maxWeeks) {
      maxWeeks = client.intervalWeeks
    }
  }

  const grid = new Map<string, GridCell[]>()

  for (const a of internalAssignments) {
    const client = withCoords[a.clientIdx].client
    const freq = recurrenceMap?.get(client.id) ?? client.frequency
    const cell: GridCell = {
      clientId: client.id,
      clientName: client.name,
      routeOrder: a.routeOrder,
      recurrence: freq as GridCell['recurrence'],
      rotation: a.rotation,
    }

    let weeks: number[]
    if (freq === 'weekly') {
      weeks = Array.from({ length: maxWeeks }, (_, i) => i)
    } else if (freq === 'biweekly') {
      const start = a.rotation === 0 ? 0 : 1
      weeks = []
      for (let w = start; w < maxWeeks; w += 2) weeks.push(w)
    } else if (freq === 'custom') {
      const interval = client.intervalWeeks ?? 4
      weeks = []
      for (let w = 0; w < maxWeeks; w += interval) weeks.push(w)
    } else {
      const weekLoads = Array.from({ length: maxWeeks }, (_, w) => {
        const k = `${w}-${a.dayOfWeek}`
        return { week: w, count: (grid.get(k) || []).length }
      })
      weekLoads.sort((a, b) => a.count - b.count)
      weeks = [weekLoads[0].week]
    }

    for (const w of weeks) {
      const k = `${w}-${a.dayOfWeek}`
      const existing = grid.get(k) || []
      grid.set(k, [...existing, cell])
    }
  }

  for (const a of internalAssignments) {
    const c = withCoords[a.clientIdx]
    if (a.dayOfWeek !== c.currentDay) {
      changes.push({
        clientId: c.client.id,
        clientName: c.client.name,
        fromDay: c.currentDay,
        toDay: a.dayOfWeek,
      })
    }
  }

  // Per-cell leg times — for each (week, day) grid cell, compute the
  // TSP-ordered leg times from home through the clients in that cell.
  const idToCoordIdx = new Map<string, number>()
  for (let i = 0; i < withCoords.length; i++) idToCoordIdx.set(withCoords[i].client.id, i + 1)
  const legTimes = new Map<string, number[]>()
  const cellDriveMinutes = new Map<string, number>()
  for (const [k, cells] of grid) {
    if (cells.length === 0) continue
    const matrixIdx = cells
      .map(c => idToCoordIdx.get(c.clientId))
      .filter((i): i is number => i !== undefined)
    if (matrixIdx.length === 0) continue
    const route = solveRouteFromDepot(0, matrixIdx, matrixMinutes)
    const legs: number[] = []
    for (let i = 0; i < route.order.length - 1; i++) {
      legs.push(Math.round(matrixMinutes[route.order[i]][route.order[i + 1]]))
    }
    legTimes.set(k, legs)
    cellDriveMinutes.set(k, Math.round(route.cost))
    const orderById = new Map<string, number>()
    route.order.slice(1).forEach((mIdx, pos) => {
      const clientId = withCoords[mIdx - 1].client.id
      orderById.set(clientId, pos)
    })
    cells.sort((a, b) => (orderById.get(a.clientId) ?? 0) - (orderById.get(b.clientId) ?? 0))
  }

  // ── Build _context for downstream AI passes (diagnostics + legal moves). ──
  // Index-aligned with matrixMinutes: clientIds[i] is at matrix index i+1.
  const clientIds = withCoords.map(c => c.client.id)
  const clientCoords = new Map<string, { lat: number; lng: number }>()
  const clientNames = new Map<string, string>()
  const clientBlockedDays = new Map<string, number[]>()
  const clientFrequencies = new Map<string, Client['frequency']>()
  const clientIntervalWeeks = new Map<string, number | undefined>()
  for (const c of withCoords) {
    clientCoords.set(c.client.id, { lat: c.client.lat!, lng: c.client.lng! })
    clientNames.set(c.client.id, c.client.name)
    clientBlockedDays.set(c.client.id, c.client.blockedDays ?? [])
    const effFreq = (recurrenceMap?.get(c.client.id) ?? c.client.frequency) as Client['frequency']
    clientFrequencies.set(c.client.id, effFreq)
    clientIntervalWeeks.set(c.client.id, c.client.intervalWeeks)
  }

  return {
    assignments,
    rotations,
    routesByDay,
    grid,
    totalDriveMinutes: Math.round(totalDriveMinutes),
    currentDriveMinutes: Math.round(currentDriveMinutes),
    changes,
    benched,
    legTimes,
    cellDriveMinutes,
    _context: {
      clientIds,
      matrixMinutes,
      homeCoords,
      workingDays: config.workingDays,
      maxJobsPerDay: config.maxJobsPerDay || 99,
      recurrenceMap,
      durationMap: _durationMap,
      clientCoords,
      clientNames,
      clientBlockedDays,
      clientFrequencies,
      clientIntervalWeeks,
    },
  }
}

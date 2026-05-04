/**
 * Schedule Optimizer — K-Medoids Clustering + Local Moves + Swap Pairs
 *
 * Each suggestion is computed against the CURRENT schedule.
 * No move depends on any other move. A "no" removes one card, everything else stays valid.
 *
 * Two types of suggestions:
 * 1. Individual moves — independently beneficial
 * 2. Swap pairs — two clients who'd both benefit from trading days
 *
 * Day assignment: k-medoids clustering on ORS drive time matrix for geographic
 * territory optimization. Local moves validate each suggestion independently.
 */

import type { Client, ProposedMove, TransitionMove, DayOfWeek } from './types'
import { getORSMatrixSeconds } from './lib/routing'
import { generatePerfectSchedule, type PerfectScheduleResult } from './lib/scheduleBuilder'

const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// ── Route-based cost primitives ──
//
// These replace the old avgDriveToGroup proxy with actual route-order math.
// An "open path" means we visit clients in order without returning to start.

/**
 * Nearest-neighbor TSP: tries every starting point, keeps the shortest open path.
 * For typical per-day groups (3-8 clients) this is fast and near-optimal.
 */
export function solveRoute(
  indices: number[],
  matrix: number[][],
): { order: number[]; cost: number } {
  if (indices.length <= 1) return { order: [...indices], cost: 0 }

  let bestOrder: number[] = []
  let bestCost = Infinity

  for (const start of indices) {
    const visited = new Set<number>([start])
    const order = [start]
    let cost = 0

    while (visited.size < indices.length) {
      const current = order[order.length - 1]
      let nearestIdx = -1
      let nearestDist = Infinity
      for (const idx of indices) {
        if (visited.has(idx)) continue
        if (matrix[current][idx] < nearestDist) {
          nearestDist = matrix[current][idx]
          nearestIdx = idx
        }
      }
      order.push(nearestIdx)
      visited.add(nearestIdx)
      cost += nearestDist
    }

    if (cost < bestCost) {
      bestCost = cost
      bestOrder = order
    }
  }

  // 2-opt improvement
  bestOrder = twoOpt(bestOrder, matrix)
  bestCost = routeCost(bestOrder, matrix)

  return { order: bestOrder, cost: bestCost }
}

/**
 * 2-opt improvement: repeatedly reverse segments to reduce total cost.
 * For open paths, tries all (i,j) segment reversals.
 */
function twoOpt(order: number[], matrix: number[][], fixedStart = false): number[] {
  if (order.length <= 3) return order
  const route = [...order]
  let improved = true
  const startIdx = fixedStart ? 1 : 0 // don't move depot if fixedStart

  while (improved) {
    improved = false
    for (let i = startIdx; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        // Cost of current edges around the segment [i..j]
        const prevI = i > 0 ? matrix[route[i - 1]][route[i]] : 0
        const afterJ = j < route.length - 1 ? matrix[route[j]][route[j + 1]] : 0
        // Cost if we reverse the segment
        const prevJ = i > 0 ? matrix[route[i - 1]][route[j]] : 0
        const afterI = j < route.length - 1 ? matrix[route[i]][route[j + 1]] : 0

        if (prevJ + afterI < prevI + afterJ) {
          // Reverse segment [i..j]
          let left = i, right = j
          while (left < right) {
            const tmp = route[left]
            route[left] = route[right]
            route[right] = tmp
            left++
            right--
          }
          improved = true
        }
      }
    }
  }
  return route
}

/** Sum of sequential edge costs along an ordered open-path route. */
export function routeCost(order: number[], matrix: number[][]): number {
  let cost = 0
  for (let i = 0; i < order.length - 1; i++) {
    cost += matrix[order[i]][order[i + 1]]
  }
  return cost
}

// ── K-Medoids (PAM) Clustering ──
//
// Industry-standard algorithm for geographic territory optimization.
// Groups clients into K clusters where K = number of working days.
// Uses ORS drive time matrix — real road distances, not lat/lng.

/**
 * K-Medoids (PAM — Partitioning Around Medoids).
 *
 * 1. BUILD: select K starting medoids that minimize total cost
 * 2. ASSIGN: every client → nearest medoid
 * 3. SWAP: try replacing each medoid with a non-medoid; keep if it reduces total cost
 * 4. Repeat until stable
 *
 * Returns K arrays of client indices. Each array is a geographic cluster.
 */
export function kMedoids(
  clientIndices: number[],
  matrix: number[][],
  k: number,
  maxPerCluster = Infinity,
): number[][] {
  const n = clientIndices.length
  if (n === 0) return []
  if (k >= n) return clientIndices.map(i => [i])

  // ── BUILD: greedy medoid initialization ──
  const medoids: number[] = []
  const remaining = new Set(clientIndices)

  // First medoid: client that minimizes total distance to all others
  let bestTotal = Infinity
  let bestFirst = clientIndices[0]
  for (const c of clientIndices) {
    let total = 0
    for (const o of clientIndices) {
      if (o !== c) total += matrix[c][o]
    }
    if (total < bestTotal) { bestTotal = total; bestFirst = c }
  }
  medoids.push(bestFirst)
  remaining.delete(bestFirst)

  // Subsequent medoids: each one reduces total cost the most
  while (medoids.length < k && remaining.size > 0) {
    let bestGain = -Infinity
    let bestNext = -1

    for (const candidate of remaining) {
      let gain = 0
      for (const c of clientIndices) {
        if (c === candidate) continue
        let currentMin = Infinity
        for (const m of medoids) currentMin = Math.min(currentMin, matrix[c][m])
        const candidateDist = matrix[c][candidate]
        if (candidateDist < currentMin) gain += currentMin - candidateDist
      }
      if (gain > bestGain) { bestGain = gain; bestNext = candidate }
    }

    if (bestNext === -1) break
    medoids.push(bestNext)
    remaining.delete(bestNext)
  }

  // Capacitated assignment: nearest medoid WITH ROOM
  function assignWithCapacity(meds: number[]): Map<number, number[]> {
    const clusters = new Map<number, number[]>()
    for (const m of meds) clusters.set(m, [])

    // Sort clients by distance to their nearest medoid (farthest first)
    // so that the tightest clients get priority for full clusters
    const sorted = clientIndices
      .map(c => {
        let minDist = Infinity
        for (const m of meds) minDist = Math.min(minDist, matrix[c][m])
        return { client: c, minDist }
      })
      .sort((a, b) => a.minDist - b.minDist) // closest first = priority

    for (const { client: c } of sorted) {
      // Sort medoids by distance, pick nearest with room
      const byDist = [...meds]
        .map(m => ({ m, d: matrix[c][m] }))
        .sort((a, b) => a.d - b.d)

      let assigned = false
      for (const { m } of byDist) {
        if (clusters.get(m)!.length < maxPerCluster) {
          clusters.get(m)!.push(c)
          assigned = true
          break
        }
      }
      // Fallback: if all full (shouldn't happen with proper k), add to nearest
      if (!assigned) {
        clusters.get(byDist[0].m)!.push(c)
      }
    }
    return clusters
  }

  // ── ASSIGN + SWAP loop ──
  let improved = true
  while (improved) {
    improved = false

    const clusters = assignWithCapacity(medoids)

    // Total cost
    let currentCost = 0
    for (const [m, members] of clusters) {
      for (const c of members) currentCost += matrix[c][m]
    }

    // Try swapping each medoid with each non-medoid
    let bestSwapCost = currentCost
    let swapOut = -1
    let swapIn = -1

    for (let mi = 0; mi < medoids.length; mi++) {
      for (const c of clientIndices) {
        if (medoids.includes(c)) continue
        const testMedoids = [...medoids]
        testMedoids[mi] = c
        // Evaluate with capacity
        const testClusters = assignWithCapacity(testMedoids)
        let cost = 0
        for (const [m, members] of testClusters) {
          for (const cl of members) cost += matrix[cl][m]
        }
        if (cost < bestSwapCost) {
          bestSwapCost = cost
          swapOut = mi
          swapIn = c
        }
      }
    }

    if (swapOut !== -1) {
      medoids[swapOut] = swapIn
      improved = true
    }
  }

  // Final capacitated assignment
  const finalClusters = assignWithCapacity(medoids)
  return [...finalClusters.values()].filter(c => c.length > 0)
}

/**
 * Greedy Nearest-N Chunking — distance-driven cluster-of-N.
 *
 * Each cluster = N geographically nearest clients. Forms clusters by:
 * 1. Pick most-isolated unplaced client as seed (worst nearest-neighbor distance)
 * 2. Add N-1 nearest unplaced clients to the seed
 * 3. Lock that cluster, repeat
 * 4. Final cluster gets whatever's left (could be < N)
 *
 * Produces "tightest first" packing: 4-4-4-1 instead of 3-4-2-2.
 * Never breaks up tight neighborhoods because clusters are built by nearest-neighbor.
 */
export function greedyNearestNCluster(
  clientIndices: number[],
  matrix: number[][],
  n: number,
): number[][] {
  if (clientIndices.length === 0) return []
  if (n <= 0) return [clientIndices]

  const unplaced = new Set(clientIndices)
  const clusters: number[][] = []

  while (unplaced.size > 0) {
    // Pick seed: most isolated unplaced client (worst nearest-neighbor)
    let seed = -1
    let worstNearest = -Infinity
    for (const c of unplaced) {
      let nearest = Infinity
      for (const o of unplaced) {
        if (o === c) continue
        if (matrix[c][o] < nearest) nearest = matrix[c][o]
      }
      // If this is the only client left, nearest = Infinity → still picks it
      if (nearest > worstNearest) {
        worstNearest = nearest
        seed = c
      }
    }

    if (seed === -1) break

    // Build cluster: seed + N-1 nearest unplaced
    const cluster: number[] = [seed]
    unplaced.delete(seed)

    const candidates = [...unplaced]
      .map(c => ({ c, d: matrix[seed][c] }))
      .sort((a, b) => a.d - b.d)

    for (let i = 0; i < n - 1 && i < candidates.length; i++) {
      cluster.push(candidates[i].c)
      unplaced.delete(candidates[i].c)
    }

    clusters.push(cluster)
  }

  return clusters
}

/**
 * Average pairwise drive time within a cluster — lower = tighter.
 */
export function clusterTightness(cluster: number[], matrix: number[][]): number {
  if (cluster.length <= 1) return 0
  let total = 0
  let pairs = 0
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      total += matrix[cluster[i]][cluster[j]]
      pairs++
    }
  }
  return total / pairs
}

/**
 * Place new clients into an existing schedule (incremental mode).
 * Existing clients stay on their current day. Each new client is assigned
 * to the day whose existing clients they're geographically closest to.
 */
export function placeNewClients(
  newClientIndices: number[],
  existingDays: Map<number, number>,
  matrix: number[][],
  maxPerDay: number,
  activeDays: number[],
  blockedDays?: Map<number, DayOfWeek[]>,
): Map<number, number> {
  const result = new Map<number, number>()
  const dayCount = new Map<number, number>()

  for (const [, day] of existingDays) {
    dayCount.set(day, (dayCount.get(day) || 0) + 1)
  }

  for (const idx of newClientIndices) {
    const blocked = blockedDays?.get(idx)
    let bestDay = activeDays[0]
    let bestAvgDist = Infinity
    let firstEmptyDay: number | null = null

    for (const day of activeDays) {
      if (blocked && blocked.includes(day as DayOfWeek)) continue
      if (maxPerDay > 0 && (dayCount.get(day) || 0) >= maxPerDay) continue

      const dayMembers = [...existingDays.entries()]
        .filter(([, d]) => d === day)
        .map(([i]) => i)

      if (dayMembers.length === 0) {
        if (firstEmptyDay === null) firstEmptyDay = day
        continue
      }

      const avgDist = dayMembers.reduce((sum, i) => sum + matrix[idx][i], 0) / dayMembers.length
      if (avgDist < bestAvgDist) {
        bestAvgDist = avgDist
        bestDay = day
      }
    }

    // If no populated day was available (all full/blocked), use the first empty day
    if (bestAvgDist === Infinity && firstEmptyDay !== null) {
      bestDay = firstEmptyDay
    }

    result.set(idx, bestDay)
    dayCount.set(bestDay, (dayCount.get(bestDay) || 0) + 1)
  }

  return result
}

/**
 * Drive time saved by removing a client from an open-path route.
 * Reconnects predecessor directly to successor.
 */
export function removalSavings(
  clientIdx: number,
  route: number[],
  matrix: number[][],
): number {
  const pos = route.indexOf(clientIdx)
  if (pos === -1 || route.length <= 1) return 0

  const prev = pos > 0 ? route[pos - 1] : -1
  const next = pos < route.length - 1 ? route[pos + 1] : -1

  let savings = 0
  if (prev !== -1) savings += matrix[prev][clientIdx]
  if (next !== -1) savings += matrix[clientIdx][next]
  if (prev !== -1 && next !== -1) savings -= matrix[prev][next]
  return savings
}

/**
 * Cheapest cost to insert a client into an existing open-path route.
 * Tries every position: before first, between each pair, after last.
 */
export function cheapestInsertionCost(
  clientIdx: number,
  route: number[],
  matrix: number[][],
  fixedStart = false,
): number {
  if (route.length === 0) return 0

  let minCost = Infinity

  // Before first stop (skip if depot is fixed — can't insert before home)
  if (!fixedStart) {
    minCost = Math.min(minCost, matrix[clientIdx][route[0]])
  }

  // After last stop
  minCost = Math.min(minCost, matrix[route[route.length - 1]][clientIdx])

  // Between consecutive stops
  for (let i = 0; i < route.length - 1; i++) {
    const cost = matrix[route[i]][clientIdx]
      + matrix[clientIdx][route[i + 1]]
      - matrix[route[i]][route[i + 1]]
    minCost = Math.min(minCost, cost)
  }

  return minCost
}

/**
 * Net drive time saved by moving a client from one day's route to another.
 * Positive = saves time. Negative = would cost time (bad move).
 */
export function computeMoveSavings(
  clientIdx: number,
  fromRoute: number[],
  toRoute: number[],
  matrix: number[][],
  fixedStart = false,
): number {
  const saved = removalSavings(clientIdx, fromRoute, matrix)
  const added = cheapestInsertionCost(clientIdx, toRoute, matrix, fixedStart)
  return Math.round(saved - added)
}

/**
 * Nearest-neighbor route anchored at a fixed depot (home address).
 * Always starts from depot, then greedily visits nearest unvisited client.
 */
export function solveRouteFromDepot(
  depotIdx: number,
  clientIndices: number[],
  matrix: number[][],
): { order: number[]; cost: number } {
  if (clientIndices.length === 0) return { order: [depotIdx], cost: 0 }

  const order = [depotIdx]
  const remaining = new Set(clientIndices)
  let cost = 0

  while (remaining.size > 0) {
    const current = order[order.length - 1]
    let nearestIdx = -1
    let nearestDist = Infinity
    for (const idx of remaining) {
      if (matrix[current][idx] < nearestDist) {
        nearestDist = matrix[current][idx]
        nearestIdx = idx
      }
    }
    order.push(nearestIdx)
    remaining.delete(nearestIdx)
    cost += nearestDist
  }

  // 2-opt improvement (keep depot fixed at start)
  const improved = twoOpt(order, matrix, true)
  return { order: improved, cost: routeCost(improved, matrix) }
}

export interface ClientWithDay {
  client: Client
  currentDay: number
}

export interface OptimizeConfig {
  maxJobsPerDay: number
  workingDays: boolean[]
  /** Total minutes available per working day. Sum of job durations on a
   *  given day must fit within this window (drive time intentionally not
   *  counted — grouping by location is assumed to make it negligible). */
  workingMinutes?: number
}

export interface SwapPair {
  moveA: ProposedMove
  moveB: ProposedMove
  totalSavings: number
}

export interface OptimizationResult {
  moves: ProposedMove[]
  swaps: SwapPair[]
  totalPotentialMinutes: number
  perfectWorldMinutes: number
}

// ── Drive time helpers using precomputed matrix ──

/**
 * Compute savings for moving a client to every other working day.
 * Uses pre-computed day routes for actual insertion/removal costs.
 */
export function computeDaySavingsFromMatrix(
  idx: number,
  currentDay: number,
  dayRoutes: Map<number, number[]>,
  matrix: number[][],
  maxJobsPerDay: number,
  dayGroupIndices: Map<number, number[]>,
  workingDays?: boolean[],
  fixedStart = false,
  blockedDays?: DayOfWeek[],
): Array<{ day: number; savings: number; clientCount: number }> {
  const currentRoute = dayRoutes.get(currentDay) || []
  const results: Array<{ day: number; savings: number; clientCount: number }> = []
  const blocked = blockedDays ? new Set(blockedDays) : null

  for (let day = 0; day < 7; day++) {
    if (day === currentDay) continue
    if (workingDays && !workingDays[day]) continue
    if (blocked && blocked.has(day as DayOfWeek)) continue
    const targetIndices = dayGroupIndices.get(day) || []

    if (maxJobsPerDay > 0 && targetIndices.length >= maxJobsPerDay) continue

    const targetRoute = dayRoutes.get(day) || []
    const savings = computeMoveSavings(idx, currentRoute, targetRoute, matrix, fixedStart)
    if (savings > 0) {
      results.push({ day, savings, clientCount: targetIndices.length })
    }
  }

  return results.sort((a, b) => b.savings - a.savings)
}

// ── Sync fallback for "Different Day" picker (uses Haversine) ──

function haversineDistMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3959
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function driveMin(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return (haversineDistMiles(lat1, lng1, lat2, lng2) * 1.4) / 30 * 60
}

/**
 * Sync version for the "Different Day" picker in OptimizeView.
 * Builds a local Haversine distance matrix and uses route-based savings.
 * No API calls — instant response for UI.
 */
export function computeDaySavings(
  client: Client,
  currentDay: number,
  dayGroups: Map<number, Client[]>,
  maxJobsPerDay: number,
  workingDays?: boolean[],
  homeCoords?: { lat: number; lng: number },
  blockedDays?: DayOfWeek[],
): Array<{ day: number; savings: number; clientCount: number }> {
  if (client.lat === null || client.lng === null) return []

  // Collect all geocoded clients and assign local indices
  const allClients: Client[] = []
  const clientIndex = new Map<string, number>()
  for (const [, group] of dayGroups) {
    for (const c of group) {
      if (c.lat !== null && c.lng !== null && !clientIndex.has(c.id)) {
        clientIndex.set(c.id, allClients.length)
        allClients.push(c)
      }
    }
  }

  const myIdx = clientIndex.get(client.id)
  if (myIdx === undefined) return []

  // Build NxN Haversine matrix (minutes)
  const n = allClients.length
  const localMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = driveMin(allClients[i].lat!, allClients[i].lng!, allClients[j].lat!, allClients[j].lng!)
      localMatrix[i][j] = d
      localMatrix[j][i] = d
    }
  }

  // Add home to local matrix if provided
  let homeLocalIdx = -1
  if (homeCoords) {
    homeLocalIdx = n // append after all clients
    // Extend matrix with home row/col
    for (let i = 0; i < n; i++) {
      const d = driveMin(allClients[i].lat!, allClients[i].lng!, homeCoords.lat, homeCoords.lng)
      localMatrix[i].push(d)
    }
    localMatrix.push(Array.from({ length: n + 1 }, (_, j) => j < n
      ? driveMin(homeCoords.lat, homeCoords.lng, allClients[j].lat!, allClients[j].lng!)
      : 0
    ))
  }
  const hasHome = homeLocalIdx >= 0

  // Build current day's route
  const currentDayClients = dayGroups.get(currentDay) || []
  const currentIndices = currentDayClients.filter(c => clientIndex.has(c.id)).map(c => clientIndex.get(c.id)!)
  const currentRoute = hasHome
    ? solveRouteFromDepot(homeLocalIdx, currentIndices, localMatrix).order
    : solveRoute(currentIndices, localMatrix).order

  const results: Array<{ day: number; savings: number; clientCount: number }> = []
  const blocked = blockedDays ? new Set(blockedDays) : null

  for (let day = 0; day < 7; day++) {
    if (day === currentDay) continue
    if (workingDays && !workingDays[day]) continue
    if (blocked && blocked.has(day as DayOfWeek)) continue
    const targetClients = dayGroups.get(day) || []

    if (maxJobsPerDay > 0 && targetClients.length >= maxJobsPerDay) continue

    const targetIndices = targetClients.filter(c => clientIndex.has(c.id)).map(c => clientIndex.get(c.id)!)
    const targetRoute = hasHome
      ? solveRouteFromDepot(homeLocalIdx, targetIndices, localMatrix).order
      : solveRoute(targetIndices, localMatrix).order
    const savings = computeMoveSavings(myIdx, currentRoute, targetRoute, localMatrix, hasHome)
    if (savings > 0) {
      results.push({ day, savings, clientCount: targetClients.length })
    }
  }

  return results.sort((a, b) => b.savings - a.savings)
}

// ── Smart Placement (new-client suggestions) ──
//
// Ranks the top candidate weekdays for a *new* (unplaced) client.
// Blended score: cluster fit (medoid distance) + nearby density - capacity pressure.
// Hard-filters days that violate working days, blocked days, weekly capacity,
// or the daily working-hours budget.

const NEARBY_THRESHOLD_MIN = 15 // "nearby" = within 15 drive minutes
const EMPTY_DAY_FIT_MIN = 25    // neutral medoid distance when a day has no clients

/**
 * Swap candidate for the Transition sidebar's "Can't Move" flow. When a client
 * rejects their new day, the cleaner surfaces top-3 placed clients of matching
 * cadence who'd fit the opening day well geographically.
 *
 * Design: only PLACED clients with matching frequency qualify (bench/dropped
 * clients aren't candidates). Biweekly candidates may shift rotation (A↔B);
 * that's flagged but not disqualifying — frequency preservation is what matters.
 */
export type SwapCandidate = {
  clientId: string
  currentDay: number
  currentRotation: 0 | 1 // biweekly only (0 for weekly)
  frequency: Client['frequency']
  nearestNeighborMin: number
  nearbyCount: number
  rotationShifts: boolean // biweekly only — partner's rotation changes in the swap
}

export function computeSwapCandidates(params: {
  openingDay: number
  openingRotation: 0 | 1
  rejectedClientId: string
  rejectedFrequency: Client['frequency']
  rejectedIntervalWeeks?: number
  allClients: Client[]
  currentDayMap: Map<string, number>          // clientId → weekday (0=Sun..6=Sat)
  currentRotationMap: Map<string, number>     // clientId → 0|1 for biweekly
  clientFrequencies: Map<string, Client['frequency']>
  clientIntervalWeeks: Map<string, number>
  config: { maxJobsPerDay: number; workingDays: boolean[] }
}): SwapCandidate[] {
  const {
    openingDay, openingRotation, rejectedClientId, rejectedFrequency,
    allClients, currentDayMap, currentRotationMap, clientFrequencies, config,
  } = params

  if (!config.workingDays[openingDay]) return []

  const rejected = allClients.find(c => c.id === rejectedClientId)
  if (!rejected || rejected.lat == null || rejected.lng == null) return []

  // Rejected's blocked days — they can't take a partner's day if it's blocked.
  const rejectedBlocked = new Set(rejected.blockedDays ?? [])

  // Group partner candidates by their current (proposed) day, filtering out
  // same-day, wrong-frequency, mutually-blocked, or missing-coord clients.
  const byDay = new Map<number, Client[]>()
  for (const c of allClients) {
    if (c.id === rejectedClientId) continue
    if (c.lat == null || c.lng == null) continue
    const cDay = currentDayMap.get(c.id)
    if (cDay === undefined || cDay < 0) continue
    if (cDay === openingDay) continue                              // must be a DIFFERENT day
    if (!config.workingDays[cDay]) continue
    if (rejectedBlocked.has(cDay as DayOfWeek)) continue           // rejected can't work that day
    if (clientFrequencies.get(c.id) !== rejectedFrequency) continue
    if ((c.blockedDays ?? []).includes(openingDay as DayOfWeek)) continue // partner can't take rejected's day

    const bucket = byDay.get(cDay) ?? []
    bucket.push(c)
    byDay.set(cDay, bucket)
  }

  // Best partner per day: closest to rejected by drive-time.
  const results: SwapCandidate[] = []
  for (const [day, candidates] of byDay) {
    let best: Client | null = null
    let bestDist = Infinity
    for (const c of candidates) {
      const d = driveMin(rejected.lat!, rejected.lng!, c.lat!, c.lng!)
      if (d < bestDist) { bestDist = d; best = c }
    }
    if (!best) continue
    const bestRotation = (currentRotationMap.get(best.id) ?? 0) as 0 | 1
    const rotationShifts = rejectedFrequency === 'biweekly'
      && openingRotation !== bestRotation
    results.push({
      clientId: best.id,
      currentDay: day,
      currentRotation: bestRotation,
      frequency: rejectedFrequency,
      nearestNeighborMin: bestDist,
      nearbyCount: 0, // unused in new model
      rotationShifts,
    })
  }

  results.sort((a, b) => a.nearestNeighborMin - b.nearestNeighborMin)
  return results
}

export type SmartPlacementSuggestion = {
  day: number               // 0-6
  score: number             // higher = better
  clusterFit: number        // minutes from new client to that day's medoid
  nearbyCount: number       // placed clients on that day within NEARBY_THRESHOLD_MIN
  nearestNeighborMin: number // minutes to the CLOSEST placed client on that day (insertion cost proxy)
  capacityPressure: number  // weekLoad / maxJobsPerDay (for breakdown UI)
  weekLoad: number          // frequency-weighted job count on that day (incl. new client)
  dayClientCount: number
}

/** Pick the medoid (client minimizing sum of distances to others in the group). */
function pickMedoid(indices: number[], matrix: number[][]): number {
  if (indices.length === 0) return -1
  if (indices.length === 1) return indices[0]
  let bestIdx = indices[0]
  let bestSum = Infinity
  for (const i of indices) {
    let sum = 0
    for (const j of indices) if (i !== j) sum += matrix[i][j]
    if (sum < bestSum) { bestSum = sum; bestIdx = i }
  }
  return bestIdx
}

/**
 * Rank weekdays for inserting a new (unplaced) client.
 * Synchronous — uses local Haversine. Safe for interactive UI.
 *
 * @param newClient        must have lat/lng; frequency and blockedDays optional
 * @param dayGroups        current placed clients grouped by weekday
 * @param config           maxJobsPerDay, workingDays, workingMinutes (daily budget)
 * @param clientDurations  minutes per placed client (defaults 60 if missing)
 * @param clientFrequency  frequency per placed client (defaults 'weekly')
 * @param newDurationMin   minutes for the new visit (default 60)
 * @param homeCoords       optional depot used as anchor for empty days
 */
export function computeSmartPlacement(
  newClient: { lat: number; lng: number; frequency: Client['frequency']; intervalWeeks?: number; blockedDays?: DayOfWeek[] },
  dayGroups: Map<number, Client[]>,
  config: { maxJobsPerDay: number; workingDays: boolean[]; workingMinutes: number },
  _clientDurations: Map<string, number>,
  clientFrequency: Map<string, Client['frequency']>,
  _newDurationMin: number,
  homeCoords?: { lat: number; lng: number },
): SmartPlacementSuggestion[] {
  if (newClient.lat == null || newClient.lng == null) return []

  // Collect placed clients + local indices.
  const allClients: Client[] = []
  const clientIndex = new Map<string, number>()
  for (const [, group] of dayGroups) {
    for (const c of group) {
      if (c.lat != null && c.lng != null && !clientIndex.has(c.id)) {
        clientIndex.set(c.id, allClients.length)
        allClients.push(c)
      }
    }
  }

  const n = allClients.length
  // Matrix size = placed + newClient (last row/col).
  const N_IDX = n              // new client index
  const size = n + 1
  const matrix: number[][] = Array.from({ length: size }, () => new Array(size).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = driveMin(allClients[i].lat!, allClients[i].lng!, allClients[j].lat!, allClients[j].lng!)
      matrix[i][j] = d
      matrix[j][i] = d
    }
  }
  for (let i = 0; i < n; i++) {
    const d = driveMin(allClients[i].lat!, allClients[i].lng!, newClient.lat, newClient.lng)
    matrix[i][N_IDX] = d
    matrix[N_IDX][i] = d
  }

  const blocked = new Set(newClient.blockedDays ?? [])
  const newWeight = frequencyWeight(newClient.frequency, newClient.intervalWeeks)
  const results: SmartPlacementSuggestion[] = []

  for (let day = 0; day < 7; day++) {
    if (!config.workingDays[day]) continue
    if (blocked.has(day as DayOfWeek)) continue

    const dayClients = dayGroups.get(day) ?? []
    const dayIndices = dayClients
      .filter(c => clientIndex.has(c.id))
      .map(c => clientIndex.get(c.id)!)

    // Frequency-weighted steady-state load — used as a SOFT score penalty only.
    // Hard capacity checks happen per-date in getBestDays.firstFittingDate()
    // because biweekly rotations fit on specific weeks even when the average
    // exceeds max (e.g. 3 biweekly on week A + 5 biweekly on week B = avg 4
    // but week A has room for one more).
    let weekLoad = newWeight
    for (const c of dayClients) {
      const freq = clientFrequency.get(c.id) ?? c.frequency
      const interval = c.intervalWeeks
      weekLoad += frequencyWeight(freq, interval)
    }

    // Cluster fit — medoid distance from the new client.
    let clusterFit: number
    if (dayIndices.length === 0) {
      clusterFit = homeCoords
        ? driveMin(homeCoords.lat, homeCoords.lng, newClient.lat, newClient.lng)
        : EMPTY_DAY_FIT_MIN
    } else {
      const medoid = pickMedoid(dayIndices, matrix)
      clusterFit = matrix[N_IDX][medoid]
    }

    // Neighbors within threshold, AND closest-neighbor drive time
    // (proxy for the marginal cost of inserting this stop into the day's route).
    let nearbyCount = 0
    let nearestNeighborMin = Infinity
    for (const idx of dayIndices) {
      const d = matrix[N_IDX][idx]
      if (d <= NEARBY_THRESHOLD_MIN) nearbyCount++
      if (d < nearestNeighborMin) nearestNeighborMin = d
    }
    // Empty day: fall back to distance from home (or neutral constant).
    if (!isFinite(nearestNeighborMin)) {
      nearestNeighborMin = homeCoords
        ? driveMin(homeCoords.lat, homeCoords.lng, newClient.lat, newClient.lng)
        : EMPTY_DAY_FIT_MIN
    }

    // Blended score — nearestNeighborMin (insertion cost) and nearbyCount (density)
    // are the primary signals; clusterFit is a weak tiebreak; capacityPressure balances load.
    const capacityPressure = config.maxJobsPerDay > 0 ? weekLoad / config.maxJobsPerDay : 0
    const score = (nearbyCount * 5)
                - (nearestNeighborMin * 4)
                - (clusterFit * 1)
                - (capacityPressure * 4)

    results.push({
      day, score, clusterFit, nearbyCount, nearestNeighborMin, capacityPressure, weekLoad,
      dayClientCount: dayClients.length,
    })
  }

  return results.sort((a, b) => b.score - a.score)
}

// ── Main optimizer pipeline ──
//
// Step 1: K-medoids hypothesis — cluster clients by geography using ORS drive times
// Step 2: Local validation — "which of those moves are independently safe?"
// Step 3: Swap pairs — find pairs where both benefit from trading days
//
// K-medoids tells us WHERE to start. Local validation ensures each suggestion is safe on its own.

const DEFAULT_WORKING_DAYS = [false, true, true, true, true, true, false]
const MIN_SAVINGS = 5 // minutes per week threshold

/** Recurrence weight: how many times per week this frequency occurs on average */
export function frequencyWeight(freq: Client['frequency'], intervalWeeks?: number): number {
  if (freq === 'custom') return 1 / (intervalWeeks ?? 4)
  if (freq === 'biweekly') return 0.5
  if (freq === 'monthly') return 0.25
  return 1 // weekly and one-time
}

/**
 * Step 1: Cluster clients by k-medoids using ORS drive time matrix.
 * Returns a map of clientIndex -> suggested day.
 */
function getKMedoidsHypothesis(
  withCoords: ClientWithDay[],
  matrix: number[][],
  config: OptimizeConfig,
): { assignments: Map<number, number> } | null {
  const activeDays = config.workingDays
    .map((on, i) => on ? i : -1)
    .filter(i => i >= 0)

  if (activeDays.length === 0) return null

  const maxPerDay = config.maxJobsPerDay > 0 ? config.maxJobsPerDay : 99
  const clientIndices = withCoords.map((_, i) => i)

  // Greedy nearest-N chunking: each cluster = N nearest clients (N = maxPerDay).
  // K is implicit (ceil(clients/N)), capped at activeDays.length.
  const clusters = greedyNearestNCluster(clientIndices, matrix, maxPerDay)
    .slice(0, activeDays.length)

  // Assign clusters to days respecting blocked days and capacity.
  const assignments = new Map<number, number>()
  const dayCount = new Map<number, number>()

  const clientBlocked = new Map<number, Set<number>>()
  for (let i = 0; i < withCoords.length; i++) {
    const blocked = withCoords[i].client.blockedDays
    if (blocked && blocked.length > 0) clientBlocked.set(i, new Set(blocked))
  }

  // Tightest cluster → first active day (Mon).
  const sorted = [...clusters].sort((a, b) => clusterTightness(a, matrix) - clusterTightness(b, matrix))
  const usedDays = new Set<number>()

  for (const cluster of sorted) {
    const clusterBlocked = new Set<number>()
    for (const idx of cluster) {
      const blocked = clientBlocked.get(idx)
      if (blocked) blocked.forEach(d => clusterBlocked.add(d))
    }

    // Prefer empty non-blocked day, then any day with capacity
    let bestDay = -1
    // First: empty day
    for (const day of activeDays) {
      if (usedDays.has(day)) continue
      if (clusterBlocked.has(day)) continue
      bestDay = day
      break
    }
    // Second: any day with capacity for this cluster
    if (bestDay === -1) {
      for (const day of activeDays) {
        if (clusterBlocked.has(day)) continue
        if ((dayCount.get(day) || 0) + cluster.length <= maxPerDay) {
          bestDay = day
          break
        }
      }
    }
    // Third: day with most remaining room
    if (bestDay === -1) {
      let maxRoom = 0
      for (const day of activeDays) {
        if (clusterBlocked.has(day)) continue
        const room = maxPerDay - (dayCount.get(day) || 0)
        if (room > maxRoom) { maxRoom = room; bestDay = day }
      }
    }
    if (bestDay === -1) bestDay = activeDays[0]
    usedDays.add(bestDay)

    for (const idx of cluster) {
      const blocked = clientBlocked.get(idx)
      if (blocked && blocked.has(bestDay)) {
        const altDay = activeDays.find(d => !blocked.has(d) && (dayCount.get(d) || 0) < maxPerDay) ?? activeDays[0]
        assignments.set(idx, altDay)
        dayCount.set(altDay, (dayCount.get(altDay) || 0) + 1)
      } else if (maxPerDay > 0 && (dayCount.get(bestDay) || 0) >= maxPerDay) {
        const altDay = activeDays.find(d => (dayCount.get(d) || 0) < maxPerDay) ?? bestDay
        assignments.set(idx, altDay)
        dayCount.set(altDay, (dayCount.get(altDay) || 0) + 1)
      } else {
        assignments.set(idx, bestDay)
        dayCount.set(bestDay, (dayCount.get(bestDay) || 0) + 1)
      }
    }
  }

  return { assignments }
}

/**
 * Generate optimization suggestions.
 *
 * Pipeline:
 * 1. Fetch ORS drive time matrix (real road times)
 * 2. K-medoids clustering to get ideal day assignments (hypothesis)
 * 3. For each client the clustering says is misplaced, validate independently
 * 4. Also do a local scan for any moves clustering might have missed
 * 5. Find swap pairs among remaining clients
 *
 * Each suggestion is independently valid against the current schedule.
 */
/**
 * Build a fingerprint of the client roster for k-medoids cache invalidation.
 * Changes when clients are added, removed, or change address.
 */
export function buildRosterFingerprint(clients: ClientWithDay[]): string {
  const sorted = clients
    .filter(c => c.client.lat !== null && c.client.lng !== null)
    .map(c => `${c.client.id}:${c.client.lat!.toFixed(5)}:${c.client.lng!.toFixed(5)}:${c.currentDay}`)
    .sort()
  return sorted.join('|')
}

// K-medoids cache — keyed by roster fingerprint
let cachedKMedoidsResult: { assignments: Map<number, number> } | null = null
let cachedKMedoidsFingerprint: string | null = null
let cachedKMedoidsClientOrder: string[] | null = null

export async function generateOptimization(
  clientsWithDays: ClientWithDay[],
  config: OptimizeConfig = { maxJobsPerDay: 0, workingDays: DEFAULT_WORKING_DAYS },
  homeCoords?: { lat: number; lng: number },
): Promise<OptimizationResult> {
  const withCoords = clientsWithDays.filter(c => c.client.lat !== null && c.client.lng !== null)

  if (withCoords.length < 3) {
    return { moves: [], swaps: [], totalPotentialMinutes: 0, perfectWorldMinutes: 0 }
  }

  // Fetch ORS matrix — append home if provided (becomes last index)
  const coords = withCoords.map(c => ({ lat: c.client.lat!, lng: c.client.lng! }))
  const homeIdx = homeCoords ? coords.length : -1
  if (homeCoords) coords.push(homeCoords)

  const matrixSeconds = await getORSMatrixSeconds(coords)
  const matrix = matrixSeconds.map(row => row.map(s => s / 60)) // minutes
  const hasHome = homeIdx >= 0

  // Build index-based day groups
  const dayGroupIndices = new Map<number, number[]>()
  for (let i = 0; i < withCoords.length; i++) {
    const day = withCoords[i].currentDay
    const group = dayGroupIndices.get(day) || []
    group.push(i)
    dayGroupIndices.set(day, group)
  }

  // Pre-compute route for each day
  const dayRoutes = new Map<number, number[]>()
  if (hasHome) {
    // Initialize all working days with depot-only route
    for (let day = 0; day < 7; day++) {
      if (config.workingDays[day]) dayRoutes.set(day, [homeIdx])
    }
    // Override with actual routes for days that have clients
    for (const [day, indices] of dayGroupIndices) {
      dayRoutes.set(day, solveRouteFromDepot(homeIdx, indices, matrix).order)
    }
  } else {
    for (const [day, indices] of dayGroupIndices) {
      dayRoutes.set(day, solveRoute(indices, matrix).order)
    }
  }

  // ── Step 1: K-medoids hypothesis (cached by roster fingerprint) ──
  const fingerprint = buildRosterFingerprint(withCoords)
  let hypothesisResult: { assignments: Map<number, number> } | null = null

  if (cachedKMedoidsFingerprint === fingerprint && cachedKMedoidsResult && cachedKMedoidsClientOrder) {
    // Remap cached assignments from old indices to current indices
    const oldIdToDay = new Map<string, number>()
    for (const [oldIdx, day] of cachedKMedoidsResult.assignments) {
      if (oldIdx < cachedKMedoidsClientOrder.length) {
        oldIdToDay.set(cachedKMedoidsClientOrder[oldIdx], day)
      }
    }
    const remapped = new Map<number, number>()
    for (let i = 0; i < withCoords.length; i++) {
      const day = oldIdToDay.get(withCoords[i].client.id)
      if (day !== undefined) remapped.set(i, day)
    }
    hypothesisResult = { assignments: remapped }
  } else {
    // Fresh run — cache the result
    const syncResult = getKMedoidsHypothesis(withCoords, matrix, config)
    hypothesisResult = syncResult ?? null
    if (hypothesisResult) {
      cachedKMedoidsResult = hypothesisResult
      cachedKMedoidsFingerprint = fingerprint
      cachedKMedoidsClientOrder = withCoords.map(c => c.client.id)
    }
  }

  const idealAssignments = hypothesisResult?.assignments ?? null

  const misplaced = new Set<number>()
  let perfectWorldMinutes = 0

  if (idealAssignments) {
    for (let idx = 0; idx < withCoords.length; idx++) {
      const idealDay = idealAssignments.get(idx)
      if (idealDay !== undefined && idealDay !== withCoords[idx].currentDay) {
        misplaced.add(idx)
      }
    }

    // Perfect world: current route costs vs ideal (k-medoids) route costs
    let currentTotalMinutes = 0
    for (const [, route] of dayRoutes) {
      currentTotalMinutes += routeCost(route, matrix)
    }

    const idealDayGroups = new Map<number, number[]>()
    for (const [idx, day] of idealAssignments) {
      const group = idealDayGroups.get(day) || []
      group.push(idx)
      idealDayGroups.set(day, group)
    }
    let idealTotalMinutes = 0
    for (const [, indices] of idealDayGroups) {
      if (hasHome) {
        idealTotalMinutes += solveRouteFromDepot(homeIdx, indices, matrix).cost
      } else {
        idealTotalMinutes += solveRoute(indices, matrix).cost
      }
    }
    perfectWorldMinutes = Math.max(0, Math.round(currentTotalMinutes - idealTotalMinutes))
  }

  // ── Step 2: Validate moves independently ──
  // Check hypothesis-suggested clients first, then scan the rest
  const moves: ProposedMove[] = []
  const checkedIndices = new Set<number>()

  // Phase A: Check clients the hypothesis says are misplaced
  for (const idx of misplaced) {
    checkedIndices.add(idx)
    const { client, currentDay } = withCoords[idx]
    const weight = frequencyWeight(client.frequency, client.intervalWeeks)

    // Prefer the hypothesis day if it saves time
    const idealDay = idealAssignments!.get(idx)!
    const daySavings = computeDaySavingsFromMatrix(
      idx, currentDay, dayRoutes, matrix, config.maxJobsPerDay, dayGroupIndices, config.workingDays, hasHome, client.blockedDays,
    )

    if (daySavings.length === 0) continue

    const idealMatch = daySavings.find(d => d.day === idealDay)
    const best = idealMatch && idealMatch.savings > 0 ? idealMatch : daySavings[0]
    const weightedSavings = Math.round(best.savings * weight)
    if (weightedSavings < MIN_SAVINGS) continue

    const freqLabel = weight < 1 ? ` (${client.frequency})` : ''
    moves.push({
      clientId: client.id,
      clientName: client.name,
      currentDay,
      suggestedDay: best.day,
      savingsMinutes: weightedSavings,
      reason: `Saves ${weightedSavings} min/wk${freqLabel} on the ${DAYS_FULL[best.day]} route (${best.clientCount} client${best.clientCount !== 1 ? 's' : ''})`,
      status: 'to-ask',
      suggestedMessage: `Hey ${client.name.split(' ')[0]}, would ${DAYS_FULL[best.day]}s work for you going forward instead of ${DAYS_FULL[currentDay]}s? Trying to tighten up my route.`,
    })
  }

  // Phase B: Full scan — catch anything the hypothesis missed
  for (let idx = 0; idx < withCoords.length; idx++) {
    if (checkedIndices.has(idx)) continue
    const { client, currentDay } = withCoords[idx]
    const weight = frequencyWeight(client.frequency, client.intervalWeeks)
    const daySavings = computeDaySavingsFromMatrix(
      idx, currentDay, dayRoutes, matrix, config.maxJobsPerDay, dayGroupIndices, config.workingDays, hasHome, client.blockedDays,
    )

    if (daySavings.length === 0) continue
    const best = daySavings[0]
    const weightedSavings = Math.round(best.savings * weight)
    if (weightedSavings < MIN_SAVINGS) continue

    const freqLabel = weight < 1 ? ` (${client.frequency})` : ''
    moves.push({
      clientId: client.id,
      clientName: client.name,
      currentDay,
      suggestedDay: best.day,
      savingsMinutes: weightedSavings,
      reason: `Saves ${weightedSavings} min/wk${freqLabel} on the ${DAYS_FULL[best.day]} route (${best.clientCount} client${best.clientCount !== 1 ? 's' : ''})`,
      status: 'to-ask',
      suggestedMessage: `Hey ${client.name.split(' ')[0]}, would ${DAYS_FULL[best.day]}s work for you going forward instead of ${DAYS_FULL[currentDay]}s? Trying to tighten up my route.`,
    })
  }

  // ── Step 3: Swap pairs (recurrence-aware, capped per client) ──
  const allSwaps: SwapPair[] = []
  const moveClientIds = new Set(moves.map(m => m.clientId))

  for (let a = 0; a < withCoords.length; a++) {
    if (moveClientIds.has(withCoords[a].client.id)) continue

    for (let b = a + 1; b < withCoords.length; b++) {
      if (moveClientIds.has(withCoords[b].client.id)) continue
      if (withCoords[a].currentDay === withCoords[b].currentDay) continue
      if (config.workingDays && (!config.workingDays[withCoords[a].currentDay] || !config.workingDays[withCoords[b].currentDay])) continue
      // Respect blocked days — A can't go to B's day if blocked, and vice versa
      if (withCoords[a].client.blockedDays?.includes(withCoords[b].currentDay as DayOfWeek)) continue
      if (withCoords[b].client.blockedDays?.includes(withCoords[a].currentDay as DayOfWeek)) continue

      // Recurrence-aware capacity check: after the swap, each destination day
      // gains one client and loses one (net zero for the swapped pair).
      // But we still need to check that the destination can handle the incoming client.
      // Since swaps are 1-for-1 on different days, capacity stays balanced IF both days
      // currently have room. Check: destination day count (excluding the one leaving).
      const aDayCount = (dayGroupIndices.get(withCoords[a].currentDay) || []).length
      const bDayCount = (dayGroupIndices.get(withCoords[b].currentDay) || []).length
      // After swap: A goes to B's day (B leaves, A arrives → net same), B goes to A's day
      // But if B's day is already at max (before B leaves), we need: bDayCount - 1 + 1 = bDayCount ≤ max
      if (config.maxJobsPerDay > 0) {
        if (bDayCount > config.maxJobsPerDay) continue // A's destination over capacity
        if (aDayCount > config.maxJobsPerDay) continue // B's destination over capacity
      }

      const aRoute = dayRoutes.get(withCoords[a].currentDay) || []
      const bRoute = dayRoutes.get(withCoords[b].currentDay) || []

      // Each client is inserted into the other's route AFTER the other is removed
      const bRouteWithoutB = bRoute.filter(i => i !== b)
      const aRouteWithoutA = aRoute.filter(i => i !== a)

      const aRawSavings = removalSavings(a, aRoute, matrix) - cheapestInsertionCost(a, bRouteWithoutB, matrix, hasHome)
      const bRawSavings = removalSavings(b, bRoute, matrix) - cheapestInsertionCost(b, aRouteWithoutA, matrix, hasHome)

      if (aRawSavings < 0 || bRawSavings < 0) continue

      const clientA = withCoords[a].client
      const clientB = withCoords[b].client
      const aWeighted = Math.round(aRawSavings * frequencyWeight(clientA.frequency, clientA.intervalWeeks))
      const bWeighted = Math.round(bRawSavings * frequencyWeight(clientB.frequency, clientB.intervalWeeks))

      if (aWeighted + bWeighted < MIN_SAVINGS * 2) continue
      const total = aWeighted + bWeighted

      allSwaps.push({
        moveA: {
          clientId: clientA.id,
          clientName: clientA.name,
          currentDay: withCoords[a].currentDay,
          suggestedDay: withCoords[b].currentDay,
          savingsMinutes: aWeighted,
          reason: `Swap with ${clientB.name} — saves ${total} min/wk total`,
          status: 'to-ask',
          suggestedMessage: `Hey ${clientA.name.split(' ')[0]}, would ${DAYS_FULL[withCoords[b].currentDay]}s work for you instead of ${DAYS_FULL[withCoords[a].currentDay]}s?`,
        },
        moveB: {
          clientId: clientB.id,
          clientName: clientB.name,
          currentDay: withCoords[b].currentDay,
          suggestedDay: withCoords[a].currentDay,
          savingsMinutes: bWeighted,
          reason: `Swap with ${clientA.name} — saves ${total} min/wk total`,
          status: 'to-ask',
          suggestedMessage: `Hey ${clientB.name.split(' ')[0]}, would ${DAYS_FULL[withCoords[a].currentDay]}s work for you instead of ${DAYS_FULL[withCoords[b].currentDay]}s?`,
        },
        totalSavings: total,
      })
    }
  }

  // Sort by total savings, then cap at top 3 swaps per client
  allSwaps.sort((a, b) => b.totalSavings - a.totalSavings)
  const swaps: SwapPair[] = []
  const swapCountPerClient = new Map<string, number>()
  const MAX_SWAPS_PER_CLIENT = 3

  for (const swap of allSwaps) {
    const countA = swapCountPerClient.get(swap.moveA.clientId) ?? 0
    const countB = swapCountPerClient.get(swap.moveB.clientId) ?? 0
    if (countA >= MAX_SWAPS_PER_CLIENT || countB >= MAX_SWAPS_PER_CLIENT) continue

    swaps.push(swap)
    swapCountPerClient.set(swap.moveA.clientId, countA + 1)
    swapCountPerClient.set(swap.moveB.clientId, countB + 1)
  }

  moves.sort((a, b) => b.savingsMinutes - a.savingsMinutes)

  const totalPotentialMinutes = moves.reduce((s, m) => s + m.savingsMinutes, 0)
    + swaps.reduce((s, sw) => s + sw.totalSavings, 0)

  // If hypothesis didn't run, estimate perfect world as ~30% more than local
  if (!idealAssignments) {
    perfectWorldMinutes = Math.round(totalPotentialMinutes * 1.3)
  }

  return { moves, swaps, totalPotentialMinutes, perfectWorldMinutes }
}


/**
 * Generate transition moves by diffing perfect schedule against current.
 * Returns moves sorted by savings (biggest first).
 * Clients already on their perfect day are excluded.
 */
export function buildTransitionMoves(
  changes: PerfectScheduleResult['changes'],
  clients: Client[],
  targetRotations?: Map<string, number>,
  recurrenceMap?: Map<string, string>,
): TransitionMove[] {
  // Build moves and detect swap pairs
  // A swap pair: Client A goes fromDay→toDay, Client B goes toDay→fromDay
  // For biweekly clients, swaps must be on the same rotation (same weeks)
  const moves: TransitionMove[] = []
  const paired = new Set<string>()

  // Helper: get frequency and rotation for a client
  const getFreq = (id: string) => {
    const override = recurrenceMap?.get(id)
    if (override) return override as Client['frequency']
    return clients.find(c => c.id === id)?.frequency ?? 'weekly'
  }
  const getTargetRot = (id: string): 0 | 1 => (targetRotations?.get(id) ?? 0) as 0 | 1
  // Current rotation: infer from client's startDate or default 0
  const getCurrentRot = (_id: string): 0 | 1 => {
    // If the perfect schedule assigns a rotation, current is whatever they had before
    // For simplicity, default to 0 — the perfect schedule's rotation is what matters
    return 0 as 0 | 1
  }

  // Rotation-aware label: "Mon" for weekly, "Mon-A" or "Mon-B" for biweekly
  const dayLabel = (day: number, freq: string, rot: 0 | 1) => {
    if (freq === 'biweekly') return `${DAYS_FULL[day]}-${rot === 0 ? 'A' : 'B'}`
    return DAYS_FULL[day]
  }

  for (let i = 0; i < changes.length; i++) {
    if (paired.has(changes[i].clientId)) continue
    const a = changes[i]
    const aFreq = getFreq(a.clientId)
    const aTargetRot = getTargetRot(a.clientId)

    // Look for a swap partner — days must cross AND rotations must be compatible
    // Two biweekly clients can only swap if they're on the same rotation (same weeks)
    let partnerId: string | null = null
    for (let j = i + 1; j < changes.length; j++) {
      if (paired.has(changes[j].clientId)) continue
      const b = changes[j]
      if (a.toDay !== b.fromDay || a.fromDay !== b.toDay) continue

      const bFreq = getFreq(b.clientId)
      const bTargetRot = getTargetRot(b.clientId)

      // Both weekly: always compatible
      // Both biweekly: must be same rotation (occupy same weeks)
      // Mixed weekly/biweekly: weekly covers all weeks, so compatible
      if (aFreq === 'biweekly' && bFreq === 'biweekly' && aTargetRot !== bTargetRot) continue

      partnerId = b.clientId
      paired.add(a.clientId)
      paired.add(b.clientId)
      break
    }

    const client = clients.find(c => c.id === a.clientId)
    if (!client) continue
    const partner = partnerId ? clients.find(c => c.id === partnerId) : null
    const swapNote = partner ? ` (swap with ${partner.name})` : ''
    const aCurrentRot = getCurrentRot(a.clientId)
    const fromLabel = dayLabel(a.fromDay, aFreq, aCurrentRot)
    const toLabel = dayLabel(a.toDay, aFreq, aTargetRot)

    moves.push({
      clientId: a.clientId,
      clientName: a.clientName,
      currentDay: a.fromDay,
      suggestedDay: a.toDay,
      savingsMinutes: 0,
      reason: `Move from ${fromLabel} to ${toLabel}${swapNote}`,
      status: 'to-ask',
      suggestedMessage: `Hey ${a.clientName.split(' ')[0]}, would ${DAYS_FULL[a.toDay]}s work for you going forward instead of ${DAYS_FULL[a.fromDay]}s? Trying to tighten up my route.`,
      locked: false,
      originalDay: a.fromDay,
      iteration: 0,
      swapPartnerClientId: partnerId,
      frequency: aFreq,
      currentRotation: aCurrentRot,
      targetRotation: aTargetRot,
    })

    // Add the partner move right after
    if (partnerId) {
      const partnerChange = changes.find(c => c.clientId === partnerId)!
      const pFreq = getFreq(partnerId)
      const pCurrentRot = getCurrentRot(partnerId)
      const pTargetRot = getTargetRot(partnerId)
      const pFromLabel = dayLabel(partnerChange.fromDay, pFreq, pCurrentRot)
      const pToLabel = dayLabel(partnerChange.toDay, pFreq, pTargetRot)

      moves.push({
        clientId: partnerChange.clientId,
        clientName: partnerChange.clientName,
        currentDay: partnerChange.fromDay,
        suggestedDay: partnerChange.toDay,
        savingsMinutes: 0,
        reason: `Move from ${pFromLabel} to ${pToLabel} (swap with ${a.clientName})`,
        status: 'to-ask',
        suggestedMessage: `Hey ${partnerChange.clientName.split(' ')[0]}, would ${DAYS_FULL[partnerChange.toDay]}s work for you going forward instead of ${DAYS_FULL[partnerChange.fromDay]}s? Trying to tighten up my route.`,
        locked: false,
        originalDay: partnerChange.fromDay,
        iteration: 0,
        swapPartnerClientId: a.clientId,
        frequency: pFreq,
        currentRotation: pCurrentRot,
        targetRotation: pTargetRot,
      })
    }
  }
  return moves
}

/**
 * Re-optimize transition after a rejection.
 *
 * Locked clients (confirmed on new day OR rejected on current day) become
 * fixed constraints — they stay fixed while remaining clients are re-solved.
 *
 * Returns all moves: locked moves pass through unchanged, unconfirmed
 * clients get fresh suggestions from the new clustering solution.
 */
export async function reoptimizeTransition(
  allClients: Client[],
  currentMoves: TransitionMove[],
  clientDayMap: Map<string, number>,
  config: { maxJobsPerDay: number; workingDays: boolean[] },
  homeCoords: { lat: number; lng: number },
  iteration: number,
  durationMap?: Map<string, number>,
  recurrenceMap?: Map<string, string>,
): Promise<TransitionMove[]> {
  const lockedMoves = currentMoves.filter(m => m.locked)
  const lockedIds = new Set(lockedMoves.map(m => m.clientId))

  // Build locked constraints for clustering:
  // - Confirmed: locked on suggestedDay (already moved there)
  // - Can't-move: locked on currentDay (stayed put)
  const lockedClients = new Map<string, { day: number; rotation: 0 | 1 }>()
  for (const m of lockedMoves) {
    if (m.status === 'confirmed') {
      lockedClients.set(m.clientId, { day: m.suggestedDay, rotation: m.targetRotation })
    } else {
      lockedClients.set(m.clientId, { day: m.currentDay, rotation: m.currentRotation })
    }
  }

  // Build effective day map: confirmed clients are on their new day,
  // everyone else is on their current schedule day
  const effectiveDayMap = new Map<string, number>(clientDayMap)
  for (const m of lockedMoves) {
    if (m.status === 'confirmed') {
      effectiveDayMap.set(m.clientId, m.suggestedDay)
    }
  }

  // All placed clients go into the clustering solve
  const placedClients = allClients.filter(c => effectiveDayMap.has(c.id))
  if (placedClients.length < 2) return lockedMoves

  const clientsWithDays = placedClients.map(c => ({
    client: c,
    currentDay: effectiveDayMap.get(c.id)!,
  }))

  // Re-run clustering with locked constraints
  const result = await generatePerfectSchedule(
    clientsWithDays, config, homeCoords, durationMap, recurrenceMap, lockedClients,
  )

  // Build new TransitionMoves from fresh clustering result (unlocked clients only)
  const newMoves = buildTransitionMoves(
    result.changes.filter(c => !lockedIds.has(c.clientId)),
    allClients,
    result.rotations,
    recurrenceMap,
  ).map(m => ({ ...m, iteration }))

  return [...lockedMoves, ...newMoves]
}

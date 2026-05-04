/**
 * Diagnostic Report Emitter
 *
 * Reads a PerfectScheduleResult + its _context and produces the structured
 * geometric summary the LLM needs (centroids, tightness, outliers, drive
 * totals). The LLM cannot compute these from raw lat/lng — it will guess,
 * and the guess will be wrong.
 *
 * Pure function. No I/O, no mutation. Safe to call many times.
 */

import type { DayOfWeek } from '../../types'
import type { PerfectScheduleResult } from '../scheduleBuilder'
import type {
  ClusterDiagnostic,
  DiagnosticReport,
  OutlierJob,
} from './types'
import { requiredHorizonWeeks } from './recurrence'

const DEFAULT_OUTLIER_LIMIT = 8

export type ComputeDiagnosticsOptions = {
  scheduleId: string
  /** How many outliers to surface to the LLM. Default 8. */
  outlierLimit?: number
  /** Override horizon (otherwise auto-detected from custom intervals, min 4). */
  horizonWeeks?: number
}

export function computeDiagnostics(
  schedule: PerfectScheduleResult,
  opts: ComputeDiagnosticsOptions,
): DiagnosticReport {
  const ctx = schedule._context
  const outlierLimit = opts.outlierLimit ?? DEFAULT_OUTLIER_LIMIT

  const horizonWeeks = opts.horizonWeeks ?? requiredHorizonWeeks(
    ctx.clientIntervalWeeks.values(),
  )

  const matrixIdx = (clientId: string): number => {
    const i = ctx.clientIds.indexOf(clientId)
    return i === -1 ? -1 : i + 1
  }

  // ── Bucket clients into (day, rotation) clusters ──
  // Biweekly clients land in their own rotation bucket; weekly/monthly/custom
  // share a single 'all' bucket per day. One-time clients are skipped here —
  // they're treated as ephemeral and don't drive geometric reasoning.
  type BucketKey = string
  const bucketKey = (day: number, rotation: 0 | 1 | 'all'): BucketKey =>
    `${day}:${rotation}`

  const buckets = new Map<BucketKey, { day: DayOfWeek; rotation: 0 | 1 | 'all'; clientIds: string[] }>()

  for (const [clientId, day] of schedule.assignments) {
    if (day < 0) continue
    const freq = ctx.clientFrequencies.get(clientId)
    if (!freq || freq === 'one-time') continue
    const rotation: 0 | 1 | 'all' =
      freq === 'biweekly' ? ((schedule.rotations.get(clientId) ?? 0) as 0 | 1) : 'all'
    const key = bucketKey(day, rotation)
    const existing = buckets.get(key)
    if (existing) existing.clientIds.push(clientId)
    else buckets.set(key, { day: day as DayOfWeek, rotation, clientIds: [clientId] })
  }

  // ── Per-bucket geometry ──
  const clusters: ClusterDiagnostic[] = []
  for (const bucket of buckets.values()) {
    const { day, rotation, clientIds } = bucket
    if (clientIds.length === 0) continue

    let sumLat = 0, sumLng = 0
    for (const id of clientIds) {
      const c = ctx.clientCoords.get(id)
      if (!c) continue
      sumLat += c.lat
      sumLng += c.lng
    }
    const centroidLat = sumLat / clientIds.length
    const centroidLng = sumLng / clientIds.length

    // Tightness = average pairwise drive minutes. Lower = denser cluster.
    let pairSum = 0
    let pairs = 0
    for (let i = 0; i < clientIds.length; i++) {
      for (let j = i + 1; j < clientIds.length; j++) {
        const ai = matrixIdx(clientIds[i])
        const bi = matrixIdx(clientIds[j])
        if (ai < 0 || bi < 0) continue
        pairSum += ctx.matrixMinutes[ai][bi]
        pairs++
      }
    }
    const tightnessMinutes = pairs > 0 ? pairSum / pairs : 0

    // Drive minutes for this bucket = sum of week-instances of this cluster
    // averaged per week. Pull from cellDriveMinutes when possible: for weekly
    // cluster on day D, every grid week shows the same total; for biweekly
    // we read the matching rotation's grid cell.
    let driveMinutes = 0
    let cellsCounted = 0
    for (const [k, cells] of schedule.grid) {
      const [wStr, dStr] = k.split('-')
      if (Number(dStr) !== day) continue
      // Match the rotation if biweekly. For 'all' buckets we want the cell
      // composed only of weekly/monthly/custom — but cellDriveMinutes is for
      // the WHOLE cell (all clients on that day that week). So we approximate
      // by using only weeks where this bucket's clients are present and the
      // cell composition is dominated by them. For now, use the cell total —
      // the LLM treats this as a guideline, not a strict cost.
      const cellHasMember = cells.some(c => clientIds.includes(c.clientId))
      if (!cellHasMember) continue
      const cellMin = schedule.cellDriveMinutes.get(k) ?? 0
      driveMinutes += cellMin
      cellsCounted++
      // Only count one representative cell per rotation to avoid double counting
      if (rotation === 'all' || rotation === 0) {
        if (Number(wStr) === 0) break
      } else {
        if (Number(wStr) === 1) break
      }
    }
    if (cellsCounted === 0) driveMinutes = 0

    clusters.push({
      day,
      rotation,
      centroidLat,
      centroidLng,
      tightnessMinutes: Math.round(tightnessMinutes * 10) / 10,
      driveMinutes: Math.round(driveMinutes),
      jobCount: clientIds.length,
      clientIds,
    })
  }

  // ── Outlier detection ──
  // For each placed client, compute drive minutes from THIS client's location
  // to its bucket's centroid (proxied by avg pairwise distance to bucket
  // members). Flag the worst offenders.
  const outlierCandidates: OutlierJob[] = []
  for (const cluster of clusters) {
    if (cluster.clientIds.length < 2) continue
    for (const id of cluster.clientIds) {
      const ai = matrixIdx(id)
      if (ai < 0) continue
      let sum = 0
      let n = 0
      for (const other of cluster.clientIds) {
        if (other === id) continue
        const bi = matrixIdx(other)
        if (bi < 0) continue
        sum += ctx.matrixMinutes[ai][bi]
        n++
      }
      const isolation = n > 0 ? sum / n : 0

      // Find the nearest non-current cluster's average distance to inform reason text
      let bestAlt: { day: DayOfWeek; dist: number } | null = null
      for (const alt of clusters) {
        if (alt.day === cluster.day && alt.rotation === cluster.rotation) continue
        let altSum = 0
        let altN = 0
        for (const other of alt.clientIds) {
          const bi = matrixIdx(other)
          if (bi < 0) continue
          altSum += ctx.matrixMinutes[ai][bi]
          altN++
        }
        const altAvg = altN > 0 ? altSum / altN : Infinity
        if (!bestAlt || altAvg < bestAlt.dist) {
          bestAlt = { day: alt.day, dist: altAvg }
        }
      }

      // Only flag if there's a meaningfully closer alternative (>= 2 min better).
      const meaningfulAlternative = bestAlt && bestAlt.dist + 2 < isolation
      if (!meaningfulAlternative) continue

      const reason = bestAlt
        ? `${Math.round(isolation)} min from current day's centroid; nearest alt cluster (day ${bestAlt.day}) avg ${Math.round(bestAlt.dist)} min.`
        : `${Math.round(isolation)} min from current day's centroid.`

      outlierCandidates.push({
        clientId: id,
        clientName: ctx.clientNames.get(id) ?? id,
        currentDay: cluster.day,
        currentRotation: cluster.rotation === 'all' ? 0 : cluster.rotation,
        isolationScore: Math.round(isolation * 10) / 10,
        reason,
      })
    }
  }

  outlierCandidates.sort((a, b) => b.isolationScore - a.isolationScore)
  const outliers = outlierCandidates.slice(0, outlierLimit)

  // ── Benched roster ──
  const benched = schedule.benched.map(id => ({
    clientId: id,
    clientName: ctx.clientNames.get(id) ?? id,
    reason: 'No working day with capacity for this client under current constraints.',
  }))

  return {
    scheduleId: opts.scheduleId,
    generatedAt: new Date().toISOString(),
    totalDriveMinutesPerWeek: schedule.totalDriveMinutes,
    clusters,
    outliers,
    benched,
    horizonWeeks,
  }
}

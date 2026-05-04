/**
 * Routing APIs — ported from mobile distanceUtils.ts
 *
 * ORS Matrix API: real drive times between all clients (N×N matrix in seconds)
 * VROOM VRP Solver: optimal day assignments given the matrix
 *
 * Falls back to Haversine × 1.4 if ORS fails.
 */

const VROOM_URL = 'https://pip-vroom.fly.dev/'
const CIRCUITY_FACTOR = 1.4

// ── Haversine fallback ──

function haversineDistMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3959
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function buildFallbackMatrixSeconds(coords: Array<{ lat: number; lng: number }>): number[][] {
  const n = coords.length
  const matrix: number[][] = []
  for (let i = 0; i < n; i++) {
    matrix[i] = []
    for (let j = 0; j < n; j++) {
      if (i === j) { matrix[i][j] = 0; continue }
      const miles = haversineDistMiles(coords[i].lat, coords[i].lng, coords[j].lat, coords[j].lng) * CIRCUITY_FACTOR
      matrix[i][j] = Math.round(miles * 2.8 * 60 + 120) // seconds
    }
  }
  return matrix
}

// ── ORS Matrix API ──

// ORS free tier: max 3500 sources × destinations per call.
// For N locations requesting all-to-all, that's N². Limit ~59.
// Batching: request BATCH_SIZE source rows at a time, stitch together.
const ORS_BATCH_SIZE = 30 // 30 sources × 100 destinations = 3000 < 3500
const ORS_BATCH_THRESHOLD = 50 // only batch when N > this

/** Sanitize one row of ORS durations for VROOM (non-negative finite integers). */
function sanitizeRow(
  row: any[],
  sourceIdx: number,
  coordinates: Array<{ lat: number; lng: number }>,
): { sanitized: number[]; fixedCount: number } {
  let fixedCount = 0
  const sanitized = row.map((val: any, j: number) => {
    if (sourceIdx === j) return 0
    if (typeof val === 'number' && isFinite(val) && val >= 0) return Math.round(val)
    fixedCount++
    const miles = haversineDistMiles(coordinates[sourceIdx].lat, coordinates[sourceIdx].lng, coordinates[j].lat, coordinates[j].lng)
    return Math.round(miles * CIRCUITY_FACTOR * 2.8 * 60 + 120)
  })
  return { sanitized, fixedCount }
}

/** Fetch a partial matrix from ORS for the given source indices. */
async function fetchORSBatch(
  locations: number[][],
  sources: number[],
): Promise<number[][]> {
  const response = await fetch('/api/ors-matrix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations, sources }),
  })
  if (!response.ok) throw new Error(`ORS proxy error: ${response.status}`)
  const data = await response.json()
  if (!data.durations) throw new Error('Invalid ORS Matrix response')
  return data.durations
}

/**
 * Get NxN drive time matrix in SECONDS from ORS.
 * Batches into multiple calls when N > 50 to stay under ORS's 3500-cell limit.
 * Sanitizes for VROOM: all non-negative finite integers, Haversine fallback for bad entries.
 */
export async function getORSMatrixSeconds(
  coordinates: Array<{ lat: number; lng: number }>,
): Promise<number[][]> {
  if (coordinates.length === 0) return []
  if (coordinates.length === 1) return [[0]]

  const n = coordinates.length
  const locations = coordinates.map(c => [c.lng, c.lat])

  try {
    let rawRows: number[][]

    if (n <= ORS_BATCH_THRESHOLD) {
      // Small enough for a single call
      rawRows = await fetchORSBatch(locations, [])
    } else {
      // Batch: split source indices into groups of ORS_BATCH_SIZE
      rawRows = new Array(n)
      const batches: number[][] = []
      for (let start = 0; start < n; start += ORS_BATCH_SIZE) {
        batches.push(Array.from({ length: Math.min(ORS_BATCH_SIZE, n - start) }, (_, i) => start + i))
      }

      console.log(`ORS matrix: batching ${n} locations into ${batches.length} calls`)

      for (const sourceBatch of batches) {
        const batchRows = await fetchORSBatch(locations, sourceBatch)
        for (let i = 0; i < sourceBatch.length; i++) {
          rawRows[sourceBatch[i]] = batchRows[i]
        }
      }
    }

    // Sanitize all rows
    let totalFixed = 0
    const sanitized: number[][] = rawRows.map((row, i) => {
      const result = sanitizeRow(row, i, coordinates)
      totalFixed += result.fixedCount
      return result.sanitized
    })

    if (totalFixed > 0) console.warn(`ORS matrix: fixed ${totalFixed} invalid entries with Haversine fallback`)
    return sanitized
  } catch (error) {
    console.warn('ORS Matrix failed, using Haversine fallback:', error)
    return buildFallbackMatrixSeconds(coordinates)
  }
}

/**
 * Get NxN drive time matrix in MINUTES (convenience wrapper for the optimizer).
 */
export async function getDriveTimeMatrix(
  coordinates: Array<{ lat: number; lng: number }>,
): Promise<number[][]> {
  const seconds = await getORSMatrixSeconds(coordinates)
  return seconds.map(row => row.map(s => s / 60))
}

// ── VROOM VRP Solver ──

export interface VroomVehicle {
  id: number
  start_index: number
  end_index?: number
  max_tasks?: number
  time_window?: [number, number]
}

export interface VroomJob {
  id: number
  location_index: number
  service?: number
}

export interface VroomStep {
  type: 'start' | 'job' | 'end'
  id?: number
  location_index?: number
  arrival?: number
  duration?: number
}

export interface VroomRoute {
  vehicle: number
  steps: VroomStep[]
  duration: number
  cost: number
}

export interface VroomResponse {
  code: number
  routes: VroomRoute[]
  unassigned: { id: number }[]
  summary: { cost: number; unassigned: number; duration: number }
}

/**
 * Solve Vehicle Routing Problem using self-hosted VROOM at pip-vroom.fly.dev.
 * Accepts pre-computed ORS duration matrix in SECONDS.
 */
export async function solveVroom(
  vehicles: VroomVehicle[],
  jobs: VroomJob[],
  durationMatrix: number[][],
): Promise<VroomResponse> {
  const payload = {
    vehicles,
    jobs,
    matrices: { car: { durations: durationMatrix } },
  }

  const res = await fetch(VROOM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`VROOM error ${res.status}: ${body}`)
  }

  return res.json()
}

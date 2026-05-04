/**
 * Serialization helpers for PerfectScheduleResult ↔ JSON.
 *
 * The engine produces Maps (assignments, rotations, grid, etc.) which JSON
 * doesn't support. We convert to array-of-pairs for transport across the
 * web → /api boundary, then rebuild on the server.
 *
 * Pure data — no behavior changes between the wire format and the runtime
 * format. Round-tripping is lossless.
 */

import type { Frequency, GridCell } from '../../types'
import type { PerfectScheduleResult, ScheduleContext } from '../scheduleBuilder'

export type SerializedScheduleContext = {
  clientIds: string[]
  matrixMinutes: number[][]
  homeCoords: { lat: number; lng: number }
  workingDays: boolean[]
  maxJobsPerDay: number
  recurrenceMap?: Array<[string, string]>
  durationMap?: Array<[string, number]>
  clientCoords: Array<[string, { lat: number; lng: number }]>
  clientNames: Array<[string, string]>
  clientBlockedDays: Array<[string, number[]]>
  clientFrequencies: Array<[string, Frequency]>
  clientIntervalWeeks: Array<[string, number | undefined]>
}

export type SerializedPerfectSchedule = {
  assignments: Array<[string, number]>
  rotations: Array<[string, number]>
  routesByDay: Array<[number, string[]]>
  grid: Array<[string, GridCell[]]>
  totalDriveMinutes: number
  currentDriveMinutes: number
  changes: PerfectScheduleResult['changes']
  benched: string[]
  legTimes: Array<[string, number[]]>
  cellDriveMinutes: Array<[string, number]>
  _context: SerializedScheduleContext
}

export function serializeSchedule(s: PerfectScheduleResult): SerializedPerfectSchedule {
  return {
    assignments: [...s.assignments.entries()],
    rotations: [...s.rotations.entries()],
    routesByDay: [...s.routesByDay.entries()],
    grid: [...s.grid.entries()],
    totalDriveMinutes: s.totalDriveMinutes,
    currentDriveMinutes: s.currentDriveMinutes,
    changes: s.changes,
    benched: s.benched,
    legTimes: [...s.legTimes.entries()],
    cellDriveMinutes: [...s.cellDriveMinutes.entries()],
    _context: serializeContext(s._context),
  }
}

export function deserializeSchedule(s: SerializedPerfectSchedule): PerfectScheduleResult {
  return {
    assignments: new Map(s.assignments),
    rotations: new Map(s.rotations),
    routesByDay: new Map(s.routesByDay),
    grid: new Map(s.grid),
    totalDriveMinutes: s.totalDriveMinutes,
    currentDriveMinutes: s.currentDriveMinutes,
    changes: s.changes,
    benched: s.benched,
    legTimes: new Map(s.legTimes),
    cellDriveMinutes: new Map(s.cellDriveMinutes),
    _context: deserializeContext(s._context),
  }
}

function serializeContext(c: ScheduleContext): SerializedScheduleContext {
  return {
    clientIds: c.clientIds,
    matrixMinutes: c.matrixMinutes,
    homeCoords: c.homeCoords,
    workingDays: c.workingDays,
    maxJobsPerDay: c.maxJobsPerDay,
    recurrenceMap: c.recurrenceMap ? [...c.recurrenceMap.entries()] : undefined,
    durationMap: c.durationMap ? [...c.durationMap.entries()] : undefined,
    clientCoords: [...c.clientCoords.entries()],
    clientNames: [...c.clientNames.entries()],
    clientBlockedDays: [...c.clientBlockedDays.entries()],
    clientFrequencies: [...c.clientFrequencies.entries()],
    clientIntervalWeeks: [...c.clientIntervalWeeks.entries()],
  }
}

function deserializeContext(c: SerializedScheduleContext): ScheduleContext {
  return {
    clientIds: c.clientIds,
    matrixMinutes: c.matrixMinutes,
    homeCoords: c.homeCoords,
    workingDays: c.workingDays,
    maxJobsPerDay: c.maxJobsPerDay,
    recurrenceMap: c.recurrenceMap ? new Map(c.recurrenceMap) : undefined,
    durationMap: c.durationMap ? new Map(c.durationMap) : undefined,
    clientCoords: new Map(c.clientCoords),
    clientNames: new Map(c.clientNames),
    clientBlockedDays: new Map(c.clientBlockedDays),
    clientFrequencies: new Map(c.clientFrequencies),
    clientIntervalWeeks: new Map(c.clientIntervalWeeks),
  }
}

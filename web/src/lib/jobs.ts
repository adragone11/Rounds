/**
 * Jobs — read-only layer for the mobile app's jobs table.
 *
 * The mobile app treats the calendar as a set of Jobs. Web currently treats it
 * as Clients + local placements + client.frequency. This file lets web READ
 * mobile-created jobs (including recurring templates) and render them on the
 * calendar alongside web placements. No writes yet — this is a sync preview.
 *
 * Shape mirrors PIp/src/types/index.ts and PIp/src/services/recurringService.ts.
 */

import { fromMobileTime } from './time'

export type RecurringType = 'one-time' | 'weekly' | 'bi-weekly' | 'monthly' | 'custom'
export type RecurrenceUnit = 'days' | 'weeks' | 'months'

export type Job = {
  id: string
  clientId: string | null
  title: string | null
  date: string               // "YYYY-MM-DD"
  startTime: string | null
  endTime: string | null
  duration: number           // hours
  price: number
  serviceType: string | null

  recurring: RecurringType
  recurringEndDate: string | null
  recurrenceAnchorDate: string | null
  recurrenceInterval: number | null
  recurrenceUnit: RecurrenceUnit | null

  isRecurring: boolean
  templateId: string | null
  isTemplate: boolean
  originalOccurrenceDate: string | null

  completed: boolean
  cancelled: boolean
  deleted: boolean
  paid: boolean
  actualDuration: number | null

  notes: string | null
  checklist: { text: string; done: boolean }[] | null

  avatarColor: string | null
  avatarIcon: string | null
}

// Cancellation is a render-side override on completed/paid/price. We keep
// the underlying flags intact on the row so Restore returns to prior state,
// but every UI surface and every earnings tally must read through these
// helpers so a cancelled job reads as cancelled everywhere.
//
// Mobile mirrors the same rule (project_cancel_overrides_complete in memory).
export function isEffectivelyComplete(j: Pick<Job, 'completed' | 'cancelled'>): boolean {
  return !j.cancelled && j.completed
}
export function isEffectivelyPaid(j: Pick<Job, 'paid' | 'cancelled'>): boolean {
  return !j.cancelled && j.paid
}
/** Price contribution to earnings tallies. Cancelled jobs contribute 0. */
export function countablePrice(j: Pick<Job, 'price' | 'cancelled'>): number {
  return j.cancelled ? 0 : (j.price ?? 0)
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseLocalDate(s: string): Date {
  return new Date(s + 'T00:00:00')
}

export function mapJobFromDb(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    clientId: (row.client_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    date: row.date as string,
    // Mobile writes times as "h:mm a" ("9:00 AM"); normalize to "HH:mm" so
    // web's internal helpers and <input type="time"> can consume them.
    startTime: fromMobileTime(row.start_time as string | null),
    endTime: fromMobileTime(row.end_time as string | null),
    duration: Number(row.duration ?? 0),
    price: Number(row.price ?? 0),
    serviceType: (row.service_type as string | null) ?? null,
    recurring: ((row.recurring as RecurringType) ?? 'one-time'),
    recurringEndDate: (row.recurring_end_date as string | null) ?? null,
    recurrenceAnchorDate: (row.recurrence_anchor_date as string | null) ?? null,
    recurrenceInterval: (row.recurrence_interval as number | null) ?? null,
    recurrenceUnit: (row.recurrence_unit as RecurrenceUnit | null) ?? null,
    isRecurring: Boolean(row.is_recurring ?? false),
    templateId: (row.template_id as string | null) ?? null,
    isTemplate: Boolean(row.is_template ?? false),
    originalOccurrenceDate: (row.original_occurrence_date as string | null) ?? null,
    completed: Boolean(row.completed ?? false),
    cancelled: Boolean(row.cancelled ?? false),
    deleted: Boolean(row.deleted ?? false),
    paid: Boolean(row.paid ?? false),
    actualDuration: (row.actual_duration as number | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    checklist: (row.checklist as Job['checklist']) ?? null,
    avatarColor: (row.avatar_color as string | null) ?? null,
    avatarIcon: (row.avatar_icon as string | null) ?? null,
  }
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d)
  c.setDate(c.getDate() + n)
  return c
}
function addWeeks(d: Date, n: number): Date {
  return addDays(d, n * 7)
}
function addMonths(d: Date, n: number): Date {
  const c = new Date(d)
  c.setMonth(c.getMonth() + n)
  return c
}

function nextOccurrence(
  d: Date,
  pattern: RecurringType,
  interval: number | null,
  unit: RecurrenceUnit | null,
): Date {
  if (pattern === 'custom' && interval && unit) {
    if (unit === 'days') return addDays(d, interval)
    if (unit === 'weeks') return addWeeks(d, interval)
    if (unit === 'months') return addMonths(d, interval)
  }
  if (pattern === 'weekly') return addWeeks(d, 1)
  if (pattern === 'bi-weekly') return addWeeks(d, 2)
  // "Monthly" = every 4 weeks (28 days), NOT calendar addMonths.
  // Locks the weekday — a Saturday monthly stays Saturday.
  // Mobile still uses addMonths and will drift; align mobile next.
  if (pattern === 'monthly') return addWeeks(d, 4)
  return d
}

/**
 * The first occurrence of a recurring template that falls on or after `from`.
 * Returns null if the template's recurrence_end_date cuts off before `from`,
 * or if `template` isn't recurring at all.
 *
 * Used by Reports' Clients list to compute "next visit" for clients whose
 * upcoming recurrences are still virtual (not yet materialized into rows).
 * Without this, a weekly client with no past visits in the current month
 * shows "—" even though their next visit is days away.
 */
export function nextOccurrenceOnOrAfter(template: Job, from: Date): string | null {
  if (!template.isRecurring || template.recurring === 'one-time') return null
  const anchor = parseLocalDate(template.recurrenceAnchorDate ?? template.date)
  const endDate = template.recurringEndDate ? parseLocalDate(template.recurringEndDate) : null
  let cur = new Date(anchor)
  let guard = 0
  // Walk forward until we land on/after `from`. Guard against pathological
  // intervals (matches the cap used by occurrencesInMonth).
  while (cur < from && guard++ < 1000) {
    const n = nextOccurrence(cur, template.recurring, template.recurrenceInterval, template.recurrenceUnit)
    if (n.getTime() === cur.getTime()) return null
    cur = n
  }
  if (endDate && cur > endDate) return null
  return fmt(cur)
}

/**
 * All occurrences of a template within [monthStart, monthEnd].
 * Caps iteration at 500 steps as a safety net against pathological intervals.
 */
export function occurrencesInMonth(template: Job, year: number, month: number): string[] {
  if (!template.isRecurring || template.recurring === 'one-time') return []
  const monthStart = new Date(year, month, 1)
  const monthEnd = new Date(year, month + 1, 0)
  const anchor = parseLocalDate(template.recurrenceAnchorDate ?? template.date)
  if (anchor > monthEnd) return []
  const endDate = template.recurringEndDate ? parseLocalDate(template.recurringEndDate) : null

  const out: string[] = []
  let cur = new Date(anchor)
  let guard = 0
  while (cur < monthStart && guard++ < 500) {
    const n = nextOccurrence(cur, template.recurring, template.recurrenceInterval, template.recurrenceUnit)
    if (n.getTime() === cur.getTime()) return out
    cur = n
  }
  while (cur <= monthEnd && guard++ < 500) {
    if (endDate && cur > endDate) break
    out.push(fmt(cur))
    const n = nextOccurrence(cur, template.recurring, template.recurrenceInterval, template.recurrenceUnit)
    if (n.getTime() === cur.getTime()) break
    cur = n
  }
  return out
}

/**
 * Expand raw `jobs` rows into a date → Job[] map for a given month.
 * Rules:
 *  - Templates contribute one virtual instance per occurrence in-month.
 *  - Non-template rows contribute themselves at `date`.
 *  - A stored instance (with `templateId` + `originalOccurrenceDate`) masks the
 *    virtual template occurrence for that date so we don't double-render.
 *  - Soft-deleted (deleted=true) rows are skipped.
 */
export function jobsForMonth(jobs: Job[], year: number, month: number): Record<string, Job[]> {
  const monthStart = new Date(year, month, 1)
  const monthEnd = new Date(year, month + 1, 0)

  const result: Record<string, Job[]> = {}
  const push = (iso: string, j: Job) => {
    if (!result[iso]) result[iso] = []
    result[iso].push(j)
  }
  const inMonth = (iso: string) => {
    const d = parseLocalDate(iso)
    return d >= monthStart && d <= monthEnd
  }

  const templates = jobs.filter(j => j.isTemplate && j.isRecurring && !j.deleted)
  // Collapse instance dups before masking/rendering. A duplicate row can sneak
  // in if mobile and web both materialize the same virtual, or if a
  // mutation races itself. Without this dedupe the mask still hides the
  // template, but both instance rows render side-by-side as ghost twins.
  const instances = dedupeJobs(jobs.filter(j => !j.isTemplate && !j.deleted))

  // Build mask: dates already stored as instances keyed by templateId.
  const storedByTemplate = new Map<string, Set<string>>()
  for (const inst of instances) {
    if (!inst.templateId) continue
    const key = inst.originalOccurrenceDate ?? inst.date
    const set = storedByTemplate.get(inst.templateId) ?? new Set<string>()
    set.add(key)
    storedByTemplate.set(inst.templateId, set)
  }

  for (const t of templates) {
    const masked = storedByTemplate.get(t.id)
    for (const iso of occurrencesInMonth(t, year, month)) {
      if (masked?.has(iso)) continue
      // Virtuals carry templateId → the real template row, so the action
      // panel can detect them and materialize a per-occurrence instance
      // before mutating. Without this, mutations fell through to the
      // template and marked every future occurrence.
      push(iso, { ...t, date: iso, originalOccurrenceDate: iso, isTemplate: false, templateId: t.id })
    }
  }
  for (const inst of instances) {
    if (inMonth(inst.date)) push(inst.date, inst)
  }

  return result
}

/** Collapse duplicate jobs that share the same logical occurrence — a recurring
 *  job is uniquely identified by (templateId, originalOccurrenceDate); one-time
 *  jobs keyed by id. Historical dups from repeated materialize calls are
 *  folded; later rows win so the newest state shows. Single source of truth
 *  for any screen that aggregates job stats (Reports, client detail, etc.). */
export function dedupeJobs(jobs: Job[]): Job[] {
  const byKey = new Map<string, Job>()
  for (const j of jobs) {
    const key = j.templateId
      ? `tpl:${j.templateId}|${j.originalOccurrenceDate ?? j.date}`
      : `one:${j.id}`
    byKey.set(key, j)
  }
  return Array.from(byKey.values())
}

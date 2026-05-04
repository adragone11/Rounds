/**
 * Job time entries — read + edit on web. Mobile owns clock in/out (Field OS),
 * but web Reports lets the user fix mistakes after the fact (forgot to clock
 * out, wrong start time). Active segments (clock_out === null) are not
 * editable here — let mobile end them.
 *
 * Table: public.job_time_entries
 *   id uuid, job_id text, user_id uuid,
 *   clock_in timestamptz NOT NULL,
 *   clock_out timestamptz NULL,   -- null = currently running
 *   created_at timestamptz
 */

import { supabase } from './supabase'

export type TimeEntry = {
  id: string
  jobId: string
  userId: string
  clockIn: string          // ISO
  clockOut: string | null  // null = active segment
  durationMs: number       // 0 for active segments (no point showing live ticks on web)
}

function mapRow(row: Record<string, unknown>): TimeEntry {
  const clockIn = String(row.clock_in)
  const clockOut = (row.clock_out as string | null) ?? null
  const durationMs = clockOut
    ? new Date(clockOut).getTime() - new Date(clockIn).getTime()
    : 0
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    userId: String(row.user_id),
    clockIn,
    clockOut,
    durationMs: Math.max(0, durationMs),
  }
}

export async function getJobTimeEntries(jobId: string): Promise<TimeEntry[]> {
  const { data, error } = await supabase
    .from('job_time_entries')
    .select('*')
    .eq('job_id', jobId)
    .order('clock_in', { ascending: true })
  if (error) throw error
  return (data ?? []).map(r => mapRow(r as Record<string, unknown>))
}

/** Batch fetch entries for many jobs at once — used by the client-detail
 *  Reports view to compute per-job totals without N+1 round trips. */
export async function getEntriesForJobs(jobIds: string[]): Promise<TimeEntry[]> {
  if (jobIds.length === 0) return []
  const { data, error } = await supabase
    .from('job_time_entries')
    .select('*')
    .in('job_id', jobIds)
    .order('clock_in', { ascending: true })
  if (error) throw error
  return (data ?? []).map(r => mapRow(r as Record<string, unknown>))
}

export async function updateTimeEntry(
  id: string,
  patch: { clockIn?: string; clockOut?: string | null },
): Promise<void> {
  const update: Record<string, unknown> = {}
  if (patch.clockIn !== undefined) update.clock_in = patch.clockIn
  if (patch.clockOut !== undefined) update.clock_out = patch.clockOut
  const { error } = await supabase.from('job_time_entries').update(update).eq('id', id)
  if (error) throw error
}

export async function createTimeEntry(
  jobId: string,
  userId: string,
  clockIn: string,
  clockOut: string,
): Promise<TimeEntry> {
  const { data, error } = await supabase
    .from('job_time_entries')
    .insert({ job_id: jobId, user_id: userId, clock_in: clockIn, clock_out: clockOut })
    .select()
    .single()
  if (error) throw error
  return mapRow(data as Record<string, unknown>)
}

export async function deleteTimeEntry(id: string): Promise<void> {
  const { error } = await supabase.from('job_time_entries').delete().eq('id', id)
  if (error) throw error
}

/** "2h 15m", "45m", "2h". Returns empty string for 0ms. */
export function formatDurationMs(ms: number): string {
  if (ms <= 0) return ''
  const totalMin = Math.round(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/** "9:34 AM", "2:07 PM" — timezone-aware (user's local time). */
export function formatClockTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

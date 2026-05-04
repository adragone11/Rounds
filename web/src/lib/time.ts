/**
 * Time wire format — bridge between web and mobile.
 *
 * Mobile stores job.start_time / job.end_time as display strings in
 * date-fns `h:mm a` format ("9:00 AM", "12:30 PM") — not Postgres time,
 * not ISO. Plus the literal sentinel "All Day".
 *
 * Web's internal representation is "HH:mm" (24h) because every
 * <input type="time"> and helper (parseHHMM, addHours, hoursBetween)
 * works in that format. These two converters sit at the Supabase
 * boundary — fromMobileTime on read (mapJobFromDb), toMobileTime on
 * every insert/update — so web internals stay untouched.
 */

export const ALL_DAY = 'All Day'

/** "HH:mm" (or "All Day", or null) → mobile's "h:mm a" wire format. */
export function toMobileTime(s: string | null | undefined): string | null {
  if (!s) return null
  if (s === ALL_DAY) return ALL_DAY
  // Already in mobile format (e.g. pass-through from another job row).
  if (/^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(s)) return normalizeMobile(s)
  const [hStr, mStr] = s.split(':')
  const h24 = Number(hStr)
  const m = Number(mStr)
  if (!Number.isFinite(h24) || !Number.isFinite(m)) return null
  const period = h24 >= 12 ? 'PM' : 'AM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

/** Mobile's "h:mm a" (or "All Day", or null) → web's "HH:mm". */
export function fromMobileTime(s: string | null | undefined): string | null {
  if (!s) return null
  if (s === ALL_DAY) return ALL_DAY
  // Already HH:mm — tolerate legacy rows web wrote before this fix.
  if (/^\d{2}:\d{2}$/.test(s)) return s
  const match = s.trim().match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/i)
  if (!match) return null
  let h = Number(match[1])
  const m = Number(match[2])
  const period = match[3].toUpperCase()
  if (period === 'PM' && h !== 12) h += 12
  if (period === 'AM' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function normalizeMobile(s: string): string {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/i)
  if (!m) return s
  return `${Number(m[1])}:${m[2]} ${m[3].toUpperCase()}`
}

/**
 * Pure helpers shared by the Schedule page and its child views.
 *
 * Extracted from Schedule.tsx — these are stateless date/time/string helpers
 * with no React or store dependencies.
 */

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

// Day-view timeline geometry — must stay in sync with the Day-View render.
export const DAY_VIEW_START_HOUR = 0
export const DAY_VIEW_END_HOUR = 23
export const DAY_VIEW_HOUR_PX = 64

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

export function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay()
}

export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Parse "HH:mm" → total minutes, or null on garbage input.
export function parseHHmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const h = Number(m[1]), mm = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h < 0 || h > 23 || mm < 0 || mm > 59) return null
  return h * 60 + mm
}

export function fmtAmPm(totalMin: number): string {
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

export function fmtDuration(totalMin: number): string {
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function fmtHHmm(totalMin: number): string {
  const h = Math.floor(totalMin / 60), m = totalMin % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Two-letter initials from a name. Used by the day-view avatar circle.
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase()
  return (parts[0]![0] + parts[1]![0]).toUpperCase()
}

// Pastel tint of a hex color for card backgrounds. Keeps contrast with the
// saturated text colour by rendering the bg at ~12% alpha.
export function pastelBg(hex: string): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex
  if (h.length !== 6) return hex
  return `#${h}1F` // 0x1F ≈ 12% alpha
}

// Mix a hex color toward white. Used to give chip text enough lift on dark
// surfaces — the raw saturated hex (#10B981, #3B82F6) reads muddy when set
// over a translucent tint over near-black; lifting it ~35% toward white
// keeps the hue but makes labels pop.
export function brightenHex(hex: string, amount = 0.35): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex
  if (h.length !== 6) return hex
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const lift = (c: number) => Math.round(c + (255 - c) * amount)
  const toHex = (c: number) => c.toString(16).padStart(2, '0')
  return `#${toHex(lift(r))}${toHex(lift(g))}${toHex(lift(b))}`
}

// Format mobile-style "HH:mm" string as "8:00 AM"; falls back if input is null.
export function fmtStartTime(hhmm: string | null | undefined, fallback = '9:00 AM'): string {
  if (!hhmm) return fallback
  const m = parseHHmm(hhmm)
  return m === null ? fallback : fmtAmPm(m)
}

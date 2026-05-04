/**
 * Read-only access to the user's message templates. Mobile owns
 * editing/seeding via messageTemplateService — web just displays them
 * for copy-paste. If the user has never seeded (uncommon — mobile
 * auto-seeds on first list()), we fall back to the same default
 * content so the user always sees something useful.
 */
import { supabase } from './supabase'

export type DefaultKey = 'reminder' | 'cancel' | 'late'

export type MessageTemplate = {
  id: string
  defaultKey: DefaultKey | null
  name: string
  icon: string
  body: string
  sortOrder: number
}

/** Free-tier watermark appended after the body. Mirrors mobile's
 *  FREE_WATERMARK in messageTemplateService.ts:57 so a copy from web
 *  produces the same outgoing text as a send from mobile. Pip+ skips
 *  this entirely. */
export const FREE_WATERMARK = '\n\n- Pip: Job & Client Scheduler'

export function fillTemplate(body: string, isPlus: boolean): string {
  return isPlus ? body : body + FREE_WATERMARK
}

const DEFAULT_SEED: MessageTemplate[] = [
  {
    id: 'seed:reminder',
    defaultKey: 'reminder',
    name: 'Reminder',
    icon: 'bell',
    body: "Hi {name}! Just a friendly reminder about your appointment on {date} at {time}. Looking forward to seeing you!",
    sortOrder: 0,
  },
  {
    id: 'seed:cancel',
    defaultKey: 'cancel',
    name: 'Cancellation',
    icon: 'x-circle',
    body: "Hi {name}, I'm sorry but I need to cancel our appointment on {date} at {time}. Would you like to reschedule? I apologize for any inconvenience.",
    sortOrder: 1,
  },
  {
    id: 'seed:late',
    defaultKey: 'late',
    name: 'Running Late',
    icon: 'alert-circle',
    body: "Hi {name}, I wanted to let you know I'm running a bit behind schedule. I should arrive around 15 minutes late for our {time} appointment. Sorry for the inconvenience!",
    sortOrder: 2,
  },
]

export async function listTemplates(userId: string, isPlus: boolean): Promise<MessageTemplate[]> {
  // Custom templates are Pip+. Free users see only default-keyed templates
  // (reminder/cancel/late) — the system seeds. Filtering here means web stays
  // consistent with mobile's enforcement; a free user with legacy custom rows
  // can't see them on web until they re-up.
  let query = supabase
    .from('user_templates')
    .select('id, default_key, name, icon, body, sort_order')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true })
  if (!isPlus) query = query.not('default_key', 'is', null)

  const { data, error } = await query

  if (error || !data || data.length === 0) return DEFAULT_SEED

  return data.map(row => ({
    id: String(row.id),
    defaultKey: (row.default_key as DefaultKey | null) ?? null,
    name: String(row.name ?? ''),
    icon: String(row.icon ?? 'message-circle'),
    body: String(row.body ?? ''),
    sortOrder: Number(row.sort_order ?? 0),
  }))
}

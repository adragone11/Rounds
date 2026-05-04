/**
 * Destructive bulk operations triggered from the profile danger zone.
 * Mirrors mobile's dataService.deleteAllJobs / deleteAllData so resets
 * stay in sync regardless of which client triggers them.
 *
 * Note: account deletion can't actually remove the auth.users row from
 * the client without an admin token — mobile doesn't either. The
 * "delete account" UX wipes the user's data and signs them out; the
 * orphaned auth row is cleaned up server-side later.
 */
import { supabase } from './supabase'

export async function deleteAllJobs(userId: string): Promise<string | null> {
  const { error } = await supabase.from('jobs').delete().eq('user_id', userId)
  if (error) return error.message
  return null
}

export async function deleteAllData(userId: string): Promise<string | null> {
  // FK order: jobs first (references clients), then clients, then the
  // user-scoped tables.
  const { error: jobsErr } = await supabase.from('jobs').delete().eq('user_id', userId)
  if (jobsErr) return jobsErr.message
  const { error: clientsErr } = await supabase.from('clients').delete().eq('user_id', userId)
  if (clientsErr) return clientsErr.message

  // Best-effort cleanup. Don't bail on a single table failing — RLS may
  // hide some of these, and a missing row shouldn't block the rest.
  const cleanup: { table: string; key: string }[] = [
    { table: 'analytics_events', key: 'user_id' },
    { table: 'message_templates', key: 'user_id' },
    { table: 'onboarding_responses', key: 'user_id' },
    { table: 'feedback', key: 'user_id' },
    { table: 'profiles', key: 'id' },
  ]
  for (const { table, key } of cleanup) {
    await supabase.from(table).delete().eq(key, userId)
  }

  // Local caches — without this the UI keeps painting deleted clients
  // until a hard reload.
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('pip-') || k.startsWith('@pip_') || k.startsWith('@app_')) {
      localStorage.removeItem(k)
    }
  }
  return null
}

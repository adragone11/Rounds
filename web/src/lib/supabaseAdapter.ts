import { supabase } from './supabase'
import { mapJobFromDb, type Job } from './jobs'
import { DEFAULT_AVATAR_COLOR } from '../theme'
import type { Client, DayOfWeek } from '../types'
import type {
  DataAdapter,
  ClientChange,
  JobChange,
  ClientInsert,
  ClientPatch,
  JobInsert,
  JobPatch,
  JobFilter,
  Unsubscribe,
} from './dataAdapter'

/** Translate a JobFilter into a chained Supabase query. The base query
 *  is always scoped to the owner via user_id; everything else is optional. */
function applyJobFilter<Q extends {
  eq: (col: string, val: unknown) => Q
  in: (col: string, vals: readonly unknown[]) => Q
  gte: (col: string, val: unknown) => Q
  lte: (col: string, val: unknown) => Q
  lt: (col: string, val: unknown) => Q
}>(query: Q, userId: string, filter: JobFilter): Q {
  let q = query.eq('user_id', userId)
  if (filter.clientId !== undefined) q = q.eq('client_id', filter.clientId)
  if (filter.clientIds && filter.clientIds.length > 0) q = q.in('client_id', filter.clientIds)
  if (filter.templateId !== undefined) q = q.eq('template_id', filter.templateId)
  if (filter.isTemplate !== undefined) q = q.eq('is_template', filter.isTemplate)
  if (filter.notDeleted) q = q.eq('deleted', false)
  if (filter.dateFrom !== undefined) q = q.gte('date', filter.dateFrom)
  if (filter.dateTo !== undefined) q = q.lte('date', filter.dateTo)
  if (filter.anchorBefore !== undefined) q = q.lt('recurrence_anchor_date', filter.anchorBefore)
  if (filter.anchorOnOrAfter !== undefined) q = q.gte('recurrence_anchor_date', filter.anchorOnOrAfter)
  if (filter.anchorEquals !== undefined) q = q.eq('recurrence_anchor_date', filter.anchorEquals)
  if (filter.notCompleted) q = q.eq('completed', false)
  if (filter.notCancelled) q = q.eq('cancelled', false)
  return q
}

/** Row → Client mapping. Only Supabase-backed columns are filled here.
 *  Schedule meta (frequency/intervalWeeks/startDate/exceptions) is layered
 *  on top by the store from localStorage. */
function mapClientRow(row: Record<string, unknown>): Client {
  const rawBlocked = Array.isArray(row.blocked_weekdays) ? row.blocked_weekdays : []
  const rate = row.rate
  return {
    id: String(row.id),
    name: typeof row.name === 'string' ? row.name : '',
    address: typeof row.address === 'string' ? row.address : '',
    color: typeof row.avatar_color === 'string' && row.avatar_color ? row.avatar_color : DEFAULT_AVATAR_COLOR,
    frequency: 'weekly',
    lat: typeof row.latitude === 'number' ? row.latitude : null,
    lng: typeof row.longitude === 'number' ? row.longitude : null,
    startDate: null,
    exceptions: [],
    blockedDays: rawBlocked.filter((n: unknown): n is DayOfWeek => typeof n === 'number' && n >= 0 && n <= 6),
    rate: typeof rate === 'number' ? rate : Number(rate ?? 0),
  }
}

export function createSupabaseAdapter(userId: string): DataAdapter {
  return {
    userId,

    async loadClients(): Promise<Client[]> {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
      if (error) throw error
      return (data ?? []).map(mapClientRow)
    },

    async insertClient(row: ClientInsert): Promise<Client> {
      const { data, error } = await supabase
        .from('clients')
        .insert({ ...row, user_id: userId })
        .select('*')
        .single()
      if (error) throw error
      return mapClientRow(data)
    },

    async updateClient(id: string, patch: ClientPatch): Promise<Client> {
      const { data, error } = await supabase
        .from('clients')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single()
      if (error) throw error
      return mapClientRow(data)
    },

    async bulkUpdateClients(ids: string[], patch: ClientPatch): Promise<void> {
      if (ids.length === 0) return
      const { error } = await supabase
        .from('clients')
        .update(patch)
        .eq('user_id', userId)
        .in('id', ids)
      if (error) throw error
    },

    async deleteClient(id: string): Promise<void> {
      const { error } = await supabase.from('clients').delete().eq('id', id)
      if (error) throw error
    },

    subscribeClients(onChange: (change: ClientChange) => void): Unsubscribe {
      const channel = supabase
        .channel(`clients:${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'clients', filter: `user_id=eq.${userId}` },
          () => onChange({ type: 'reload' }),
        )
        .subscribe()
      return () => { supabase.removeChannel(channel) }
    },

    async loadJobs(): Promise<Job[]> {
      const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .eq('user_id', userId)
        .eq('deleted', false)
      if (error) throw error
      return (data ?? []).map(mapJobFromDb)
    },

    async insertJob(row: JobInsert): Promise<Job> {
      const { data, error } = await supabase
        .from('jobs')
        .insert({ ...row, user_id: userId })
        .select('*')
        .single()
      if (error) throw error
      return mapJobFromDb(data)
    },

    async updateJob(id: string, patch: JobPatch): Promise<Job> {
      const { data, error } = await supabase
        .from('jobs')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single()
      if (error) throw error
      return mapJobFromDb(data)
    },

    /** Soft-delete to match mobile's expectation; refreshJobs filters
     *  `deleted=false` so the row disappears from the live set. */
    async deleteJob(id: string): Promise<void> {
      const { error } = await supabase.from('jobs').update({ deleted: true }).eq('id', id)
      if (error) throw error
    },

    async bulkUpdateJobs(filter: JobFilter, patch: JobPatch): Promise<void> {
      const query = applyJobFilter(supabase.from('jobs').update(patch), userId, filter)
      const { error } = await query
      if (error) throw error
    },

    async bulkDeleteJobs(filter: JobFilter): Promise<void> {
      const query = applyJobFilter(supabase.from('jobs').delete(), userId, filter)
      const { error } = await query
      if (error) throw error
    },

    async bulkInsertJobs(rows: JobInsert[]): Promise<void> {
      if (rows.length === 0) return
      const stamped = rows.map(r => ({ ...r, user_id: userId }))
      const { error } = await supabase.from('jobs').insert(stamped)
      if (error) throw error
    },

    async findTemplateByAnchor(clientId: string, anchorDate: string): Promise<Job | null> {
      const { data, error } = await supabase.from('jobs').select('*')
        .eq('user_id', userId)
        .eq('client_id', clientId)
        .eq('is_template', true)
        .eq('deleted', false)
        .eq('recurrence_anchor_date', anchorDate)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw error
      return data ? mapJobFromDb(data) : null
    },

    subscribeJobs(onChange: (change: JobChange) => void): Unsubscribe {
      const channel = supabase
        .channel(`jobs:${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'jobs', filter: `user_id=eq.${userId}` },
          payload => {
            if (payload.eventType === 'INSERT') {
              const row = payload.new as Record<string, unknown>
              if (row.deleted) return
              onChange({ type: 'insert', job: mapJobFromDb(row) })
              return
            }
            if (payload.eventType === 'UPDATE') {
              const row = payload.new as Record<string, unknown>
              const job = mapJobFromDb(row)
              if (job.deleted) onChange({ type: 'delete', id: job.id })
              else onChange({ type: 'update', job })
              return
            }
            if (payload.eventType === 'DELETE') {
              const old = payload.old as Record<string, unknown>
              const id = old?.id
              if (typeof id === 'string') onChange({ type: 'delete', id })
            }
          },
        )
        .subscribe()
      return () => { supabase.removeChannel(channel) }
    },
  }
}

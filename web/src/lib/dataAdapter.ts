// Data layer abstraction. Stage 1: interface only. Stage 2 (next commit) adds
// a localStorage adapter and a Pip+ entitlement switch.
//
// Adapters return already-mapped Client/Job shapes — the store should never
// see raw Supabase rows. Subscribe* methods return an unsubscribe function.

import type { Client } from '../types'
import type { Job } from './jobs'

export type Unsubscribe = () => void

export type ClientChange =
  | { type: 'reload' }
  | { type: 'upsert'; client: Client }
  | { type: 'delete'; id: string }

export type JobChange =
  | { type: 'insert'; job: Job }
  | { type: 'update'; job: Job }
  | { type: 'delete'; id: string }

/** Patch shapes are kept loose because callers already build column-shaped
 *  objects for Supabase. The local adapter will translate the same shape. */
export type ClientInsert = Record<string, unknown>
export type ClientPatch = Record<string, unknown>
export type JobInsert = Record<string, unknown>
export type JobPatch = Record<string, unknown>

/** Filter shape for bulk job operations. All fields are AND-combined.
 *  Mirrors the SQL we currently chain inline; the local adapter will
 *  translate these into in-memory array filters. */
export type JobFilter = {
  clientId?: string
  clientIds?: string[]
  templateId?: string
  isTemplate?: boolean
  /** When true, requires `deleted=false`. */
  notDeleted?: boolean
  /** ISO yyyy-mm-dd inclusive lower bound on the `date` column. */
  dateFrom?: string
  /** ISO yyyy-mm-dd inclusive upper bound on the `date` column. */
  dateTo?: string
  /** Strict less-than on `recurrence_anchor_date`. */
  anchorBefore?: string
  /** Greater-than-or-equal on `recurrence_anchor_date`. */
  anchorOnOrAfter?: string
  /** Equality on `recurrence_anchor_date`. */
  anchorEquals?: string
  /** When true, requires `completed=false`. */
  notCompleted?: boolean
  /** When true, requires `cancelled=false`. */
  notCancelled?: boolean
}

export interface DataAdapter {
  /** Identifier for the current owner (Supabase auth uid, or local user id). */
  readonly userId: string

  loadClients(): Promise<Client[]>
  insertClient(row: ClientInsert): Promise<Client>
  updateClient(id: string, patch: ClientPatch): Promise<Client>
  /** Apply the same patch to many clients in one round-trip. Used by the
   *  schedule publish flow to recolor clients by assigned weekday. */
  bulkUpdateClients(ids: string[], patch: ClientPatch): Promise<void>
  deleteClient(id: string): Promise<void>
  subscribeClients(onChange: (change: ClientChange) => void): Unsubscribe

  loadJobs(): Promise<Job[]>
  insertJob(row: JobInsert): Promise<Job>
  updateJob(id: string, patch: JobPatch): Promise<Job>
  /** Soft-delete in Supabase, hard-delete in local. Both yield "row gone." */
  deleteJob(id: string): Promise<void>
  /** Apply `patch` to every row matching `filter`. */
  bulkUpdateJobs(filter: JobFilter, patch: JobPatch): Promise<void>
  /** Hard-delete every row matching `filter`. Used for templates because
   *  mobile's template query doesn't filter `deleted=false`. */
  bulkDeleteJobs(filter: JobFilter): Promise<void>
  /** Insert many job rows in a single round-trip. */
  bulkInsertJobs(rows: JobInsert[]): Promise<void>
  /** Look up the most recently created live template for (clientId, anchorDate). */
  findTemplateByAnchor(clientId: string, anchorDate: string): Promise<Job | null>
  subscribeJobs(onChange: (change: JobChange) => void): Unsubscribe
}

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Wrench } from 'lucide-react'
import { useStore } from '../store'
import { useCurrency } from '../lib/currency'
import { useLanguage } from '../lib/language'
import { dedupeJobs, nextOccurrenceOnOrAfter } from '../lib/jobs'
import type { Job } from '../lib/jobs'
import type { Client } from '../types'
import EditJobModal from '../components/EditJobModal'
import AddPriceModal from '../components/AddPriceModal'
import { ALL_DAY } from '../lib/time'
import { getEntriesForJobs, formatDurationMs, type TimeEntry } from '../lib/timeEntries'
import { DEFAULT_AVATAR_COLOR } from '../theme'

type Tab = 'earnings' | 'clients'
type Range = 'today' | 'week' | 'month' | 'year'

const BRAND = '#10B981'        // emerald (earnings)
const CLIENT = '#3B82F6'       // blue (clients) — was violet, swapped to
                                //   match the rest of the app's accent.
                                //   Recurrence keeps its violet treatment
                                //   (lives outside this file).
const UNPAID = '#F59E0B'       // amber
const TEXT_DIM = '#9CA3AF'

// localStorage-backed state for Reports navigation. Survives browser close
// so the user lands back on the same client/tab they were viewing.
const REPORTS_STATE_KEY = 'pip.reports.state'
const UNPRICED_OPEN_KEY = 'pip.reports.unpriced.open'
type PersistedReportsState = { tab: Tab; range: Range; selectedClientId: string | null }
function loadReportsState(): PersistedReportsState {
  try {
    const raw = localStorage.getItem(REPORTS_STATE_KEY)
    if (!raw) return { tab: 'earnings', range: 'year', selectedClientId: null }
    const parsed = JSON.parse(raw) as Partial<PersistedReportsState>
    return {
      tab: parsed.tab ?? 'earnings',
      range: parsed.range ?? 'year',
      selectedClientId: parsed.selectedClientId ?? null,
    }
  } catch {
    return { tab: 'earnings', range: 'year', selectedClientId: null }
  }
}

export default function Reports() {
  const navigate = useNavigate()
  const { t } = useLanguage()
  const { jobs, clients } = useStore()
  const initial = loadReportsState()
  const [tab, setTab] = useState<Tab>(initial.tab)
  const [range, setRange] = useState<Range>(initial.range)
  const [selectedClientId, setSelectedClientId] = useState<string | null>(initial.selectedClientId)
  useEffect(() => {
    try { localStorage.setItem(REPORTS_STATE_KEY, JSON.stringify({ tab, range, selectedClientId })) } catch { /* ignore */ }
  }, [tab, range, selectedClientId])

  const activeJobs = useMemo(
    () => dedupeJobs(jobs.filter(j => !j.deleted && !j.cancelled && !j.isTemplate)),
    [jobs],
  )
  const finished = useMemo(() => activeJobs.filter(j => j.completed), [activeJobs])
  // Cancelled jobs are kept out of every earnings tally (activeJobs filter
  // above) but we still want them visible in client detail so the user can
  // see what got cancelled. Mirrors the "Past Jobs" treatment in Clients.tsx.
  const cancelledJobs = useMemo(
    () => dedupeJobs(jobs.filter(j => !j.deleted && !j.isTemplate && j.cancelled)),
    [jobs],
  )
  // Recurring templates — needed by the Clients list to compute "next visit"
  // for clients whose next occurrence is still virtual (not materialized).
  // activeJobs filters templates out, so without this every weekly/biweekly
  // client with no past materialized rows in the current month renders as
  // "—" under Next Visit. Reference: nextOccurrenceOnOrAfter in lib/jobs.ts.
  const templates = useMemo(
    () => jobs.filter(j => !j.deleted && j.isTemplate && j.isRecurring),
    [jobs],
  )

  const onTabChange = (t: Tab) => {
    setTab(t)
    setSelectedClientId(null)
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-surface-page">
      {/* Header */}
      <div className="shrink-0 px-8 pt-7 pb-5 flex items-center gap-4">
        <button
          onClick={() => navigate('/settings')}
          className="w-10 h-10 rounded-full bg-white shadow-sm flex items-center justify-center text-gray-700 hover:bg-gray-50 transition-colors"
          aria-label={t('reports.web.backToSettings')}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">{t('reports.title')}</h1>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-8 pb-10">
        <div className="max-w-7xl mx-auto">
          {/* Tabs + range selector on the same row */}
          <div className="flex items-center justify-between mb-6">
            <div className="bg-white rounded-2xl p-1.5 shadow-sm flex gap-1">
              <TabButton active={tab === 'earnings'} onClick={() => onTabChange('earnings')} label={t('reports.tabs.earnings')} color={BRAND}
                icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" /></svg>} />
              <TabButton active={tab === 'clients'} onClick={() => onTabChange('clients')} label={t('reports.tabs.clients')} color={CLIENT}
                icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg>} />
            </div>
            {tab === 'earnings' && <RangeSelect value={range} onChange={setRange} />}
          </div>

          {tab === 'earnings' && <EarningsTab finished={finished} activeJobs={activeJobs} clients={clients} range={range} />}
          {tab === 'clients' && !selectedClientId && (
            <ClientsList finished={finished} activeJobs={activeJobs} templates={templates} clients={clients} onSelect={setSelectedClientId} />
          )}
          {tab === 'clients' && selectedClientId && (
            <ClientDetail
              client={clients.find(c => c.id === selectedClientId) ?? null}
              activeJobs={activeJobs}
              cancelledJobs={cancelledJobs}
              onBack={() => setSelectedClientId(null)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ═══ Earnings ════════════════════════════════════════════════════════════════

function EarningsTab({ finished, activeJobs, clients, range }: { finished: Job[]; activeJobs: Job[]; clients: Client[]; range: Range }) {
  const { t } = useLanguage()
  const { formatCurrency } = useCurrency()
  const windowed = useMemo(() => inRange(finished, range), [finished, range])
  const clientMap = useMemo(() => new Map(clients.map(c => [c.id, c])), [clients])
  const [editing, setEditing] = useState<{ job: Job; client: Client | null } | null>(null)
  // Separate state for the price-only Needs Price flow. Keeping the price
  // entry isolated from the full edit modal prevents accidents like flipping
  // completion with scope='all' from a list intended only for pricing.
  const [pricing, setPricing] = useState<{ job: Job; client: Client | null } | null>(null)

  // Fixed headline totals — always visible regardless of selected range.
  const headline = useMemo(() => {
    const sum = (r: Range) => inRange(finished, r).reduce((s, j) => s + j.price, 0)
    const allTime = finished.reduce((s, j) => s + j.price, 0)
    return {
      today: sum('today'),
      week: sum('week'),
      month: sum('month'),
      year: sum('year'),
      allTime,
    }
  }, [finished])

  const totals = useMemo(() => {
    let paidAmt = 0, unpaidAmt = 0
    for (const j of windowed) {
      if (j.paid) paidAmt += j.price
      else unpaidAmt += j.price
    }
    const total = paidAmt + unpaidAmt
    const avg = windowed.length > 0 ? total / windowed.length : 0
    return { paidAmt, unpaidAmt, total, avg, count: windowed.length }
  }, [windowed])

  const series = useMemo(() => buildChartSeries(windowed, range), [windowed, range])
  const recent = useMemo(() => {
    const todayISO = new Date().toISOString().slice(0, 10)
    return activeJobs
      .filter(j => j.date <= todayISO)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 12)
  }, [activeJobs])

  // Completed-but-unpriced across every client. Lives outside the period
  // toggle on purpose — it's a roster-wide cleanup signal, not a windowed
  // metric. Sorted newest-first so the most recently forgotten job is on
  // top.
  const unpricedAll = useMemo(
    () => finished.filter(j => j.price <= 0).sort((a, b) => (a.date < b.date ? 1 : -1)),
    [finished],
  )

  const countSuffix = totals.count === 1
    ? t('reports.web.jobCountOne', { count: totals.count })
    : t('reports.web.jobCountOther', { count: totals.count })

  return (
    <>
      {/* Headline stat cards — always visible, fixed periods. */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <StatCard label={t('common.today')} value={formatCurrency(headline.today)} accent={range === 'today' ? BRAND : undefined} />
        <StatCard label={t('earnings.thisWeek')} value={formatCurrency(headline.week)} accent={range === 'week' ? BRAND : undefined} />
        <StatCard label={t('earnings.thisMonth')} value={formatCurrency(headline.month)} accent={range === 'month' ? BRAND : undefined} />
        <StatCard label={t('earnings.thisYear')} value={formatCurrency(headline.year)} accent={range === 'year' ? BRAND : undefined} />
        <StatCard label={t('earnings.allTime')} value={formatCurrency(headline.allTime)} accent={BRAND} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-6 mb-6">
        <Card>
          <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
            <div>
              <p className="text-lg font-bold text-gray-900">{t('earnings.title')}</p>
              <p className="text-xs text-gray-400 mt-0.5">{rangeLabel(range, t)} · {formatCurrency(totals.total)} {countSuffix}</p>
            </div>
            <Legend items={[{ label: t('earnings.title'), color: BRAND }]} />
          </div>
          <LineChart
            series={[{ name: t('earnings.title'), color: BRAND, data: series.values, format: formatCurrency }]}
            labels={series.labels}
          />
        </Card>

        <FollowUpCard activeJobs={activeJobs} clients={clients} />
      </div>

      {/* Needs Price — full-width section between the chart row and the
          recent-jobs row. Renders only when there's something to fix; the
          page stays calm otherwise. Each row routes through the existing
          edit modal so the scope picker (this / this+future) handles
          recurrence cleanly. */}
      {unpricedAll.length > 0 && (
        <div className="mb-6">
          <UnpricedJobsCard
            jobs={unpricedAll}
            clientMap={clientMap}
            onEdit={(job) => setPricing({ job, client: job.clientId ? clientMap.get(job.clientId) ?? null : null })}
            showClient
          />
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-6">
        <JobsTable
          title={t('reports.web.recentJobs')}
          jobs={recent}
          clientMap={clientMap}
          onEdit={(job, client) => setEditing({ job, client })}
        />
        <TopClientsCard windowed={windowed} clientMap={clientMap} range={range} />
      </div>

      {editing && (
        <EditJobModal
          job={editing.job}
          client={editing.client}
          onClose={() => setEditing(null)}
        />
      )}
      {pricing && (
        <AddPriceModal
          job={pricing.job}
          client={pricing.client}
          onClose={() => setPricing(null)}
        />
      )}
    </>
  )
}

// ═══ Clients List ════════════════════════════════════════════════════════════

function ClientsList({ finished, activeJobs, templates, clients, onSelect }: {
  finished: Job[]
  activeJobs: Job[]
  templates: Job[]
  clients: Client[]
  onSelect: (id: string) => void
}) {
  const { t } = useLanguage()
  const { formatCurrency } = useCurrency()
  const stats = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    type S = {
      revenue: number
      totalJobs: number
      firstDate: string  // earliest scheduled job (any status) — clears if that job is deleted
      lastDate: string   // most recent completed job
      nextDate: string   // soonest upcoming job
    }
    const m = new Map<string, S>()
    const get = (id: string): S => m.get(id) ?? {
      revenue: 0, totalJobs: 0,
      firstDate: '', lastDate: '', nextDate: '',
    }
    for (const j of activeJobs) {
      if (!j.clientId) continue
      const cur = get(j.clientId)
      cur.totalJobs += 1
      if (!cur.firstDate || j.date < cur.firstDate) cur.firstDate = j.date
      if (j.completed) {
        cur.revenue += j.price
        if (j.date > cur.lastDate) cur.lastDate = j.date
      } else if (parseDate(j.date) >= today) {
        if (!cur.nextDate || j.date < cur.nextDate) cur.nextDate = j.date
      }
      m.set(j.clientId, cur)
    }
    // Project recurring templates forward — for clients whose next visit
    // is still a virtual occurrence (not yet materialized into a row), the
    // loop above never sees it. Fold the soonest projected occurrence into
    // each client's nextDate.
    for (const tpl of templates) {
      if (!tpl.clientId) continue
      const next = nextOccurrenceOnOrAfter(tpl, today)
      if (!next) continue
      const cur = get(tpl.clientId)
      if (!cur.nextDate || next < cur.nextDate) cur.nextDate = next
      m.set(tpl.clientId, cur)
    }
    return m
  }, [activeJobs, templates])

  const rows = useMemo(() => {
    const empty = { revenue: 0, totalJobs: 0, firstDate: '', lastDate: '', nextDate: '' }
    return clients
      .map(c => ({ client: c, ...(stats.get(c.id) ?? empty) }))
      .sort((a, b) => {
        // Active clients first (by revenue), then clients with upcoming jobs (by next date), then inactive.
        if (a.totalJobs > 0 && b.totalJobs === 0) return -1
        if (b.totalJobs > 0 && a.totalJobs === 0) return 1
        if (a.revenue !== b.revenue) return b.revenue - a.revenue
        return b.totalJobs - a.totalJobs
      })
  }, [clients, stats])

  const totalRevenue = useMemo(() => finished.reduce((s, j) => s + j.price, 0), [finished])
  // "Active" = has ANY job (completed or upcoming), not just completed.
  const activeCount = [...stats.values()].filter(s => s.totalJobs > 0).length

  return (
    <>
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard label={t('clients.title')} value={String(clients.length)} accent={CLIENT} />
        <StatCard label={t('reports.web.active')} value={String(activeCount)} />
        <StatCard label={t('reports.web.allTimeRevenue')} value={formatCurrency(totalRevenue)} accent={CLIENT} />
      </div>

      <Card>
        <div className="flex items-center justify-between mb-4">
          <p className="text-lg font-bold text-gray-900">{t('reports.web.allClients')}</p>
          <p className="text-xs text-gray-400">{t('reports.web.clickClientHint')}</p>
        </div>

        {rows.length === 0 && <p className="text-sm text-gray-400 py-8 text-center">{t('reports.web.noClientsYet')}</p>}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                  <th className="text-left py-2 pr-3">{t('addJob.labels.client')}</th>
                  <th className="text-right py-2 px-3">Started</th>
                  <th className="text-right py-2 px-3">Next visit</th>
                  <th className="text-right py-2 px-3">{t('reports.web.colRevenue')}</th>
                  <th className="text-right py-2 pl-3 w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const subtitle = r.lastDate
                    ? `Last: ${formatShortDate(r.lastDate)}`
                    : r.nextDate
                      ? 'New client'
                      : 'No jobs yet'
                  return (
                    <tr
                      key={r.client.id}
                      className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer"
                      onClick={() => onSelect(r.client.id)}
                    >
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar color={r.client.color} name={r.client.name} />
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900 truncate">{r.client.name}</p>
                            <p className="text-xs text-gray-400 truncate">{subtitle}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right">
                        {r.firstDate
                          ? <DateBadge date={r.firstDate} tone="muted" />
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-3 px-3 text-right">
                        {r.nextDate
                          ? <DateBadge date={r.nextDate} tone="next" />
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-3 px-3 text-right font-bold text-gray-900">
                        {r.revenue > 0 ? formatCurrency(r.revenue) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-3 pl-3 text-right">
                        <svg className="w-4 h-4 text-gray-300 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                        </svg>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

// ═══ Client Detail ═══════════════════════════════════════════════════════════

function ClientDetail({ client, activeJobs, cancelledJobs, onBack }: {
  client: Client | null
  activeJobs: Job[]
  cancelledJobs: Job[]
  onBack: () => void
}) {
  const { t } = useLanguage()
  const { formatCurrency } = useCurrency()
  const [editing, setEditing] = useState<Job | null>(null)
  // Price-only flow for the per-client Needs Price card. Same reason as the
  // roster-wide card: keep "set the price" surgical so users can't trip
  // completion/paid toggles while fixing earnings.
  const [pricing, setPricing] = useState<Job | null>(null)

  if (!client) {
    return (
      <Card>
        <p className="text-sm text-gray-400">{t('reports.web.clientNotFound')}</p>
        <button onClick={onBack} className="mt-3 text-sm font-semibold" style={{ color: CLIENT }}>← {t('common.back')}</button>
      </Card>
    )
  }

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const clientJobs = dedupeJobs(activeJobs.filter(j => j.clientId === client.id))

  // Tracked time per job (clock in/out from mobile). Keyed by jobId →
  // { totalMs, entries }. One batch fetch covers every job for this client.
  const [trackedByJob, setTrackedByJob] = useState<Map<string, { totalMs: number; entries: TimeEntry[] }>>(new Map())
  const jobIdsKey = clientJobs.map(j => j.id).sort().join(',')
  useEffect(() => {
    let cancelled = false
    const ids = clientJobs.map(j => j.id)
    if (ids.length === 0) { setTrackedByJob(new Map()); return }
    getEntriesForJobs(ids)
      .then(entries => {
        if (cancelled) return
        const map = new Map<string, { totalMs: number; entries: TimeEntry[] }>()
        for (const e of entries) {
          const cur = map.get(e.jobId) ?? { totalMs: 0, entries: [] }
          cur.totalMs += e.durationMs
          cur.entries.push(e)
          map.set(e.jobId, cur)
        }
        setTrackedByJob(map)
      })
      .catch(() => { if (!cancelled) setTrackedByJob(new Map()) })
    return () => { cancelled = true }
  // jobIdsKey collapses the array → string so we don't re-fetch when the
  // wrapper re-renders with a new but identical array reference.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobIdsKey])

  const completed = clientJobs.filter(j => j.completed).sort((a, b) => (a.date < b.date ? 1 : -1))
  const upcoming = clientJobs
    .filter(j => !j.completed && parseDate(j.date) >= today)
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  const paid = completed.filter(j => j.paid)
  // $0 completions are "no charge", not "unpaid". Filtering them out keeps
  // the Unpaid card honest (no $0 total + non-zero count edge case) and
  // hides the section entirely when nothing is actually owed.
  const unpaid = completed.filter(j => !j.paid && j.price > 0)
  // Unpriced = completed but never priced. These belong in their own
  // section ("Needs Price") with an Add-price affordance — they're a
  // data-entry chore, not a collection problem. Pip+ surfaces them so
  // users can recover earnings they forgot to record.
  const unpriced = completed.filter(j => j.price <= 0)

  // Cancelled jobs for this client — kept out of every $ tally above, but
  // surfaced below so the user can see what got cancelled. Most-recent first.
  const cancelled = cancelledJobs
    .filter(j => j.clientId === client.id)
    .sort((a, b) => (a.date < b.date ? 1 : -1))

  const totalEarned = completed.reduce((s, j) => s + j.price, 0)
  const paidAmt = paid.reduce((s, j) => s + j.price, 0)
  const unpaidAmt = unpaid.reduce((s, j) => s + j.price, 0)
  // Total tracked time across every job for this client (completed +
  // upcoming + cancelled). Sum is meaningful even on cancelled rows since
  // any clock-in still represents real work the user did.
  const totalTrackedMs = Array.from(trackedByJob.values()).reduce((s, t) => s + t.totalMs, 0)

  return (
    <>
      {/* Client header */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={onBack}
          className="w-10 h-10 rounded-full bg-white shadow-sm flex items-center justify-center text-gray-700 hover:bg-gray-50"
          aria-label={t('reports.web.backToClients')}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-white text-xl font-bold shrink-0" style={{ backgroundColor: client.color }}>
          {client.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-bold text-gray-900 truncate">{client.name}</p>
          <p className="text-sm text-gray-400 truncate">{client.address || '—'}</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <StatCard label={t('reports.web.totalEarned')} value={formatCurrency(totalEarned)} accent={CLIENT} />
        <StatCard label={t('payment.paid')} value={formatCurrency(paidAmt)} accent={BRAND} />
        <StatCard label={t('payment.unpaid')} value={formatCurrency(unpaidAmt)} accent={unpaidAmt > 0 ? UNPAID : undefined} />
        <StatCard label="Completed Jobs" value={String(completed.length)} />
        <StatCard label="Total Tracked" value={totalTrackedMs > 0 ? (formatDurationMs(totalTrackedMs) || '—') : '—'} accent={totalTrackedMs > 0 ? '#0369A1' : undefined} />
      </div>

      {/* Needs Follow Up — only renders if this client has overdue jobs */}
      {getOverdueJobs(clientJobs).length > 0 && (
        <>
          <FollowUpCard activeJobs={clientJobs} clients={[client]} />
          <div className="h-6" />
        </>
      )}

      {/* Upcoming jobs */}
      <Card>
        <p className="text-lg font-bold text-gray-900 mb-4">{t('clientDetail.jobSections.upcomingJobs')}</p>
        {upcoming.length === 0 ? (
          <p className="text-sm text-gray-400 py-4">{t('reports.web.noUpcomingScheduled')}</p>
        ) : (
          <ClientJobsTable jobs={upcoming} mode="upcoming" onEdit={setEditing} trackedByJob={trackedByJob} />
        )}
      </Card>

      <div className="h-6" />

      {/* Unpaid */}
      {unpaid.length > 0 && (
        <>
          <Card>
            <div className="flex items-center justify-between mb-4">
              <p className="text-lg font-bold text-gray-900">{t('reports.web.unpaidJobs')}</p>
              <span className="text-sm font-bold" style={{ color: UNPAID }}>{formatCurrency(unpaidAmt)}</span>
            </div>
            <ClientJobsTable jobs={unpaid} mode="completed" onEdit={setEditing} trackedByJob={trackedByJob} />
          </Card>
          <div className="h-6" />
        </>
      )}

      {/* Needs Price — completed jobs without a price. Click any row to
          open the edit panel pre-loaded; the existing scope picker handles
          "this only" vs "this + future". */}
      {unpriced.length > 0 && (
        <>
          <UnpricedJobsCard
            jobs={unpriced}
            onEdit={(j) => setPricing(j)}
            showClient={false}
          />
          <div className="h-6" />
        </>
      )}

      {/* Paid history */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <p className="text-lg font-bold text-gray-900">{t('reports.web.paidHistory')}</p>
          <span className="text-sm font-bold" style={{ color: BRAND }}>{formatCurrency(paidAmt)}</span>
        </div>
        {paid.length === 0 ? (
          <p className="text-sm text-gray-400 py-4">{t('reports.web.noPaidJobsYet')}</p>
        ) : (
          <ClientJobsTable jobs={paid} mode="completed" onEdit={setEditing} trackedByJob={trackedByJob} />
        )}
      </Card>

      {/* Cancelled — visible record, no $ counted. Header includes the count
          and a $0 to reinforce that no money is being tallied here. */}
      {cancelled.length > 0 && (
        <>
          <div className="h-6" />
          <Card>
            <div className="flex items-center justify-between mb-4">
              <p className="text-lg font-bold text-gray-900">Cancelled</p>
              <span className="text-sm font-bold text-gray-400">{cancelled.length}</span>
            </div>
            <ClientJobsTable jobs={cancelled} mode="cancelled" onEdit={setEditing} trackedByJob={trackedByJob} />
          </Card>
        </>
      )}

      {pricing && (
        <AddPriceModal job={pricing} client={client} onClose={() => setPricing(null)} />
      )}
      {editing && (
        <EditJobModal job={editing} client={client} onClose={() => setEditing(null)} />
      )}
    </>
  )
}

function ClientJobsTable({ jobs, mode, onEdit, trackedByJob }: {
  jobs: Job[]
  // 'cancelled' is a render-only variant — same columns as 'completed' but
  // every row reads as struck-through with a single CANCELLED status pill.
  mode: 'upcoming' | 'completed' | 'cancelled'
  onEdit?: (j: Job) => void
  // jobId → tracked time (sum of clock_in/out segments). Tracked column
  // hidden on upcoming since nothing's been clocked yet.
  trackedByJob?: Map<string, { totalMs: number; entries: TimeEntry[] }>
}) {
  const { t } = useLanguage()
  const isCancelledMode = mode === 'cancelled'
  const showTracked = mode !== 'upcoming'
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
            <th className="text-left py-2 pr-3">{t('addJob.labels.date')}</th>
            <th className="text-left py-2 px-3">{t('reports.web.colJob')}</th>
            <th className="text-right py-2 px-3">{t('clientDetail.stats.hours')}</th>
            {showTracked && <th className="text-right py-2 px-3">Tracked</th>}
            <th className="text-right py-2 px-3">{mode === 'upcoming' ? t('addJob.labels.price') : t('reports.web.colAmount')}</th>
            {mode !== 'upcoming' && <th className="text-right py-2 px-3">Status</th>}
            {mode === 'completed' && <th className="text-right py-2 pl-3">Paid</th>}
          </tr>
        </thead>
        <tbody>
          {jobs.map(j => {
            const tracked = trackedByJob?.get(j.id)
            return (
            <tr
              key={j.id}
              onClick={onEdit ? () => onEdit(j) : undefined}
              className={`border-t border-gray-100 ${onEdit ? 'cursor-pointer hover:bg-gray-50 transition-colors' : ''} ${isCancelledMode ? 'opacity-70' : ''}`}
            >
              <td className="py-3 pr-3"><DateBadge date={j.date} tone={mode === 'upcoming' ? 'next' : 'muted'} /></td>
              <td className={`py-3 px-3 text-gray-500 ${isCancelledMode ? 'line-through' : ''}`}>
                {j.title ?? (j.startTime && j.startTime !== ALL_DAY
                  ? formatTimeRange(j.startTime, j.endTime, j.duration)
                  : t('reports.web.recurring'))}
              </td>
              <td className={`py-3 px-3 text-right text-gray-700 ${isCancelledMode ? 'line-through' : ''}`}>{formatHours(j.actualDuration ?? j.duration ?? 0)}</td>
              {showTracked && (
                <td className={`py-3 px-3 text-right tabular-nums ${tracked && tracked.totalMs > 0 ? 'text-sky-700 font-semibold' : 'text-gray-300'} ${isCancelledMode ? 'line-through' : ''}`}>
                  {tracked && tracked.totalMs > 0 ? formatDurationMs(tracked.totalMs) : '—'}
                </td>
              )}
              <td className={`py-3 pl-3 text-right ${isCancelledMode ? 'line-through text-gray-400' : ''}`}>
                <Money amount={j.price} />
              </td>
              {mode === 'completed' && (
                <td className="py-3 px-3 text-right">
                  <CompletionChip completed price={j.price} />
                </td>
              )}
              {mode === 'completed' && (
                <td className="py-3 pl-3 text-right">
                  <PaidChip completed paid={j.paid} price={j.price} />
                </td>
              )}
              {isCancelledMode && (
                <td className="py-3 px-3 text-right">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-50 text-red-700 no-underline">
                    Cancelled
                  </span>
                </td>
              )}
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Pip+ "Needs Price" card. Surfaces completed jobs the user never priced
 * so they can recover earnings they forgot to record. Used in two places:
 *  1. Earnings tab — roster-wide list, includes client name
 *  2. Per-client detail — that client only, omits the client column
 *
 * Rows are click-targets that hand back to the parent's existing edit
 * flow (EditJobModal). The modal's scope picker handles "this only" vs
 * "this + future", which is why we don't need any new write logic here.
 */
function UnpricedJobsCard({ jobs, clientMap, onEdit, showClient }: {
  jobs: Job[]
  clientMap?: Map<string, Client>
  onEdit: (job: Job) => void
  showClient: boolean
}) {
  const { t } = useLanguage()
  // Persist open/closed across reloads — sits next to the rest of Reports'
  // localStorage state. Defaults to open so the cleanup signal is visible
  // the first time it appears; the user can collapse if they want a calmer
  // page once they've triaged.
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(UNPRICED_OPEN_KEY) !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem(UNPRICED_OPEN_KEY, open ? '1' : '0') } catch { /* ignore */ }
  }, [open])
  const count = jobs.length
  const headline = count === 1
    ? t('reports.web.unpricedHeadlineOne')
    : t('reports.web.unpricedHeadlineOther', { count })
  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className={`w-full px-5 py-4 ${open ? 'border-b border-amber-100 dark:border-amber-400/20' : ''} bg-amber-50/50 hover:bg-amber-50 dark:bg-amber-500/10 dark:hover:bg-amber-500/15 flex items-start justify-between gap-3 text-left transition-colors`}
      >
        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold text-gray-900 leading-tight">
            {t('reports.web.needsPrice') || 'Needs Price'}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">{headline} · {t('reports.web.unpricedSubtitle')}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
            style={{ backgroundColor: UNPAID + '22', color: UNPAID }}
          >
            {count}
          </span>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {open && (
      <ul className="divide-y divide-gray-100 dark:divide-white/5">
        {jobs.map(j => {
          const client = showClient && j.clientId ? clientMap?.get(j.clientId) : undefined
          const avatarColor = j.avatarColor || client?.color || DEFAULT_AVATAR_COLOR
          return (
            <li
              key={j.id}
              onClick={() => onEdit(j)}
              className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-amber-50/40 dark:hover:bg-amber-500/10 transition-colors"
            >
              {showClient && (
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-[11px] font-semibold shrink-0"
                  style={{ backgroundColor: avatarColor }}
                  aria-hidden
                >
                  {client ? avatarInitials(client.name) : '•'}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  {showClient && client && (
                    <p className="text-sm font-semibold text-gray-900 truncate">{client.name}</p>
                  )}
                  <p className="text-[11px] font-medium text-gray-400 shrink-0">{formatShortDate(j.date)}</p>
                </div>
                <p className={`text-[12px] text-gray-500 truncate ${showClient ? 'mt-0.5' : ''}`}>
                  {formatHours(j.actualDuration ?? j.duration ?? 0)}
                  {j.title ? ` · ${j.title}` : ''}
                </p>
              </div>
              <span
                className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 text-[12px] font-semibold text-white rounded-lg"
                style={{ backgroundColor: UNPAID }}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                {t('reports.web.addPrice') || 'Add price'}
              </span>
            </li>
          )
        })}
      </ul>
      )}
    </div>
  )
}

// ═══ Shared atoms ════════════════════════════════════════════════════════════

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-2xl shadow-sm p-5">{children}</div>
}

function TabButton({ active, onClick, label, color, icon }: {
  active: boolean; onClick: () => void; label: string; color: string; icon: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 px-8 py-2.5 min-w-[140px] rounded-xl text-sm font-semibold transition-colors ${active ? '' : 'text-gray-400 hover:text-gray-600'}`}
      style={active ? { backgroundColor: color + '15', color } : undefined}
    >
      {icon}
      {label}
    </button>
  )
}

function Money({ amount }: { amount: number }) {
  const { formatCurrency } = useCurrency()
  if (!amount) return <span className="text-gray-300">—</span>
  return <span className="font-bold text-gray-900">{formatCurrency(amount)}</span>
}

function DateBadge({ date, tone }: { date: string; tone: 'muted' | 'next' }) {
  // 'next' uses a violet tint with 15% alpha — already theme-safe.
  // 'muted' was hardcoded #F3F4F6 / #6B7280 which renders bright on dark;
  // route through theme tokens instead so it picks up the right surface.
  const styles = tone === 'next'
    ? { color: CLIENT, backgroundColor: CLIENT + '15' }
    : { color: 'var(--color-ink-secondary)', backgroundColor: 'var(--color-surface-subtle)' }
  return (
    <span
      className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold tabular-nums whitespace-nowrap"
      style={styles}
    >
      {formatDateBadge(date)}
    </span>
  )
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  // No accent → fall through to the theme's primary ink so the value flips
  // from near-black on light to near-white on dark. Hardcoding #111827 here
  // pinned the number to black on the dark page (unreadable).
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm">
      <p className="text-xs font-semibold text-gray-400 mb-1.5">{label}</p>
      <p className="text-2xl font-bold tracking-tight" style={{ color: accent ?? 'var(--color-ink-primary)' }}>{value}</p>
    </div>
  )
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex items-center gap-4">
      {items.map(i => (
        <div key={i.label} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: i.color }} />
          <span className="text-xs font-semibold text-gray-500">{i.label}</span>
        </div>
      ))}
    </div>
  )
}

function RangeSelect({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const { t } = useLanguage()
  const opts: { v: Range; label: string }[] = [
    { v: 'today', label: t('common.today') },
    { v: 'week', label: t('reports.web.rangeWeek') },
    { v: 'month', label: t('reports.web.rangeMonth') },
    { v: 'year', label: t('reports.web.rangeYear') },
  ]
  return (
    <div className="bg-white rounded-xl shadow-sm flex p-1 gap-0.5">
      {opts.map(o => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-6 py-2 min-w-[96px] rounded-lg text-sm font-semibold transition-colors ${value === o.v ? 'bg-gray-100 text-gray-900' : 'text-gray-400 hover:text-gray-600'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Avatar({ color, name }: { color: string; name: string }) {
  return (
    <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold shrink-0" style={{ backgroundColor: color }}>
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

function TaskAvatar() {
  return (
    <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-blue-50">
      <Wrench className="w-4 h-4 text-blue-500" />
    </div>
  )
}

// ═══ Follow-up card ══════════════════════════════════════════════════════════

export function FollowUpCard({ activeJobs, clients }: { activeJobs: Job[]; clients: Client[] }) {
  const store = useStore()
  const { formatCurrency } = useCurrency()
  const [paidPromptId, setPaidPromptId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const clientMap = useMemo(() => new Map(clients.map(c => [c.id, c])), [clients])

  const overdue = useMemo(() => getOverdueJobs(activeJobs), [activeJobs])

  const mutate = async (jobId: string, patch: Record<string, unknown>) => {
    setBusyId(jobId)
    await store.updateJob(jobId, patch)
    await store.refreshJobs()
    setBusyId(null)
  }

  const onComplete = (job: Job) => {
    if (job.price > 0) { setPaidPromptId(job.id); return }
    mutate(job.id, { completed: true })
  }

  const confirmComplete = (job: Job, paid: boolean) => {
    setPaidPromptId(null)
    mutate(job.id, { completed: true, paid })
  }

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <p className="text-lg font-bold text-gray-900">Needs Follow Up</p>
        {overdue.length > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold text-white" style={{ backgroundColor: '#EF4444' }}>
            {overdue.length}
          </span>
        )}
      </div>

      {overdue.length === 0 ? (
        <div className="flex flex-col items-center py-8 text-center">
          <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center mb-2">
            <svg className="w-5 h-5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5 9-10" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-gray-500">All caught up!</p>
          <p className="text-xs text-gray-400 mt-0.5">No past jobs waiting for action</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-0.5">
          {overdue.map(job => {
            const client = job.clientId ? (clientMap.get(job.clientId) ?? null) : null
            const label = client?.name ?? job.title ?? 'Unnamed job'
            const isPaidPrompt = paidPromptId === job.id
            const isBusy = busyId === job.id

            return (
              <div key={job.id} className="rounded-xl border border-gray-100 bg-gray-50/60 dark:border-white/10 dark:bg-white/5 p-2.5">
                <div className="flex items-center gap-2.5 mb-2">
                  {client
                    ? <Avatar color={client.color} name={client.name} />
                    : <div className="w-9 h-9 rounded-full bg-gray-200 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-gray-900 truncate">{label}</p>
                    <p className="text-[11px] text-gray-400">{formatShortDate(job.date)}</p>
                  </div>
                  {job.price > 0 && (
                    <span className={`text-[12px] font-bold shrink-0 ${job.paid ? 'text-emerald-500 line-through' : 'text-gray-900'}`}>
                      {formatCurrency(job.price)}
                    </span>
                  )}
                </div>

                {isPaidPrompt ? (
                  <div className="rounded-lg bg-white border border-gray-200 p-2.5 space-y-1.5">
                    <p className="text-[12px] font-semibold text-gray-900">Was it paid?</p>
                    <p className="text-[11px] text-gray-400">{formatCurrency(job.price)} for this visit</p>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => confirmComplete(job, true)}
                        className="flex-1 py-1.5 rounded-lg text-[11.5px] font-semibold text-white bg-emerald-500 hover:bg-emerald-600"
                      >Yes, paid</button>
                      <button
                        onClick={() => confirmComplete(job, false)}
                        className="flex-1 py-1.5 rounded-lg text-[11.5px] font-semibold text-gray-700 bg-white border border-gray-200 hover:bg-gray-50"
                      >Not yet</button>
                      <button
                        onClick={() => setPaidPromptId(null)}
                        className="px-2.5 py-1.5 rounded-lg text-[11.5px] text-gray-400 hover:text-gray-600"
                      >✕</button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => onComplete(job)}
                    disabled={isBusy || busyId != null}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11.5px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 dark:text-emerald-300 dark:bg-emerald-500/15 dark:hover:bg-emerald-500/25 dark:border-emerald-400/25 disabled:opacity-40 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5 9-10" />
                    </svg>
                    Complete
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ═══ Jobs table (Earnings recent) ════════════════════════════════════════════

function JobsTable({ title, jobs, clientMap, onEdit }: {
  title: string
  jobs: Job[]
  clientMap: Map<string, Client>
  onEdit: (job: Job, client: Client | null) => void
}) {
  const { t } = useLanguage()
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <p className="text-lg font-bold text-gray-900">{title}</p>
      </div>
      {jobs.length === 0 && <p className="text-sm text-gray-400 py-8 text-center">{t('reports.web.nothingHereYet')}</p>}
      {jobs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                <th className="text-left py-2 pr-3">{t('addJob.labels.client')}</th>
                <th className="text-left py-2 px-3">{t('addJob.labels.date')}</th>
                <th className="text-right py-2 px-3">{t('clientDetail.stats.hours')}</th>
                <th className="text-right py-2 px-3">{t('reports.web.colAmount')}</th>
                <th className="text-right py-2 px-3">Status</th>
                <th className="text-right py-2 pl-3">Paid</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(j => {
                const client = j.clientId ? (clientMap.get(j.clientId) ?? null) : null
                const hours = j.actualDuration ?? j.duration ?? 0
                return (
                  <tr
                    key={j.id}
                    onClick={() => onEdit(j, client)}
                    className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"
                  >
                    <td className="py-3 pr-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {client ? <Avatar color={client.color} name={client.name} /> : <TaskAvatar />}
                        <p className="font-semibold text-gray-900 truncate">{client?.name ?? j.title ?? t('reports.web.unnamedJob')}</p>
                      </div>
                    </td>
                    <td className="py-3 px-3"><DateBadge date={j.date} tone="muted" /></td>
                    <td className="py-3 px-3 text-right text-gray-700">{formatHours(hours)}</td>
                    <td className="py-3 px-3 text-right">
                      <Money amount={j.price} />
                    </td>
                    <td className="py-3 px-3 text-right">
                      <CompletionChip completed={j.completed} price={j.price} />
                    </td>
                    <td className="py-3 pl-3 text-right">
                      <PaidChip completed={j.completed} paid={j.paid} price={j.price} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function CompletionChip({ completed, price }: { completed: boolean; price: number }) {
  if (completed) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold" style={{ color: BRAND, backgroundColor: BRAND + '15' }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: BRAND }} />
        Done
      </span>
    )
  }
  if (price > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold text-rose-600 bg-rose-50">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
        Follow Up
      </span>
    )
  }
  return <span className="text-[11px] text-gray-300">—</span>
}

function PaidChip({ completed, paid, price }: { completed: boolean; paid: boolean; price: number }) {
  if (!completed || !price) return <span className="text-[11px] text-gray-300">—</span>
  const color = paid ? BRAND : UNPAID
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold" style={{ color, backgroundColor: color + '15' }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {paid ? 'Paid' : 'Unpaid'}
    </span>
  )
}

// ═══ Charts ══════════════════════════════════════════════════════════════════

type LineSeries = { name: string; color: string; data: number[]; format: (v: number) => string }

function LineChart({ series, labels }: { series: LineSeries[]; labels: string[] }) {
  const { t } = useLanguage()
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const W = 800, H = 260
  const padL = 48, padR = 16, padT = 20, padB = 32
  const innerW = W - padL - padR
  const innerH = H - padT - padB

  const n = labels.length
  const xAt = (i: number) => n <= 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW

  const maxVal = Math.max(1, ...series.flatMap(s => s.data))
  const yAxis = niceAxis(maxVal, 4)
  const yMax = yAxis[yAxis.length - 1]
  const yAt = (v: number) => padT + innerH - (v / yMax) * innerH

  const hasData = series.some(s => s.data.some(v => v > 0))

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
        {yAxis.map((v, i) => (
          <g key={i}>
            {/* Grid lines were hardcoded #F1F5F9 — readable on a white card,
                blown out to solid white on a dark card. Route through the
                edge token so it greys out properly in dark mode. */}
            <line x1={padL} x2={W - padR} y1={yAt(v)} y2={yAt(v)} stroke="var(--color-edge-default)" strokeWidth={1} />
            <text x={padL - 8} y={yAt(v) + 4} textAnchor="end" fontSize={10} fill={TEXT_DIM}>
              {series[0]?.format(v) ?? v}
            </text>
          </g>
        ))}

        {labels.map((l, i) => (
          <text
            key={i}
            x={xAt(i)}
            y={H - 10}
            textAnchor="middle"
            fontSize={10}
            fill={hoverIdx === i ? 'var(--color-ink-primary)' : TEXT_DIM}
            fontWeight={hoverIdx === i ? 700 : 500}
          >
            {l}
          </text>
        ))}

        {hoverIdx != null && (
          <line x1={xAt(hoverIdx)} x2={xAt(hoverIdx)} y1={padT} y2={H - padB} stroke="var(--color-edge-default)" strokeWidth={1} strokeDasharray="3 3" />
        )}

        {series.map((s, si) => {
          if (s.data.every(v => v === 0)) return null
          const path = smoothPath(s.data.map((v, i) => [xAt(i), yAt(v)]))
          const area = `${path} L ${xAt(n - 1)} ${padT + innerH} L ${xAt(0)} ${padT + innerH} Z`
          const gradId = `grad-${si}`
          return (
            <g key={s.name}>
              <defs>
                <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              {si === 0 && <path d={area} fill={`url(#${gradId})`} />}
              <path d={path} stroke={s.color} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              {s.data.map((v, i) => (
                <circle key={i} cx={xAt(i)} cy={yAt(v)} r={hoverIdx === i ? 5 : 0} fill="white" stroke={s.color} strokeWidth={2.5} />
              ))}
            </g>
          )
        })}

        {labels.map((_, i) => (
          <rect
            key={i}
            x={xAt(i) - (innerW / Math.max(1, n - 1)) / 2}
            y={padT}
            width={innerW / Math.max(1, n - 1)}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
          />
        ))}
      </svg>

      {hoverIdx != null && hasData && (
        <div
          className="absolute pointer-events-none rounded-lg bg-gray-900 text-white text-xs font-semibold px-3 py-2 shadow-lg -translate-x-1/2 -translate-y-full"
          style={{
            left: `${(xAt(hoverIdx) / W) * 100}%`,
            top: `${(yAt(Math.max(...series.map(s => s.data[hoverIdx] ?? 0))) / H) * 100}%`,
          }}
        >
          <p className="text-[10px] opacity-70 mb-1">{labels[hoverIdx]}</p>
          {series.map(s => (
            <div key={s.name} className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="opacity-80">{s.name}:</span>
              <span>{s.format(s.data[hoverIdx] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}

      {!hasData && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 pointer-events-none">
          {t('reports.web.noActivityInRange')}
        </div>
      )}
    </div>
  )
}

// ═══ Top clients card ════════════════════════════════════════════════════════

function TopClientsCard({ windowed, clientMap, range }: {
  windowed: Job[]
  clientMap: Map<string, Client>
  range: Range
}) {
  const { t } = useLanguage()
  const { formatCurrency } = useCurrency()

  const ranked = useMemo(() => {
    const m = new Map<string, { client: Client; revenue: number; jobs: number }>()
    for (const j of windowed) {
      if (!j.clientId || !j.price) continue
      const client = clientMap.get(j.clientId)
      if (!client) continue
      const cur = m.get(j.clientId) ?? { client, revenue: 0, jobs: 0 }
      cur.revenue += j.price
      cur.jobs += 1
      m.set(j.clientId, cur)
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6)
  }, [windowed, clientMap])

  const maxRevenue = ranked[0]?.revenue ?? 0

  return (
    <Card>
      <div className="mb-4">
        <p className="text-lg font-bold text-gray-900">Top Clients</p>
        <p className="text-xs text-gray-400 mt-0.5">{rangeLabel(range, t)} · by revenue</p>
      </div>

      {ranked.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">{t('reports.web.nothingHereYet')}</p>
      ) : (
        <div className="space-y-3">
          {ranked.map(({ client, revenue, jobs }, i) => (
            <div key={client.id} className="flex items-center gap-3">
              <span className="text-[11px] font-bold text-gray-300 w-4 shrink-0 tabular-nums">{i + 1}</span>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-[11px] font-bold shrink-0" style={{ backgroundColor: client.color }}>
                {client.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-1 mb-1">
                  <p className="text-[13px] font-semibold text-gray-900 truncate">{client.name}</p>
                  <p className="text-[13px] font-bold text-gray-900 shrink-0 tabular-nums">{formatCurrency(revenue)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${maxRevenue > 0 ? (revenue / maxRevenue) * 100 : 0}%`, backgroundColor: BRAND }}
                    />
                  </div>
                  <p className="text-[10px] text-gray-400 shrink-0">{jobs} {jobs === 1 ? 'job' : 'jobs'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ═══ Helpers ═════════════════════════════════════════════════════════════════

function parseHHMM(s: string | null | undefined): number | null {
  if (!s || s === ALL_DAY) return null
  const [h, m] = s.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

function formatHHMM(s: string | null | undefined): string {
  const mins = parseHHMM(s)
  if (mins == null) return ''
  const h24 = Math.floor(mins / 60)
  const m = mins % 60
  const period = h24 >= 12 ? 'PM' : 'AM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

function addHoursToHHMM(start: string | null, hours: number): string {
  const s = parseHHMM(start)
  if (s == null) return ''
  const total = s + Math.round(hours * 60)
  const h = Math.floor(total / 60) % 24
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatTimeRange(start: string | null, end: string | null, durationHours: number): string {
  const startStr = formatHHMM(start)
  if (!startStr) return ''
  const endStr = end ? formatHHMM(end) : formatHHMM(addHoursToHHMM(start, durationHours))
  return endStr ? `${startStr} – ${endStr}` : startStr
}

function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00')
}

export function getOverdueJobs(activeJobs: Job[]): Job[] {
  const now = new Date()
  const todayISO = now.toISOString().slice(0, 10)
  const nowMins = now.getHours() * 60 + now.getMinutes()
  return activeJobs
    .filter(j => {
      if (j.completed || j.cancelled) return false
      if (j.date < todayISO) return true
      if (j.date === todayISO && j.startTime !== ALL_DAY) {
        const endMins = parseHHMM(j.endTime) ??
          (j.startTime ? (parseHHMM(j.startTime) ?? 0) + Math.round(j.duration * 60) : null)
        return endMins != null && nowMins > endMins
      }
      return false
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

function avatarInitials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '•'
}

function formatHours(n: number): string {
  if (!isFinite(n) || n === 0) return '0h'
  if (n >= 10) return `${Math.round(n)}h`
  return `${n.toFixed(1)}h`
}

function formatShortDate(s: string): string {
  if (!s) return '—'
  const d = parseDate(s)
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : '2-digit',
  })
}

function formatDateBadge(s: string): string {
  if (!s) return '—'
  const d = parseDate(s)
  const month = d.toLocaleDateString(undefined, { month: 'short' })
  const day = d.getDate()
  const year = String(d.getFullYear()).slice(-2)
  return `${month} ${day} '${year}`
}

function rangeLabel(r: Range, t: (key: string, options?: object) => string): string {
  return r === 'today'
    ? t('common.today')
    : r === 'week'
      ? t('earnings.thisWeek')
      : r === 'month'
        ? t('earnings.thisMonth')
        : t('earnings.thisYear')
}

function inRange(jobs: Job[], r: Range): Job[] {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  let start: Date
  if (r === 'today') start = new Date(today)
  else if (r === 'week') { start = new Date(today); start.setDate(today.getDate() - today.getDay()) }
  else if (r === 'month') start = new Date(today.getFullYear(), today.getMonth(), 1)
  else start = new Date(today.getFullYear(), 0, 1)
  return jobs.filter(j => parseDate(j.date) >= start)
}

/** Single earnings-over-time series for the selected range. */
function buildChartSeries(jobs: Job[], r: Range): { labels: string[]; values: number[] } {
  const today = new Date(); today.setHours(0, 0, 0, 0)

  type Bucket = { label: string; start: Date; end: Date }
  let buckets: Bucket[] = []

  if (r === 'today') {
    // Today as a 7-day strip with today emphasized — a single-point chart is useless.
    const start = new Date(today); start.setDate(today.getDate() - 6)
    buckets = Array.from({ length: 7 }, (_, i) => {
      const s = new Date(start); s.setDate(start.getDate() + i)
      const e = new Date(s); e.setHours(23, 59, 59, 999)
      return { label: i === 6 ? 'Today' : 'SMTWTFS'[s.getDay()], start: s, end: e }
    })
  } else if (r === 'week') {
    const sow = new Date(today); sow.setDate(today.getDate() - today.getDay())
    buckets = Array.from({ length: 7 }, (_, i) => {
      const s = new Date(sow); s.setDate(sow.getDate() + i)
      const e = new Date(s); e.setHours(23, 59, 59, 999)
      return { label: 'SMTWTFS'[s.getDay()], start: s, end: e }
    })
  } else if (r === 'month') {
    // This month, daily buckets. Label every 3rd day to keep X-axis legible.
    const som = new Date(today.getFullYear(), today.getMonth(), 1)
    const days = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    buckets = Array.from({ length: days }, (_, i) => {
      const s = new Date(som); s.setDate(som.getDate() + i)
      const e = new Date(s); e.setHours(23, 59, 59, 999)
      const dayNum = i + 1
      const label = dayNum === 1 || dayNum % 5 === 0 || dayNum === days ? String(dayNum) : ''
      return { label, start: s, end: e }
    })
  } else {
    // year
    buckets = Array.from({ length: 12 }, (_, m) => {
      const s = new Date(today.getFullYear(), m, 1)
      const e = new Date(today.getFullYear(), m + 1, 0, 23, 59, 59)
      return { label: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m], start: s, end: e }
    })
  }

  const values = new Array(buckets.length).fill(0)
  for (const j of jobs) {
    const d = parseDate(j.date)
    for (let i = 0; i < buckets.length; i++) {
      if (d >= buckets[i].start && d <= buckets[i].end) {
        values[i] += j.price
        break
      }
    }
  }
  return { labels: buckets.map(b => b.label), values }
}

function niceAxis(max: number, ticks: number): number[] {
  if (max <= 0) return [0, 1]
  const rough = max / ticks
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / mag
  let step: number
  if (norm < 1.5) step = 1 * mag
  else if (norm < 3) step = 2 * mag
  else if (norm < 7) step = 5 * mag
  else step = 10 * mag
  const top = Math.ceil(max / step) * step
  const out: number[] = []
  for (let v = 0; v <= top; v += step) out.push(v)
  return out
}

function smoothPath(points: [number, number][]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`
  const [first, ...rest] = points
  let d = `M ${first[0]} ${first[1]}`
  for (let i = 0; i < rest.length; i++) {
    const prev = points[i]
    const curr = points[i + 1]
    const next = points[i + 2] ?? curr
    const prev2 = points[i - 1] ?? prev
    const c1x = prev[0] + (curr[0] - prev2[0]) / 6
    const c1y = prev[1] + (curr[1] - prev2[1]) / 6
    const c2x = curr[0] - (next[0] - prev[0]) / 6
    const c2y = curr[1] - (next[1] - prev[1]) / 6
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${curr[0]} ${curr[1]}`
  }
  return d
}

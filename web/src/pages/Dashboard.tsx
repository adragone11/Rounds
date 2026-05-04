import { useState, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { useCurrency } from '../lib/currency'
import { useLanguage } from '../lib/language'
import { useProfile } from '../lib/profile'
import { useAuth } from '../lib/auth'
import type { Client } from '../types'
import type { Job } from '../lib/jobs'
import Confetti from '../components/Confetti'

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function getGreetingKey(): string {
  const h = new Date().getHours()
  if (h < 12) return 'home.greetings.morning'
  if (h < 17) return 'home.greetings.afternoon'
  return 'home.greetings.evening'
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtTime(hour: number, minute: number): string {
  const h = hour % 12 || 12
  const ampm = hour < 12 ? 'AM' : 'PM'
  return minute === 0 ? `${h}:00 ${ampm}` : `${h}:${String(minute).padStart(2, '0')} ${ampm}`
}

function fmtDuration(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function shortAddr(address: string): string {
  if (!address) return ''
  return address.split(',')[0].trim()
}

function recurrenceLabel(freq: string | undefined, t: (k: string) => string): string {
  switch (freq) {
    case 'weekly':   return t('recurrence.weekly')
    case 'biweekly': return t('recurrence.biWeekly')
    case 'monthly':  return t('recurrence.monthly')
    case 'custom':   return t('recurrence.custom')
    default:         return ''
  }
}

interface JobSlot {
  client: Client
  startMinute: number
  duration: number
  job: Job | null
  price: number
}

function buildJobSlots(
  clients: Client[],
  jobByClient: Map<string, Job>,
  store: { getClientDuration: (id: string) => number },
  startHour = 8,
): JobSlot[] {
  let cur = startHour * 60
  return clients.map(c => {
    const duration = store.getClientDuration(c.id)
    const job = jobByClient.get(c.id) ?? null
    const price = job?.price ?? 0
    const slot: JobSlot = { client: c, startMinute: cur, duration, job, price }
    cur += duration
    return slot
  })
}

export default function Dashboard() {
  const navigate = useNavigate()
  const store = useStore()
  const { formatCurrency } = useCurrency()
  const { t } = useLanguage()
  const { profile } = useProfile()
  const { user } = useAuth()
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [showConfetti, setShowConfetti] = useState(false)

  const now = new Date()
  const todayStr = fmtDate(now)
  const todayDow = now.getDay()

  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const tomorrowStr = fmtDate(tomorrow)
  const tomorrowDow = tomorrow.getDay()

  const todayClients = useMemo(() => store.getClientsForDate(todayStr), [store, todayStr])
  const tomorrowClients = useMemo(() => store.getClientsForDate(tomorrowStr), [store, tomorrowStr])
  const todayJobRows = useMemo(() => store.getJobsForDate(todayStr, now.getFullYear(), now.getMonth()), [store, todayStr, now])
  const tomorrowJobRows = useMemo(() => store.getJobsForDate(tomorrowStr, tomorrow.getFullYear(), tomorrow.getMonth()), [store, tomorrowStr, tomorrow])
  const todayJobByClient = useMemo(() => {
    const m = new Map<string, Job>()
    for (const j of todayJobRows) if (j.clientId) m.set(j.clientId, j)
    return m
  }, [todayJobRows])
  const tomorrowJobByClient = useMemo(() => {
    const m = new Map<string, Job>()
    for (const j of tomorrowJobRows) if (j.clientId) m.set(j.clientId, j)
    return m
  }, [tomorrowJobRows])
  const todayJobs = useMemo(() => buildJobSlots(todayClients, todayJobByClient, store), [todayClients, todayJobByClient, store])
  const tomorrowJobs = useMemo(() => buildJobSlots(tomorrowClients, tomorrowJobByClient, store), [tomorrowClients, tomorrowJobByClient, store])

  // Three-tier ordering for Today:
  //   0 = pending   (still on the queue, NEXT lives here)
  //   1 = completed (done, kept above cancelled so the user reads "what
  //                   actually happened" before "what didn't")
  //   2 = cancelled (no money, no work — drops to the bottom)
  // Stable sort preserves schedule order within each tier, so "NEXT" keeps
  // pointing at the next live job.
  const todayJobsSorted = useMemo(() => {
    const tier = (s: typeof todayJobs[number]) => {
      if (s.job?.cancelled) return 2
      if (s.job?.completed) return 1
      return 0
    }
    return [...todayJobs].sort((a, b) => tier(a) - tier(b))
  }, [todayJobs])

  const todayExpected = todayJobs.reduce((s, j) => s + (j.job?.cancelled ? 0 : j.price), 0)
  // Cancelled overrides completed — a cancelled visit is not a "finished" visit
  // even if the underlying flag is still set. Mirrors isEffectivelyComplete.
  const todayDoneCount = todayJobs.reduce((n, j) => n + (j.job?.completed && !j.job?.cancelled ? 1 : 0), 0)
  // Earned = collected. A job has to be marked paid to count — completion alone
  // doesn't move money. Cancelled jobs are excluded even if somehow flagged paid.
  const todayPaid = todayJobs.reduce((s, j) => s + (j.job?.paid && !j.job?.cancelled ? j.price : 0), 0)
  const selectedJob = selectedJobId ? todayJobs.find(j => j.client.id === selectedJobId) : null

  // This week: completed earnings + total job count breakdown
  const weekStats = useMemo(() => {
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay()); startOfWeek.setHours(0, 0, 0, 0)
    const endOfWeek = new Date(startOfWeek); endOfWeek.setDate(startOfWeek.getDate() + 7)
    let earned = 0, paid = 0, total = 0, done = 0
    for (const j of store.jobs) {
      if (j.deleted || j.cancelled || j.isTemplate) continue
      const d = new Date(j.date + 'T00:00:00')
      if (d < startOfWeek || d >= endOfWeek) continue
      total += 1
      if (j.completed) {
        earned += j.price
        done += 1
        if (j.paid) paid += j.price
      }
    }
    return { earned, paid, unpaid: earned - paid, total, done }
  }, [store.jobs, now])

  // Per-day jobs counts for the bar chart (Sun..Sat of current week)
  const weekDays = useMemo(() => {
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay()); startOfWeek.setHours(0, 0, 0, 0)
    const out: Array<{ dow: number; date: string; dayNum: number; count: number; isToday: boolean }> = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfWeek); d.setDate(startOfWeek.getDate() + i)
      const dateStr = fmtDate(d)
      const clients = store.getClientsForDate(dateStr)
      out.push({
        dow: d.getDay(),
        date: dateStr,
        dayNum: d.getDate(),
        count: clients.length,
        isToday: dateStr === todayStr,
      })
    }
    return out
  }, [store, now, todayStr])
  const maxWeekCount = Math.max(...weekDays.map(d => d.count), 1)

  // Unpaid total across all time (completed + !paid). $0 jobs are "no
  // charge" — surfacing them as unpaid is misleading (you end up with a
  // $0 total but a non-zero count, which reads like an alert).
  const unpaidStats = useMemo(() => {
    let total = 0, count = 0
    for (const j of store.jobs) {
      if (j.deleted || j.cancelled || j.isTemplate || !j.completed || j.paid) continue
      if (j.price <= 0) continue
      total += j.price
      count += 1
    }
    return { total, count }
  }, [store.jobs])

  // Past-due signal lives inline on each JobCard now (yellow !), not in a
  // separate panel. Computed cheaply from today's slots; tomorrow can't be
  // past-due. Indexed by client.id so JobCard lookups are O(1).
  const currentMin = now.getHours() * 60 + now.getMinutes()
  const pastDueByClient = useMemo(() => {
    const out = new Set<string>()
    for (const s of todayJobs) {
      if (!s.job || s.job.completed || s.job.cancelled) continue
      if (currentMin >= s.startMinute + s.duration) out.add(s.client.id)
    }
    return out
  }, [todayJobs, currentMin])

  const greeting = t(getGreetingKey())
  const firstName = (profile.fullName || user?.email?.split('@')[0] || '').split(/\s+/)[0]
  const eyebrow = `${t(`dashboard.daysFull.${DAY_KEYS[todayDow]}`)} · ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}`

  return (
    <div className="flex-1 overflow-auto bg-surface-page">
      <div className="px-8 pt-7 pb-14 max-w-[1400px] mx-auto">
        {/* Top header row */}
        <div className="grid gap-6 mb-5" style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px' }}>
          <div className="flex items-end justify-between gap-4 min-w-0">
            <div>
              <div className="text-xs font-semibold text-ink-secondary uppercase tracking-[0.08em] mb-1.5">
                {eyebrow}
              </div>
              <h1 className="text-[32px] font-bold tracking-[-0.02em] text-ink-primary leading-tight">
                {greeting}{firstName ? `, ${firstName}` : ''}
              </h1>
              <p className="text-[15px] text-ink-secondary mt-1.5">
                {todayClients.length > 0
                  ? `${todayClients.length} ${todayClients.length === 1 ? 'job' : 'jobs'} on deck · ${formatCurrency(todayExpected)} expected`
                  : t('home.emptyStates.noJobsToday')}
              </p>
            </div>
            <div className="flex gap-2.5 shrink-0">
              <Link
                to="/schedule"
                className="inline-flex items-center gap-1.5 bg-surface-card text-ink-primary border border-edge-default rounded-[10px] px-3.5 py-2.5 text-sm font-semibold hover:bg-gray-50 transition-colors"
              >
                <svg className="w-[15px] h-[15px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="19" r="2.5" />
                  <circle cx="18" cy="5" r="2.5" />
                  <path d="M8.5 19H15a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h6.5" />
                </svg>
                Route
              </Link>
              <button
                type="button"
                onClick={() => navigate('/schedule?action=addJob')}
                className="inline-flex items-center gap-1.5 bg-[#0A0A0C] text-white rounded-[10px] px-4 py-2.5 text-sm font-semibold hover:bg-black transition-colors shadow-sm"
              >
                <svg className="w-[15px] h-[15px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                New job
              </button>
            </div>
          </div>
          <div />
        </div>

        {/* Main 2-col grid */}
        <div className="grid gap-6 items-start" style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px' }}>
          {/* LEFT */}
          <div className="flex flex-col gap-5 min-w-0">
            {/* KPI strip */}
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
              <KPI label="Today" value={formatCurrency(todayPaid)} sub={`${todayDoneCount}/${todayClients.length} done`} accent="#16A34A" icon="trending-up" />
              <KPI label="Unpaid" value={formatCurrency(unpaidStats.total)} sub={`${unpaidStats.count} unpaid`} accent="#D97706" icon="alert-circle" />
              <KPI label="Clients" value={String(todayClients.length)} sub="scheduled today" accent="#7C3AED" icon="users" />
            </div>

            {/* Today's schedule */}
            <div>
              <div className="flex items-baseline justify-between mb-3 h-6">
                <h2 className="text-lg font-bold tracking-[-0.01em] m-0 text-ink-primary">
                  {t('home.sections.todaysSchedule')}
                </h2>
                <div className="flex items-center gap-3.5 text-[13px]">
                  <span className="text-ink-secondary">{todayDoneCount}/{todayClients.length} done</span>
                  <Link to="/schedule" className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:text-blue-700 transition-colors">
                    Open calendar
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </Link>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {todayClients.length > 0 ? (
                  todayJobsSorted.map((slot, i) => (
                    <JobCard
                      key={slot.client.id}
                      slot={slot}
                      isFirst={i === 0}
                      isSelected={selectedJobId === slot.client.id}
                      pastDue={pastDueByClient.has(slot.client.id)}
                      onClick={() => setSelectedJobId(selectedJobId === slot.client.id ? null : slot.client.id)}
                      formatCurrency={formatCurrency}
                    />
                  ))
                ) : (
                  <div className="bg-surface-card rounded-2xl py-10 text-center">
                    <p className="text-base font-semibold text-ink-primary">{t('dashboard.nothingScheduled')}</p>
                    <p className="text-sm text-ink-secondary mt-1 mb-4">{t('dashboard.enjoyDayOff')}</p>
                    <Link
                      to="/schedule"
                      className="inline-flex items-center gap-1.5 bg-[#0A0A0C] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-black transition-colors"
                    >
                      Open calendar
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                      </svg>
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT */}
          <div className="flex flex-col gap-6">
            {/* This week — bar chart */}
            <div className="bg-surface-card rounded-2xl p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_1px_3px_rgba(0,0,0,0.04)]">
              <div className="flex items-baseline justify-between mb-5">
                <SectionLabel>This week</SectionLabel>
                <Link to="/schedule" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700 transition-colors">
                  View all
                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </Link>
              </div>
              <div className="flex items-end justify-between gap-1 h-[120px]">
                {weekDays.map((d, i) => {
                  const h = d.count > 0 ? Math.max(10, (d.count / maxWeekCount) * 100) : 4
                  return (
                    <div
                      key={i}
                      className="relative flex-1 flex flex-col items-center gap-1.5 group cursor-pointer"
                    >
                      {/* ink-primary flips to a near-white in dark, so use
                          ink-inverse for the text — the pair always renders
                          a high-contrast pill in both themes. */}
                      <div className="absolute -top-7 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded-md bg-ink-primary text-ink-inverse text-[10px] font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none tabular-nums">
                        {d.count} {d.count === 1 ? 'job' : 'jobs'}
                      </div>
                      {/* Non-today bars: light pastels are designed for the
                          white card; on the dark card they wash out. Step the
                          has-jobs bar to a translucent blue and the empty bar
                          to a translucent white in dark. */}
                      <div
                        className={`w-[70%] rounded transition-colors group-hover:bg-blue-500 ${
                          d.isToday
                            ? 'bg-blue-500'
                            : d.count > 0
                              ? 'bg-[#CDD9F8] dark:bg-blue-500/35'
                              : 'bg-[#E9EAF0] dark:bg-white/10'
                        }`}
                        style={{ height: h }}
                      />
                      <div className={`text-[10px] font-semibold ${d.isToday ? 'text-blue-600' : 'text-ink-tertiary'}`}>
                        {DAY_LETTERS[d.dow]}
                      </div>
                      <div
                        className={`text-[11px] font-bold rounded-full ${d.isToday ? 'text-white px-1.5 py-px' : 'text-ink-secondary px-0 py-0'}`}
                        style={{ background: d.isToday ? '#3B82F6' : 'transparent' }}
                      >
                        {d.dayNum}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="mt-3.5 pt-3.5 border-t border-edge-default flex justify-between">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Earned</div>
                  <div className="text-lg font-bold mt-0.5 tabular-nums">{formatCurrency(weekStats.earned)}</div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Unpaid</div>
                  <div className={`text-lg font-bold mt-0.5 tabular-nums ${weekStats.unpaid > 0 ? 'text-amber-600' : ''}`}>
                    {formatCurrency(weekStats.unpaid)}
                  </div>
                </div>
              </div>
            </div>

            {/* Tomorrow */}
            <div className="bg-surface-card rounded-2xl p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_1px_3px_rgba(0,0,0,0.04)]">
              <div className="flex items-baseline justify-between mb-3">
                <SectionLabel>
                  {t('home.sections.tomorrow')} · {tomorrow.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </SectionLabel>
                <span className="text-xs text-ink-tertiary">{t(`dashboard.daysFull.${DAY_KEYS[tomorrowDow]}`)}</span>
              </div>
              {tomorrowClients.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {tomorrowJobs.map(slot => {
                    const h = Math.floor(slot.startMinute / 60)
                    const m = slot.startMinute % 60
                    return (
                      <div key={slot.client.id} className="flex items-center gap-2.5">
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                          style={{ backgroundColor: slot.client.color || '#6B7280' }}
                        >
                          {getInitials(slot.client.name)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-semibold text-ink-primary truncate">{slot.client.name}</div>
                        </div>
                        <div className="text-xs text-ink-secondary font-medium tabular-nums">{fmtTime(h, m)}</div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-sm text-ink-tertiary">{t('home.emptyStates.noJobsScheduled')}</p>
              )}
              <button
                type="button"
                onClick={() => navigate('/schedule?action=addJob')}
                className="mt-3 w-full py-2 text-[13px] font-medium bg-transparent border border-dashed border-edge-default text-ink-secondary rounded-[10px] hover:bg-gray-50 transition-colors"
              >
                + Add job
              </button>
            </div>

          </div>
        </div>
      </div>

      {selectedJob && (
        <ActionPanel
          slot={selectedJob}
          pastDue={pastDueByClient.has(selectedJob.client.id)}
          onClose={() => setSelectedJobId(null)}
          onComplete={async () => {
            if (!selectedJob.job) return
            // updateJobWithScope materializes virtual occurrences before
            // patching — direct store.updateJob would write per-occurrence
            // flags onto the template row when today's recurring instance
            // hasn't been materialized yet.
            if (selectedJob.job.completed) {
              await store.updateJobWithScope(selectedJob.job, { completed: false, paid: false }, 'this')
              setSelectedJobId(null)
              return
            }
            // Decide whether *this* completion will be the final one for the
            // day BEFORE the mutation fires — using todayJobs/tomorrowJobs as
            // they exist now (the in-memory snapshot still says "incomplete"
            // for this job, so we exclude it from the "every other complete"
            // check). Mirrors mobile's HomeScreen.tsx pre-mutation pattern.
            const jobDate = selectedJob.job.date
            let bucket: typeof todayJobs | null = null
            if (jobDate === todayStr) bucket = todayJobs
            else if (jobDate === fmtDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) bucket = tomorrowJobs
            let shouldCelebrate = false
            if (bucket && bucket.length > 0) {
              const others = bucket.filter(s => s.job?.id !== selectedJob.job!.id)
              shouldCelebrate = others.every(s => !!s.job?.completed && !s.job?.cancelled)
            }
            const paid = selectedJob.job.price > 0
              ? confirm(t('dashboard.paidPrompt', { price: formatCurrency(selectedJob.job.price) }))
              : false
            await store.updateJobWithScope(selectedJob.job, { completed: true, paid }, 'this')
            setSelectedJobId(null)
            if (shouldCelebrate) setShowConfetti(true)
          }}
          onCancel={async () => {
            if (!selectedJob.job) return
            await store.updateJobWithScope(selectedJob.job, { cancelled: !selectedJob.job.cancelled }, 'this')
            setSelectedJobId(null)
          }}
          onTogglePaid={async () => {
            if (!selectedJob.job) return
            await store.updateJobWithScope(selectedJob.job, { paid: !selectedJob.job.paid }, 'this')
            setSelectedJobId(null)
          }}
          onDelete={async () => {
            if (!selectedJob.job) return
            if (!confirm(`Delete this visit for ${selectedJob.client.name}? This cannot be undone.`)) return
            // Per-occurrence delete. syncCancelOccurrence soft-deletes a
            // real one-off or materializes a cancelled instance for a
            // virtual recurring slot — never touches the template.
            // Tasks (no clientId) aren't virtualized, so direct delete is safe.
            if (selectedJob.job.clientId) {
              await store.syncCancelOccurrence(selectedJob.job.clientId, selectedJob.job.date)
            } else {
              await store.deleteJob(selectedJob.job.id)
            }
            setSelectedJobId(null)
          }}
          onEdit={() => {
            if (!selectedJob.job) return
            navigate(`/schedule?jobId=${encodeURIComponent(selectedJob.job.id)}&date=${encodeURIComponent(selectedJob.job.date)}`)
          }}
        />
      )}
      {/* Conditionally mounted: Confetti unmounts via onAnimationEnd, so no
          lingering animations or GPU work after the celebration finishes. */}
      {showConfetti && <Confetti onAnimationEnd={() => setShowConfetti(false)} />}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold text-ink-tertiary uppercase tracking-[0.07em]">
      {children}
    </div>
  )
}

function KPI({ label, value, sub, accent, icon }: {
  label: string
  value: string
  sub: string
  accent: string
  icon: 'briefcase' | 'trending-up' | 'alert-circle' | 'users'
}) {
  const icons: Record<typeof icon, React.ReactNode> = {
    briefcase: (
      <>
        <rect x="3" y="7" width="18" height="14" rx="2" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M3 13h18" />
      </>
    ),
    'trending-up': (
      <>
        <path d="M3 17l6-6 4 4 8-8" />
        <path d="M14 7h7v7" />
      </>
    ),
    'alert-circle': (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16v.01" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M3 20c0-3 3-5 6-5s6 2 6 5" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M15 20c0-2 2-4 4-4s2.5 1 2.5 2" />
      </>
    ),
  }
  return (
    <div className="bg-surface-card rounded-[14px] px-[18px] py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex flex-col gap-1 relative overflow-hidden">
      <div className="flex items-center justify-between">
        <SectionLabel>{label}</SectionLabel>
        <div
          className="w-[26px] h-[26px] rounded-lg flex items-center justify-center"
          style={{ background: accent + '14', color: accent }}
        >
          <svg className="w-[14px] h-[14px]" fill="none" viewBox="0 0 24 24" stroke={accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            {icons[icon]}
          </svg>
        </div>
      </div>
      <div className="text-2xl font-bold tracking-[-0.02em] tabular-nums">{value}</div>
      <div className="text-xs text-ink-secondary">{sub}</div>
    </div>
  )
}

function JobCard({ slot, isFirst, isSelected, pastDue, onClick, formatCurrency }: {
  slot: JobSlot
  isFirst: boolean
  isSelected: boolean
  pastDue: boolean
  onClick: () => void
  formatCurrency: (n: number) => string
}) {
  const { t } = useLanguage()
  const { client, startMinute, duration, job, price } = slot
  const completed = !!job?.completed
  const cancelled = !!job?.cancelled
  const dim = completed || cancelled
  const sH = Math.floor(startMinute / 60)
  const sM = startMinute % 60
  const endMin = startMinute + duration
  const eH = Math.floor(endMin / 60)
  const eM = endMin % 60
  const recurring = client.frequency !== 'one-time'
  const paid = !!job?.paid

  return (
    <div
      onClick={onClick}
      className={`bg-surface-card rounded-[14px] cursor-pointer transition-all relative ${dim ? 'opacity-55' : ''} ${cancelled ? 'line-through' : ''} ${isSelected ? 'ring-2 ring-blue-500' : ''}`}
      style={{
        borderLeft: `4px solid ${client.color || '#9CA3AF'}`,
        padding: '16px',
        paddingLeft: '24px',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.04)',
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto auto auto',
        gap: 16,
        alignItems: 'center',
      }}
    >
      {/* Avatar */}
      <div
        className={`w-10 h-10 rounded-[11px] flex items-center justify-center text-white text-sm font-bold shrink-0 ${dim ? 'grayscale' : ''}`}
        style={{ backgroundColor: client.color || '#6B7280' }}
      >
        {getInitials(client.name)}
      </div>

      {/* Name + badges + address */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-[15px] font-bold text-ink-primary truncate">{client.name}</div>
          {pastDue && !completed && !cancelled && (
            <span
              className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-amber-400 text-white text-[11px] font-bold shrink-0"
              title="End time has passed — mark complete?"
              aria-label="Past due"
            >
              !
            </span>
          )}
          {isFirst && !completed && !cancelled && !pastDue && (
            <span className="text-[10px] font-bold text-blue-800 bg-blue-100 dark:bg-blue-500/15 dark:text-blue-300 px-[7px] py-0.5 rounded-md tracking-[0.04em] shrink-0">
              NEXT
            </span>
          )}
          {recurring && (
            <span className="inline-flex items-center gap-1 bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300 text-[11px] font-semibold px-1.5 py-0.5 rounded-md shrink-0">
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 2l4 4-4 4" />
                <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
                <path d="M7 22l-4-4 4-4" />
                <path d="M21 13v1a4 4 0 0 1-4 4H3" />
              </svg>
              {recurrenceLabel(client.frequency, t)}
            </span>
          )}
          {/* Cancelled is the trump status — DONE/PAID are suppressed under
              it, and a single CANCELLED badge takes the spot. */}
          {cancelled ? (
            <span className="text-[10px] font-bold text-red-700 bg-red-50 px-[7px] py-0.5 rounded-md tracking-[0.04em] shrink-0 no-underline">
              CANCELLED
            </span>
          ) : (
            <>
              {completed && (
                <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 dark:bg-emerald-500/15 dark:text-emerald-300 px-[7px] py-0.5 rounded-md tracking-[0.04em] shrink-0">
                  DONE
                </span>
              )}
              {paid && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 px-[7px] py-0.5 rounded-md tracking-[0.04em] shrink-0">
                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                  PAID
                </span>
              )}
            </>
          )}
        </div>
        {client.address && (
          <div className="text-[13px] text-ink-secondary mt-0.5 flex items-center gap-1.5 truncate">
            <svg className="w-2.5 h-2.5 text-ink-tertiary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s7-7.5 7-13a7 7 0 0 0-14 0c0 5.5 7 13 7 13z" />
              <circle cx="12" cy="9" r="2.5" />
            </svg>
            <span className="truncate">{shortAddr(client.address)}</span>
          </div>
        )}
      </div>

      {/* Time block — start–end */}
      <div className="text-right">
        <div className="text-[14px] font-bold tracking-[-0.01em] text-ink-primary tabular-nums whitespace-nowrap">
          {fmtTime(sH, sM)} – {fmtTime(eH, eM)}
        </div>
        <div className="text-[11px] text-ink-tertiary mt-0.5">{fmtDuration(duration)}</div>
      </div>

      {/* $ pill — cancelled visits don't move money, so the pill goes
          struck-through and grey. Mirrors countablePrice() in lib/jobs.ts. */}
      {price > 0 && (
        <div className={`px-2.5 py-[5px] rounded-full text-[13px] font-bold tabular-nums ${
          cancelled
            ? 'bg-gray-100 text-gray-400 line-through'
            : 'bg-emerald-50 text-emerald-700'
        }`}>
          {formatCurrency(price)}
        </div>
      )}

      {/* More */}
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onClick() }}
        className="bg-gray-100 border-0 rounded-[10px] w-[34px] h-[34px] flex items-center justify-center text-ink-secondary hover:bg-gray-200 transition-colors"
        aria-label="Job actions"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="5" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          <circle cx="19" cy="12" r="1.5" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}

function ActionPanel({ slot, pastDue, onClose, onComplete, onCancel, onTogglePaid, onDelete, onEdit }: {
  slot: JobSlot
  pastDue: boolean
  onClose: () => void
  onComplete: () => void
  onCancel: () => void
  onTogglePaid: () => void
  onDelete: () => void
  onEdit: () => void
}) {
  const { t } = useLanguage()
  const { client, startMinute, job } = slot
  const completed = !!job?.completed
  const cancelled = !!job?.cancelled
  const paid = !!job?.paid
  const h = Math.floor(startMinute / 60)
  const m = startMinute % 60
  const now = new Date()

  const openDirections = () => {
    if (client.lat && client.lng) {
      window.open(`https://maps.apple.com/?daddr=${client.lat},${client.lng}`, '_blank')
    } else if (client.address) {
      window.open(`https://maps.apple.com/?daddr=${encodeURIComponent(client.address)}`, '_blank')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative bg-surface-card w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden ring-1 ring-edge-default"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-5 pb-4 border-b border-edge-default">
          <div className="flex items-start justify-between">
            <div className="min-w-0">
              <p className="text-lg font-bold text-ink-primary truncate">{client.name}</p>
              <p className="text-sm text-ink-secondary mt-0.5 tabular-nums">
                {now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {fmtTime(h, m)}
              </p>
              {client.address && <p className="text-sm text-ink-tertiary mt-0.5 truncate">{client.address}</p>}
            </div>
            <button onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 text-ink-tertiary shrink-0 -mr-1">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="p-3 space-y-1">
          <button
            onClick={onComplete}
            className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors ${
              completed
                ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            }`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            {completed ? 'Mark not done' : t('home.actionPanel.quickComplete')}
            {pastDue && !completed && (
              <span
                className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-amber-400 text-white text-[11px] font-bold"
                title="End time has passed"
                aria-label="Past due"
              >
                !
              </span>
            )}
          </button>
          <ActionBtn
            icon="edit"
            label="Edit job"
            subtitle="Open on the calendar to change time, price, or notes"
            onClick={onEdit}
          />
          <ActionBtn icon="nav" label={t('home.actionPanel.getDirections')} onClick={openDirections} />
          <ActionBtn
            icon="paid"
            label={paid ? 'Mark unpaid' : 'Mark paid'}
            subtitle={paid ? 'Already collected' : 'Customer has paid for this visit'}
            onClick={onTogglePaid}
          />
          <ActionBtn
            icon="cancel"
            label={cancelled ? t('dashboard.restoreJob') : t('home.actionPanel.cancelJob')}
            subtitle={cancelled ? t('dashboard.restoreJobDesc') : t('dashboard.cancelJobDesc')}
            onClick={onCancel}
          />
          <ActionBtn
            icon="trash"
            label="Delete job"
            subtitle="Permanently remove this visit"
            destructive
            onClick={onDelete}
          />
        </div>
      </div>
    </div>
  )
}

function ActionBtn({ icon, label, subtitle, onClick, destructive }: {
  icon: string; label: string; subtitle?: string; onClick: () => void; destructive?: boolean
}) {
  const icons: Record<string, React.ReactNode> = {
    nav: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>,
    cancel: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    paid: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    trash: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>,
    edit: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" /></svg>,
  }

  // Per-icon tinting. Edit/paid/nav get color cues so the eye lands on the
  // most-used actions; cancel stays muted (paired with destructive intent),
  // trash stays red.
  const tints: Record<string, string> = {
    edit: 'bg-blue-50 text-blue-600',
    paid: 'bg-emerald-50 text-emerald-600',
    nav: 'bg-violet-50 text-violet-600',
    cancel: 'bg-gray-100 text-ink-secondary',
    trash: 'bg-gray-100 text-ink-secondary',
  }
  const tint = destructive ? 'bg-red-50 text-red-600' : (tints[icon] ?? 'bg-gray-100 text-ink-secondary')

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-left ${destructive ? 'hover:bg-red-50' : 'hover:bg-gray-50'}`}
    >
      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${tint}`}>
        {icons[icon]}
      </div>
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${destructive ? 'text-red-700' : 'text-ink-primary'}`}>{label}</p>
        {subtitle && <p className="text-[11px] text-ink-secondary truncate">{subtitle}</p>}
      </div>
    </button>
  )
}

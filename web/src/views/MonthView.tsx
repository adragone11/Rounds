import type { DragEvent, RefObject } from 'react'
import type { ProposedMove, Frequency } from '../types'
import type { Job } from '../lib/jobs'
import MonthCalendar from '../components/MonthCalendar'
import type { MonthCalendarChip } from '../components/MonthCalendar'
import { DEFAULT_AVATAR_COLOR, RANK_COLORS } from '../theme'
import { getDaysInMonth, dateKey } from '../lib/scheduleHelpers'

type ClientLike = { id: string; name: string; color: string; frequency?: Frequency; startDate?: string | null }
type StoreLike = {
  clients: ClientLike[]
  jobs: Job[]
  getClientsForDate: (date: string) => ClientLike[]
  getJobsForDate: (date: string, year: number, month: number) => Job[]
  createJobFromPlacement: (clientId: string, anchor: string, freq: Frequency) => Promise<string | null>
  refreshJobs: () => Promise<unknown>
}

/**
 * Continuous-scroll month view. Stacks every month in `monthsList`
 * vertically and feeds each one a chip map built from placements + jobs.
 *
 * The chip click handler materializes a job on-demand (so a click on a
 * virtual recurrence becomes a real row before toggle).
 */
export function MonthView({
  monthsList,
  monthsScrollRef,
  monthSectionRefs,
  store,
  today,
  selectedDate,
  selectedClientDates,
  dragOverDate,
  suggestionDateRank,
  previewMoves,
  dayColors,
  onDayClick,
  onDayViewClick,
  onChipDragStart,
  onCellDragOver,
  onCellDragLeave,
  onCellDrop,
  toggleJob,
}: {
  monthsList: { y: number; m: number }[]
  monthsScrollRef: RefObject<HTMLDivElement | null>
  monthSectionRefs: RefObject<Record<string, HTMLElement | null>>
  store: StoreLike
  today: Date
  selectedDate: string | null
  selectedClientDates: Set<string>
  dragOverDate: string | null
  suggestionDateRank: Map<string, number>
  previewMoves: ProposedMove[]
  dayColors: string[]
  onDayClick: (date: string) => void
  onDayViewClick: (date: string) => void
  onChipDragStart: (e: DragEvent, clientId: string, date: string) => void
  onCellDragOver: (e: DragEvent, date: string) => void
  onCellDragLeave: () => void
  onCellDrop: (e: DragEvent, date: string) => void
  toggleJob: (job: Job) => void
}) {
  const buildChipsForMonth = (y: number, m: number): Record<string, MonthCalendarChip[]> => {
    const chipsByDate: Record<string, MonthCalendarChip[]> = {}
    const dim = getDaysInMonth(y, m)
    for (let day = 1; day <= dim; day++) {
      const date = dateKey(y, m, day)
      const dayOfWeek = new Date(date + 'T00:00:00').getDay()
      const dayClients = store.getClientsForDate(date)
      const dayJobs = store.getJobsForDate(date, y, m)
      const chips: MonthCalendarChip[] = []
      const jobByClient = new Map<string, Job>()
      for (const j of dayJobs) if (j.clientId) jobByClient.set(j.clientId, j)
      for (const c of dayClients) {
        const cj = jobByClient.get(c.id)
        // Prefer the per-job color (editable from EditJobModal) over the
        // client default — lets users recolor a single visit without
        // touching the client.
        chips.push({
          clientId: c.id,
          clientName: c.name,
          color: cj?.avatarColor || c.color || DEFAULT_AVATAR_COLOR,
          day: dayOfWeek,
          jobId: cj?.id,
          completed: cj?.completed,
          cancelled: cj?.cancelled,
        })
      }
      const placedIds = new Set(dayClients.map(c => c.id))
      for (const j of dayJobs) {
        if (j.clientId && placedIds.has(j.clientId)) continue
        const label = j.title
          ?? (j.clientId ? (store.clients.find(c => c.id === j.clientId)?.name ?? 'Client') : 'Visit')
        chips.push({
          clientId: j.id,
          clientName: label,
          color: j.avatarColor ?? DEFAULT_AVATAR_COLOR,
          day: dayOfWeek,
          readonly: true,
          jobId: j.id,
          completed: j.completed,
          cancelled: j.cancelled,
        })
      }
      if (chips.length > 0) chipsByDate[date] = chips
    }
    return chipsByDate
  }

  const calPreviewMoves = previewMoves.map(m => ({
    clientId: m.clientId,
    clientName: m.clientName,
    suggestedDay: m.suggestedDay,
    dayColor: dayColors[m.suggestedDay],
  }))
  const previewCrossingIds = new Set(previewMoves.map(m => m.clientId))

  const handleChipClick = async (chip: MonthCalendarChip, date: string) => {
    // Resolve the month from the chip's date so click works in any
    // visible month, not just the current one.
    const cd = new Date(date + 'T00:00:00')
    const cy = cd.getFullYear()
    const cm = cd.getMonth()
    if (chip.jobId) {
      const job = store.getJobsForDate(date, cy, cm).find(j => j.id === chip.jobId)
        ?? store.jobs.find(j => j.id === chip.jobId)
      if (job) toggleJob(job)
      return
    }
    const client = store.clients.find(c => c.id === chip.clientId)
    if (!client) return
    const freq = client.frequency ?? 'weekly'
    const anchor = client.startDate ?? date
    const newId = await store.createJobFromPlacement(chip.clientId, anchor, freq)
    if (!newId) return
    await store.refreshJobs()
    const healed = store.getJobsForDate(date, cy, cm)
      .find(j => j.clientId === chip.clientId)
      ?? store.jobs.find(j => j.id === newId)
    if (healed) toggleJob(healed)
  }

  return (
    <div ref={monthsScrollRef} className="flex-1 overflow-y-auto">
      {monthsList.map(({ y, m }) => {
        const key = `${y}-${m}`
        return (
          <section
            key={key}
            ref={el => { monthSectionRefs.current[key] = el }}
            data-month={key}
            className="flex flex-col"
          >
            <MonthCalendar
              year={y}
              month={m}
              chipsByDate={buildChipsForMonth(y, m)}
              today={today}
              showMonthLabel
              onDayClick={onDayClick}
              selectedDate={selectedDate}
              selectedClientDates={selectedClientDates}
              dragOverDate={dragOverDate}
              suggestionDateRank={suggestionDateRank}
              onChipDragStart={onChipDragStart}
              onChipClick={handleChipClick}
              onCellDragOver={onCellDragOver}
              onCellDragLeave={onCellDragLeave}
              onCellDrop={onCellDrop}
              onDayViewClick={onDayViewClick}
              previewMoves={calPreviewMoves}
              previewCrossingClientIds={previewCrossingIds}
              rankColors={RANK_COLORS}
            />
          </section>
        )
      })}
    </div>
  )
}

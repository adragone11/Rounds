import { useEffect, useRef } from 'react'
import type { DragEvent } from 'react'
import type { Job } from '../lib/jobs'
import type { AddJobOverlay } from '../hooks/useAddJobOverlay'
import { isAddJobDraftValid } from '../components/AddJobPanel'
import { AddJobPreviewCard } from '../components/AddJobPreviewCard'
import { DEFAULT_AVATAR_COLOR } from '../theme'
import {
  DAY_VIEW_END_HOUR,
  dateKey,
  parseHHmm,
  fmtHHmm,
  fmtAmPm,
  fmtDuration,
  initialsOf,
  pastelBg,
} from '../lib/scheduleHelpers'

const DAY_HOURS = Array.from({ length: 24 }, (_, i) => i)
const HOUR_PX = 64
const DAY_START_HOUR = DAY_HOURS[0]!
const DEFAULT_SCROLL_HOUR = 7
const dayHourLabel = (h: number) => (h === 0 ? '12 AM' : h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`)

type ClientLike = { id: string; name: string; address: string; color: string }
type StoreLike = {
  clients: ClientLike[]
  getClientsForDate: (date: string) => ClientLike[]
  getJobsForDate: (date: string, year: number, month: number) => Job[]
}

/**
 * Single-day timeline. Doubles as the Add-Job time picker: when the
 * overlay is active and the draft is valid, clicking on the empty grid
 * drops a 60-minute preview card at the clicked time which can then be
 * resized or moved (see AddJobPreviewCard).
 */
export function DayView({
  focusDate,
  today,
  store,
  dragOverDate,
  dayColors,
  addJob,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  toggleJob,
}: {
  focusDate: Date
  today: Date
  store: StoreLike
  dragOverDate: string | null
  dayColors: string[]
  addJob: AddJobOverlay
  onDragStart: (e: DragEvent, clientId: string, sourceDate: string) => void
  onDragOver: (e: DragEvent, date: string) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent, date: string) => void
  toggleJob: (job: Job) => void
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Default the scroll position to 7 AM so the long pre-dawn band isn't
  // what the user sees first; they can scroll up for early-morning slots.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: DEFAULT_SCROLL_HOUR * HOUR_PX })
  }, [])

  const date = dateKey(focusDate.getFullYear(), focusDate.getMonth(), focusDate.getDate())
  const dayClients = store.getClientsForDate(date)
  const dayJobs = store.getJobsForDate(date, focusDate.getFullYear(), focusDate.getMonth())
  const jobByClient = new Map<string, Job>()
  for (const j of dayJobs) if (j.clientId) jobByClient.set(j.clientId, j)
  const taskJobs = dayJobs.filter(j => !j.clientId)
  const dayOfWeek = focusDate.getDay()
  const isOver = date === dragOverDate

  const {
    active: addJobActive,
    draft: addJobDraft,
    previewDate: addJobPreviewDate,
    start: addJobStart,
    end: addJobEnd,
    resizing: addJobResizing,
    dayTimelineRef,
    yToHHmm,
    setStart: setAddJobStart,
    setEnd: setAddJobEnd,
    setPreviewDate: setAddJobPreviewDate,
  } = addJob

  // Add-job preview card geometry (only on the active date).
  const addJobOnThisDate = addJobActive && addJobPreviewDate === date
  const addJobStartMin = parseHHmm(addJobStart)
  const addJobEndMin = parseHHmm(addJobEnd)
  const addJobValidTimes = addJobStartMin !== null && addJobEndMin !== null && addJobEndMin > addJobStartMin
  const addJobCardTop = addJobValidTimes
    ? Math.max(0, ((addJobStartMin! - DAY_START_HOUR * 60) / 60) * HOUR_PX)
    : 0
  const addJobCardHeight = addJobValidTimes
    ? Math.max(28, ((addJobEndMin! - addJobStartMin!) / 60) * HOUR_PX)
    : 64
  const addJobClient = addJobDraft.clientId
    ? store.clients.find(c => c.id === addJobDraft.clientId) ?? null
    : null
  const addJobCardColor = addJobClient?.color ?? '#EC4899'

  const isToday = date === dateKey(today.getFullYear(), today.getMonth(), today.getDate())
  const totalJobs = dayClients.length + taskJobs.length
  const dayLong = focusDate.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase()
  const dateLong = focusDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })

  return (
    <div
      ref={scrollRef}
      className={`flex-1 overflow-y-auto transition-colors ${isOver ? 'bg-blue-50' : ''}`}
      onDragOver={e => onDragOver(e, date)}
      onDragLeave={onDragLeave}
      onDrop={e => onDrop(e, date)}
    >
      {/* Header */}
      <div className="px-6 pt-5 pb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-ink-tertiary uppercase tracking-[0.12em] flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: dayColors[dayOfWeek] }} />
            {dayLong}
          </p>
          <h2 className="text-[26px] font-bold text-ink-primary leading-tight mt-1">{dateLong}</h2>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[11px] font-semibold text-ink-tertiary uppercase tracking-[0.12em]">Scheduled</p>
          <p className="text-[18px] font-bold text-ink-primary mt-0.5">
            {totalJobs} {totalJobs === 1 ? 'job' : 'jobs'}
          </p>
        </div>
      </div>

      {/* Timeline grid */}
      <div
        ref={dayTimelineRef}
        className={`relative ${addJobActive && isAddJobDraftValid(addJobDraft) ? 'cursor-pointer' : ''}`}
        onClick={(e) => {
          if (!addJobActive || !isAddJobDraftValid(addJobDraft)) return
          if (addJobResizing) return
          // Ignore clicks on existing job cards / overlays — only fire when
          // the empty grid background is clicked.
          const target = e.target as HTMLElement
          if (target.closest('[data-day-grid-skip]')) return
          const t = yToHHmm(e.clientY)
          if (!t) return
          const startMin = parseHHmm(t)!
          const endMin = Math.min(DAY_VIEW_END_HOUR * 60 + 45, startMin + 60)
          setAddJobPreviewDate(date)
          setAddJobStart(t)
          setAddJobEnd(fmtHHmm(endMin))
        }}
      >
        {/* Hour rows. The bottom hairline uses an alpha-white in dark mode
            (instead of solid gray-50) so it doesn't read as a stack of
            bright stripes against the near-black timeline. */}
        {DAY_HOURS.map(h => (
          <div key={h} className="flex h-16 border-b border-gray-50 dark:border-white/[0.04]">
            <div className="w-16 shrink-0 flex items-start justify-end pr-3 pt-1 border-r border-gray-100">
              <span className="text-[11px] text-gray-400 font-medium">{dayHourLabel(h)}</span>
            </div>
            <div className="flex-1" />
          </div>
        ))}

        {addJobOnThisDate && addJobValidTimes && (
          <AddJobPreviewCard
            overlay={addJob}
            cardTop={addJobCardTop}
            cardHeight={addJobCardHeight}
            color={addJobCardColor}
            client={addJobClient}
            startMin={addJobStartMin!}
            endMin={addJobEndMin!}
          />
        )}

        {/* Client + task blocks (absolute, aligned to start time) */}
        {dayClients.length === 0 && taskJobs.length === 0 ? (
          <div className="absolute top-0 left-16 right-0 text-center pt-20 pointer-events-none">
            <p className="text-ink-tertiary text-sm">No clients scheduled</p>
            <p className="text-ink-tertiary/60 text-xs mt-1">Drag a client from the sidebar to schedule</p>
          </div>
        ) : (
          <div data-day-grid-skip className="absolute top-0 left-16 right-0 px-4">
            {dayClients.map(client => {
              const job = jobByClient.get(client.id)
              const completed = !!job?.completed
              const cancelled = !!job?.cancelled
              const color = job?.avatarColor || client.color || DEFAULT_AVATAR_COLOR
              const startHHmm = job?.startTime ?? '09:00'
              const startMin = parseHHmm(startHHmm) ?? 9 * 60
              const durationHours = job?.duration ?? 1
              const durationMin = Math.round(durationHours * 60)
              const top = ((startMin - DAY_START_HOUR * 60) / 60) * HOUR_PX
              const height = Math.max(56, durationHours * HOUR_PX) - 6
              const price = job?.price ?? 0
              return (
                <div
                  key={client.id}
                  draggable
                  onDragStart={e => onDragStart(e, client.id, date)}
                  onClick={e => { if (job) { e.stopPropagation(); toggleJob(job) } }}
                  className={`absolute left-0 right-0 rounded-2xl px-4 py-3 flex items-center gap-3 transition-shadow hover:shadow-sm ${job ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} ${cancelled ? 'opacity-40 line-through' : ''}`}
                  style={{
                    top,
                    height,
                    backgroundColor: pastelBg(color),
                    borderLeft: `4px solid ${color}`,
                  }}
                >
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-[12px] font-bold text-white shrink-0"
                    style={{ backgroundColor: color }}
                  >
                    {completed ? '✓' : initialsOf(client.name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] font-semibold truncate" style={{ color }}>
                      {client.name}
                    </p>
                    <p className="text-[12px] mt-0.5 truncate" style={{ color }}>
                      {fmtAmPm(startMin)} · {fmtDuration(durationMin)}
                      {client.address && ` · ${client.address}`}
                    </p>
                  </div>
                  {cancelled ? (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-red-50 text-red-700 shrink-0 no-underline">
                      Cancelled
                    </span>
                  ) : price > 0 && (
                    <p className="text-[15px] font-bold shrink-0" style={{ color }}>
                      ${Math.round(price)}
                    </p>
                  )}
                </div>
              )
            })}

            {taskJobs.map(j => {
              const color = j.avatarColor || DEFAULT_AVATAR_COLOR
              const startHHmm = j.startTime ?? '09:00'
              const startMin = parseHHmm(startHHmm) ?? 9 * 60
              const durationHours = j.duration || 1
              const durationMin = Math.round(durationHours * 60)
              const top = ((startMin - DAY_START_HOUR * 60) / 60) * HOUR_PX
              const height = Math.max(56, durationHours * HOUR_PX) - 6
              return (
                <div
                  key={j.id}
                  onClick={() => toggleJob(j)}
                  className={`absolute left-0 right-0 rounded-2xl px-4 py-3 flex items-center gap-3 cursor-pointer hover:shadow-sm transition-shadow ${j.cancelled ? 'opacity-40 line-through' : ''}`}
                  style={{
                    top,
                    height,
                    backgroundColor: pastelBg(color),
                    borderLeft: `4px solid ${color}`,
                  }}
                >
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-[12px] font-bold text-white shrink-0"
                    style={{ backgroundColor: color }}
                  >
                    {j.completed ? '✓' : initialsOf(j.title ?? 'Task')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] font-semibold truncate" style={{ color }}>
                      {j.title ?? 'Task'}
                    </p>
                    <p className="text-[12px] mt-0.5 truncate" style={{ color }}>
                      {fmtAmPm(startMin)} · {fmtDuration(durationMin)}
                    </p>
                  </div>
                  {j.cancelled ? (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-red-50 text-red-700 shrink-0 no-underline">
                      Cancelled
                    </span>
                  ) : j.price > 0 && (
                    <p className="text-[15px] font-bold shrink-0" style={{ color }}>
                      ${Math.round(j.price)}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* NOW indicator — only on today, only when "now" is in the visible window. */}
        {isToday && (() => {
          const nowMin = today.getHours() * 60 + today.getMinutes()
          const top = ((nowMin - DAY_START_HOUR * 60) / 60) * HOUR_PX
          if (top < 0 || top > DAY_HOURS.length * HOUR_PX) return null
          return (
            <div className="absolute left-0 right-0 pointer-events-none z-20" style={{ top }}>
              <div className="absolute right-3 -top-4 text-[10px] font-bold uppercase tracking-wider text-orange-600">
                Now · {fmtAmPm(nowMin)}
              </div>
              <div className="absolute left-[60px] -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-orange-500" />
              <div className="absolute left-[68px] right-0 h-px bg-orange-500" />
            </div>
          )
        })()}
      </div>
    </div>
  )
}

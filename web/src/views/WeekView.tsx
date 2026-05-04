import { useEffect, useRef } from 'react'
import type { DragEvent } from 'react'
import type { Job } from '../lib/jobs'
import { DAY_ABBREV as DAYS, DEFAULT_AVATAR_COLOR } from '../theme'
import { dateKey, parseHHmm, pastelBg, fmtStartTime } from '../lib/scheduleHelpers'

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const HOUR_PX = 56 // h-14
const WEEK_START_MIN = HOURS[0]! * 60
const TIMELINE_HEIGHT = HOURS.length * HOUR_PX
const DEFAULT_SCROLL_HOUR = 7

const hourLabel = (h: number) => (h === 0 ? '12 AM' : h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`)

type ClientLike = { id: string; name: string; address: string; color: string }
type StoreLike = {
  getClientsForDate: (date: string) => ClientLike[]
  getJobsForDate: (date: string, year: number, month: number) => Job[]
}

function getWeekDates(focus: Date): Date[] {
  const d = new Date(focus)
  const sunday = new Date(d)
  sunday.setDate(d.getDate() - d.getDay())
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(sunday)
    x.setDate(sunday.getDate() + i)
    return x
  })
}

/**
 * 7-column timeline view (Sun–Sat). Today's column gets the filled black
 * day pill + an orange "now" line; every column accepts drops and
 * supports click-to-select.
 */
export function WeekView({
  focusDate,
  today,
  store,
  selectedDate,
  dragOverDate,
  onDateClick,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  toggleJob,
}: {
  focusDate: Date
  today: Date
  store: StoreLike
  selectedDate: string | null
  dragOverDate: string | null
  onDateClick: (date: string) => void
  onDragStart: (e: DragEvent, clientId: string, sourceDate: string) => void
  onDragOver: (e: DragEvent, date: string) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent, date: string) => void
  toggleJob: (job: Job) => void
}) {
  const weekDates = getWeekDates(focusDate)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Park the scroll at 7 AM so the long pre-dawn band isn't what
  // the user lands on first.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: DEFAULT_SCROLL_HOUR * HOUR_PX })
  }, [])

  const blockGeometry = (startHHmm: string | null, durationHours: number) => {
    const startMin = parseHHmm(startHHmm ?? '09:00') ?? 9 * 60
    const top = ((startMin - WEEK_START_MIN) / 60) * HOUR_PX
    const height = Math.max(28, durationHours * HOUR_PX)
    return { top, height }
  }

  return (
    <>
      {/* Day headers */}
      <div className="grid shrink-0 border-b border-edge-default bg-white dark:bg-surface-page" style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
        <div className="border-r border-edge-default" />
        {weekDates.map((d, i) => {
          const isTd = d.toDateString() === today.toDateString()
          return (
            <div key={i} className="px-2 py-3 text-center border-r border-edge-default last:border-r-0">
              <p className="text-[10px] text-ink-tertiary font-semibold uppercase tracking-wider">{DAYS[d.getDay()]}</p>
              <p className={`text-[18px] font-bold mt-1 ${isTd ? 'text-white bg-black rounded-full w-8 h-8 flex items-center justify-center mx-auto' : 'text-ink-primary'}`}>
                {d.getDate()}
              </p>
            </div>
          )
        })}
      </div>

      {/* Timeline + day columns */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-white dark:bg-surface-page">
        <div className="grid relative" style={{ gridTemplateColumns: '56px repeat(7, 1fr)', height: TIMELINE_HEIGHT }}>
          {/* Time labels column */}
          <div className="border-r border-edge-default relative">
            {HOURS.map((h, idx) => (
              <div
                key={h}
                className="absolute left-0 right-0 pr-2 text-right"
                style={{ top: idx * HOUR_PX - 7 }}
              >
                <span className="text-[10px] text-ink-tertiary font-medium">{hourLabel(h)}</span>
              </div>
            ))}
          </div>

          {weekDates.map((d, i) => {
            const date = dateKey(d.getFullYear(), d.getMonth(), d.getDate())
            const dayClients = store.getClientsForDate(date)
            const dayJobs = store.getJobsForDate(date, d.getFullYear(), d.getMonth())
            const jobByClient = new Map<string, Job>()
            for (const j of dayJobs) if (j.clientId) jobByClient.set(j.clientId, j)
            const taskJobs = dayJobs.filter(j => !j.clientId)
            const isOver = date === dragOverDate
            const isToday = d.toDateString() === today.toDateString()

            return (
              <div
                key={i}
                className={`border-r border-edge-default last:border-r-0 transition-colors relative ${
                  isOver ? 'bg-blue-50 ring-2 ring-inset ring-blue-300'
                  : selectedDate === date ? 'bg-blue-50/40 dark:bg-blue-500/[0.08]'
                  : 'hover:bg-gray-50/60 dark:hover:bg-white/[0.03]'
                }`}
                onClick={() => onDateClick(date)}
                onDragOver={e => onDragOver(e, date)}
                onDragLeave={onDragLeave}
                onDrop={e => onDrop(e, date)}
              >
                {/* Hour grid lines */}
                {HOURS.map((h, idx) => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 border-t border-gray-100"
                    style={{ top: idx * HOUR_PX }}
                  />
                ))}

                {/* Now line — only on today's column */}
                {isToday && (() => {
                  const nowMin = today.getHours() * 60 + today.getMinutes()
                  const top = ((nowMin - WEEK_START_MIN) / 60) * HOUR_PX
                  if (top < 0 || top > TIMELINE_HEIGHT) return null
                  return (
                    <div className="absolute left-0 right-0 pointer-events-none z-10" style={{ top }}>
                      <div className="h-px bg-orange-500" />
                    </div>
                  )
                })()}

                {/* Client blocks */}
                {dayClients.map(client => {
                  const job = jobByClient.get(client.id)
                  const completed = !!job?.completed
                  const cancelled = !!job?.cancelled
                  const color = job?.avatarColor || client.color || DEFAULT_AVATAR_COLOR
                  const startHHmm = job?.startTime ?? null
                  const duration = job?.duration ?? 1
                  const { top, height } = blockGeometry(startHHmm, duration)
                  const price = job?.price ?? 0
                  return (
                    <div
                      key={client.id}
                      draggable
                      onDragStart={e => onDragStart(e, client.id, date)}
                      onClick={e => { if (job) { e.stopPropagation(); toggleJob(job) } }}
                      className={`absolute left-1 right-1 rounded-[10px] overflow-hidden ${job ? 'cursor-pointer hover:brightness-95' : 'cursor-grab active:cursor-grabbing'} ${cancelled ? 'opacity-40 line-through' : completed ? 'opacity-70' : ''}`}
                      style={{
                        top,
                        height,
                        backgroundColor: pastelBg(color),
                        borderLeft: `3px solid ${color}`,
                      }}
                      title={`${client.name}${client.address ? ` · ${client.address}` : ''}`}
                    >
                      <div className="px-2 pt-1.5 pb-1">
                        <p className="text-[11px] font-semibold leading-tight truncate" style={{ color }}>
                          {completed && <span className="mr-0.5">✓ </span>}
                          {client.name}
                        </p>
                        <p className="text-[10px] mt-0.5 leading-tight truncate" style={{ color }}>
                          {fmtStartTime(startHHmm)}
                          {!cancelled && price > 0 && ` · $${Math.round(price)}`}
                          {cancelled && ' · Cancelled'}
                        </p>
                      </div>
                    </div>
                  )
                })}

                {/* Title-only task jobs (no client) */}
                {taskJobs.map(j => {
                  const color = j.avatarColor || DEFAULT_AVATAR_COLOR
                  const { top, height } = blockGeometry(j.startTime, j.duration || 1)
                  return (
                    <div
                      key={j.id}
                      onClick={e => { e.stopPropagation(); toggleJob(j) }}
                      className={`absolute left-1 right-1 rounded-[10px] overflow-hidden cursor-pointer hover:brightness-95 ${j.cancelled ? 'opacity-40 line-through' : j.completed ? 'opacity-70' : ''}`}
                      style={{
                        top,
                        height,
                        backgroundColor: pastelBg(color),
                        borderLeft: `3px solid ${color}`,
                      }}
                    >
                      <div className="px-2 pt-1.5 pb-1">
                        <p className="text-[11px] font-semibold leading-tight truncate" style={{ color }}>
                          {j.completed && <span className="mr-0.5">✓ </span>}
                          {j.title ?? 'Task'}
                        </p>
                        <p className="text-[10px] mt-0.5 leading-tight truncate" style={{ color }}>
                          {fmtStartTime(j.startTime)}
                          {!j.cancelled && j.price > 0 && ` · $${Math.round(j.price)}`}
                          {j.cancelled && ' · Cancelled'}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

import { useState, useMemo } from 'react'
import type { GridCell } from '../types'
import { useStore } from '../store'
import { COLOR_PALETTE } from '../theme'
import { useTheme } from '../lib/theme'

// ── Constants ──

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PIXELS_PER_MINUTE = 1.5 // 90px per hour

interface WeekTimeGridProps {
  grid: Map<string, GridCell[]>
  activeDays: number[]
  durationMap: Map<string, number>
  /** Optional: per-cell leg times (minutes). Key = "week-day". Array = [home→c1, c1→c2, …]. */
  legTimes?: Map<string, number[]>
  /** Optional: per-cell total drive minutes (home → … → last). */
  cellDriveMinutes?: Map<string, number>
  dayStartMinutes?: number
  dayEndMinutes?: number
  maxJobsPerDay: number
  selectedClientId: string | null
  onClientClick?: (clientId: string) => void
  onDayClick?: (dayIndex: number) => void
  selectedDay: number | null
  unplacedClients?: Array<{ id: string; name: string; color: string; frequency?: string }>
  /** True only after the user has run Auto Sort. Pre-Auto-Sort, the bench is the
   *  initial roster (manual-first flow), not engine-rejected clients — so the
   *  "couldn't fit" banner and suggestion copy must stay hidden. */
  hasRunAutoSort?: boolean
  onPlaceClient?: (clientId: string, dayIndex: number) => void
  onRemoveClient?: (clientId: string) => void
  benchHasClients?: boolean
  /** Top 3 day suggestions for the currently selected bench client. Empty when none selected or none fit. */
  benchSuggestions?: Array<{ day: number; dayName: string; cadenceLabel: string; rotation: 0 | 1; nearestNeighborMin: number; nearbyCount: number; capacityLeft: number; wouldOverflow: boolean }>
  onPlaceBenchClient?: (clientId: string, dayIndex: number, rotation?: 0 | 1) => void
  onRaiseMaxJobs?: () => void
  maxJobsPerDayForBench?: number
  changedClientIds?: Set<string>
  clientFromDay?: Map<string, number>
  suggestedDays?: Map<string, { day: number; label: string }>
  onWeekChange?: (week: number | null) => void
  showAllWeeksOption?: boolean
  onReorderClients?: (day: number, week: number, orderedClientIds: string[]) => void
  /** Confirm the current schedule plan (proceeds to the Transition workspace). */
  onConfirmSchedule?: () => void
}

type DerivedBlock = GridCell & {
  top: number
  height: number
  startMinutes: number
  duration: number
  overflows: boolean
}

const hourLabel = (h: number) =>
  h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`

export default function WeekTimeGrid({
  grid,
  activeDays,
  durationMap,
  legTimes,
  cellDriveMinutes,
  dayStartMinutes = 480,
  dayEndMinutes = 1020,
  maxJobsPerDay,
  selectedClientId,
  onClientClick,
  onDayClick,
  selectedDay,
  unplacedClients,
  hasRunAutoSort,
  onPlaceClient,
  onRemoveClient,
  benchHasClients,
  benchSuggestions,
  onPlaceBenchClient,
  onRaiseMaxJobs,
  maxJobsPerDayForBench,
  changedClientIds,
  clientFromDay,
  suggestedDays,
  onWeekChange,
  showAllWeeksOption,
  onReorderClients,
  onConfirmSchedule,
}: WeekTimeGridProps) {
  const store = useStore()
  const DAY_COLORS = store.dayColors
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [activeWeek, setActiveWeek] = useState(0)
  const [showAllOnMap, setShowAllOnMap] = useState(true)
  const [dragOverDay, setDragOverDay] = useState<number | null>(null)
  const [editingColorDay, setEditingColorDay] = useState<number | null>(null)
  // Collapse state for the bench panel — defaults to open. The grabber strip
  // and the count header act as the toggle target.
  const [benchOpen, setBenchOpen] = useState(true)
  // Roster filter + search — internal UI state, no need to persist.
  type RosterFilter = 'all' | 'weekly' | 'biweekly' | 'monthly'
  const [rosterFilter, setRosterFilter] = useState<RosterFilter>('all')
  const [rosterSearch, setRosterSearch] = useState('')

  // Reorder state — drag within a column
  const [reorderDragIdx, setReorderDragIdx] = useState<{ day: number; fromIdx: number } | null>(null)
  const [reorderHoverIdx, setReorderHoverIdx] = useState<number | null>(null)

  const totalMinutes = dayEndMinutes - dayStartMinutes
  const gridHeight = totalMinutes * PIXELS_PER_MINUTE

  const hours = useMemo(() => {
    const start = Math.floor(dayStartMinutes / 60)
    const end = Math.ceil(dayEndMinutes / 60)
    const result: number[] = []
    for (let h = start; h <= end; h++) result.push(h)
    return result
  }, [dayStartMinutes, dayEndMinutes])

  const deriveBlocks = (cells: GridCell[]): DerivedBlock[] => {
    let currentMinutes = 0
    return cells.map(cell => {
      const duration = durationMap.get(cell.clientId) ?? 60
      const top = currentMinutes * PIXELS_PER_MINUTE
      const height = duration * PIXELS_PER_MINUTE
      const startMinutes = dayStartMinutes + currentMinutes
      currentMinutes += duration
      const overflows = startMinutes + duration > dayEndMinutes
      return { ...cell, top, height, startMinutes, duration, overflows }
    })
  }

  // Derive week count from grid keys (supports custom recurrence > 4 weeks)
  const weekCount = useMemo(() => {
    let max = 3 // minimum 4 weeks (0-3)
    for (const key of grid.keys()) {
      const week = parseInt(key.split('-')[0])
      if (week > max) max = week
    }
    return max + 1
  }, [grid])

  const weekIndices = useMemo(() =>
    Array.from({ length: weekCount }, (_, i) => i),
  [weekCount])

  // Precompute week summaries
  const weekSummaries = useMemo(() => {
    return weekIndices.map(week => {
      let total = 0
      const dayCounts: { day: number; count: number }[] = []
      for (const day of activeDays) {
        const key = `${week}-${day}`
        const count = (grid.get(key) ?? []).length
        dayCounts.push({ day, count })
        total += count
      }
      return { dayCounts, total }
    })
  }, [grid, activeDays, weekIndices])

  // Compute per-day counts for the active week
  const dayCountsForWeek = useMemo(() => {
    const counts = new Map<number, number>()
    for (const day of activeDays) {
      const key = `${activeWeek}-${day}`
      counts.set(day, (grid.get(key) ?? []).length)
    }
    return counts
  }, [grid, activeDays, activeWeek])

  return (
    <div className="flex flex-col h-full bg-gray-50/50 dark:bg-zinc-900">
      {/* Week selector — combined mini bar + tabs */}
      <div className="flex items-center gap-1 px-3 py-2.5 bg-white dark:bg-zinc-900 border-b border-gray-200/80 dark:border-white/10">
        {weekIndices.map(week => {
          const isActive = activeWeek === week
          const { dayCounts, total } = weekSummaries[week]
          return (
            <button
              key={week}
              onClick={() => {
                setActiveWeek(week)
                setShowAllOnMap(false)
                onWeekChange?.(week)
              }}
              className={`flex-1 flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-150 ${
                isActive && !showAllOnMap
                  ? 'bg-gray-900 shadow-md shadow-gray-900/20 dark:bg-white/15'
                  : 'bg-white hover:bg-gray-50 border border-gray-200/60 dark:bg-white/5 dark:hover:bg-white/10 dark:border-white/10'
              }`}
            >
              <span className={`text-xs font-bold tracking-tight ${isActive && !showAllOnMap ? 'text-white' : 'text-gray-500 dark:text-gray-300'}`}>
                W{week + 1}
              </span>
              <div className="flex gap-px flex-1">
                {dayCounts.map(({ day, count }) => (
                  <div
                    key={day}
                    className="flex-1 h-1.5 rounded-full"
                    style={{
                      backgroundColor: count > 0
                        // Inactive bars in dark mode use a higher alpha (~75%) so day
                        // colors stay vivid against the dark surface; light mode keeps
                        // the original ~30% wash.
                        ? isActive && !showAllOnMap ? DAY_COLORS[day] : DAY_COLORS[day] + (isDark ? 'BF' : '50')
                        : isActive && !showAllOnMap ? 'rgba(255,255,255,0.15)' : (isDark ? 'rgba(255,255,255,0.08)' : '#E5E7EB'),
                    }}
                  />
                ))}
              </div>
              <span className={`text-[10px] font-bold tabular-nums ${
                isActive && !showAllOnMap ? 'text-white/70' : 'text-gray-400 dark:text-gray-500'
              }`}>
                {total}
              </span>
            </button>
          )
        })}
        {showAllWeeksOption && (
          <button
            onClick={() => {
              setShowAllOnMap(true)
              onWeekChange?.(null)
            }}
            className={`px-3 py-2 rounded-lg text-xs font-bold tracking-tight transition-all duration-150 ${
              showAllOnMap
                ? 'bg-gray-900 text-white shadow-md shadow-gray-900/20 dark:bg-white/15'
                : 'bg-white text-gray-500 hover:bg-gray-50 border border-gray-200/60 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10 dark:border-white/10'
            }`}
          >
            All
          </button>
        )}
      </div>

      {/* Day column headers */}
      <div className="flex border-b border-gray-200/80 bg-white dark:bg-zinc-900 dark:border-white/10 shrink-0 relative">
        <div className="w-11 shrink-0" />
        {activeDays.map(day => {
          const count = dayCountsForWeek.get(day) ?? 0
          const atCapacity = count >= maxJobsPerDay
          const isSelected = selectedDay === day
          const dayTotal = cellDriveMinutes?.get(`${activeWeek}-${day}`)
          return (
            <button
              key={day}
              onClick={() => onDayClick?.(day)}
              className={`flex-1 py-2.5 text-center transition-all duration-150 border-r border-gray-100 dark:border-white/5 ${
                isSelected ? 'bg-gray-50 dark:bg-white/8' : 'hover:bg-gray-50/50 dark:hover:bg-white/5'
              }`}
            >
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  setEditingColorDay(editingColorDay === day ? null : day)
                }}
                className="inline-block text-[11px] font-extrabold tracking-wide uppercase cursor-pointer hover:opacity-70 transition-opacity"
                style={{ color: DAY_COLORS[day] }}
                title={`Change ${DAYS[day]} color`}
              >
                {DAYS[day]}
              </span>
              <div className="flex items-center justify-center gap-1 mt-0.5">
                <span className={`text-[10px] font-bold tabular-nums ${
                  atCapacity ? 'text-red-500' : 'text-gray-400 dark:text-gray-500'
                }`}>
                  {count}
                </span>
                <span className="text-[10px] text-gray-300 dark:text-white/20">/</span>
                <span className="text-[10px] text-gray-300 dark:text-white/30">{maxJobsPerDay}</span>
              </div>
              {typeof dayTotal === 'number' && dayTotal > 0 && (
                <div className="mt-0.5 text-[9px] text-gray-400 font-medium tabular-nums">
                  {dayTotal >= 60 ? `${Math.floor(dayTotal / 60)}h ${dayTotal % 60}m` : `${dayTotal}m`} drive
                </div>
              )}
              {selectedClientId && suggestedDays?.get(selectedClientId)?.day === day && (
                <span className="inline-block mt-1 text-[8px] font-bold text-green-600 bg-green-50 px-1.5 py-0.5 rounded-full">
                  closest
                </span>
              )}
            </button>
          )
        })}
        {editingColorDay !== null && (
          <div
            className="absolute top-full left-1/2 -translate-x-1/2 mt-1 z-30 bg-white border border-gray-200 rounded-lg shadow-lg p-3"
            style={{ minWidth: 280 }}
          >
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] text-gray-600">
                Color for <span className="font-semibold text-gray-800">{DAYS[editingColorDay]}</span>
              </p>
              <button
                type="button"
                onClick={() => {
                  store.resetDayColors()
                  setEditingColorDay(null)
                }}
                className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
              >
                Reset all
              </button>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {COLOR_PALETTE.map(({ name, hex }) => {
                const selected = DAY_COLORS[editingColorDay] === hex
                return (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => {
                      store.setDayColor(editingColorDay, hex)
                      setEditingColorDay(null)
                    }}
                    className={`h-7 rounded transition-all ${
                      selected ? 'ring-2 ring-gray-900 ring-offset-1' : 'hover:scale-105'
                    }`}
                    style={{ backgroundColor: hex }}
                    title={name}
                    aria-label={name}
                  />
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Time grid — scrollable */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden relative">
        {/* Empty-state hint card — only when no manual placements yet AND
            Auto Sort hasn't run. Auto-hides on first drop or first Auto Sort. */}
        {!hasRunAutoSort && grid.size === 0 && unplacedClients && unplacedClients.length > 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 px-6">
            <div className="pointer-events-auto max-w-md w-full rounded-2xl bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10 shadow-lg px-5 py-4">
              <p className="text-sm text-gray-700 dark:text-gray-200 leading-snug">
                <span className="font-bold text-blue-600 dark:text-blue-400">Auto Sort</span>
                {' '}will organize your schedule by location. You can adjust it after.
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-snug mt-2">
                Or place a client first to lock them in on a specific day of the week
              </p>
            </div>
          </div>
        )}
        <div className="flex" style={{ height: gridHeight }}>
          {/* Time labels */}
          <div className="w-11 shrink-0 relative">
            {hours.map(h => {
              const top = (h * 60 - dayStartMinutes) * PIXELS_PER_MINUTE
              return (
                <div
                  key={h}
                  className="absolute left-0 right-0 text-[10px] text-gray-400 text-right pr-2 font-medium"
                  style={{ top, transform: 'translateY(-6px)' }}
                >
                  {hourLabel(h)}
                </div>
              )
            })}
          </div>

          {/* Day columns */}
          {activeDays.map(day => {
            const key = `${activeWeek}-${day}`
            const rawCells = grid.get(key) ?? []

            // Apply visual reorder if dragging within this column
            let cells = rawCells
            if (reorderDragIdx && reorderDragIdx.day === day && reorderHoverIdx !== null && reorderHoverIdx !== reorderDragIdx.fromIdx) {
              const arr = [...rawCells]
              const [moved] = arr.splice(reorderDragIdx.fromIdx, 1)
              arr.splice(reorderHoverIdx, 0, moved)
              cells = arr
            }
            const blocks = deriveBlocks(cells)

            return (
              <div
                key={day}
                onDragOver={(e) => { e.preventDefault(); setDragOverDay(day) }}
                onDragLeave={() => setDragOverDay(null)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOverDay(null)
                  const clientId = e.dataTransfer.getData('clientId')
                  if (clientId) onPlaceClient?.(clientId, day)
                }}
                className={`flex-1 relative border-r border-gray-100/80 dark:border-white/5 transition-colors duration-100 ${
                  selectedDay === day ? 'bg-white/80 dark:bg-white/5' : ''
                } ${dragOverDay === day ? 'bg-blue-50/60 dark:bg-blue-500/15' : ''}`}
              >
                {/* Hour gridlines */}
                {hours.map(h => {
                  const top = (h * 60 - dayStartMinutes) * PIXELS_PER_MINUTE
                  return (
                    <div
                      key={h}
                      className="absolute left-0 right-0 border-t border-gray-200/50"
                      style={{ top }}
                    />
                  )
                })}

                {/* Client blocks */}
                {blocks.map((block, blockIdx) => {
                  const isSelected = selectedClientId === block.clientId
                  const isMoved = changedClientIds?.has(block.clientId)
                  const fromDay = isMoved ? clientFromDay?.get(block.clientId) : undefined
                  const isDragging = reorderDragIdx?.day === day && reorderDragIdx?.fromIdx === blockIdx
                  const recBadge =
                    block.recurrence === 'biweekly'
                      ? block.rotation === 0 ? 'A' : 'B'
                      : block.recurrence === 'monthly'
                        ? 'M'
                        : block.recurrence === 'weekly'
                          ? 'W'
                          : block.recurrence === 'custom'
                            ? 'C'
                            : block.recurrence === 'one-time'
                              ? '1'
                              : null
                  const showTime = block.height >= 40
                  const startH = Math.floor(block.startMinutes / 60)
                  const startM = block.startMinutes % 60
                  const timeStr = `${hourLabel(startH).replace(' ', '')}${startM > 0 ? `:${String(startM).padStart(2, '0')}` : ''}`
                  const color = DAY_COLORS[day]

                  return (
                    <div
                      key={block.clientId}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('clientId', block.clientId)
                        e.dataTransfer.setData('sourceDay', String(day))
                        e.dataTransfer.effectAllowed = 'move'
                        // Find original index in rawCells for reorder tracking
                        const origIdx = rawCells.findIndex(c => c.clientId === block.clientId)
                        setReorderDragIdx({ day, fromIdx: origIdx >= 0 ? origIdx : blockIdx })
                      }}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        // Only do reorder preview if dragging within the same column
                        if (reorderDragIdx && reorderDragIdx.day === day) {
                          const origIdx = rawCells.findIndex(c => c.clientId === block.clientId)
                          if (origIdx >= 0 && origIdx !== reorderHoverIdx) {
                            setReorderHoverIdx(origIdx)
                          }
                        }
                      }}
                      onDragEnd={() => {
                        // Commit the reorder
                        if (reorderDragIdx && reorderDragIdx.day === day && reorderHoverIdx !== null && reorderHoverIdx !== reorderDragIdx.fromIdx && onReorderClients) {
                          const arr = [...rawCells]
                          const [moved] = arr.splice(reorderDragIdx.fromIdx, 1)
                          arr.splice(reorderHoverIdx, 0, moved)
                          onReorderClients(day, activeWeek, arr.map(c => c.clientId))
                        }
                        setReorderDragIdx(null)
                        setReorderHoverIdx(null)
                      }}
                      onClick={() => onClientClick?.(block.clientId)}
                      className={`absolute left-1.5 right-1.5 rounded-lg text-left transition-all duration-150 overflow-hidden group cursor-grab active:cursor-grabbing ${
                        isSelected
                          ? 'ring-2 ring-gray-900 ring-offset-1 z-10 scale-[1.02]'
                          : 'hover:brightness-110 hover:shadow-md'
                      } ${block.overflows ? 'border-2 border-red-400' : ''}`}
                      style={{
                        top: block.top,
                        height: Math.max(block.height, 22),
                        background: `linear-gradient(135deg, ${color}, ${color}dd)`,
                        opacity: isDragging ? 0.4 : 1,
                        boxShadow: isSelected
                          ? undefined
                          : `0 1px 3px ${color}30, inset 0 1px 0 rgba(255,255,255,0.15)`,
                        borderLeft: isMoved && fromDay !== undefined && fromDay >= 0 ? `3px solid ${DAY_COLORS[fromDay]}` : undefined,
                      }}
                    >
                      <div className="px-2 py-1 h-full flex flex-col justify-center">
                        <p className="text-[10px] font-semibold text-white truncate leading-tight drop-shadow-sm">
                          {block.clientName}
                        </p>
                        {isMoved && fromDay !== undefined ? (
                          <p className="text-[9px] font-bold text-white/80 truncate leading-tight mt-0.5">
                            {fromDay === -1 ? 'new' : `from ${DAYS[fromDay]}`}
                          </p>
                        ) : showTime ? (
                          <p className="text-[9px] text-white/60 truncate leading-tight mt-0.5">
                            {timeStr}
                          </p>
                        ) : null}
                      </div>
                      {recBadge && (
                        <span className="absolute top-1 right-1.5 text-[7px] font-bold text-white/90 bg-black/15 px-1 py-px rounded">
                          {recBadge}
                        </span>
                      )}
                      {/* Remove button — visible on hover */}
                      {onRemoveClient && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onRemoveClient(block.clientId) }}
                          className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/30 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                          title="Move to bench"
                        >
                          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )
                })}

                {/* Drive-time chips between consecutive blocks */}
                {legTimes && (() => {
                  const legs = legTimes.get(`${activeWeek}-${day}`) ?? []
                  // legs[0] = home→block0, legs[i] = block(i-1)→block(i)
                  return blocks.map((block, i) => {
                    const leg = legs[i]
                    if (leg == null || leg === 0) return null
                    let top: number
                    if (i === 0) {
                      // Home → first block: sit INSIDE the top of block0 as
                      // a floating badge. Placing above clips against the
                      // grid's scroll container / day header.
                      top = block.top + 3
                    } else {
                      // Mid-gap between previous and current
                      const prev = blocks[i - 1]
                      const prevBottom = prev.top + Math.max(prev.height, 22)
                      const gap = block.top - prevBottom
                      if (gap < 14) return null // no room for chip
                      top = prevBottom + gap / 2 - 7
                    }
                    return (
                      <div
                        key={`leg-${block.clientId}`}
                        className="absolute left-1/2 -translate-x-1/2 text-[9px] font-semibold text-gray-600 bg-white border border-gray-200 rounded-full px-1.5 py-px shadow-sm tabular-nums pointer-events-none z-10"
                        style={{ top }}
                        title={i === 0 ? `Home → ${block.clientName}` : `${blocks[i - 1].clientName} → ${block.clientName}`}
                      >
                        {i === 0 ? '🏠 ' : ''}{leg}m
                      </div>
                    )
                  })
                })()}

                {/* Add zone — always visible at bottom of each column when bench has clients */}
                {(benchHasClients || dragOverDay === day) && (
                  <button
                    onClick={() => {
                      if (selectedClientId) onPlaceClient?.(selectedClientId, day)
                    }}
                    className={`absolute inset-x-1.5 h-10 rounded-lg border-2 border-dashed flex items-center justify-center z-20 transition-colors ${
                      dragOverDay === day
                        ? 'border-blue-400 bg-blue-50/60 dark:bg-blue-500/15 dark:border-blue-400/60'
                        : 'border-gray-300 bg-gray-50/40 hover:border-gray-400 hover:bg-gray-50/80 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20 dark:hover:bg-white/8'
                    }`}
                    style={{ top: blocks.length > 0 ? `${blocks[blocks.length - 1].top + Math.max(blocks[blocks.length - 1].height, 22) + 6}px` : '6px' }}
                  >
                    <span className={`text-[10px] font-bold ${dragOverDay === day ? 'text-blue-600 dark:text-blue-300' : 'text-gray-400 dark:text-gray-500'}`}>
                      + Add here
                    </span>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Roster panel — always rendered when an unplacedClients list exists.
          Pre-Auto-Sort: full client roster (manual staging). Post-Auto-Sort:
          remaining clients that couldn't fit. When everyone is placed, panel
          becomes a success card with a Confirm CTA. */}
      {unplacedClients && (() => {
        // Counts per recurrence — drive the filter pill labels and the "N left"
        // header. Computed once per render against the canonical bench list.
        const counts = {
          all: unplacedClients.length,
          weekly: unplacedClients.filter(c => c.frequency === 'weekly').length,
          biweekly: unplacedClients.filter(c => c.frequency === 'biweekly').length,
          monthly: unplacedClients.filter(c => c.frequency === 'monthly').length,
        }
        const search = rosterSearch.trim().toLowerCase()
        // Normalize the filter at render-time: if the active cadence no longer
        // has any clients (e.g. user placed the last weekly), fall back to "all"
        // instead of stranding the user on an empty filter with no visible pill.
        const effectiveFilter: RosterFilter = rosterFilter !== 'all' && counts[rosterFilter] === 0 ? 'all' : rosterFilter
        const filtered = unplacedClients.filter(c => {
          if (effectiveFilter !== 'all' && c.frequency !== effectiveFilter) return false
          if (search && !c.name.toLowerCase().includes(search)) return false
          return true
        })
        const allPlaced = unplacedClients.length === 0
        // Only render pills for cadences that actually have clients in the bench;
        // hide the rest so the filter rail doesn't lie about what's available.
        // "All" stays visible whenever there's >1 distinct cadence to filter across.
        const cadencePills: Array<{ key: Exclude<RosterFilter, 'all'>; label: string }> = [
          { key: 'weekly', label: 'Weekly' },
          { key: 'biweekly', label: 'Biweekly' },
          { key: 'monthly', label: 'Monthly' },
        ]
        const visibleCadences = cadencePills.filter(p => counts[p.key] > 0)
        const filterPills: Array<{ key: RosterFilter; label: string }> = visibleCadences.length > 1
          ? [{ key: 'all', label: 'All' }, ...visibleCadences]
          : visibleCadences
        return (
        <div className={`shrink-0 border-t rounded-t-2xl shadow-[0_-12px_32px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_-12px_32px_-12px_rgba(0,0,0,0.6)] ${hasRunAutoSort && !allPlaced ? 'border-amber-200/70 bg-amber-50/80 dark:border-amber-400/25 dark:bg-amber-500/10' : 'border-gray-200 bg-white dark:border-white/10 dark:bg-zinc-900/80'}`}>
          {/* Toggle strip — clicking the grabber or the title row collapses/expands the panel. */}
          <button
            type="button"
            onClick={() => setBenchOpen(o => !o)}
            aria-expanded={benchOpen}
            className="w-full px-4 pt-2 pb-2 flex flex-col items-center gap-1 cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/5 transition-colors rounded-t-2xl"
          >
            <span className="block h-1 w-10 rounded-full bg-gray-300 dark:bg-white/15" />
            <span className="w-full flex items-center justify-between">
              {allPlaced ? (
                <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">All clients placed!</span>
              ) : (
                <span className="text-xs font-bold text-gray-800 dark:text-gray-100 flex items-center gap-1.5">
                  <span>{hasRunAutoSort ? "Couldn't fit" : 'Clients'}</span>
                  <span className="text-gray-400 dark:text-gray-500 font-medium">{unplacedClients.length} left</span>
                </span>
              )}
              <svg
                className={`w-4 h-4 transition-transform ${benchOpen ? 'rotate-0' : 'rotate-180'} ${hasRunAutoSort && !allPlaced ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </span>
          </button>
          {benchOpen && (
          <div className="px-4 pb-4 pt-1">
          {/* All-placed empty state — replaces the roster with a success card +
              Confirm Schedule CTA. Mirrors mobile's ClientScrollPanel empty branch. */}
          {allPlaced && (
            <div className="py-4 text-center">
              <p className="text-sm text-gray-700 dark:text-gray-200 mb-3">
                Every client has a day. Lock it in or keep tweaking.
              </p>
              {onConfirmSchedule && (
                <button
                  onClick={onConfirmSchedule}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                  Confirm Schedule
                </button>
              )}
            </div>
          )}
          {/* Post-Auto-Sort callout: explain why the bench exists and offer the rerun action. */}
          {!allPlaced && hasRunAutoSort && (
            <div className="mb-2.5 p-2.5 rounded-lg bg-amber-100/70 border border-amber-200/80 dark:bg-amber-500/15 dark:border-amber-400/25">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[11px] text-amber-800/80 dark:text-amber-200/70 leading-snug min-w-0">
                  Based on your settings, we couldn't fit these. Tap a client to see suggested days, or increase max jobs/day to rerun with more room.
                </p>
                {onRaiseMaxJobs && (
                  <button
                    onClick={onRaiseMaxJobs}
                    className="shrink-0 px-2.5 py-1 text-[11px] font-semibold text-white bg-amber-600 rounded-md hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400 whitespace-nowrap"
                  >
                    +1 max/day
                  </button>
                )}
              </div>
            </div>
          )}
          {/* Search + filter pills — only when there's something to filter. */}
          {!allPlaced && (
            <div className="mb-2.5 flex flex-col gap-2">
              <input
                type="text"
                value={rosterSearch}
                onChange={(e) => setRosterSearch(e.target.value)}
                placeholder="Search clients..."
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-gray-100 dark:bg-white/10 border border-transparent focus:border-blue-400 dark:focus:border-blue-500 focus:bg-white dark:focus:bg-white/15 outline-none text-gray-800 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 transition-colors"
              />
              {filterPills.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5">
                {filterPills.map(p => {
                  const n = counts[p.key]
                  const active = effectiveFilter === p.key
                  return (
                    <button
                      key={p.key}
                      onClick={() => setRosterFilter(p.key)}
                      className={`shrink-0 px-2.5 py-1 text-[11px] font-semibold rounded-full border transition-colors ${
                        active
                          ? 'bg-gray-900 text-white border-gray-900 dark:bg-white/20 dark:border-white/20'
                          : 'bg-white text-gray-700 border-gray-200 hover:border-gray-400 dark:bg-white/5 dark:text-gray-300 dark:border-white/10 dark:hover:border-white/20'
                      }`}
                    >
                      {p.label}
                      <span className={`ml-1 ${active ? 'text-white/70' : 'text-gray-400 dark:text-gray-500'}`}>{n}</span>
                    </button>
                  )
                })}
              </div>
              )}
            </div>
          )}
          {/* Post-Auto-Sort suggestions dock — fixed location so the layout doesn't reflow when the
              user taps different bench chips. Placeholder keeps height reserved. */}
          {!allPlaced && hasRunAutoSort && (() => {
            const selected = unplacedClients.find(c => c.id === selectedClientId)
            const cap = maxJobsPerDayForBench ?? '?'
            return (
              <div className="mb-2.5 px-2.5 py-2 rounded-lg bg-white/70 border border-amber-200/70 dark:bg-white/8 dark:border-amber-400/20 flex items-center gap-2 flex-wrap min-h-[40px]">
                <span className="text-[10px] font-semibold text-amber-700/80 dark:text-amber-300/80 shrink-0">
                  {selected ? `Best days for ${selected.name}:` : 'Best days:'}
                </span>
                {!selected && (
                  <span className="text-[10px] text-amber-700/60 dark:text-amber-300/60 italic">Tap a client below to see suggested days.</span>
                )}
                {selected && benchSuggestions && benchSuggestions.length === 0 && (
                  <span className="text-[10px] text-amber-700/70 dark:text-amber-300/70 italic">
                    No suggestions — client is missing coordinates or no days are active.
                  </span>
                )}
                {selected && benchSuggestions && benchSuggestions.map((s, i) => {
                  const nearestMin = Math.round(s.nearestNeighborMin)
                  const isAdjacent = nearestMin < 2 && s.nearbyCount > 0
                  const tail = s.wouldOverflow
                    ? `over by 1 (${cap}+1)`
                    : `${s.capacityLeft} left`
                  const dayColor = DAY_COLORS[s.day]
                  // Cadence label clarifies *when* a biweekly/monthly client would land —
                  // "A" vs "B" rotation for biweekly, "mo" for monthly, "Nw" for custom,
                  // "wk" for weekly. Critical because biweekly capacity is rotation-specific.
                  return (
                    <button
                      key={s.day}
                      onClick={() => onPlaceBenchClient?.(selected.id, s.day, s.rotation)}
                      className={`flex items-center gap-1.5 px-2 py-1 bg-white dark:bg-white/10 rounded border transition-all hover:shadow-sm ${
                        s.wouldOverflow
                          ? 'border-amber-400 hover:border-amber-500 bg-amber-50/60 dark:bg-amber-500/15 dark:border-amber-400/40'
                          : 'border-gray-200 hover:border-amber-400 dark:border-white/10 dark:hover:border-amber-400/50'
                      }`}
                      title={`Cadence: ${s.cadenceLabel}\nClosest neighbor: ${nearestMin} min\nNearby (≤15 min): ${s.nearbyCount}\n${s.wouldOverflow ? `Over cap by 1 (${cap}+1)` : `Capacity left: ${s.capacityLeft}/${cap}`}`}
                    >
                      <span className="text-[9px] font-bold text-gray-400">#{i + 1}</span>
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dayColor }} />
                      <span className="text-[11px] font-semibold text-gray-800 dark:text-gray-100">{s.dayName}</span>
                      <span
                        className="text-[9px] font-bold px-1 rounded"
                        style={{ backgroundColor: `${dayColor}22`, color: dayColor }}
                      >
                        {s.cadenceLabel}
                      </span>
                      {s.wouldOverflow && (
                        <span className="text-[9px] font-bold text-amber-700 bg-amber-100 dark:text-amber-200 dark:bg-amber-500/20 px-1 rounded">+1</span>
                      )}
                      <span className="text-[9px] text-gray-500 dark:text-gray-400">
                        {isAdjacent ? 'Next door' : `${nearestMin}min`} · {tail}
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })()}
          {/* Horizontal-scroll roster — mirrors mobile's bench rail. Cards stay
              full-size (no wrap) so the user scrolls sideways through the list,
              matching the mobile interaction model. */}
          {!allPlaced && filtered.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 italic px-1 py-3">
              No clients match this filter.
            </p>
          )}
          {!allPlaced && filtered.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {filtered.map(client => {
              const freq = client.frequency
              // Use "2w" for biweekly (cadence) to disambiguate from the grid card's
              // "A"/"B" rotation badges. Bench clients have no rotation yet.
              const freqBadge =
                freq === 'biweekly' ? '2w'
                : freq === 'monthly' ? 'mo'
                : freq === 'weekly' ? 'wk'
                : freq === 'one-time' ? '1x'
                : null
              const isSelected = selectedClientId === client.id
              return (
                <div
                  key={client.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('clientId', client.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => onClientClick?.(client.id)}
                  className={`shrink-0 flex flex-col items-start gap-0.5 px-3 py-2 min-w-[110px] bg-gray-900 dark:bg-white/10 rounded-xl cursor-grab active:cursor-grabbing hover:bg-gray-800 dark:hover:bg-white/15 transition-colors duration-100 ${
                    isSelected ? 'ring-2 ring-amber-400' : ''
                  }`}
                >
                  <span className="text-xs font-semibold text-white whitespace-nowrap">{client.name}</span>
                  {freqBadge && (
                    <span className="text-[10px] font-medium text-gray-400 dark:text-gray-300 whitespace-nowrap" title={freq}>
                      {freqBadge}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          )}
          </div>
          )}
        </div>
        )
      })()}
    </div>
  )
}

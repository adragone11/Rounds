/**
 * MonthCalendar — shared month-grid component.
 *
 * Used by:
 *  - Schedule.tsx  (full interactive mode: drag-drop, suggestions, day-view jump)
 *  - ScheduleChange.tsx  (read-only preview mode: chips only, no interaction)
 *
 * Visual contract: cell sizing, pill styling, day-number bubble — verbatim from
 * the original inline grid in Schedule.tsx. No regressions allowed.
 */

import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const DAYS_ABBREV = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}
function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay()
}
function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export type MonthCalendarChip = {
  clientId: string
  clientName: string
  color: string
  /** day-of-week (0–6) for the chip — stored for callers that need it. */
  day: number
  /** Read-only chip (e.g. mobile-created job we can't edit yet). Renders with
   *  a dashed border + muted fill so users can tell it's from another surface. */
  readonly?: boolean
  /** Optional job id this chip represents. When set, clicking the chip invokes
   *  `onChipClick` so the caller can open the action panel. */
  jobId?: string
  /** Visual state flags from the underlying job. */
  completed?: boolean
  cancelled?: boolean
}

export type MonthCalendarProps = {
  year: number
  month: number // 0–11
  chipsByDate: Record<string, MonthCalendarChip[]>
  today: Date
  /** Optional: called when a day cell is clicked. */
  onDayClick?: (iso: string) => void

  // ── Schedule.tsx-specific interactive features (all optional) ──

  /** ISO dates that are currently selected/highlighted (blue ring). */
  selectedDate?: string | null
  /** ISO dates highlighted because a client is selected (amber ring). */
  selectedClientDates?: Set<string> | null
  /** ISO date currently hovered by a drag operation. */
  dragOverDate?: string | null
  /** Map of date → suggestion rank (1/2/3) for Smart Placement rings. */
  suggestionDateRank?: Map<string, number>
  /** Called when a chip is drag-started. */
  onChipDragStart?: (e: DragEvent<HTMLDivElement>, clientId: string, date: string) => void
  /** Called when a chip is clicked (not dragged). Only fires if the chip has a jobId. */
  onChipClick?: (chip: MonthCalendarChip, date: string) => void
  /** Called on dragover of a cell. */
  onCellDragOver?: (e: DragEvent<HTMLDivElement>, iso: string) => void
  /** Called on dragleave of a cell. */
  onCellDragLeave?: () => void
  /** Called on drop into a cell. */
  onCellDrop?: (e: DragEvent<HTMLDivElement>, iso: string) => void
  /** Called when the "view" button inside a cell is clicked (switches to day view). */
  onDayViewClick?: (iso: string) => void
  /** Ghost preview chips for optimizer proposed moves. */
  previewMoves?: Array<{ clientId: string; clientName: string; suggestedDay: number; dayColor: string }>
  /** Set of clientIds whose chips are shown crossed-out (optimizer preview). */
  previewCrossingClientIds?: Set<string>
  /** Rank colors: 1=gold, 2=silver, 3=bronze. */
  rankColors?: Record<number, string>

  /** When true, renders the bold month label above the weekday headers. */
  showMonthLabel?: boolean
  /** When true, skip MonthCalendar's own SUN…SAT header row — caller (e.g.
   *  Schedule.tsx) renders its own interactive day-color header instead. */
  hideDayHeader?: boolean
}

export default function MonthCalendar({
  year,
  month,
  chipsByDate,
  today,
  onDayClick,
  selectedDate,
  selectedClientDates,
  dragOverDate,
  suggestionDateRank,
  onChipDragStart,
  onChipClick,
  onCellDragOver,
  onCellDragLeave,
  onCellDrop,
  onDayViewClick,
  previewMoves,
  previewCrossingClientIds,
  rankColors,
  showMonthLabel = false,
  hideDayHeader = false,
}: MonthCalendarProps) {
  const daysInMonth = getDaysInMonth(year, month)
  const firstDay = getFirstDayOfMonth(year, month)

  const cells: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const isToday = (day: number) =>
    year === today.getFullYear() && month === today.getMonth() && day === today.getDate()

  return (
    <>
      {/* Optional month label — used by ScheduleChange to label each stacked month */}
      {showMonthLabel && (
        <div className="px-3 py-1.5 bg-white border-b border-gray-200/60">
          <h3 className="text-xs font-bold text-gray-800 tracking-tight">
            {MONTHS[month]} {year}
          </h3>
        </div>
      )}

      {/* SUN…SAT header row — skipped when the caller renders its own */}
      {!hideDayHeader && (
        <div className="relative grid grid-cols-7 border-b border-gray-200/50 shrink-0 bg-white/60">
          {DAYS_ABBREV.map((day) => (
            <div
              key={day}
              className="px-1 py-2 text-center"
            >
              <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{day}</span>
            </div>
          ))}
        </div>
      )}

      {/* 5–6-week cell grid */}
      <div className="flex-1 grid grid-cols-7 auto-rows-fr">
        {cells.map((day, i) => {
          const date = day ? dateKey(year, month, day) : ''
          const chips = day ? (chipsByDate[date] ?? []) : []
          const isOver = date === dragOverDate
          const suggestionRank = day && suggestionDateRank ? suggestionDateRank.get(date) : undefined
          const rankColor = (suggestionRank && rankColors) ? rankColors[suggestionRank] : null

          return (
            <div
              key={i}
              className={`border-b border-r border-gray-200/50 p-1.5 min-h-[80px] transition-all relative ${
                day ? 'cursor-pointer bg-surface-cell' : 'bg-surface-cell-muted'
              } ${
                isOver
                  ? '!bg-blue-50 ring-2 ring-inset ring-blue-300'
                  : selectedDate === date
                  ? '!bg-blue-50/50 ring-1 ring-inset ring-blue-200'
                  : rankColor
                  ? ''
                  : selectedClientDates?.has(date)
                  ? '!bg-amber-50/60 ring-1 ring-inset ring-amber-200'
                  : day
                  ? 'hover:bg-gray-50/80'
                  : ''
              }`}
              style={rankColor ? {
                boxShadow: `inset 0 0 0 2px ${rankColor}`,
                backgroundColor: `${rankColor}12`,
              } : undefined}
              onClick={day && onDayClick ? () => onDayClick(date) : undefined}
              onDragOver={day && onCellDragOver ? (e) => onCellDragOver(e, date) : undefined}
              onDragLeave={day && onCellDragLeave ? onCellDragLeave : undefined}
              onDrop={day && onCellDrop ? (e) => onCellDrop(e, date) : undefined}
            >
              {day && (
                <>
                  {suggestionRank && rankColor && (
                    <span
                      className="absolute top-1 right-1 w-4 h-4 rounded-full text-white text-[9px] font-bold flex items-center justify-center shadow"
                      style={{ backgroundColor: rankColor }}
                      title={`Suggestion #${suggestionRank}`}
                    >{suggestionRank}</span>
                  )}
                  <div className="flex items-center justify-between mb-0.5">
                    <span className={`inline-flex items-center justify-center w-5 h-5 text-[10px] rounded-full ${
                      isToday(day) ? 'bg-gray-900 text-white font-bold dark:bg-white dark:text-gray-900' : 'text-gray-600 font-medium'
                    }`}>{day}</span>
                    {chips.length > 0 && onDayViewClick && (
                      <button
                        onClick={e => { e.stopPropagation(); onDayViewClick(date) }}
                        className="text-[9px] text-gray-400 hover:text-gray-600"
                      >
                        view
                      </button>
                    )}
                  </div>
                  <div className="space-y-0.5">
                    {chips.map((chip, idx) => {
                      const isPreviewClient = previewCrossingClientIds?.has(chip.clientId)
                      const clickable = !!chip.jobId && !!onChipClick
                      const handleChipClick = clickable
                        ? (e: ReactMouseEvent) => { e.stopPropagation(); onChipClick!(chip, date) }
                        : undefined
                      const stateCls = chip.cancelled
                        ? 'opacity-40 line-through'
                        : chip.completed
                        ? 'opacity-55'
                        : ''
                      if (chip.readonly) {
                        return (
                          <div
                            key={`${chip.clientId}-${idx}`}
                            onClick={handleChipClick}
                            className={`flex items-center gap-1 px-1.5 py-[3px] rounded-md text-[9px] font-semibold truncate border border-dashed ${
                              isPreviewClient ? 'opacity-30 line-through' : ''
                            } ${clickable ? 'cursor-pointer hover:brightness-95' : ''} ${stateCls}`}
                            style={{
                              borderColor: chip.color,
                              color: chip.color,
                              background: `${chip.color}15`,
                            }}
                            title={clickable ? 'Click for actions' : 'From mobile (read-only)'}
                          >
                            {chip.completed && <span className="leading-none">✓</span>}
                            <span className="truncate">{chip.clientName}</span>
                          </div>
                        )
                      }
                      return (
                        <div
                          key={chip.clientId}
                          draggable={!!onChipDragStart}
                          onDragStart={onChipDragStart ? (e) => onChipDragStart(e, chip.clientId, date) : undefined}
                          onClick={handleChipClick}
                          className={`flex items-center gap-1 px-1.5 py-[3px] rounded-md text-[9px] font-semibold text-white truncate ${
                            onChipDragStart ? 'cursor-grab active:cursor-grabbing' : ''
                          } ${clickable ? 'hover:brightness-110' : ''} ${isPreviewClient ? 'opacity-30 line-through' : ''} ${stateCls}`}
                          style={{
                            background: `linear-gradient(135deg, ${chip.color}, ${chip.color}dd)`,
                            boxShadow: `0 1px 2px ${chip.color}30`,
                          }}
                        >
                          {chip.completed && <span className="leading-none drop-shadow-sm">✓</span>}
                          <span className="truncate drop-shadow-sm">{chip.clientName}</span>
                        </div>
                      )
                    })}
                    {/* Ghost preview blocks for optimizer proposed moves */}
                    {day && previewMoves && previewMoves
                      .filter(m => new Date(date + 'T00:00:00').getDay() === m.suggestedDay)
                      .map(move => (
                        <div
                          key={`preview-${move.clientId}`}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium truncate border border-dashed"
                          style={{
                            borderColor: move.dayColor,
                            backgroundColor: move.dayColor + '20',
                            color: move.dayColor,
                          }}
                        >
                          <span className="truncate">{move.clientName}</span>
                        </div>
                      ))
                    }
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

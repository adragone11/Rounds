import { useMemo } from 'react'
import type { Client, SchedulePlan, Frequency } from '../types'

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_COLORS = ['#F97316', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4']

type CellKey = `${number}-${number}`

interface PlacedClient {
  clientId: string
  clientName: string
  day: number
  status: 'pending' | 'confirmed' | 'cant-move' | 'waiting' | 'to-ask'
  cadence: Frequency
}

export interface ManualPlacementContext {
  clientId: string
  clientName: string
  cadence: Frequency
}

interface RotationGridProps {
  plan: SchedulePlan
  clients: Client[]
  workingDays: boolean[]
  maxJobsPerDay: number
  /** When set, the grid enters "placement mode" — cells become clickable. */
  placement?: ManualPlacementContext | null
  /** Fired when user clicks a cell while in placement mode. */
  onPlaceCell?: (cell: { day: number; week: 0 | 1 | 2 | 3; rotation: 0 | 1 }) => void
  onCancelPlacement?: () => void
}

/**
 * 4-week × 7-day grid showing the planned schedule cycle at a glance.
 *
 * Each cadence has a visual signature:
 *   weekly   → fills all 4 rows of its column
 *   biweekly → fills 2 alternating rows (Wk1+3 = rotation A; Wk2+4 = rotation B)
 *   monthly  → fills 1 row (week-of-cycle; for now defaults to Wk 1 — the
 *              data model doesn't yet store per-month-week placement, so
 *              monthly clients all collapse into the first week. Iterate later.)
 *
 * In placement mode, cells become buttons. Clicking a cell emits the
 * (day, week, rotation) triplet — the parent decides what to do with it
 * (typically: write back to the plan with locked=false, status='to-ask').
 */
export default function RotationGrid({
  plan,
  clients,
  workingDays,
  maxJobsPerDay,
  placement,
  onPlaceCell,
  onCancelPlacement,
}: RotationGridProps) {
  const clientsById = useMemo(() => new Map(clients.map(c => [c.id, c])), [clients])
  const recurrenceMap = useMemo(
    () => new Map<string, Frequency>(plan.builderRecurrence),
    [plan.builderRecurrence],
  )

  // Map: "wk-day" → array of clients in that cell.
  const cellMap = useMemo(() => {
    const map = new Map<CellKey, PlacedClient[]>()
    for (const pc of plan.clients) {
      // Only confirmed/locked clients land on the grid. Manual placements,
      // swap acceptances, and pending suggestions stay off until the user
      // taps Confirm.
      if (!pc.locked) continue
      if (pc.plannedDay < 0) continue
      const cadence = recurrenceMap.get(pc.clientId) ?? 'weekly'
      const client = clientsById.get(pc.clientId)
      if (!client) continue

      const placed: PlacedClient = {
        clientId: pc.clientId,
        clientName: client.name,
        day: pc.plannedDay,
        status: pc.status,
        cadence,
      }

      const weeks: number[] =
        cadence === 'weekly'
          ? [0, 1, 2, 3]
          : cadence === 'biweekly'
            ? pc.plannedRotation === 0
              ? [0, 2]
              : [1, 3]
            : [0] // monthly — first week for now (TODO: track week-of-cycle)

      for (const wk of weeks) {
        const key = `${wk}-${pc.plannedDay}` as CellKey
        const arr = map.get(key) ?? []
        arr.push(placed)
        map.set(key, arr)
      }
    }
    return map
  }, [plan.clients, recurrenceMap, clientsById])

  const placementActive = !!placement

  return (
    <div className="p-3 flex flex-col gap-3">
      {placementActive && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-purple-50 border border-purple-200 dark:bg-purple-500/15 dark:border-purple-400/30">
          <p className="text-[11px] text-purple-800 dark:text-purple-200">
            <span className="font-semibold">Place {placement?.clientName}</span>
            <span className="text-purple-600 dark:text-purple-300/80">
              {' '}— tap any cell ({placement?.cadence})
            </span>
          </p>
          <button
            onClick={onCancelPlacement}
            className="text-[10px] font-semibold text-purple-700 dark:text-purple-200 hover:underline"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="bg-white dark:bg-surface-card rounded-lg border border-gray-200 p-2">
        {/* Day-of-week header */}
        <div className="grid grid-cols-[36px_repeat(7,1fr)] gap-1 mb-1">
          <div />
          {DAY_LETTERS.map((d, i) => (
            <div
              key={i}
              className={`text-center text-[10px] font-bold uppercase tracking-wider ${
                workingDays[i] ? 'text-gray-500' : 'text-gray-300 dark:text-gray-600'
              }`}
            >
              {d}
            </div>
          ))}
        </div>

        {/* 4 week rows */}
        {[0, 1, 2, 3].map(wk => {
          const rotation: 0 | 1 = wk === 0 || wk === 2 ? 0 : 1
          return (
            <div
              key={wk}
              className="grid grid-cols-[36px_repeat(7,1fr)] gap-1 mb-1 last:mb-0"
            >
              <div className="flex items-center text-[9px] font-bold text-gray-500 uppercase tracking-wider">
                Wk {wk + 1}
              </div>
              {[0, 1, 2, 3, 4, 5, 6].map(day => {
                const key = `${wk}-${day}` as CellKey
                const occupants = cellMap.get(key) ?? []
                const count = occupants.length
                const isWorking = workingDays[day]
                const overCap = count > maxJobsPerDay
                const interactive = placementActive && isWorking
                const cellLabel = `${DAY_FULL[day]}, Week ${wk + 1}: ${count} of ${maxJobsPerDay}`

                const baseClasses =
                  'relative min-h-[64px] rounded-md text-left p-1 flex flex-col gap-0.5 transition-colors overflow-hidden'
                const stateClasses = !isWorking
                  ? 'bg-gray-50 dark:bg-surface-cell-muted opacity-50 cursor-not-allowed'
                  : overCap
                    ? 'bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-400/30'
                    : count > 0
                      ? 'bg-gray-50 dark:bg-surface-cell border border-gray-200'
                      : 'bg-white dark:bg-surface-cell border border-gray-200'
                const interactiveClasses = interactive
                  ? 'hover:ring-2 hover:ring-purple-500 cursor-pointer'
                  : ''

                const handleClick = () => {
                  if (!interactive) return
                  onPlaceCell?.({ day, week: wk as 0 | 1 | 2 | 3, rotation })
                }

                return (
                  <button
                    key={day}
                    type="button"
                    disabled={!interactive}
                    onClick={handleClick}
                    title={cellLabel}
                    className={`${baseClasses} ${stateClasses} ${interactiveClasses}`}
                  >
                    <div className="flex items-center justify-between leading-none">
                      <span
                        className={`text-[9px] font-bold tabular-nums ${
                          overCap
                            ? 'text-red-600 dark:text-red-300'
                            : count > 0
                              ? 'text-gray-700 dark:text-ink-primary'
                              : 'text-gray-300'
                        }`}
                      >
                        {isWorking ? `${count}/${maxJobsPerDay}` : ''}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5 mt-auto">
                      {occupants.map(c => (
                        <span
                          key={c.clientId}
                          className="flex items-center gap-1 px-1.5 py-[3px] rounded-md text-[9px] font-semibold text-white truncate leading-none"
                          style={{
                            background: `linear-gradient(135deg, ${DAY_COLORS[c.day]}, ${DAY_COLORS[c.day]}dd)`,
                            boxShadow: `0 1px 2px ${DAY_COLORS[c.day]}30`,
                          }}
                          title={c.clientName}
                        >
                          <span className="truncate drop-shadow-sm">{c.clientName}</span>
                        </span>
                      ))}
                    </div>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 text-[9px] text-gray-500 dark:text-gray-400 px-1">
        <span>Each row = 1 week of the 4-week cycle</span>
        <span>·</span>
        <span>Weekly fills all 4 rows</span>
        <span>·</span>
        <span>Bi-weekly = Wk 1+3 (A) or 2+4 (B)</span>
        <span>·</span>
        <span>Monthly = single row</span>
      </div>
    </div>
  )
}

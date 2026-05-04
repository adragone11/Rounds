import { useState } from 'react'
import type { BestDay } from '../store'
import { RANK_COLORS } from '../theme'

const DAY_COLORS = ['#F97316', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4']

/**
 * Smart Placement suggestion list. Used in both the Schedule sidebar
 * (when a client pin is selected) and the Add Job panel (when a client
 * is picked from the draft form). Both surfaces need the same gating
 * messaging — missing coords, no neighbors, sustainable-day shortfall —
 * so we centralize it here instead of duplicating two divergent panels.
 */
export function SmartPlacementSuggestions({
  bestDays,
  hasCoords,
  placedNeighborCount,
  previewBestDay,
  onTogglePreview,
  onPick,
}: {
  bestDays: BestDay[]
  hasCoords: boolean
  placedNeighborCount: number
  previewBestDay: string | null
  onTogglePreview: (date: string | null) => void
  onPick: (date: string) => void
}) {
  if (!hasCoords) {
    return <p className="text-[10px] text-gray-400">Add an address to get suggestions</p>
  }
  if (placedNeighborCount < 1) {
    return <p className="text-[10px] text-gray-400">Place a few clients first — Smart Placement uses nearby neighbors to pick the best day.</p>
  }
  if (bestDays.length === 0) {
    return <p className="text-[10px] text-gray-400">No day can sustain this recurrence — every working day is full, blocked, or would overflow before the 12-week horizon.</p>
  }
  return (
    <div className="space-y-1">
      {bestDays.length < 3 && (
        <p className="text-[9px] text-gray-400 italic pb-1">
          Only {bestDays.length} day{bestDays.length === 1 ? '' : 's'} can sustain this recurrence — the rest are full or don't match your working/blocked settings.
        </p>
      )}
      {bestDays.map(bd => (
        <BestDayRow
          key={bd.day}
          bd={bd}
          isPreviewing={!!previewBestDay && bd.firstDate === previewBestDay}
          onTogglePreview={() => onTogglePreview(previewBestDay === bd.firstDate ? null : bd.firstDate)}
          onPick={() => bd.firstDate && onPick(bd.firstDate)}
        />
      ))}
    </div>
  )
}

/**
 * Click-to-expand row revealing why the engine ranked this day. The
 * collapsed state is the rank chip + day + first-fit date + one-line
 * reason; the expanded state shows the four scoring signals as labeled
 * chips so the ranking is auditable instead of opaque.
 */
function BestDayRow({
  bd,
  isPreviewing,
  onTogglePreview,
  onPick,
}: {
  bd: BestDay
  isPreviewing: boolean
  onTogglePreview: () => void
  onPick: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const rankColor = RANK_COLORS[bd.rank]
  const firstDateLabel = bd.firstDate
    ? new Date(bd.firstDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : 'Full 12 wks'
  const nearestMin = Math.round(bd.nearestNeighborMin)
  const clusterMin = Math.round(bd.clusterFit)
  const capPct = Math.round(bd.capacityPressure * 100)

  return (
    <div
      className={`bg-white rounded-md border transition-colors ${
        isPreviewing ? 'border-amber-400 ring-1 ring-amber-300' : 'border-gray-100'
      }`}
    >
      <div
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer"
      >
        <span
          className="w-5 h-5 rounded-full shrink-0 text-white text-[10px] font-bold flex items-center justify-center"
          style={{ backgroundColor: rankColor }}
        >{bd.rank}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: DAY_COLORS[bd.day] }} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-gray-800 truncate">{bd.dayName.slice(0, 3)} · {firstDateLabel}</p>
          <p className="text-[10px] text-gray-500 truncate">{bd.reason}</p>
        </div>
        <svg
          className={`w-3 h-3 text-gray-300 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        {bd.firstDate && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onTogglePreview() }}
              title={isPreviewing ? 'Hide preview' : 'Preview this day on map'}
              className={`p-1 rounded transition-colors ${
                isPreviewing ? 'bg-amber-100 text-amber-700' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onPick() }}
              className="px-1.5 py-0.5 text-[9px] font-semibold text-white bg-gray-900 rounded hover:bg-gray-700"
            >Place</button>
          </>
        )}
      </div>

      {expanded && (
        <div className="px-2 pb-2 pt-1 border-t border-gray-100 space-y-1">
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">Why this day</p>
          <div className="grid grid-cols-2 gap-1">
            <BreakdownChip label="Closest neighbor" value={`${nearestMin} min`} />
            <BreakdownChip label={`Nearby on ${bd.dayName.slice(0, 3)}s`} value={`${bd.nearbyCount} ≤ 15 min`} />
            <BreakdownChip label="Cluster center" value={`${clusterMin} min`} />
            <BreakdownChip label="Capacity used" value={`${capPct}%`} />
          </div>
        </div>
      )}
    </div>
  )
}

function BreakdownChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded px-1.5 py-1">
      <p className="text-[8px] text-gray-400 uppercase tracking-wider leading-tight">{label}</p>
      <p className="text-[11px] font-semibold text-gray-800 leading-tight mt-0.5">{value}</p>
    </div>
  )
}

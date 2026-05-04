import type { Frequency, Client } from '../types'

type Pending = { clientId: string; date: string } | null
type PendingMove = { clientId: string; sourceDate: string; targetDate: string } | null

const FREQ_OPTIONS: ReadonlyArray<readonly [Frequency, string]> = [
  ['weekly', 'Every week'],
  ['biweekly', 'Every 2 weeks'],
  ['monthly', 'Once a month (every 4 weeks)'],
  ['one-time', 'Just this date'],
]

const fmtMonthDay = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const fmtFullDay = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

/**
 * The three "what do you want to do?" overlays for drag-drop placements.
 *
 * - pendingDrop: fresh drop from the sidebar → pick recurrence
 * - pendingRemove: client dragged back to the sidebar → just-this / future / all
 * - pendingMove: recurring client dragged to a different day → just-this / future
 */
export function ScheduleConfirmModals({
  clients,
  pendingDrop,
  pendingRemove,
  pendingMove,
  onCancelDrop,
  onCancelRemove,
  onCancelMove,
  onConfirmDrop,
  onConfirmRemove,
  onConfirmMove,
}: {
  clients: Client[]
  pendingDrop: Pending
  pendingRemove: Pending
  pendingMove: PendingMove
  onCancelDrop: () => void
  onCancelRemove: () => void
  onCancelMove: () => void
  onConfirmDrop: (f: Frequency) => void
  onConfirmRemove: (mode: 'just-this' | 'this-and-future' | 'all') => void
  onConfirmMove: (mode: 'just-this' | 'this-and-future') => void
}) {
  const nameOf = (id: string) => clients.find(c => c.id === id)?.name

  return (
    <>
      {pendingDrop && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onCancelDrop}>
          <div className="bg-white rounded-xl shadow-xl p-4 w-64" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold text-gray-900 mb-1">How often?</p>
            <p className="text-xs text-gray-400 mb-3">
              {nameOf(pendingDrop.clientId)} — starting {fmtMonthDay(pendingDrop.date)}
            </p>
            <div className="space-y-1.5">
              {FREQ_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => onConfirmDrop(value)}
                  className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 transition-colors text-gray-700"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onCancelRemove}>
          <div className="bg-white rounded-xl shadow-xl p-4 w-64" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold text-gray-900 mb-1">Remove from schedule</p>
            <p className="text-xs text-gray-400 mb-3">
              {nameOf(pendingRemove.clientId)} — {fmtFullDay(pendingRemove.date)}
            </p>
            <div className="space-y-1.5">
              <button
                onClick={() => onConfirmRemove('just-this')}
                className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 transition-colors text-gray-700"
              >
                Just this one
              </button>
              <button
                onClick={() => onConfirmRemove('this-and-future')}
                className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 transition-colors text-gray-700"
              >
                This and all future
              </button>
              <button
                onClick={() => onConfirmRemove('all')}
                className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-red-50 transition-colors text-red-600"
              >
                All visits ever (past & future)
              </button>
            </div>
            <button
              onClick={onCancelRemove}
              className="w-full mt-2 px-3 py-2 text-sm font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pendingMove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onCancelMove}>
          <div className="bg-white rounded-xl shadow-xl p-4 w-72" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold text-gray-900 mb-1">Move recurring visit</p>
            <p className="text-xs text-gray-400 mb-3">
              {nameOf(pendingMove.clientId)} — {fmtFullDay(pendingMove.sourceDate)} → {fmtFullDay(pendingMove.targetDate)}
            </p>
            <div className="space-y-1.5">
              <button
                onClick={() => onConfirmMove('just-this')}
                className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 transition-colors text-gray-700"
              >
                Just this one
              </button>
              <button
                onClick={() => onConfirmMove('this-and-future')}
                className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-gray-100 transition-colors text-gray-700"
              >
                This and all future
              </button>
            </div>
            <button
              onClick={onCancelMove}
              className="w-full mt-2 px-3 py-2 text-sm font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  )
}

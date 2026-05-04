import type { AddJobDraft } from './AddJobPanel'
import type { AddJobOverlay } from '../hooks/useAddJobOverlay'
import { fmtAmPm, parseHHmm } from '../lib/scheduleHelpers'

const EDGE_PX = 14

/**
 * The dashed pink/colored card that previews where the new job will land on
 * the day timeline. Apple-Calendar zone detection: top/bottom 14 px = resize,
 * body = move (preserves duration, pins grab-point to the cursor).
 *
 * All drag state and cursor-Y → time conversion live in the overlay hook;
 * this component just translates pointer events into hook actions.
 */
export function AddJobPreviewCard({
  overlay,
  cardTop,
  cardHeight,
  color,
  client,
  startMin,
  endMin,
}: {
  overlay: AddJobOverlay
  cardTop: number
  cardHeight: number
  color: string
  client: { name: string } | null
  startMin: number
  endMin: number
}) {
  const { resizing, draft, yToHHmm, beginResize, beginMoveDrag } = overlay

  return (
    <div
      data-day-grid-skip
      onMouseMove={(e) => {
        if (resizing) return
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
        const relY = e.clientY - r.top
        const el = e.currentTarget as HTMLDivElement
        if (relY < EDGE_PX || relY > r.height - EDGE_PX) {
          el.style.cursor = 'ns-resize'
        } else {
          el.style.cursor = 'grab'
        }
      }}
      onMouseDown={(e) => {
        e.preventDefault()
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
        const relY = e.clientY - r.top
        if (relY < EDGE_PX) { beginResize('top'); return }
        if (relY > r.height - EDGE_PX) { beginResize('bottom'); return }
        const t = yToHHmm(e.clientY)
        if (!t) return
        const cursorMin = parseHHmm(t)!
        beginMoveDrag(cursorMin)
      }}
      className={`absolute left-[72px] right-3 rounded-2xl shadow-lg flex flex-col justify-between text-white select-none ${
        resizing === 'move' ? 'cursor-grabbing' : resizing ? 'cursor-ns-resize' : 'cursor-grab'
      }`}
      style={{
        top: cardTop + 8,
        height: cardHeight - 8,
        backgroundColor: color,
        border: '2px dashed rgba(255,255,255,0.55)',
      }}
    >
      {/* Visual edge hints — purely decorative; the parent owns all pointer
          events via zone detection. */}
      <div className="pointer-events-none absolute top-1 left-0 right-0 flex items-center justify-center">
        <div className="w-10 h-1 rounded-full bg-white/70" />
      </div>
      <div className="flex items-start justify-between gap-2 px-4 pt-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">
            {client?.name ?? (draft.title.trim() || 'New job')}
          </p>
          <p className="text-[11px] opacity-90 mt-0.5">
            {fmtAmPm(startMin)} – {fmtAmPm(endMin)}
          </p>
        </div>
        {draftHasPrice(draft) && (
          <span className="px-2 py-0.5 text-[11px] font-semibold rounded-md bg-black/15 shrink-0">
            ${Number(draft.price).toFixed(2)}
          </span>
        )}
      </div>
      <div className="px-4 pb-4 flex justify-end">
        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/25">New</span>
      </div>
      <div className="pointer-events-none absolute bottom-1 left-0 right-0 flex items-center justify-center">
        <div className="w-10 h-1 rounded-full bg-white/70" />
      </div>
    </div>
  )
}

function draftHasPrice(d: AddJobDraft): boolean {
  return !!d.price && Number(d.price) > 0
}

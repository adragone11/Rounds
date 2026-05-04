import { useState } from 'react'
import { COLOR_PALETTE } from '../theme'

/** A clickable pill that shows the current color + label, expanding into the
 *  curated palette when tapped. Used wherever a job/client color is edited
 *  (JobActionPanel, EditJobModal, EditClientCard, Clients detail).
 *
 *  We surface the mobile-app frequency convention as a tiny hint so users
 *  can match by sight: weekly → orange, biweekly → blue, monthly → purple. */
export default function ColorPickerChip({
  color, label, onChange, size = 'md',
}: {
  color: string
  label: string
  onChange: (hex: string) => void
  size?: 'sm' | 'md'
}) {
  const [open, setOpen] = useState(false)
  const padding = size === 'sm' ? 'px-2 py-[3px] text-[10px]' : 'px-2.5 py-1.5 text-xs'
  const swatchSize = size === 'sm' ? 'w-6 h-6' : 'w-7 h-7'

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`group inline-flex items-center gap-1.5 rounded-md font-semibold text-white max-w-full transition-transform hover:scale-[1.02] ${padding}`}
        style={{ backgroundColor: color }}
        aria-expanded={open}
        aria-label="Edit color"
      >
        <span className="truncate">{label}</span>
        <svg className="w-3 h-3 shrink-0 opacity-80 group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zM19.5 9.75L14.25 4.5" />
        </svg>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {COLOR_PALETTE.map(({ name, hex }) => {
              const isSelected = hex.toLowerCase() === color.toLowerCase()
              return (
                <button
                  key={hex}
                  type="button"
                  onClick={() => { onChange(hex); setOpen(false) }}
                  className={`${swatchSize} rounded-full transition-transform hover:scale-110 ${isSelected ? 'ring-2 ring-offset-2 ring-gray-900' : ''}`}
                  style={{ backgroundColor: hex }}
                  title={name}
                  aria-label={name}
                  aria-pressed={isSelected}
                />
              )
            })}
          </div>
          <p className="text-[10px] text-gray-400">
            Mobile uses orange for weekly, blue for biweekly, purple for monthly.
          </p>
        </div>
      )}
    </div>
  )
}

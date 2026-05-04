import { memo, useEffect, useRef } from 'react'
import type { DragEvent } from 'react'
import type { Frequency, DayOfWeek } from '../types'
import { useCurrency } from '../lib/currency'
import { DAY_ABBREV as DAYS, BLOCKED_COLOR } from '../theme'
import ColorPickerChip from './ColorPickerChip'
import AddressAutocomplete from './AddressAutocomplete'

/* ── Pin showing geocode status next to an address ── */
export function GeocodePin({ address, lat, lng }: { address: string; lat: number | null; lng: number | null }) {
  const color = !address?.trim() ? '#D1D5DB' : lat != null && lng != null ? '#22C55E' : '#EAB308'
  const title = !address?.trim() ? 'No address' : lat != null && lng != null ? 'Geocoded' : 'Not geocoded'
  return (
    <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill={color}>
      <title>{title}</title>
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/>
    </svg>
  )
}

const FREQ_BADGE: Record<string, { label: string; color: string }> = {
  'weekly': { label: 'W', color: '#3B82F6' },
  'biweekly': { label: '2W', color: '#8B5CF6' },
  'monthly': { label: 'M', color: '#F97316' },
  'one-time': { label: '1x', color: '#9CA3AF' },
}

function clientInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0]!.substring(0, 2).toUpperCase()
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase()
}

/* ── Client card (view mode) ──
   Callbacks take the clientId so the parent can pass stable refs and the
   card can be memoized — clicking a different client only re-renders the
   row whose `selected` flag flipped, not every row in the sidebar. */
function ClientCardInner({ client, dimmed, selected, pinColor, placed, draggable: isDraggable, onDragStart, onEdit, onClick }: {
  client: { id: string; name: string; address: string; color: string; lat: number | null; lng: number | null; frequency: string; startDate: string | null }
  dimmed: boolean
  selected?: boolean
  pinColor?: string
  placed?: boolean
  draggable?: boolean
  onDragStart?: (e: DragEvent, clientId: string) => void
  onEdit: (clientId: string) => void
  onClick?: (clientId: string) => void
}) {
  // `placed` is the cross-device truth (client has a job in Supabase), set by
  // the caller. `client.startDate` is the legacy localStorage-only signal — it
  // breaks across origins/devices, so prefer `placed` when given.
  const badge = (placed || client.startDate) ? FREQ_BADGE[client.frequency] : null
  // Avatar shows the day-of-week color for placed clients (so the row reads
  // as "this is on a Wednesday"), and the client's own color for unplaced ones.
  const avatarColor = dimmed ? (pinColor ?? '#9CA3AF') : (client.color || '#9CA3AF')

  return (
    <div
      draggable={isDraggable}
      onDragStart={onDragStart ? e => onDragStart(e, client.id) : undefined}
      onClick={onClick ? () => onClick(client.id) : undefined}
      className={`flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] group transition-colors ${
        selected
          ? 'bg-amber-50 ring-1 ring-amber-300'
          : dimmed
            ? 'hover:bg-gray-50'
            : 'cursor-grab active:cursor-grabbing hover:bg-surface-chip'
      }`}
    >
      <div
        className={`w-7 h-7 rounded-lg flex items-center justify-center text-white text-[10px] font-bold shrink-0 ${dimmed ? 'opacity-60' : ''}`}
        style={{ backgroundColor: avatarColor }}
      >
        {clientInitials(client.name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className={`text-[13px] font-semibold truncate ${dimmed ? 'text-ink-secondary' : 'text-ink-primary'}`}>
            {client.name}
          </p>
          {badge && (
            <span className="text-[9px] font-bold px-1.5 py-px rounded shrink-0" style={{ color: badge.color, backgroundColor: badge.color + '18' }}>
              {badge.label}
            </span>
          )}
        </div>
        {client.address && (
          <div className="flex items-center gap-1 min-w-0">
            <GeocodePin address={client.address} lat={client.lat} lng={client.lng} />
            <p className="text-[11px] text-ink-tertiary truncate">{client.address}</p>
          </div>
        )}
      </div>
      <button
        onClick={e => { e.stopPropagation(); onEdit(client.id) }}
        className="opacity-0 group-hover:opacity-100 text-ink-tertiary hover:text-ink-primary transition-opacity shrink-0"
        title="Edit client"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
        </svg>
      </button>
    </div>
  )
}

export const ClientCard = memo(ClientCardInner)

/* ── Client card (edit mode) ── */
export function EditClientCard({
  color, name, address, frequency, duration, blockedDays, rate, isPlus,
  onNameChange, onAddressChange, onAddressSelect,
  onFrequencyChange, onDurationChange, onRateChange, onToggleBlockedDay, onColorChange,
  onSave, onCancel, onDelete,
}: {
  color: string
  name: string
  address: string
  frequency: Frequency
  duration: number
  blockedDays: DayOfWeek[]
  rate: string
  isPlus: boolean
  onNameChange: (v: string) => void
  onAddressChange: (v: string) => void
  onAddressSelect: (r: { address: string; lat: number; lng: number }) => void
  onFrequencyChange: (f: Frequency) => void
  onDurationChange: (d: number) => void
  onRateChange: (v: string) => void
  onToggleBlockedDay: (d: DayOfWeek) => void
  onColorChange: (hex: string) => void
  onSave: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const nameRef = useRef<HTMLInputElement>(null)
  const { currencyInfo } = useCurrency()
  useEffect(() => nameRef.current?.focus(), [])

  return (
    <div className="bg-white rounded-lg border-2 border-blue-300 p-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          ref={nameRef}
          value={name}
          onChange={e => onNameChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSave()}
          placeholder="Name"
          className="flex-1 text-xs font-medium px-2 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
      </div>
      <div>
        <ColorPickerChip color={color} label={name || 'Color'} onChange={onColorChange} size="sm" />
      </div>
      <AddressAutocomplete
        value={address}
        onChange={onAddressChange}
        onSelect={onAddressSelect}
        onKeyDown={e => e.key === 'Enter' && onSave()}
        placeholder="Address"
        className="w-full text-[10px] px-2 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-300"
      />
      <div className="flex items-center gap-1.5">
        <label className="text-[9px] font-semibold text-gray-500 uppercase tracking-wider shrink-0">Recurrence</label>
        <select
          value={frequency}
          onChange={e => onFrequencyChange(e.target.value as Frequency)}
          className="flex-1 text-[10px] px-1.5 py-1 border border-gray-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-300"
        >
          <option value="weekly">Weekly</option>
          <option value="biweekly">Biweekly</option>
          <option value="monthly">Monthly</option>
          <option value="one-time">One-time</option>
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <label className="text-[9px] font-semibold text-gray-500 uppercase tracking-wider shrink-0">Duration</label>
        <input
          type="number"
          min={15}
          max={480}
          step={15}
          value={duration}
          onChange={e => onDurationChange(Math.max(15, Number(e.target.value) || 60))}
          className="w-14 text-[10px] px-1.5 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
        <span className="text-[10px] text-gray-400">min</span>
      </div>
      <div className="flex items-center gap-1.5">
        <label className="text-[9px] font-semibold text-gray-500 uppercase tracking-wider shrink-0">Default Price</label>
        <div className="relative flex-1 max-w-[100px]">
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400 pointer-events-none">{currencyInfo.symbol}</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="5"
            placeholder="0"
            value={rate}
            onChange={e => onRateChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onSave()}
            className="w-full pl-4 pr-1.5 py-1 text-[10px] border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-300"
          />
        </div>
        <span className="text-[9px] text-gray-400">per visit</span>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-[9px] font-semibold text-gray-500 uppercase tracking-wider">Blocked days</p>
          {false && !isPlus && (
            <span className="text-[8px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-blue-600 text-white"></span>
          )}
        </div>
        {isPlus ? (
          <div className="flex gap-1">
            {DAYS.map((d, i) => {
              const blocked = blockedDays.includes(i as DayOfWeek)
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => onToggleBlockedDay(i as DayOfWeek)}
                  className={`flex-1 py-1 text-[10px] font-bold rounded-md border transition-all ${blocked ? 'line-through' : ''}`}
                  style={blocked ? {
                    backgroundColor: BLOCKED_COLOR + '18',
                    color: BLOCKED_COLOR,
                    borderColor: BLOCKED_COLOR + '55',
                  } : {
                    backgroundColor: '#fff',
                    color: '#374151',
                    borderColor: '#E5E7EB',
                  }}
                >{d.charAt(0)}</button>
              )
            })}
          </div>
        ) : (
          <p className="text-[10px] text-gray-400 leading-snug">
            Block weekdays for this client.
          </p>
        )}
      </div>
      <div className="flex items-center justify-between pt-1">
        <button
          onClick={onDelete}
          className="text-[10px] text-red-400 hover:text-red-600 font-medium"
        >
          Delete
        </button>
        <div className="flex gap-1.5">
          <button onClick={onCancel} className="text-[10px] text-gray-400 hover:text-gray-600 px-2 py-0.5">
            Cancel
          </button>
          <button onClick={onSave} className="text-[10px] text-white bg-gray-900 hover:bg-gray-800 px-3 py-0.5 rounded font-medium">
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

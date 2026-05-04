import { useState, useMemo } from 'react'
import { useStore } from '../store'
import type { BestDay } from '../store'
import { useToast } from '../lib/toast'
import { useCurrency } from '../lib/currency'
import AddressAutocomplete from './AddressAutocomplete'
import { SmartPlacementSuggestions } from './SmartPlacementSuggestions'
import type { Client } from '../types'

export type AddJobDraft = {
  title: string
  clientId: string | null
  price: string
  recurring: 'one-time' | 'weekly' | 'bi-weekly' | 'monthly'
  notes: string
  // Pre-flight checklist captured at create time. Mirrors the JobActionPanel
  // ChecklistSection so users can plan the visit's tasks the same moment
  // they're writing notes. Empty array = nothing to attach.
  checklist: { text: string; done: boolean }[]
}

export const emptyAddJobDraft: AddJobDraft = {
  title: '',
  clientId: null,
  price: '',
  recurring: 'one-time',
  notes: '',
  checklist: [],
}

export function isAddJobDraftValid(d: AddJobDraft): boolean {
  return d.title.trim().length > 0 || d.clientId !== null
}

function clientInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function AddJobPanel({
  draft,
  onChange,
  onClose,
  isPlus,
  bestDays,
  placedNeighborCount,
  previewBestDay,
  onTogglePreview,
  onPickDay,
}: {
  draft: AddJobDraft
  onChange: (next: AddJobDraft) => void
  onClose: () => void
  // Smart Placement context — owned by Schedule.tsx so the suggestion data
  // stays consistent with what the calendar lights up. Panel renders the
  // list inline under the client picker when a client with coords is
  // selected; gating messages live in the shared component.
  isPlus: boolean
  bestDays: BestDay[]
  placedNeighborCount: number
  previewBestDay: string | null
  onTogglePreview: (date: string | null) => void
  onPickDay: (date: string) => void
}) {
  const store = useStore()
  const toast = useToast()
  const { currencyInfo } = useCurrency()
  const [clientPickerOpen, setClientPickerOpen] = useState(false)
  const [clientSearch, setClientSearch] = useState('')

  // Inline "Add New Client" sub-form state.
  const [addingNewClient, setAddingNewClient] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [newAddress, setNewAddress] = useState('')
  const [newCoords, setNewCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [newClientSaving, setNewClientSaving] = useState(false)

  const newAddrTrim = newAddress.trim()
  const newAddrGeocoded = !!newCoords && newAddrTrim.length > 0
  const newAddrPending = newAddrTrim.length > 0 && !newCoords
  // amber while user is typing/has unsaved address, green once geocoded, gray when empty.
  const pinColor = newAddrGeocoded ? '#16A34A' : newAddrPending ? '#D97706' : '#9CA3AF'

  const cancelAddNewClient = () => {
    setAddingNewClient(false)
    setNewName('')
    setNewPhone('')
    setNewAddress('')
    setNewCoords(null)
  }

  const submitNewClient = async () => {
    const name = newName.trim()
    if (!name || newClientSaving) return
    setNewClientSaving(true)
    const id = await store.addClient(
      name,
      newAddrTrim,
      newCoords,
      newPhone.trim() || undefined,
    )
    setNewClientSaving(false)
    if (id) {
      onChange({ ...draft, clientId: id })
      cancelAddNewClient()
      setClientPickerOpen(false)
      setClientSearch('')
      toast('Client added')
    }
  }

  const clients = store.clients
  const selectedClient: Client | null = useMemo(
    () => (draft.clientId ? clients.find(c => c.id === draft.clientId) ?? null : null),
    [draft.clientId, clients]
  )

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase()
    if (!q) return clients
    return clients.filter(c => c.name.toLowerCase().includes(q))
  }, [clients, clientSearch])

  const valid = isAddJobDraftValid(draft)

  return (
    <div className="w-[324px] border-r border-edge-default flex flex-col shrink-0 bg-white">
      {/* Header */}
      <div className="px-5 pt-5 pb-3 border-b border-edge-default">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-[18px] font-bold text-ink-primary leading-tight">Add Job</h2>
            <p className="text-[12px] text-ink-tertiary mt-0.5">Fill out, then pick a day →</p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 -mr-1 flex items-center justify-center rounded-lg text-ink-tertiary hover:text-ink-primary hover:bg-surface-chip transition-colors"
            title="Cancel"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Job Title */}
        <div>
          <label className="block text-[12px] font-semibold text-ink-primary mb-1.5">
            Job Title <span className="text-ink-tertiary font-normal">(optional)</span>
          </label>
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-tertiary pointer-events-none"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
            >
              <rect x="4" y="3" width="14" height="18" rx="2" />
              <path d="M8 8h6M8 12h6M8 16h4" />
            </svg>
            <input
              type="text"
              value={draft.title}
              onChange={e => onChange({ ...draft, title: e.target.value })}
              placeholder="e.g., Window Cleaning"
              className="w-full pl-9 pr-3 py-2.5 text-[14px] bg-surface-chip rounded-[10px] border border-transparent focus:border-blue-500 focus:bg-white focus:outline-none transition-colors"
            />
          </div>
        </div>

        {/* Client */}
        <div>
          <label className="block text-[12px] font-semibold text-ink-primary mb-1.5">Client</label>
          <button
            type="button"
            onClick={() => setClientPickerOpen(o => !o)}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-[14px] bg-surface-chip rounded-[10px] hover:bg-gray-100 transition-colors text-left"
          >
            {selectedClient ? (
              <>
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                  style={{ backgroundColor: selectedClient.color }}
                >
                  {clientInitials(selectedClient.name)}
                </span>
                <span className="flex-1 text-ink-primary truncate">{selectedClient.name}</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4 text-ink-tertiary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
                </svg>
                <span className="flex-1 text-ink-tertiary">None</span>
              </>
            )}
            <svg className={`w-4 h-4 text-ink-tertiary shrink-0 transition-transform ${clientPickerOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {/* Smart Placement panel — appears inline under the picker once a
              client is selected. Mirrors the sidebar Smart Placement card
              that shows when no Add Job is active, so the user gets the
              same "why this day" affordance in either flow. */}
          {selectedClient && !clientPickerOpen && isPlus && (
            <div className="mt-2 rounded-[10px] bg-amber-50/60 border border-amber-100 p-2">
              <p className="text-[10px] font-semibold text-amber-800 uppercase tracking-wider mb-1.5">
                Smart placement · {selectedClient.name}
              </p>
              <SmartPlacementSuggestions
                bestDays={bestDays}
                hasCoords={selectedClient.lat !== null && selectedClient.lng !== null}
                placedNeighborCount={placedNeighborCount}
                previewBestDay={previewBestDay}
                onTogglePreview={onTogglePreview}
                onPick={onPickDay}
              />
            </div>
          )}
          {selectedClient && !clientPickerOpen && !isPlus && (
            <div className="mt-2 rounded-[10px] bg-blue-50/60 border border-blue-100 p-2">
              <div className="flex items-start gap-2">
                <span className="inline-block mt-0.5 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-600 text-white">Pip+</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-semibold text-gray-900">Smart Placement</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">Upgrade in the Pip mobile app to surface best-day suggestions here.</p>
                </div>
              </div>
            </div>
          )}
          {clientPickerOpen && (
            <div className="mt-2 border border-edge-default rounded-[10px] bg-white shadow-sm overflow-hidden">
              <div className="p-2 border-b border-edge-default">
                <input
                  autoFocus
                  type="text"
                  value={clientSearch}
                  onChange={e => setClientSearch(e.target.value)}
                  placeholder="Search clients..."
                  className="w-full px-2.5 py-1.5 text-[13px] bg-surface-chip rounded-md focus:outline-none"
                />
              </div>

              {addingNewClient ? (
                <div className="p-3 space-y-2 bg-blue-50/40">
                  {/* Name (required) */}
                  <div className="flex items-center gap-2 bg-white rounded-md px-2.5 py-2 border border-edge-default focus-within:border-blue-500">
                    <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
                    </svg>
                    <input
                      autoFocus
                      type="text"
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      placeholder="Name"
                      className="flex-1 text-[13px] bg-transparent focus:outline-none"
                    />
                  </div>

                  {/* Phone (optional) */}
                  <div className="flex items-center gap-2 bg-white rounded-md px-2.5 py-2 border border-edge-default focus-within:border-blue-500">
                    <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
                    </svg>
                    <input
                      type="tel"
                      value={newPhone}
                      onChange={e => setNewPhone(e.target.value)}
                      placeholder="Phone (optional)"
                      className="flex-1 min-w-0 text-[13px] bg-transparent focus:outline-none"
                    />
                  </div>

                  {/* Address (optional) with status pin — status sits on its own row to avoid clipping */}
                  <div>
                    <div className="flex items-center gap-2 bg-white rounded-md px-2.5 py-2 border border-edge-default focus-within:border-blue-500">
                      <svg
                        className="w-4 h-4 shrink-0 transition-colors"
                        style={{ color: pinColor }}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
                      >
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                      <AddressAutocomplete
                        value={newAddress}
                        onChange={(v) => {
                          setNewAddress(v)
                          // If user keeps typing after a selection, the address is dirty again.
                          if (newCoords) setNewCoords(null)
                        }}
                        onSelect={(r) => {
                          setNewAddress(r.address)
                          setNewCoords({ lat: r.lat, lng: r.lng })
                        }}
                        placeholder="Address (optional)"
                        className="flex-1 min-w-0 text-[13px] bg-transparent focus:outline-none"
                      />
                    </div>
                    {(newAddrGeocoded || newAddrPending) && (
                      <p className={`mt-1 px-1 text-[11px] font-semibold inline-flex items-center gap-1 ${newAddrGeocoded ? 'text-emerald-600' : 'text-amber-600'}`}>
                        {newAddrGeocoded ? (
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="9" />
                            <path d="M12 8v4M12 16h.01" />
                          </svg>
                        )}
                        {newAddrGeocoded ? 'Address saved' : 'Address not saved'}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={cancelAddNewClient}
                      className="px-3 py-1.5 text-[12px] font-medium text-ink-secondary hover:text-ink-primary transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void submitNewClient()}
                      disabled={!newName.trim() || newClientSaving}
                      className="px-4 py-1.5 text-[12px] font-semibold text-white rounded-full transition-colors disabled:opacity-40"
                      style={{ background: '#3B82F6' }}
                    >
                      {newClientSaving ? 'Adding…' : 'Add'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  {/* Add New Client row */}
                  <button
                    type="button"
                    onClick={() => setAddingNewClient(true)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-[13px] font-semibold text-blue-600 hover:bg-blue-50 text-left border-b border-edge-default"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    Add New Client
                  </button>

                  {selectedClient && (
                    <button
                      type="button"
                      onClick={() => {
                        onChange({ ...draft, clientId: null })
                        setClientPickerOpen(false)
                        setClientSearch('')
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-surface-chip text-ink-tertiary text-left"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      Clear selection
                    </button>
                  )}
                  {filteredClients.length === 0 ? (
                    <p className="px-3 py-3 text-[12px] text-ink-tertiary">No clients match.</p>
                  ) : (
                    filteredClients.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          onChange({ ...draft, clientId: c.id })
                          setClientPickerOpen(false)
                          setClientSearch('')
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-surface-chip text-left ${
                          c.id === draft.clientId ? 'bg-blue-50' : ''
                        }`}
                      >
                        <span
                          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                          style={{ backgroundColor: c.color }}
                        >
                          {clientInitials(c.name)}
                        </span>
                        <span className="flex-1 truncate text-ink-primary">{c.name}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Price */}
        <div>
          <label className="block text-[12px] font-semibold text-ink-primary mb-1.5">
            Price <span className="text-ink-tertiary font-normal">(optional)</span>
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[14px] font-semibold text-emerald-600 pointer-events-none">
              {currencyInfo.symbol}
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={draft.price}
              onChange={e => onChange({ ...draft, price: e.target.value })}
              placeholder="0.00"
              className="w-full pl-8 pr-3 py-2.5 text-[14px] bg-surface-chip rounded-[10px] border border-transparent focus:border-blue-500 focus:bg-white focus:outline-none transition-colors"
            />
          </div>
        </div>

        {/* Recurring */}
        <div>
          <label className="block text-[12px] font-semibold text-ink-primary mb-1.5">Recurring</label>
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-blue-500 pointer-events-none"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
              <path d="M21 4v4h-4" />
              <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
              <path d="M3 20v-4h4" />
            </svg>
            <select
              value={draft.recurring}
              onChange={e => onChange({ ...draft, recurring: e.target.value as AddJobDraft['recurring'] })}
              className="w-full appearance-none pl-9 pr-9 py-2.5 text-[14px] bg-surface-chip rounded-[10px] border border-transparent focus:border-blue-500 focus:bg-white focus:outline-none transition-colors text-ink-primary cursor-pointer"
            >
              <option value="one-time">One-Time</option>
              <option value="weekly">Weekly</option>
              <option value="bi-weekly">Bi-Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-tertiary pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-[12px] font-semibold text-ink-primary mb-1.5">
            Notes <span className="text-ink-tertiary font-normal">(optional)</span>
          </label>
          <textarea
            rows={3}
            value={draft.notes}
            onChange={e => onChange({ ...draft, notes: e.target.value })}
            placeholder="Add any notes for this job..."
            className="w-full px-3 py-2.5 text-[14px] bg-surface-chip rounded-[10px] border border-transparent focus:border-blue-500 focus:bg-white focus:outline-none transition-colors resize-y"
          />
        </div>

        {/* Checklist — plan tasks for the visit at create time. Empty by
            default; only persists if the user adds at least one item. */}
        <ChecklistEditor
          items={draft.checklist}
          onChange={next => onChange({ ...draft, checklist: next })}
        />
      </div>

      {/* Footer hint */}
      <div className="px-5 py-4 border-t border-edge-default">
        <div
          className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-[10px] text-[13px] font-semibold transition-colors ${
            valid
              ? 'bg-blue-50 text-blue-700'
              : 'bg-surface-chip text-ink-tertiary'
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          {valid ? 'Click any day on the calendar' : 'Add a title or client first'}
        </div>
      </div>
    </div>
  )
}

// Inline checklist editor used by the Add Job sheet. Mirrors the UX of the
// JobActionPanel ChecklistSection (toggle, delete-on-hover, Add input) but
// without backend mutations — it only edits a draft array that the parent
// flushes on submit. State for the input is local so typing doesn't bubble
// onChange noise into the parent on every keystroke.
function ChecklistEditor({
  items,
  onChange,
}: {
  items: { text: string; done: boolean }[]
  onChange: (next: { text: string; done: boolean }[]) => void
}) {
  const [draft, setDraft] = useState('')
  const submit = () => {
    const t = draft.trim()
    if (!t) return
    onChange([...items, { text: t, done: false }])
    setDraft('')
  }
  const toggle = (i: number) => {
    const next = items.slice()
    next[i] = { ...next[i], done: !next[i].done }
    onChange(next)
  }
  const remove = (i: number) => {
    const next = items.slice()
    next.splice(i, 1)
    onChange(next)
  }
  return (
    <div>
      <label className="block text-[12px] font-semibold text-ink-primary mb-1.5">
        Checklist <span className="text-ink-tertiary font-normal">(optional)</span>
      </label>
      {items.length > 0 && (
        <div className="space-y-1 mb-2">
          {items.map((item, i) => (
            <div key={i} className="group flex items-center gap-2 text-[13px]">
              <button
                type="button"
                onClick={() => toggle(i)}
                className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  item.done
                    ? 'bg-emerald-500 border-emerald-500 text-white'
                    : 'bg-surface-card border-edge-default hover:border-ink-tertiary'
                }`}
                aria-label={item.done ? 'Uncheck item' : 'Check item'}
              >
                {item.done && (
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5 9-10" />
                  </svg>
                )}
              </button>
              <span className={`flex-1 ${item.done ? 'line-through text-ink-tertiary' : 'text-ink-primary'}`}>{item.text}</span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="opacity-0 group-hover:opacity-100 text-ink-tertiary hover:text-red-500 text-[15px] leading-none transition-opacity"
                aria-label="Remove item"
              >×</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
          placeholder="Add an item…"
          className="flex-1 px-3 py-2 text-[13px] bg-surface-chip rounded-[10px] border border-transparent focus:border-blue-500 focus:bg-white focus:outline-none transition-colors"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim()}
          className="px-3 py-2 text-[12px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-[10px] disabled:opacity-40 transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  )
}

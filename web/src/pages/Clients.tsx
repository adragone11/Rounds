import { useState, useMemo } from 'react'
import { useStore } from '../store'
import { useCurrency } from '../lib/currency'
import { useLanguage } from '../lib/language'
import AddressAutocomplete from '../components/AddressAutocomplete'
import AddClientSheet from '../components/AddClientSheet'
import ImportClientsModal from '../components/ImportClientsModal'
import ColorPickerChip from '../components/ColorPickerChip'
import { dedupeJobs } from '../lib/jobs'
import { FollowUpCard, getOverdueJobs } from './Reports'
import type { Client, DayOfWeek } from '../types'

const DAY_LABELS: { day: DayOfWeek; label: string }[] = [
  { day: 0, label: 'Sun' }, { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' }, { day: 4, label: 'Thu' }, { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
]

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_ABBREVS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function shortAddress(address: string): string {
  return address.split(',')[0]?.trim() || address
}

function formatFrequency(client: Client, t: (key: string, options?: object) => string): string {
  switch (client.frequency) {
    case 'biweekly': return t('recurrence.biWeekly')
    case 'weekly': return t('recurrence.weekly')
    case 'monthly': return t('recurrence.monthly')
    case 'one-time': return t('recurrence.oneTime')
    case 'custom': return t('clientsWeb.everyWeeksShort', { count: client.intervalWeeks ?? '?' })
    default: return ''
  }
}

function frequencyBadgeClasses(frequency: Client['frequency']): string {
  // Light: pastel-100 bg + 700 text. Dark: 900/40 alpha bg + 300 text so the
  // chip reads as a tinted surface, not a glowing pill on a dark page.
  switch (frequency) {
    case 'biweekly': return 'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300'
    case 'weekly': return 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
    case 'monthly': return 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300'
    case 'one-time': return 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300'
    case 'custom': return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
    default: return 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300'
  }
}

export default function Clients() {
  const store = useStore()
  const { formatCurrency } = useCurrency()
  const { t } = useLanguage()
  const [search, setSearch] = useState('')
  const [showAddClient, setShowAddClient] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  // Always derive from the store so live store mutations (e.g. color picker)
  // reflect immediately in the detail panel without re-selecting.
  const selectedClient = useMemo(
    () => selectedClientId ? store.clients.find(c => c.id === selectedClientId) ?? null : null,
    [selectedClientId, store.clients],
  )
  const setSelectedClient = (c: Client | null) => setSelectedClientId(c?.id ?? null)
  const [activeTab, setActiveTab] = useState<'details' | 'jobs'>('details')
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sortBy, setSortBy] = useState<'name' | 'nextJob'>('nextJob')
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editAddress, setEditAddress] = useState('')
  const [editCoords, setEditCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [editBlockedDays, setEditBlockedDays] = useState<DayOfWeek[]>([])
  const [cadenceTab, setCadenceTab] = useState<'all' | 'weekly' | 'biweekly' | 'monthly' | 'one-time'>('all')

  const nextJobDates = useMemo(() => {
    const map = new Map<string, string>()
    const today = new Date()
    const todayStr = fmtDate(today)
    for (const client of store.clients) {
      for (let offset = 0; offset < 3; offset++) {
        const d = new Date(today.getFullYear(), today.getMonth() + offset, 1)
        const dates = store.getAllDatesForClient(client.id, d.getFullYear(), d.getMonth())
        const future = dates.filter(dt => dt >= todayStr).sort()
        if (future.length > 0) { map.set(client.id, future[0]); break }
      }
    }
    return map
  }, [store.clients, store.getAllDatesForClient])

  // Tab counts (computed against the unfiltered roster so the badge doesn't
  // shift when the user types in the search field).
  const tabCounts = useMemo(() => {
    let weekly = 0, biweekly = 0, monthly = 0, oneTime = 0
    for (const c of store.clients) {
      if (c.frequency === 'weekly') weekly += 1
      else if (c.frequency === 'biweekly') biweekly += 1
      else if (c.frequency === 'monthly') monthly += 1
      else if (c.frequency === 'one-time') oneTime += 1
    }
    return { all: store.clients.length, weekly, biweekly, monthly, oneTime }
  }, [store.clients])

  const filteredClients = useMemo(() => {
    let list = store.clients
    if (cadenceTab === 'weekly') {
      list = list.filter(c => c.frequency === 'weekly')
    } else if (cadenceTab === 'biweekly') {
      list = list.filter(c => c.frequency === 'biweekly')
    } else if (cadenceTab === 'monthly') {
      list = list.filter(c => c.frequency === 'monthly')
    } else if (cadenceTab === 'one-time') {
      list = list.filter(c => c.frequency === 'one-time')
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q))
    }
    if (sortBy === 'nextJob') {
      list = [...list].sort((a, b) => (nextJobDates.get(a.id) ?? 'z').localeCompare(nextJobDates.get(b.id) ?? 'z'))
    } else {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name))
    }
    return list
  }, [store.clients, search, sortBy, nextJobDates, cadenceTab])

  const upcomingDates = useMemo(() => {
    if (!selectedClient) return []
    const today = new Date()
    const todayStr = fmtDate(today)
    const dates: string[] = []
    for (let offset = 0; offset < 4; offset++) {
      const d = new Date(today.getFullYear(), today.getMonth() + offset, 1)
      dates.push(...store.getAllDatesForClient(selectedClient.id, d.getFullYear(), d.getMonth()).filter(dt => dt >= todayStr))
    }
    return [...new Set(dates)].sort()
  }, [selectedClient, store.getAllDatesForClient])

  // Per-client completed stats — same pipeline Reports uses, so the two screens
  // never disagree. Filters out templates/cancelled/deleted, dedupes historical
  // duplicate materializations, then sums price + duration.
  const clientStats = useMemo(() => {
    if (!selectedClient) return { count: 0, earned: 0, minutes: 0 }
    const completed = dedupeJobs(
      store.jobs.filter(j =>
        !j.deleted && !j.cancelled && !j.isTemplate &&
        j.clientId === selectedClient.id && j.completed
      )
    )
    const earned = completed.reduce((s, j) => s + (j.price ?? 0), 0)
    const minutes = completed.reduce((s, j) => s + ((j.actualDuration ?? j.duration ?? 0) * 60), 0)
    return { count: completed.length, earned, minutes }
  }, [selectedClient, store.jobs])

  const fmtHours = (mins: number): string => {
    if (mins <= 0) return '0h'
    const h = Math.floor(mins / 60)
    const m = Math.round(mins % 60)
    if (h === 0) return `${m}m`
    if (m === 0) return `${h}h`
    return `${h}h ${m}m`
  }

  const formatNextDate = (dateStr: string): string => {
    const d = new Date(dateStr + 'T00:00:00')
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${months[d.getMonth()]} ${d.getDate()}`
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  const selectAll = () => {
    if (selected.size === filteredClients.length) setSelected(new Set())
    else setSelected(new Set(filteredClients.map(c => c.id)))
  }
  const deleteSelected = () => {
    if (selected.size === 0) return
    if (!confirm(t('clientsWeb.confirmBulkDelete', { count: selected.size }))) return
    selected.forEach(id => store.removeClient(id))
    setSelected(new Set()); setSelectMode(false)
  }

  const startEdit = (client: Client) => {
    setEditing(true); setEditName(client.name); setEditAddress(client.address); setEditCoords(null); setEditBlockedDays(client.blockedDays ?? [])
  }
  const saveEdit = () => {
    if (!selectedClient || !editName.trim()) return
    store.updateClient(selectedClient.id, editName.trim(), editAddress.trim(), editCoords)
    store.updateClientBlockedDays(selectedClient.id, editBlockedDays)
    // selectedClient is derived from store.clients, so it'll re-render automatically.
    setEditing(false)
  }
  const toggleBlockedDay = (day: DayOfWeek) => {
    setEditBlockedDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day])
  }
  const deleteClient = () => {
    if (!selectedClient) return
    if (!confirm(t('clientsWeb.confirmDeleteSingle', { name: selectedClient.name }))) return
    store.removeClient(selectedClient.id); setSelectedClient(null); setEditing(false)
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-surface-page">
      {/* Top header */}
      <div className="shrink-0 px-8 pt-7 pb-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-bold text-ink-primary tracking-[-0.02em] leading-tight">
              {t('clients.title')}
            </h1>
            <p className="text-[13px] text-ink-secondary mt-1">
              {tabCounts.all} {tabCounts.all === 1 ? 'client' : 'clients'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowImport(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold text-gray-700 bg-white border border-gray-300 rounded-[10px] hover:bg-gray-50 transition-colors"
            >
              <svg className="w-[14px] h-[14px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
              </svg>
              Import
            </button>
            <button
              onClick={() => setShowAddClient(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold text-white bg-gray-900 rounded-[10px] hover:bg-gray-700 transition-colors"
            >
              <svg className="w-[14px] h-[14px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {t('clientsWeb.addClient') || 'Add Client'}
            </button>
          </div>
        </div>
      </div>

      {/* Main: two columns */}
      <div className="flex-1 flex min-h-0">
        {/* Left: client list */}
        <div className="flex-1 flex flex-col min-w-0 px-8 pb-6">
          {/* Search + sort */}
          <div className="flex items-center gap-2.5 mb-3">
            <div className="flex-1 bg-white rounded-[10px] border border-edge-default px-3.5 py-2.5 flex items-center gap-2.5">
              <svg className="w-[15px] h-[15px] text-ink-tertiary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4-4" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('clients.searchPlaceholder')}
                className="flex-1 bg-transparent text-[14px] text-ink-primary placeholder:text-ink-tertiary outline-none min-w-0"
              />
            </div>
            <button
              onClick={() => setSortBy(prev => prev === 'nextJob' ? 'name' : 'nextJob')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-[13px] font-semibold text-ink-primary bg-white border border-edge-default rounded-[10px] hover:bg-gray-50 transition-colors"
            >
              <svg className="w-[14px] h-[14px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 4v16M3 8l4-4 4 4" />
                <path d="M17 20V4M13 16l4 4 4-4" />
              </svg>
              {sortBy === 'nextJob' ? t('clientsWeb.sort.nextJob') : t('clientsWeb.sort.name')}
            </button>
          </div>

          {/* Cadence tabs — only show frequencies the user actually has */}
          <div className="flex gap-6 border-b border-edge-default mb-3 -mx-1 px-1 overflow-x-auto">
            {([
              { key: 'all' as const,      label: t('common.all') || 'All',                  count: tabCounts.all,      show: true },
              { key: 'weekly' as const,   label: t('recurrence.weekly') || 'Weekly',        count: tabCounts.weekly,   show: tabCounts.weekly > 0 },
              { key: 'biweekly' as const, label: t('recurrence.biWeekly') || 'Bi-weekly',   count: tabCounts.biweekly, show: tabCounts.biweekly > 0 },
              { key: 'monthly' as const,  label: t('recurrence.monthly') || 'Monthly',      count: tabCounts.monthly,  show: tabCounts.monthly > 0 },
              { key: 'one-time' as const, label: t('recurrence.oneTime') || 'One-time',     count: tabCounts.oneTime,  show: tabCounts.oneTime > 0 },
            ]).filter(tab => tab.show).map(tab => {
              const active = cadenceTab === tab.key
              return (
                <button
                  key={tab.key}
                  onClick={() => setCadenceTab(tab.key)}
                  className={`flex items-center gap-1.5 py-2.5 text-[13px] font-semibold transition-colors whitespace-nowrap border-b-2 -mb-px ${
                    active ? 'text-ink-primary border-ink-primary' : 'text-ink-secondary border-transparent hover:text-ink-primary'
                  }`}
                >
                  {tab.label}
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface-chip text-ink-secondary">
                    {tab.count}
                  </span>
                </button>
              )
            })}
            {selectMode ? (
              <div className="ml-auto flex items-center gap-3 py-2.5">
                <button onClick={selectAll} className="text-[13px] font-semibold text-blue-600">
                  {selected.size === filteredClients.length ? t('clients.bulkDelete.deselectAll') : t('common.all')}
                </button>
                <button onClick={deleteSelected} disabled={selected.size === 0} className="text-[13px] text-red-500 font-semibold disabled:opacity-40">
                  {t('clientsWeb.deleteCount', { count: selected.size })}
                </button>
                <button onClick={() => { setSelectMode(false); setSelected(new Set()) }} className="text-[13px] text-ink-secondary">
                  {t('common.cancel')}
                </button>
              </div>
            ) : store.clients.length > 0 && (
              <button onClick={() => setSelectMode(true)} className="ml-auto py-2.5 text-[13px] text-ink-secondary font-semibold hover:text-ink-primary transition-colors">
                {t('common.edit')}
              </button>
            )}
          </div>

          {/* List — 2-col grid so cards don't stretch full width */}
          <div className="flex-1 overflow-y-auto pr-1">
            {store.clients.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <div className="w-14 h-14 rounded-2xl bg-white/80 flex items-center justify-center mx-auto mb-3 shadow-sm">
                    <svg className="w-7 h-7 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg>
                  </div>
                  <p className="text-sm font-semibold text-gray-600">{t('clients.emptyStates.noClientsTitle')}</p>
                  <p className="text-xs text-gray-400 mt-1 mb-4">{t('clientsWeb.addClientSubtitle') || 'Add your first client to get started.'}</p>
                  <button onClick={() => setShowAddClient(true)} className="px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-800 transition-colors">{t('clientsWeb.addClient') || 'Add Client'}</button>
                </div>
              </div>
            ) : (<div className="grid grid-cols-2 gap-2">{filteredClients.map(client => {
              const nextDate = nextJobDates.get(client.id)
              const isActive = selectedClient?.id === client.id
              return (
                <div key={client.id}
                  onClick={() => { if (selectMode) { toggleSelect(client.id); return }; setSelectedClient(client); setActiveTab('details'); setEditing(false) }}
                  className={`flex items-center gap-3 px-4 py-3 bg-white rounded-2xl cursor-pointer transition-all shadow-sm ${
                    isActive ? 'ring-2 ring-blue-400/50 shadow-md' : 'hover:shadow-md'
                  } ${selected.has(client.id) ? 'ring-2 ring-blue-500' : ''}`}
                >
                  {selectMode && <input type="checkbox" checked={selected.has(client.id)} onChange={() => toggleSelect(client.id)} onClick={e => e.stopPropagation()} className="w-4 h-4 rounded border-gray-300 text-blue-600 shrink-0" />}
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm shrink-0" style={{ backgroundColor: client.color }}>{getInitials(client.name)}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{client.name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${frequencyBadgeClasses(client.frequency)}`}>
                        {formatFrequency(client, t)}
                      </span>
                      {client.address && <p className="text-xs text-gray-400 truncate">{shortAddress(client.address)}</p>}
                    </div>
                  </div>
                  {nextDate && !selectMode && (
                    <span className="text-xs font-medium px-2 py-1 bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 rounded-lg shrink-0">
                      {t('clientsWeb.nextAbbr', { date: formatNextDate(nextDate) })}
                    </span>
                  )}
                </div>
              )
            })}</div>)}
          </div>
        </div>

        {/* Right: detail panel (inline, not modal) */}
        <div className="w-96 shrink-0 border-l border-gray-200/60 overflow-y-auto">
          {selectedClient ? (
            <div className="p-6">
              {/* Header */}
              <div className="flex items-center justify-between mb-4">
                <button onClick={() => { setSelectedClient(null); setEditing(false) }} className="text-xs text-gray-400 hover:text-gray-600 font-medium">{t('clientsWeb.close')}</button>
                <button onClick={() => editing ? saveEdit() : startEdit(selectedClient)} className="text-xs font-medium" style={{ color: '#4A7CFF' }}>
                  {editing ? t('common.save') : t('common.edit')}
                </button>
              </div>

              {/* Avatar + Name */}
              <div className="flex flex-col items-center mb-5">
                <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-white font-bold text-2xl mb-3" style={{ backgroundColor: selectedClient.color }}>
                  {getInitials(selectedClient.name)}
                </div>
                {editing ? (
                  <>
                    <input autoFocus value={editName} onChange={e => setEditName(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveEdit()}
                      className="text-xl font-bold text-gray-900 text-center bg-white border border-gray-300 rounded-lg px-3 py-1 focus:outline-none focus:ring-2 focus:ring-blue-200" />
                    <div className="mt-2">
                      <ColorPickerChip
                        color={selectedClient.color}
                        label={selectedClient.name || 'Color'}
                        onChange={hex => store.updateClientColor(selectedClient.id, hex)}
                        size="sm"
                      />
                    </div>
                  </>
                ) : (
                  <h2 className="text-xl font-bold text-gray-900">{selectedClient.name}</h2>
                )}
              </div>

              {/* Tabs */}
              <div className="flex bg-surface-chip rounded-[10px] p-[3px] mb-5">
                <button
                  onClick={() => setActiveTab('details')}
                  className={`flex-1 py-1.5 text-[13px] font-semibold rounded-[7px] transition-all ${
                    activeTab === 'details' ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
                  }`}
                >
                  {t('clientDetail.tabDetails')}
                </button>
                <button
                  onClick={() => setActiveTab('jobs')}
                  className={`flex-1 py-1.5 text-[13px] font-semibold rounded-[7px] transition-all ${
                    activeTab === 'jobs' ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
                  }`}
                >
                  {t('clientDetail.tabJobs')}
                </button>
              </div>

              {activeTab === 'details' ? (
                <>
                  {/* Stats */}
                  <div className="mb-4">
                    <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">{t('clientDetail.stats.completedJobs')}</p>
                    <div className="bg-white rounded-2xl flex divide-x divide-gray-100 shadow-sm">
                      <div className="flex-1 py-3 text-center"><p className="text-lg font-bold text-gray-900">{clientStats.count}</p><p className="text-[10px] text-gray-400">{t('clientDetail.stats.jobs')}</p></div>
                      <div className="flex-1 py-3 text-center"><p className="text-lg font-bold text-green-600">{formatCurrency(clientStats.earned)}</p><p className="text-[10px] text-gray-400">{t('clientDetail.stats.earned')}</p></div>
                      <div className="flex-1 py-3 text-center"><p className="text-lg font-bold text-gray-900">{fmtHours(clientStats.minutes)}</p><p className="text-[10px] text-gray-400">{t('clientDetail.stats.hours')}</p></div>
                    </div>
                  </div>

                  {/* Contact */}
                  <div className="mb-4">
                    <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">{t('clientDetail.contactInfo.title')}</p>
                    <div className="bg-white rounded-2xl overflow-hidden shadow-sm">
                      {editing ? (
                        <div className="p-3 space-y-3">
                          <AddressAutocomplete value={editAddress} onChange={v => { setEditAddress(v); setEditCoords(null) }}
                            onSelect={r => { setEditAddress(r.address); setEditCoords({ lat: r.lat, lng: r.lng }) }}
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200" placeholder="Address" />
                          <div>
                            <p className="text-xs font-medium text-gray-500 mb-1.5">Blocked Days</p>
                            <div className="flex gap-1.5">
                              {DAY_LABELS.map(({ day, label }) => (
                                <button key={day} type="button" onClick={() => toggleBlockedDay(day)}
                                  className={`px-2 py-1 text-xs rounded-md font-medium transition-colors ${editBlockedDays.includes(day) ? 'bg-red-100 text-red-700 border border-red-300' : 'bg-gray-100 text-gray-500 border border-gray-200 hover:bg-gray-200'}`}>{label}</button>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : selectedClient.address ? (
                        <>
                          <div className="flex items-center gap-3 px-4 py-3">
                            <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                              <svg className="w-4 h-4 text-blue-500" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>
                            </div>
                            <p className="text-sm text-gray-900 flex-1">{selectedClient.address}</p>
                            <button onClick={() => navigator.clipboard.writeText(selectedClient.address)} className="text-gray-400 hover:text-gray-600 shrink-0" title="Copy">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                            </button>
                          </div>
                          <a href={`https://maps.apple.com/?daddr=${encodeURIComponent(selectedClient.address)}`} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-3 px-4 py-3 border-t border-gray-100 hover:bg-blue-50/50 transition-colors" style={{ color: '#4A7CFF' }}>
                            <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                              <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>
                            </div>
                            <span className="text-sm font-medium">Directions</span>
                          </a>
                        </>
                      ) : <p className="px-4 py-3 text-sm text-gray-400">No address</p>}
                    </div>
                  </div>

                  {/* Blocked days */}
                  {selectedClient.blockedDays && selectedClient.blockedDays.length > 0 && !editing && (
                    <div className="mb-4">
                      <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">Blocked Days</p>
                      <div className="flex gap-1.5">
                        {DAY_LABELS.map(({ day, label }) => (
                          <span key={day} className={`px-2.5 py-1 text-xs rounded-md font-medium ${selectedClient.blockedDays.includes(day) ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-300'}`}>{label}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedClient.startDate && (
                    <p className="text-center text-sm text-gray-400">{formatFrequency(selectedClient, t)} &middot; {DAY_NAMES[new Date(selectedClient.startDate + 'T00:00:00').getDay()]}s</p>
                  )}

                  {editing && (
                    <button onClick={deleteClient} className="w-full mt-4 py-2.5 text-sm font-medium text-red-500 bg-red-50 rounded-xl hover:bg-red-100 transition-colors">Delete Client</button>
                  )}
                </>
              ) : (
                /* Jobs tab */
                <>
                  {(() => {
                    const clientJobs = store.jobs.filter(j =>
                      !j.deleted && !j.isTemplate && j.clientId === selectedClient.id
                    )
                    const overdue = getOverdueJobs(clientJobs)
                    if (overdue.length === 0) return null
                    return (
                      <div className="mb-6">
                        <FollowUpCard activeJobs={clientJobs} clients={[selectedClient]} />
                      </div>
                    )
                  })()}
                  <div className="mb-6">
                    <h3 className="text-sm font-bold text-gray-900 mb-3">Upcoming Jobs</h3>
                    {upcomingDates.length > 0 ? (
                      <div className="space-y-2">
                        {upcomingDates.map(dateStr => {
                          const d = new Date(dateStr + 'T00:00:00')
                          const dur = store.getClientDuration(selectedClient.id)
                          const durLabel = dur >= 60 ? `${Math.floor(dur / 60)}h${dur % 60 > 0 ? ` ${dur % 60}m` : ''}` : `${dur}m`
                          // Pull price from a real or virtual job for this date if one exists.
                          // Past visits without a price stay 0 — there's no longer a per-client default.
                          const jobOnDate = store.jobs.find(j =>
                            !j.deleted && !j.cancelled && !j.isTemplate &&
                            j.clientId === selectedClient.id && j.date === dateStr
                          )
                          const price = jobOnDate?.price ?? 0
                          return (
                            <div key={dateStr} className="bg-white rounded-2xl p-3.5 shadow-sm">
                              <div className="flex items-center gap-3 mb-2">
                                <div className="w-10 h-10 rounded-xl flex flex-col items-center justify-center text-white shrink-0" style={{ backgroundColor: selectedClient.color }}>
                                  <span className="text-sm font-bold leading-none">{d.getDate()}</span>
                                  <span className="text-[8px] font-semibold leading-none mt-0.5">{MONTH_ABBREVS[d.getMonth()]}</span>
                                </div>
                                <span className="text-sm font-semibold text-gray-900">{DAY_NAMES[d.getDay()]}</span>
                                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${frequencyBadgeClasses(selectedClient.frequency)}`}>{formatFrequency(selectedClient, t)}</span>
                                {price > 0 && (
                                  <span className="ml-auto text-sm font-bold text-gray-900">{formatCurrency(price)}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 text-xs text-gray-500">
                                {selectedClient.address && (
                                  <span className="flex items-center gap-1 truncate">
                                    <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>
                                    {shortAddress(selectedClient.address)}
                                  </span>
                                )}
                                <span className="ml-auto font-medium">{durLabel}</span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : <p className="text-sm text-gray-400 text-center py-4">No upcoming jobs</p>}
                  </div>
                  {(() => {
                    // Past Jobs = anything historical for this client. Includes
                    // cancelled jobs (formerly-completed-then-cancelled, or just
                    // cancelled) so the user has full visibility — cancellation
                    // is a render-side override on the money, not a hide. The
                    // earnings stat at the top of the panel already excludes
                    // cancelled, so the totals stay honest.
                    const pastJobs = dedupeJobs(
                      store.jobs.filter(j =>
                        !j.deleted && !j.isTemplate &&
                        j.clientId === selectedClient.id &&
                        (j.completed || j.cancelled)
                      )
                    ).sort((a, b) => (a.date < b.date ? 1 : -1))
                    return (
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-sm font-bold text-gray-900">Past Jobs</h3>
                          <span className="text-sm text-gray-400">{pastJobs.length}</span>
                        </div>
                        {pastJobs.length === 0 ? (
                          <p className="text-sm text-gray-400 text-center py-4">No past jobs</p>
                        ) : (
                          <div className="space-y-2">
                            {pastJobs.map(job => {
                              const d = new Date(job.date + 'T00:00:00')
                              const price = job.price ?? 0
                              const isCancelled = !!job.cancelled
                              const isPaid = !isCancelled && !!job.paid
                              const isFree = price <= 0
                              return (
                                <div key={job.id} className="bg-white rounded-2xl p-3 shadow-sm flex items-center gap-3">
                                  <div className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center text-white shrink-0 ${isCancelled ? 'grayscale opacity-60' : ''}`} style={{ backgroundColor: selectedClient.color }}>
                                    <span className="text-sm font-bold leading-none">{d.getDate()}</span>
                                    <span className="text-[8px] font-semibold leading-none mt-0.5">{MONTH_ABBREVS[d.getMonth()]}</span>
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className={`text-sm font-semibold text-gray-900 ${isCancelled ? 'line-through opacity-60' : ''}`}>{DAY_NAMES[d.getDay()]}</p>
                                    <p className="text-xs text-gray-400">{d.getFullYear()}</p>
                                  </div>
                                  <div className="flex flex-col items-end gap-1 shrink-0">
                                    {!isFree && (
                                      <span className={`text-sm font-bold ${
                                        isCancelled ? 'text-gray-400 line-through'
                                        : isPaid ? 'text-emerald-600'
                                        : 'text-gray-900'
                                      }`}>
                                        {formatCurrency(price)}
                                      </span>
                                    )}
                                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                                      isCancelled ? 'bg-red-50 text-red-700'
                                      : isFree ? 'bg-gray-100 text-gray-500'
                                      : isPaid ? 'bg-emerald-50 text-emerald-700'
                                      : 'bg-amber-50 text-amber-700'
                                    }`}>
                                      {isCancelled ? 'Cancelled'
                                        : isFree ? 'No charge'
                                        : isPaid ? 'Paid'
                                        : 'Unpaid'}
                                    </span>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-sm text-gray-400">Select a client</p>
                <p className="text-xs text-gray-300 mt-1">Details will appear here</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add Client sheet */}
      <AddClientSheet
        open={showAddClient}
        onClose={() => setShowAddClient(false)}
        onCreated={(id) => { setSelectedClientId(id); setActiveTab('details') }}
      />

      {/* Import Clients modal */}
      {showImport && <ImportClientsModal onClose={() => setShowImport(false)} />}

    </div>
  )
}

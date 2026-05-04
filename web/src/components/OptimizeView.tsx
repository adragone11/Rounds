import { useState, useMemo, useEffect } from 'react'
import type { Client, ProposedMove, OptimizationStatus } from '../types'
import { generateOptimization, computeDaySavings, buildRosterFingerprint, type SwapPair } from '../optimizer'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_COLORS = ['#F97316', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4']

const STATUS_CONFIG: Record<OptimizationStatus, { label: string; color: string; bg: string }> = {
  'to-ask':    { label: 'To Ask',      color: '#6B7280', bg: '#F3F4F6' },
  'waiting':   { label: 'Waiting',     color: '#F59E0B', bg: '#FFFBEB' },
  'confirmed': { label: 'Confirmed',   color: '#10B981', bg: '#ECFDF5' },
  'cant-move': { label: "Can't Move",  color: '#EF4444', bg: '#FEF2F2' },
  'skipped':   { label: 'Skip',        color: '#6366F1', bg: '#EEF2FF' },
}

const STORAGE_KEY = 'pip-optimization'

interface OptimizeSidebarProps {
  clients: Client[]
  clientDayMap: Map<string, number>
  onClose: () => void
  onPreviewMoves: (moves: ProposedMove[]) => void
  onApplyMove: (clientId: string, newDay: number) => void
  homeAddress: { address: string; lat: number; lng: number } | null
}

interface PersistedState {
  moves: ProposedMove[]
  swaps: SwapPair[]
  maxJobsPerDay: number
  workingDays: boolean[]
  perfectWorldMinutes: number
  rosterFingerprint?: string // tracks when client roster changes
}

function loadPersistedState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export default function OptimizeSidebar({ clients, clientDayMap, onClose, onPreviewMoves, onApplyMove, homeAddress }: OptimizeSidebarProps) {
  const [maxJobsPerDay, setMaxJobsPerDay] = useState(0)
  const [workingDays, setWorkingDays] = useState<boolean[]>([false, true, true, true, true, true, false])
  const [moves, setMoves] = useState<ProposedMove[]>([])
  const [swaps, setSwaps] = useState<SwapPair[]>([])
  const [perfectWorldMinutes, setPerfectWorldMinutes] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [diffDayClientId, setDiffDayClientId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selectedMoveId, setSelectedMoveId] = useState<string | null>(null)

  // Load persisted state — re-run if client roster changed since last cache
  useEffect(() => {
    const persisted = loadPersistedState()
    const currentFingerprint = buildRosterFingerprint(
      clients.filter(c => clientDayMap.has(c.id)).map(c => ({ client: c, currentDay: clientDayMap.get(c.id)! }))
    )

    if (persisted && persisted.rosterFingerprint === currentFingerprint) {
      // Same roster — restore cached results (deterministic)
      setMoves(persisted.moves)
      setSwaps(persisted.swaps)
      setMaxJobsPerDay(persisted.maxJobsPerDay)
      setWorkingDays(persisted.workingDays ?? [false, true, true, true, true, true, false])
      setPerfectWorldMinutes(persisted.perfectWorldMinutes)
      setInitialized(true)
    } else {
      // First time or roster changed — fresh optimization
      runOptimizer(persisted?.maxJobsPerDay ?? 0, persisted?.workingDays ?? [false, true, true, true, true, true, false])
    }
  }, [])

  // Persist on change (include roster fingerprint for cache invalidation)
  useEffect(() => {
    if (!initialized) return
    const rosterFingerprint = buildRosterFingerprint(
      clients.filter(c => clientDayMap.has(c.id)).map(c => ({ client: c, currentDay: clientDayMap.get(c.id)! }))
    )
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ moves, swaps, maxJobsPerDay, workingDays, perfectWorldMinutes, rosterFingerprint }))
  }, [moves, swaps, maxJobsPerDay, workingDays, perfectWorldMinutes, initialized])

  const runOptimizer = async (maxJobs: number, wd?: boolean[]) => {
    const days = wd ?? workingDays
    const clientsWithDays = clients
      .filter(c => clientDayMap.has(c.id))
      .map(c => ({ client: c, currentDay: clientDayMap.get(c.id)! }))

    setLoading(true)
    try {
      const result = await generateOptimization(clientsWithDays, { maxJobsPerDay: maxJobs, workingDays: days }, { lat: homeAddress!.lat, lng: homeAddress!.lng })
      setMoves(result.moves)
      setSwaps(result.swaps)
      setPerfectWorldMinutes(result.perfectWorldMinutes)
    } catch (err) {
      console.error('Optimizer failed:', err)
    } finally {
      setLoading(false)
      setInitialized(true)
    }
  }

  const refresh = async () => {
    const locked = new Set([
      ...moves.filter(m => m.status === 'confirmed' || m.status === 'cant-move').map(m => m.clientId),
      ...swaps.flatMap(s => {
        const ids: string[] = []
        if (s.moveA.status === 'confirmed' || s.moveA.status === 'cant-move') ids.push(s.moveA.clientId)
        if (s.moveB.status === 'confirmed' || s.moveB.status === 'cant-move') ids.push(s.moveB.clientId)
        return ids
      }),
    ])

    const clientsWithDays = clients
      .filter(c => clientDayMap.has(c.id) && !locked.has(c.id))
      .map(c => ({ client: c, currentDay: clientDayMap.get(c.id)! }))

    setLoading(true)
    try {
      const result = await generateOptimization(clientsWithDays, { maxJobsPerDay, workingDays }, { lat: homeAddress!.lat, lng: homeAddress!.lng })
      const lockedMoves = moves.filter(m => locked.has(m.clientId))
      const lockedSwaps = swaps.filter(s => locked.has(s.moveA.clientId) || locked.has(s.moveB.clientId))
      setMoves([...lockedMoves, ...result.moves])
      setSwaps([...lockedSwaps, ...result.swaps])
      setPerfectWorldMinutes(result.perfectWorldMinutes)
    } catch (err) {
      console.error('Refresh failed:', err)
    } finally {
      setLoading(false)
    }
  }

  // Stats
  const totalPotential = useMemo(() =>
    moves.reduce((s, m) => s + m.savingsMinutes, 0) + swaps.reduce((s, sw) => s + sw.totalSavings, 0),
  [moves, swaps])
  const confirmedSavings = useMemo(() =>
    moves.filter(m => m.status === 'confirmed').reduce((s, m) => s + m.savingsMinutes, 0) +
    swaps.reduce((s, sw) => {
      let v = 0
      if (sw.moveA.status === 'confirmed') v += sw.moveA.savingsMinutes
      if (sw.moveB.status === 'confirmed') v += sw.moveB.savingsMinutes
      return s + v
    }, 0),
  [moves, swaps])
  const allItems = moves.length + swaps.length * 2
  const resolvedItems = moves.filter(m => m.status === 'confirmed' || m.status === 'cant-move').length +
    swaps.reduce((s, sw) => s + (sw.moveA.status === 'confirmed' || sw.moveA.status === 'cant-move' ? 1 : 0) + (sw.moveB.status === 'confirmed' || sw.moveB.status === 'cant-move' ? 1 : 0), 0)

  const updateMoveStatus = (clientId: string, status: OptimizationStatus) => {
    setMoves(prev => prev.map(m => m.clientId === clientId ? { ...m, status } : m))
    setSwaps(prev => prev.map(sw => ({
      ...sw,
      moveA: sw.moveA.clientId === clientId ? { ...sw.moveA, status } : sw.moveA,
      moveB: sw.moveB.clientId === clientId ? { ...sw.moveB, status } : sw.moveB,
    })))
    // Auto-refresh remaining suggestions when a client can't move —
    // their rejection may open better options for other clients
    if (status === 'cant-move') {
      void refresh()
    }
  }

  const applyMove = (move: ProposedMove) => {
    onApplyMove(move.clientId, move.suggestedDay)
    // Remove the applied move from the list
    setMoves(prev => prev.filter(m => m.clientId !== move.clientId))
    setSwaps(prev => prev.filter(s => s.moveA.clientId !== move.clientId && s.moveB.clientId !== move.clientId))
  }

  const copyMessage = (move: ProposedMove) => {
    navigator.clipboard.writeText(move.suggestedMessage)
    setCopiedId(move.clientId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const formatTime = (min: number) => {
    if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`
    return `${min}m`
  }

  const handleMoveClick = (move: ProposedMove) => {
    if (selectedMoveId === move.clientId) {
      setSelectedMoveId(null)
      onPreviewMoves([])
      setExpandedId(null)
    } else {
      setSelectedMoveId(move.clientId)
      onPreviewMoves([move])
      setExpandedId(move.clientId)
    }
  }

  const handleSwapClick = (swap: SwapPair) => {
    const swapKey = `swap-${swap.moveA.clientId}`
    if (selectedMoveId === swapKey) {
      setSelectedMoveId(null)
      onPreviewMoves([])
      setExpandedId(null)
    } else {
      setSelectedMoveId(swapKey)
      onPreviewMoves([swap.moveA, swap.moveB])
      setExpandedId(null) // expand both via swap selection
    }
  }

  // "Different Day" data
  const diffDayOptions = useMemo(() => {
    if (!diffDayClientId) return []
    const client = clients.find(c => c.id === diffDayClientId)
    const currentDay = clientDayMap.get(diffDayClientId)
    if (!client || currentDay === undefined) return []

    const dayGroups = new Map<number, Client[]>()
    clients.forEach(c => {
      const day = clientDayMap.get(c.id)
      if (day !== undefined) {
        const group = dayGroups.get(day) || []
        group.push(c)
        dayGroups.set(day, group)
      }
    })

    return computeDaySavings(client, currentDay, dayGroups, maxJobsPerDay, workingDays,
      homeAddress ? { lat: homeAddress.lat, lng: homeAddress.lng } : undefined)
  }, [diffDayClientId, clients, clientDayMap, maxJobsPerDay, workingDays])

  // Gate: require home address
  if (!homeAddress) {
    return (
      <div className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0">
        <div className="p-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Optimize</h2>
          <button onClick={onClose} className="text-[10px] text-gray-400 hover:text-gray-600">Back</button>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-2">
              <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
              </svg>
            </div>
            <p className="text-[11px] font-medium text-gray-600">Set your starting address</p>
            <p className="text-[10px] text-gray-400 mt-0.5">A home address is needed to calculate accurate route times</p>
          </div>
        </div>
      </div>
    )
  }

  // Loading state
  if (!initialized && loading) {
    return (
      <div className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0">
        <div className="p-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Optimize</h2>
          <button onClick={onClose} className="text-[10px] text-gray-400 hover:text-gray-600">Back</button>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center">
            <div className="w-8 h-8 border-3 border-gray-200 border-t-green-500 rounded-full animate-spin mx-auto mb-3" />
            <p className="text-[11px] font-medium text-gray-600">Analyzing...</p>
            <p className="text-[10px] text-gray-400 mt-0.5">Calculating drive times</p>
          </div>
        </div>
      </div>
    )
  }

  // Empty state
  if (initialized && moves.length === 0 && swaps.length === 0) {
    return (
      <div className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0">
        <div className="p-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Optimize</h2>
          <button onClick={onClose} className="text-[10px] text-gray-400 hover:text-gray-600">Back</button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-2">
              <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-[11px] font-medium text-gray-600">Looks good</p>
            <p className="text-[10px] text-gray-400 mt-0.5">No improvements found</p>
          </div>
          <button
            onClick={() => void runOptimizer(maxJobsPerDay)}
            disabled={loading}
            className="mt-4 px-3 py-1.5 text-[10px] font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-40"
          >
            {loading ? 'Scanning...' : 'Run again'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0">
      {/* Header */}
      <div className="p-2.5 border-b border-gray-200">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Optimize</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 text-gray-400"
              title="Settings"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button
              onClick={refresh}
              disabled={loading}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 text-gray-400 disabled:opacity-40"
              title={loading ? 'Scanning...' : 'Re-scan schedule'}
            >
              <svg className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M2.985 19.644l3.181-3.182" />
              </svg>
            </button>
            <button
              onClick={() => {
                localStorage.removeItem(STORAGE_KEY)
                setMoves([])
                setSwaps([])
                setPerfectWorldMinutes(0)
                setInitialized(true)
                onPreviewMoves([])
              }}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 text-gray-400"
              title="Clear results"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <button onClick={onClose} className="text-[10px] text-gray-400 hover:text-gray-600 font-medium ml-0.5">Back</button>
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div className="mb-2 p-2 bg-white rounded-lg border border-gray-200 space-y-2">
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">Max jobs/day</label>
              <select
                value={maxJobsPerDay}
                onChange={e => {
                  const v = parseInt(e.target.value)
                  setMaxJobsPerDay(v)
                  void runOptimizer(v)
                }}
                className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 w-full"
              >
                <option value={0}>No limit</option>
                {[3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n} per day</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">Working days</label>
              <div className="flex gap-0.5">
                {DAYS.map((day, i) => (
                  <button
                    key={day}
                    onClick={() => {
                      const next = [...workingDays]
                      next[i] = !next[i]
                      setWorkingDays(next)
                      void runOptimizer(maxJobsPerDay, next)
                    }}
                    className={`flex-1 h-5 text-[8px] font-medium rounded transition-colors ${
                      workingDays[i]
                        ? 'bg-gray-900 text-white'
                        : 'bg-white text-gray-400 border border-gray-200'
                    }`}
                  >
                    {day[0]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Stats bar */}
        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <div className="flex-1 bg-green-50 rounded px-2 py-1">
              <p className="text-[8px] text-green-600 font-medium uppercase">Potential</p>
              <p className="text-xs font-bold text-green-700">{formatTime(totalPotential)}<span className="text-[8px] font-normal text-green-500">/wk</span></p>
            </div>
            <div className="flex-1 bg-gray-100 rounded px-2 py-1">
              <p className="text-[8px] text-gray-500 font-medium uppercase">Confirmed</p>
              <p className="text-xs font-bold text-gray-800">{formatTime(confirmedSavings)}<span className="text-[8px] font-normal text-gray-400">/wk</span></p>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <p className="text-[9px] text-gray-400">{resolvedItems}/{allItems} resolved</p>
            </div>
            <div className="h-1 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${allItems > 0 ? (resolvedItems / allItems) * 100 : 0}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {/* Individual moves */}
        {moves.length > 0 && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1 px-0.5">
              Moves ({moves.length})
            </p>
            <div className="space-y-1">
              {moves.map(move => (
                <SidebarMoveCard
                  key={move.clientId}
                  move={move}
                  isExpanded={expandedId === move.clientId}
                  isSelected={selectedMoveId === move.clientId}
                  copiedId={copiedId}
                  onToggle={() => handleMoveClick(move)}
                  onStatusChange={status => updateMoveStatus(move.clientId, status)}
                  onCopy={() => copyMessage(move)}
                  onDifferentDay={() => setDiffDayClientId(move.clientId)}
                  onApply={() => applyMove(move)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Swap pairs */}
        {swaps.length > 0 && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1 px-0.5 mt-2">
              Swaps ({swaps.length})
            </p>
            <div className="space-y-1.5">
              {swaps.map(swap => {
                const swapKey = `swap-${swap.moveA.clientId}`
                const isSwapSelected = selectedMoveId === swapKey
                const bothConfirmed = swap.moveA.status === 'confirmed' && swap.moveB.status === 'confirmed'
                return (
                <div key={`${swap.moveA.clientId}-${swap.moveB.clientId}`} className={`bg-white rounded-lg border overflow-hidden transition-all ${isSwapSelected ? 'border-green-300 ring-1 ring-green-200' : 'border-gray-200'}`}>
                  <div
                    className="px-2 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => handleSwapClick(swap)}
                  >
                    <div className="flex items-center gap-1">
                      <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                      </svg>
                      <span className="text-[9px] font-medium text-gray-500">Swap — preview both</span>
                    </div>
                    <span className="text-[9px] font-bold text-green-600">-{swap.totalSavings}m</span>
                  </div>
                  <SidebarMoveCard
                    move={swap.moveA}
                    isExpanded={expandedId === swap.moveA.clientId || isSwapSelected}
                    isSelected={selectedMoveId === swap.moveA.clientId || isSwapSelected}
                    copiedId={copiedId}
                    onToggle={() => handleMoveClick(swap.moveA)}
                    onStatusChange={status => updateMoveStatus(swap.moveA.clientId, status)}
                    onCopy={() => copyMessage(swap.moveA)}
                    onDifferentDay={() => setDiffDayClientId(swap.moveA.clientId)}
                    noBorder
                  />
                  <div className="border-t border-gray-100" />
                  <SidebarMoveCard
                    move={swap.moveB}
                    isExpanded={expandedId === swap.moveB.clientId || isSwapSelected}
                    isSelected={selectedMoveId === swap.moveB.clientId || isSwapSelected}
                    copiedId={copiedId}
                    onToggle={() => handleMoveClick(swap.moveB)}
                    onStatusChange={status => updateMoveStatus(swap.moveB.clientId, status)}
                    onCopy={() => copyMessage(swap.moveB)}
                    onDifferentDay={() => setDiffDayClientId(swap.moveB.clientId)}
                    noBorder
                  />
                  {bothConfirmed && (
                    <div className="p-2 border-t border-gray-100 bg-green-50/50">
                      <button
                        onClick={() => { applyMove(swap.moveA); applyMove(swap.moveB) }}
                        className="w-full flex items-center justify-center gap-1 px-1.5 py-1.5 text-[10px] font-semibold text-white bg-green-600 rounded hover:bg-green-700 transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                        Apply Swap to Schedule
                      </button>
                    </div>
                  )}
                </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Different Day picker modal */}
      {diffDayClientId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setDiffDayClientId(null)}>
          <div className="bg-white rounded-xl shadow-xl p-5 w-80" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold text-gray-900 mb-1">Check another day</p>
            <p className="text-xs text-gray-400 mb-4">
              {clients.find(c => c.id === diffDayClientId)?.name} — currently {DAYS_FULL[clientDayMap.get(diffDayClientId) ?? 0]}
            </p>

            {diffDayOptions.length === 0 ? (
              <p className="text-sm text-gray-400">No better days available.</p>
            ) : (
              <div className="space-y-1.5 mb-4">
                {diffDayOptions.map(opt => (
                  <button
                    key={opt.day}
                    onClick={() => {
                      setMoves(prev => prev.map(m =>
                        m.clientId === diffDayClientId
                          ? {
                              ...m,
                              suggestedDay: opt.day,
                              savingsMinutes: opt.savings,
                              suggestedMessage: `Hey ${m.clientName.split(' ')[0]}, would ${DAYS_FULL[opt.day]}s work for you going forward instead of ${DAYS_FULL[m.currentDay]}s?`,
                            }
                          : m
                      ))
                      setDiffDayClientId(null)
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors text-left"
                  >
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: DAY_COLORS[opt.day] }} />
                    <span className="text-sm font-medium text-gray-800 flex-1">{DAYS_FULL[opt.day]}</span>
                    <span className="text-sm font-bold text-green-600">-{opt.savings} min</span>
                    <span className="text-[10px] text-gray-400">{opt.clientCount} clients</span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex justify-between">
              <button onClick={() => setDiffDayClientId(null)} className="text-xs text-gray-500 hover:text-gray-700">
                Cancel
              </button>
              <button
                onClick={() => {
                  updateMoveStatus(diffDayClientId, 'cant-move')
                  setDiffDayClientId(null)
                }}
                className="text-xs text-red-500 hover:text-red-700"
              >
                Keep on current day
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Sidebar Move Card (compact) ── */
function SidebarMoveCard({ move, isExpanded, isSelected, copiedId, onToggle, onStatusChange, onCopy, onDifferentDay, onApply, noBorder }: {
  move: ProposedMove
  isExpanded: boolean
  isSelected: boolean
  copiedId: string | null
  onToggle: () => void
  onStatusChange: (status: OptimizationStatus) => void
  onCopy: () => void
  onDifferentDay: () => void
  onApply?: () => void
  noBorder?: boolean
}) {
  const config = STATUS_CONFIG[move.status]

  return (
    <div className={`${noBorder ? '' : 'bg-white rounded-lg border'} transition-all ${
      isSelected ? (noBorder ? 'bg-blue-50/50' : 'border-blue-300 bg-blue-50/30 ring-1 ring-blue-200')
      : move.status === 'confirmed' ? (noBorder ? 'bg-green-50/30' : 'border-green-200 bg-green-50/30')
      : move.status === 'cant-move' ? 'opacity-50'
      : noBorder ? '' : 'border-gray-200'
    }`}>
      <div className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer" onClick={onToggle}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <p className="text-[11px] font-semibold text-gray-900 truncate">{move.clientName}</p>
            <span className="text-[8px] font-medium px-1 py-px rounded-full shrink-0" style={{ color: config.color, backgroundColor: config.bg }}>
              {config.label}
            </span>
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: DAY_COLORS[move.currentDay] }} />
            <span className="text-[10px] text-gray-400">{DAYS[move.currentDay]}</span>
            <svg className="w-2.5 h-2.5 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: DAY_COLORS[move.suggestedDay] }} />
            <span className="text-[10px] font-medium text-gray-600">{DAYS[move.suggestedDay]}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] font-bold text-green-600">-{move.savingsMinutes}m</p>
        </div>
      </div>

      {isExpanded && (
        <div className="px-2 pb-2 border-t border-gray-100">
          <p className="text-[10px] text-gray-500 mt-1.5 mb-2 leading-relaxed">{move.reason}</p>

          {/* Suggested message */}
          <div className="bg-gray-50 rounded p-1.5 mb-2">
            <div className="flex items-center justify-between mb-0.5">
              <p className="text-[8px] font-semibold text-gray-400 uppercase tracking-wider">Message</p>
              <button onClick={onCopy} className="text-[9px] text-blue-600 hover:text-blue-800 font-medium">
                {copiedId === move.clientId ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="text-[10px] text-gray-600 italic leading-relaxed">"{move.suggestedMessage}"</p>
          </div>

          {/* Status buttons */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1">
              {(['to-ask', 'waiting', 'confirmed', 'cant-move', 'skipped'] as const).map(status => {
                const sc = STATUS_CONFIG[status]
                const isActive = move.status === status
                return (
                  <button
                    key={status}
                    onClick={() => onStatusChange(status)}
                    className={`px-1.5 py-0.5 text-[9px] font-medium rounded transition-all ${
                      isActive ? 'ring-1 ring-offset-0.5' : 'hover:opacity-80'
                    }`}
                    style={{
                      color: sc.color,
                      backgroundColor: sc.bg,
                      ...(isActive ? { boxShadow: `0 0 0 1px ${sc.color}40` } : {}),
                    }}
                  >
                    {sc.label}
                  </button>
                )
              })}
            </div>
            <button
              onClick={onDifferentDay}
              className="w-full px-1.5 py-1 text-[9px] font-medium text-blue-600 bg-blue-50 rounded hover:bg-blue-100 text-center"
            >
              Different Day
            </button>
            {move.status === 'confirmed' && onApply && (
              <button
                onClick={onApply}
                className="w-full flex items-center justify-center gap-1 px-1.5 py-1.5 text-[10px] font-semibold text-white bg-green-600 rounded hover:bg-green-700 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                Apply to Schedule
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

import { useState, useMemo, useRef, useEffect } from 'react'
import type { Client, TransitionMove, TransitionState, OptimizationStatus, SchedulePlan, PlanClient } from '../types'
import { computeSwapCandidates } from '../optimizer'
import type { SwapCandidate } from '../optimizer'
import { useStore } from '../store'
import { useTheme } from '../lib/theme'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_COLORS = ['#F97316', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4']

const STATUS_CONFIG: Record<OptimizationStatus, { label: string; color: string; bg: string }> = {
  'to-ask':    { label: 'To Ask',      color: '#6B7280', bg: '#F3F4F6' },
  'waiting':   { label: 'Waiting',     color: '#F59E0B', bg: '#FFFBEB' },
  'confirmed': { label: 'Confirmed',   color: '#10B981', bg: '#ECFDF5' },
  'cant-move': { label: "Can't Move",  color: '#EF4444', bg: '#FEF2F2' },
  'skipped':   { label: 'Skip',        color: '#6366F1', bg: '#EEF2FF' }, // kept for type compat; no longer user-facing
}

// Dark-mode palette: lift text to ~300-tone for legibility on dark surfaces and
// use translucent color washes (~18% alpha) for the bg so badges stay tinted by
// their identity color but don't glow against the page.
const STATUS_CONFIG_DARK: Record<OptimizationStatus, { label: string; color: string; bg: string }> = {
  'to-ask':    { label: 'To Ask',      color: '#9CA3AF', bg: 'rgba(255,255,255,0.08)' },
  'waiting':   { label: 'Waiting',     color: '#FCD34D', bg: 'rgba(245,158,11,0.18)' },
  'confirmed': { label: 'Confirmed',   color: '#6EE7B7', bg: 'rgba(16,185,129,0.18)' },
  'cant-move': { label: "Can't Move",  color: '#FCA5A5', bg: 'rgba(239,68,68,0.18)' },
  'skipped':   { label: 'Skip',        color: '#A5B4FC', bg: 'rgba(99,102,241,0.18)' },
}

type MessageTemplate = {
  id: string
  label: string
  render: (firstName: string, newDay: string) => string
}

const MESSAGE_TEMPLATES: MessageTemplate[] = [
  {
    id: 'warm',
    label: 'Warm',
    render: (name, day) =>
      `Hi ${name}! Reworking my route so I can get to everyone faster and on time. Your cleaning is going to be on ${day}s from now on — same time, same service. Let me know if there's a real ${day} conflict.`,
  },
  {
    id: 'pricing',
    label: 'Pricing',
    render: (name, day) =>
      `Hey ${name}, quick heads up — I'm reworking my schedule so I can keep my rates steady. Right now I'm driving 40+ min between jobs and that cost has to go somewhere. Grouping stops by area fixes it. Your cleaning will be on ${day}s from now on. Let me know if that's truly a no.`,
  },
  {
    id: 'reliability',
    label: 'Reliability',
    render: (name, day) =>
      `${name} — making an important change. My schedule's gotten too spread out and it's affecting my on-time arrivals. Reorganizing everyone by area so I can show up when I say I will. Your cleaning is going to be on ${day}s going forward. Let me know if there's a genuine conflict.`,
  },
  {
    id: 'transparent',
    label: 'Transparent',
    render: (name, day) =>
      `Hi ${name}, being straight with you: I've grown my client base and my old schedule isn't working anymore — too much drive time, too many late arrivals. Rebuilding my week so clients in the same area get done the same day. Your cleaning will be on ${day}s going forward. This matters for me to keep the business running well. Let me know if ${day} is a real problem.`,
  },
]

const TEMPLATE_STORAGE_KEY = 'pip-transition-template'

function renderTemplate(templateId: string, firstName: string, dayFull: string): string {
  const tpl = MESSAGE_TEMPLATES.find(t => t.id === templateId) ?? MESSAGE_TEMPLATES[0]
  return tpl.render(firstName, dayFull)
}

// ── Plan ↔ TransitionState adapters ──────────────────────────────────────────

/**
 * Convert a SchedulePlan + original move list into the TransitionState shape
 * the view already understands. `initialMoves` provides suggestedMessage,
 * reason, etc. that the plan doesn't store. `clients` is the authoritative
 * roster — used to resolve real names even when `initialMoves` is empty (e.g.
 * the resume path after a page reload) or when a client was renamed after the
 * plan was created.
 */
function planToTransitionState(
  plan: SchedulePlan,
  initialMoves: TransitionMove[],
  config: { maxJobsPerDay: number; workingDays: boolean[] },
  clients: Client[],
): TransitionState {
  const byId = new Map(initialMoves.map(m => [m.clientId, m]))
  const clientsById = new Map(clients.map(c => [c.id, c]))
  const deriveStatus = (pc: PlanClient, baseStatus?: OptimizationStatus): OptimizationStatus => {
    if (pc.status === 'confirmed') return 'confirmed'
    if (pc.status === 'cant-move') return 'cant-move'
    if (pc.status === 'waiting') return 'waiting'
    // pending → fall back to baseStatus from initialMoves, or 'to-ask'
    if (baseStatus && baseStatus !== 'confirmed' && baseStatus !== 'cant-move' && baseStatus !== 'waiting') {
      return baseStatus
    }
    return 'to-ask'
  }
  const deriveLocked = (pc: PlanClient): boolean =>
    pc.locked ?? pc.status === 'confirmed'

  const moves: TransitionMove[] = plan.clients.map(pc => {
    // Resolve the real name: store roster → initialMoves → raw id (last resort).
    const resolvedName =
      clientsById.get(pc.clientId)?.name ??
      byId.get(pc.clientId)?.clientName ??
      pc.clientId

    const base = byId.get(pc.clientId)
    if (!base) {
      // Fallback for clients that aren't in initialMoves (e.g. page reload).
      // Construct a minimal move — message/reason fields are non-critical.
      return {
        clientId: pc.clientId,
        clientName: resolvedName,
        currentDay: pc.plannedDay,
        suggestedDay: pc.plannedDay,
        originalDay: pc.originalPlannedDay,
        savingsMinutes: 0,
        reason: '',
        suggestedMessage: '',
        status: deriveStatus(pc),
        locked: deriveLocked(pc),
        iteration: 0,
        swapPartnerClientId: pc.swapPartnerClientId,
        preSwapSnapshot: null,
        frequency: 'weekly',
        currentRotation: pc.plannedRotation,
        targetRotation: pc.plannedRotation,
      }
    }
    return {
      ...base,
      clientName: resolvedName,
      suggestedDay: pc.plannedDay,
      targetRotation: pc.plannedRotation,
      status: deriveStatus(pc, base.status),
      locked: deriveLocked(pc),
      swapPartnerClientId: pc.swapPartnerClientId,
    }
  })
  return {
    moves,
    lockedClientIds: plan.clients.filter(c => deriveLocked(c)).map(c => c.clientId),
    iteration: 0,
    status: 'active',
    startedAt: plan.createdAt,
    config,
  }
}

/**
 * Write the current TransitionState back into the plan, preserving
 * `originalPlannedDay` from the previous plan state.
 */
function transitionStateToPlan(ts: TransitionState, prev: SchedulePlan): SchedulePlan {
  const planById = new Map(prev.clients.map(c => [c.clientId, c]))
  const nextClients: PlanClient[] = ts.moves.map(m => {
    const existing = planById.get(m.clientId)
    const status: PlanClient['status'] =
      m.status === 'confirmed' ? 'confirmed'
      : m.status === 'cant-move' ? 'cant-move'
      : m.status === 'waiting' ? 'waiting'
      : 'pending'
    return {
      clientId: m.clientId,
      plannedDay: m.suggestedDay,
      originalPlannedDay: existing?.originalPlannedDay ?? m.suggestedDay,
      plannedRotation: m.targetRotation,
      status,
      locked: m.locked,
      swapPartnerClientId: m.swapPartnerClientId ?? null,
    }
  })
  return { ...prev, clients: nextClients }
}

interface TransitionViewProps {
  clients: Client[]
  clientDayMap: Map<string, number>
  initialMoves: TransitionMove[]
  /** @deprecated unused — Task 10 will remove. Kept so Schedule.tsx compiles. */
  applyId?: string | null                                           // unused — removed in Task 10
  config: { maxJobsPerDay: number; workingDays: boolean[] }
  homeAddress: { lat: number; lng: number }
  onClose: () => void
  /** @deprecated unused — Task 10 will remove. Kept so Schedule.tsx compiles. */
  onClear?: () => void                                              // unused — removed in Task 10
  /** @deprecated unused — plan-state mutation is the only write now. */
  onApplyMove?: (clientId: string, newDay: number) => void         // unused — removed in Task 10
  /** @deprecated legacy re-optimize path — no longer used in cutover flow */
  onReoptimize?: (currentMoves: TransitionMove[]) => Promise<TransitionMove[]>
  /** @deprecated unused — plan-state mutation is the only write now. */
  onUnconfirm?: (clientId: string) => void                         // unused — removed in Task 10
  /** When true, renders a Finished checkmark instead of the Finish CTA and
   *  hides the sidebar footer. Wired by ScheduleChange to unlock the header
   *  Apply-to-Schedule button. */
  finished?: boolean
  /** Fired when the user confirms the Finish modal. */
  onFinish?: () => void
  /** Fired when the user taps "Place Manually" inside the swap picker. The
   *  parent (ScheduleChange) flips the rotation grid into placement mode. */
  onRequestManualPlacement?: (clientId: string) => void
}

function formatTime(min: number): string {
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`
  return `${min}m`
}

export default function TransitionView({
  clients,
  clientDayMap: _clientDayMap,
  initialMoves,
  applyId: _applyId,           // unused — removed in Task 10
  config,
  homeAddress: _homeAddress,
  onClose,
  onClear: _onClear,           // unused — removed in Task 10
  onApplyMove: _onApplyMove,   // unused — removed in Task 10
  onReoptimize,
  onUnconfirm: _onUnconfirm,   // unused — removed in Task 10
  finished = false,
  onFinish,
  onRequestManualPlacement,
}: TransitionViewProps) {
  const store = useStore()

  // ── Read state from SchedulePlan ──────────────────────────────────────────
  // If the plan disappears (discarded or committed), close the panel.
  const plan = store.schedulePlan
  const planRef = useRef(plan)
  planRef.current = plan

  // If plan is null on mount, close immediately. Use a ref-based check so
  // the effect runs once after mount without needing plan in the dep array.
  useEffect(() => {
    if (!planRef.current) onClose()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Derive state from plan on every render. The plan is the single source of
  // truth — no local TransitionState in useState.
  const state: TransitionState = plan
    ? planToTransitionState(plan, initialMoves, config, store.clients)
    : {
        moves: [],
        lockedClientIds: [],
        iteration: 0,
        status: 'active',
        startedAt: new Date().toISOString(),
        config,
      }

  /**
   * Replaces the old `setState`. Calls updateSchedulePlan so every mutation
   * goes through the store and is persisted to localStorage automatically.
   */
  const setState = (updater: (prev: TransitionState) => TransitionState) => {
    const next = updater(state)
    store.updateSchedulePlan(p => transitionStateToPlan(next, p))
  }

  // Re-optimize path is kept as a prop for callers, but the cutover flow no
  // longer triggers it — swap picker handles rejections directly.
  void onReoptimize

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(TEMPLATE_STORAGE_KEY)
      if (saved && MESSAGE_TEMPLATES.some(t => t.id === saved)) return saved
    } catch { /* ignore */ }
    return MESSAGE_TEMPLATES[0].id
  })
  useEffect(() => {
    try { localStorage.setItem(TEMPLATE_STORAGE_KEY, templateId) } catch { /* ignore */ }
  }, [templateId])
  // moveId whose "Can't Move" row is currently showing swap candidates
  const [swapOpenFor, setSwapOpenFor] = useState<string | null>(null)

  // ── Commit a symmetric swap ──
  // Laura rejected Friday → trades with Joe (proposed Thursday).
  //   Laura: Fri → Thursday (to-ask, unlocked)
  //   Joe:   Thu → Friday   (to-ask, unlocked)
  // Both cards return to Pending; the cleaner must separately confirm each
  // with its client. If Joe was already Confirmed (locked), his plan status
  // is cleared so he's back in pending cleanly (no live-schedule write).
  const handleSwapCommit = (rejected: TransitionMove, partner: SwapCandidate) => {
    const partnerMove = state.moves.find(m => m.clientId === partner.clientId)
    if (!partnerMove) return

    setState(prev => {
      const nextIter = prev.iteration + 1
      return {
        ...prev,
        iteration: nextIter,
        moves: prev.moves.map(m => {
          // Rejected client takes partner's slot
          if (m.clientId === rejected.clientId) {
            return {
              ...m,
              suggestedDay: partner.currentDay,
              targetRotation: partnerMove.targetRotation,
              status: 'to-ask' as OptimizationStatus,
              locked: false,
              swapPartnerClientId: partner.clientId,
              preSwapSnapshot: {
                suggestedDay: m.suggestedDay,
                targetRotation: m.targetRotation,
                reason: m.reason,
                suggestedMessage: m.suggestedMessage,
              },
              iteration: nextIter,
              reason: `Swap with ${partnerMove.clientName} — takes ${DAYS_FULL[partner.currentDay]} slot`,
              suggestedMessage: `Hey ${m.clientName.split(' ')[0]}, confirming ${DAYS_FULL[partner.currentDay]}s going forward instead of ${DAYS_FULL[rejected.suggestedDay]}s — does that still work?`,
            }
          }
          // Partner takes rejected's slot
          if (m.clientId === partner.clientId) {
            return {
              ...m,
              suggestedDay: rejected.suggestedDay,
              targetRotation: rejected.targetRotation,
              status: 'to-ask' as OptimizationStatus,
              locked: false,
              swapPartnerClientId: rejected.clientId,
              preSwapSnapshot: {
                suggestedDay: m.suggestedDay,
                targetRotation: m.targetRotation,
                reason: m.reason,
                suggestedMessage: m.suggestedMessage,
              },
              iteration: nextIter,
              reason: `Swap with ${rejected.clientName} — takes ${DAYS_FULL[rejected.suggestedDay]} slot`,
              suggestedMessage: `Hey ${m.clientName.split(' ')[0]}, would ${DAYS_FULL[rejected.suggestedDay]}s work for you going forward instead of ${DAYS_FULL[partner.currentDay]}s? Trying to tighten up my route.`,
            }
          }
          return m
        }),
        lockedClientIds: prev.lockedClientIds.filter(
          id => id !== rejected.clientId && id !== partner.clientId,
        ),
      }
    })
    setSwapOpenFor(null)
    setExpandedId(null)
  }

  // User closed the swap picker without acting. No locking — every client
  // must be explicitly placed (swap, manual, or revert→confirm) before the
  // rollout can finish. Just hides the picker; status stays cant-move.
  const dismissSwap = (_clientId: string) => {
    setSwapOpenFor(null)
  }

  // Undo a Can't Move tap — flips status back to to-ask and closes the swap
  // picker. No locking. Use case: user tapped Can't Move by mistake, or
  // changed their mind after seeing the swap candidates.
  const undoCantMove = (clientId: string) => {
    setState(prev => ({
      ...prev,
      moves: prev.moves.map(m =>
        m.clientId === clientId
          ? { ...m, status: 'to-ask' as OptimizationStatus, locked: false }
          : m,
      ),
      lockedClientIds: prev.lockedClientIds.filter(id => id !== clientId),
    }))
    setSwapOpenFor(null)
  }

  // Revert any Resolved card back to To Ask — unlocks the card so it flows
  // back into Pending. Grid visibility is driven by `locked`, so unlocking
  // automatically unplaces them from the rotation grid.
  const revertMove = (clientId: string) => {
    setState(prev => ({
      ...prev,
      moves: prev.moves.map(m =>
        m.clientId === clientId
          ? { ...m, status: 'to-ask' as OptimizationStatus, locked: false }
          : m,
      ),
      lockedClientIds: prev.lockedClientIds.filter(id => id !== clientId),
    }))
  }

  // Undo a swap — restores BOTH sides of a swap pair to their pre-swap day
  // and rotation, flips both to to-ask, clears swap tags.
  const undoSwap = (clientId: string) => {
    const move = state.moves.find(m => m.clientId === clientId)
    if (!move || !move.swapPartnerClientId) return
    const partner = state.moves.find(m => m.clientId === move.swapPartnerClientId)
    if (!partner) return

    setState(prev => ({
      ...prev,
      moves: prev.moves.map(m => {
        if (m.clientId !== move.clientId && m.clientId !== partner.clientId) return m
        const snap = m.preSwapSnapshot
        return {
          ...m,
          ...(snap ? {
            suggestedDay: snap.suggestedDay,
            targetRotation: snap.targetRotation,
            reason: snap.reason,
            suggestedMessage: snap.suggestedMessage,
          } : {}),
          status: 'to-ask' as OptimizationStatus,
          locked: false,
          swapPartnerClientId: null,
          preSwapSnapshot: null,
        }
      }),
      lockedClientIds: prev.lockedClientIds.filter(
        id => id !== move.clientId && id !== partner.clientId,
      ),
    }))
  }

  // ── Master Confirm-all: 2-step armed state ───────────────────────────────
  const [confirmEverythingArmed, setConfirmEverythingArmed] = useState(false)
  const confirmEverythingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (confirmEverythingTimerRef.current) clearTimeout(confirmEverythingTimerRef.current)
    }
  }, [])

  // ── Bulk-confirm undo snapshot ────────────────────────────────────────────
  // Snapshot of clientId → status captured just before the last bulk-confirm.
  const [bulkUndoSnapshot, setBulkUndoSnapshot] = useState<Record<string, 'pending' | 'confirmed'> | null>(null)

  const [loading] = useState(false)
  const [showFinishConfirm, setShowFinishConfirm] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  // Completion detection: all moves locked AND re-optimize not in flight.
  // Completion is never auto-applied — user must click "Finish transition".
  const allResolved = state.moves.length > 0 && state.moves.every(m => m.locked) && !loading

  // Swap candidates come from the PROPOSED schedule (the Transition moves
  // themselves), not the live calendar.
  const localFindSwapCandidates = (rejected: TransitionMove): SwapCandidate[] => {
    const proposedDayMap = new Map<string, number>()
    const proposedRotMap = new Map<string, number>()
    const freqMap = new Map<string, Client['frequency']>()
    const iwMap = new Map<string, number>()
    for (const m of state.moves) {
      if (m.suggestedDay < 0) continue
      proposedDayMap.set(m.clientId, m.suggestedDay)
      proposedRotMap.set(m.clientId, m.targetRotation)
      freqMap.set(m.clientId, m.frequency)
    }
    // Anyone already committed as a swap partner is off-limits.
    const usedPartnerIds = new Set(
      state.moves
        .filter(m => m.swapPartnerClientId != null)
        .map(m => m.clientId),
    )
    const candidates = computeSwapCandidates({
      openingDay: rejected.suggestedDay,
      openingRotation: rejected.targetRotation,
      rejectedClientId: rejected.clientId,
      rejectedFrequency: rejected.frequency,
      rejectedIntervalWeeks: undefined,
      allClients: clients,
      currentDayMap: proposedDayMap,
      currentRotationMap: proposedRotMap,
      clientFrequencies: freqMap,
      clientIntervalWeeks: iwMap,
      config,
    })
    return candidates.filter(c => !usedPartnerIds.has(c.clientId))
  }

  // Lookup for swap-picker rendering (candidate rows need client names).
  const clientsById = useMemo(() => {
    const m = new Map<string, Client>()
    for (const c of clients) m.set(c.id, c)
    return m
  }, [clients])

  // Lookup from the moves list — used to flag "re-ask needed" for swap
  // candidates whose move is currently locked + confirmed.
  const movesByClientId = useMemo(() => {
    const m = new Map<string, TransitionMove>()
    for (const mv of state.moves) m.set(mv.clientId, mv)
    return m
  }, [state.moves])

  // Stats
  const confirmedSavings = useMemo(
    () => state.moves.filter(m => m.status === 'confirmed').reduce((s, m) => s + m.savingsMinutes, 0),
    [state.moves],
  )
  const totalPotential = useMemo(
    () => state.moves.reduce((s, m) => s + m.savingsMinutes, 0),
    [state.moves],
  )
  const allCount = state.moves.length
  const resolvedCount = state.moves.filter(m => m.locked).length

  // Carryover = same day AND same rotation — no client conversation needed.
  const isCarryover = (m: TransitionMove) =>
    m.currentDay === m.suggestedDay && m.currentRotation === m.targetRotation && m.currentDay >= 0
  const pendingAll = state.moves.filter(m => !m.locked && m.status !== 'skipped')
  const pendingMoves = pendingAll.filter(m => !isCarryover(m))
  const pendingCarryovers = pendingAll.filter(isCarryover)
  const skippedMoves = state.moves.filter(m => m.status === 'skipped' && !m.locked)
  const resolvedMoves = state.moves.filter(m => m.locked)

  const isStale = useMemo(() => {
    const currentIds = new Set(clients.map(c => c.id))
    return state.moves.some(m => !currentIds.has(m.clientId))
  }, [clients, state.moves])

  const rosterDrift = useMemo(() => {
    if (!plan) return { added: [] as string[], removed: [] as string[] }
    const current = new Set(store.clients.map(c => c.id))
    const snapshot = new Set(plan.rosterSnapshot)
    const added = [...current].filter(id => !snapshot.has(id))
    const removed = [...snapshot].filter(id => !current.has(id))
    return { added, removed }
  }, [plan, store.clients])

  const updateMoveStatus = async (clientId: string, status: OptimizationStatus) => {
    const move = state.moves.find(m => m.clientId === clientId)
    if (!move) return

    if (status === 'confirmed') {
      // Plan-state mutation only — no live-schedule write.
      // Clear bulk undo snapshot on any manual confirmation.
      setBulkUndoSnapshot(null)
      setState(prev => ({
        ...prev,
        moves: prev.moves.map(m =>
          m.clientId === clientId ? { ...m, status: 'confirmed' as OptimizationStatus, locked: true } : m,
        ),
        lockedClientIds: [...prev.lockedClientIds.filter(id => id !== clientId), clientId],
      }))
    } else if (status === 'cant-move') {
      // Client said no — flip status only. Cant-Move is just an entry point
      // to the swap picker; the user resolves placement via swap, undo, or
      // manual. No placement change here (client was already unplaced from
      // to-ask state).
      setState(prev => ({
        ...prev,
        moves: prev.moves.map(m =>
          m.clientId === clientId ? { ...m, status: 'cant-move' as OptimizationStatus } : m,
        ),
      }))
      setExpandedId(clientId)
      setSwapOpenFor(clientId)
    } else {
      // to-ask or waiting: just update status, no locking
      setState(prev => ({
        ...prev,
        moves: prev.moves.map(m =>
          m.clientId === clientId ? { ...m, status } : m,
        ),
      }))
    }
  }

  // Master bulk-confirm: every unresolved client (pending + carryover).
  // Used when the user just wants to accept the whole Builder output
  // without going through per-client conversations.
  const armConfirmEverything = () => {
    setConfirmEverythingArmed(true)
    if (confirmEverythingTimerRef.current) clearTimeout(confirmEverythingTimerRef.current)
    confirmEverythingTimerRef.current = setTimeout(() => {
      setConfirmEverythingArmed(false)
      confirmEverythingTimerRef.current = null
    }, 3000)
  }
  const confirmEverything = () => {
    const allPendingIds = new Set(pendingAll.map(m => m.clientId))
    if (allPendingIds.size === 0) return
    const snapshot: Record<string, 'pending' | 'confirmed'> = {}
    if (plan) {
      for (const pc of plan.clients) {
        snapshot[pc.clientId] = pc.status === 'confirmed' ? 'confirmed' : 'pending'
      }
    }
    setBulkUndoSnapshot(snapshot)
    setConfirmEverythingArmed(false)
    if (confirmEverythingTimerRef.current) {
      clearTimeout(confirmEverythingTimerRef.current)
      confirmEverythingTimerRef.current = null
    }
    setState(prev => ({
      ...prev,
      moves: prev.moves.map(m =>
        allPendingIds.has(m.clientId)
          ? { ...m, status: 'confirmed' as OptimizationStatus, locked: true }
          : m,
      ),
      lockedClientIds: [
        ...prev.lockedClientIds.filter(id => !allPendingIds.has(id)),
        ...allPendingIds,
      ],
    }))
  }

  // Undo the most recent bulk-confirm: restore statuses from snapshot.
  const undoBulkConfirm = () => {
    if (!bulkUndoSnapshot) return
    const snap = bulkUndoSnapshot
    setBulkUndoSnapshot(null)
    setState(prev => ({
      ...prev,
      moves: prev.moves.map(m => {
        const prevStatus = snap[m.clientId]
        if (prevStatus === undefined) return m
        const wasConfirmed = prevStatus === 'confirmed'
        return {
          ...m,
          status: (wasConfirmed ? 'confirmed' : 'to-ask') as OptimizationStatus,
          locked: wasConfirmed,
        }
      }),
      lockedClientIds: prev.lockedClientIds.filter(id => snap[id] === 'confirmed'),
    }))
  }

  const renderMessageForMove = (move: TransitionMove): string => {
    const firstName = move.clientName.split(' ')[0]
    return renderTemplate(templateId, firstName, DAYS_FULL[move.suggestedDay])
  }

  const copyMessage = (move: TransitionMove) => {
    void navigator.clipboard.writeText(renderMessageForMove(move))
    setCopiedId(move.clientId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  // "Done" after completion and explicit "Start fresh" both wipe the sidebar:
  // discard the plan and close.
  const handleClearAndClose = () => {
    store.discardSchedulePlan()
    onClose()
  }

  // Reset: revert every confirmation in the plan back to "To Ask" — keeps the
  // plan alive, just clears progress. Does NOT touch the live schedule.
  const handleReset = () => {
    setState(prev => ({
      ...prev,
      moves: prev.moves.map(m => ({
        ...m,
        status: 'to-ask' as OptimizationStatus,
        locked: false,
      })),
      lockedClientIds: [],
    }))
    setBulkUndoSnapshot(null)
  }

  // Group moves by target day — mirrors the Perfect Schedule grid layout
  const renderMovesByDay = (moves: TransitionMove[]) => {
    const byDay = new Map<number, TransitionMove[]>()
    for (const move of moves) {
      const day = move.suggestedDay
      const group = byDay.get(day) || []
      group.push(move)
      byDay.set(day, group)
    }

    const sortedDays = [...byDay.keys()].sort((a, b) => a - b)

    return sortedDays.map(day => (
      <div key={day} className="mb-2">
        <div className="flex items-center gap-1.5 mb-1 px-0.5">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DAY_COLORS[day] }} />
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: DAY_COLORS[day] }}>
            {DAYS_FULL[day]}
          </span>
          <span className="text-[9px] text-gray-400">({byDay.get(day)!.length})</span>
        </div>
        <div className="space-y-1">
          {byDay.get(day)!.map(move => (
            <TransitionMoveCard
              key={move.clientId}
              move={move}
              renderedMessage={renderMessageForMove(move)}
              isExpanded={expandedId === move.clientId}
              copiedId={copiedId}
              onToggle={() => setExpandedId(expandedId === move.clientId ? null : move.clientId)}
              onStatusChange={status => void updateMoveStatus(move.clientId, status)}
              onCopy={() => copyMessage(move)}
              swapOpen={swapOpenFor === move.clientId}
              swapCandidates={swapOpenFor === move.clientId ? localFindSwapCandidates(move) : []}
              clientsById={clientsById}
              movesById={movesByClientId}
              onSwap={partner => handleSwapCommit(move, partner)}
              onCloseSwap={() => dismissSwap(move.clientId)}
              onShowSwap={() => setSwapOpenFor(move.clientId)}
              onRevert={() => revertMove(move.clientId)}
              onUndoSwap={move.swapPartnerClientId ? () => undoSwap(move.clientId) : undefined}
              onUndoCantMove={() => undoCantMove(move.clientId)}
              onPlaceManually={
                onRequestManualPlacement
                  ? () => {
                      setSwapOpenFor(null)
                      onRequestManualPlacement(move.clientId)
                    }
                  : undefined
              }
            />
          ))}
        </div>
      </div>
    ))
  }

  // Early return if no plan (closed already via useEffect on mount; this
  // guards subsequent renders if plan is discarded while open).
  if (!plan) return null

  // Completed state
  if (state.status === 'completed') {
    return (
      <div className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0">
        <div className="p-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Schedule change</h2>
          <button onClick={handleClearAndClose} className="text-[10px] text-gray-400 hover:text-gray-600 font-medium">Done</button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-2">
              <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-[11px] font-medium text-gray-600">Schedule change complete</p>
            <p className="text-[10px] text-gray-400 mt-0.5">
              {state.moves.filter(m => m.status === 'confirmed').length} moves confirmed
            </p>
            {confirmedSavings > 0 && (
              <p className="text-xs font-bold text-green-600 mt-1">{formatTime(confirmedSavings)}/wk saved</p>
            )}
          </div>
          <button
            onClick={handleClearAndClose}
            className="mt-4 px-3 py-1.5 text-[10px] font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
          >
            Done
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
          <div className="flex items-center gap-1">
            <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Schedule change</h2>
            {state.iteration > 0 && (
              <span className="text-[8px] font-medium px-1 py-px rounded-full bg-blue-100 text-blue-600">
                Pass {state.iteration + 1}
              </span>
            )}
          </div>
          {loading && (
            <div className="w-3 h-3 border-2 border-gray-200 border-t-green-500 rounded-full animate-spin" />
          )}
        </div>

        {/* Stats bar */}
        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <div className="flex-1 bg-green-50 rounded px-2 py-1">
              <p className="text-[8px] text-green-600 font-medium uppercase">Saved</p>
              <p className="text-xs font-bold text-green-700">
                {formatTime(confirmedSavings)}<span className="text-[8px] font-normal text-green-500">/wk</span>
              </p>
            </div>
            <div className="flex-1 bg-gray-100 rounded px-2 py-1">
              <p className="text-[8px] text-gray-500 font-medium uppercase">Potential</p>
              <p className="text-xs font-bold text-gray-800">
                {formatTime(totalPotential)}<span className="text-[8px] font-normal text-gray-400">/wk</span>
              </p>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <p className="text-[9px] text-gray-400">{resolvedCount}/{allCount} resolved</p>
              {pendingAll.length > 0 && (
                <button
                  onClick={confirmEverythingArmed ? confirmEverything : armConfirmEverything}
                  className={`text-[9px] font-semibold rounded px-1.5 py-0.5 transition-colors ${
                    confirmEverythingArmed
                      ? 'bg-amber-500 text-white hover:bg-amber-600'
                      : 'text-green-600 hover:text-green-700'
                  }`}
                  title={confirmEverythingArmed ? 'Click again to confirm everyone' : `Confirm every remaining client (${pendingAll.length})`}
                >
                  {confirmEverythingArmed ? 'Tap again to confirm all' : `Confirm all ${pendingAll.length}`}
                </button>
              )}
            </div>
            <div className="h-1 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-green-500 transition-all"
                style={{ width: `${allCount > 0 ? (resolvedCount / allCount) * 100 : 0}%` }}
              />
            </div>
          </div>
        </div>

        <p className="mt-2 text-[9px] text-gray-500 text-center">Confirm clients as they agree — each moves to their new day</p>

        {/* Message tone picker — applies to every card's Copy action */}
        <div className="mt-2">
          <p className="text-[8px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Message tone</p>
          <div className="flex flex-wrap gap-1">
            {MESSAGE_TEMPLATES.map(t => (
              <button
                key={t.id}
                onClick={() => setTemplateId(t.id)}
                className={`px-1.5 py-0.5 text-[9px] font-medium rounded transition-all ${
                  templateId === t.id
                    ? 'bg-gray-900 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Finish CTA — once pressed + confirmed, collapses into a Finished
            badge so the Apply button (rendered by ScheduleChange header)
            takes over. */}
        {allResolved && !finished && (
          <button
            onClick={() => setShowFinishConfirm(true)}
            className="mt-2 w-full px-2 py-1.5 text-[10px] font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors"
          >
            Finish
          </button>
        )}
        {finished && (
          <div className="mt-2 w-full px-2 py-1.5 flex items-center justify-center gap-1.5 text-[10px] font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            Finished
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {/* Roster drift banner — non-blocking amber warning */}
        {(rosterDrift.added.length > 0 || rosterDrift.removed.length > 0) && (
          <div className="mx-3 mb-2 p-2 bg-amber-50 border border-amber-200 rounded-md text-[11px] text-amber-800">
            Your client list changed since this plan was created.
            {rosterDrift.added.length > 0 && <div>Added: {rosterDrift.added.length} client(s)</div>}
            {rosterDrift.removed.length > 0 && <div>Removed: {rosterDrift.removed.length} client(s)</div>}
            <div className="mt-1 text-amber-700">Regenerate the plan to include them, or continue with the current list.</div>
          </div>
        )}

        {/* Stale schedule-change banner */}
        {isStale && (
          <div className="mx-2 mt-2 p-2 bg-red-50 rounded-lg border border-red-200">
            <p className="text-[10px] text-red-700 font-medium">Client list changed</p>
            <p className="text-[9px] text-red-600 mt-0.5">Some clients in this plan were added or removed.</p>
            <button
              onClick={() => setShowResetConfirm(true)}
              className="mt-1.5 w-full px-2 py-1 text-[9px] font-medium text-red-700 bg-red-100 rounded hover:bg-red-200"
            >
              Reset
            </button>
          </div>
        )}

        {/* To Resolve section */}
        {pendingMoves.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1 px-0.5">
              <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider">
                To Resolve ({pendingMoves.length})
              </p>
            </div>
            <div className="space-y-1.5">
              {renderMovesByDay(pendingMoves)}
            </div>
          </div>
        )}

        {/* Carryover section — clients whose day/rotation didn't change.
            No outreach needed; one bulk-confirm re-anchors all at once.
            Requires 2-step tap to prevent accidental bulk-confirm. */}
        {pendingCarryovers.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1 px-0.5 mt-2">
              <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider">
                Carryover ({pendingCarryovers.length})
              </p>
              {bulkUndoSnapshot && (
                <button
                  onClick={undoBulkConfirm}
                  className="text-[9px] font-medium text-gray-400 hover:text-gray-600"
                  title="Undo last bulk confirm"
                >
                  Undo
                </button>
              )}
            </div>
            <div className="space-y-1.5">
              {renderMovesByDay(pendingCarryovers)}
            </div>
          </div>
        )}

        {/* Skipped section — come back to these */}
        {skippedMoves.length > 0 && (
          <div>
            <p className="text-[9px] font-semibold text-indigo-400 uppercase tracking-wider mb-1 px-0.5 mt-2">
              Skipped — come back ({skippedMoves.length})
            </p>
            <div className="space-y-1.5">
              {renderMovesByDay(skippedMoves)}
            </div>
          </div>
        )}

        {/* Resolved section */}
        {resolvedMoves.length > 0 && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1 px-0.5 mt-2">
              Resolved ({resolvedMoves.length})
            </p>
            <div className="space-y-1.5">
              {renderMovesByDay(resolvedMoves)}
            </div>
          </div>
        )}

        {/* Empty state */}
        {state.moves.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="text-center">
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-2">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <p className="text-[11px] font-medium text-gray-600">No moves to make</p>
              <p className="text-[10px] text-gray-400 mt-0.5">Schedule looks optimal</p>
            </div>
          </div>
        )}
      </div>

      {/* Sidebar footer — Reset only. Apply lives in the ScheduleChange header. */}
      {state.moves.length > 0 && (
        <div className="px-2.5 py-2 border-t border-gray-200 bg-white">
          <button
            onClick={() => setShowResetConfirm(true)}
            title="Clear all confirmations and start the rollout over. Your applied schedule stays put."
            className="w-full px-2 py-1 text-[10px] font-medium text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
          >
            Reset schedule change
          </button>
        </div>
      )}

      {/* Finish confirm modal */}
      {showFinishConfirm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">
              {allResolved ? 'Finish schedule change?' : 'Close for now?'}
            </h2>
            <p className="text-sm text-gray-600 mb-5">
              {allResolved
                ? `${state.moves.length} confirmed. Marking this complete closes the panel and clears the confirmation list — you won't be able to reopen this rollout.`
                : `You still have ${pendingMoves.length} client${pendingMoves.length === 1 ? '' : 's'} to resolve. Your progress is saved — you can reopen this anytime from the Schedule page.`}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowFinishConfirm(false)}
                className="flex-1 px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowFinishConfirm(false)
                  if (allResolved) {
                    onFinish?.()
                  } else {
                    onClose()
                  }
                }}
                className={`flex-1 px-4 py-2 text-sm font-medium text-white rounded-lg ${
                  allResolved ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-900 hover:bg-gray-800'
                }`}
              >
                {allResolved ? 'Finish' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Reset confirm modal — discards the plan entirely. */}
      {showResetConfirm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">
              Reset schedule change?
            </h2>
            <p className="text-sm text-gray-600 mb-5">
              This unplaces every client and reverts them all back to <span className="font-semibold">To Ask</span>. The plan stays open so you can confirm them again.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="flex-1 px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowResetConfirm(false)
                  handleReset()
                }}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Transition Move Card ── */
function TransitionMoveCard({
  move,
  renderedMessage,
  isExpanded,
  copiedId,
  onToggle,
  onStatusChange,
  onCopy,
  noBorder,
  swapOpen,
  swapCandidates,
  clientsById,
  movesById,
  onSwap,
  onCloseSwap: _onCloseSwap,
  onShowSwap,
  onRevert,
  onUndoSwap,
  onUndoCantMove,
  onPlaceManually,
}: {
  move: TransitionMove
  renderedMessage?: string
  isExpanded: boolean
  copiedId: string | null
  onToggle: () => void
  onStatusChange: (status: OptimizationStatus) => void
  onCopy: () => void
  noBorder?: boolean
  swapOpen?: boolean
  swapCandidates?: SwapCandidate[]
  clientsById?: Map<string, Client>
  movesById?: Map<string, TransitionMove>
  onSwap?: (partner: SwapCandidate) => void
  onCloseSwap?: () => void
  onShowSwap?: () => void
  onRevert?: () => void
  onUndoSwap?: () => void
  onUndoCantMove?: () => void
  onPlaceManually?: () => void
}) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const statusCfg = (isDark ? STATUS_CONFIG_DARK : STATUS_CONFIG)[move.status]

  return (
    <div className={`${noBorder ? '' : 'bg-white rounded-lg border border-gray-200'} transition-all ${
      move.status === 'confirmed' ? 'bg-green-50/30' : ''
    }`}>
      {/* Card header row */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer" onClick={onToggle}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <p className="text-[11px] font-semibold text-gray-900 truncate">{move.clientName}</p>
            <span
              className="text-[8px] font-medium px-1 py-px rounded-full shrink-0"
              style={{ color: statusCfg.color, backgroundColor: statusCfg.bg }}
            >
              {statusCfg.label}
            </span>
            {(move.iteration > 0 || move.swapPartnerClientId != null) && (
              <span className="text-[8px] font-medium px-1 py-px rounded-full shrink-0 bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300">
                updated
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: DAY_COLORS[move.currentDay] }} />
            <span className="text-[10px] text-gray-400">
              {DAYS[move.currentDay]}{move.frequency === 'biweekly' ? (move.currentRotation === 0 ? '-A' : '-B') : ''}
            </span>
            <svg className="w-2.5 h-2.5 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: DAY_COLORS[move.suggestedDay] }} />
            <span className="text-[10px] font-medium text-gray-600">
              {DAYS[move.suggestedDay]}{move.frequency === 'biweekly' ? (move.targetRotation === 0 ? '-A' : '-B') : ''}
            </span>
          </div>
        </div>
        <div className="text-right shrink-0">
          {move.savingsMinutes > 0 && (
            <p className="text-[10px] font-bold text-green-600">-{move.savingsMinutes}m</p>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="px-2 pb-2 border-t border-gray-100">
          <p className="text-[10px] text-gray-500 mt-1.5 mb-2 leading-relaxed">{move.reason}</p>

          {/* Suggested message — only shown for unconfirmed clients. Once
              confirmed, the message is no longer needed (already sent). */}
          {move.status !== 'confirmed' && (
            <div className="bg-gray-50 rounded p-1.5 mb-2">
              <div className="flex items-center justify-between mb-0.5">
                <p className="text-[8px] font-semibold text-gray-400 uppercase tracking-wider">Message</p>
                <button onClick={onCopy} className="text-[9px] text-blue-600 hover:text-blue-800 font-medium">
                  {copiedId === move.clientId ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-[10px] text-gray-600 italic leading-relaxed">"{renderedMessage ?? move.suggestedMessage}"</p>
            </div>
          )}

          {/* Swap picker — surfaces top-3 swap candidates for a rejected move.
              Auto-opens when Can't Move is clicked; user can re-open via the
              "Find swap" button on locked cant-move rows. */}
          {swapOpen && move.status === 'cant-move' && (
            <div className="mb-2 p-1.5 rounded-md bg-amber-50 border border-amber-200/80 dark:bg-amber-500/10 dark:border-amber-400/30">
              <p className="text-[9px] font-bold text-amber-800 dark:text-amber-200 mb-1">Trade day with…</p>
              {(!swapCandidates || swapCandidates.length === 0) ? (
                <p className="text-[9px] italic text-amber-700/70 dark:text-amber-200/70">No matching-cadence candidates fit {DAYS_FULL[move.suggestedDay]}.</p>
              ) : (
                <div className="space-y-1">
                  {swapCandidates.map(cand => {
                    const c = clientsById?.get(cand.clientId)
                    if (!c) return null
                    const nearestMin = Math.round(cand.nearestNeighborMin)
                    const isAdjacent = nearestMin < 2 && cand.nearbyCount > 0
                    const partnerMove = movesById?.get(cand.clientId)
                    const reAskNeeded = partnerMove?.locked && partnerMove?.status === 'confirmed'
                    const cadenceLabel = cand.frequency === 'weekly'
                      ? 'Weekly'
                      : cand.frequency === 'biweekly'
                        ? (cand.currentRotation === 0 ? 'Wk 1,3' : 'Wk 2,4')
                        : cand.frequency === 'monthly'
                          ? 'Monthly'
                          : null
                    return (
                      <div key={cand.clientId} className="flex items-center gap-1.5 px-1.5 py-1 bg-white rounded border border-amber-200/60">
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] font-semibold text-gray-800 truncate">{c.name}</p>
                          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: DAY_COLORS[cand.currentDay] }} />
                            <span className="text-[9px] text-gray-500">{DAYS_FULL[cand.currentDay]}</span>
                            {cadenceLabel && (
                              <>
                                <span className="text-[9px] text-gray-400">·</span>
                                <span className="text-[9px] font-medium text-gray-600">{cadenceLabel}</span>
                              </>
                            )}
                            <span className="text-[9px] text-gray-400">·</span>
                            <span className="text-[9px] text-gray-500">{isAdjacent ? 'Next door' : `${nearestMin}min`}</span>
                            {cand.rotationShifts && (
                              <span className="text-[8px] font-semibold text-amber-700 bg-amber-100 px-1 rounded">rot shift</span>
                            )}
                            {reAskNeeded && (
                              <span className="text-[8px] font-semibold text-orange-700 bg-orange-100 px-1 rounded">re-ask needed</span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => onSwap?.(cand)}
                          className="px-1.5 py-0.5 text-[9px] font-semibold text-white bg-amber-600 rounded hover:bg-amber-700"
                        >
                          Trade
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              {/* Footer actions — Undo cancels the Can't Move (back to To Ask),
                  Place Manually opens the rotation grid in placement mode. */}
              <div className="flex items-center justify-end gap-3 mt-1.5 pt-1.5 border-t border-amber-200/60 dark:border-amber-400/20">
                {onUndoCantMove && (
                  <button
                    onClick={onUndoCantMove}
                    className="text-[9px] font-semibold text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 underline"
                  >
                    Cancel
                  </button>
                )}
                {onPlaceManually && (
                  <button
                    onClick={onPlaceManually}
                    className="text-[9px] font-semibold text-purple-700 hover:text-purple-800 dark:text-purple-300 dark:hover:text-purple-200 underline"
                  >
                    Place manually →
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Action buttons — locked moves show static label */}
          {move.locked ? (
            <div className="text-center py-1 space-y-1">
              {move.status === 'confirmed' ? (
                <div className="flex items-center justify-center gap-2">
                  <p className="text-[9px] font-medium text-green-600">Confirmed for new schedule</p>
                  {onRevert && (
                    <button
                      onClick={onRevert}
                      className="text-[9px] font-semibold text-gray-500 hover:text-gray-700 underline"
                    >
                      Revert to To Ask
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <p className="text-[9px] font-medium text-gray-400">Locked — staying on {DAYS_FULL[move.currentDay]}</p>
                  <div className="flex items-center justify-center gap-2">
                    {move.status === 'cant-move' && !swapOpen && onShowSwap && (
                      <button
                        onClick={onShowSwap}
                        className="text-[9px] font-semibold text-amber-700 hover:text-amber-800 underline"
                      >
                        Find swap
                      </button>
                    )}
                    {onRevert && (
                      <button
                        onClick={onRevert}
                        className="text-[9px] font-semibold text-gray-500 hover:text-gray-700 underline"
                      >
                        Revert to To Ask
                      </button>
                    )}
                    {onUndoSwap && move.swapPartnerClientId && (
                      <button
                        onClick={onUndoSwap}
                        className="text-[9px] font-semibold text-amber-700 hover:text-amber-800 underline"
                      >
                        Undo swap
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <div className="flex flex-wrap gap-1">
                {(['to-ask', 'waiting', 'confirmed', 'cant-move'] as const).map(status => {
                  const sc = (isDark ? STATUS_CONFIG_DARK : STATUS_CONFIG)[status]
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
              {/* Undo swap — reverts both cards in a swap pair back to their
                  pre-swap state and statuses. */}
              {onUndoSwap && move.swapPartnerClientId && (
                <button
                  onClick={onUndoSwap}
                  className="text-[9px] font-semibold text-amber-700 hover:text-amber-800 underline"
                >
                  Undo swap
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

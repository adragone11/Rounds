export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6

export type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'one-time' | 'custom'

export type Client = {
  id: string
  name: string
  address: string
  color: string
  frequency: Frequency
  intervalWeeks?: number     // only used when frequency === 'custom' (e.g. 5 = every 5 weeks)
  lat: number | null
  lng: number | null
  startDate: string | null   // recurrence anchor — "YYYY-MM-DD"
  exceptions: string[]       // dates removed from the recurring pattern
  blockedDays: DayOfWeek[]   // days the client cannot be scheduled
  rate: number               // legacy: mobile-owned column, unused on web — price lives on jobs + scheduleMeta
}

/** Manual placement overrides (moved instances, one-time placements) */
export type Placement = {
  clientId: string
  date: string // "YYYY-MM-DD"
}

/** Optimization move suggestion */
export type OptimizationStatus = 'to-ask' | 'waiting' | 'confirmed' | 'cant-move' | 'skipped'

export type ProposedMove = {
  clientId: string
  clientName: string
  currentDay: number       // 0-6 day of week
  suggestedDay: number     // 0-6 day of week
  savingsMinutes: number   // estimated drive time saved per week
  reason: string
  status: OptimizationStatus
  suggestedMessage: string // text to send the client
}

export type OptimizationState = {
  moves: ProposedMove[]
  totalSavingsMinutes: number  // if everyone says yes
  actualSavingsMinutes: number // from confirmed moves so far
  startedAt: string            // ISO date
}

/** A single move in the transition plan */
export type TransitionMove = ProposedMove & {
  locked: boolean           // true once confirmed OR cant-move
  originalDay: number       // client's day when transition started
  iteration: number         // which re-optimization pass generated this move
  swapPartnerClientId: string | null  // if this is part of a swap pair
  /** Snapshot of suggestedDay/targetRotation/reason/message from BEFORE the
   *  swap mutated this card. Used by Undo swap to restore both sides to
   *  pre-swap state. Null when the card isn't part of a swap. */
  preSwapSnapshot?: {
    suggestedDay: number
    targetRotation: 0 | 1
    reason: string
    suggestedMessage: string
  } | null
  frequency: Frequency
  currentRotation: 0 | 1   // current A/B rotation (0=A weeks 0,2  1=B weeks 1,3)
  targetRotation: 0 | 1    // rotation in the perfect schedule
}

/** Tracks the full transition from current → perfect schedule */
export type TransitionState = {
  moves: TransitionMove[]
  lockedClientIds: string[]       // clients whose positions are fixed (confirmed + rejected)
  iteration: number               // increments on each re-optimization
  status: 'active' | 'paused' | 'completed'
  startedAt: string               // ISO date
  config: {                       // snapshot of config used to generate
    maxJobsPerDay: number
    workingDays: boolean[]
  }
}

/** A single client entry in a 4-week grid cell */
export type GridCell = {
  clientId: string
  clientName: string
  routeOrder: number
  recurrence: Frequency
  rotation: 0 | 1  // 0 = A (weeks 0,2), 1 = B (weeks 1,3)
}

/** A sandboxed draft schedule produced by Schedule Builder. Lives in
 *  localStorage and does NOT mutate the live schedule until committed. */
export type SchedulePlan = {
  id: string
  createdAt: string
  status: 'active' | 'committed' | 'discarded'
  builderAssignments: Array<[string, number]>    // clientId → dayOfWeek (-1 = benched, excluded)
  builderRotations: Array<[string, number]>      // clientId → rotation (0=A, 1=B)
  builderRecurrence: Array<[string, Frequency]>  // clientId → frequency
  builderIntervalWeeks: Array<[string, number]>  // clientId → intervalWeeks
  rosterSnapshot: string[]
  clients: PlanClient[]
}

export type PlanClient = {
  clientId: string
  plannedDay: number
  originalPlannedDay: number  // Builder's original assignment (immutable — do not mutate after plan creation)
  plannedRotation: 0 | 1
  status: 'pending' | 'confirmed' | 'cant-move' | 'waiting' | 'to-ask'
  /** Explicit lock flag — confirmed implies locked; cant-move may be locked after dismissSwap. */
  locked?: boolean
  swapPartnerClientId: string | null
}

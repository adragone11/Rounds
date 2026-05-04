/**
 * AI Optimization Layer — Contracts
 *
 * The load-bearing types between the deterministic engine, the LLM
 * post-processor, and the trace UI.
 *
 * Architecture invariants (DO NOT VIOLATE):
 *
 *   1. The LLM never produces a schedule. It picks from a pre-validated
 *      menu of LegalMoves. Anything outside the menu is ignored.
 *   2. LegalMoves are validated across the FULL projected horizon (every
 *      week from 0 to horizonWeeks). Recurrence integrity is enforced
 *      here, not by the LLM.
 *   3. Every LLM call writes a full OptimizationIteration. The trace is
 *      a product feature, not a debug afterthought.
 *
 * verbatimModuleSyntax is on — use `export type` and `import type` only.
 */

import type { DayOfWeek, Frequency } from '../../types'

// ────────────────────────────────────────────────────────────────────────
// Diagnostic Report — engine emits AFTER generating a schedule.
// Pre-computed geometry the LLM cannot reason about on its own.
// ────────────────────────────────────────────────────────────────────────

/**
 * One geographic cluster (a single (day, rotation) bucket on the schedule).
 * Biweekly clients split into rotation 0 and rotation 1, so a single calendar
 * day can produce up to two ClusterDiagnostic entries (Mon-A and Mon-B).
 * Weekly/monthly clients use rotation = 'all' to indicate "every week".
 */
export type ClusterDiagnostic = {
  day: DayOfWeek
  rotation: 0 | 1 | 'all'
  centroidLat: number
  centroidLng: number
  /** Average pairwise drive minutes within the cluster — lower = tighter. */
  tightnessMinutes: number
  /** TSP-ordered total drive time from home through all stops in this cluster. */
  driveMinutes: number
  jobCount: number
  clientIds: string[]
}

/**
 * A single client flagged by the engine as poorly placed within its current
 * day. Outliers drive the LLM's attention — the menu of legal moves is
 * generated to address these specifically.
 */
export type OutlierJob = {
  clientId: string
  clientName: string
  currentDay: DayOfWeek
  currentRotation: 0 | 1
  /** Drive minutes from this client to its day's centroid. Higher = worse. */
  isolationScore: number
  /** Engine-generated short string. e.g. "11 min from Mon centroid; nearest neighbor is Tue cluster." */
  reason: string
}

export type DiagnosticReport = {
  /** SchedulePlan.id this diagnostic is bound to. */
  scheduleId: string
  generatedAt: string
  /** Recurrence-weighted average drive minutes per week. Same metric the engine uses. */
  totalDriveMinutesPerWeek: number
  clusters: ClusterDiagnostic[]
  outliers: OutlierJob[]
  /** Clients the engine couldn't place within constraints. */
  benched: { clientId: string; clientName: string; reason: string }[]
  /** Number of weeks projected for capacity verification. >= 4. */
  horizonWeeks: number
}

// ────────────────────────────────────────────────────────────────────────
// Legal Moves — engine pre-validates these.
// Anything in the menu is guaranteed to respect:
//   - max jobs per day across the FULL projected horizon (every week)
//   - working day mask
//   - per-client blockedDays
//   - recurrence integrity (weekly stays weekly, biweekly rotation valid)
//   - one-time clients are NOT eligible (excluded from move generation)
// ────────────────────────────────────────────────────────────────────────

/**
 * Per-week peak job count after the move is applied.
 * Indexed by week (0..horizonWeeks-1) then by day of week.
 * Engine has already verified every value <= maxJobsPerDay.
 */
export type PerWeekPeakLoad = Record<number, Record<number, number>>

export type LegalMoveImpact = {
  /** Negative = saves drive time. Recurrence-weighted weekly delta. */
  driveMinutesDelta: number
  /** Days whose route changes if this move is applied. */
  affectedDays: DayOfWeek[]
  /** Capacity proof: peak load per (week, day) AFTER applying. All <= maxJobsPerDay. */
  perWeekPeakLoad: PerWeekPeakLoad
  /** Cluster tightness change (avg pairwise minutes). Negative = tighter. */
  tightnessDelta: number
}

/** Swap two clients between days. Both clients keep their original frequency. */
export type SwapMove = {
  id: string
  type: 'swap'
  clientAId: string
  clientBId: string
  clientAName: string
  clientBName: string
  fromDayA: DayOfWeek
  fromDayB: DayOfWeek
  fromRotationA: 0 | 1
  fromRotationB: 0 | 1
  /** = fromDayB for a pure swap; may differ for cross-cluster repositioning. */
  toDayA: DayOfWeek
  toDayB: DayOfWeek
  toRotationA: 0 | 1
  toRotationB: 0 | 1
  impact: LegalMoveImpact
}

/** Move a single client to a different day (and possibly different rotation for biweekly). */
export type ReassignMove = {
  id: string
  type: 'reassign'
  clientId: string
  clientName: string
  fromDay: DayOfWeek
  toDay: DayOfWeek
  fromRotation: 0 | 1
  toRotation: 0 | 1
  impact: LegalMoveImpact
}

export type LegalMove = SwapMove | ReassignMove

export type LegalMoveSet = {
  scheduleId: string
  generatedAt: string
  /** Capped subset (best by impact). Cap is set in AIOptimizerConfig.legalMoveCap. */
  moves: LegalMove[]
  /** Total moves the engine considered before capping. For diagnostics. */
  totalConsidered: number
}

// ────────────────────────────────────────────────────────────────────────
// LLM Suggestion — what the LLM returns.
// Must reference legal move IDs. The LLM cannot invent new moves.
// Validated by Zod against this shape before reaching the loop.
// ────────────────────────────────────────────────────────────────────────

export type LLMSuggestion = {
  /** Move IDs the LLM recommends applying, in priority order. */
  selectedMoveIds: string[]
  /** Plain-English explanation surfaced to the user via the trace panel. */
  reasoning: string
  /** Optional notes on moves it considered but rejected. */
  rejectedMoveIds: { id: string; reason: string }[]
  /** Higher-level commentary on schedule shape (visible in trace, not user-facing). */
  observations: string
}

// ────────────────────────────────────────────────────────────────────────
// Optimization Trace — the audit log.
// Visible to dev (full) and user (filtered) via the AI Trace panel.
// ────────────────────────────────────────────────────────────────────────

export type OptimizationIteration = {
  index: number
  diagnostic: DiagnosticReport
  legalMoves: LegalMoveSet
  llm: {
    /** Gateway provider/model string, e.g. "anthropic/claude-sonnet-4-6". */
    model: string
    promptTokens: number
    completionTokens: number
    /** Tokens served from prompt cache. Lower cost, faster. */
    cachedTokens: number
    latencyMs: number
    suggestion: LLMSuggestion
  }
  /** Moves actually applied (post-tabu, post-validation). Subset of suggestion.selectedMoveIds. */
  applied: LegalMove[]
  /** Moves the LLM picked but the loop skipped. */
  skipped: { moveId: string; reason: 'tabu' | 'invalid' | 'llm-rejected' }[]
}

export type OptimizationExitReason =
  | 'no-improvements'           // LLM returned an empty selection
  | 'max-iterations-reached'    // Hit AIOptimizerConfig.maxIterations
  | 'convergence-threshold'     // Iteration improved <convergenceThresholdPct
  | 'tabu-blocked-all'          // All LLM picks were on the tabu list
  | 'llm-error'                 // LLM unreachable / invalid output (engine result still returned)
  | 'engine-error'              // Engine failed (bubbled up — caller decides)

export type OptimizationTrace = {
  scheduleId: string
  startedAt: string
  endedAt: string
  iterations: OptimizationIteration[]
  exitReason: OptimizationExitReason
  /** Drive minutes BEFORE any LLM iteration. */
  initialDriveMinutes: number
  /** Drive minutes AFTER all applied moves. */
  finalDriveMinutes: number
  /** initialDriveMinutes - finalDriveMinutes. Positive = improvement. */
  improvementMinutes: number
}

// ────────────────────────────────────────────────────────────────────────
// Recurrence Projection — utility shape used by the legal-moves generator
// to verify capacity in every projected week. Not exposed to the LLM.
// ────────────────────────────────────────────────────────────────────────

export type RecurrenceProjection = {
  clientId: string
  frequency: Frequency
  intervalWeeks?: number
  rotation: 0 | 1
  /** Weeks (0-indexed within horizon) this client appears in. */
  activeWeeks: number[]
}

// ────────────────────────────────────────────────────────────────────────
// AI Optimizer Config — runtime knobs.
// All defaults documented in DEFAULT_AI_CONFIG below.
// ────────────────────────────────────────────────────────────────────────

export type AIOptimizerConfig = {
  /** Hard cap on iterations. Default: 2. Two passes is plenty — diminishing returns hit fast. */
  maxIterations: number
  /** Stop if an iteration improves total drive time by less than this percent. Default: 5. */
  convergenceThresholdPct: number
  /**
   * Weeks of capacity verification for every legal move. Default: 4.
   * Auto-bumps to longest custom intervalWeeks if greater.
   */
  horizonWeeks: number
  /** Max moves sent to the LLM per iteration. Default: 25. Keeps tokens bounded. */
  legalMoveCap: number
  /** Vercel AI Gateway provider/model string. */
  model: string
  /** Optional cheaper fallback if the primary model fails. */
  fallbackModel?: string
}

export const DEFAULT_AI_CONFIG: AIOptimizerConfig = {
  maxIterations: 2,
  convergenceThresholdPct: 5,
  horizonWeeks: 4,
  legalMoveCap: 25,
  model: 'anthropic/claude-sonnet-4-6',
  fallbackModel: 'anthropic/claude-haiku-4-5',
}

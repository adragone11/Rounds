/**
 * Optimization Loop
 *
 * Orchestrates: diagnostics → legal moves → LLM call → apply → repeat.
 *
 * Hard caps:
 *   - max iterations (default 2)
 *   - convergence threshold (default <5% improvement → stop)
 *   - tabu list (no move ID can be applied twice in the same loop)
 *
 * The LLM call is injected so this module stays transport-agnostic: the
 * Vercel function passes in a function that hits AI Gateway; tests can
 * pass in a stub.
 */

import type { PerfectScheduleResult } from '../scheduleBuilder'
import { computeDiagnostics } from './diagnostics'
import { generateLegalMoves } from './legalMoves'
import { applyMoveSequence } from './applyMove'
import type {
  AIOptimizerConfig,
  DiagnosticReport,
  LegalMoveSet,
  LLMSuggestion,
  OptimizationExitReason,
  OptimizationIteration,
  OptimizationTrace,
} from './types'
import { DEFAULT_AI_CONFIG } from './types'

/**
 * The injected LLM caller. The loop hands it diagnostics + the legal-moves
 * menu and expects an LLMSuggestion in return. Implementations live in the
 * API route (real Gateway call) and tests (stub).
 */
export type LLMCaller = (params: {
  diagnostic: DiagnosticReport
  legalMoves: LegalMoveSet
  iterationIndex: number
}) => Promise<{
  suggestion: LLMSuggestion
  meta: {
    model: string
    promptTokens: number
    completionTokens: number
    cachedTokens: number
    latencyMs: number
  }
}>

export type RunOptimizationLoopParams = {
  schedule: PerfectScheduleResult
  scheduleId: string
  llmCall: LLMCaller
  config?: Partial<AIOptimizerConfig>
}

export type RunOptimizationLoopResult = {
  refinedSchedule: PerfectScheduleResult
  trace: OptimizationTrace
  finalDiagnostics: DiagnosticReport
}

export async function runOptimizationLoop(
  params: RunOptimizationLoopParams,
): Promise<RunOptimizationLoopResult> {
  const cfg: AIOptimizerConfig = { ...DEFAULT_AI_CONFIG, ...params.config }
  const { scheduleId, llmCall } = params
  const startedAt = new Date().toISOString()
  const initialDriveMinutes = params.schedule.totalDriveMinutes

  let current = params.schedule
  const tabu = new Set<string>()
  const iterations: OptimizationIteration[] = []
  let exitReason: OptimizationExitReason = 'no-improvements'
  let finalDiagnostics: DiagnosticReport = computeDiagnostics(current, {
    scheduleId,
    horizonWeeks: cfg.horizonWeeks,
  })

  for (let i = 0; i < cfg.maxIterations; i++) {
    const diagnostic = computeDiagnostics(current, {
      scheduleId,
      horizonWeeks: cfg.horizonWeeks,
    })
    finalDiagnostics = diagnostic

    // Early exit if there's nothing to improve.
    if (diagnostic.outliers.length === 0) {
      exitReason = 'no-improvements'
      break
    }

    const legalMoves = generateLegalMoves(current, {
      scheduleId,
      horizonWeeks: cfg.horizonWeeks,
      legalMoveCap: cfg.legalMoveCap,
    })
    if (legalMoves.moves.length === 0) {
      exitReason = 'no-improvements'
      break
    }

    // Ask the LLM which moves to apply.
    let llmResponse: Awaited<ReturnType<LLMCaller>>
    try {
      llmResponse = await llmCall({ diagnostic, legalMoves, iterationIndex: i })
    } catch {
      exitReason = 'llm-error'
      break
    }
    const { suggestion, meta } = llmResponse

    // Filter the LLM's picks against the tabu list and the available menu.
    const available = new Map(legalMoves.moves.map(m => [m.id, m]))
    const skippedFromLLM: { moveId: string; reason: 'tabu' | 'invalid' | 'llm-rejected' }[] = []
    const ordered: typeof legalMoves.moves = []
    for (const id of suggestion.selectedMoveIds) {
      const move = available.get(id)
      if (!move) {
        skippedFromLLM.push({ moveId: id, reason: 'invalid' })
        continue
      }
      if (tabu.has(id)) {
        skippedFromLLM.push({ moveId: id, reason: 'tabu' })
        continue
      }
      ordered.push(move)
    }

    if (ordered.length === 0) {
      // The LLM either picked nothing or every pick was tabu. End the loop.
      iterations.push({
        index: i,
        diagnostic,
        legalMoves,
        llm: { ...meta, suggestion },
        applied: [],
        skipped: skippedFromLLM,
      })
      exitReason = skippedFromLLM.some(s => s.reason === 'tabu')
        ? 'tabu-blocked-all'
        : 'no-improvements'
      break
    }

    const beforeDrive = current.totalDriveMinutes
    const applyResult = applyMoveSequence(current, ordered)
    current = applyResult.schedule
    for (const id of applyResult.appliedIds) tabu.add(id)
    const conflictSkips = applyResult.skipped.map(s => ({
      moveId: s.id,
      reason: 'invalid' as const,
    }))

    iterations.push({
      index: i,
      diagnostic,
      legalMoves,
      llm: { ...meta, suggestion },
      applied: ordered.filter(m => applyResult.appliedIds.includes(m.id)),
      skipped: [...skippedFromLLM, ...conflictSkips],
    })

    // Convergence check — if this iteration didn't move the needle, stop.
    const afterDrive = current.totalDriveMinutes
    const improvementPct = beforeDrive > 0 ? ((beforeDrive - afterDrive) / beforeDrive) * 100 : 0
    if (improvementPct < cfg.convergenceThresholdPct && i < cfg.maxIterations - 1) {
      exitReason = 'convergence-threshold'
      break
    }

    if (i === cfg.maxIterations - 1) {
      exitReason = 'max-iterations-reached'
    }
  }

  const endedAt = new Date().toISOString()
  const finalDriveMinutes = current.totalDriveMinutes

  const trace: OptimizationTrace = {
    scheduleId,
    startedAt,
    endedAt,
    iterations,
    exitReason,
    initialDriveMinutes,
    finalDriveMinutes,
    improvementMinutes: initialDriveMinutes - finalDriveMinutes,
  }

  // Re-compute final diagnostics from the post-loop schedule so the trace
  // panel can render "after" geometry alongside the per-iteration "before".
  finalDiagnostics = computeDiagnostics(current, {
    scheduleId,
    horizonWeeks: cfg.horizonWeeks,
  })

  return {
    refinedSchedule: current,
    trace,
    finalDiagnostics,
  }
}

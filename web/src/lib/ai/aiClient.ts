/**
 * Client-side wrapper for /api/ai/optimize.
 *
 * Web (and later mobile) calls this after the engine has produced a
 * PerfectScheduleResult. Returns the AI-refined schedule + the trace the UI
 * shows in the visibility panel.
 *
 * No business logic lives here — this is purely transport. All decisions
 * (which moves to apply, when to stop iterating) happen server-side.
 */

import type { PerfectScheduleResult } from '../scheduleBuilder'
import {
  serializeSchedule,
  deserializeSchedule,
  type SerializedPerfectSchedule,
} from './serialize'
import type {
  AIOptimizerConfig,
  DiagnosticReport,
  OptimizationTrace,
} from './types'

export type OptimizeViaAIParams = {
  schedule: PerfectScheduleResult
  scheduleId: string
  options?: Partial<AIOptimizerConfig>
}

export type OptimizeViaAIResult = {
  refinedSchedule: PerfectScheduleResult
  trace: OptimizationTrace
  finalDiagnostics: DiagnosticReport
}

export async function optimizeViaAI(
  params: OptimizeViaAIParams,
): Promise<OptimizeViaAIResult> {
  const body = {
    scheduleId: params.scheduleId,
    schedule: serializeSchedule(params.schedule),
    options: params.options,
  }

  const res = await fetch('/api/ai/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AI optimize failed (${res.status}): ${text}`)
  }

  const data = await res.json() as {
    refinedSchedule: SerializedPerfectSchedule
    trace: OptimizationTrace
    finalDiagnostics: DiagnosticReport
  }

  return {
    refinedSchedule: deserializeSchedule(data.refinedSchedule),
    trace: data.trace,
    finalDiagnostics: data.finalDiagnostics,
  }
}

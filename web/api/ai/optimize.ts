/**
 * POST /api/ai/optimize
 *
 * Runs the AI optimization loop on a schedule produced by the engine.
 * Web (and later: mobile) calls this with a serialized PerfectScheduleResult.
 * The server runs diagnostics → legal moves → LLM call → apply, returns the
 * refined schedule + full trace.
 *
 * Auth model:
 *   - AI_GATEWAY_API_KEY env var (set in Vercel Preview/Production)
 *   - Auto-provisioned via OIDC when deployed; required in .env.local for dev
 *
 * Cost ceiling:
 *   - Sonnet 4.5 default, prompt caching on the system block
 *   - Hard cap of 2 iterations enforced by the loop
 *   - Typical run: ~$0.02-0.03 per call
 *
 * NOT a streaming endpoint. Returns once the loop converges/exits. Loop is
 * bounded so total request time is predictable (< 30s in practice).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { generateText, Output, gateway } from 'ai'
import { z } from 'zod'

import {
  deserializeSchedule,
  serializeSchedule,
  type SerializedPerfectSchedule,
} from '../../src/lib/ai/serialize'
import { runOptimizationLoop, type LLMCaller } from '../../src/lib/ai/optimizationLoop'
import type {
  AIOptimizerConfig,
  DiagnosticReport,
  LegalMoveSet,
} from '../../src/lib/ai/types'

// ────────────────────────────────────────────────────────────────────────
// Request / response shapes
// ────────────────────────────────────────────────────────────────────────

type RequestBody = {
  scheduleId: string
  schedule: SerializedPerfectSchedule
  options?: Partial<AIOptimizerConfig>
}

// ────────────────────────────────────────────────────────────────────────
// LLM output schema (Zod) — what the model is contractually allowed to return.
// Keep flat. The richer LLMSuggestion type in lib/ai/types.ts wraps this.
// ────────────────────────────────────────────────────────────────────────

const SuggestionSchema = z.object({
  selectedMoveIds: z.array(z.string()).describe(
    'Move IDs from the provided menu, in priority order. Empty array if no move is worth applying.',
  ),
  reasoning: z.string().describe(
    'Plain-English explanation of WHY these moves were chosen. Shown to the user.',
  ),
  rejectedMoveIds: z.array(z.object({
    id: z.string(),
    reason: z.string(),
  })).describe('Optional notes on moves you considered but rejected. Can be empty.'),
  observations: z.string().describe(
    'Higher-level commentary on the schedule shape. Internal — not shown to users.',
  ),
})

// ────────────────────────────────────────────────────────────────────────
// System prompt — the role, the rules, the priorities.
// Lives at file scope so prompt caching can deduplicate it across iterations.
// ────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the polish layer for a deterministic scheduling engine that builds weekly routes for a solo house cleaner.

The engine has already produced a valid schedule that respects every hard constraint (max jobs per day, working days, recurrence patterns, blocked days). Your job is NOT to rebuild the schedule. Your job is to identify the small handful of edits that would make it feel more "human-optimized" — tighter geographic clusters, fewer outlier jobs, more intuitive routes.

You will receive:
1. A diagnostic report: cluster centroids, tightness scores, outlier jobs, total drive time.
2. A pre-validated menu of legal moves (swaps and reassigns). Each carries proof that it's safe across every projected week.

Rules:
- You may ONLY return move IDs from the provided menu. You cannot invent moves.
- You may select multiple moves in priority order. The system applies them in order, skipping any that conflict.
- An empty selection is valid — return [] if no move is worth applying.
- Do NOT pick moves that touch the same client (the second one will be skipped as a conflict).

Priorities, in order:
1. Reduce total drive time (every move's driveMinutesDelta is negative — pick the ones that save the most).
2. Tighten clusters (lower tightnessDelta = better).
3. Fix obvious outliers (clients flagged in diagnostics.outliers).
4. Avoid disruption — prefer moves that affect fewer days.

Be conservative. If the schedule already looks good, return [] and say so. The user will trust your judgment more if you don't fabricate improvements.

Reasoning should be concise, plain English, and reference the clients by name. Example:
"Moved Sarah from Friday to Tuesday — she's 14 minutes from the Friday cluster but right next to the Tuesday group. Saves 8 min/week of driving."`

// ────────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  // Auth: AI Gateway uses AI_GATEWAY_API_KEY locally and OIDC tokens on
  // production Vercel. The AI SDK picks whichever is available — we don't
  // gate on env vars here so OIDC-only deployments work without changes.

  let body: RequestBody
  try {
    body = req.body as RequestBody
    if (!body || !body.scheduleId || !body.schedule) throw new Error('missing fields')
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  let schedule
  try {
    schedule = deserializeSchedule(body.schedule)
  } catch (err) {
    return res.status(400).json({
      error: 'Invalid schedule shape',
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  const model = body.options?.model ?? DEFAULT_MODEL

  const llmCall: LLMCaller = async ({ diagnostic, legalMoves, iterationIndex }) => {
    const userPrompt = buildUserPrompt(diagnostic, legalMoves, iterationIndex)
    const t0 = Date.now()

    const { output, usage } = await generateText({
      model: gateway(model),
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      output: Output.object({ schema: SuggestionSchema }),
    })

    const latencyMs = Date.now() - t0
    return {
      suggestion: {
        selectedMoveIds: output.selectedMoveIds,
        reasoning: output.reasoning,
        rejectedMoveIds: output.rejectedMoveIds,
        observations: output.observations,
      },
      meta: {
        model,
        promptTokens: usage?.inputTokens ?? 0,
        completionTokens: usage?.outputTokens ?? 0,
        cachedTokens: usage?.cachedInputTokens ?? 0,
        latencyMs,
      },
    }
  }

  try {
    const result = await runOptimizationLoop({
      schedule,
      scheduleId: body.scheduleId,
      llmCall,
      config: body.options,
    })

    return res.status(200).json({
      refinedSchedule: serializeSchedule(result.refinedSchedule),
      trace: result.trace,
      finalDiagnostics: result.finalDiagnostics,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return res.status(500).json({ error: 'Optimization failed', detail })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Prompt construction — kept verbose intentionally. Readable prompts age
// better than clever ones. Token cost is bounded by the move cap.
// ────────────────────────────────────────────────────────────────────────

function buildUserPrompt(
  diagnostic: DiagnosticReport,
  legalMoves: LegalMoveSet,
  iterationIndex: number,
): string {
  return `Iteration ${iterationIndex + 1} of the optimization loop.

DIAGNOSTIC REPORT
${JSON.stringify(diagnostic, null, 2)}

LEGAL MOVES MENU
${JSON.stringify(legalMoves, null, 2)}

Respond with the structured object: which moves to apply (by id), why, what you considered and rejected, and any higher-level observations.`
}

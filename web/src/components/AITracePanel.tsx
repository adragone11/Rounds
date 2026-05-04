/**
 * AI Trace Panel — shows exactly what the AI saw, picked, and why.
 *
 * This is the visibility surface the user said was critical. It's both a
 * dev tool (debug the loop) AND a product feature (build user trust).
 *
 * Renders:
 *   - Summary card: minutes saved, moves applied, exit reason
 *   - Per-iteration breakdown: outliers shown, moves picked, reasoning,
 *     skipped (with reason: tabu / conflict / invalid)
 *   - Token + latency stats (dev-flavored, intentionally subtle)
 */

import { useState } from 'react'
import type { OptimizationTrace } from '../lib/ai/types'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Props = {
  trace: OptimizationTrace
  onDismiss?: () => void
}

export default function AITracePanel({ trace, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(true)

  const movesApplied = trace.iterations.reduce((s, i) => s + i.applied.length, 0)
  const totalTokens = trace.iterations.reduce(
    (s, i) => s + i.llm.promptTokens + i.llm.completionTokens,
    0,
  )
  const totalLatency = trace.iterations.reduce((s, i) => s + i.llm.latencyMs, 0)

  const exitLabel = labelForExitReason(trace.exitReason)
  const improved = trace.improvementMinutes > 0

  return (
    <div className="border border-purple-200 bg-purple-50/50 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-purple-50 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-500 to-fuchsia-500 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-purple-900 truncate">
              {improved
                ? `AI saved ${trace.improvementMinutes} min/week`
                : movesApplied === 0
                  ? 'AI: no improvements found'
                  : `AI applied ${movesApplied} ${movesApplied === 1 ? 'move' : 'moves'}`}
            </div>
            <div className="text-xs text-purple-700 truncate">
              {movesApplied} {movesApplied === 1 ? 'move' : 'moves'} • {trace.iterations.length} {trace.iterations.length === 1 ? 'pass' : 'passes'} • {exitLabel}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {onDismiss && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onDismiss() }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onDismiss() } }}
              className="text-xs text-purple-600 hover:text-purple-800 px-2 py-1 cursor-pointer"
            >
              Dismiss
            </span>
          )}
          <svg
            className={`w-4 h-4 text-purple-700 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Body */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-purple-200">
          {/* Per-iteration */}
          {trace.iterations.map(iter => (
            <div key={iter.index} className="space-y-3 pt-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-purple-900 uppercase tracking-wide">
                  Iteration {iter.index + 1}
                </div>
                <div className="text-[10px] text-purple-600 tabular-nums">
                  {iter.llm.latencyMs}ms · {iter.llm.promptTokens + iter.llm.completionTokens} tok
                </div>
              </div>

              {/* What the LLM saw */}
              {iter.diagnostic.outliers.length > 0 && (
                <div className="bg-white/70 rounded-lg p-3 border border-purple-100">
                  <div className="text-[11px] font-semibold text-purple-800 mb-1.5">
                    Flagged as outliers
                  </div>
                  <ul className="space-y-1">
                    {iter.diagnostic.outliers.slice(0, 5).map(o => (
                      <li key={o.clientId} className="text-xs text-purple-900">
                        <span className="font-medium">{o.clientName}</span>{' '}
                        <span className="text-purple-600">({DAYS[o.currentDay]})</span>
                        <span className="text-purple-700"> — {o.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* What the LLM said */}
              <div className="bg-white/70 rounded-lg p-3 border border-purple-100">
                <div className="text-[11px] font-semibold text-purple-800 mb-1.5">
                  AI reasoning
                </div>
                <p className="text-xs text-gray-800 leading-relaxed whitespace-pre-wrap">
                  {iter.llm.suggestion.reasoning || <em className="text-gray-500">No reasoning provided.</em>}
                </p>
              </div>

              {/* What got applied */}
              {iter.applied.length > 0 ? (
                <div className="bg-green-50 rounded-lg p-3 border border-green-200">
                  <div className="text-[11px] font-semibold text-green-800 mb-1.5">
                    Applied ({iter.applied.length})
                  </div>
                  <ul className="space-y-1">
                    {iter.applied.map(m => (
                      <li key={m.id} className="text-xs text-green-900 tabular-nums">
                        {m.type === 'reassign'
                          ? <>{m.clientName}: {DAYS[m.fromDay]} → {DAYS[m.toDay]}</>
                          : <>Swap: {m.clientAName} ({DAYS[m.fromDayA]}↔{DAYS[m.toDayA]}) ↔ {m.clientBName} ({DAYS[m.fromDayB]}↔{DAYS[m.toDayB]})</>
                        }
                        <span className="text-green-700 ml-1.5">
                          ({m.impact.driveMinutesDelta > 0 ? '+' : ''}{m.impact.driveMinutesDelta}m)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <div className="text-xs text-gray-700 italic">
                    No moves applied this iteration.
                  </div>
                </div>
              )}

              {/* Skipped */}
              {iter.skipped.length > 0 && (
                <details className="bg-yellow-50 rounded-lg border border-yellow-200">
                  <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-yellow-800">
                    Skipped ({iter.skipped.length})
                  </summary>
                  <ul className="px-3 pb-3 space-y-1">
                    {iter.skipped.map((s, idx) => (
                      <li key={`${s.moveId}-${idx}`} className="text-xs text-yellow-900 font-mono">
                        {s.moveId}
                        <span className="text-yellow-700 ml-2">({s.reason})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}

          {/* Footer: dev stats */}
          <div className="pt-2 border-t border-purple-200 flex items-center justify-between text-[10px] text-purple-700 tabular-nums">
            <span>{trace.iterations.length} iter · {totalTokens} tok · {totalLatency}ms total</span>
            <span>{trace.iterations[0]?.llm.model ?? 'no model'}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function labelForExitReason(r: OptimizationTrace['exitReason']): string {
  switch (r) {
    case 'no-improvements': return 'no further improvements'
    case 'max-iterations-reached': return 'max iterations reached'
    case 'convergence-threshold': return 'converged'
    case 'tabu-blocked-all': return 'tabu blocked all moves'
    case 'llm-error': return 'LLM error'
    case 'engine-error': return 'engine error'
  }
}

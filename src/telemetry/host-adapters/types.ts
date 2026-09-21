/**
 * Host telemetry adapter types.
 *
 * All numeric fields use `null` to represent "unknown / not observed / absent".
 * An observed 0 is a meaningful value distinct from absence.
 *
 * Privacy: This type carries only allowlisted numeric counts, durations,
 * identifiers and status. It NEVER contains raw prompts, source code,
 * file paths, error stacks, or log content.
 */

// ── Token Usage ─────────────────────────────────────────────────────

export interface StepUsage {
  totalInputTokens: number | null;
  cachedInputTokens: number | null;
  freshInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

// ── Quality ─────────────────────────────────────────────────────────

export type StepEstimation = "exact" | "estimated" | "unknown";

export interface ParseQuality {
  totalEvents: number;
  malformedEvents: number;
  invalidUsageEvents: number;
  isComplete: boolean;
  /** Whether agent step count is exact (identity-tracked), estimated, or unknown. */
  stepEstimation: StepEstimation;
}

// ── Outcome ─────────────────────────────────────────────────────────

/**
 * Explicit task/request outcome.
 * - 'succeeded': evidenced by correlated run_finish/manifest or explicit annotation
 * - 'failed': evidenced by correlated failure event or explicit annotation
 * - 'unknown': no outcome evidence available (default)
 *
 * outcome and usage completeness are independent dimensions.
 */
export type RequestOutcome = "succeeded" | "failed" | "unknown";

export interface OutcomeProvenance {
  /** Source of the outcome determination. */
  source: "events_jsonl" | "annotation" | "none";
  /** run_id from correlated events.jsonl, if any. */
  runId?: string;
  /** event_type that determined the outcome (e.g. 'run_finish'). */
  eventType?: string;
}

// ── Per-request report ──────────────────────────────────────────────

export interface HostUsageReport {
  requestId: string | null;
  usage: StepUsage;
  agentSteps: number | null;
  compactionCount: number | null;
  quality: ParseQuality;
  outcome: RequestOutcome;
  outcomeProvenance: OutcomeProvenance;
}

// ── Events.jsonl correlation ────────────────────────────────────────

/**
 * Canonical TelemetryEvent shape from src/telemetry/events.ts.
 * Used for offline correlation — not imported at runtime to avoid
 * coupling to foundation build state.
 */
export interface CanonicalTelemetryEvent {
  trace_id: string;
  run_id: string;
  timestamp: string;
  event_type:
    | "run_start"
    | "task_start"
    | "task_complete"
    | "gate_start"
    | "gate_complete"
    | "retry"
    | "escalation"
    | "budget_consumed"
    | "run_finish";
  task_id?: string;
  gate_id?: string;
  attempt?: number;
  duration_ms?: number;
  failure_class?: string;
  status?: string;
  metrics?: Record<string, number>;
}

/**
 * Runtime metrics extracted from events.jsonl for a single run.
 * All fields null when no events.jsonl is available.
 */
export interface RuntimeMetrics {
  runId: string;
  workerCalls: number | null;
  gatesFirstPassCount: number | null;
  gatesFinalPassCount: number | null;
  gatesTotal: number | null;
  fetchCount: number | null;
  fetchBytes: number | null;
  rawDigestBytes: number | null;
  rawDigestTokens: number | null;
  responseBytes: number | null;
  durationMs: number | null;
  runStatus: string | null;
}

// ── Trace parse result ──────────────────────────────────────────────

export interface TraceParseResult {
  hostType: "codex" | "claude-code";
  requests: HostUsageReport[];
  quality: ParseQuality;
}

// ── Baseline report ─────────────────────────────────────────────────

export interface BaselineReport {
  version: "1";
  hostType: "codex" | "claude-code";
  variant: string;
  comparableGroup: string;
  isSynthetic: boolean;
  requests: HostUsageReport[];
  runtime: RuntimeMetrics | null;
  stats: DescriptiveStats | null;
  outcomeStats: OutcomeStats;
  quality: ParseQuality;
}

export interface OutcomeStats {
  total: number;
  succeeded: number;
  failed: number;
  unknown: number;
}

export interface DescriptiveStats {
  /** N = number of succeeded requests with observed usage. */
  n: number;
  /** Requests excluded from stats (failed/unknown outcome or missing usage). */
  excluded: number;
  excludedReasons: {
    failedOutcome: number;
    unknownOutcome: number;
    missingUsage: number;
  };
  totalInputTokens: NumericSummary | null;
  freshInputTokens: NumericSummary | null;
  outputTokens: NumericSummary | null;
  agentSteps: NumericSummary | null;
}

export interface NumericSummary {
  min: number;
  max: number;
  median: number;
  p95: number;
  sum: number;
}

// ── Comparison ──────────────────────────────────────────────────────

export interface ComparisonResult {
  comparableGroup: string;
  hostType: string;
  matchedCaseIds: string[];
  variants: Record<string, VariantSummary>;
  warnings: string[];
}

export interface VariantSummary {
  n: number;
  excluded: number;
  isSynthetic: boolean;
  outcomeStats: OutcomeStats;
  perSucceededRequest: {
    totalInputTokens: NumericSummary | null;
    freshInputTokens: NumericSummary | null;
    outputTokens: NumericSummary | null;
    agentSteps: NumericSummary | null;
  };
}

// ── Host event identity for cross-file dedup ────────────────────────

export interface ParsedHostEvent {
  /** Stable identity key for dedup across files. null if not identifiable. */
  identityKey: string | null;
  /** The parsed event object. */
  event: Record<string, unknown>;
  /** Which request this event belongs to. */
  requestId: string | null;
}

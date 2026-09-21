import type {
  HostUsageReport,
  StepUsage,
  ParseQuality,
  TraceParseResult,
  ParsedHostEvent,
} from "./types.js";

// ── Validation ──────────────────────────────────────────────────────

function isNonNegInt(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v === Math.floor(v)
  );
}

function validateField(v: unknown): number | null | "INVALID" {
  if (v === undefined || v === null) return null;
  if (isNonNegInt(v)) return v;
  return "INVALID";
}

function validateUsage(raw: Record<string, unknown>): StepUsage | null {
  const totalInput = validateField(raw["input_tokens"]);
  const cachedInput = validateField(raw["cached_input_tokens"]);
  const outputTokens = validateField(raw["output_tokens"]);
  const reasoningOutput = validateField(raw["reasoning_output_tokens"]);
  if (
    totalInput === "INVALID" ||
    cachedInput === "INVALID" ||
    outputTokens === "INVALID" ||
    reasoningOutput === "INVALID"
  )
    return null;
  if (totalInput !== null && cachedInput !== null && cachedInput > totalInput)
    return null;
  const freshInput =
    totalInput !== null && cachedInput !== null
      ? totalInput - cachedInput
      : null;
  return {
    totalInputTokens: totalInput,
    cachedInputTokens: cachedInput,
    freshInputTokens: freshInput,
    outputTokens,
    reasoningOutputTokens: reasoningOutput,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

function addUsage(acc: StepUsage, step: StepUsage): StepUsage {
  return {
    totalInputTokens: addNullable(acc.totalInputTokens, step.totalInputTokens),
    cachedInputTokens: addNullable(
      acc.cachedInputTokens,
      step.cachedInputTokens,
    ),
    freshInputTokens: addNullable(acc.freshInputTokens, step.freshInputTokens),
    outputTokens: addNullable(acc.outputTokens, step.outputTokens),
    reasoningOutputTokens: addNullable(
      acc.reasoningOutputTokens,
      step.reasoningOutputTokens,
    ),
  };
}

function emptyUsage(): StepUsage {
  return {
    totalInputTokens: null,
    cachedInputTokens: null,
    freshInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
  };
}

function emptyQuality(): ParseQuality {
  return {
    totalEvents: 0,
    malformedEvents: 0,
    invalidUsageEvents: 0,
    isComplete: true,
    stepEstimation: "unknown",
  };
}

function emptyReport(requestId: string | null): HostUsageReport {
  return {
    requestId,
    usage: emptyUsage(),
    agentSteps: null,
    compactionCount: null,
    quality: emptyQuality(),
    outcome: "unknown",
    outcomeProvenance: { source: "none" },
  };
}

// ── Compaction ───────────────────────────────────────────────────────

const COMPACTION_TYPES = new Set(["compaction", "compacted"]);
function isExplicitCompaction(event: Record<string, unknown>): boolean {
  if (typeof event["type"] === "string" && COMPACTION_TYPES.has(event["type"]))
    return true;
  const p = event["payload"];
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const pt = (p as Record<string, unknown>)["type"];
    if (typeof pt === "string" && COMPACTION_TYPES.has(pt)) return true;
  }
  return false;
}

// ── Event identity for cross-file dedup ─────────────────────────────

function codexEventIdentity(event: Record<string, unknown>): string | null {
  const eid = event["event_id"] ?? event["id"];
  if (typeof eid === "string" || typeof eid === "number") return `eid:${eid}`;
  // Fingerprint from total_token_usage snapshot (cumulative => unique per step)
  const payload = event["payload"] as Record<string, unknown> | undefined;
  if (!payload) return null;
  const total =
    payload["total_token_usage"] ??
    (payload["info"] as Record<string, unknown> | undefined)?.[
      "total_token_usage"
    ];
  if (total && typeof total === "object") {
    const t = total as Record<string, unknown>;
    return `total:${t["input_tokens"]}:${t["cached_input_tokens"]}:${t["output_tokens"]}:${t["reasoning_output_tokens"]}`;
  }
  return null;
}

/**
 * Extract identifiable events from Codex trace content for cross-file dedup.
 */
export function extractCodexEvents(content: string): ParsedHostEvent[] {
  const raws = parseInputEvents(content);
  const results: ParsedHostEvent[] = [];
  for (const raw of raws) {
    if (raw === null) {
      results.push({ identityKey: null, event: {}, requestId: null });
      continue;
    }
    const reqId =
      typeof raw["request_id"] === "string" ? raw["request_id"] : null;
    results.push({
      identityKey: codexEventIdentity(raw),
      event: raw,
      requestId: reqId,
    });
  }
  return results;
}

/**
 * Parse deduplicated Codex events into per-request reports.
 * Caller is responsible for cross-file dedup before calling this.
 */
export function parseCodexEvents(events: ParsedHostEvent[]): TraceParseResult {
  const quality = emptyQuality();
  const grouped = new Map<string | null, ParsedHostEvent[]>();
  const seenIdentities = new Set<string>();
  for (const pe of events) {
    if (Object.keys(pe.event).length === 0 && pe.identityKey === null) {
      quality.totalEvents++;
      quality.malformedEvents++;
      continue;
    }
    if (pe.identityKey !== null) {
      if (seenIdentities.has(pe.identityKey)) continue;
      seenIdentities.add(pe.identityKey);
    }
    quality.totalEvents++;
    let list = grouped.get(pe.requestId);
    if (!list) {
      list = [];
      grouped.set(pe.requestId, list);
    }
    list.push(pe);
  }
  quality.isComplete = quality.malformedEvents === 0;
  const requests: HostUsageReport[] = [];
  // Track session-level cumulative total_token_usage across requests
  let sessionPrevSnapshot: Record<string, unknown> | null = null;
  for (const [reqId, eventList] of grouped) {
    const result = parseCodexRequestEvents(
      reqId,
      eventList,
      quality,
      sessionPrevSnapshot,
    );
    requests.push(result.report);
    sessionPrevSnapshot = result.lastSnapshot;
  }
  return { hostType: "codex", requests, quality };
}

/** Convenience: parse single content string (no cross-file dedup). */
export function parseCodexTrace(content: string): TraceParseResult {
  return parseCodexEvents(extractCodexEvents(content));
}

function parseCodexRequestEvents(
  requestId: string | null,
  events: ParsedHostEvent[],
  globalQuality: ParseQuality,
  sessionPrevSnapshot: Record<string, unknown> | null,
): { report: HostUsageReport; lastSnapshot: Record<string, unknown> | null } {
  const report = emptyReport(requestId);
  let stepCount = 0;
  let hasIdentity = false;
  let prevTotalSnapshot = sessionPrevSnapshot;

  for (const pe of events) {
    const event = pe.event;
    if (isExplicitCompaction(event)) {
      report.compactionCount = (report.compactionCount ?? 0) + 1;
    }
    const payload = event["payload"];
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      continue;
    const pl = payload as Record<string, unknown>;
    if (pl["type"] !== "token_count") continue;
    const info = pl["info"] as Record<string, unknown> | undefined;
    if (pe.identityKey !== null) hasIdentity = true;

    let stepUsage: StepUsage | null = null;
    if (info) {
      const totalSnapshot = info["total_token_usage"] as
        Record<string, unknown> | undefined;
      if (totalSnapshot && prevTotalSnapshot) {
        stepUsage = deltaFromSnapshots(prevTotalSnapshot, totalSnapshot);
        if (!stepUsage) {
          globalQuality.invalidUsageEvents++;
          report.quality.invalidUsageEvents++;
        }
      }
      if (totalSnapshot) prevTotalSnapshot = totalSnapshot;
      if (!stepUsage) {
        const lastUsage = info["last_token_usage"] as
          Record<string, unknown> | undefined;
        if (lastUsage) {
          stepUsage = validateUsage(lastUsage);
          if (!stepUsage) {
            globalQuality.invalidUsageEvents++;
            report.quality.invalidUsageEvents++;
          }
        }
      }
    }
    if (stepUsage) {
      report.usage = addUsage(report.usage, stepUsage);
    }
    stepCount++;
  }

  if (hasIdentity) {
    report.agentSteps = stepCount;
    report.quality.stepEstimation = "exact";
  } else if (stepCount > 0) {
    report.agentSteps = stepCount;
    report.quality.stepEstimation = "estimated";
  } else {
    report.agentSteps = null;
    report.quality.stepEstimation = "unknown";
  }
  report.quality.totalEvents = events.length;
  report.quality.isComplete =
    report.quality.malformedEvents === 0 &&
    report.quality.invalidUsageEvents === 0 &&
    report.usage.totalInputTokens !== null;
  return { report, lastSnapshot: prevTotalSnapshot };
}

function deltaFromSnapshots(
  prev: Record<string, unknown>,
  curr: Record<string, unknown>,
): StepUsage | null {
  const pI = prev["input_tokens"];
  const cI = curr["input_tokens"];
  const pO = prev["output_tokens"];
  const cO = curr["output_tokens"];
  if (
    !isNonNegInt(cI) ||
    !isNonNegInt(pI) ||
    !isNonNegInt(cO) ||
    !isNonNegInt(pO)
  )
    return null;
  const dI = cI - pI;
  const dO = cO - pO;
  if (dI < 0 || dO < 0) return null; // reset
  const pC = prev["cached_input_tokens"];
  const cC = curr["cached_input_tokens"];
  const dC = isNonNegInt(cC) && isNonNegInt(pC) ? cC - pC : null;
  if (dC !== null && (dC < 0 || dC > dI)) return null;
  const pR = prev["reasoning_output_tokens"];
  const cR = curr["reasoning_output_tokens"];
  const dR = isNonNegInt(cR) && isNonNegInt(pR) ? cR - pR : null;
  if (dR !== null && dR < 0) return null;
  return {
    totalInputTokens: dI,
    cachedInputTokens: dC,
    freshInputTokens: dC !== null ? dI - dC : null,
    outputTokens: dO,
    reasoningOutputTokens: dR,
  };
}

// ── Input parsing ───────────────────────────────────────────────────

function parseInputEvents(
  content: string,
): Array<Record<string, unknown> | null> {
  const trimmed = content.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr))
        return arr.map((item: unknown) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : null,
        );
    } catch {
      /* fall through */
    }
  }
  return trimmed.split("\n").map((line) => {
    const l = line.trim();
    if (l === "") return null;
    try {
      const p = JSON.parse(l);
      return p && typeof p === "object" && !Array.isArray(p)
        ? (p as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  });
}

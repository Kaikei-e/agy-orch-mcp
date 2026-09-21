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

function validateClaudeUsage(raw: Record<string, unknown>): StepUsage | null {
  const inputTokens = validateField(raw["input_tokens"]);
  const cacheCreation = validateField(raw["cache_creation_input_tokens"]);
  const cacheRead = validateField(raw["cache_read_input_tokens"]);
  const outputTokens = validateField(raw["output_tokens"]);
  if (
    inputTokens === "INVALID" ||
    cacheCreation === "INVALID" ||
    cacheRead === "INVALID" ||
    outputTokens === "INVALID"
  )
    return null;
  const totalInput =
    inputTokens !== null && cacheCreation !== null && cacheRead !== null
      ? inputTokens + cacheCreation + cacheRead
      : null;
  const cachedInput = cacheRead;
  const freshInput =
    inputTokens !== null && cacheCreation !== null
      ? inputTokens + cacheCreation
      : null;
  if (totalInput !== null && cachedInput !== null && cachedInput > totalInput)
    return null;
  return {
    totalInputTokens: totalInput,
    cachedInputTokens: cachedInput,
    freshInputTokens: freshInput,
    outputTokens,
    reasoningOutputTokens: null,
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

const COMPACTION_MARKERS = new Set([
  "compaction",
  "compact_boundary",
  "compacted",
]);
function isExplicitCompaction(event: Record<string, unknown>): boolean {
  if (
    typeof event["type"] === "string" &&
    COMPACTION_MARKERS.has(event["type"])
  )
    return true;
  if (
    typeof event["marker"] === "string" &&
    COMPACTION_MARKERS.has(event["marker"])
  )
    return true;
  return false;
}

// ── Event identity for cross-file dedup ─────────────────────────────

function claudeEventIdentity(event: Record<string, unknown>): string | null {
  const msg = event["message"] as Record<string, unknown> | undefined;
  if (msg && typeof msg["id"] === "string") return `msg:${msg["id"]}`;
  return null;
}

/**
 * Extract identifiable events from Claude Code trace for cross-file dedup.
 */
export function extractClaudeEvents(content: string): ParsedHostEvent[] {
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
      identityKey: claudeEventIdentity(raw),
      event: raw,
      requestId: reqId,
    });
  }
  return results;
}

/**
 * Parse deduplicated Claude events into per-request reports.
 * For events with same message.id across files, keeps the LATEST (last seen).
 */
export function parseClaudeEvents(events: ParsedHostEvent[]): TraceParseResult {
  const quality = emptyQuality();
  const grouped = new Map<string | null, ParsedHostEvent[]>();
  for (const pe of events) {
    if (Object.keys(pe.event).length === 0 && pe.identityKey === null) {
      quality.totalEvents++;
      quality.malformedEvents++;
      continue;
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
  for (const [reqId, eventList] of grouped) {
    requests.push(parseClaudeRequestEvents(reqId, eventList, quality));
  }
  return { hostType: "claude-code", requests, quality };
}

/** Convenience: parse single content string. */
export function parseClaudeCodeTrace(content: string): TraceParseResult {
  return parseClaudeEvents(extractClaudeEvents(content));
}

function parseClaudeRequestEvents(
  requestId: string | null,
  events: ParsedHostEvent[],
  globalQuality: ParseQuality,
): HostUsageReport {
  const report = emptyReport(requestId);
  // Collect LATEST usage per message.id
  const messageUsages = new Map<string, Record<string, unknown>>();
  const messageOrder: string[] = [];

  for (const pe of events) {
    const event = pe.event;
    if (isExplicitCompaction(event)) {
      report.compactionCount = (report.compactionCount ?? 0) + 1;
    }
    const message = event["message"];
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const msg = message as Record<string, unknown>;
      const msgId = msg["id"];
      const usage = msg["usage"];
      if (
        typeof msgId === "string" &&
        usage &&
        typeof usage === "object" &&
        !Array.isArray(usage)
      ) {
        if (!messageUsages.has(msgId)) messageOrder.push(msgId);
        messageUsages.set(msgId, usage as Record<string, unknown>); // latest wins
      }
    }
  }

  let stepCount = 0;
  for (const msgId of messageOrder) {
    const usage = messageUsages.get(msgId)!;
    const stepUsage = validateClaudeUsage(usage);
    if (stepUsage) {
      report.usage = addUsage(report.usage, stepUsage);
      stepCount++;
    } else {
      globalQuality.invalidUsageEvents++;
      report.quality.invalidUsageEvents++;
    }
  }

  if (messageOrder.length > 0) {
    report.agentSteps = stepCount;
    report.quality.stepEstimation = "exact"; // message.id provides identity
  }
  report.quality.totalEvents = events.length;
  report.quality.isComplete =
    report.quality.malformedEvents === 0 &&
    report.quality.invalidUsageEvents === 0 &&
    report.usage.totalInputTokens !== null;
  return report;
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

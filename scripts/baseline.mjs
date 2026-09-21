/**
 * Offline baseline report generator.
 *
 * - Cross-file event dedup before aggregation
 * - events.jsonl correlation for runtime metrics and outcome
 * - Outcome-based stats (only succeeded requests with observed usage)
 * - Privacy-safe output: allowlisted counts only
 * - Synthetic metadata from fixtures or CLI flag
 * - JSON and JSONL input
 * - No network calls, no model invocations
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── Stat helpers ────────────────────────────────────────────────────
function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  const m = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}
function p95(sorted) {
  if (!sorted.length) return 0;
  return sorted[
    Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1)
  ];
}
function numericSummary(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    min: s[0],
    max: s[s.length - 1],
    median: median(s),
    p95: p95(s),
    sum: s.reduce((a, b) => a + b, 0),
  };
}

// ── Events.jsonl correlation ────────────────────────────────────────
function parseEventsJsonl(content) {
  const events = [];
  for (const line of content.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const e = JSON.parse(l);
      if (e && typeof e === "object") events.push(e);
    } catch {
      /* skip */
    }
  }
  return events;
}

export function extractRuntimeMetrics(eventsContent, runIdFilter) {
  const events = parseEventsJsonl(eventsContent);
  const filtered = runIdFilter
    ? events.filter((e) => e.run_id === runIdFilter)
    : events;
  if (!filtered.length) return null;
  const runId = filtered[0].run_id || runIdFilter || null;
  let workerCalls = 0,
    gatesFirst = 0,
    gatesFinal = 0,
    gatesTotal = 0;
  let fetchCount = null,
    fetchBytes = null,
    rawDigestBytes = null,
    rawDigestTokens = null,
    responseBytes = null;
  let durationMs = null,
    runStatus = null;
  for (const e of filtered) {
    const t = e.event_type;
    if (t === "task_complete") workerCalls++;
    if (t === "gate_complete") {
      gatesTotal++;
      const attempt = typeof e.attempt === "number" ? e.attempt : 1;
      if (attempt === 1 && e.status === "passed") gatesFirst++;
      if (e.status === "passed") gatesFinal++;
    }
    if (t === "run_finish") {
      durationMs = e.duration_ms ?? null;
      runStatus = e.status ?? null;
    }
    if (e.metrics) {
      if (typeof e.metrics.fetch_count === "number")
        fetchCount = (fetchCount ?? 0) + e.metrics.fetch_count;
      if (typeof e.metrics.fetch_bytes === "number")
        fetchBytes = (fetchBytes ?? 0) + e.metrics.fetch_bytes;
      if (typeof e.metrics.raw_output_bytes === "number")
        rawDigestBytes = e.metrics.raw_output_bytes;
      if (typeof e.metrics.digest_tokens_estimated === "number")
        rawDigestTokens = e.metrics.digest_tokens_estimated;
      if (typeof e.metrics.response_bytes === "number")
        responseBytes = e.metrics.response_bytes;
    }
  }
  return {
    runId,
    workerCalls: workerCalls || null,
    gatesFirstPassCount: gatesFirst || null,
    gatesFinalPassCount: gatesFinal || null,
    gatesTotal: gatesTotal || null,
    fetchCount,
    fetchBytes,
    rawDigestBytes,
    rawDigestTokens,
    responseBytes,
    durationMs,
  };
}

export function determineOutcome(eventsContent, requestId, runIdMapping) {
  if (!eventsContent)
    return { outcome: "unknown", provenance: { source: "none" } };
  const events = parseEventsJsonl(eventsContent);
  const runId = runIdMapping?.[requestId] ?? null;
  const finishEvents = events.filter(
    (e) => e.event_type === "run_finish" && (!runId || e.run_id === runId),
  );
  if (!finishEvents.length)
    return { outcome: "unknown", provenance: { source: "none" } };
  const last = finishEvents[finishEvents.length - 1];
  const status = last.status;
  if (status === "succeeded")
    return {
      outcome: "succeeded",
      provenance: {
        source: "events_jsonl",
        runId: last.run_id,
        eventType: "run_finish",
      },
    };
  if (status === "failed" || status === "partial")
    return {
      outcome: "failed",
      provenance: {
        source: "events_jsonl",
        runId: last.run_id,
        eventType: "run_finish",
      },
    };
  return {
    outcome: "unknown",
    provenance: {
      source: "events_jsonl",
      runId: last.run_id,
      eventType: "run_finish",
    },
  };
}

// ── Cross-file dedup ────────────────────────────────────────────────
function deduplicateEvents(allEvents) {
  const seen = new Map(); // identityKey -> last event
  const result = [];
  for (const pe of allEvents) {
    if (pe.identityKey !== null) {
      if (seen.has(pe.identityKey)) {
        // Replace with latest (for Claude streaming final updates)
        const idx = seen.get(pe.identityKey);
        result[idx] = pe;
        continue;
      }
      seen.set(pe.identityKey, result.length);
    }
    result.push(pe);
  }
  return result.filter(Boolean);
}

// ── Main export ─────────────────────────────────────────────────────
export async function generateBaselineReport(tracesDir, hostType, opts = {}) {
  const {
    variant = "A",
    comparableGroup = "default",
    isSynthetic = true,
    outPath = null,
    eventsPath = null,
    runIdMapping = null,
  } = opts;
  if (!["A", "B", "C", "D"].includes(variant))
    throw new Error(`Invalid variant label. Expected A, B, C, or D.`);

  let extractEvents, parseEvents;
  try {
    if (hostType === "codex") {
      const mod = await import("../dist/telemetry/host-adapters/codex.js");
      extractEvents = mod.extractCodexEvents;
      parseEvents = mod.parseCodexEvents;
    } else if (hostType === "claude-code") {
      const mod =
        await import("../dist/telemetry/host-adapters/claude-code.js");
      extractEvents = mod.extractClaudeEvents;
      parseEvents = mod.parseClaudeEvents;
    } else {
      throw new Error(`Unsupported host type.`);
    }
  } catch (err) {
    throw new Error(
      `Failed to load ${hostType} adapter. Ensure project is built.`,
    );
  }

  const entries = fs
    .readdirSync(tracesDir)
    .filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
  const traceFiles = entries.filter((f) => {
    // Exclude own output files on repeat invocation
    if (
      outPath &&
      path.resolve(path.join(tracesDir, f)) === path.resolve(outPath)
    )
      return false;
    return true;
  });
  if (!traceFiles.length)
    throw new Error("No .jsonl or .json trace files found in directory.");

  // Extract and check host compatibility
  const allEvents = [];
  let hasHostEvents = false;
  for (const f of traceFiles) {
    const content = fs.readFileSync(path.join(tracesDir, f), "utf8");
    const events = extractEvents(content);
    // Check if file has events that look like this host type
    const hasRelevant = events.some((e) => {
      if (Object.keys(e.event).length === 0) return false;
      if (hostType === "codex")
        return e.event.payload && typeof e.event.payload.type === "string";
      if (hostType === "claude-code")
        return e.event.message && typeof e.event.message.id === "string";
      return false;
    });
    if (hasRelevant) hasHostEvents = true;
    allEvents.push(...events);
  }
  if (
    !hasHostEvents &&
    allEvents.some((e) => Object.keys(e.event).length > 0)
  ) {
    throw new Error(
      "No events matching specified host type found. Check host parameter.",
    );
  }

  // Cross-file dedup
  const deduped = deduplicateEvents(allEvents);
  const result = parseEvents(deduped);

  // Synthetic detection from fixtures
  const fixturesSynthetic = deduped.some((e) => e.event._synthetic === true);
  const effectiveSynthetic = isSynthetic || fixturesSynthetic;

  // Events.jsonl correlation
  let eventsContent = null;
  if (eventsPath && fs.existsSync(eventsPath)) {
    eventsContent = fs.readFileSync(eventsPath, "utf8");
  }
  const runtime = eventsContent
    ? extractRuntimeMetrics(eventsContent, null)
    : null;

  // Apply outcomes
  for (const req of result.requests) {
    if (opts.outcomes && req.requestId && opts.outcomes[req.requestId]) {
      const o = opts.outcomes[req.requestId];
      req.outcome = o.outcome || "unknown";
      req.outcomeProvenance = { source: "annotation" };
    } else if (eventsContent && req.requestId) {
      const o = determineOutcome(eventsContent, req.requestId, runIdMapping);
      req.outcome = o.outcome;
      req.outcomeProvenance = o.provenance;
    }
  }

  // Sanitize
  const sanitized = result.requests.map(sanitizeReport);

  // Outcome stats
  const outcomeStats = {
    total: sanitized.length,
    succeeded: 0,
    failed: 0,
    unknown: 0,
  };
  for (const r of sanitized) {
    outcomeStats[r.outcome]++;
  }

  // Stats: only succeeded/non-failed with observed usage
  const succeededWithUsage = sanitized.filter(
    (r) => r.outcome !== "failed" && r.usage.totalInputTokens !== null,
  );
  const failedCount = sanitized.filter((r) => r.outcome === "failed").length;
  const unknownCount = sanitized.filter((r) => r.outcome === "unknown").length;
  const missingUsage = sanitized.filter(
    (r) => r.outcome === "succeeded" && r.usage.totalInputTokens === null,
  ).length;
  const stats =
    succeededWithUsage.length > 0
      ? {
          n: succeededWithUsage.length,
          excluded: sanitized.length - succeededWithUsage.length,
          excludedReasons: {
            failedOutcome: failedCount,
            unknownOutcome: unknownCount,
            missingUsage,
          },
          totalInputTokens: numericSummary(
            succeededWithUsage
              .map((r) => r.usage.totalInputTokens)
              .filter((v) => v !== null),
          ),
          freshInputTokens: numericSummary(
            succeededWithUsage
              .map((r) => r.usage.freshInputTokens)
              .filter((v) => v !== null),
          ),
          outputTokens: numericSummary(
            succeededWithUsage
              .map((r) => r.usage.outputTokens)
              .filter((v) => v !== null),
          ),
          agentSteps: numericSummary(
            succeededWithUsage
              .map((r) => r.agentSteps)
              .filter((v) => v !== null),
          ),
        }
      : null;

  const report = {
    version: "1",
    hostType,
    variant,
    comparableGroup,
    isSynthetic: effectiveSynthetic,
    requests: sanitized,
    runtime,
    stats,
    outcomeStats,
    quality: {
      totalEvents: result.quality.totalEvents,
      malformedEvents: result.quality.malformedEvents,
      invalidUsageEvents: result.quality.invalidUsageEvents,
      isComplete:
        result.quality.isComplete && result.quality.malformedEvents === 0,
      stepEstimation: result.quality.stepEstimation,
    },
  };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}

function sanitizeReport(r) {
  return {
    requestId: r.requestId,
    usage: {
      totalInputTokens: r.usage.totalInputTokens,
      cachedInputTokens: r.usage.cachedInputTokens,
      freshInputTokens: r.usage.freshInputTokens,
      outputTokens: r.usage.outputTokens,
      reasoningOutputTokens: r.usage.reasoningOutputTokens,
    },
    agentSteps: r.agentSteps,
    compactionCount: r.compactionCount,
    quality: {
      totalEvents: r.quality.totalEvents,
      malformedEvents: r.quality.malformedEvents,
      invalidUsageEvents: r.quality.invalidUsageEvents,
      isComplete: r.quality.isComplete,
      stepEstimation: r.quality.stepEstimation,
    },
    outcome: r.outcome,
    outcomeProvenance: r.outcomeProvenance,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  const kv = {};
  const pos = [];
  for (const a of args) {
    const i = a.indexOf("=");
    if (i > 0) kv[a.slice(0, i)] = a.slice(i + 1);
    else pos.push(a);
  }
  const tracesDir = pos[0] || kv["traces"];
  const hostType = pos[1] || kv["host"];
  const outPath = pos[2] || kv["out"];
  if (!tracesDir || !hostType || !outPath) {
    process.stderr.write(
      "Usage: node baseline.mjs <tracesDir> <hostType> <outPath> [variant=A] [group=default] [synthetic=true] [events=path]\n",
    );
    process.exit(1);
  }
  generateBaselineReport(tracesDir, hostType, {
    variant: kv["variant"] || "A",
    comparableGroup: kv["group"] || "default",
    isSynthetic: kv["synthetic"] !== "false",
    outPath,
    eventsPath: kv["events"] || null,
  })
    .then(() => {
      process.stderr.write("Report generated.\n");
    })
    .catch(() => {
      process.stderr.write("Fatal: failed to generate report.\n");
      process.exit(2);
    });
}

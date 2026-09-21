/**
 * Offline A-B comparison for matched engineering request groups.
 *
 * - Requires A/B/C/D labels with matching comparableGroup and hostType
 * - Compares only common case IDs across all variants
 * - Per-succeeded-request metrics (outcome must be 'succeeded')
 * - Reports unmatched/excluded counts per variant
 * - Warns on synthetic, small N; rejects incompatible groups/hosts
 * - No network calls, no model invocations
 */
import fs from "fs";
import { fileURLToPath } from "url";

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

const VALID_LABELS = new Set(["A", "B", "C", "D"]);

export function compareRuns(variantReports) {
  const labels = Object.keys(variantReports);
  if (labels.length < 2)
    throw new Error("At least 2 variant reports are required for comparison.");
  for (const l of labels) {
    if (!VALID_LABELS.has(l))
      throw new Error(`Invalid variant label '${l}'. Expected A, B, C, or D.`);
  }

  // Validate report schema basics
  for (const l of labels) {
    const r = variantReports[l];
    if (!r || typeof r !== "object")
      throw new Error(`Variant ${l} report is invalid.`);
    if (r.variant !== undefined && r.variant !== l)
      throw new Error(
        `Variant ${l} report has mismatched variant label '${r.variant}'.`,
      );
  }

  const warnings = [];

  // Group/host compatibility
  const groups = new Set(
    labels.map((l) => variantReports[l].comparableGroup || "default"),
  );
  if (groups.size > 1) {
    warnings.push(
      `Mismatched comparableGroup across variants: ${[...groups].join(", ")}.`,
    );
  }
  const hosts = new Set(
    labels.map((l) => variantReports[l].hostType).filter(Boolean),
  );
  if (hosts.size > 1)
    throw new Error(
      `Incompatible hostType across variants: ${[...hosts].join(", ")}. Cannot compare.`,
    );

  const group = [...groups][0];
  const hostType = [...hosts][0] || "unknown";

  // Find matched case IDs (requestId present in ALL variants)
  const caseIdsByVariant = {};
  for (const l of labels) {
    const reqs = variantReports[l].requests || [];
    caseIdsByVariant[l] = new Set(
      reqs.filter((r) => r.requestId !== null).map((r) => r.requestId),
    );
  }
  const allCaseIds = [...caseIdsByVariant[labels[0]]];
  const matchedCaseIds = allCaseIds.filter((id) =>
    labels.every((l) => caseIdsByVariant[l].has(id)),
  );

  if (!matchedCaseIds.length) {
    warnings.push(
      "No common request IDs across all variants. No matched comparison possible.",
    );
  }

  for (const l of labels) {
    const unmatched =
      caseIdsByVariant[l].size -
      matchedCaseIds.filter((id) => caseIdsByVariant[l].has(id)).length;
    if (unmatched > 0)
      warnings.push(
        `Variant ${l}: ${unmatched} request(s) not matched across all variants, excluded from comparison.`,
      );
  }

  // Build per-variant summaries
  const variants = {};
  for (const l of labels) {
    const report = variantReports[l];
    const allReqs = report.requests || [];

    const outcomeStats = {
      total: allReqs.length,
      succeeded: 0,
      failed: 0,
      unknown: 0,
    };
    for (const r of allReqs) outcomeStats[r.outcome || "unknown"]++;

    // Only successful requests with observed usage for metrics
    const successfulReqs = allReqs.filter(
      (r) =>
        r.outcome !== "failed" && r.usage && r.usage.totalInputTokens !== null,
    );
    const excluded = allReqs.length - successfulReqs.length;

    const reqMetrics = {
      totalInputTokens: numericSummary(
        successfulReqs
          .map((r) => r.usage.totalInputTokens)
          .filter((v) => v !== null),
      ),
      freshInputTokens: numericSummary(
        successfulReqs
          .map((r) => r.usage.freshInputTokens)
          .filter((v) => v !== null),
      ),
      outputTokens: numericSummary(
        successfulReqs
          .map((r) => r.usage.outputTokens)
          .filter((v) => v !== null),
      ),
      agentSteps: numericSummary(
        successfulReqs.map((r) => r.agentSteps).filter((v) => v !== null),
      ),
    };

    variants[l] = {
      n: successfulReqs.length,
      excluded,
      isSynthetic: report.isSynthetic ?? true,
      outcomeStats,
      perSuccessfulRequest: reqMetrics,
      perSucceededRequest: reqMetrics,
    };

    if (report.isSynthetic)
      warnings.push(
        `Variant ${l} uses synthetic data. Do not claim performance improvement.`,
      );
    if (successfulReqs.length < 20)
      warnings.push(
        `Variant ${l} has only ${successfulReqs.length} succeeded matched requests (minimum recommended: 20).`,
      );
  }

  const sampleSizes = new Set(labels.map((l) => variants[l].n));
  if (sampleSizes.size > 1) {
    warnings.push(
      `Unequal sample sizes across variants: ${labels.map((l) => `${l}=${variants[l].n}`).join(", ")}.`,
    );
  }

  return {
    comparableGroup: group,
    hostType,
    matchedCaseIds,
    variants,
    warnings,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    process.stderr.write(
      "Usage: node compare-runs.mjs A=reportA.json B=reportB.json\n",
    );
    process.exit(1);
  }
  const reports = {};
  for (const arg of args) {
    const i = arg.indexOf("=");
    if (i === -1) {
      process.stderr.write("Fatal: invalid argument format.\n");
      process.exit(2);
    }
    const label = arg.slice(0, i);
    const fp = arg.slice(i + 1);
    if (!VALID_LABELS.has(label)) {
      process.stderr.write(`Fatal: invalid variant label.\n`);
      process.exit(2);
    }
    try {
      reports[label] = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      process.stderr.write(
        `Fatal: could not load report for variant ${label}.\n`,
      );
      process.exit(2);
    }
  }
  try {
    process.stdout.write(JSON.stringify(compareRuns(reports), null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(2);
  }
}

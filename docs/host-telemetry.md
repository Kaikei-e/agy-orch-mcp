# Host Telemetry

Host telemetry adapters normalize token usage logs from different hosts (Codex and Claude Code) into a unified `HostUsageReport` structure for offline analysis and A-B comparison.

## Architecture

```
test/fixtures/host-traces/*.jsonl   ─→  parseCodexTrace() / parseClaudeCodeTrace()
                                         │
                                         ▼
                                    TraceParseResult { requests: HostUsageReport[] }
                                         │
                                         ▼
                                    scripts/baseline.mjs  ─→  BaselineReport (JSON)
                                         │
                                         ▼
                                    scripts/compare-runs.mjs ─→ ComparisonResult (JSON)
```

## Key Design Decisions

### Null vs Zero Semantics

All numeric usage fields use `null` to represent **"unknown / not observed / absent"**. An observed `0` is a meaningful value (e.g., zero cached tokens) distinct from absence. Parsers never silently default missing fields to `0`.

### Compaction Detection

Compactions are recorded **only** when explicit boundary markers are present in logs:

- **Codex**: `type: "compaction"` or `payload.type: "compaction"` / `"compacted"`
- **Claude Code**: `type: "compact_boundary"` / `"compaction"` or `marker: "compaction"` / `"compact_boundary"`

We **never** infer compaction from falling input token counts — this is not sufficient evidence.

### Token Semantics

- **Codex**: Parsed from `payload.type === "token_count"`. Uses `info.last_token_usage` per-step or `info.total_token_usage` cumulative snapshots with delta extraction. `freshInputTokens = totalInputTokens - cachedInputTokens`.
- **Claude Code**: Parsed from `message.usage`. `totalInputTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. `cachedInputTokens = cache_read_input_tokens`. `freshInputTokens = input_tokens + cache_creation_input_tokens`. Streaming events are deduplicated by `message.id` — the **latest** event per ID wins (final streaming update has authoritative usage).

### Validation

All token counts are validated as non-negative integers. `cached_input_tokens > input_tokens` is rejected. Present-but-invalid numeric fields (negative, non-integer) cause the entire usage record to be rejected and tracked in `quality.invalidUsageEvents`.

### Multi-Request Grouping

A single trace file may contain events for multiple engineering requests (grouped by `request_id`). The same `request_id` may span multiple files; the baseline script merges them. Files are **never** counted as requests.

### Privacy & Redaction

Parsers output **only** allowlisted numeric aggregates:

- Token counts, agent steps, compaction counts, request IDs
- Quality metrics (malformed/invalid event counts)

They **never** copy raw prompts, source code, file paths, error stacks, or log content into output. Fixture filenames are not included in reports.

## Usage

### Generate Baseline Report

```bash
# Codex traces
node scripts/baseline.mjs test/fixtures/host-traces/ codex report.json variant=A group=batch-1 synthetic=true

# Claude Code traces
node scripts/baseline.mjs test/fixtures/host-traces/ claude-code report.json variant=B group=batch-1
```

Options (key=value after positional args):

- `variant` — Label: A, B, C, or D (default: A)
- `group` — Comparable group ID for matched comparisons (default: "default")
- `synthetic` — Whether fixtures are synthetic (default: true)

### Compare Variants

```bash
node scripts/compare-runs.mjs A=report-legacy.json B=report-parallel.json C=report-repair.json
```

Requires exactly labels A/B/C/D. Produces warnings for:

- Mismatched comparable groups
- Synthetic fixture data
- Unequal successful request counts
- Sample sizes below 20

### Report Structure

```json
{
  "version": "1",
  "hostType": "codex",
  "variant": "A",
  "comparableGroup": "batch-1",
  "isSynthetic": true,
  "requests": [
    {
      "requestId": "req_001",
      "usage": {
        "totalInputTokens": 1500,
        "cachedInputTokens": 1000,
        "freshInputTokens": 500,
        "outputTokens": 100,
        "reasoningOutputTokens": 20
      },
      "agentSteps": 2,
      "compactionCount": 1,
      "quality": {
        "totalEvents": 4,
        "malformedEvents": 0,
        "invalidUsageEvents": 0,
        "isComplete": true
      }
    }
  ],
  "stats": {
    "n": 1,
    "excluded": 0,
    "totalInputTokens": {
      "min": 1500,
      "max": 1500,
      "median": 1500,
      "p95": 1500,
      "sum": 1500
    }
  }
}
```

## Fixtures

All test fixtures in `test/fixtures/host-traces/` are **prominently labeled synthetic** (`_synthetic: true`, `_label: "SYNTHETIC FIXTURE"`). 20+20 real host rollout traces remain pending.

## Remaining Gaps

- Real host rollout fixtures (20 Codex + 20 Claude Code) not yet available
- `events.jsonl` correlation with agy-orch run events pending foundation integration
- Worker/gate/fetch/raw-digest/walltime metrics require foundation runtime hooks
- CLI entrypoints need integration testing with actual `pnpm build` output (currently blocked by foundation TS errors in `src/artifacts/store.ts`)

# Implementation Status & Handoff — Phase 0–5 Integration

> Updated: 2026-09-22
> Process coordination: Source and execution state are fully consolidated on the active runtime. Competing writers halted.
> Status: Phase 0–5 batch, runtime, workers, gates, workspace isolation, digest trimming, immutable SHA resolution, telemetry logger, and MCP facade are **COMPLETE**. All 209 automated tests pass cleanly. Test verification log written to `/tmp/agy-final-verification.log`.

---

## 1. Verification & Test Metrics

- **Static analysis & build**:
  - `pnpm check`: Passed (clean `tsc --noEmit`, zero errors).
  - `pnpm build`: Passed (clean compilation of all modules into `dist/`).
  - `git diff --check`: Passed (clean, zero trailing whitespace or conflict markers).
- **Full test suite passes observed (`pnpm test` / `node --test test/*.test.mjs`)**:
  - Total tests: **209 / 209 passed**, 0 failed, 0 cancelled, 0 skipped.
  - Runtime scheduler & budget suites (`test/scheduler.test.mjs`, `test/runtime-budget-and-repair.test.mjs`): 20/20 pass (including immutable SHA freeze across branch advancement, request/plan/events selectors, secret redaction, and baseline telemetry consumption).
  - Worker adapters, raw stdout fidelity & routing (`test/workers.test.mjs`): 15/15 pass (including physical CLI stdout preservation with stream-json envelopes, diagnostic stderr capture, and strict omission of rawStdout from legacy MCP tool results).
  - Workspace management & isolation (`test/workspace.test.mjs`): 10/10 pass.
  - Gates & execution runner (`test/gates.test.mjs`): 10/10 pass.
  - Artifact store & safety (`test/artifacts.test.mjs`, `test/artifacts-safety.test.mjs`): 22/22 pass.
  - MCP Batch & Fetch E2E (`test/mcp_batch.test.mjs`, `test/mcp_fetch.test.mjs`): 10/10 pass.
  - Foundation safety & regressions (`test/foundation-safety.test.mjs`, `test/foundation-regressions.test.mjs`): 30/30 pass.
  - Host telemetry adapters & baseline (`test/host-adapters.test.mjs`, `test/baseline.test.mjs`): 40/40 pass.
  - Config, DAG, retention, redaction, policy: 52/52 pass (including dead-owner task interruption, live-owner protection, and zero-spawn assertion).

---

## 2. Architecture & Design Decisions

1. **Artifact-Only `final.patch`**:
   - `antigravity_batch` never writes changes directly to the host working tree.
   - Tasks execute within isolated Git worktrees. Validated changes are integrated into an integration worktree and published exclusively as an artifact (`final.patch`), leaving the working directory untouched.
2. **Clean Git Workspace Requirement**:
   - `workspace.dirty_policy` is `"reject"`. The target workspace must have no uncommitted changes; dirty trees fail preflight with an actionable error.
   - The previously proposed `"snapshot"` policy was removed from the schema and domain models.
3. **Ownership vs. Reference Scope**:
   - `task.owns` defines the strictly exclusive file patterns a worker is permitted to modify (`owns ⊆ scope.include` and `owns ∩ scope.exclude = ∅`). Trailing-slash directories (e.g. `dir/`) are normalized to `dir/**`.
   - `scope.include` defines the broader read/reference visibility granted to the task.
4. **No OS Sandbox Boundary Claim**:
   - Process containment relies on application-level Git worktrees, static path validations, and command allowlists. It provides defense-in-depth orchestration hygiene, **not** an OS-level security or virtualization boundary.
5. **Gate Command Specifications**:
   - `gate.command` requires an explicit argv array (`string[]`), never an unparsed shell command string, preventing shell injection and unmonitored subshells.
   - `GateRunner.runGate` supports typed `signal?: AbortSignal` (6th argument) and terminates process groups promptly upon cancellation without false-passed gates.
6. **Bounded Recovery, Budgets & Clamping**:
   - Execution loops are bounded by `budget.max_worker_calls` (default 50), `max_repair_attempts` (default 3), `max_replans` (default 2), and a strict `wall_time_ms` deadline (default 7,200,000ms / 2h). Over-limit budget values are automatically clamped and reported via `budget_adjustments`. Long batches emit progress heartbeats when a progressToken is supplied.
7. **Safe Fetch Pointers**:
   - `antigravity_fetch` retrieves structured slices of prior run artifacts using logical selectors (`task:<id>:stdout`, `task:<id>:stderr`, `gate:<id>:stdout`, `gate:<id>:stderr`, `manifest`, `digest`) or internal artifact IDs with cursor-based pagination (`byte_offset`). Raw filesystem paths are never accepted.
8. **Preflight Token Budget Capacity & Envelope Trimming**:
   - Upfront preflight capacity validation rejects impossible `max_tokens` before any worker spawn, store initialization, or worktree creation.
   - Deterministic trimmer accounts for the entire MCP `CallToolResult` envelope (`content` + `structuredContent` + `isError`) using `estimateTokenCount`.
   - `CAPACITY_EXCEEDED` errors preserve the `run_id` and `recovery_pointer`.
9. **Opt-In Surface & Model Routing**:
   - Legacy tools (`antigravity_run`, `antigravity_continue`, `antigravity_models`) remain default.
   - Batch and fetch features are strictly opt-in via `AGY_MCP_ENABLE_BATCH=true` and `AGY_MCP_ENABLE_FETCH=true`.
   - `AGY_MCP_TOOL_SURFACE=batch` exposes a minimal tool surface (`antigravity_batch`, `antigravity_fetch`) to conserve client context windows.
10. **Raw CLI Stdout Fidelity in Batch Worker Artifacts**:
    - `WorkerExecutionResult` preserves physical raw CLI stdout (including stream-json events, metadata envelopes, and trailing newlines) and stderr for artifact logging, while parsed `runResult.response` continues to drive failure classification and legacy tool responses.
    - Legacy `toToolResult` strictly omits internal `rawStdout` from both text and structured content, guaranteeing zero leakage to standard MCP clients.

---

## 3. Explicit Notes on Unimplemented & Open Items

1. **Phase 6 Semantic Compressor**:
   - Marked as **OPTIONAL** in the design draft and is **NOT IMPLEMENTED**. Progressive deterministic shedding in `src/digest/deterministic.ts` provides complete token budget containment without LLM-based summary compression.
2. **Phase 7 Operational Milestone (20+20 Real Host Traces)**:
   - Live telemetry collection of 20 Codex and 20 Claude Code production rollout runs is **NOT RUN**. Synthetic fixtures (`_synthetic: true`) validate parser mechanics, but real-world operational benchmarks have not been executed.

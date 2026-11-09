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
6. **Bounded Recovery, Budgets, Clamping & 15-Minute Resumable Turn Cap**:
   - Individual `antigravity_run` / `antigravity_continue` turns are capped at 15 minutes (`timeout_seconds` default and max `900`). `agy` ends the turn itself via `--print-timeout <N>s`, and the bridge hard-kills the process tree 60 seconds later. A cut-off turn returns `status: "TIMEOUT"` with `resumable: true`, `conversation_id`, `partial_response`, `verified_outputs`, `workspace_changes`, `terminated_tasks`, and `turn_seconds` (`duration_seconds` from `agy` is cumulative per conversation; `turn_seconds` is this turn).
   - Batch execution loops are bounded by `budget.max_worker_calls` (default 50), `max_repair_attempts` (default 3), `max_replans` (default 2), and a strict `wall_time_ms` deadline (default 7,200,000ms / 2h). Per-turn batch worker timeout is capped at `900,000` ms (15 min); a worker turn that hits the cap is resumed automatically in the same worktree and conversation with a bridge-written resume prompt, counted against `max_worker_calls`. Effort-suffixed model slugs (e.g. `gemini-4-argon-high`) are resolved without passing a conflicting `--effort low` flag. Over-limit budget values are automatically clamped and reported via `budget_adjustments`. Long batches emit progress heartbeats when a `progressToken` is supplied.
7. **Safe Fetch Pointers & Shortened Response Navigation**:
   - `antigravity_fetch` retrieves structured slices of prior run artifacts using logical selectors (`task:<id>:stdout`, `task:<id>:stderr`, `task:<id>:patch`, `gate:<id>:stdout`, `gate:<id>:stderr`, `manifest`, `digest`, `request`, `plan`, `events`) or internal artifact IDs with cursor-based pagination (`byte_offset`). Raw filesystem paths are never accepted.
   - When a legacy run/continue response exceeds `AGY_MCP_MAX_OUTPUT_CHARS`, the full text is saved to `response_artifact.path` and accompanied by `response_outline` (Markdown heading levels and `start_line`–`end_line` ranges) and a `resource_link` content item (`file://` URI to `response.txt`).
8. **Preflight Token Budget Capacity & Envelope Trimming**:
   - Upfront preflight capacity validation rejects impossible `max_tokens` before any worker spawn, store initialization, or worktree creation.
   - Deterministic trimmer accounts for the entire MCP `CallToolResult` envelope (`content` + `structuredContent` + `isError`) using `estimateTokenCount`.
   - `CAPACITY_EXCEEDED` errors preserve the `run_id` and `recovery_pointer`.
9. **Opt-In Surface, Parallelism, Queueing & MCP Tasks**:
   - Legacy tools (`antigravity_run`, `antigravity_continue`, `antigravity_models`) remain default; batch and fetch features are opt-in via `AGY_MCP_ENABLE_BATCH=true` and `AGY_MCP_ENABLE_FETCH=true` (or `AGY_MCP_TOOL_SURFACE=batch`).
   - Tools advertise `readOnlyHint: true` and `destructiveHint: false` so Claude Code runs multiple calls in one message in parallel without relay subagents (and auto-backgrounds calls running longer than 2 minutes via `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`).
   - `queue_timeout_seconds` (`0`–`900`) waits in a FIFO queue with position progress notifications (`queue_wait_seconds` in result) instead of returning `BUSY`.
   - MCP Tasks extension (`io.modelcontextprotocol/tasks`, revision `2026-07-28`) is enabled by default (`AGY_MCP_TASKS=auto`; `AGY_MCP_TASKS=off` disables); clients advertising it receive a task handle and poll `tasks/get` (verified with SDK clients in tests; Claude Code documents support from v2.1.304 for main-conversation calls).
10. **Machine-Extracted Evidence, Structured Handoffs & CLI Capture Fidelity**:
    - `StreamLedger` extracts `verified_outputs` (`command`, `status` `completed` | `failed` | `denied` | `background` | `running`, `exit_code`, `output_tail`, `error`, `full_output_path`, `background_task_id`, `duration_seconds`) from the `agy` JSON stream so hosts can verify command execution without trusting model prose. `denied_commands` merges stream and transcript denials, including denials that only appear as the last tool call in `PLANNER_RESPONSE`.
    - `return_mode: "structured"` passes `--json-schema` (`src/handoff-schema.ts`) and returns a parsed `handoff` object alongside `response`.
    - `WorkerExecutionResult` preserves physical raw CLI stdout and stderr for batch artifact logging, while `toToolResult` strictly omits `rawStdout` from legacy MCP tool outputs.
11. **Command Guard, Fixed Deny Rules, Preflight Warnings & Environment Isolation**:
    - `agy-orch-mcp --install-guard` installs an env-gated (`AGY_ORCH_MCP_GUARD=1`) `PreToolUse` hook (`agy-orch-mcp-guard`) in `~/.gemini/config/hooks.json` (`--uninstall-guard` removes it; `AGY_MCP_GUARD=off` disables). It denies remote-changing `git`/`gh` commands (including via `sh -c`, `xargs`, `env` wrappers) and unquoted redirection/command substitution with actionable reasons, and returns `deny_unless_prior_grant` for everything else (never `"ask"`, which headless `agy` auto-approves; empty output abstains when `AGY_ORCH_MCP_GUARD` is unset). Fixed deny rules are also passed via `--settings`. `--doctor` reports guard status and a permissions audit (`high`/`medium`/`low`), and turns emit `preflight_warnings` for prompt commands that would be denied or when the guard hook is missing.
    - `AGY_MCP_ENV_ISOLATION=full` (default) | `install` | `off` creates one directory per conversation under `AGY_MCP_ENV_ROOT` (`<XDG_STATE_HOME or ~/.local/state>/agy-orch/env`), reused on `continue`, pruned after 24h at startup, with polling enabled for file watchers (`CHOKIDAR_USEPOLLING=1`, `WATCHPACK_POLLING=true`).

---

## 3. Explicit Notes on Unimplemented & Open Items

1. **Phase 6 Semantic Compressor**:
   - Marked as **OPTIONAL** in the design draft and is **NOT IMPLEMENTED**. Progressive deterministic shedding in `src/digest/deterministic.ts` provides complete token budget containment without LLM-based summary compression.
2. **Phase 7 Operational Milestone (20+20 Real Host Traces)**:
   - Live telemetry collection of 20 Codex and 20 Claude Code production rollout runs is **NOT RUN**. Synthetic fixtures (`_synthetic: true`) validate parser mechanics, but real-world operational benchmarks have not been executed.

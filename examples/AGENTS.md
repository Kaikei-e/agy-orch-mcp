# Agent Delegation Policy (agy-first)

This repository adopts an **agy-first** execution model: an external frontier AI assistant (such as Codex CLI/IDE or Claude Code) acts as the high-level orchestrator, while the Google Antigravity CLI (`agy` via `agy-orch-mcp`) serves as the primary execution engine.

## Roles & Responsibilities

- **Host Frontier Orchestrator**:
  - Decomposes high-level objectives into well-bounded task packets planned as `<= 15`-minute resumable turns.
  - Reviews final diffs (`git diff`) and the machine-extracted `verified_outputs` command ledger returned by `agy-orch-mcp` rather than relying on commands quoted in the model's prose Evidence.
  - Avoids performing repository exploration, web search, or code editing directly when agy delegation is configured.

- **Antigravity CLI Worker**:
  - Receives delegated tasks via `antigravity_run` or `antigravity_continue`.
  - Performs repository exploration, web search, code modifications, and test execution directly within its workspace.
  - **No Recursive Delegation**: A worker executing a delegated task must complete the task using native tools and MUST NOT recursively invoke `agy-orch-mcp` or delegate back to the host.

## Task Packet Specification

When delegating a task to `antigravity_run`, scope each turn to `<= 15` minutes (`timeout_seconds` default and max `900`) and structure the prompt with:

1. **Goal**: Clear objective and success definition.
2. **File Scope & Ownership**: Explicit list of files to edit, files to read-only, and files to avoid touching.
3. **Constraints & Acceptance Criteria**: Code conventions, required test commands, and quality requirements. Because the `agy-orch-mcp` command guard hook returns actionable hints when denying shell constructs, packets no longer need long lists of forbidden shell characters—keep only the "one simple command per call" advice.
4. **Expected Compact Handoff**: Request modified file paths, relevant reference URLs and facts, and any remaining blockers (or set `return_mode: "structured"` for a parsed `handoff` object). Trust `verified_outputs` for command execution evidence.

## Execution & Recovery Guidelines

- **Guard Installation**: Install the command guard and subagent model hook once via `agy-orch-mcp --install-guard` and check status with `agy-orch-mcp --doctor` (built-in defaults: `AGY_MCP_DEFAULT_MODEL=gemini-4-hydrogen-high`, `AGY_MCP_REASONING_MODEL=gemini-4-carbon-high`, `AGY_MCP_SUBAGENT_MODEL=gemini-4-argon-medium`).
- **Self-Testing**: Workers must run project test suites and resolve issues within the agy session before completing.
- **Continuation**: Use `antigravity_continue` (with the required `conversation_id`) only for direct follow-ups to the same conversation or to resume a `TIMEOUT` turn. Start every independent task with a new `antigravity_run` (including when `context.rotate_recommended` is `true`).
- **Choosing a parallel strategy** (by task type, not by host):
  - Parallel code changes: use `antigravity_batch`. Each task runs in an isolated Git worktree with validated `owns`, and results return as `final.patch`, so tasks cannot collide in the workspace. Per-turn worker timeouts are capped at 900,000 ms (15 min) and timed-out turns are resumed automatically in the same worktree and conversation (counted against `max_worker_calls`). Requires a clean Git working tree; budget values exceeding server limits are automatically clamped and reported.
  - Single tasks and direct follow-ups: `antigravity_run`, then `antigravity_continue` with an explicit ID.
  - Parallel read-only investigations or disjoint-scope tasks: issue multiple `antigravity_run` calls (or `antigravity_continue` calls with distinct `conversation_id`s) in a single turn (up to 8 concurrent calls by default; set `queue_timeout_seconds` to wait for a slot instead of `BUSY`).
- **Host parallelism**: `antigravity_run`, `antigravity_continue`, and `antigravity_batch` advertise `readOnlyHint: true` and `destructiveHint: false` in their MCP `ToolAnnotations` so host tool schedulers can dispatch multiple calls concurrently (while server-side safety is enforced via `mode`, `autonomy`, `allowedRoot`, per-conversation locks and isolated environments, and isolated worktrees).
  - Claude Code: maps `annotations.readOnlyHint: true` to `isConcurrencySafe()`, so multiple `antigravity_run` or distinct-ID `antigravity_continue` calls in one assistant message execute in parallel directly. Relay subagents are unnecessary (rebuild `dist` after upgrading so the running server advertises the annotation). Claude Code also moves MCP calls running longer than 2 minutes to the background automatically (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`).
  - Codex CLI / IDE: set `supports_parallel_tool_calls = true` on the MCP server entry in `config.toml` to dispatch multiple tool calls concurrently in a single turn.
- **Concurrency & Queueing**: Overlapping calls with identical conversation IDs immediately return `BUSY`. Calls exceeding capacity return `BUSY` unless `queue_timeout_seconds` (`0`–`900`) is set to wait in the FIFO queue with position progress.
- **Handling BUSY**: Set `queue_timeout_seconds` or wait/reschedule calls serially; do not trigger rapid retry storms.
- **Handling TIMEOUT (15-Minute Turn Cap)**: Turns are capped at 15 minutes (`--print-timeout` + 60s hard-kill) for fast feedback cycles. A cut-off turn returns `status: "TIMEOUT"` with `resumable: true`, `conversation_id`, `partial_response`, `verified_outputs`, `workspace_changes`, `terminated_tasks`, and `turn_seconds` (`duration_seconds` is cumulative per conversation). Continue the task with `antigravity_continue` using the reported state.
- **Handling Empty Responses**: Inspect `workspace_changes` (`git status`) and `partial_response` before re-issuing prompts.
- **Handling Permission Errors**: Inspect `denied_commands` and `workspace_changes`; continue with a named permitted alternative or report concrete blockers directly rather than silently shifting work to the host.

## Local MCP Client Configuration

Do not commit personal, machine-dependent MCP client configuration files (`.mcp.json`, `.codex/`, `.claude/settings.local.json`) to Git. Add them to `.gitignore` and verify with `git check-ignore -v` and `git status --short`.

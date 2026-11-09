# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Machine-extracted `verified_outputs` command ledger (`command`, `status` `completed`/`failed`/`denied`/`background`/`running`, `exit_code`, `output_tail`, `error`, `full_output_path`, `background_task_id`, `duration_seconds`) parsed from the `agy` JSON stream so hosts can verify command execution directly.
- `return_mode: "structured"` on `antigravity_run` and `antigravity_continue`, passing `--json-schema` (`src/handoff-schema.ts`) and returning the parsed `handoff` object (or `handoff_error`) alongside `response`.
- Shortened responses now include `response_outline` (Markdown heading levels and line ranges) in `structuredContent` and a `resource_link` content item (`file://` URI to `response.txt`) alongside `response_artifact`.
- Command guard hook installer (`agy-orch-mcp --install-guard` / `--uninstall-guard`) managing an env-gated `PreToolUse` hook (`agy-orch-mcp-guard`, active only when `AGY_ORCH_MCP_GUARD=1`) in `~/.gemini/config/hooks.json` with timestamped backups, fixed deny rules via `--settings`, `AGY_MCP_GUARD=on|off`, and `--doctor` guard status plus a permissions audit (`high`/`medium`/`low`).
- `preflight_warnings` on non-`full` turns for commands named in the prompt that `permissions.allow` or deny rules would block, plus a warning when the guard hook is not installed.
- Per-conversation environment isolation (`AGY_MCP_ENV_ISOLATION=full|install|off`, default `full`; `AGY_MCP_ENV_ROOT`, default `<XDG_STATE_HOME or ~/.local/state>/agy-orch/env`) reused across `antigravity_continue`, pruned after 24 hours at startup, with file-watcher polling variables (`CHOKIDAR_USEPOLLING=1`, `WATCHPACK_POLLING=true`).
- FIFO slot queueing via `queue_timeout_seconds` (`0`–`900`, default `0`) with queue position progress notifications and `queue_wait_seconds` in the result instead of immediate `BUSY`.
- MCP Tasks extension (`io.modelcontextprotocol/tasks`, revision `2026-07-28`, `tasks/get`, `tasks/cancel`, controlled by `AGY_MCP_TASKS=auto|off`), verified with SDK clients in tests (Claude Code documents support from v2.1.304 for main-conversation calls).
- Automatic in-worktree and in-conversation resume for `antigravity_batch` worker turns that hit the 15-minute (`900,000` ms) per-turn cap, using a bridge-written resume prompt and counting each resumed turn against `budget.max_worker_calls`.
- `PERMISSION_DENIED` results now include `denied_commands`, recovered from the agy stream and conversation transcript, and guidance to continue with a named permitted alternative or extend `permissions.allow`.
- Run/continue results report per-conversation `context` usage and recommend a fresh `antigravity_run` once cumulative tokens exceed `AGY_MCP_CONTEXT_ROTATE_TOKENS` (default 2,000,000).
- Truncated responses are saved in full to the artifact store and referenced by `response_artifact`.
- MCP initialization instructions and tool descriptions providing default delegation guidance for client hosts.
- Configurable default model via `AGY_MCP_DEFAULT_MODEL`, with precedence (per-call `model` argument > `AGY_MCP_DEFAULT_MODEL` > CLI default).
- Bridge error classification converting CLI output with denied actions into `PERMISSION_DENIED` and empty success responses into `EMPTY_RESPONSE`.
- Operational documentation and templates for the **agy-first** delegation policy (`AGENTS.md`, `CLAUDE.md`, `examples/`).
- Documented compact output recommendation (`AGY_MCP_MAX_OUTPUT_CHARS=16000`), client restart instructions, and `--mode` intent semantics under `--disable-slash-commands`.
- Explicit `.gitignore` entries for machine-dependent personal MCP client configuration files (`.mcp.json`, `.codex/`, `.claude/settings.local.json`).
- Initial local MCP bridge for Antigravity CLI runs, conversation continuation, and model listing.
- OSS documentation, contribution guidance, security reporting guidance, a Claude Code configuration example, and continuous integration.
- Codex CLI and IDE stdio configuration guidance, including an example TOML file and timeout settings for long-running tools.
- Configurable parallel CLI execution with `AGY_MCP_MAX_CONCURRENT` (default 8, range 1–32), per-call cancellation, and conversation-ID locks. Set the limit to 1 for the previous serial behavior.

### Changed

- Capped `antigravity_run` and `antigravity_continue` turns at 15 minutes (`timeout_seconds` default and max `900`, passed to `agy` as `--print-timeout` with a 60-second hard-kill grace period) and `antigravity_batch` per-turn worker timeout at `900,000` ms. Cut-off turns return `status: "TIMEOUT"` with `resumable: true`, `conversation_id`, `partial_response`, `verified_outputs`, `workspace_changes`, `terminated_tasks`, and `turn_seconds` (alongside cumulative `duration_seconds`) for continuation via `antigravity_continue`.
- Renamed tool and repository to `agy-orch-mcp`.
- **Breaking:** `antigravity_continue` now requires `conversation_id`. Implicit latest-conversation continuation (`--continue`), which took exclusive access to the server and blocked every other call, has been removed.
- Tool descriptions, MCP `ToolAnnotations` (`readOnlyHint: true`, `destructiveHint: false`), and delegation guidance now enable direct parallel tool execution in both Claude Code (`isConcurrencySafe()`, making relay subagents unnecessary) and OpenAI Codex (`supports_parallel_tool_calls = true`), while routing independent tasks to new `antigravity_run` calls and parallel code changes to `antigravity_batch`.
- Raised default `AGY_MCP_MAX_CONCURRENT` (and default `maxParallelism` cap) from 4 to 8, and set the built-in default model to `gemini-4-argon-high`.
- Scoped `WorktreeManager` session directories by `runId` when `AGY_ORCH_STORAGE_DIR` is configured and serialized per-repository `git worktree` add/remove operations to prevent lock contention during parallel batch execution.
- Elevated `antigravity_batch` server default limits (`maxWallTimeMs = 7_200_000`, `maxWorkerCalls = 50`, `maxParallelism = min(16, AGY_MCP_MAX_CONCURRENT)`).
- Batch budget parameters exceeding server limits are now automatically clamped and surfaced in `budget_adjustments` rather than rejected.
- Structural validation errors in `antigravity_batch` (owns vs. scope containment, DAG cycles, task/gate limits) are now aggregated into a single descriptive message.
- Removed unsupported `"snapshot"` value from `dirty_policy`; only `"reject"` remains.
- Normalized directory patterns ending with a trailing slash (`dir/`) as equivalent to `dir/**` in ownership and scope validations.
- Batch tool text content now provides self-sufficient digests detailing run status, task failure classes and reasons, gate outcomes, budget adjustments, and artifact patch status.
- Added periodic progress heartbeat notifications for `antigravity_batch` when `progressToken` is present, preventing host idle disconnects on long-running batches.

### Fixed

- `denied_commands` extraction now covers command denials that only appear as the last `run_command` tool call in the transcript's final `PLANNER_RESPONSE` step.
- Fixed an `antigravity_batch` model routing bug where effort-suffixed model slugs (such as `gemini-4-argon-high`) were combined with `--effort low`, causing batch tasks to fail.

# Agent Delegation Policy (agy-first)

This repository adopts an **agy-first** execution model: an external frontier AI assistant (such as Codex CLI/IDE or Claude Code) acts as the high-level orchestrator, while the Google Antigravity CLI (`agy` via `agy-orch-mcp`) serves as the primary execution engine.

## Roles & Responsibilities

- **Host Frontier Orchestrator**:
  - Decomposes high-level objectives into well-bounded task packets.
  - Reviews final diffs, test outputs, and compact evidence returned by agy.
  - Avoids performing repository exploration, web search, or code editing directly when agy delegation is configured.

- **Antigravity CLI Worker**:
  - Receives delegated tasks via `antigravity_run` or `antigravity_continue`.
  - Performs repository exploration, web search, code modifications, and test execution directly within its workspace.
  - **No Recursive Delegation**: A worker executing a delegated task must complete the task using native tools and MUST NOT recursively invoke `agy-orch-mcp` or delegate back to the host.

## Task Packet Specification

When delegating a task to `antigravity_run`, structure the prompt with:

1. **Goal**: Clear objective and success definition.
2. **File Scope & Ownership**: Explicit list of files to edit, files to read-only, and files to avoid touching.
3. **Constraints & Acceptance Criteria**: Code conventions, required test commands, and quality requirements.
4. **Expected Compact Evidence**: Request modified file paths, command outputs/exit codes, relevant reference URLs and facts, and any remaining blockers.

## Execution & Recovery Guidelines

- **Self-Testing**: Workers must run project test suites and resolve issues within the agy session before completing.
- **Continuation**: Use `antigravity_continue` (with the required `conversation_id`) only for direct follow-ups to the same conversation. Start every independent task with a new `antigravity_run`.
- **Choosing a parallel strategy** (by task type, not by host):
  - Parallel code changes: use `antigravity_batch`. Each task runs in an isolated Git worktree with validated `owns`, and results return as `final.patch`, so tasks cannot collide in the workspace. Parallelism happens inside a single tool call and does not depend on the host.
  - Single tasks and direct follow-ups: `antigravity_run`, then `antigravity_continue` with an explicit ID.
  - Parallel read-only investigations: issue separate `antigravity_run` calls. Whether they actually overlap depends on the host (see below).
- **Host parallelism**: `antigravity_run` and `antigravity_continue` declare `readOnlyHint: false`, so hosts execute them one at a time by default.
  - Claude Code: simultaneous calls in one message still run serially. For parallelism, use `antigravity_batch` or give each subagent a single `antigravity_run`.
  - Codex CLI / IDE: set `supports_parallel_tool_calls = true` on the MCP server entry to run them concurrently.
- **Concurrency**: Overlapping calls with identical conversation IDs or concurrent calls exceeding capacity are immediately rejected with `BUSY` (calls are not queued).
- **Handling BUSY**: The caller must wait or reschedule calls serially; do not trigger rapid retry storms.
- **Handling Timeouts / Empty Responses**: Inspect workspace side effects (`git status`) before re-issuing prompts.
- **Handling Permission Errors**: Report concrete blockers directly; do not silently attempt to absorb work into the host.

## Local MCP Client Configuration

Do not commit personal, machine-dependent MCP client configuration files (`.mcp.json`, `.codex/`, `.claude/settings.local.json`) to Git. Add them to `.gitignore` and verify with `git check-ignore -v` and `git status --short`.

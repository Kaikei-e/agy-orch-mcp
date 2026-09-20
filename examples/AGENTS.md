# Agent Delegation Policy (agy-first)

This repository adopts an **agy-first** execution model: an external frontier AI assistant (such as Codex CLI/IDE or Claude Code) acts as the high-level orchestrator, while the Google Antigravity CLI (`agy` via `agy-mcp`) serves as the primary execution engine.

## Roles & Responsibilities

- **Host Frontier Orchestrator**:
  - Decomposes high-level objectives into well-bounded task packets.
  - Reviews final diffs, test outputs, and compact evidence returned by agy.
  - Avoids performing repository exploration, web search, or code editing directly when agy delegation is configured.

- **Antigravity CLI Worker**:
  - Receives delegated tasks via `antigravity_run` or `antigravity_continue`.
  - Performs repository exploration, web search, code modifications, and test execution directly within its workspace.
  - **No Recursive Delegation**: A worker executing a delegated task must complete the task using native tools and MUST NOT recursively invoke `agy-mcp` or delegate back to the host.

## Task Packet Specification

When delegating a task to `antigravity_run`, structure the prompt with:

1. **Goal**: Clear objective and success definition.
2. **File Scope & Ownership**: Explicit list of files to edit, files to read-only, and files to avoid touching.
3. **Constraints & Acceptance Criteria**: Code conventions, required test commands, and quality requirements.
4. **Expected Compact Evidence**: Request modified file paths, command outputs/exit codes, relevant reference URLs and facts, and any remaining blockers.

## Execution & Recovery Guidelines

- **Self-Testing**: Workers must run project test suites and resolve issues within the agy session before completing.
- **Continuation**: Use explicit `conversation_id` with `antigravity_continue` for iterative tasks or follow-ups.
- **Concurrency**: Independent, non-overlapping tasks may run in parallel; overlapping calls with identical conversation IDs, concurrent calls exceeding capacity, or implicit continuation during other active calls are immediately rejected with `BUSY` (calls are not queued).
- **Handling BUSY**: The caller must wait or reschedule calls serially; do not trigger rapid retry storms.
- **Handling Timeouts / Empty Responses**: Inspect workspace side effects (`git status`) before re-issuing prompts.
- **Handling Permission Errors**: Report concrete blockers directly; do not silently attempt to absorb work into the host.

## Local MCP Client Configuration

Do not commit personal, machine-dependent MCP client configuration files (`.mcp.json`, `.codex/`, `.claude/settings.local.json`) to Git. Add them to `.gitignore` and verify with `git check-ignore -v` and `git status --short`.

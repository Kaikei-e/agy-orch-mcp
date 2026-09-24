# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Renamed tool and repository to `agy-orch-mcp`.
- **Breaking:** `antigravity_continue` now requires `conversation_id`. Implicit latest-conversation continuation (`--continue`), which took exclusive access to the server and blocked every other call, has been removed.
- Tool descriptions and delegation guidance now route independent tasks to new `antigravity_run` calls and parallel code changes to `antigravity_batch`, and document host-specific parallelism (Claude Code serializes non-read-only MCP tools; Codex needs `supports_parallel_tool_calls = true`).

### Added

- MCP initialization instructions and tool descriptions providing default delegation guidance for client hosts.
- Configurable default model via `AGY_MCP_DEFAULT_MODEL`, with precedence (per-call `model` argument > `AGY_MCP_DEFAULT_MODEL` > CLI default).
- Bridge error classification converting CLI output with denied actions into `PERMISSION_DENIED` and empty success responses into `EMPTY_RESPONSE`.
- Operational documentation and templates for the **agy-first** delegation policy (`AGENTS.md`, `CLAUDE.md`, `examples/`).
- Documented compact output recommendation (`AGY_MCP_MAX_OUTPUT_CHARS=16000`), client restart instructions, and `--mode` intent semantics under `--disable-slash-commands`.
- Explicit `.gitignore` entries for machine-dependent personal MCP client configuration files (`.mcp.json`, `.codex/`, `.claude/settings.local.json`).
- Initial local MCP bridge for Antigravity CLI runs, conversation continuation, and model listing.
- OSS documentation, contribution guidance, security reporting guidance, a Claude Code configuration example, and continuous integration.
- Codex CLI and IDE stdio configuration guidance, including an example TOML file and timeout settings for long-running tools.
- Configurable parallel CLI execution with `AGY_MCP_MAX_CONCURRENT` (default 4, range 1–32), per-call cancellation, and conversation-ID locks. Set the limit to 1 for the previous serial behavior.

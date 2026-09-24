# agy-orch-mcp

[日本語](README.ja.md) · [設計ドキュメント (Japanese Design Doc)](docs/design.ja.md) · [Apache-2.0](LICENSE)

`agy-orch-mcp` is a local [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an MCP client delegate work to the Google Antigravity CLI (`agy`). It communicates over stdio, starts `agy` as a child process, and returns CLI output as structured MCP content.

It is designed for personal local workflows and open-source adaptation. It is not an official Antigravity product and does not replace Antigravity's access controls or account requirements.

## Overview & The agy-first Model

For detailed architecture, design rationale, and operational planning, see [docs/design.ja.md](docs/design.ja.md) (in Japanese).

`agy-orch-mcp` enables an **agy-first** division of labor:

- **External Frontier Host**: Codex CLI/IDE or Claude Code acts as the orchestrator. The host focuses on task decomposition, structured prompt packet formulation, and final review of diffs and evidence. It avoids performing repository investigation, web search, or code editing directly.
- **Antigravity Execution Engine**: The local Antigravity CLI (`agy`) serves as the execution engine, handling repository research, web searches, code modification, testing, and self-correction loops.
- **No Recursive Delegation**: An Antigravity CLI session executing a delegated task must complete its work directly using native tools. It must not recursively call `agy-orch-mcp` or delegate work back to the host.
- **Delegation Guidance vs. Host Capabilities**: The server supplies MCP initialization instructions and tool descriptions that guide the client host to delegate execution tasks to Antigravity. These instructions express default workflow guidance; they do not and cannot forcibly disable or replace the host's other built-in tools.

## What it provides

| MCP tool               | Availability | Purpose                                                                                                                    |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `antigravity_run`      | Default      | Starts a new Antigravity conversation and returns its result and, when supplied by the CLI, its `conversation_id`.         |
| `antigravity_continue` | Default      | Continues a conversation by its required `conversation_id`. Use it only for direct follow-ups; start new tasks with `run`. |
| `antigravity_models`   | Default      | Runs `agy models` and returns the CLI output. It does not start a model turn, but it may contact Antigravity.              |
| `antigravity_batch`    | Opt-in       | Executes a multi-task DAG with validation gates in isolated Git worktrees, producing an artifact-only `final.patch`.       |
| `antigravity_fetch`    | Opt-in       | Retrieves safe slices of artifacts (stdout, stderr, patches, digest, manifest, request, plan, events) by logical selector. |

`run` and `continue` accept a prompt, an absolute workspace, an optional model and effort, a mode (`plan` or `accept-edits`), an autonomy level, and a hard timeout. Legacy tool defaults remain unchanged. Opt-in tools (`antigravity_batch` and `antigravity_fetch`) require `AGY_MCP_ENABLE_BATCH=true` and `AGY_MCP_ENABLE_FETCH=true` (or setting `AGY_MCP_TOOL_SURFACE=batch`).

### Model Selection & Precedence

Model selection resolves in the following order:

1. The explicit `model` argument provided in the MCP tool call (`antigravity_run` or `antigravity_continue`).
2. The server environment variable `AGY_MCP_DEFAULT_MODEL` (if set and non-empty).
3. The default model configured within the installed `agy` CLI itself (when omitted).

Query available model slugs using `antigravity_models`, then cache or specify the desired slug.

### Safety, Workspace Boundaries, and Bridge Status Classification

The default request settings are `mode: "plan"` and `autonomy: "safe"`.

- `safe` inherits workspace trust and permissions configured in `agy`. It is **not** a read-only guarantee.
- Output returned by the worker is untrusted evidence; review proposed commands and file edits before acting on them.
- `mode` (`plan` or `accept-edits`) signals intended agent behavior. In headless mode, the current `agy` CLI issues a diagnostic indicating that `--mode` has no effect when `--disable-slash-commands` is active. Consequently, `mode` is an intent signal and **not** an operating system security boundary.
- `autonomy` governs permission handling:
  - `safe` (default): Inherits workspace trust and permissions configured in `agy`.
  - `sandbox`: Adds the CLI's terminal sandbox restrictions.
  - `full`: Passes `--dangerously-skip-permissions` to the CLI. Rejected unless `AGY_MCP_ALLOW_FULL_AUTONOMY=true` is set in the server environment.
- `AGY_MCP_ALLOWED_ROOT`, when set, permits only canonical workspaces beneath that root. This restricts **workspace selection only**; it does **not** sandbox a child process's filesystem or network access.
- **Bridge Error Classification**: The bridge parses raw CLI output envelopes and refines the status:
  - When `agy` outputs a `SUCCESS` status but records `denied_actions`, the bridge classifies the result as `status: "PERMISSION_DENIED"` with actionable error guidance, preserving the `denied_actions` list in the response metadata.
  - When `agy` outputs a `SUCCESS` status with an empty response string, the bridge classifies the result as `status: "EMPTY_RESPONSE"`, alerting the caller to review potential workspace side effects before retrying.
  - _(Note: These classifications are synthesized by the `agy-orch-mcp` bridge layer to provide robust MCP semantics, rather than raw CLI terminal statuses)._

### Structured Task Packets

When delegating tasks to `antigravity_run`, the host orchestrator should provide a structured task packet:

```json
{
  "prompt": "GOAL: Implement JWT authentication middleware.\nSCOPE: Only edit src/auth.ts and test/auth.test.ts. Do not touch config files.\nCONSTRAINTS: Follow existing TypeScript strict conventions. Run `pnpm test` to verify.\nEVIDENCE: Return modified file paths, test command exit status and output, and any external reference URLs consulted.",
  "workspace": "/absolute/path/to/workspace",
  "mode": "accept-edits",
  "autonomy": "safe",
  "timeout_seconds": 600
}
```

## Batch Orchestration (`antigravity_batch` & `antigravity_fetch`)

When opted in via `AGY_MCP_ENABLE_BATCH=true` and `AGY_MCP_ENABLE_FETCH=true` (or `AGY_MCP_TOOL_SURFACE=batch`), the server provides advanced multi-task DAG batch orchestration:

- **Isolated Worktrees & Artifact-Only Delivery**: Each task worker runs in an isolated Git worktree branched from the base revision. Validated patches are integrated in deterministic topological order and saved as an artifact (`final.patch`). The host working tree is **never directly modified**.
- **Clean Workspace Requirement**: `workspace.dirty_policy` defaults to `"reject"` and requires a clean working repository. The `"snapshot"` policy is currently **unsupported and rejected**.
- **Ownership vs. Reference Scope**: `task.owns` specifies the exact file paths/globs the worker has permission to edit (`owns ⊆ scope.include` and `owns ∩ scope.exclude = ∅`). `scope.include` defines broader read/reference visibility.
- **Gate Command Execution**: `gate.command` requires an explicit argv array (`string[]`), never raw shell strings, preventing shell injection or unmonitored subshell expansion.
- **Containment Model**: Worktree isolation, static path validation, and argv execution provide defense-in-depth application boundaries; they do **not** constitute an operating-system-level sandbox.
- **Bounded Retries & Deadlines**: Batches enforce strict execution limits (`budget.max_worker_calls`, `max_repair_attempts`, `max_replans`, and `wall_time_ms`).
- **Token Budget, Preflight Capacity & Dynamic Digest**: Output is summarized within `return.max_tokens` (default 1400) using deterministic progressive shedding accounting for the entire MCP envelope. Upfront preflight validation rejects impossible budgets before worker or worktree creation, preserving `CAPACITY_EXCEEDED` and recovery pointers. (Phase 6 semantic compression is optional and not implemented; real-world 20+20 host rollout benchmarks were not run).
- **Safe Artifact Fetching & Raw Capture Fidelity**: `antigravity_fetch` retrieves full or sliced outputs using logical selectors (`task:<id>:stdout`, `task:<id>:stderr`, `task:<id>:patch`, `gate:<id>:stdout`, `gate:<id>:stderr`, `manifest`, `digest`, `request`, `plan`, `events`) or artifact IDs with cursor pagination (`byte_offset`). Physical CLI stream-json stdout and stderr are faithfully preserved in batch task artifacts for post-run recovery, while internal raw stdout is strictly omitted from legacy MCP tool outputs. Raw filesystem paths are rejected.
- **Minimal Tool Surface (`AGY_MCP_TOOL_SURFACE=batch`)**: Suppresses legacy `antigravity_run`, `antigravity_continue`, and `antigravity_models` tools, publishing only `antigravity_batch` and `antigravity_fetch` to conserve host context tokens.
- **Client Configuration Examples**: For batch profiles, consult [examples/codex-batch.toml](examples/codex-batch.toml) and [examples/claude-code-batch.mcp.json](examples/claude-code-batch.mcp.json).

## Parallel Calls, Timeouts, and Bounded Recovery

The server runs up to four `agy` commands concurrently by default (`AGY_MCP_MAX_CONCURRENT`).

- All commands, including `antigravity_models`, count toward the concurrency limit. Calls exceeding the limit immediately return `BUSY` and are **not queued**.
- Independent tasks with different explicit `conversation_id` values or new runs can execute in parallel.
- Concurrent requests using the same explicit conversation ID serialize: the second request immediately returns `BUSY`.
- Conversation locks and limits apply within one server process. Workspace files, credentials, and CLI state remain shared.
- Whether simultaneous calls reach the server concurrently depends on the host. `run` and `continue` declare `readOnlyHint: false`, so Claude Code executes them one at a time; Codex runs them concurrently when the server entry sets `supports_parallel_tool_calls = true`. For parallel code changes, prefer `antigravity_batch`, which parallelizes inside a single call and isolates each task in its own worktree.
- `timeout_seconds` defaults to 300 and accepts integers from 10 through 3600. Configure the MCP client's own tool timeout slightly longer (e.g. 3660s) so the tool deadline fires first.
- Returned tool responses are capped by `AGY_MCP_MAX_OUTPUT_CHARS` (default 40000; 16000 recommended for host context efficiency). When output is truncated, verify the truncated metadata and request focused follow-up turns before making decisions.
- **Handling `BUSY`**: The client must wait or serialize calls rather than triggering rapid retry storms.
- **Handling Timeouts and `EMPTY_RESPONSE`**: When a command times out or returns an empty response, inspect the workspace (`git status`) to evaluate partial side effects before retrying.
- **Handling `PERMISSION_DENIED` and Errors**: Report the specific blocker to the user rather than silently shifting the execution workload back to the host.

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer (the repository pins pnpm 10.18.1)
- An installed, authenticated Antigravity CLI available as `agy`, or an executable path supplied through `AGY_MCP_BIN`
- A workspace that Antigravity is allowed to use

Official documentation references:

- [Antigravity CLI Headless Documentation](https://antigravity.google/docs/cli/headless/)
- [OpenAI Codex MCP Configuration Documentation](https://developers.openai.com/codex/mcp/)
- [Official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## Install from Source

```bash
git clone https://github.com/Kaikei-e/agy-orch-mcp.git
cd agy-orch-mcp
pnpm install --frozen-lockfile
pnpm build
pnpm run doctor
```

`pnpm run doctor` checks the configured workspace and verifies that the installed `agy` advertises the necessary CLI flags without initiating a model turn.

For an optional live smoke test after authenticating `agy`:

```bash
pnpm run probe
```

The probe invokes `run` and then `continue` on the returned conversation. It consumes live Antigravity quota and creates conversations; it is deliberately excluded from CI.

## Connect an MCP Client

Build the server, then configure your client to launch the compiled entry point.

> [!IMPORTANT]
> **Restart the client session**: Always restart your Codex CLI/IDE or Claude Code session after modifying MCP configuration files. When editing existing configuration files, merge server tables carefully to preserve existing settings.

### Claude Code (`.mcp.json`)

For Claude Code, add a stdio server entry to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "node",
      "args": ["/absolute/path/to/agy-orch-mcp/dist/index.js"],
      "env": {
        "AGY_MCP_DEFAULT_WORKSPACE": "/absolute/path/to/workspace",
        "AGY_MCP_ALLOWED_ROOT": "/absolute/path/to",
        "AGY_MCP_MAX_CONCURRENT": "4",
        "AGY_MCP_MAX_OUTPUT_CHARS": "16000"
      }
    }
  }
}
```

_Tip_: Setting `AGY_MCP_MAX_OUTPUT_CHARS="16000"` keeps returned tool output compact, preserving the host model's context window.

### OpenAI Codex CLI / IDE (`config.toml`)

For Codex CLI or Codex IDE, add the stdio server to `~/.codex/config.toml` (global) or `.codex/config.toml` (trusted projects):

```toml
[mcp_servers.antigravity]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/agy-orch-mcp/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 3660
supports_parallel_tool_calls = true

[mcp_servers.antigravity.env]
AGY_MCP_DEFAULT_WORKSPACE = "/absolute/path/to/workspace"
AGY_MCP_ALLOWED_ROOT = "/absolute/path/to"
AGY_MCP_MAX_CONCURRENT = "4"
# Recommended compact output limit to protect host context:
# AGY_MCP_MAX_OUTPUT_CHARS = "16000"
# Optional default model slug discovered via `antigravity_models`:
# AGY_MCP_DEFAULT_MODEL = "a-slug-returned-by-antigravity_models"
# Remove this entry when `agy` is available in Codex's PATH:
AGY_MCP_BIN = "/absolute/path/to/agy"
```

Codex CLI registration can also be performed via:

```bash
codex mcp add antigravity \
  --env "AGY_MCP_DEFAULT_WORKSPACE=/absolute/path/to/workspace" \
  --env "AGY_MCP_ALLOWED_ROOT=/absolute/path/to" \
  --env "AGY_MCP_MAX_CONCURRENT=4" \
  --env "AGY_MCP_MAX_OUTPUT_CHARS=16000" \
  -- "/absolute/path/to/node" "/absolute/path/to/agy-orch-mcp/dist/index.js"
```

Remember to add `startup_timeout_sec = 20` and `tool_timeout_sec = 3660` to the resulting entry in `config.toml`.

### Personal Client Settings & Git Hygiene

Do not commit machine-specific MCP configuration files to Git. Ensure your repository `.gitignore` includes:

```gitignore
# Personal MCP client settings
.mcp.json
.codex/
.claude/settings.local.json
```

Verify exclusions using:

```bash
git check-ignore -v .mcp.json .codex/config.toml .claude/settings.local.json
git status --short
```

## Reusable Project Templates

To establish agy-first policies in downstream projects, copy the provided templates:

- [examples/AGENTS.md](examples/AGENTS.md): Project-agnostic agy-first delegation rules.
- [examples/CLAUDE.md](examples/CLAUDE.md): Claude Code configuration importing `@AGENTS.md`.

When introducing these templates to an existing project, **merge** the rules into the existing `AGENTS.md` or `CLAUDE.md` rather than overwriting project-specific instructions, build commands, or domain guidelines.

## Configuration Reference

| Variable                      | Default                  | Meaning                                                                                     |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `AGY_MCP_BIN`                 | `agy`                    | CLI executable name, or an absolute or relative path to the executable.                     |
| `AGY_MCP_DEFAULT_WORKSPACE`   | server current directory | Default workspace directory.                                                                |
| `AGY_MCP_ALLOWED_ROOT`        | unset                    | Optional canonical root restricting permitted workspaces.                                   |
| `AGY_MCP_DEFAULT_MODEL`       | unset                    | Optional default model slug. Precedence: per-call `model` > `AGY_MCP_DEFAULT_MODEL` > CLI.  |
| `AGY_MCP_FAST_MODEL`          | unset                    | Optional fast-tier model slug for batch tasks requesting `worker.tier: "fast"`.             |
| `AGY_MCP_REASONING_MODEL`     | unset                    | Optional reasoning-tier model slug for `worker.tier: "reasoning"` or escalated repairs.     |
| `AGY_MCP_ENABLE_BATCH`        | `false`                  | Set to `true` to publish the `antigravity_batch` tool (automatically true if surface=batch) |
| `AGY_MCP_ENABLE_FETCH`        | `false`                  | Set to `true` to publish the `antigravity_fetch` tool (automatically true if surface=batch) |
| `AGY_MCP_TOOL_SURFACE`        | `all`                    | Tool surface filter: `all` (default), `compat`, or `batch` (publishes only batch/fetch).    |
| `AGY_MCP_MAX_CONCURRENT`      | `4`                      | Maximum simultaneous CLI child processes (1–32).                                            |
| `AGY_MCP_MAX_OUTPUT_CHARS`    | `40000`                  | Maximum characters in MCP tool response representation (1024–1000000; 16000 recommended).   |
| `AGY_MCP_MAX_BUFFER_BYTES`    | `8388608`                | Maximum captured CLI stdout buffer per process before termination (1024–67108864).          |
| `AGY_MCP_ALLOW_FULL_AUTONOMY` | `false`                  | Set to `true` to permit requests with `autonomy: "full"`.                                   |
| `AGY_ORCH_STORAGE_DIR`        | unset                    | Optional directory for artifact store and telemetry (defaults to XDG state/cache path).     |

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm format:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before filing issues or pull requests. Released under the [Apache License 2.0](LICENSE).

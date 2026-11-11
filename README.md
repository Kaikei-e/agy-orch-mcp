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

`run` and `continue` accept a prompt, an absolute workspace, an optional model and effort, a mode (`plan` or `accept-edits`), an autonomy level, a per-turn timeout (`timeout_seconds`, 10–900, default 900), an optional slot queue timeout (`queue_timeout_seconds`, 0–900, default 0), and a `return_mode` (`raw`, `digest`, or `structured`). Opt-in tools (`antigravity_batch` and `antigravity_fetch`) require `AGY_MCP_ENABLE_BATCH=true` and `AGY_MCP_ENABLE_FETCH=true` (or setting `AGY_MCP_TOOL_SURFACE=batch`).

### Model Selection & Precedence

Model selection resolves in the following order:

1. The explicit `model` argument provided in the MCP tool call (`antigravity_run` or `antigravity_continue`).
2. The server environment variable `AGY_MCP_DEFAULT_MODEL` (if set and non-empty).
3. The server built-in default model (`gemini-4-carbon-high`).

Subagents and worker tiers resolve as follows:

- `AGY_MCP_SUBAGENT_MODEL` defaults to `gemini-4-argon-medium`. When the `--install-guard` hook is installed, `agy` sessions spawned by `agy-orch-mcp` receive `SessionStart` guidance and `PreToolUse` enforcement (`swarm` `action: "add"` defaults to `AGY_MCP_SUBAGENT_MODEL`, and `invoke_subagent` `Model: "inherit"` / omitted is rewritten to the matching subagent tier).
- In `antigravity_batch`, `fast` tier workers default to `AGY_MCP_FAST_MODEL` (falling back to `AGY_MCP_SUBAGENT_MODEL`, default `gemini-4-argon-medium`) and `reasoning` tier workers default to `AGY_MCP_REASONING_MODEL` (falling back to `AGY_MCP_DEFAULT_MODEL`, default `gemini-4-carbon-high`).

Query available model slugs using `antigravity_models`, then cache or specify the desired slug.

### Safety, Workspace Boundaries, and Bridge Status Classification

The default request settings are `mode: "plan"` and `autonomy: "safe"`.

- `safe` inherits workspace trust and permissions configured in `agy`. It is **not** a read-only guarantee.
- Output returned by the worker is untrusted; hosts should verify execution using the machine-extracted `verified_outputs` ledger and `git diff` rather than commands quoted in the model's prose response.
- `mode` (`plan` or `accept-edits`) signals intended agent behavior. In headless mode, the current `agy` CLI issues a diagnostic indicating that `--mode` has no effect when `--disable-slash-commands` is active. Consequently, `mode` is an intent signal and **not** an operating system security boundary.
- `autonomy` governs permission handling:
  - `safe` (default): Inherits workspace trust and permissions configured in `agy`, plus the bridge's fixed deny rules and command guard.
  - `sandbox`: Adds the CLI's terminal sandbox restrictions.
  - `full`: Passes `--dangerously-skip-permissions` to the CLI. Rejected unless `AGY_MCP_ALLOW_FULL_AUTONOMY=true` is set in the server environment.
- `AGY_MCP_ALLOWED_ROOT`, when set, permits only canonical workspaces beneath that root. This restricts **workspace selection only**; it does **not** sandbox a child process's filesystem or network access.
- **Command Guard (`--install-guard`), Subagent Model Hook & Fixed Deny Rules**:
  - Running `agy-orch-mcp --install-guard` adds one environment-gated lifecycle hook named `agy-orch-mcp-guard` (`SessionStart` + `PreToolUse` for `run_command`, `swarm`, and `invoke_subagent`) to `~/.gemini/config/hooks.json` (preserving any other hooks and writing a timestamped `.bak` backup); `agy-orch-mcp --uninstall-guard` removes it.
  - The hook evaluates `run_command` tool calls only when the bridge sets `AGY_ORCH_MCP_GUARD=1`, and injects/enforces `AGY_MCP_SUBAGENT_MODEL` (`AGY_ORCH_MCP_SUBAGENT_MODEL`) on `SessionStart`, `swarm`, and `invoke_subagent` only for bridge-spawned sessions, so interactive or non-bridge `agy` sessions are unaffected. Measured `agy` behavior: a hook returning `"ask"` auto-approves in headless mode (so the guard never returns `"ask"`), whereas an empty hook response abstains.
  - When active, the guard returns `"deny"` for remote-changing `git`/`gh` operations (`git push`, mutating `gh pr`/`issue`/`repo`/`release`/`workflow`/`run`/`secret`/`variable`/`label` subcommands, and `gh api` without an explicit `GET` method, including via `sh -c`, `xargs`, `env`, or `timeout`/`nohup`/`nice` wrappers) and for unquoted redirection or command substitution (`>`, `<`, `$(`, backticks) with an actionable reason the worker can act on. For everything else, it returns `"deny_unless_prior_grant"` (with targeted rewrite hints for path-qualified binaries, Go templates `{{`, unquoted parentheses, and env prefixes) so a command missing from `permissions.allow` reports a tool error to the worker instead of aborting the headless turn.
  - In `safe` and `sandbox` modes, the bridge also always passes fixed deny rules (`command(git push)` and mutating `command(gh ...)`) via `--settings`, which `agy` merges with the user's allow list.
  - `agy-orch-mcp --doctor` reports the guard hook status (`installed`, `missing`, or `outdated`) and audits `~/.gemini/antigravity-cli/settings.json` for permission risks (`high`, `medium`, `low`). Disable guarding on the server with `AGY_MCP_GUARD=off`.
- **Per-Conversation Environment Isolation (`AGY_MCP_ENV_ISOLATION`)**:
  - Controlled by `AGY_MCP_ENV_ISOLATION=full` (default) | `install` | `off` under `AGY_MCP_ENV_ROOT` (default `<XDG_STATE_HOME or ~/.local/state>/agy-orch/env`). Each conversation gets its own directory (`<AGY_MCP_ENV_ROOT>/<conversation_id>`), which is reused on `antigravity_continue` and pruned after 24 hours of inactivity at server startup.
  - `install` (and `full`) sets `GOBIN`, `npm_config_prefix`, `BUN_INSTALL`, `PNPM_HOME`, `CARGO_INSTALL_ROOT`, `PYTHONUSERBASE`, `CHOKIDAR_USEPOLLING=1`, and `WATCHPACK_POLLING=true` (so file watchers use polling), and prepends the isolated `bin` directories to `PATH`.
  - `full` additionally isolates caches and state: `GOPATH`, `GOMODCACHE`, `GOCACHE`, `npm_config_cache`, `npm_config_store_dir`, `BUN_INSTALL_CACHE_DIR`, `CARGO_HOME`, `PIP_CACHE_DIR`, and `UV_CACHE_DIR`.
  - Trade-offs: `full` mode re-downloads Go modules, npm packages, or Rust crates per conversation, and isolating `CARGO_HOME` skips `~/.cargo/config.toml`. Set `AGY_MCP_ENV_ISOLATION=install` when shared caches or user Cargo configuration are required.
- **Evidence, Preflight Warnings & Bridge Status Classification**:
  - **Machine-Extracted Command Ledger (`verified_outputs`)**: The bridge extracts every `run_command` step from the `agy` JSON stream into `verified_outputs` (`step_index`, `command`, `status` `completed` | `failed` | `denied` | `background` | `running`, `exit_code`, `output_tail`, `error`, `full_output_path`, `background_task_id`, `duration_seconds`). Hosts should trust `verified_outputs` over commands quoted in `response`.
  - **Structured Handoff (`return_mode: "structured"`)**: Passes `--json-schema` (`src/handoff-schema.ts`: `summary`, `changes`, `verification`, `facts`, `side_effects`, `blockers`) and returns the parsed object in `handoff` (or `handoff_error` on invalid JSON) alongside `response`.
  - **Preflight Warnings (`preflight_warnings`)**: Before starting a non-`full` turn, the bridge checks command candidates in the prompt against `permissions.allow`, `permissions.deny`, and fixed deny rules, returning `preflight_warnings` for commands that headless `agy` would deny, plus a warning when the guard hook is not installed.
  - **`PERMISSION_DENIED` & `denied_commands`**: When `agy` records `denied_actions`, the bridge classifies the result as `status: "PERMISSION_DENIED"`, merges denied commands from the stream and conversation transcript into `denied_commands` (including denials that only appear as the last tool call in the transcript), and attaches `partial_response` and `workspace_changes`.
  - **Context Rotation (`context`)**: Every run/continue result carries `context` (turns and cumulative `total_tokens`). Past `AGY_MCP_CONTEXT_ROTATE_TOKENS`, `context.rotate_recommended` is `true` and the host should start a new `antigravity_run` with a compact handoff.
  - **`EMPTY_RESPONSE`**: When `agy` reports `SUCCESS` with an empty response string, the bridge classifies the result as `status: "EMPTY_RESPONSE"` with `partial_response` and `workspace_changes` so the caller can inspect side effects before retrying.

### Structured Task Packets

When delegating tasks to `antigravity_run`, provide a concise task packet scoped to a `<= 15`-minute resumable turn. Because the guard hook returns actionable hints on shell constructs, prompts no longer need long lists of forbidden shell characters—just keep the "one simple command per call" rule:

```json
{
  "prompt": "GOAL: Implement JWT authentication middleware.\nSCOPE: Edit only src/auth.ts and test/auth.test.ts. Do not touch config files.\nCONSTRAINTS: Follow TypeScript strict conventions. Run one simple command per call (`pnpm test`).\nHANDOFF: Summarize changes, external URLs/facts, and any blockers.",
  "workspace": "/absolute/path/to/workspace",
  "mode": "accept-edits",
  "autonomy": "safe",
  "timeout_seconds": 900,
  "return_mode": "structured"
}
```

## Batch Orchestration (`antigravity_batch` & `antigravity_fetch`)

When opted in via `AGY_MCP_ENABLE_BATCH=true` and `AGY_MCP_ENABLE_FETCH=true` (or `AGY_MCP_TOOL_SURFACE=batch`), the server provides advanced multi-task DAG batch orchestration:

- **Isolated Worktrees & Artifact-Only Delivery**: Each task worker runs in an isolated Git worktree branched from the base revision. Validated patches are integrated in deterministic topological order and saved as an artifact (`final.patch`). The host working tree is **never directly modified**.
- **Clean Workspace Requirement**: `workspace.dirty_policy` is `"reject"` and requires a clean working repository (commit or stash uncommitted changes before invoking batch).
- **Ownership vs. Reference Scope**: `task.owns` specifies the exact file paths/globs the worker has permission to edit (`owns ⊆ scope.include` and `owns ∩ scope.exclude = ∅`). `scope.include` defines broader read/reference visibility.
- **Gate Command Execution**: `gate.command` requires an explicit argv array (`string[]`), never raw shell strings, preventing shell injection or unmonitored subshell expansion.
- **Containment Model**: Worktree isolation, static path validation, and argv execution provide defense-in-depth application boundaries; they do **not** constitute an operating-system-level sandbox.
- **Bounded Retries, Deadlines & Clamping**: Batches enforce execution limits (up to 50 worker calls, 16 parallel tasks, 7,200,000ms / 2h wall time). Requested budget values exceeding server limits are automatically clamped and reported in `budget_adjustments` rather than rejected. Bounded execution loops are tracked by `budget.max_worker_calls`, `max_repair_attempts`, `max_replans`, and `wall_time_ms`. Per-turn worker timeouts are capped at `900,000` ms (15 minutes); when a worker turn hits the cap, the scheduler automatically resumes it in the same worktree and conversation with a bridge-written resume prompt, counted against `max_worker_calls`. Effort-suffixed model slugs (such as `gemini-4-carbon-high` or `gemini-4-argon-medium`) are resolved without passing a conflicting `--effort low` flag. Periodic progress notifications (heartbeat) are emitted when a `progressToken` is supplied.
- **Token Budget, Preflight Capacity & Dynamic Digest**: Output is summarized within `return.max_tokens` (default 1400) using deterministic progressive shedding accounting for the entire MCP envelope. Upfront preflight validation rejects impossible budgets before worker or worktree creation, preserving `CAPACITY_EXCEEDED` and recovery pointers. (Phase 6 semantic compression is optional and not implemented; real-world 20+20 host rollout benchmarks were not run).
- **Safe Artifact Fetching & Raw Capture Fidelity**: `antigravity_fetch` retrieves full or sliced outputs using logical selectors (`task:<id>:stdout`, `task:<id>:stderr`, `task:<id>:patch`, `gate:<id>:stdout`, `gate:<id>:stderr`, `manifest`, `digest`, `request`, `plan`, `events`) or artifact IDs with cursor pagination (`byte_offset`). Physical CLI stream-json stdout and stderr are faithfully preserved in batch task artifacts for post-run recovery, while internal raw stdout is strictly omitted from legacy MCP tool outputs. Raw filesystem paths are rejected.
- **Minimal Tool Surface (`AGY_MCP_TOOL_SURFACE=batch`)**: Suppresses legacy `antigravity_run`, `antigravity_continue`, and `antigravity_models` tools, publishing only `antigravity_batch` and `antigravity_fetch` to conserve host context tokens.
- **Client Configuration Examples**: For batch profiles, consult [examples/codex-batch.toml](examples/codex-batch.toml) and [examples/claude-code-batch.mcp.json](examples/claude-code-batch.mcp.json).

## Parallel Calls, Timeouts, and Bounded Recovery

The server runs up to eight `agy` commands concurrently by default (`AGY_MCP_MAX_CONCURRENT`).

- All commands, including `antigravity_models`, count toward the concurrency limit. When all slots are in use, calls return `BUSY` immediately by default (`queue_timeout_seconds: 0`), or wait in a FIFO queue for up to `queue_timeout_seconds` (`0`–`900`) while emitting queue position progress notifications (`Queued for an agy slot (position N)`) and reporting `queue_wait_seconds` in the result.
- Independent tasks with different explicit `conversation_id` values or new runs can execute in parallel.
- Concurrent requests using the same explicit conversation ID serialize: a simultaneous request for the same conversation ID immediately returns `BUSY`.
- Conversation locks and limits apply within one server process. Workspace files, credentials, and CLI state remain shared.
- All MCP tools (`antigravity_run`, `antigravity_continue`, `antigravity_models`, `antigravity_batch`, and `antigravity_fetch`) advertise `annotations.readOnlyHint: true` and `annotations.destructiveHint: false` so MCP host schedulers can dispatch multiple tool calls in a single turn concurrently:
  - **Claude Code** maps `annotations.readOnlyHint: true` directly to its internal `isConcurrencySafe()` check, executing simultaneous `antigravity_run` or distinct-ID `antigravity_continue` calls in a single assistant message in parallel (relay subagents are unnecessary; rebuild `dist` with `pnpm build` after upgrading so the running server advertises the annotation). Claude Code also moves MCP calls that run longer than 2 minutes to the background automatically (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`).
  - **OpenAI Codex CLI / IDE** dispatches multiple MCP tool calls in a single turn concurrently when `[mcp_servers.<name>]` sets `supports_parallel_tool_calls = true`.
  - For parallel code modifications across the same repository, prefer `antigravity_batch`, which parallelizes inside a single call and isolates each task in its own Git worktree.
- **MCP Tasks Extension (`io.modelcontextprotocol/tasks`, revision `2026-07-28`)**: Enabled by default (`AGY_MCP_TASKS=auto`; set `AGY_MCP_TASKS=off` to disable). A client that negotiates revision `2026-07-28` and advertises `io.modelcontextprotocol/tasks` receives a task handle (`resultType: "task"`) and polls `tasks/get` (or cancels via `tasks/cancel`). Verified with SDK clients in tests; Claude Code documents support from v2.1.304 for main-conversation calls.
- **15-Minute Turn Cap (`timeout_seconds`)**: `timeout_seconds` defaults to `900` and accepts integers from `10` through `900` (15 minutes). `agy` ends the turn itself via `--print-timeout <N>s` and the bridge hard-kills the process tree 60 seconds later. Capping turns at 15 minutes enforces fast feedback cycles and splits long tasks into resumable turns. A cut-off turn returns `status: "TIMEOUT"` with `resumable: true`, `conversation_id`, `partial_response`, `verified_outputs`, `workspace_changes`, `terminated_tasks`, and `turn_seconds`; continue the task with `antigravity_continue`. Note that `duration_seconds` from `agy` is cumulative per conversation, whereas `turn_seconds` measures this turn.
- **Shortened Responses (`response_outline` & `resource_link`)**: Returned tool responses are capped by `AGY_MCP_MAX_OUTPUT_CHARS` (default `40000`; `16000` recommended for host context efficiency). When a response is shortened, the full text is saved to `response_artifact.path`, accompanied by `response_outline` (Markdown heading levels and `start_line`–`end_line` ranges) and a `resource_link` content item (`file://` URI to `response.txt`) so the host can read only the sections it needs.
- **Handling `BUSY`**: Use `queue_timeout_seconds` (up to `900`) or wait/serialize calls rather than triggering rapid retry storms.
- **Handling `TIMEOUT` and `EMPTY_RESPONSE`**: On `TIMEOUT` with `resumable: true`, inspect `partial_response`, `verified_outputs`, `workspace_changes`, and `terminated_tasks` and continue with `antigravity_continue`. On `EMPTY_RESPONSE`, inspect `workspace_changes` (`git status`) before retrying.
- **Handling `PERMISSION_DENIED` and Errors**: Review `denied_commands` and `workspace_changes`, then either continue with a named permitted alternative or report the concrete blocker to the user rather than silently shifting execution back to the host.

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer (the repository pins pnpm 10.34.9)
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
node dist/index.js --install-guard
pnpm run doctor
```

`node dist/index.js --install-guard` (or `agy-orch-mcp --install-guard`) installs the env-gated `PreToolUse` command guard hook in `~/.gemini/config/hooks.json` (use `--uninstall-guard` to remove it). `pnpm run doctor` checks the configured workspace, verifies required `agy` CLI flags, reports the guard hook status, and runs a permissions audit on `~/.gemini/antigravity-cli/settings.json` without initiating a model turn.

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
        "AGY_MCP_MAX_CONCURRENT": "8",
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
AGY_MCP_MAX_CONCURRENT = "8"
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
  --env "AGY_MCP_MAX_CONCURRENT=8" \
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

| Variable                        | Default                                            | Meaning                                                                                                         |
| ------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `AGY_MCP_BIN`                   | `agy`                                              | CLI executable name, or an absolute or relative path to the executable.                                         |
| `AGY_MCP_DEFAULT_WORKSPACE`     | server current directory                           | Default workspace directory.                                                                                    |
| `AGY_MCP_ALLOWED_ROOT`          | unset                                              | Optional canonical root restricting permitted workspaces.                                                       |
| `AGY_MCP_DEFAULT_MODEL`         | `gemini-4-carbon-high`                             | Default model slug. Precedence: per-call `model` > `AGY_MCP_DEFAULT_MODEL` > `gemini-4-carbon-high`.            |
| `AGY_MCP_SUBAGENT_MODEL`        | `gemini-4-argon-medium`                            | Subagent / swarm worker model slug enforced via `--install-guard` (`SessionStart` + `PreToolUse`).              |
| `AGY_MCP_FAST_MODEL`            | `AGY_MCP_SUBAGENT_MODEL` (`gemini-4-argon-medium`) | Fast-tier model slug for batch tasks requesting `worker.tier: "fast"`.                                          |
| `AGY_MCP_REASONING_MODEL`       | `AGY_MCP_DEFAULT_MODEL` (`gemini-4-carbon-high`)   | Reasoning-tier model slug for `worker.tier: "reasoning"` or escalated repairs.                                  |
| `AGY_MCP_ENABLE_BATCH`          | `false`                                            | Set to `true` to publish the `antigravity_batch` tool (automatically true if surface=batch)                     |
| `AGY_MCP_ENABLE_FETCH`          | `false`                                            | Set to `true` to publish the `antigravity_fetch` tool (automatically true if surface=batch)                     |
| `AGY_MCP_TOOL_SURFACE`          | `all`                                              | Tool surface filter: `all` (default), `compat`, or `batch` (publishes only batch/fetch).                        |
| `AGY_MCP_MAX_CONCURRENT`        | `8`                                                | Maximum simultaneous CLI child processes (1–32).                                                                |
| `AGY_MCP_MAX_OUTPUT_CHARS`      | `40000`                                            | Maximum characters in MCP tool response representation (1024–1000000; 16000 recommended).                       |
| `AGY_MCP_CONTEXT_ROTATE_TOKENS` | `2000000`                                          | Cumulative `total_tokens` per conversation after which results set `context.rotate_recommended` (1–1000000000). |
| `AGY_MCP_MAX_BUFFER_BYTES`      | `8388608`                                          | Maximum captured CLI stdout buffer per process before termination (1024–67108864).                              |
| `AGY_MCP_ALLOW_FULL_AUTONOMY`   | `false`                                            | Set to `true` to permit requests with `autonomy: "full"`.                                                       |
| `AGY_MCP_GUARD`                 | `on`                                               | Command guard (`on` or `off`). Sets `AGY_ORCH_MCP_GUARD=1` and checks `--install-guard` status when `on`.       |
| `AGY_MCP_ENV_ISOLATION`         | `full`                                             | Per-conversation environment isolation mode (`full`, `install`, or `off`).                                      |
| `AGY_MCP_ENV_ROOT`              | `<XDG_STATE_HOME or ~/.local/state>/agy-orch/env`  | Root directory for per-conversation isolated environments (pruned after 24h at startup).                        |
| `AGY_MCP_TASKS`                 | `auto`                                             | MCP Tasks extension (`io.modelcontextprotocol/tasks`, revision `2026-07-28`): `auto` (default) or `off`.        |
| `AGY_ORCH_STORAGE_DIR`          | unset                                              | Optional directory for artifact store and telemetry (defaults to XDG state/cache path).                         |

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm format:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before filing issues or pull requests. Released under the [Apache License 2.0](LICENSE).

# Claude Code Configuration Template

@AGENTS.md

## Project Workflows

- Build: `<build-command>`
- Test: `<test-command>`
- Lint / Check: `<lint-command>`

## Claude Code Operational Guidelines

1. **Host Orchestrator**:
   - Claude Code serves as the frontier host orchestrator.
   - Install the command guard once (`agy-orch-mcp --install-guard`) and rebuild `dist/` after upgrading `agy-orch-mcp`.
   - Delegate repository investigations, external web search, code implementation, tests, and fixes to Antigravity CLI via `agy-orch-mcp` tools (`antigravity_run`, `antigravity_continue`, `antigravity_batch`).
   - Retain host context for planning, task dispatching, and reviewing `git diff` plus the machine-extracted `verified_outputs` command ledger (rather than commands quoted in the model's prose Evidence).

2. **Delegation Protocol**:
   - Plan tasks as `<= 15`-minute resumable turns (`timeout_seconds` default and max `900`). Issue concise task packets specifying goal, target files, acceptance tests, and compact handoff expectations (or set `return_mode: "structured"`). Keep the "one simple command per call" advice, without long lists of forbidden shell characters (the guard hook returns hints).
   - Cache model selection from `antigravity_models` or rely on `AGY_MCP_DEFAULT_MODEL` / CLI default.
   - For direct follow-ups or when a turn hits `TIMEOUT` (`resumable: true`), provide the returned `conversation_id` to `antigravity_continue` and continue from `partial_response`, `verified_outputs`, `workspace_changes`, and `terminated_tasks`. Start independent tasks with a new `antigravity_run`.
   - Emit multiple `antigravity_run` calls (or `antigravity_continue` with distinct `conversation_id`s) in a single message to run independent read-only investigations or disjoint-scope tasks in parallel (up to `AGY_MCP_MAX_CONCURRENT`, default 8; relay subagents are unnecessary; set `queue_timeout_seconds` to wait for a free slot instead of `BUSY`). Claude Code moves MCP calls running longer than 2 minutes to the background automatically (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). For parallel code changes across shared repositories, prefer `antigravity_batch` for isolated Git worktrees.
   - Never recurse or delegate back from an active agy worker session.

# Claude Code Configuration Template

@AGENTS.md

## Project Workflows

- Build: `<build-command>`
- Test: `<test-command>`
- Lint / Check: `<lint-command>`

## Claude Code Operational Guidelines

1. **Host Orchestrator**:
   - Claude Code serves as the frontier host orchestrator.
   - Delegate repository investigations, external web search, code implementation, tests, and fixes to Antigravity CLI via `agy-orch-mcp` tools (`antigravity_run`, `antigravity_continue`).
   - Retain host context for planning, task dispatching, and diff review.

2. **Delegation Protocol**:
   - Issue structured task packets specifying goal, target files, acceptance tests, and compact evidence expectations.
   - Cache model selection from `antigravity_models` or rely on `AGY_MCP_DEFAULT_MODEL` / CLI default.
   - For direct follow-ups to the same task, provide the returned `conversation_id` to `antigravity_continue`. Start independent tasks with a new `antigravity_run`.
   - Emit multiple `antigravity_run` calls (or `antigravity_continue` with distinct `conversation_id`s) in a single message to run independent read-only investigations or disjoint-scope tasks in parallel (up to `AGY_MCP_MAX_CONCURRENT`, default 8). For parallel code changes across shared repositories, prefer `antigravity_batch` for isolated Git worktrees.
   - Never recurse or delegate back from an active agy worker session.
